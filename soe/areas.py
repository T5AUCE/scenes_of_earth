"""Area handling: validate drawn GeoJSON, then plan the grid window, aggregation and mask.

Everything here is offline. Every rule that can reject a request lives here, so
rejections happen before any network read.
"""
import math
from dataclasses import dataclass, field

import numpy as np
import shapely
from rasterio.features import geometry_mask
from rasterio.transform import Affine
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape

from .sources import GRID

MAX_BODY = 1_000_000
MAX_VERTICES = 5000
MIN_CELLS = 25  # drawn shapes smaller than this are rejected
PAD_DEG = 0.5  # each layer's window is padded to at least this size
# Source cells times steps, summed over time-varying layers and checked before any read.
MAX_SOURCE = 100_000_000
# Raw bytes of all layers' arrays after aggregation.
MAX_OUTPUT_BYTES = 50_000_000
FACTORS = (1, 2, 4, 8)


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
    for v in (start, end):
        if not (isinstance(v, str) and len(v) == 7 and v[4] == "-" and v[:4].isdigit()
                and v[5:].isdigit() and 1 <= int(v[5:]) <= 12):
            raise AreaError("start and end must be 'YYYY-MM'")
    if start < first:
        raise AreaError(f"{who}start must be {first} or later")
    if end < start:
        raise AreaError("end must not be before start")
    if end > latest:
        raise AreaError(f"{who}end must be {latest} or earlier")


def _positions(coords):
    """Every [x, y, ...] position of a GeoJSON coordinates array, with the nesting depth capped."""
    out, stack = [], [(coords, 0)]
    while stack:
        c, depth = stack.pop()
        if not isinstance(c, (list, tuple)) or depth > 5:
            raise AreaError("invalid coordinates")
        if c and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in c):
            out.append(c)
        else:
            stack.extend((v, depth + 1) for v in c)
    return out


def clean_polygon(obj):
    """Validate drawn GeoJSON and return a repaired, rounded (1e-4), normalised (Multi)Polygon."""
    if isinstance(obj, dict) and obj.get("type") == "Feature":
        obj = obj.get("geometry")
    if not isinstance(obj, dict) or obj.get("type") not in ("Polygon", "MultiPolygon"):
        raise AreaError("geometry must be a Polygon or MultiPolygon")
    pos = _positions(obj.get("coordinates"))
    if len(pos) > MAX_VERTICES:
        raise AreaError(f"too many vertices (max {MAX_VERTICES})")
    try:
        # Written so NaN, infinity and huge integers all fail the comparison (no float conversion).
        ok = all(len(p) >= 2 and abs(p[0]) <= 180 and abs(p[1]) <= 90 for p in pos)
    except OverflowError:
        ok = False
    if not ok:
        raise AreaError(
            "coordinates must be finite numbers within +-180 longitude and +-90 latitude")
    try:
        geom = shape(obj)
    except Exception as e:
        raise AreaError(f"invalid geometry: {e}") from e
    geom = shapely.make_valid(geom)
    polys = [p for p in shapely.get_parts(shapely.get_parts(geom))
             if isinstance(p, Polygon) and not p.is_empty]
    if not polys:
        raise AreaError("geometry is empty")
    geom = shapely.set_precision(MultiPolygon(polys) if len(polys) > 1 else polys[0], 1e-4)
    if geom.is_empty or geom.area == 0:
        raise AreaError("geometry is empty")
    return shapely.normalize(geom)


def _pad(lo, hi, lim_lo, lim_hi, need):
    """Grow [lo, hi) to at least `need` cells, centred, inside [lim_lo, lim_hi)."""
    extra = need - (hi - lo)
    if extra <= 0:
        return lo, hi
    lo, hi = lo - extra // 2, hi + extra - extra // 2
    if lo < lim_lo:
        lo, hi = lim_lo, hi + lim_lo - lo
    if hi > lim_hi:
        lo, hi = max(lim_lo, lo - (hi - lim_hi)), lim_hi
    return lo, hi


