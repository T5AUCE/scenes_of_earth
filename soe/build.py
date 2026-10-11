"""Build immutable scene bundles containing raster data and metadata."""
import json
import os
import shutil
import warnings
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import numpy as np
import zarr
from shapely.geometry import mapping
from zarr.codecs import GzipCodec

from . import __version__
from .areas import AreaError, plan as make_plan
from .bundle import make, validate

MAX_WORKERS = 8
MEMORY_BUDGET_BYTES = 500_000_000
ESTIMATED_BYTES_PER_CELL = 13
BATCH_SIZE = 12
TILE_SIZE = 512
COMPRESSION = GzipCodec(level=5)


def build_scene(
    scene_id,
    area,
    start,
    end,
    datasets,
    title,
    scenes_dir,
    progress=lambda _: None,
):
    """Build or reuse the scene's bundle and return its size in bytes."""

    scenes_dir = Path(scenes_dir)
    final_dir = scenes_dir / scene_id

    # Content-addressed bundles are immutable and can be reused.
    if final_dir.is_dir():
        size = _directory_size(final_dir)
        progress(1.0)
        return size

    scene_plan = make_plan(area, datasets, start, end)

    with _temporary_scene_directory(scenes_dir, scene_id) as temp_dir:
        root = zarr.open_group(
            str(temp_dir / "data.zarr"),
            mode="w",
            zarr_format=3,
        )

        progress(0.05)

        layer_metadata = _write_layers(
            root, scene_plan, datasets, progress
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

        bundle_size = _directory_size(temp_dir)

        # If another build published this scene first, keep the existing bundle.
        bundle_size = _publish_scene(
            temp_dir, final_dir, bundle_size
        )

    progress(1.0)

    return bundle_size


@contextmanager
def _temporary_scene_directory(scenes_dir, scene_id):
    temp_dir = Path(scenes_dir) / ".tmp" / scene_id

    shutil.rmtree(temp_dir, ignore_errors=True)
    temp_dir.mkdir(parents=True)

    try:
        yield temp_dir
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _publish_scene(temp_dir, final_dir, built_size):
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


def _finalize_scene(
    root,
    temp_dir,
    scene_document,
    title,
    area,
    scene_plan,
):
    problems = validate(scene_document)
    if problems:
        raise RuntimeError(
            "Invalid scene.json: " + "; ".join(problems)
        )

    root.attrs.update(
        {
            "title": title,
            "conventions": "CF-1.8",
            "generator": f"soe {__version__}",
            "credits": scene_document["credits"],
        }
    )

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Consolidated metadata is currently not part",
        )
        zarr.consolidate_metadata(str(temp_dir / "data.zarr"))

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


def _directory_size(directory):
    return sum(
        file_path.stat().st_size
        for file_path in Path(directory).rglob("*")
        if file_path.is_file()
    )


def _write_layers(root, scene_plan, datasets, progress):
    layer_metadata = {}

    ordered_datasets = sorted(
        datasets,
        key=lambda dataset: dataset.time_varying,
    )

    for dataset in ordered_datasets:
        layer_plan = scene_plan.layers[dataset.id]
        layer_group = root.create_group(dataset.id)

        _write_coordinates_and_mask(layer_group, layer_plan)

        if dataset.time_varying:
            metadata = _write_time_series(
                layer_group,
                dataset,
                layer_plan,
                progress,
            )
        else:
            metadata = _write_static_layer(
                layer_group,
                dataset,
                layer_plan,
            )

        layer_metadata[dataset.id] = metadata

    return layer_metadata


def _write_coordinates_and_mask(layer_group, layer_plan):
    """Write cell-centre coordinates and the area mask."""
    height, width = layer_plan.shape
    longitude, latitude = _coordinates(
        layer_plan.transform, height, width
    )

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
        {"long_name": "1 = cell centre inside the area"},
    )


