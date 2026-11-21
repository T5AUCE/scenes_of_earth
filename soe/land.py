"""OpenStreetMap land polygons, the coast that every scene area is cut to.

`import-land` loads the split land polygons into a local SQLite file with an R-tree, then stores
the clip of every country and state, so a request for a large area never waits for one. A clip is
the area's shape, reaching a little past its boundary, minus the land its same-level neighbours
hold, cut to land. An area with a maritime extent already reaches past its coast, so its clip is
its own shape cut to land, and a combined area joins the clips of its parts. Clips are cached in
the main database for each land version, and the land version is part of the scene id.
"""

import hashlib
import json
import logging
import math
import os
import shutil
import sqlite3
import tempfile
import time
import urllib.request
import zipfile
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ProcessPoolExecutor
from contextlib import closing, contextmanager
from dataclasses import dataclass, replace
from email.utils import parsedate_to_datetime
from itertools import repeat
from multiprocessing import get_context
from pathlib import Path

try:
    import resource
except ImportError:  # Windows has no resource module, so the import is optional.
    resource = None  # type: ignore[assignment]

import numpy as np
import shapely
from shapely.affinity import translate
from shapely.errors import ShapelyError
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import split

from . import db
from .areas import MAX_LONGITUDE_DEG, WORLD_WIDTH_DEG, Area, AreaError, polygonal_parts, unwrap
from .overture_import import COMBINED_ID_SUFFIX, KM_PER_DEGREE, OVERTURE_SOURCE
from .sources import SourceUnavailable

DEFAULT_LAND_PATH = "./data/land.sqlite"
LAND_ZIP_URL = "https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip"
DOWNLOAD_TIMEOUT_SECS = 60
DOWNLOAD_CHUNK_BYTES = 1 << 20
IMPORT_BATCH_ROWS = 20_000

# A named area may reach this far past its boundary to take land its boundary leaves out.
GROW_DEG = 0.02
# About 1 ha; smaller parts are islets or slivers left where neighbours were cut away.
MIN_PART_DEG2 = 1e-6
OUTLINE_PRECISION_DEG = 1e-5  # the build rounds outline and border coordinates to this
BORDER_MATCH_DEG = GROW_DEG / 2  # how close a cut edge must be to a neighbour to count as a border
SHARED_BORDER_DEG = 10 * OUTLINE_PRECISION_DEG  # slivers between neighbours are far narrower
RAY_DIRECTION_MIN_DEG = 4 * SHARED_BORDER_DEG  # the coast tail at a border end stays shorter
EDGE_MATCH_DEG = 1e-9  # a display vertex is copied from the edge it follows, so only float noise
CLIP_WORKERS_BY_LEVEL = {"country": 1, "state": 4}  # levels whose clips the import stores
# The limit counts virtual memory, so a runaway GEOS call raises instead of ending the pool.
CLIP_WORKER_LIMIT_BYTES = 6 * 1024**3
TERRITORIAL_LEVELS = ("country", "state")  # levels whose maritime extent holds all their land
# Member frames merge slivers below the build rounding precision before their union.
FRAME_SNAP_DEG = OUTLINE_PRECISION_DEG
# Version 2 removes the whole neighbour inside the display, not only the margin part.
# Version 3 buffers the neighbour before any grid snapping, so a neighbour narrower
# than the grid still leaves a gap.
# Version 4 grows the display outline past its tolerance, so it holds all the land.
# Version 5 widens the sea margin to a 400th of the span and stops it at land borders.
# Version 6 counts the grown shape and cuts the sea once, so later outlines may differ.
# Version 7 cuts an area with a maritime extent to its own shape and simplifies borders by level.
# Version 8 finds shared borders by their distance to neighbours and draws them on display edges.
CLIP_METHOD_VERSION = 8
SLOW_CLIP_SECS = 30  # clips slower than this print one line, so slow areas stay visible

PLANNING_TOLERANCE_DIVISOR = 200_000  # a 200000th of the larger bbox side, a tenth of a cell
MIN_DISPLAY_TOLERANCE_DEG = 0.001
DISPLAY_TOLERANCE_DIVISOR = 2000  # a 2000th of the larger bbox side, so small areas stay sharp
MAX_DISPLAY_VERTICES = 50_000
STALLED_RATIO = 0.9  # a coarser outline with over this share of the vertices gained too little
DISPLAY_CORNER_SEGMENTS = 2  # segments per quarter circle where the outline is grown
DISPLAY_GROWTH_FACTOR = 1.1  # makes up for the polygonal corners of the growth, 1.082 at least
DISPLAY_SPAN_DIVISOR = 400  # a 400th of the span keeps a centred coast line inside the mask
DISPLAY_BORDER_RAY_FACTOR = 2  # twice the growth is the shortest seaward ray
# Stored states reach at most about 950 rays, so a larger count would exhaust the union.
MAX_BORDER_RAYS = 2000

# The area's own border lines only serve below the zoom from which the basemap draws that level.
BORDER_ZOOM_BY_MAX_LEVEL = ((4, 5), (6, 9), (8, 11))
BORDER_FINEST_ZOOM = 12
UNASSIGNED_REPORT_COUNT = 10
# A country with more clip vertices is skipped, and this sits just above Canada's 4.24 million.
UNASSIGNED_REPORT_MAX_VERTICES = 4_300_000

STORED_LONGITUDE_RANGE_DEG = (-MAX_LONGITUDE_DEG, WORLD_WIDTH_DEG)  # of unwrapped boundary bboxes
REVISION_CHARS = 16  # hex characters of the sha256 kept as the revision of the neighbours

NO_LAND_MESSAGE = "area has no land"

log = logging.getLogger("soe.land")


@dataclass(frozen=True)
class Neighbour:
    """A boundary next to an area, and how far its longitudes move to join the area's frame."""

    id: str
    digest: str  # revision of its stored geometry
    shift_deg: float


@dataclass
class LandClip:
    """An area cut to land, with the outline to draw and the lines where it meets other areas."""

    geom: BaseGeometry  # land inside the area, in the longitude frame that planning uses
    display: BaseGeometry  # simplified geom, grown seaward and never onto a neighbour's land
    borders: BaseGeometry  # MultiLineString of display edges that run along land borders
    disputed: BaseGeometry  # MultiLineString of display edges that follow a disputed line


def store_path() -> str:
    """Where the land polygon store is read from (SOE_LAND)."""
    return os.environ.get("SOE_LAND", DEFAULT_LAND_PATH)


def land_version(store: Path | str) -> str:
    """The date of the imported land polygons. Raises SourceUnavailable when none are imported."""
    unavailable = SourceUnavailable("land polygons are not imported")
    if not Path(store).is_file():
        raise unavailable

    with _open_store(store) as connection:
        row = connection.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()

    if row is None:
        raise unavailable

    return row[0]


