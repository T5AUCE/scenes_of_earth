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
from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape

from .sources import FIRST_MONTH, GRID, NCOLS, NROWS

MAX_BODY = 1_000_000
MAX_VERTICES = 5000
MIN_CELLS = 25  # drawn shapes smaller than this are rejected
PAD_CELLS = 10  # bbox is padded to at least 0.5 degrees
MAX_SOURCE = 100_000_000  # source cells x months, checked before any read
MAX_OUTPUT = 25_000_000  # output cells x months after aggregation
MAX_TILES = 100  # GLO-90 tiles
FACTORS = (1, 2, 4, 8)


class AreaError(ValueError):
    """A request the backend refuses; the API turns this into a 422."""


@dataclass
class Area:
    geom: object  # shapely (Multi)Polygon, EPSG:4326
    boundary: dict | None = None  # boundary row for named areas, None for drawn ones

    @property
    def named(self):
        return self.boundary is not None


@dataclass
class Plan:
    geometry: object  # clipped to coverage
    window: tuple  # (col, row, width, height) on the global grid, snapped to `factor`
    factor: int
    transform: Affine  # of the aggregated rain grid
    shape: tuple  # (ny, nx) of the aggregated rain grid
    mask: np.ndarray  # uint8, aggregated grid
    cells_inside: int
    bbox: list  # [W, S, E, N]
    clipped: bool
    notices: list = field(default_factory=list)


def check_months(start, end, latest):
    """Validate 'YYYY-MM' start/end: FIRST_MONTH <= start <= end <= latest."""
    for v in (start, end):
        if not (isinstance(v, str) and len(v) == 7 and v[4] == "-" and v[:4].isdigit()
                and v[5:].isdigit() and 1 <= int(v[5:]) <= 12):
            raise AreaError("start and end must be 'YYYY-MM'")
    if start < FIRST_MONTH:
        raise AreaError(f"start must be {FIRST_MONTH} or later")
    if end < start:
        raise AreaError("end must not be before start")
    if end > latest:
        raise AreaError(f"end must be {latest} or earlier")


def _positions(coords):
    """Every [x, y, ...] position of a GeoJSON coordinates array (iterative, nesting depth capped)."""
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
        raise AreaError("coordinates must be finite numbers within +-180 longitude and +-90 latitude")
    try:
        geom = shape(obj)
    except Exception as e:
        raise AreaError(f"invalid geometry: {e}") from e
    geom = shapely.make_valid(geom)
    polys = [p for p in shapely.get_parts(shapely.get_parts(geom)) if isinstance(p, Polygon) and not p.is_empty]
    if not polys:
        raise AreaError("geometry is empty")
    geom = shapely.set_precision(MultiPolygon(polys) if len(polys) > 1 else polys[0], 1e-4)
    if geom.is_empty or geom.area == 0:
        raise AreaError("geometry is empty")
    return shapely.normalize(geom)


def _pad(lo, hi, size):
    """Grow [lo, hi) to at least PAD_CELLS, centred, inside [0, size)."""
    extra = PAD_CELLS - (hi - lo)
    if extra <= 0:
        return lo, hi
    lo, hi = lo - extra // 2, hi + extra - extra // 2
    if lo < 0:
        lo, hi = 0, hi - lo
    if hi > size:
        lo, hi = max(0, lo - (hi - size)), size
    return lo, hi


def _cell_mask(geom, window_transform, shape_, all_touched=False):
    return geometry_mask([mapping(geom)], shape_, window_transform, invert=True, all_touched=all_touched)


def plan(area, n_months, datasets):
    """Work out window, aggregation factor, mask and notices; raise AreaError if the request is refused."""
    geom, notices = area.geom, []
    x0, y0, x1, y1 = geom.bounds
    if x1 - x0 > 180:
        raise AreaError("shapes crossing the antimeridian are not supported")
    clipped_geom = geom.intersection(box(-180, -60, 180, 60))
    if clipped_geom.is_empty or clipped_geom.area == 0:
        raise AreaError("area is outside rain coverage (60S to 60N)")
    clipped = clipped_geom.area < geom.area * (1 - 1e-9)
    if clipped:
        notices.append("Part of the area lies outside rain coverage (60S to 60N) and was clipped.")

    x0, y0, x1, y1 = clipped_geom.bounds
    c0, c1 = math.floor(round((x0 + 180) / 0.05, 6)), math.ceil(round((x1 + 180) / 0.05, 6))
    r0, r1 = math.floor(round((60 - y1) / 0.05, 6)), math.ceil(round((60 - y0) / 0.05, 6))
    c0, c1, r0, r1 = max(c0, 0), min(c1, NCOLS), max(r0, 0), min(r1, NROWS)
    pc0, pc1 = _pad(c0, c1, NCOLS)
    pr0, pr1 = _pad(r0, r1, NROWS)
    if (pc0, pc1, pr0, pr1) != (c0, c1, r0, r1):
        notices.append("The map area was padded to at least 0.5 x 0.5 degrees for context.")
    c0, c1, r0, r1 = pc0, pc1, pr0, pr1

    rain = any(ds.time_varying for ds in datasets)
    if rain and (c1 - c0) * (r1 - r0) * n_months > MAX_SOURCE:
        raise AreaError("area and period are too large to read; choose a smaller area or fewer months")

    t_native = GRID @ Affine.translation(c0, r0)
    native = _cell_mask(clipped_geom, t_native, (r1 - r0, c1 - c0))
    native_cells = int(native.sum())
    if native_cells < MIN_CELLS:
        if not area.named:
            raise AreaError(f"drawn shape is too small (needs at least {MIN_CELLS} rain cells, about 750 km2)")
        notices.append("This area is smaller than 25 rain cells (about 750 km2); rain values are coarse.")

    factor = 1
    if rain:
        for f in FACTORS:
            w = -(-c1 // f) * f - c0 // f * f
            h = -(-r1 // f) * f - r0 // f * f
            if (w // f) * (h // f) * n_months <= MAX_OUTPUT:
                factor = f
                break
        else:
            raise AreaError("area and period are too large even at 8x aggregation")
        if factor > 1:
            notices.append(f"Rain was averaged over {factor}x{factor} cells ({0.05 * factor:g} degrees) "
                           "to fit the size budget.")
    c0, c1, r0, r1 = c0 // factor * factor, -(-c1 // factor) * factor, r0 // factor * factor, -(-r1 // factor) * factor
    if rain and (c1 - c0) * (r1 - r0) * n_months > MAX_SOURCE:
        raise AreaError("area and period are too large to read; choose a smaller area or fewer months")

    transform = GRID @ Affine.translation(c0, r0) @ Affine.scale(factor)
    ny, nx = (r1 - r0) // factor, (c1 - c0) // factor
    mask = _cell_mask(clipped_geom, transform, (ny, nx))
    if not mask.any():
        mask = _cell_mask(clipped_geom, transform, (ny, nx), all_touched=True)
        if not mask.any():
            raise AreaError("area does not cover any rain cells")
        notices.append("No cell centre fell inside this small area, so every cell it touches is used.")
    bbox = [round(v, 6) for v in (transform.c, transform.f + ny * transform.e, transform.c + nx * transform.a, transform.f)]

    for ds in datasets:
        if ds.max_tiles and ds.tile_count(bbox) > ds.max_tiles:
            raise AreaError(f"{ds.id} needs more than {ds.max_tiles} source tiles; choose a smaller area")
    return Plan(clipped_geom, (c0, r0, c1 - c0, r1 - r0), factor, transform, (ny, nx),
                mask.astype("uint8"), int(mask.sum()), bbox, clipped, notices)
