"""Build immutable scene bundles containing raster data and metadata."""
import json
import os
import shutil
import warnings
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import numpy as np
import zarr
from rasterio.transform import Affine
from shapely.geometry import mapping
from zarr.codecs import GzipCodec

from . import __version__
from .areas import Area, AreaError
from .bundle import VERSION, JsonObject, make, validate
from .plan import MASK_INSIDE, LayerPlan, Plan, plan as make_plan
from .sources import (
    FROM_FALLBACK,
    FROM_MAIN,
    SOURCE_ROLE,
    STOP_COUNT,
    TOP_PERCENTILE,
    Dataset,
    FilledStep,
    Role,
    SeriesDataset,
    StaticDataset,
)
from .terrain_cache import is_cached, read_cached

ProgressCallback = Callable[[float, str | None], None]  # build fraction done 0-1, stage text
LayerProgress = Callable[[float, str], None]  # the same for one layer: its fraction done, stage

MAX_WORKERS = 8
MEMORY_BUDGET_BYTES = 500_000_000
ESTIMATED_BYTES_PER_CELL = 13

BATCH_SIZE = 12
TILE_SIZE_CELLS = 512
COMPRESSION = GzipCodec(level=5)
UNIX_EPOCH = date(1970, 1, 1)
MONTH_LABEL_CHARS = 7  # "YYYY-MM" of an ISO date, for stage texts
CACHE_DIR_NAME = ".cache"  # in the scenes directory; the leading dot keeps it unserved

# Publishing needs the final 5% of the progress bar.
LAYERS_PROGRESS_SHARE = 0.95
STATIC_BLOCK_COST = 1.0  # relative work, in rough seconds
STATIC_CACHED_COST = 0.1  # a cache hit still costs the writing
SERIES_STEP_COST = 0.2
PERCENTILE_SAMPLES_PER_BATCH = 100_000


class SourceChanged(Exception):
    """Local source data was replaced after the scene's id was made, so the id would be wrong."""


def build_scene(
    scene_id: str,
    area: Area,
    start: str | None,
    end: str | None,
    datasets: list[Dataset],
    title: str,
    scenes_dir: Path | str,
    progress: ProgressCallback = lambda fraction, stage: None,
    local_revisions: dict[str, str | None] | None = None,
) -> int:
    """Build or reuse the scene's bundle and return its size in bytes.

    `start` and `end` are request periods ('YYYY-MM'), or None for scenes without series.
    `local_revisions` are the local revisions that the scene id was made from. The build checks
    them before reading and again before publishing, and raises SourceChanged without publishing
    if any differs. Without them nothing is checked.
    """
    scenes_dir = Path(scenes_dir)
    final_dir = scenes_dir / scene_id

    # Content-addressed bundles are immutable and can be reused.
    if final_dir.is_dir():
        size = _directory_size(final_dir)
        progress(1.0, None)
        return size

    scene_plan = make_plan(area, datasets, start, end)
    _check_local_revisions(datasets, scene_plan, local_revisions)

    with _temporary_scene_directory(scenes_dir, scene_id) as temp_dir:
        root = zarr.open_group(
            str(temp_dir / "data.zarr"),
            mode="w",
            zarr_format=3,
        )

        layer_metadata = _write_layers(
            root,
            scene_plan,
            datasets,
            scenes_dir / CACHE_DIR_NAME,
            progress,
        )

        scene_document = make(
            scene_id,
            title,
            area,
            scene_plan,
            datasets,
            layer_metadata,
        )

        _finalize_scene(
            root,
            temp_dir,
            scene_document,
            title,
            area,
            scene_plan,
        )

        _check_local_revisions(datasets, scene_plan, local_revisions)
        built_size = _directory_size(temp_dir)
        # If another build published this scene first, keep the existing bundle.
        bundle_size = _publish_scene(temp_dir, final_dir, built_size)

    progress(1.0, None)
    return bundle_size


