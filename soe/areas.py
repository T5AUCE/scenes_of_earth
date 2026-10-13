"""Area handling: validate drawn GeoJSON, then plan the grid window, aggregation and mask."""
import math
from dataclasses import dataclass, field

import numpy as np
import shapely
from rasterio.features import geometry_mask
from rasterio.transform import Affine
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape

from .sources import GRID

MAX_BODY_BYTES = 1_000_000
MAX_VERTICES = 5000
MAX_NESTING_DEPTH = 5
MAX_LONGITUDE_DEG = 180
MAX_LATITUDE_DEG = 90
WORLD_WIDTH_DEG = 360
DRAWN_PRECISION_DEG = 1e-4

MIN_CELLS = 25  # drawn shapes smaller than this are rejected
PAD_DEG = 0.5  # each layer's window is padded to at least this size
PADDED_NOTICE = "The map area was padded to at least 0.5 x 0.5 degrees for context."
AREA_TOLERANCE = 1e-9  # relative; below this a clipped area counts as unchanged

# Source cells times steps, summed over time-varying layers and checked before any read.
MAX_SOURCE = 100_000_000
# Raw bytes of all layers' arrays after aggregation.
MAX_OUTPUT_BYTES = 50_000_000
FACTORS = (1, 2, 4, 8)

GRID_DECIMALS = 6  # cell indices and bounds are rounded to this to absorb float noise
GRID_WEST_DEG = -180
GRID_NORTH_DEG = 60


class AreaError(ValueError):
    """A request the backend refuses; the API turns this into a 422."""


@dataclass
class Area:
    """The requested area: a shape, plus its boundary row when it was picked by name."""

    geom: object  # shapely (Multi)Polygon, EPSG:4326
    boundary: dict | None = None  # boundary row for named areas, None for drawn ones

    @property
    def named(self):
        return self.boundary is not None


@dataclass
class LayerPlan:
    """Grid, mask and time steps of one layer."""

    ds_id: str
    transform: Affine  # of this layer's grid
    shape: tuple  # (ny, nx)
    bbox: list  # [W, S, E, N]
    res: float  # cell size, degrees
    factor: int  # block-mean aggregation of time-varying layers; 1 otherwise
    mask: np.ndarray  # uint8
    cells_inside: int
    steps: list  # ISO dates; empty for static layers
    notices: list = field(default_factory=list)


@dataclass
class Plan:
    """The result of plan(): one LayerPlan per dataset plus what is shared."""

    geometry: object  # clipped to the coverage shared by all layers
    layers: dict  # dataset id -> LayerPlan
    bbox: list  # [W, S, E, N] around all layers
    clipped: bool
    notices: list = field(default_factory=list)


def check_months(start, end, first, latest, who=""):
    """Validate 'YYYY-MM' start/end: first <= start <= end <= latest.

    `who` prefixes the range messages.
    """
    for month in (start, end):
        if not _is_month(month):
            raise AreaError("start and end must be 'YYYY-MM'")

    if start < first:
        raise AreaError(f"{who}start must be {first} or later")
    if end < start:
        raise AreaError("end must not be before start")
    if end > latest:
        raise AreaError(f"{who}end must be {latest} or earlier")


def _is_month(value):
    return (
        isinstance(value, str)
        and len(value) == 7
        and value[4] == "-"
        and value[:4].isdigit()
        and value[5:].isdigit()
        and 1 <= int(value[5:]) <= 12
    )


def clean_polygon(obj):
    """Validate drawn GeoJSON; return a repaired, rounded (1e-4 degrees), normalised polygon."""
    if isinstance(obj, dict) and obj.get("type") == "Feature":
        obj = obj.get("geometry")
    if not isinstance(obj, dict) or obj.get("type") not in ("Polygon", "MultiPolygon"):
        raise AreaError("geometry must be a Polygon or MultiPolygon")

    positions = _positions(obj.get("coordinates"))
    if len(positions) > MAX_VERTICES:
        raise AreaError(f"too many vertices (max {MAX_VERTICES})")
    if not _within_world(positions):
        raise AreaError(
            "coordinates must be finite numbers within +-180 longitude and +-90 latitude"
        )

    try:
        geometry = shape(obj)
    except Exception as error:
        raise AreaError(f"invalid geometry: {error}") from error

    polygons = _polygonal_parts(geometry)
    if not polygons:
        raise AreaError("geometry is empty")

    merged = MultiPolygon(polygons) if len(polygons) > 1 else polygons[0]
    geometry = shapely.set_precision(merged, DRAWN_PRECISION_DEG)
    if geometry.is_empty or geometry.area == 0:
        raise AreaError("geometry is empty")

    return shapely.normalize(geometry)