def snap(lo, hi, f):
    """Widen [lo, hi) outwards to multiples of f."""
    return lo // f * f, -(-hi // f) * f


def _cell_mask(geom, window_transform, shape_, all_touched=False):
    return geometry_mask([mapping(geom)], shape_, window_transform, invert=True,
                         all_touched=all_touched)


def unwrap(geom):
    """Put a shape that crosses 180 into one longitude frame.

    Parts west of 0 move east by 360, so longitudes go up to 360.
    """
    x0, _, x1, _ = geom.bounds
    if x1 - x0 <= 180:
        return geom
    parts = [translate(p, xoff=360) if sum(p.bounds[::2]) < 0 else p
             for p in shapely.get_parts(geom)]
    return MultiPolygon(parts)


def _extent(coverage):
    """Coverage as (W, S, E, N) in the unwrapped frame: a global coverage reaches 360 east."""
    w, s_, e, n = coverage
    return w, s_, 360 if (w, e) == (-180, 180) else e, n


def _span(bounds, cell):
    """Outward cell range (c0, c1, r0, r1) of bounds on the grid that starts at 180W, 60N."""
    x0, y0, x1, y1 = bounds
    return (math.floor(round((x0 + 180) / cell, 6)), math.ceil(round((x1 + 180) / cell, 6)),
            math.floor(round((60 - y1) / cell, 6)), math.ceil(round((60 - y0) / cell, 6)))


def _layer_grid(ds, window, factor):
    """(transform, (ny, nx), bbox, res) of a layer over the anchor-grid cells c0:c1, r0:r1."""
    c0, c1, r0, r1 = window
    cell = ds.anchor_res
    bbox = [round(v, 6) for v in
            (-180 + c0 * cell, 60 - r1 * cell, -180 + c1 * cell, 60 - r0 * cell)]
    res = cell * factor if ds.time_varying else ds.res_for(bbox)
    shape = (round((bbox[3] - bbox[1]) / res), round((bbox[2] - bbox[0]) / res))
    return Affine(res, 0, bbox[0], 0, -res, bbox[3]), shape, bbox, res


def _layer_bytes(ds, shape, steps=1):
    """Raw bytes of a layer's arrays: every array per step, plus one mask byte per cell."""
    bytes_per_step = sum(np.dtype(enc[0]).itemsize for enc in ds.encoding.values())
    return shape[0] * shape[1] * (steps * bytes_per_step + 1)