def _write_static_layer(layer_group, dataset, layer_plan):
    """Write an elevation raster and its derived hillshade."""
    elevation, transform = dataset.read(
        layer_plan.bbox,
        layer_plan.res,
    )

    _write_array(
        layer_group,
        dataset.arrays["elevation"],
        elevation,
        ["lat", "lon"],
        {
            "units": dataset.units,
            "long_name": "Elevation (resampled)",
        },
    )

    shade_settings = dataset.style["hillshade"]
    shade = hillshade(
        elevation,
        abs(transform.a),
        transform.f,
        shade_settings["azimuth"],
        shade_settings["altitude"],
    )

    shade_description = (
        f"Hillshade, azimuth {shade_settings['azimuth']}, "
        f"altitude {shade_settings['altitude']} (0-255)"
    )

    _write_array(
        layer_group,
        dataset.arrays["hillshade"],
        shade,
        ["lat", "lon"],
        {"long_name": shade_description},
    )

    return {}


def hillshade(
    elevation,
    resolution_degrees,
    latitude_top,
    azimuth=315,
    altitude=45,
):
    """Return uint8 hillshade (0-255) for a north-up grid with cells in degrees."""
    elevation = np.pad(
        elevation.astype("float64"),
        1,
        mode="edge",
    )

    height = elevation.shape[0] - 2
    latitude = (
        latitude_top
        - (np.arange(height) + 0.5) * resolution_degrees
    )

    # Gradients need cell sizes in metres to match elevation units.
    cell_width = (
        resolution_degrees
        * 111320
        * np.cos(np.radians(latitude))
    )[:, None].clip(min=1)

    cell_height = resolution_degrees * 110574

    northwest = elevation[:-2, :-2]
    north = elevation[:-2, 1:-1]
    northeast = elevation[:-2, 2:]
    west = elevation[1:-1, :-2]
    east = elevation[1:-1, 2:]
    southwest = elevation[2:, :-2]
    south = elevation[2:, 1:-1]
    southeast = elevation[2:, 2:]

    gradient_east = (
        (northeast + 2 * east + southeast)
        - (northwest + 2 * west + southwest)
    ) / (8 * cell_width)

    gradient_north = (
        (northwest + 2 * north + northeast)
        - (southwest + 2 * south + southeast)
    ) / (8 * cell_height)

    azimuth_radians = np.radians(azimuth)
    altitude_radians = np.radians(altitude)

    light_east = (
        np.sin(azimuth_radians) * np.cos(altitude_radians)
    )
    light_north = (
        np.cos(azimuth_radians) * np.cos(altitude_radians)
    )
    light_up = np.sin(altitude_radians)

    illumination = (
        -gradient_east * light_east
        -gradient_north * light_north
        +light_up
    ) / np.sqrt(
        gradient_east**2 + gradient_north**2 + 1
    )

    return np.rint(
        illumination.clip(0, 1) * 255
    ).astype("uint8")


def _write_time_series(layer_group, dataset, layer_plan, progress):
    """Write a time series in batches and return its display statistics."""
    steps = layer_plan.steps
    height, width = layer_plan.shape
    step_count = len(steps)

    dtype, scale, offset, fill_value = dataset.encoding["value"]

    _write_time_coordinate(layer_group, steps)

    series = _create_time_array(
        layer_group,
        dataset,
        layer_plan,
        dtype,
        scale,
        offset,
        fill_value,
    )

    statistics = _StatisticsAccumulator()

    worker_count = _choose_worker_count(layer_plan)

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        for batch_start in range(0, step_count, BATCH_SIZE):
            batch_steps = steps[
                batch_start:batch_start + BATCH_SIZE
            ]

            raster_batch = _read_batch(
                executor,
                dataset,
                layer_plan,
                batch_steps,
            )

            statistics.add(raster_batch, layer_plan.mask)

            encoded_batch = encode_values(
                raster_batch,
                dtype,
                scale,
                offset,
                fill_value,
            )

            batch_end = batch_start + len(batch_steps)
            series[batch_start:batch_end] = encoded_batch

            progress(
                0.05 + 0.9 * batch_end / step_count
            )

    value_stats = statistics.finish()

    return {
        "domain": dataset.domain(value_stats),
        "stats": value_stats,
    }