def _check_local_revisions(
    datasets: list[Dataset],
    scene_plan: Plan,
    expected: dict[str, str | None] | None,
) -> None:
    if expected is None:
        return

    for dataset in datasets:
        if dataset.time_varying:
            current = dataset.local_revision(scene_plan.layers[dataset.id].steps)
            if current != expected.get(dataset.id):
                raise SourceChanged(f"{dataset.title} data changed after the scene was prepared")


@contextmanager
def _temporary_scene_directory(scenes_dir: Path | str, scene_id: str) -> Iterator[Path]:
    temp_dir = Path(scenes_dir) / ".tmp" / scene_id

    shutil.rmtree(temp_dir, ignore_errors=True)
    temp_dir.mkdir(parents=True)

    try:
        yield temp_dir
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _write_layers(
    root: zarr.Group,
    scene_plan: Plan,
    datasets: list[Dataset],
    cache_dir: Path,
    progress: ProgressCallback,
) -> dict[str, JsonObject]:
    ordered_datasets = sorted(datasets, key=lambda dataset: dataset.time_varying)
    costs = {
        dataset.id: _layer_cost(dataset, scene_plan.layers[dataset.id], cache_dir)
        for dataset in ordered_datasets
    }
    progress_shares = _ProgressShares(progress, costs)
    layer_metadata = {}
    for dataset in ordered_datasets:
        layer_metadata[dataset.id] = _write_layer(
            root.create_group(dataset.id),
            dataset,
            scene_plan.layers[dataset.id],
            cache_dir,
            progress_shares.for_layer(dataset.id),
        )
    return layer_metadata


def _layer_cost(dataset: Dataset, layer_plan: LayerPlan, cache_dir: Path) -> float:
    """Estimated work of writing a layer, in the unit of STATIC_BLOCK_COST."""
    if isinstance(dataset, SeriesDataset):
        return len(layer_plan.steps) * SERIES_STEP_COST

    if is_cached(dataset, layer_plan.bbox, layer_plan.res, cache_dir):
        return STATIC_CACHED_COST

    return dataset.block_count(layer_plan.bbox) * STATIC_BLOCK_COST


class _ProgressShares:
    """Gives each layer a share of the progress bar by its cost; the bar never moves back."""

    def __init__(self, progress: ProgressCallback, costs: dict[str, float]) -> None:
        total_cost = sum(costs.values()) or 1.0
        self._progress = progress
        self._shares = {
            layer_id: LAYERS_PROGRESS_SHARE * cost / total_cost
            for layer_id, cost in costs.items()
        }
        self._starts = {}
        start = 0.0
        for layer_id, share in self._shares.items():
            self._starts[layer_id] = start
            start += share
        self._reported = 0.0

    def for_layer(self, layer_id: str) -> LayerProgress:
        def report(fraction: float, stage: str) -> None:
            self._reported = max(
                self._reported,
                self._starts[layer_id] + self._shares[layer_id] * fraction,
            )
            self._progress(self._reported, stage)

        return report


def _write_layer(
    layer_group: zarr.Group,
    dataset: Dataset,
    layer_plan: LayerPlan,
    cache_dir: Path,
    progress: LayerProgress,
) -> JsonObject:
    """Write one layer's coordinates, mask and data arrays; return its build result."""
    _write_coordinates_and_mask(layer_group, layer_plan)
    if isinstance(dataset, SeriesDataset):
        return _write_time_series(layer_group, dataset, layer_plan, progress)
    if isinstance(dataset, StaticDataset):
        return _write_static_layer(layer_group, dataset, layer_plan, cache_dir, progress)
    raise TypeError(f"{dataset.id}: unknown dataset kind {type(dataset).__name__}")