def land_in(store: Path | str, bounds: tuple[float, float, float, float]) -> list[Polygon]:
    """Land polygons whose bbox meets `bounds` (west, south, east, north).

    Bounds past 180 or -180 read the other side of the antimeridian and shift it into the same
    longitude frame, so an area that crosses 180 sees its land in one piece.
    """
    west, south, east, north = bounds
    reads = [(max(west, -MAX_LONGITUDE_DEG), min(east, MAX_LONGITUDE_DEG), 0)]
    if east > MAX_LONGITUDE_DEG:
        reads.append((-MAX_LONGITUDE_DEG, east - WORLD_WIDTH_DEG, WORLD_WIDTH_DEG))
    if west < -MAX_LONGITUDE_DEG:
        reads.append((west + WORLD_WIDTH_DEG, MAX_LONGITUDE_DEG, -WORLD_WIDTH_DEG))

    polygons: list[Polygon] = []
    with _open_store(store) as connection:
        for read_west, read_east, shift in reads:
            rows = connection.execute(
                "SELECT land.wkb FROM land_index JOIN land ON land.id = land_index.id "
                "WHERE land_index.max_x >= ? AND land_index.min_x <= ? "
                "AND land_index.max_y >= ? AND land_index.min_y <= ?",
                (read_west, read_east, south, north),
            )
            geometries = shapely.from_wkb([row[0] for row in rows])
            polygons += [translate(geometry, xoff=shift) for geometry in geometries]

    return polygons


def clip_to_land(
    store: Path | str,
    frame: BaseGeometry,
    neighbours: Sequence[BaseGeometry],
    grow_deg: float = GROW_DEG,
    min_part_deg2: float = MIN_PART_DEG2,
    disputed_lines: Sequence[BaseGeometry] = (),
) -> LandClip:
    """Cut `frame` to land, after growing it by `grow_deg` and taking back what `neighbours` hold.

    `frame` and `neighbours` share one longitude frame. Land that the frame fully contains is
    kept as it is, and only the land that crosses its edge is intersected. Parts under
    `min_part_deg2` are dropped, except the largest. The borders are the edges of the display
    outline that follow a neighbour over land, and the ones along `disputed_lines` are split off.
    The display has a vertex where each border starts and stops. Raises AreaError when no land is
    left.
    """
    frame = _valid(frame)
    held = _held_by_neighbours(frame, neighbours, grow_deg)
    margin = frame.buffer(grow_deg).difference(frame).difference(held)
    # The union keeps lines where a neighbour sliver only touches the frame, so only
    # its polygons are kept for the land search and the outline below.
    reach = shapely.union_all(_polygonal_parts(frame.union(margin)))
    parts = _land_inside(store, reach, min_part_deg2)

    tolerance_deg = _display_tolerance(frame.bounds)
    limit_deg = _conservative_reach_deg(frame.bounds)

    # Recovered land already spends part of the lookup window, so coarsening cannot spend it again.
    west, south, east, north = frame.bounds
    part_west, part_south, part_east, part_north = shapely.total_bounds(parts)
    outward_deg = max(part_east - east, west - part_west, part_north - north, south - part_south)
    display_limit_deg = limit_deg - outward_deg

    display, exclusion = _display_outline(
        parts, neighbours, tolerance_deg, keep_in_reach=bool(grow_deg), limit_deg=display_limit_deg
    )
    display, solid, disputed = _mark_borders(display, exclusion.boundary, parts, disputed_lines)

    return LandClip(_planning_land(parts, frame.bounds, held), display, solid, disputed)


def clip_territorial(
    store: Path | str,
    frame: BaseGeometry,
    disputed_lines: Sequence[BaseGeometry],
    min_part_deg2: float = MIN_PART_DEG2,
) -> LandClip:
    """Cut `frame` to land when it already reaches past the coast, as a maritime extent does.

    No neighbour holds land the frame leaves out, so the frame is neither grown nor cut by others.
    The borders are the edges of the display outline that run along the frame over land, and the
    ones along `disputed_lines` are split off. The display has a vertex where each border starts
    and stops. Raises AreaError when no land is left.
    """
    frame = _valid(frame)
    parts = _land_inside(store, frame, min_part_deg2)
    display = _territorial_display(parts, frame)
    display, solid, disputed = _mark_borders(display, frame.boundary, parts, disputed_lines)

    return LandClip(
        _planning_land(parts, frame.bounds, shapely.GeometryCollection()), display, solid, disputed
    )


def _land_inside(store: Path | str, reach: BaseGeometry, min_part_deg2: float) -> list[Polygon]:
    """The land polygons in `reach`, largest first.

    Land that `reach` fully contains is kept as it is, and only the land that crosses its edge
    is intersected. Raises AreaError when no land is left.
    """
    whole, crossing = _whole_and_crossing(store, reach)
    cut = shapely.intersection(reach, crossing)
    cut_polygons = [part for part in _polygonal_parts(cut) if part.area > 0]
    parts = _large_parts(shapely.union_all([*whole, *cut_polygons]), min_part_deg2)
    if not parts:
        raise AreaError(NO_LAND_MESSAGE)

    return parts


def _whole_and_crossing(store: Path | str, reach: BaseGeometry) -> tuple[np.ndarray, np.ndarray]:
    """The land polygons `reach` fully contains, and the ones that cross its edge."""
    candidates = np.array(land_in(store, reach.bounds), dtype=object)

    shapely.prepare(reach)
    touching = shapely.intersects(reach, candidates)
    whole = touching & shapely.contains(reach, candidates)

    return candidates[whole], candidates[touching & ~whole]


def _held_by_neighbours(
    frame: BaseGeometry, neighbours: Sequence[BaseGeometry], grow_deg: float
) -> BaseGeometry:
    """The part of the frame's margin of `grow_deg` that the neighbours already hold."""
    margin = frame.buffer(grow_deg).difference(frame)
    touching = shapely.intersection(list(neighbours), margin)
    return shapely.union_all(_polygonal_parts(touching))


def _valid(geometry: BaseGeometry) -> BaseGeometry:
    """The geometry as polygons only, repaired when invalid."""
    if geometry.is_valid and geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry

    return MultiPolygon(polygonal_parts(geometry))


def _large_parts(land: BaseGeometry, min_part_deg2: float) -> list[Polygon]:
    """The polygons of `land` from `min_part_deg2` up, largest first, always keeping the largest."""
    polygons = [part for part in shapely.get_parts(land) if isinstance(part, Polygon)]
    parts = sorted(polygons, key=lambda part: part.area, reverse=True)
    return [part for index, part in enumerate(parts) if index == 0 or part.area >= min_part_deg2]


def _polygonal_parts(geometry: BaseGeometry | np.ndarray) -> list[Polygon]:
    """The non-empty polygons of overlay results, without their lines and points.

    Shapes that only touch along an edge or at a point meet as lines and points,
    which the gridded outline overlay fails on, so every combine keeps polygons only.
    """
    parts = shapely.get_parts(shapely.get_parts(geometry))
    return [part for part in parts if isinstance(part, Polygon) and not part.is_empty]


def _mark_borders(
    display: BaseGeometry,
    edge: BaseGeometry,
    land: Sequence[Polygon],
    disputed_lines: Sequence[BaseGeometry],
) -> tuple[BaseGeometry, MultiLineString, MultiLineString]:
    """The display with vertices where its borders change, and its solid and disputed border lines.

    A border is a display edge that runs along `edge` over land, and a disputed border is one
    along `disputed_lines`. A display segment can cross the coast or the start of a disputed
    line, so the display first gets a vertex at each crossing and every border segment lies
    wholly inside or outside. The build finds the borders in the written outline by vertex.
    """
    land_shape = MultiPolygon(land)
    zone = _disputed_zone(disputed_lines)
    for region in (edge, land_shape, zone):
        shapely.prepare(region)

    display = _with_vertices_at_crossings(display, edge, [land_shape, zone])

    def along_edge_over_land(midpoints: np.ndarray) -> np.ndarray:
        # The display sits one rounding step from a neighbour's edge, so land is searched that far.
        return shapely.dwithin(edge, midpoints, EDGE_MATCH_DEG) & shapely.dwithin(
            land_shape, midpoints, 2 * OUTLINE_PRECISION_DEG
        )

    borders = _edge_lines(display.boundary, _by_midpoint(along_edge_over_land))
    if zone.is_empty:
        return display, borders, MultiLineString()

    def along_disputed(midpoints: np.ndarray) -> np.ndarray:
        return shapely.intersects(zone, midpoints)

    solid = _edge_lines(borders, _by_midpoint(lambda midpoints: ~along_disputed(midpoints)))
    disputed = _edge_lines(borders, _by_midpoint(along_disputed))

    return display, solid, disputed