def _write_time_coordinate(layer_group, steps):
    """Write dates as integer days since the Unix epoch."""
    epoch = date(1970, 1, 1)

    days_since_epoch = np.array(
        [
            (date.fromisoformat(step) - epoch).days
            for step in steps
        ],
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
    layer_group,
    dataset,
    layer_plan,
    dtype,
    scale,
    offset,
    fill_value,
):
    """Create the chunked and sharded Zarr array for a time series."""
    step_count = len(layer_plan.steps)
    height, width = layer_plan.shape

    spatial_chunks = (
        min(height, TILE_SIZE),
        min(width, TILE_SIZE),
    )

    return layer_group.create_array(
        dataset.arrays["value"],
        shape=(step_count, height, width),
        chunks=(1, *spatial_chunks),
        shards=(
            min(step_count, BATCH_SIZE),
            *spatial_chunks,
        ),
        dtype=dtype,
        fill_value=fill_value,
        compressors=COMPRESSION,
        dimension_names=["time", "lat", "lon"],
        attributes={
            "units": dataset.units,
            "long_name": dataset.long_name,
            "scale_factor": scale,
            "add_offset": offset,
        },
    )


def _read_batch(executor, dataset, layer_plan, steps):
    rasters = executor.map(
        lambda step: dataset.read_step(
            step,
            layer_plan.bbox,
            layer_plan.factor,
        ),
        steps,
    )

    return np.stack(list(rasters))


def _choose_worker_count(layer_plan):
    """Limit concurrent raster reads using the estimated memory budget."""
    height, width = layer_plan.shape

    estimated_bytes_per_step = (
        height
        * width
        * layer_plan.factor**2
        * ESTIMATED_BYTES_PER_CELL
    )

    workers_allowed_by_memory = (
        MEMORY_BUDGET_BYTES
        // max(1, estimated_bytes_per_step)
    )

    return max(
        1,
        min(MAX_WORKERS, workers_allowed_by_memory),
    )


class _StatisticsAccumulator:
    """Accumulate exact basic statistics and an approximate 98th percentile."""

    def __init__(self):
        self._random = np.random.default_rng(0)
        self._samples = []
        self._minimum = np.inf
        self._maximum = -np.inf
        self._value_sum = 0.0
        self._value_count = 0

    def add(self, raster_batch, area_mask):
        """Accumulate valid values from one batch."""
        values = raster_batch[:, area_mask.astype(bool)]
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
                min(values.size, 100_000),
                replace=False,
            )
        )

    def finish(self):
        """Return rounded statistics or raise when no valid data exists."""
        if self._value_count == 0:
            raise AreaError("No valid data inside the area")

        percentile_98 = np.percentile(
            np.concatenate(self._samples),
            98,
        )

        return {
            "min": round(float(self._minimum), 2),
            "max": round(float(self._maximum), 2),
            "mean": round(
                self._value_sum / self._value_count,
                2,
            ),
            "p98": round(float(percentile_98), 2),
        }


def _coordinates(transform, height, width):
    """Return cell-centre longitude and latitude coordinates."""
    longitude = (
        transform.c
        + (np.arange(width) + 0.5) * transform.a
    )
    latitude = (
        transform.f
        + (np.arange(height) + 0.5) * transform.e
    )

    return longitude, latitude


def _write_array(
    group,
    name,
    data,
    dimensions,
    attributes=None,
):
    array = group.create_array(
        name,
        shape=data.shape,
        chunks=data.shape,
        dtype=data.dtype,
        compressors=COMPRESSION,
        dimension_names=dimensions,
        attributes=attributes or {},
    )

    array[...] = data

    return array


def encode_values(values, dtype, scale, offset, fill_value):
    """Quantize floats to integers, using fill_value for NaN values."""
    quantized = np.rint(
        (values - offset) / scale
    ).clip(0, fill_value - 1)

    encoded = np.where(
        np.isnan(values),
        fill_value,
        quantized,
    )

    return encoded.astype(dtype)
