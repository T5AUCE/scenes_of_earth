"""OpenStreetMap land polygons, the coast that every scene area is cut to.

`import-land` loads the split land polygons into a local SQLite file with an R-tree, then stores
the clip of every country and state, so a request for a large area never waits for one. A clip is
the area's shape, reaching a little past its boundary, minus the land its same-level neighbours
hold, cut to land. Clips are cached in the main database for each land version, and the land
version is part of the scene id.
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
from collections.abc import Iterator, Sequence
from concurrent.futures import ProcessPoolExecutor
from contextlib import closing, contextmanager
from dataclasses import dataclass, replace
from email.utils import parsedate_to_datetime
from itertools import repeat
from multiprocessing import get_context
from pathlib import Path

import numpy as np
import shapely
from shapely.affinity import translate
from shapely.errors import ShapelyError
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import split

from . import db
from .areas import MAX_LONGITUDE_DEG, WORLD_WIDTH_DEG, Area, AreaError, polygonal_parts, unwrap
from .boundary_import import CGAZ_SOURCE
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
CLIP_WORKERS_BY_LEVEL = {"country": 1, "state": 4}  # levels whose clips the import stores
# Version 2 removes the whole neighbour inside the display, not only the margin part.
# Version 3 buffers the neighbour before any grid snapping, so a neighbour narrower
# than the grid still leaves a gap.
# Version 4 grows the display outline past its tolerance, so it holds all the land.
# Version 5 widens the sea margin to a 400th of the span and stops it at land borders.
# Version 6 counts the grown shape and cuts the sea once, so later outlines may differ.
CLIP_METHOD_VERSION = 6
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
NEIGHBOUR_TOUCH_DEG = (
    10 * OUTLINE_PRECISION_DEG
)  # shorter contacts are rounding, not neighbour land

LINE_STRING_TYPE_ID = 1  # shapely.get_type_id of a LineString
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
    borders: BaseGeometry  # MultiLineString of the edges that run over land


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
) -> LandClip:
    """Cut `frame` to land, after growing it by `grow_deg` and taking back what `neighbours` hold.

    `frame` and `neighbours` share one longitude frame. Land that the frame fully contains is
    kept as it is, and only the land that crosses its edge is intersected. Parts under
    `min_part_deg2` are dropped, except the largest. Raises AreaError when no land is left.
    """
    frame = _valid(frame)
    held = _held_by_neighbours(frame, neighbours, grow_deg)
    margin = frame.buffer(grow_deg).difference(frame).difference(held)
    # The union keeps lines where a neighbour sliver only touches the frame, so only
    # its polygons are kept for the land search, the borders and the outline below.
    reach = shapely.union_all(_polygonal_parts(frame.union(margin)))
    candidates = np.array(land_in(store, reach.bounds), dtype=object)

    shapely.prepare(reach)
    touching = shapely.intersects(reach, candidates)
    whole = touching & shapely.contains(reach, candidates)
    crossing = candidates[touching & ~whole]

    cut = shapely.intersection(reach, crossing)
    cut_polygons = [part for part in _polygonal_parts(cut) if part.area > 0]
    pieces = [*candidates[whole], *cut_polygons]
    parts = _large_parts(shapely.union_all(pieces), min_part_deg2)
    if not parts:
        raise AreaError(NO_LAND_MESSAGE)

    tolerance_deg = _display_tolerance(frame.bounds)
    borders = _borders(reach, crossing, held if grow_deg else None)
    limit_deg = _conservative_reach_deg(frame.bounds)

    # Recovered land already spends part of the lookup window, so coarsening cannot spend it again.
    west, south, east, north = frame.bounds
    part_west, part_south, part_east, part_north = shapely.total_bounds(parts)
    outward_deg = max(part_east - east, west - part_west, part_north - north, south - part_south)
    display_limit_deg = limit_deg - outward_deg

    return LandClip(
        _planning_land(parts, frame.bounds, held),
        _display_outline(
            parts,
            neighbours,
            tolerance_deg,
            keep_in_reach=bool(grow_deg),
            limit_deg=display_limit_deg,
        ),
        shapely.simplify(borders, tolerance_deg),
    )


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


def _borders(
    reach: BaseGeometry, crossing: np.ndarray, held: BaseGeometry | None
) -> MultiLineString:
    """The edges of `reach` that run over land and meet the land a neighbour holds.

    Other cut edges are small islands that the boundary leaves out a little of, which are not
    borders. Without `held`, as for a drawn shape, every edge over land is a border.
    """
    inside = shapely.get_parts(shapely.get_parts(shapely.intersection(reach.boundary, crossing)))
    lines = inside[shapely.get_type_id(inside) == LINE_STRING_TYPE_ID]
    if not len(lines):
        return MultiLineString()

    merged = shapely.get_parts(shapely.line_merge(shapely.union_all(lines)))
    if held is not None:
        merged = merged[shapely.dwithin(merged, held, BORDER_MATCH_DEG)]

    return MultiLineString(merged.tolist())


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
) -> BaseGeometry:
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
    """
    west, south, east, north = shapely.total_bounds(parts)
    span_deg = max(east - west, north - south)
    valid_neighbours = [part if part.is_valid else shapely.make_valid(part) for part in neighbours]
    land_union = shapely.union_all(parts)
    border_lines = _shared_border_lines(land_union, valid_neighbours)
    coast_lines = _coast_lines(land_union, border_lines)
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
        return outline

    tolerance_deg *= 2
    growth_deg = _display_growth(tolerance_deg, span_deg)
    covered = _grown_cover(parts, tolerance_deg, growth_deg)
    exclusion = _display_exclusion(valid_neighbours, covered)
    return _cut_sea_at_borders(
        covered, land_union, border_lines, coast_lines, growth_deg, exclusion
    )


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

    The sea margin is split with straight extensions of the borders, and only the pieces
    sharing a coast segment with the land are kept, so the mask stops where the border
    reaches the coast.
    """
    base = shapely.difference(covered, exclusion)
    if border_lines.is_empty or exclusion.is_empty:
        return shapely.normalize(base)

    try:
        sea = shapely.difference(covered, land_union)
        if sea.is_empty:
            return shapely.normalize(base)

        # Merging turns each border into whole lines, so only the real ends grow rays.
        rays = _seaward_border_rays(shapely.line_merge(border_lines), growth_deg, covered)
        if not rays:
            return shapely.normalize(base)

        divided = split(sea, shapely.union_all(rays))
        # Only pieces sharing a coast segment stay, so point touches at borders are dropped.
        # The buffer overlaps each coastal piece, so only a larger overlap marks the neighbour side.
        kept = [
            part
            for part in _polygonal_parts(divided)
            if shapely.intersection(part, coast_lines).length > OUTLINE_PRECISION_DEG
            and shapely.intersection(part, exclusion).area <= NEIGHBOUR_TOUCH_DEG * growth_deg
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


def _shared_border_lines(
    land_union: BaseGeometry, neighbours: Sequence[BaseGeometry]
) -> BaseGeometry:
    """The edges where the land meets its neighbours, which the sea margin must stop at."""
    lines: list[BaseGeometry] = []
    for neighbour in neighbours:
        try:
            touching = shapely.intersection(land_union, neighbour)
        except ShapelyError:
            # A neighbour that cannot be compared leaves the sea margin as it is.
            continue

        if touching.is_empty:
            continue

        lines += [
            part
            for part in shapely.get_parts(touching)
            if shapely.get_type_id(part) == LINE_STRING_TYPE_ID
        ]

    if not lines:
        return shapely.GeometryCollection()

    return shapely.union_all(lines)


def _coast_lines(land_union: BaseGeometry, border_lines: BaseGeometry) -> BaseGeometry:
    """The land boundary without its borders, where the sea margin may stay."""
    boundary = land_union.boundary
    if border_lines.is_empty:
        return boundary

    return shapely.difference(boundary, border_lines)


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
        if len(coords) < 2:
            continue

        for first, second in ((coords[0], coords[1]), (coords[-1], coords[-2])):
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


def clip_area_to_land(db_path: Path | str, store: Path | str, area: Area) -> Area:
    """The area cut to land, using the stored clip when the land version has one.

    The clip also depends on the boundaries around a named area, so a stored clip is used only
    while those are unchanged. Raises SourceUnavailable without a land store and AreaError when
    the area has no land, both before any data is read. An area wider than planning accepts is
    returned as it is, for planning to refuse.
    """
    version = land_version(store)
    frame = unwrap(area.geom)
    if _too_wide(frame):
        return area

    neighbours = _neighbours(db_path, area, frame)
    revision = _neighbour_revision(neighbours)
    digest = _clip_digest(area, frame, revision)
    stored = db.get_land_clip(db_path, digest, version, CLIP_METHOD_VERSION)
    if stored is None:
        clip = _clip_area(db_path, store, area, frame, neighbours)
        db.set_land_clip(db_path, digest, version, CLIP_METHOD_VERSION, _wkbs(clip))
    else:
        clip = LandClip(*shapely.from_wkb(stored))

    return replace(
        area,
        geom=clip.geom,
        display=clip.display,
        borders=clip.borders,
        land_version=version,
        neighbour_revision=revision,
    )


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
    """The same-level boundaries around a named area's frame, in either longitude frame.

    Boundaries that cross 180 are stored from -180 up to 360, so the grown frame is looked up
    again a world width to either side to find the ones stored on the other side of 180.
    """
    if not area.named:
        return []

    west, south, east, north = frame.bounds
    # The display outline grows past the frame by its sea margin and must not cover these.
    reach_deg = _conservative_reach_deg(frame.bounds)
    stored_west, stored_east = STORED_LONGITUDE_RANGE_DEG
    neighbours = []
    for shift_deg in (0, WORLD_WIDTH_DEG, -WORLD_WIDTH_DEG):
        window = (
            west - reach_deg - shift_deg,
            south - reach_deg,
            east + reach_deg - shift_deg,
            north + reach_deg,
        )
        if window[2] < stored_west or window[0] > stored_east:
            continue

        found = db.neighbour_digests(db_path, area.boundary, window)
        neighbours += [Neighbour(boundary_id, digest, shift_deg) for boundary_id, digest in found]

    return neighbours


def _neighbour_revision(neighbours: list[Neighbour]) -> str:
    """A short digest of which neighbours there are and of their geometry; empty without any."""
    if not neighbours:
        return ""

    lines = sorted(f"{item.id}:{item.digest}:{item.shift_deg}" for item in neighbours)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()[:REVISION_CHARS]


def _clip_area(
    db_path: Path | str,
    store: Path | str,
    area: Area,
    frame: BaseGeometry,
    neighbours: list[Neighbour],
) -> LandClip:
    if not area.named:
        return clip_to_land(store, frame, [], grow_deg=0)

    return clip_to_land(store, frame, _neighbour_shapes(db_path, neighbours))


def _neighbour_shapes(db_path: Path | str, neighbours: list[Neighbour]) -> list[BaseGeometry]:
    """The neighbours' shapes, each moved into the longitude frame of the area."""
    shapes = []
    for item in neighbours:
        geometry = shape(json.loads(db.get_boundary(db_path, item.id)["geom_geojson"]))
        shapes.append(translate(unwrap(geometry), xoff=item.shift_deg))

    return shapes


