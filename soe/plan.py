"""Scene planning: each layer's grid window, aggregation factor, mask and time steps."""
import math
from dataclasses import dataclass, field

import numpy as np
from rasterio.features import geometry_mask
from rasterio.transform import Affine
from shapely.geometry import box, mapping
from shapely.geometry.base import BaseGeometry

from .areas import MAX_LONGITUDE_DEG, WORLD_WIDTH_DEG, Area, AreaError, unwrap
from .sources import GRID, Bbox, Dataset, SeriesDataset

CellSpan = tuple[int, int, int, int]  # c0, c1, r0, r1 on an anchor grid

MIN_CELLS = 25  # drawn shapes smaller than this are rejected
PAD_DEG = 0.5  # each layer's window is padded to at least this size
PADDED_NOTICE = f"The map area was padded to at least {PAD_DEG} x {PAD_DEG} degrees for context."
AREA_TOLERANCE = 1e-9  # relative; below this a clipped area counts as unchanged

# Source cells times steps, summed over time-varying layers and checked before any read.
MAX_SOURCE = 100_000_000
# Raw bytes of all layers' arrays after aggregation.
MAX_OUTPUT_BYTES = 50_000_000
FACTORS = (1, 2, 4, 8)

GRID_DECIMALS = 6  # cell indices and bounds are rounded to this to absorb float noise
GRID_WEST_DEG = -180
GRID_NORTH_DEG = 60


@dataclass
class LayerPlan:
    """Grid, mask and time steps of one layer."""

    ds_id: str
    transform: Affine  # of this layer's grid
    shape: tuple  # (height, width)
    bbox: list  # [W, S, E, N]
    res: float  # cell size, degrees
    factor: int  # block-mean aggregation of time-varying layers; 1 otherwise
    mask: np.ndarray  # uint8
    cells_inside: int
    steps: list  # ISO dates; empty for static layers
    sources: list  # source dicts the layer reads, the main one first
    notices: list = field(default_factory=list)


@dataclass
class Plan:
    """The result of plan(): one LayerPlan per dataset plus what is shared."""

    geometry: object  # clipped to the coverage shared by all layers
    layers: dict  # dataset id -> LayerPlan
    bbox: list  # [W, S, E, N] around all layers
    clipped: bool
    notices: list = field(default_factory=list)


def plan(area: Area, datasets: list[Dataset], start: str, end: str) -> Plan:
    """Work out each layer's grid, mask and time steps, with one aggregation factor for all series.

    Raises AreaError if the request is refused. `start` and `end` ('YYYY-MM') matter only to
    time-varying layers.
    """
    geometry = unwrap(area.geom)
    _check_longitude_span(geometry)

    parts, layer_notices, shared_geometry, clipped = _clip_to_coverage(geometry, datasets)
    windows, padded = _layer_windows(datasets, parts)
    notices = [PADDED_NOTICE] if padded else []

    series = [dataset for dataset in datasets if isinstance(dataset, SeriesDataset)]
    steps = {dataset.id: dataset.steps(start, end) for dataset in series}
    _check_source_size(windows, steps)

    notices += _small_area_notices(area, shared_geometry)

    budget_for_series = _budget_after_static_layers(datasets, windows)
    factor = 1
    if series:
        factor, series_windows = _aggregation_factor(series, windows, steps, budget_for_series)
        windows.update(series_windows)
        _check_source_size(windows, steps)

    layers = {
        dataset.id: _layer_plan(
            dataset,
            parts[dataset.id],
            windows[dataset.id],
            factor if dataset.time_varying else 1,
            steps.get(dataset.id, []),
            layer_notices[dataset.id],
        )
        for dataset in datasets
    }
    bbox = _enclosing_bbox([layer.bbox for layer in layers.values()])

    return Plan(shared_geometry, layers, bbox, clipped, notices)


def _check_longitude_span(geometry: BaseGeometry) -> None:
    west, _, east, _ = geometry.bounds
    if east - west > MAX_LONGITUDE_DEG:
        raise AreaError("area spans more than 180 degrees of longitude")


def _clip_to_coverage(
    geometry: BaseGeometry,
    datasets: list[Dataset],
) -> tuple[dict[str, BaseGeometry], dict[str, list[str]], BaseGeometry, bool]:
    """Per-layer clipped geometry, per-layer notices, the geometry all layers share, was clipped."""
    parts, layer_notices = {}, {}
    shared_geometry, clipped = geometry, False
    for dataset in datasets:
        part = geometry.intersection(box(*_extent(dataset.coverage)))
        if part.is_empty or part.area == 0:
            raise AreaError(f"area is outside {dataset.title} coverage")

        layer_notices[dataset.id] = []
        if part.area < geometry.area * (1 - AREA_TOLERANCE):
            clipped = True
            layer_notices[dataset.id].append(
                f"Part of the area lies outside {dataset.title} coverage and was clipped."
            )
        parts[dataset.id] = part
        shared_geometry = shared_geometry.intersection(part)

    if shared_geometry.is_empty or shared_geometry.area == 0:
        raise AreaError("area is outside the coverage shared by the selected layers")

    return parts, layer_notices, shared_geometry, clipped