def _write_coordinates_and_mask(layer_group: zarr.Group, layer_plan: LayerPlan) -> None:
    """Write cell-centre coordinates and the area mask."""
    height, width = layer_plan.shape
    longitude, latitude = _coordinates(layer_plan.transform, height, width)

    _write_array(
        layer_group,
        "lon",
        longitude,
        ["lon"],
        {"units": "degrees_east"},
    )
    _write_array(
        layer_group,
        "lat",
        latitude,
        ["lat"],
        {"units": "degrees_north"},
    )
    _write_array(
        layer_group,
        "mask",
        layer_plan.mask,
        ["lat", "lon"],
        {"long_name": "0 = outside, 1 = area cell, 2 = one-cell ring of real values"},
    )


def _coordinates(transform: Affine, height: int, width: int) -> tuple[np.ndarray, np.ndarray]:
    """Return cell-centre longitude and latitude coordinates."""
    longitude = transform.c + (np.arange(width) + 0.5) * transform.a
    latitude = transform.f + (np.arange(height) + 0.5) * transform.e
    return longitude, latitude


def _write_static_layer(
    layer_group: zarr.Group,
    dataset: StaticDataset,
    layer_plan: LayerPlan,
    cache_dir: Path,
    progress: LayerProgress,
) -> JsonObject:
    """Write every role of a static dataset and return its statistics, if it has any."""
    block_count = dataset.block_count(layer_plan.bbox)
    blocks_read = 0

    def block_read() -> None:
        nonlocal blocks_read
        blocks_read += 1
        progress(blocks_read / block_count, f"{dataset.title} {blocks_read}/{block_count}")

    if not is_cached(dataset, layer_plan.bbox, layer_plan.res, cache_dir):
        progress(0, f"{dataset.title} 0/{block_count}")

    arrays, transform = read_cached(
        dataset,
        layer_plan.bbox,
        layer_plan.res,
        cache_dir,
        block_read,
    )
    progress(1, f"{dataset.title} {block_count}/{block_count}")

    for role, spec in dataset.roles.items():
        _write_array(
            layer_group,
            spec.name,
            _fill_outside(arrays[role], layer_plan.mask, spec),
            ["lat", "lon"],
            _attributes(spec),
            spec.fill,
        )

    stats = dataset.summary(arrays, layer_plan.mask == MASK_INSIDE, transform)
    return {"stats": stats} if stats else {}


def _fill_outside(data: np.ndarray, mask: np.ndarray, spec: Role) -> np.ndarray:
    """Fill missing samples and cells outside both the area and its real-data ring."""
    if spec.fill is None:
        raise ValueError(f"{spec.name}: a static role needs a fill value to hide outside cells")

    valid = (mask != 0) & np.isfinite(data)
    return np.where(valid, data, spec.fill).astype(data.dtype)


def _attributes(spec: Role) -> JsonObject:
    """The CF attributes of a role's array; the scale and offset are always set."""
    labels = {"units": spec.units, "long_name": spec.long_name}
    return {
        **{key: value for key, value in labels.items() if value},
        "scale_factor": spec.scale,
        "add_offset": spec.offset,
    }


def _write_time_series(
    layer_group: zarr.Group,
    dataset: SeriesDataset,
    layer_plan: LayerPlan,
    progress: LayerProgress,
) -> JsonObject:
    """Write a time series in batches and return its display statistics."""
    steps = layer_plan.steps
    step_count = len(steps)
    spec = dataset.roles["value"]
    area_mask = layer_plan.mask == MASK_INSIDE
    stored_mask = layer_plan.mask != 0

    _write_time_coordinate(layer_group, steps)
    series = _create_time_array(layer_group, dataset, spec, layer_plan)
    statistics = _StatisticsAccumulator()
    provenance = _Provenance(area_mask, stored_mask, step_count)
    worker_count = _choose_worker_count(layer_plan)

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        for batch_start in range(0, step_count, BATCH_SIZE):
            batch_steps = steps[batch_start:batch_start + BATCH_SIZE]
            raster_batch, filled_batch = _read_batch(
                executor,
                dataset,
                layer_plan,
                batch_steps,
            )
            statistics.add(raster_batch, area_mask)
            provenance.add(batch_start, raster_batch, filled_batch)
            encoded_batch = encode_values(
                np.where(stored_mask, raster_batch, np.nan),
                spec.dtype,
                spec.scale,
                spec.offset,
                spec.fill,
            )
            batch_end = batch_start + len(batch_steps)
            series[batch_start:batch_end] = encoded_batch
            last_month = steps[batch_end - 1][:MONTH_LABEL_CHARS]
            progress(batch_end / step_count, f"{dataset.title} {last_month}")

    value_stats = statistics.finish()
    return {
        "stops": dataset.stops(value_stats, statistics.quantiles(STOP_COUNT)),
        "stats": value_stats,
        **_write_provenance(layer_group, dataset, steps, provenance),
    }