def _positions(coordinates):
    """Every [x, y, ...] position of a GeoJSON coordinates array, with the nesting depth capped."""
    positions, stack = [], [(coordinates, 0)]
    while stack:
        node, depth = stack.pop()
        if not isinstance(node, (list, tuple)) or depth > MAX_NESTING_DEPTH:
            raise AreaError("invalid coordinates")

        if node and all(_is_number(value) for value in node):
            positions.append(node)
        else:
            stack.extend((child, depth + 1) for child in node)
    return positions


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _within_world(positions):
    try:
        # Written so NaN, infinity and huge integers all fail the comparison (no float conversion).
        return all(
            len(position) >= 2
            and abs(position[0]) <= MAX_LONGITUDE_DEG
            and abs(position[1]) <= MAX_LATITUDE_DEG
            for position in positions
        )
    except OverflowError:
        return False


def _polygonal_parts(geometry):
    """Non-empty polygons of a repaired shape; stray lines and points are dropped."""
    collection = shapely.make_valid(geometry)
    # make_valid can nest a MultiPolygon in a GeometryCollection, so flatten twice.
    parts = shapely.get_parts(shapely.get_parts(collection))
    return [part for part in parts if isinstance(part, Polygon) and not part.is_empty]


def plan(area, datasets, start, end):
    """Work out each layer's grid, mask and time steps, with one aggregation factor for all series.

    Raises AreaError if the request is refused. `start` and `end` ('YYYY-MM') matter only to
    time-varying layers.
    """
    geometry = unwrap(area.geom)
    _check_longitude_span(geometry)

    parts, layer_notices, shared_geometry, clipped = _clip_to_coverage(geometry, datasets)
    windows, padded = _layer_windows(datasets, parts)
    notices = [PADDED_NOTICE] if padded else []

    steps = {dataset.id: dataset.steps(start, end) for dataset in datasets if dataset.time_varying}
    _check_source_size(windows, steps)

    notices += _small_area_notices(area, shared_geometry)

    budget_for_series = _budget_after_static_layers(datasets, windows)
    series = [dataset for dataset in datasets if dataset.time_varying]
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
    bboxes = [layer.bbox for layer in layers.values()]
    bbox = [
        min(layer_bbox[0] for layer_bbox in bboxes),
        min(layer_bbox[1] for layer_bbox in bboxes),
        max(layer_bbox[2] for layer_bbox in bboxes),
        max(layer_bbox[3] for layer_bbox in bboxes),
    ]

    return Plan(shared_geometry, layers, bbox, clipped, notices)


def unwrap(geom):
    """Put a shape that crosses 180 into one longitude frame.

    Parts west of 0 move east by 360, so longitudes go up to 360;
    parts that meet at 180 merge.
    """
    west, _, east, _ = geom.bounds
    if east - west <= MAX_LONGITUDE_DEG:
        return geom

    polygons = _polygonal_parts(geom)
    if not polygons:
        raise AreaError("geometry is empty")

    parts = [
        translate(part, xoff=WORLD_WIDTH_DEG) if sum(part.bounds[::2]) < 0 else part
        for part in polygons
    ]
    return shapely.unary_union(parts)


def _check_longitude_span(geometry):
    west, _, east, _ = geometry.bounds
    if east - west > MAX_LONGITUDE_DEG:
        raise AreaError("area spans more than 180 degrees of longitude")


def _clip_to_coverage(geometry, datasets):
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


def _extent(coverage):
    """Coverage as (W, S, E, N) in the unwrapped frame: a global coverage reaches 360 east."""
    west, south, east, north = coverage
    is_global = (west, east) == (-MAX_LONGITUDE_DEG, MAX_LONGITUDE_DEG)
    return west, south, WORLD_WIDTH_DEG if is_global else east, north


def _layer_windows(datasets, parts):
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