def _disputed_zone(disputed_lines: Sequence[BaseGeometry]) -> BaseGeometry:
    if not disputed_lines:
        return shapely.GeometryCollection()

    return shapely.union_all(shapely.buffer(list(disputed_lines), BORDER_MATCH_DEG))


def _with_vertices_at_crossings(
    display: BaseGeometry, edge: BaseGeometry, regions: Sequence[BaseGeometry]
) -> BaseGeometry:
    """The display with a vertex wherever a segment along `edge` enters or leaves a region."""
    outlines = [shapely.boundary(region) for region in regions]
    shapely.prepare(outlines)
    polygons = []
    for polygon in shapely.get_parts(display):
        rings = [
            _ring_with_crossings(ring, edge, regions, outlines)
            for ring in (polygon.exterior, *polygon.interiors)
        ]
        polygons.append(Polygon(rings[0], rings[1:]))

    return shapely.normalize(MultiPolygon(polygons))


def _ring_with_crossings(
    ring: BaseGeometry,
    edge: BaseGeometry,
    regions: Sequence[BaseGeometry],
    outlines: Sequence[BaseGeometry],
) -> np.ndarray:
    """The ring's coordinates with the crossing vertices of its segments along `edge`."""
    coordinates = shapely.get_coordinates(ring)
    starts, ends = coordinates[:-1], coordinates[1:]
    along_edge = shapely.dwithin(edge, shapely.points((starts + ends) / 2), EDGE_MATCH_DEG)

    found: dict[int, list[np.ndarray]] = {}
    along = np.flatnonzero(along_edge)
    for region, outline in zip(regions, outlines, strict=True):
        # Any segment meeting the outline within float noise may enter or leave the region.
        segments = shapely.linestrings(np.stack([starts[along], ends[along]], axis=1))
        crossing = along[shapely.intersects(outline, shapely.buffer(segments, EDGE_MATCH_DEG))]
        if not len(crossing):
            continue

        segments = shapely.linestrings(np.stack([starts[crossing], ends[crossing]], axis=1))
        points = _ends_of_stretches_inside(segments, region)
        point_indexes, segment_indexes = shapely.STRtree(segments).query(
            shapely.points(points), predicate="dwithin", distance=EDGE_MATCH_DEG
        )
        for point_index, segment_index in zip(point_indexes, segment_indexes, strict=True):
            found.setdefault(crossing[segment_index], []).append(points[point_index])

    pieces = []
    previous = 0
    for index in sorted(found):
        points = _points_between(coordinates[index], coordinates[index + 1], np.array(found[index]))
        pieces += [coordinates[previous : index + 1], points]
        previous = index + 1

    return np.concatenate([*pieces, coordinates[previous:]])


def _ends_of_stretches_inside(segments: np.ndarray, region: BaseGeometry) -> np.ndarray:
    """The coordinates where the parts of the segments inside the region start and stop."""
    # Snapping both to a grid makes edges that differ by float noise intersect as a line.
    parts = shapely.get_parts(
        shapely.intersection(
            shapely.multilinestrings(segments), region, grid_size=EDGE_MATCH_DEG / 4
        )
    )
    stretches = parts[shapely.get_type_id(parts) == shapely.GeometryType.LINESTRING]

    return shapely.get_coordinates(
        [*shapely.get_point(stretches, 0), *shapely.get_point(stretches, -1)]
    )


def _points_between(start: np.ndarray, end: np.ndarray, found: np.ndarray) -> np.ndarray:
    """The distinct points of `found` strictly between `start` and `end`, in order from `start`."""
    distances = np.linalg.norm(found - start, axis=1)
    inside = (distances > EDGE_MATCH_DEG) & (np.linalg.norm(found - end, axis=1) > EDGE_MATCH_DEG)
    order = np.argsort(distances[inside])
    points = found[inside][order]
    moved = np.linalg.norm(np.diff(points, axis=0), axis=1) > EDGE_MATCH_DEG

    return points[np.insert(moved, 0, True)[: len(points)]]


def _by_midpoint(
    accept: Callable[[np.ndarray], np.ndarray],
) -> Callable[[np.ndarray, np.ndarray], np.ndarray]:
    """A segment test that accepts a segment when `accept` takes its midpoint."""
    return lambda starts, ends: accept(shapely.points((starts + ends) / 2))


def _edge_lines(
    edges: BaseGeometry, keep: Callable[[np.ndarray, np.ndarray], np.ndarray]
) -> MultiLineString:
    """The runs of consecutive segments of `edges` that `keep` accepts.

    `keep` takes the start and end coordinates of one line's segments and returns a boolean per
    segment. A run keeps the line's own vertices, and a closed line is cut at its first vertex.
    """
    runs = []
    for line in shapely.get_parts(edges):
        if not isinstance(line, LineString):
            continue

        coordinates = shapely.get_coordinates(line)
        if len(coordinates) < 2:
            continue

        run_start = None
        for index, kept in enumerate(keep(coordinates[:-1], coordinates[1:])):
            if kept and run_start is None:
                run_start = index
            elif not kept and run_start is not None:
                runs.append(coordinates[run_start : index + 1])
                run_start = None

        if run_start is not None:
            runs.append(coordinates[run_start:])

    return MultiLineString(runs)


def border_min_zoom(border_level: int | None) -> int | None:
    """The zoom from which the basemap draws borders of the level itself, or None without one.

    The zooms follow the basemap's boundary layer, which sets them per admin level in
    https://github.com/openmaptiles/planetiler-openmaptiles/blob/main/src/main/java/org/openmaptiles/layers/Boundary.java
    and a border without a known level has no switch zoom.
    """
    if border_level is None:
        return None

    return next(
        (zoom for max_level, zoom in BORDER_ZOOM_BY_MAX_LEVEL if border_level <= max_level),
        BORDER_FINEST_ZOOM,
    )


def _territorial_display(parts: list[Polygon], frame: BaseGeometry) -> BaseGeometry:
    """The parts simplified and grown past the tolerance, then cut at the frame edge.

    The frame holds the sea out to the maritime limit, so the sea margin stops there, and a border
    keeps the detail of the frame. That detail never coarsens, so the loop stops when a coarser
    tolerance removes few vertices.
    """
    west, south, east, north = shapely.total_bounds(parts)
    span_deg = max(east - west, north - south)
    tolerance_deg = _display_tolerance(frame.bounds)
    previous_vertices = None
    while True:
        growth_deg = _display_growth(tolerance_deg, span_deg)
        cut = shapely.intersection(_grown_cover(parts, tolerance_deg, growth_deg), frame)
        outline = shapely.union_all(_polygonal_parts(cut))

        vertices = shapely.get_num_coordinates(outline)
        stalled = previous_vertices is not None and vertices > previous_vertices * STALLED_RATIO
        if vertices <= MAX_DISPLAY_VERTICES or tolerance_deg >= span_deg or stalled:
            return shapely.normalize(outline)

        previous_vertices = vertices
        tolerance_deg *= 2