def _write_provenance(
    layer_group: zarr.Group,
    dataset: SeriesDataset,
    steps: list[str],
    provenance: "_Provenance",
) -> JsonObject:
    """Write the `source` array when the fallback gave a value, and return the layer's notes."""
    if dataset.fallback is None:
        return {}

    if provenance.fallback_used:
        _write_array(
            layer_group,
            SOURCE_ROLE.name,
            provenance.codes(),
            ["lat", "lon"],
            {
                **_attributes(SOURCE_ROLE),
                "flag_values": [FROM_MAIN, FROM_FALLBACK, FROM_MAIN | FROM_FALLBACK],
                "flag_meanings": "main fallback main_and_fallback",
            },
            SOURCE_ROLE.fill,
        )

    return {
        "fallback_used": provenance.fallback_used,
        "notices": provenance.notices(dataset, steps),
    }


class _Provenance:
    """Track area provenance while crediting fallback data stored in the hidden ring too."""

    def __init__(
        self,
        area_mask: np.ndarray,
        stored_mask: np.ndarray,
        step_count: int,
    ) -> None:
        self._area_mask = area_mask
        self._stored_mask = stored_mask
        self._step_filled = np.zeros(step_count, bool)
        self._from_main = np.zeros(area_mask.shape, bool)
        self._from_fallback = np.zeros(area_mask.shape, bool)
        self._missing = np.zeros(area_mask.shape, bool)  # lacks a value in some step

    @property
    def fallback_used(self) -> bool:
        """Return whether any stored value came from the fallback and needs attribution."""
        return bool((self._from_fallback & self._stored_mask).any())

    @property
    def fallback_cells(self) -> int:
        """Return the number of cells inside the area that took a fallback value in some step."""
        return int((self._from_fallback & self._area_mask).sum())

    def add(
        self,
        batch_start: int,
        raster_batch: np.ndarray,
        filled_batch: np.ndarray | None,
    ) -> None:
        """Account for the steps from `batch_start`; `filled_batch` is None without a fallback."""
        present = np.isfinite(raster_batch)
        filled = np.zeros_like(present) if filled_batch is None else filled_batch
        self._from_main |= (present & ~filled).any(axis=0)
        self._from_fallback |= filled.any(axis=0)
        batch_end = batch_start + len(filled)
        self._step_filled[batch_start:batch_end] = (filled & self._area_mask).any(axis=(1, 2))
        self._missing |= (~present).any(axis=0)

    def codes(self) -> np.ndarray:
        """Return each cell's code, adding FROM_MAIN and FROM_FALLBACK when both gave values."""
        codes = self._from_main * FROM_MAIN + self._from_fallback * FROM_FALLBACK
        return np.where(self._area_mask, codes, 0).astype("uint8")

    def notices(self, dataset: SeriesDataset, steps: list[str]) -> list[str]:
        """Return notes on the cells that took fallback values and those that still lack a value."""
        inside = int(self._area_mask.sum())
        missing = int((self._missing & self._area_mask).sum())
        notices = []
        if self.fallback_cells:
            notice = dataset.fallback.notice
            notices.append(notice.format(filled=self.fallback_cells, inside=inside))
            notices += dataset.fallback_notices(steps, self._step_filled.tolist())
        if missing:
            notices.append(
                f"{dataset.title} has no value from either source in {missing} of {inside} cells "
                "in some months.",
            )
        return notices