def _extent(coverage: Bbox) -> Bbox:
    """Coverage as (W, S, E, N) in the unwrapped frame: a global coverage reaches 360 east."""
    west, south, east, north = coverage
    is_global = (west, east) == (-MAX_LONGITUDE_DEG, MAX_LONGITUDE_DEG)
    return west, south, WORLD_WIDTH_DEG if is_global else east, north


def _layer_windows(
    datasets: list[Dataset],
    parts: dict[str, BaseGeometry],
) -> tuple[dict[str, CellSpan], bool]:
    """Anchor-grid cell window (c0, c1, r0, r1) of each layer, padded; and whether any was."""
    windows, padded = {}, False
    for dataset in datasets:
        cell = dataset.anchor_res
        limit_c0, limit_c1, limit_r0, limit_r1 = _span(_extent(dataset.coverage), cell)
        c0, c1, r0, r1 = _span(parts[dataset.id].bounds, cell)
        c0, c1 = max(c0, limit_c0), min(c1, limit_c1)
        r0, r1 = max(r0, limit_r0), min(r1, limit_r1)

        needed_cells = round(PAD_DEG / cell)
        columns = _pad(c0, c1, limit_c0, limit_c1, needed_cells)
        rows = _pad(r0, r1, limit_r0, limit_r1, needed_cells)
        window = columns + rows
        padded |= window != (c0, c1, r0, r1)
        windows[dataset.id] = window
    return windows, padded


def _span(bounds: Bbox, cell: float) -> CellSpan:
    """Outward cell range (c0, c1, r0, r1) of bounds on the grid that starts at 180W, 60N."""
    west, south, east, north = bounds
    return (
        math.floor(round((west - GRID_WEST_DEG) / cell, GRID_DECIMALS)),
        math.ceil(round((east - GRID_WEST_DEG) / cell, GRID_DECIMALS)),
        math.floor(round((GRID_NORTH_DEG - north) / cell, GRID_DECIMALS)),
        math.ceil(round((GRID_NORTH_DEG - south) / cell, GRID_DECIMALS)),
    )


def _pad(
    low: int,
    high: int,
    limit_low: int,
    limit_high: int,
    needed_cells: int,
) -> tuple[int, int]:
    """Grow [low, high) to at least `needed_cells` cells, centred, within the limits."""
    extra = needed_cells - (high - low)
    if extra <= 0:
        return low, high

    low, high = low - extra // 2, high + extra - extra // 2
    if low < limit_low:
        low, high = limit_low, high + limit_low - low
    if high > limit_high:
        low, high = max(limit_low, low - (high - limit_high)), limit_high
    return low, high


def _check_source_size(windows: dict[str, CellSpan], steps: dict[str, list[str]]) -> None:
    if _source_cells(windows, steps) > MAX_SOURCE:
        raise AreaError(
            "area and period are too large to read; choose a smaller area or fewer months"
        )


def _source_cells(windows: dict[str, CellSpan], steps: dict[str, list[str]]) -> int:
    return sum(
        (c1 - c0) * (r1 - r0) * len(steps[dataset_id])
        for dataset_id, (c0, c1, r0, r1) in windows.items()
        if dataset_id in steps
    )


def _small_area_notices(area: Area, shared_geometry: BaseGeometry) -> list[str]:
    c0, c1, r0, r1 = _span(shared_geometry.bounds, GRID.a)
    window_transform = GRID @ Affine.translation(c0, r0)
    native_mask = _cell_mask(shared_geometry, window_transform, (r1 - r0, c1 - c0))
    if int(native_mask.sum()) >= MIN_CELLS:
        return []

    if not area.named:
        raise AreaError(
            f"drawn shape is too small (needs at least {MIN_CELLS} 0.05° cells, about 750 km2)"
        )

    return [
        f"This area is smaller than {MIN_CELLS} 0.05° cells (about 750 km2); values are coarse.",
    ]


def _budget_after_static_layers(
    datasets: list[Dataset],
    windows: dict[str, CellSpan],
) -> int:
    """Output bytes left for series; static layers have a fixed cost, so they are budgeted first."""
    budget = MAX_OUTPUT_BYTES
    for dataset in datasets:
        if dataset.time_varying:
            continue

        _, grid_shape, bbox, _ = _layer_grid(dataset, windows[dataset.id], 1)
        if dataset.max_tiles and dataset.tile_count(bbox) > dataset.max_tiles:
            raise AreaError(
                f"{dataset.id} needs more than {dataset.max_tiles} source tiles; "
                "choose a smaller area"
            )
        budget -= _layer_bytes(dataset, grid_shape)

    if budget < 0:
        raise AreaError("the static layers alone exceed the size budget; choose a smaller area")

    return budget