def _planning_land(
    parts: list[Polygon], bounds: tuple[float, float, float, float], held: BaseGeometry
) -> MultiPolygon:
    """The parts with their detail reduced far below the finest cell, so planning stays fast.

    A country such as Norway has millions of vertices, which makes planning take tens of seconds.
    Simplifying can move an edge onto a neighbour, so the land that `held` covers is taken back.
    """
    west, south, east, north = bounds
    tolerance_deg = max(east - west, north - south) / PLANNING_TOLERANCE_DIVISOR
    simplified = shapely.union_all(shapely.simplify(parts, tolerance_deg, preserve_topology=True))
    polygons = [
        part
        for part in shapely.get_parts(shapely.difference(simplified, held))
        if isinstance(part, Polygon)
    ]

    return shapely.normalize(MultiPolygon(polygons))


def _display_tolerance(bounds: tuple[float, float, float, float]) -> float:
    west, south, east, north = bounds
    return max(
        MIN_DISPLAY_TOLERANCE_DEG, max(east - west, north - south) / DISPLAY_TOLERANCE_DIVISOR
    )


def _display_growth(tolerance_deg: float, span_deg: float) -> float:
    return max(DISPLAY_GROWTH_FACTOR * tolerance_deg, span_deg / DISPLAY_SPAN_DIVISOR)


def _conservative_reach_deg(frame_bounds: tuple[float, float, float, float]) -> float:
    """The neighbour search and the grown outline share this farthest reach past the frame.

    Recovered land can sit a full margin beyond the frame, so the span includes that margin on
    both sides before the display growth is added.
    """
    west, south, east, north = frame_bounds
    span_deg = max(east - west, north - south) + 2 * GROW_DEG
    tolerance_deg = _display_tolerance(frame_bounds)

    return GROW_DEG + _display_growth(tolerance_deg, span_deg) + 2 * OUTLINE_PRECISION_DEG


def _display_outline(
    parts: list[Polygon],
    neighbours: Sequence[BaseGeometry],
    tolerance_deg: float,
    keep_in_reach: bool,
    limit_deg: float,
) -> tuple[BaseGeometry, BaseGeometry]:
    """The parts simplified and grown past the tolerance, minus every neighbour.

    Simplifying moves the coast by up to the tolerance in either direction, and growing by more
    than the tolerance puts all land back inside. The sea margin also reaches a 400th of the
    span, so a centred coast line stays inside at the fit zoom. Parts too small for the
    tolerance are replaced by their hull, so no islet is lost. The whole neighbour near the
    grown parts is taken back afterwards, with one rounding step to spare because the build
    rounds coordinates and could otherwise move an edge onto it. The sea margin is split where
    land borders reach the coast, and the side touching a neighbour is dropped, so the mask
    stops at the border. The loop counts only the grown shape because the sea cut barely
    changes its vertex count, and the cut runs once on the picked tolerance with at most one
    coarser retry, so long coasts skip a full sea cut per round. A coarser tolerance is tried
    until the grown shape has at most MAX_DISPLAY_VERTICES vertices, the tolerance is as wide
    as the area, the growth would pass the neighbours that were looked up (so the cap is soft;
    only checked when `keep_in_reach`, which named areas set even when none were found, because
    one could lie just past the lookup), or a coarser tolerance stops removing vertices while
    neighbours are near, because the rest is a neighbour's detail, which must stay.

    Returns the outline and the neighbour land that it was cut away from.
    """
    west, south, east, north = shapely.total_bounds(parts)
    span_deg = max(east - west, north - south)
    valid_neighbours = [part if part.is_valid else shapely.make_valid(part) for part in neighbours]
    land_union = shapely.union_all(parts)
    neighbour_land = _neighbour_land(valid_neighbours)
    border_lines = _shared_border_lines(land_union, neighbour_land)
    coast_lines = _coast_lines(land_union, neighbour_land)
    previous_vertices = None
    max_growth_deg = limit_deg
    while True:
        growth_deg = _display_growth(tolerance_deg, span_deg)
        covered = _grown_cover(parts, tolerance_deg, growth_deg)

        vertices = shapely.get_num_coordinates(covered)
        # A stall means only neighbour detail is left, so it counts only near a neighbour.
        stalled = (
            _has_nearby_neighbour(valid_neighbours, covered)
            and previous_vertices is not None
            and vertices > previous_vertices * STALLED_RATIO
        )
        too_wide = keep_in_reach and _display_growth(tolerance_deg * 2, span_deg) > max_growth_deg
        if vertices <= MAX_DISPLAY_VERTICES or tolerance_deg >= span_deg or stalled or too_wide:
            break

        previous_vertices = vertices
        tolerance_deg *= 2

    exclusion = _display_exclusion(valid_neighbours, covered)
    outline = _cut_sea_at_borders(
        covered, land_union, border_lines, coast_lines, growth_deg, exclusion
    )
    if (
        shapely.get_num_coordinates(outline) <= MAX_DISPLAY_VERTICES
        or tolerance_deg >= span_deg
        or stalled
        or too_wide
    ):
        return outline, exclusion

    tolerance_deg *= 2
    growth_deg = _display_growth(tolerance_deg, span_deg)
    covered = _grown_cover(parts, tolerance_deg, growth_deg)
    exclusion = _display_exclusion(valid_neighbours, covered)
    outline = _cut_sea_at_borders(
        covered, land_union, border_lines, coast_lines, growth_deg, exclusion
    )
    return outline, exclusion


def _grown_cover(parts: list[Polygon], tolerance_deg: float, growth_deg: float) -> BaseGeometry:
    """The parts simplified to `tolerance_deg`, grown seaward and merged into one shape."""
    shapes = [part if part.area >= tolerance_deg**2 else part.convex_hull for part in parts]
    simplified = shapely.simplify(shapes, tolerance_deg)
    collapsed = shapely.is_empty(simplified)
    simplified[collapsed] = shapely.envelope(np.array(shapes, dtype=object)[collapsed])
    grown = shapely.buffer(
        shapely.make_valid(simplified), growth_deg, quad_segs=DISPLAY_CORNER_SEGMENTS
    )

    return shapely.union_all(grown)


def _has_nearby_neighbour(neighbours: Sequence[BaseGeometry], covered: BaseGeometry) -> bool:
    """Whether any neighbour lies within the rounding guard of the grown cover."""
    if not neighbours or covered.is_empty:
        return False

    # The full exclusion is rebuilt once later, so the loop only checks the distance.
    return any(
        shapely.dwithin(covered, neighbour, 2 * OUTLINE_PRECISION_DEG) for neighbour in neighbours
    )


def _display_exclusion(neighbours: Sequence[BaseGeometry], covered: BaseGeometry) -> BaseGeometry:
    """The neighbour land inside the grown parts, grown by one rounding step.

    The whole neighbour inside the parts is removed, not only the growth margin, because the
    display tolerance can be larger than the margin. Only the neighbours near the grown parts
    are read, so far-away detail never enters the outline.
    """
    if not neighbours:
        return shapely.GeometryCollection()

    valid_reach = shapely.union_all(_polygonal_parts(shapely.make_valid(covered)))
    if valid_reach.is_empty:
        return valid_reach

    # Rounding can move the outline onto a neighbour just past its unrounded edge.
    valid_reach = valid_reach.buffer(2 * OUTLINE_PRECISION_DEG, join_style="mitre")

    clipped = shapely.intersection(list(neighbours), valid_reach.envelope)
    polygons = _polygonal_parts(clipped)
    nearby = shapely.union_all(polygons) if polygons else shapely.GeometryCollection()
    if nearby.is_empty:
        return nearby

    # Buffer before any grid snapping, which can erase a neighbour narrower than the grid.
    relevant = shapely.intersection(shapely.make_valid(nearby), valid_reach)

    return relevant.buffer(OUTLINE_PRECISION_DEG, join_style="mitre")