def _write_time_coordinate(layer_group: zarr.Group, steps: list[str]) -> None:
    """Write dates as integer days since the Unix epoch."""
    days_since_epoch = np.array(
        [(date.fromisoformat(step) - UNIX_EPOCH).days for step in steps],
        dtype="int32",
    )
    _write_array(
        layer_group,
        "time",
        days_since_epoch,
        ["time"],
        {
            "units": "days since 1970-01-01",
            "calendar": "standard",
        },
    )


def _create_time_array(
    layer_group: zarr.Group,
    dataset: SeriesDataset,
    spec: Role,
    layer_plan: LayerPlan,
) -> zarr.Array:
    """Create the chunked and sharded Zarr array for a time series."""
    step_count = len(layer_plan.steps)
    height, width = layer_plan.shape
    spatial_chunks = (
        min(height, TILE_SIZE_CELLS),
        min(width, TILE_SIZE_CELLS),
    )

    return layer_group.create_array(
        spec.name,
        shape=(step_count, height, width),
        chunks=(1, *spatial_chunks),
        shards=(
            min(step_count, BATCH_SIZE),
            *spatial_chunks,
        ),
        dtype=spec.dtype,
        fill_value=spec.fill,
        compressors=COMPRESSION,
        dimension_names=["time", "lat", "lon"],
        attributes=_series_attributes(dataset, spec),
    )


def _series_attributes(dataset: SeriesDataset, spec: Role) -> JsonObject:
    """The attributes of a role, plus the CF cell_methods of the dataset's period summary."""
    if dataset.cell_method is None:
        return _attributes(spec)

    return {**_attributes(spec), "cell_methods": f"time: {dataset.cell_method}"}


class _StatisticsAccumulator:
    """Accumulate exact basic statistics and an approximate 98th percentile."""

    def __init__(self) -> None:
        self._random = np.random.default_rng(0)
        self._samples = []
        self._minimum = np.inf
        self._maximum = -np.inf
        self._value_sum = 0.0
        self._value_count = 0

    def add(self, raster_batch: np.ndarray, area_mask: np.ndarray) -> None:
        """Accumulate valid values from one batch."""
        values = raster_batch[:, area_mask]
        values = values[np.isfinite(values)]

        if values.size == 0:
            return

        self._minimum = min(self._minimum, values.min())
        self._maximum = max(self._maximum, values.max())
        self._value_sum += values.sum(dtype="float64")
        self._value_count += values.size

        # Per-batch sampling bounds memory but slightly overweights a short last batch.
        self._samples.append(
            self._random.choice(
                values,
                min(values.size, PERCENTILE_SAMPLES_PER_BATCH),
                replace=False,
            )
        )

    def finish(self) -> dict[str, float]:
        """Return rounded statistics or raise when no valid data exists."""
        if self._value_count == 0:
            raise AreaError("No valid data inside the area")

        percentile_98 = np.percentile(np.concatenate(self._samples), TOP_PERCENTILE)
        mean = self._value_sum / self._value_count

        return {
            "min": round(float(self._minimum), 2),
            "max": round(float(self._maximum), 2),
            "mean": round(mean, 2),
            "p98": round(float(percentile_98), 2),
        }

    def quantiles(self, count: int) -> list[float]:
        """Sample values at `count` evenly spaced percentiles from 0 to TOP_PERCENTILE."""
        percentiles = np.linspace(0, TOP_PERCENTILE, count)
        return np.percentile(np.concatenate(self._samples), percentiles).tolist()