def _wkbs(clip: LandClip) -> db.LandClipWkbs:
    return (shapely.to_wkb(clip.geom), shapely.to_wkb(clip.display), shapely.to_wkb(clip.borders))


def store_clips(db_path: Path | str, store: Path | str) -> int:
    """Clip every country, then every state, that has no clip for the land version yet.

    Returns the number of clips stored. Countries are clipped one at a time because the largest
    hold millions of vertices, while states are clipped in parallel.
    """
    stored = 0
    for level, workers in CLIP_WORKERS_BY_LEVEL.items():
        boundary_ids = db.boundary_ids(db_path, CGAZ_SOURCE, (level,))
        # Each area runs in a fresh worker, so its peak memory is released afterwards.
        with ProcessPoolExecutor(
            workers, mp_context=get_context("spawn"), max_tasks_per_child=1
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


def _store_clip(db_path: Path | str, store: Path | str, boundary_id: str) -> bool:
    """Store the clip of one boundary unless it has one; whether a clip was stored."""
    boundary = db.get_boundary(db_path, boundary_id)
    area = Area(shape(json.loads(boundary["geom_geojson"])), boundary)
    frame = unwrap(area.geom)
    revision = _neighbour_revision(_neighbours(db_path, area, frame))
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

    Returns the number of clips stored.
    """
    version = _remote_version(LAND_ZIP_URL)
    if not _has_version(store, version):
        _download_land(LAND_ZIP_URL, store, version)

    db.ensure_schema(db_path)
    db.delete_land_clips_except(db_path, version, CLIP_METHOD_VERSION)
    return store_clips(db_path, store)


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