def _cut_sea_at_borders(
    covered: BaseGeometry,
    land_union: BaseGeometry,
    border_lines: BaseGeometry,
    coast_lines: BaseGeometry,
    growth_deg: float,
    exclusion: BaseGeometry,
) -> BaseGeometry:
    """The grown parts without a neighbour and without the sea past a land border.

    The sea margin is split with straight extensions of the borders. A piece stays when it runs
    along the area's coast for longer than along the neighbours, so the mask stops where the
    border reaches the coast, and a neighbour's edge that enters the margin cannot cost the
    whole margin.
    """
    base = shapely.difference(covered, exclusion)
    # Without a coast no sea margin remains to trim, as for a landlocked area.
    if border_lines.is_empty or exclusion.is_empty or coast_lines.is_empty:
        return shapely.normalize(base)

    try:
        sea = shapely.difference(covered, land_union)
        if sea.is_empty:
            return shapely.normalize(base)

        # Merging turns each border into whole lines, so only the real ends grow rays.
        rays = _seaward_border_rays(shapely.line_merge(border_lines), growth_deg, covered)
        if not rays or len(rays) > MAX_BORDER_RAYS:
            return shapely.normalize(base)

        divided = split(sea, shapely.union_all(rays))
        exclusion_edge = exclusion.boundary
        kept = [
            part
            for part in _polygonal_parts(divided)
            if _runs_along_coast(part, coast_lines, exclusion_edge)
        ]
    except ShapelyError:
        # Splitting is only a visual trim, so an unexpected split keeps the grown shape.
        return shapely.normalize(base)

    if not kept:
        return shapely.normalize(shapely.difference(land_union, exclusion))

    kept_sea = shapely.union_all(kept)
    return shapely.normalize(
        shapely.difference(shapely.union_all([land_union, kept_sea]), exclusion)
    )


def _runs_along_coast(
    sea_piece: Polygon, coast_lines: BaseGeometry, exclusion_edge: BaseGeometry
) -> bool:
    """Whether the piece runs along the coast for longer than along the neighbours.

    A piece that only touches the coast at a border end is rounding, so it needs a real contact.
    """
    coast_deg = shapely.intersection(sea_piece, coast_lines).length
    neighbour_deg = shapely.intersection(sea_piece, exclusion_edge).length

    return coast_deg > OUTLINE_PRECISION_DEG and coast_deg > neighbour_deg


def _neighbour_land(neighbours: Sequence[BaseGeometry]) -> BaseGeometry:
    """The neighbours united, or nothing when there are none or they will not unite."""
    if not neighbours:
        return shapely.GeometryCollection()

    try:
        united = shapely.union_all(neighbours)
    except ShapelyError:
        # Neighbours that cannot be united leave the sea margin as it is.
        return shapely.GeometryCollection()

    shapely.prepare(united)
    return united


def _shared_border_lines(land_union: BaseGeometry, neighbour_land: BaseGeometry) -> BaseGeometry:
    """The land boundary along the neighbours, which the sea margin must stop at.

    Boundaries that weave around each other cut their exact intersection into thousands of
    slivers, so the border is every boundary segment within the match distance of a neighbour.
    A segment counts only when both of its ends and its middle are near, so a short coast
    segment at a border end stays coast and the rays start at the coast.
    """
    return _edge_lines(
        land_union.boundary, lambda starts, ends: _near_neighbours(neighbour_land, starts, ends)
    )


def _coast_lines(land_union: BaseGeometry, neighbour_land: BaseGeometry) -> BaseGeometry:
    """The land boundary away from the neighbours, where the sea margin may stay."""
    return _edge_lines(
        land_union.boundary, lambda starts, ends: ~_near_neighbours(neighbour_land, starts, ends)
    )


def _near_neighbours(
    neighbour_land: BaseGeometry, starts: np.ndarray, ends: np.ndarray
) -> np.ndarray:
    """Whether each segment has both ends and its middle near a neighbour."""
    points = (starts, (starts + ends) / 2, ends)
    near = [
        shapely.dwithin(neighbour_land, shapely.points(point), SHARED_BORDER_DEG)
        for point in points
    ]

    return np.logical_and.reduce(near)


def _seaward_border_rays(
    border_lines: BaseGeometry, growth_deg: float, covered: BaseGeometry
) -> list[LineString]:
    """Extend the ends of shared land edges straight past the sea margin.

    Both ends are extended because an inland end stays over land and never splits the sea,
    while a coastal end reaches the water and divides it.
    """
    minimum_ray_deg = DISPLAY_BORDER_RAY_FACTOR * growth_deg
    west, south, east, north = covered.bounds
    rays: list[LineString] = []
    for line in shapely.get_parts(border_lines):
        coords = list(line.coords)
        # A closed border has no ends, and its rays would cross every other ray.
        if len(coords) < 2 or line.is_ring:
            continue

        for end_first in (coords, coords[::-1]):
            first = end_first[0]
            second = _direction_anchor(end_first)
            delta_x = first[0] - second[0]
            delta_y = first[1] - second[1]
            length_deg = math.hypot(delta_x, delta_y)
            if length_deg == 0:
                continue

            unit_x = delta_x / length_deg
            unit_y = delta_y / length_deg
            if unit_x > 0:
                exit_x_deg = (east - first[0]) / unit_x
            elif unit_x < 0:
                exit_x_deg = (west - first[0]) / unit_x
            else:
                exit_x_deg = math.inf
            if unit_y > 0:
                exit_y_deg = (north - first[1]) / unit_y
            elif unit_y < 0:
                exit_y_deg = (south - first[1]) / unit_y
            else:
                exit_y_deg = math.inf
            exit_deg = min(exit_x_deg, exit_y_deg)
            # A shallow angle stays inside the margin for a long run, so the ray leaves its bounds.
            if not math.isfinite(exit_deg) or exit_deg < 0:
                ray_length_deg = minimum_ray_deg
            else:
                ray_length_deg = max(minimum_ray_deg, exit_deg + 2 * OUTLINE_PRECISION_DEG)

            # Continuing straight past the end keeps the mask edge aligned with the border.
            far = (first[0] + unit_x * ray_length_deg, first[1] + unit_y * ray_length_deg)
            rays.append(LineString([first, far]))

    return rays


def _direction_anchor(coords: list[tuple[float, ...]]) -> tuple[float, ...]:
    """The first vertex far enough from the start of `coords` to give a border's direction.

    A border end can pick up a tiny coast segment, which points along the coast, so the
    direction ignores vertices closer than the tail a coast segment can add.
    """
    start = coords[0]
    for point in coords[1:]:
        if math.dist(start, point) >= RAY_DIRECTION_MIN_DEG:
            return point

    return coords[-1]