def _choose_worker_count(layer_plan: LayerPlan) -> int:
    """Limit concurrent raster reads using the estimated memory budget."""
    height, width = layer_plan.shape
    estimated_bytes_per_step = (
        height
        * width
        * layer_plan.factor**2
        * ESTIMATED_BYTES_PER_CELL
    )
    workers_allowed_by_memory = MEMORY_BUDGET_BYTES // max(1, estimated_bytes_per_step)
    return max(1, min(MAX_WORKERS, workers_allowed_by_memory))


def _read_batch(
    executor: ThreadPoolExecutor,
    dataset: SeriesDataset,
    layer_plan: LayerPlan,
    steps: list[str],
) -> FilledStep:
    rasters = list(
        executor.map(
            lambda step: dataset.read_step_filled(
                step,
                layer_plan.bbox,
                layer_plan.factor,
            ),
            steps,
        )
    )
    values = np.stack([raster.values for raster in rasters])
    if dataset.fallback is None:
        return FilledStep(values, None)

    return FilledStep(values, np.stack([raster.filled for raster in rasters]))


def encode_values(
    values: np.ndarray,
    dtype: str,
    scale: float,
    offset: float,
    fill_value: int,
) -> np.ndarray:
    """Quantize floats to integers, using fill_value for NaN values.

    fill_value is the dtype's minimum or maximum, and no real value is encoded onto it.
    """
    limits = np.iinfo(dtype)
    lowest = limits.min + (fill_value == limits.min)
    highest = limits.max - (fill_value == limits.max)
    quantized = np.rint((values - offset) / scale).clip(lowest, highest)
    encoded = np.where(np.isnan(values), fill_value, quantized)
    return encoded.astype(dtype)


def _finalize_scene(
    root: zarr.Group,
    temp_dir: Path,
    scene_document: JsonObject,
    title: str,
    area: Area,
    scene_plan: Plan,
) -> None:
    problems = validate(scene_document, VERSION)
    if problems:
        raise RuntimeError("Invalid scene.json: " + "; ".join(problems))

    root.attrs.update(
        {
            "title": title,
            "conventions": "CF-1.8",
            "generator": f"soe {__version__}",
            "credits": scene_document["credits"],
        },
    )

    _consolidate_metadata(temp_dir)
    _write_scene_documents(temp_dir, scene_document, title, area, scene_plan)


def _consolidate_metadata(temp_dir: Path) -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Consolidated metadata is currently not part",
        )
        zarr.consolidate_metadata(str(temp_dir / "data.zarr"))


def _write_scene_documents(
    temp_dir: Path,
    scene_document: JsonObject,
    title: str,
    area: Area,
    scene_plan: Plan,
) -> None:
    area_name = (area.boundary or {}).get("name", title)
    area_feature = {
        "type": "Feature",
        "properties": {"name": area_name},
        "geometry": mapping(scene_plan.geometry),
    }

    (temp_dir / "area.geojson").write_text(
        json.dumps(area_feature),
        encoding="utf-8",
    )
    (temp_dir / "scene.json").write_text(
        json.dumps(scene_document, indent=1),
        encoding="utf-8",
    )


def _publish_scene(temp_dir: Path, final_dir: Path, built_size: int) -> int:
    if final_dir.is_dir():
        return _directory_size(final_dir)

    try:
        os.replace(temp_dir, final_dir)
    except OSError:
        # Another build may have published the same scene concurrently.
        if final_dir.is_dir():
            return _directory_size(final_dir)
        raise

    return built_size


def _directory_size(directory: Path | str) -> int:
    return sum(
        file_path.stat().st_size
        for file_path in Path(directory).rglob("*")
        if file_path.is_file()
    )


def _write_array(
    group: zarr.Group,
    name: str,
    data: np.ndarray,
    dimensions: list[str],
    attributes: JsonObject | None = None,
    fill_value: int | None = None,
) -> zarr.Array:
    array = group.create_array(
        name,
        shape=data.shape,
        chunks=data.shape,
        dtype=data.dtype,
        fill_value=fill_value,
        compressors=COMPRESSION,
        dimension_names=dimensions,
        attributes=attributes or {},
    )
    array[...] = data
    return array