def _span(bounds, cell):
    """Outward cell range (c0, c1, r0, r1) of bounds on the grid that starts at 180W, 60N."""
    west, south, east, north = bounds
    return (
        math.floor(round((west - GRID_WEST_DEG) / cell, GRID_DECIMALS)),
        math.ceil(round((east - GRID_WEST_DEG) / cell, GRID_DECIMALS)),
        math.floor(round((GRID_NORTH_DEG - north) / cell, GRID_DECIMALS)),
        math.ceil(round((GRID_NORTH_DEG - south) / cell, GRID_DECIMALS)),
    )


def _pad(low, high, limit_low, limit_high, needed_cells):
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


def _check_source_size(windows, steps):
    if _source_cells(windows, steps) > MAX_SOURCE:
        raise AreaError(
            "area and period are too large to read; choose a smaller area or fewer months"
        )


def _source_cells(windows, steps):
    return sum(
        (c1 - c0) * (r1 - r0) * len(steps[dataset_id])
        for dataset_id, (c0, c1, r0, r1) in windows.items()
        if dataset_id in steps
    )


def _small_area_notices(area, shared_geometry):
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

        f"This area is smaller than {MIN_CELLS} 0.05° cells (about 750 km2); values are coarse."
    ]


def _budget_after_static_layers(datasets, windows):
    """Output bytes left for series; static layers have a fixed cost, so they are budgeted first."""
    budget = MAX_OUTPUT_BYTES
    for dataset in datasets:
        if dataset.time_varying:
            continue

        _, shape, bbox, _ = _layer_grid(dataset, windows[dataset.id], 1)
        if dataset.max_tiles and dataset.tile_count(bbox) > dataset.max_tiles:
            raise AreaError(
                f"{dataset.id} needs more than {dataset.max_tiles} source tiles; "
                "choose a smaller area"
            )
        budget -= _layer_bytes(dataset, shape)

    if budget < 0:
        raise AreaError("the static layers alone exceed the size budget; choose a smaller area")

    return budget


def _layer_grid(dataset, window, factor):
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
    shape = (round((bbox[3] - bbox[1]) / res), round((bbox[2] - bbox[0]) / res))
    return Affine(res, 0, bbox[0], 0, -res, bbox[3]), shape, bbox, res


def _layer_bytes(dataset, shape, steps=1):
    """Raw bytes of a layer's arrays: every array per step, plus one mask byte per cell."""
    bytes_per_step = sum(np.dtype(encoding[0]).itemsize for encoding in dataset.encoding.values())
    return shape[0] * shape[1] * (steps * bytes_per_step + 1)


def _aggregation_factor(series, windows, steps, budget):
    """Smallest block-mean factor whose series fit the budget, with the windows snapped to it."""
    for factor in FACTORS:
        snapped = {}
        output_bytes = 0
        for dataset in series:
            c0, c1, r0, r1 = windows[dataset.id]
            snapped[dataset.id] = snap(c0, c1, factor) + snap(r0, r1, factor)
            c0, c1, r0, r1 = snapped[dataset.id]
            grid_shape = ((r1 - r0) // factor, (c1 - c0) // factor)
            output_bytes += _layer_bytes(dataset, grid_shape, len(steps[dataset.id]))
        if output_bytes <= budget:
            return factor, snapped
    raise AreaError(f"area and period are too large even at {FACTORS[-1]}x aggregation")


def snap(low, high, factor):
    """Widen [low, high) outwards to multiples of `factor`."""
    return low // factor * factor, -(-high // factor) * factor


def _layer_plan(dataset, geometry, window, factor, steps, clip_notices):
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
    if note := dataset.notice(bbox):
        notices.append(note)

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
        notices,
    )


def _layer_mask(dataset, geometry, transform, grid_shape):
    """(mask, whether it fell back to every touched cell because no cell center was inside)."""
    mask = _cell_mask(geometry, transform, grid_shape)
    if mask.any():
        return mask, False

    mask = _cell_mask(geometry, transform, grid_shape, all_touched=True)
    if not mask.any():
        raise AreaError(f"area does not cover any {dataset.title} cells")

    return mask, True


def _cell_mask(geometry, window_transform, grid_shape, all_touched=False):
    return geometry_mask(
        [mapping(geometry)],
        grid_shape,
        window_transform,
        invert=True,
        all_touched=all_touched,
    )