def clip_area_to_land(db_path: Path | str, store: Path | str, area: Area) -> Area:
    """The area cut to land, using the stored clip when the land version has one.

    A stored clip is used only while the boundaries and disputed lines it was cut with, and the
    clips of a combined area's members, are unchanged. Raises SourceUnavailable without a land store
    and AreaError when the area has no land, both before any data is read. An area wider than
    planning accepts is returned as it is, for planning to refuse.
    """
    version = land_version(store)
    frame = unwrap(area.geom)
    if _too_wide(frame):
        return area

    clip, revision = _cached_clip(db_path, store, version, area, frame)
    # A plain cut has no borders, so its scene keeps the ordinary outline instead of border runs.
    has_borders = not _plain_cut(area)

    return replace(
        area,
        geom=clip.geom,
        display=clip.display,
        borders=clip.borders if has_borders else None,
        disputed=clip.disputed if has_borders else None,
        land_version=version,
        neighbour_revision=revision,
    )


def _cached_clip(
    db_path: Path | str, store: Path | str, version: str, area: Area, frame: BaseGeometry
) -> tuple[LandClip, str]:
    """The clip of the area and its revision, stored when it was not yet."""
    neighbours = _neighbours(db_path, area, frame)
    revision = _clip_revision(db_path, area, frame, neighbours)
    digest = _clip_digest(area, frame, revision)
    stored = db.get_land_clip(db_path, digest, version, CLIP_METHOD_VERSION)
    if stored is not None:
        return LandClip(*shapely.from_wkb(stored)), revision

    clip = _clip_area(db_path, store, area, frame, neighbours)
    db.set_land_clip(db_path, digest, version, CLIP_METHOD_VERSION, _wkbs(clip))

    return clip, revision


def _stored_clip(db_path: Path | str, version: str, area: Area) -> LandClip | None:
    """The clip that is stored for the area, or None without one. Nothing is computed."""
    frame = unwrap(area.geom)
    revision = _clip_revision(db_path, area, frame, _neighbours(db_path, area, frame))
    digest = _clip_digest(area, frame, revision)
    stored = db.get_land_clip(db_path, digest, version, CLIP_METHOD_VERSION)

    return None if stored is None else LandClip(*shapely.from_wkb(stored))


def _too_wide(frame: BaseGeometry) -> bool:
    west, _, east, _ = frame.bounds
    return east - west > MAX_LONGITUDE_DEG


def _clip_digest(area: Area, frame: BaseGeometry, neighbour_revision: str) -> str:
    """Key of an area's clip, starting with the method version.

    A new method version never reuses an old clip.
    """
    shape_digest = hashlib.sha256(shapely.to_wkb(frame)).hexdigest()
    version_prefix = f"clip{CLIP_METHOD_VERSION}"
    if not area.named:
        return f"{version_prefix}:poly:{shape_digest}"

    return f"{version_prefix}:{area.boundary['id']}:{shape_digest}:{neighbour_revision}"


def _neighbours(db_path: Path | str, area: Area, frame: BaseGeometry) -> list[Neighbour]:
    """The same-level boundaries around the frame of an area that follows the coast.

    The grown frame is looked up on either side of 180 to find the ones stored on the other side.
    """
    if not _follows_coast(area):
        return []

    # The display outline grows past the frame by its sea margin and must not cover these.
    reach_deg = _conservative_reach_deg(frame.bounds)
    neighbours = []
    for window, shift_deg in _stored_windows(frame.bounds, reach_deg):
        found = db.neighbour_digests(db_path, area.boundary, window)
        neighbours += [Neighbour(boundary_id, digest, shift_deg) for boundary_id, digest in found]

    return neighbours


def _stored_windows(
    bounds: tuple[float, float, float, float], reach_deg: float
) -> Iterator[tuple[tuple[float, float, float, float], float]]:
    """The bounds grown by `reach_deg` as lookup windows for stored shapes, with their shifts.

    Shapes that cross 180 are stored from -180 up to 360, so the window is looked up again a
    world width to either side. A shape found with a shift moves by it to join the frame.
    """
    west, south, east, north = bounds
    stored_west, stored_east = STORED_LONGITUDE_RANGE_DEG
    for shift_deg in (0, WORLD_WIDTH_DEG, -WORLD_WIDTH_DEG):
        window = (
            west - reach_deg - shift_deg,
            south - reach_deg,
            east + reach_deg - shift_deg,
            north + reach_deg,
        )
        if window[2] >= stored_west and window[0] <= stored_east:
            yield window, shift_deg


def _clip_revision(
    db_path: Path | str, area: Area, frame: BaseGeometry, neighbours: list[Neighbour]
) -> str:
    """A short digest of everything besides the frame that shapes the clip; empty when nothing does.

    A combined area depends on the clips of its members, a territorial area on its border level
    and the disputed lines, and a coast-following area also on its neighbours and their geometry.
    """
    if _is_combined(area):
        # Member order is storage order, so the keys are sorted and only the member set matters.
        lines = sorted(_member_digests(db_path, area))
    elif _plain_cut(area):
        return ""
    else:
        disputed_digest = _lines_digest(_disputed_lines(db_path, frame))
        lines = [f"level:{area.boundary.get('border_level')}", f"disputed:{disputed_digest}"]
        if _is_territorial(area):
            lines.append("territorial")
        lines += sorted(f"{item.id}:{item.digest}:{item.shift_deg}" for item in neighbours)

    return hashlib.sha256("\n".join(lines).encode()).hexdigest()[:REVISION_CHARS]


def _member_digests(db_path: Path | str, area: Area) -> list[str]:
    """The clip keys of the areas that a combined area is made of, in part order."""
    digests = []
    for member_id in db.boundary_part_ids(db_path, _parent_id(area)):
        member = _named_area(db_path, member_id)
        frame = unwrap(member.geom)
        revision = _clip_revision(db_path, member, frame, _neighbours(db_path, member, frame))
        digests.append(_clip_digest(member, frame, revision))

    return digests


def _parent_id(combined: Area) -> str:
    return combined.boundary["id"].removesuffix(COMBINED_ID_SUFFIX)


def _lines_digest(lines: list[BaseGeometry]) -> str:
    return hashlib.sha256(b"".join(sorted(shapely.to_wkb(line) for line in lines))).hexdigest()


def _follows_coast(area: Area) -> bool:
    """Whether the clip grows past the boundary and leaves the land of same-level neighbours."""
    return not (_plain_cut(area) or _is_territorial(area) or _is_combined(area))


def _is_territorial(area: Area) -> bool:
    """Whether the stored shape reaches out to sea, so it already holds all of its land.

    Counties and below follow the coast because their maritime extent was not checked to hold
    all of their land.
    """
    return (
        area.named
        and bool(area.boundary.get("has_maritime"))
        and area.boundary.get("level") in TERRITORIAL_LEVELS
    )


def _is_combined(area: Area) -> bool:
    return area.named and area.boundary["id"].endswith(COMBINED_ID_SUFFIX)


def _plain_cut(area: Area) -> bool:
    """Whether the area is cut to land without neighbours and without growth.

    Cities can overlap, so no same-level neighbour may cut their outline. Drawn shapes have
    no neighbours at all.
    """
    if not area.named:
        return True

    return area.boundary.get("level") == "city"


def _clip_area(
    db_path: Path | str,
    store: Path | str,
    area: Area,
    frame: BaseGeometry,
    neighbours: list[Neighbour],
) -> LandClip:
    if _is_combined(area):
        return _combined_clip(db_path, store, area)

    if _plain_cut(area):
        return clip_to_land(store, frame, [], grow_deg=0)

    disputed_lines = _disputed_lines(db_path, frame)
    if _is_territorial(area):
        return clip_territorial(store, frame, disputed_lines)

    return clip_to_land(
        store, frame, _neighbour_shapes(db_path, neighbours), disputed_lines=disputed_lines
    )