def plan(area, datasets, start, end):
    """Work out each layer's grid, mask and time steps, with one aggregation factor for all series.

    Raises AreaError if the request is refused. `start` and `end` ('YYYY-MM') matter only to
    time-varying layers.
    """
    geom, notices = unwrap(area.geom), []
    x0, y0, x1, y1 = geom.bounds
    if x1 - x0 > 180:
        raise AreaError("area spans more than 180 degrees of longitude")

    parts, layer_notices, ref, clipped = {}, {}, geom, False
    for ds in datasets:
        part = geom.intersection(box(*_extent(ds.coverage)))
        if part.is_empty or part.area == 0:
            raise AreaError(f"area is outside {ds.title} coverage")
        layer_notices[ds.id] = []
        if part.area < geom.area * (1 - 1e-9):
            clipped = True
            layer_notices[ds.id].append(
                f"Part of the area lies outside {ds.title} coverage and was clipped.")
        parts[ds.id], ref = part, ref.intersection(part)
    if ref.is_empty or ref.area == 0:
        raise AreaError("area is outside the coverage shared by the selected layers")

    windows, padded = {}, False
    for ds in datasets:
        cell = ds.anchor_res
        limits = _span(_extent(ds.coverage), cell)
        c0, c1, r0, r1 = _span(parts[ds.id].bounds, cell)
        c0, c1 = max(c0, limits[0]), min(c1, limits[1])
        r0, r1 = max(r0, limits[2]), min(r1, limits[3])
        need = round(PAD_DEG / cell)
        window = _pad(c0, c1, limits[0], limits[1], need) + _pad(r0, r1, limits[2], limits[3], need)
        padded |= window != (c0, c1, r0, r1)
        windows[ds.id] = window
    if padded:
        notices.append("The map area was padded to at least 0.5 x 0.5 degrees for context.")

    steps = {ds.id: ds.steps(start, end) for ds in datasets if ds.time_varying}

    def source_cells(layer_windows):
        return sum((c1 - c0) * (r1 - r0) * len(steps[ds_id])
                   for ds_id, (c0, c1, r0, r1) in layer_windows.items() if ds_id in steps)

    too_large_to_read = (
        "area and period are too large to read; choose a smaller area or fewer months")
    if source_cells(windows) > MAX_SOURCE:
        raise AreaError(too_large_to_read)

    c0, c1, r0, r1 = _span(ref.bounds, GRID.a)
    native = _cell_mask(ref, GRID @ Affine.translation(c0, r0), (r1 - r0, c1 - c0))
    if int(native.sum()) < MIN_CELLS:
        if not area.named:
            raise AreaError(
                f"drawn shape is too small (needs at least {MIN_CELLS} 0.05° cells, about 750 km2)")
        notices.append(f"This area is smaller than {MIN_CELLS} 0.05° cells (about 750 km2); "
                       "values are coarse.")

    budget = MAX_OUTPUT_BYTES
    # Static layers have a fixed cost, so they are budgeted first.
    for ds in datasets:
        if ds.time_varying:
            continue
        _, shape, bbox, _ = _layer_grid(ds, windows[ds.id], 1)
        if ds.max_tiles and ds.tile_count(bbox) > ds.max_tiles:
            raise AreaError(
                f"{ds.id} needs more than {ds.max_tiles} source tiles; choose a smaller area")
        budget -= _layer_bytes(ds, shape)
    if budget < 0:
        raise AreaError("the static layers alone exceed the size budget; choose a smaller area")

    series = [ds for ds in datasets if ds.time_varying]
    factor = 1
    if series:
        for trial in FACTORS:
            snapped = {ds.id: snap(*windows[ds.id][:2], trial) + snap(*windows[ds.id][2:], trial)
                       for ds in series}
            out = sum(_layer_bytes(ds, ((r1 - r0) // trial, (c1 - c0) // trial), len(steps[ds.id]))
                      for ds in series for c0, c1, r0, r1 in [snapped[ds.id]])
            if out <= budget:
                factor = trial
                break
        else:
            raise AreaError("area and period are too large even at 8x aggregation")
        windows.update(snapped)
        if source_cells(windows) > MAX_SOURCE:
            raise AreaError(too_large_to_read)

    layers = {}
    for ds in datasets:
        layer_factor = factor if ds.time_varying else 1
        transform, shape, bbox, res = _layer_grid(ds, windows[ds.id], layer_factor)
        notes = layer_notices[ds.id]
        if layer_factor > 1:
            notes.append(f"{ds.title} was averaged over {layer_factor}x{layer_factor} cells "
                         f"({res:g} degrees) to fit the size budget.")
        mask = _cell_mask(parts[ds.id], transform, shape)
        if not mask.any():
            mask = _cell_mask(parts[ds.id], transform, shape, all_touched=True)
            if not mask.any():
                raise AreaError(f"area does not cover any {ds.title} cells")
            notes.append(
                "No cell centre fell inside this small area, so every cell it touches is used.")
        if note := ds.notice(bbox):
            notes.append(note)
        layers[ds.id] = LayerPlan(ds.id, transform, shape, bbox, res, layer_factor,
                                  mask.astype("uint8"), int(mask.sum()), steps.get(ds.id, []),
                                  notes)
    bboxes = [lp.bbox for lp in layers.values()]
    bbox = [min(b[0] for b in bboxes), min(b[1] for b in bboxes),
            max(b[2] for b in bboxes), max(b[3] for b in bboxes)]
    return Plan(ref, layers, bbox, clipped, notices)