def _layer_grid(
    dataset: Dataset,
    window: CellSpan,
    factor: int,
) -> tuple[Affine, tuple[int, int], list[float], float]:
    """(transform, (height, width), bbox, res) of a layer over anchor-grid cells c0:c1, r0:r1."""
    c0, c1, r0, r1 = window
    cell = dataset.anchor_res
    bbox = [
        round(value, GRID_DECIMALS)
        for value in (
            GRID_WEST_DEG + c0 * cell,
            GRID_NORTH_DEG - r1 * cell,
            GRID_WEST_DEG + c1 * cell,
            GRID_NORTH_DEG - r0 * cell,
        )
    ]
    res = cell * factor if dataset.time_varying else dataset.res_for(bbox)
    grid_shape = (round((bbox[3] - bbox[1]) / res), round((bbox[2] - bbox[0]) / res))
    return Affine(res, 0, bbox[0], 0, -res, bbox[3]), grid_shape, bbox, res


def _layer_bytes(dataset: Dataset, grid_shape: tuple[int, int], steps: int = 1) -> int:
    """Raw bytes of a layer's arrays: every array per step, plus one mask byte per cell."""
    bytes_per_step = sum(np.dtype(encoding[0]).itemsize for encoding in dataset.encoding.values())
    return grid_shape[0] * grid_shape[1] * (steps * bytes_per_step + 1)


def _aggregation_factor(
    series: list[SeriesDataset],
    windows: dict[str, CellSpan],
    steps: dict[str, list[str]],
    budget: int,
) -> tuple[int, dict[str, CellSpan]]:
    """Smallest block-mean factor whose series fit the budget, with the windows snapped to it."""
    for factor in FACTORS:
        snapped = {dataset.id: _snap_window(windows[dataset.id], factor) for dataset in series}
        if _series_bytes(series, snapped, steps, factor) <= budget:
            return factor, snapped

    raise AreaError(f"area and period are too large even at {FACTORS[-1]}x aggregation")


def _snap_window(window: CellSpan, factor: int) -> CellSpan:
    """Widen both cell ranges of a window outwards to multiples of `factor`."""
    c0, c1, r0, r1 = window
    return _snap_range(c0, c1, factor) + _snap_range(r0, r1, factor)


def _snap_range(low: int, high: int, factor: int) -> tuple[int, int]:
    """Widen [low, high) outwards to multiples of `factor`."""
    return low // factor * factor, -(-high // factor) * factor


def _series_bytes(
    series: list[SeriesDataset],
    windows: dict[str, CellSpan],
    steps: dict[str, list[str]],
    factor: int,
) -> int:
    """Output bytes of all series once each window is averaged over factor x factor blocks."""
    total_bytes = 0
    for dataset in series:
        c0, c1, r0, r1 = windows[dataset.id]
        grid_shape = ((r1 - r0) // factor, (c1 - c0) // factor)
        total_bytes += _layer_bytes(dataset, grid_shape, len(steps[dataset.id]))
    return total_bytes


def _layer_plan(
    dataset: Dataset,
    geometry: BaseGeometry,
    window: CellSpan,
    factor: int,
    steps: list[str],
    clip_notices: list[str],
) -> LayerPlan:
    transform, grid_shape, bbox, res = _layer_grid(dataset, window, factor)
    notices = list(clip_notices)
    if factor > 1:
        notices.append(
            f"{dataset.title} was averaged over {factor}x{factor} cells "
            f"({res:g} degrees) to fit the size budget."
        )

    mask, used_touched = _layer_mask(dataset, geometry, transform, grid_shape)
    if used_touched:
        notices.append(
            "No cell center fell inside this small area, so every cell it touches is used."
        )
    notices += dataset.notices(bbox)

    return LayerPlan(
        dataset.id,
        transform,
        grid_shape,
        bbox,
        res,
        factor,
        mask.astype("uint8"),
        int(mask.sum()),
        steps,
        dataset.sources_for(bbox),
        notices,
    )


def _layer_mask(
    dataset: Dataset,
    geometry: BaseGeometry,
    transform: Affine,
    grid_shape: tuple[int, int],
) -> tuple[np.ndarray, bool]:
    """(mask, whether it fell back to every touched cell because no cell center was inside)."""
    mask = _cell_mask(geometry, transform, grid_shape)
    if mask.any():
        return mask, False

    mask = _cell_mask(geometry, transform, grid_shape, all_touched=True)
    if not mask.any():
        raise AreaError(f"area does not cover any {dataset.title} cells")

    return mask, True


def _enclosing_bbox(bboxes: list[list[float]]) -> list[float]:
    """[W, S, E, N] around every given bbox."""
    return [
        min(bbox[0] for bbox in bboxes),
        min(bbox[1] for bbox in bboxes),
        max(bbox[2] for bbox in bboxes),
        max(bbox[3] for bbox in bboxes),
    ]


def _cell_mask(
    geometry: BaseGeometry,
    window_transform: Affine,
    grid_shape: tuple[int, int],
    all_touched: bool = False,
) -> np.ndarray:
    return geometry_mask(
        [mapping(geometry)],
        grid_shape,
        window_transform,
        invert=True,
        all_touched=all_touched,
    )