def _combined_clip(db_path: Path | str, store: Path | str, area: Area) -> LandClip:
    """The member clips united, with the borders of the members except where they meet."""
    version = land_version(store)
    clips = []
    frames = []
    for member_id in db.boundary_part_ids(db_path, _parent_id(area)):
        member = _named_area(db_path, member_id)
        frame = unwrap(member.geom)
        frames.append(frame)
        clips.append(_cached_clip(db_path, store, version, member, frame)[0])

    frames = _in_one_longitude_frame(frames)
    seams = _seams(frames, _united_frames(frames))
    shapely.prepare(seams)

    def away_from_seams(midpoints: np.ndarray) -> np.ndarray:
        # A member's edge sits one rounding step inside its frame, so the seam is searched that far.
        return ~shapely.dwithin(seams, midpoints, 2 * FRAME_SNAP_DEG)

    solid = _edge_lines(
        shapely.union_all([clip.borders for clip in clips]), _by_midpoint(away_from_seams)
    )
    disputed = _edge_lines(
        shapely.union_all([clip.disputed for clip in clips]), _by_midpoint(away_from_seams)
    )

    return LandClip(
        _united_land([clip.geom for clip in clips], seams),
        shapely.union_all([clip.display for clip in clips]),
        solid,
        disputed,
    )


def _in_one_longitude_frame(frames: list[BaseGeometry]) -> list[BaseGeometry]:
    """The frames, each moved to the longitudes of the ones before it."""
    shifted = [frames[0]]
    for frame in frames[1:]:
        west, _, east, _ = shapely.total_bounds(shifted)
        shifted.append(_shifted_into(frame, west, east))

    return shifted


def _united_frames(frames: list[BaseGeometry]) -> BaseGeometry:
    """The frames united, with slivers where they meet merged."""
    # Slivers where the frames meet would survive as internal edges, so they merge first.
    return shapely.buffer(
        shapely.buffer(shapely.union_all(frames), FRAME_SNAP_DEG, join_style="mitre"),
        -FRAME_SNAP_DEG,
        join_style="mitre",
    )


def _seams(frames: list[BaseGeometry], united: BaseGeometry) -> BaseGeometry:
    """The edges of the frames that run inside their union, a little widened."""
    edges = shapely.union_all([frame.boundary for frame in frames])
    inside = edges.intersection(united.buffer(-2 * FRAME_SNAP_DEG))
    return inside.buffer(FRAME_SNAP_DEG)


def _united_land(lands: list[BaseGeometry], seams: BaseGeometry) -> BaseGeometry:
    """The member land united, uniting only the parts that reach a seam between the frames.

    Archipelagos have thousands of parts, which take minutes to unite although the parts away
    from the seams are disjoint.
    """
    polygons = np.array([part for land in lands for part in shapely.get_parts(land)], dtype=object)
    at_seams = shapely.STRtree(polygons).query(seams, predicate="intersects")
    away = np.delete(polygons, at_seams)

    united = _polygonal_parts(shapely.union_all(polygons[at_seams]))
    return shapely.normalize(shapely.multipolygons([*away, *united]))


def _disputed_lines(db_path: Path | str, frame: BaseGeometry) -> list[BaseGeometry]:
    """The disputed lines near the frame, moved into its longitude frame."""
    lines: list[BaseGeometry] = []
    for window, shift_deg in _stored_windows(frame.bounds, BORDER_MATCH_DEG):
        wkbs = db.disputed_line_wkbs(db_path, window)
        lines += [translate(line, xoff=shift_deg) for line in shapely.from_wkb(wkbs)]

    return lines


def _named_area(db_path: Path | str, boundary_id: str) -> Area:
    boundary = db.get_boundary(db_path, boundary_id)
    return Area(shape(json.loads(boundary["geom_geojson"])), boundary)


def _neighbour_shapes(db_path: Path | str, neighbours: list[Neighbour]) -> list[BaseGeometry]:
    """The neighbours' shapes, each moved into the longitude frame of the area."""
    shapes = []
    for item in neighbours:
        geometry = shape(json.loads(db.get_boundary(db_path, item.id)["geom_geojson"]))
        shapes.append(translate(unwrap(geometry), xoff=item.shift_deg))

    return shapes


def _wkbs(clip: LandClip) -> db.LandClipWkbs:
    return (
        shapely.to_wkb(clip.geom),
        shapely.to_wkb(clip.display),
        shapely.to_wkb(clip.borders),
        shapely.to_wkb(clip.disputed),
    )


def store_clips(db_path: Path | str, store: Path | str) -> int:
    """Clip every country, then every state, that has no clip for the land version yet.

    Returns the number of clips stored. Countries are clipped one at a time because the largest
    hold millions of vertices, while states are clipped in parallel.
    """
    stored = 0
    for level, workers in CLIP_WORKERS_BY_LEVEL.items():
        boundary_ids = db.boundary_ids(db_path, OVERTURE_SOURCE, (level,))
        # Each area runs in a fresh worker, so its peak memory is released afterwards.
        with ProcessPoolExecutor(
            workers,
            mp_context=get_context("spawn"),
            max_tasks_per_child=1,
            initializer=_limit_clip_worker_memory,
        ) as pool:
            results = pool.map(
                _store_clip, repeat(db_path), repeat(store), boundary_ids, chunksize=1
            )
            for position, was_stored in enumerate(results, start=1):
                stored += was_stored
                if position % 100 == 0:
                    print(
                        f"land clips ({level}): {position}/{len(boundary_ids)} checked", flush=True
                    )

    return stored


def _limit_clip_worker_memory() -> None:
    """Cap one clip worker, so a runaway GEOS call raises instead of ending the pool."""
    if resource is None:
        return

    resource.setrlimit(resource.RLIMIT_AS, (CLIP_WORKER_LIMIT_BYTES, CLIP_WORKER_LIMIT_BYTES))


def unassigned_land_report(
    db_path: Path | str, store: Path | str, count: int = UNASSIGNED_REPORT_COUNT
) -> list[tuple[str, float]]:
    """The countries with the most land (id, km2) that no clip of their states holds.

    A plain cut of a country is right only when its states tile it, so a large figure points at
    land the state clips lose. Only stored clips are read, one country at a time, so the report
    never clips an area itself. A country or state without a stored clip counts as holding no land,
    and a country with more than UNASSIGNED_REPORT_MAX_VERTICES clip vertices is skipped with a
    printed line.
    """
    version = land_version(store)
    unassigned = []
    for country_id in db.boundary_ids(db_path, OVERTURE_SOURCE, ("country",)):
        country = _named_area(db_path, country_id)
        if _is_combined(country) or not country.boundary["iso3"]:
            continue

        state_ids = db.state_ids_of_country(db_path, OVERTURE_SOURCE, country.boundary["iso3"])
        if not state_ids:
            continue

        leftover = _land_without_states(db_path, version, country, state_ids)
        if leftover is None:
            print(f"land report: {country_id} skipped, its clips are too detailed", flush=True)
            continue

        unassigned.append((country_id, sum(_area_km2(part) for part in leftover)))

    return sorted(unassigned, key=lambda item: item[1], reverse=True)[:count]


def _land_without_states(
    db_path: Path | str, version: str, country: Area, state_ids: list[str]
) -> list[Polygon] | None:
    """The parts of the country's clip outside every state clip, from the planning tolerance up.

    Returns None when the clips hold more than UNASSIGNED_REPORT_MAX_VERTICES vertices.
    """
    country_clip = _stored_clip(db_path, version, country)
    if country_clip is None:
        return []

    country_land = country_clip.geom
    west, south, east, north = country_land.bounds
    states = []
    for state_id in state_ids:
        state_clip = _stored_clip(db_path, version, _named_area(db_path, state_id))
        if state_clip is not None:
            states.append(_shifted_into(state_clip.geom, west, east))

    vertices = sum(shapely.get_num_coordinates(geometry) for geometry in [country_land, *states])
    if vertices > UNASSIGNED_REPORT_MAX_VERTICES:
        return None

    tolerance_deg = max(east - west, north - south) / PLANNING_TOLERANCE_DIVISOR
    # Buffering each state before the union keeps abutting clips from stalling it on slivers.
    covered = shapely.union_all(
        [shapely.simplify(state, tolerance_deg).buffer(2 * tolerance_deg) for state in states]
    )
    leftover = _polygonal_parts(shapely.difference(country_land, covered))

    return [part for part in leftover if part.area >= MIN_PART_DEG2]


def _shifted_into(geometry: BaseGeometry, west: float, east: float) -> BaseGeometry:
    """The geometry moved a world width when that puts its centre between `west` and `east`.

    Each area is unwrapped on its own, so a state can sit on the other side of 180 from its country.
    """
    min_x, _, max_x, _ = geometry.bounds
    centre = (min_x + max_x) / 2
    for shift_deg in (0, WORLD_WIDTH_DEG, -WORLD_WIDTH_DEG):
        if west <= centre + shift_deg <= east:
            return translate(geometry, xoff=shift_deg)

    return geometry


def _area_km2(geometry: BaseGeometry) -> float:
    """The area in square kilometres, scaling the degrees by the latitude of the shape."""
    return geometry.area * KM_PER_DEGREE**2 * math.cos(math.radians(geometry.centroid.y))


def _store_clip(db_path: Path | str, store: Path | str, boundary_id: str) -> bool:
    """Store the clip of one boundary unless it has one; whether a clip was stored."""
    area = _named_area(db_path, boundary_id)
    frame = unwrap(area.geom)
    revision = _clip_revision(db_path, area, frame, _neighbours(db_path, area, frame))
    digest = _clip_digest(area, frame, revision)
    if db.get_land_clip(db_path, digest, land_version(store), CLIP_METHOD_VERSION) is not None:
        return False

    try:
        start_secs = time.monotonic()
        clip_area_to_land(db_path, store, area)

        elapsed_secs = time.monotonic() - start_secs
        if elapsed_secs > SLOW_CLIP_SECS:
            print(f"land clips: {boundary_id} took {elapsed_secs:.0f} s to clip", flush=True)
    except (AreaError, ShapelyError) as error:
        print(f"land clips: {boundary_id} skipped ({error})", flush=True)
        return False

    return True


def import_land(store: Path | str, db_path: Path | str) -> int:
    """Download the land polygons when they changed, then store each country's and state's clip.

    Prints the countries whose land the state clips leave out. Returns the number of clips stored.
    """
    version = _remote_version(LAND_ZIP_URL)
    if not _has_version(store, version):
        _download_land(LAND_ZIP_URL, store, version)

    db.ensure_schema(db_path)
    db.delete_land_clips_except(db_path, version, CLIP_METHOD_VERSION)
    stored = store_clips(db_path, store)

    print("Land of a country that no state clip holds (km2):", flush=True)
    for country_id, km2 in unassigned_land_report(db_path, store):
        print(f"  {country_id}: {km2:,.1f}", flush=True)

    return stored


def write_land_store(store: Path | str, version: str, polygons: Sequence[BaseGeometry]) -> None:
    """Write a store of the given land polygons, replacing any store at the path."""
    with _new_store(store, version) as connection:
        _add_polygons(connection, shapely.to_wkb(list(polygons)))


def _remote_version(url: str) -> str:
    """The date the file at `url` was last changed, as YYYY-MM-DD."""
    request = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECS) as response:
            modified = response.headers["Last-Modified"]
    except OSError as error:
        raise SourceUnavailable("the land polygons server could not be reached") from error

    return parsedate_to_datetime(modified).date().isoformat()


def _has_version(store: Path | str, version: str) -> bool:
    try:
        return land_version(store) == version
    except SourceUnavailable:
        return False


def _download_land(url: str, store: Path | str, version: str) -> None:
    """Download the land polygons and store them, leaving no download or unzipped copy behind."""
    store = Path(store)
    store.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=store.parent, prefix=".land-import-") as work:
        zip_path = Path(work) / "land.zip"
        with (
            zip_path.open("wb") as file,
            urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECS) as response,
        ):
            shutil.copyfileobj(response, file, DOWNLOAD_CHUNK_BYTES)

        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(work)

        zip_path.unlink()
        shapefile = next(Path(work).rglob("land_polygons.shp"))
        _store_shapefile(shapefile, store, version)


def _store_shapefile(shapefile: Path, store: Path, version: str) -> None:
    # Read lazily so the server, which never imports, does not need the import extra.
    import pyogrio

    total = pyogrio.read_info(shapefile)["features"]
    with _new_store(store, version) as connection:
        for first in range(0, total, IMPORT_BATCH_ROWS):
            _, _, wkbs, _ = pyogrio.raw.read(
                shapefile, columns=[], skip_features=first, max_features=IMPORT_BATCH_ROWS
            )
            _add_polygons(connection, wkbs)

    log.info("land polygons stored: %d", total)


@contextmanager
def _new_store(store: Path | str, version: str) -> Iterator[sqlite3.Connection]:
    """A connection to a new store that replaces the old one only when the block finishes."""
    store = Path(store)
    store.parent.mkdir(parents=True, exist_ok=True)
    new_path = store.with_name(store.name + ".new")
    new_path.unlink(missing_ok=True)

    try:
        with closing(sqlite3.connect(new_path)) as connection:
            # The store is rebuilt from the download, so a crash costs nothing and needs no journal.
            connection.execute("PRAGMA journal_mode=OFF")
            connection.execute("PRAGMA synchronous=OFF")
            connection.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            connection.execute("CREATE TABLE land (id INTEGER PRIMARY KEY, wkb BLOB NOT NULL)")
            connection.execute(
                "CREATE VIRTUAL TABLE land_index USING rtree(id, min_x, max_x, min_y, max_y)"
            )
            yield connection

            connection.execute("INSERT INTO meta (key, value) VALUES ('version', ?)", (version,))
            connection.commit()

        os.replace(new_path, store)
    finally:
        new_path.unlink(missing_ok=True)


def _add_polygons(connection: sqlite3.Connection, wkbs: Sequence[bytes]) -> None:
    first_id = connection.execute("SELECT COUNT(*) FROM land").fetchone()[0]
    bounds = shapely.bounds(shapely.from_wkb(wkbs))
    rows = [
        (first_id + offset, bytes(wkb), west, east, south, north)
        for offset, (wkb, (west, south, east, north)) in enumerate(zip(wkbs, bounds, strict=True))
    ]

    connection.executemany("INSERT INTO land (id, wkb) VALUES (?, ?)", [row[:2] for row in rows])
    connection.executemany(
        "INSERT INTO land_index (id, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)",
        [(row[0], row[2], row[3], row[4], row[5]) for row in rows],
    )


@contextmanager
def _open_store(store: Path | str) -> Iterator[sqlite3.Connection]:
    uri = Path(store).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        yield connection
