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
import os
import shutil
import sqlite3
import tempfile
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
from shapely.geometry import MultiLineString, MultiPolygon, Polygon, shape
from shapely.geometry.base import BaseGeometry

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
CLIP_METHOD_VERSION = 3

PLANNING_TOLERANCE_DIVISOR = 200_000  # a 200000th of the larger bbox side, a tenth of a cell
MIN_DISPLAY_TOLERANCE_DEG = 0.001
DISPLAY_TOLERANCE_DIVISOR = 2000  # a 2000th of the larger bbox side, so small areas stay sharp
MAX_DISPLAY_VERTICES = 50_000
DISPLAY_CORNER_SEGMENTS = 2  # segments per quarter circle where the outline is grown

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

    return LandClip(
        _planning_land(parts, frame.bounds, held),
        _display_outline(parts, reach, neighbours, tolerance_deg),
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


def _display_outline(
    parts: list[Polygon],
    reach: BaseGeometry,
    neighbours: Sequence[BaseGeometry],
    tolerance_deg: float,
) -> BaseGeometry:
    """The parts simplified and grown by the tolerance, within `reach`.

    Growing hides the places where simplifying cut into the coast. Every neighbour inside the
    simplified reach is taken back after the growth, with one rounding step to spare because
    the build rounds coordinates and could otherwise move an edge onto it. The full neighbour
    is needed because simplifying can bridge further than the growth margin when the tolerance
    is larger. A coarser tolerance is tried until the outline has at most MAX_DISPLAY_VERTICES
    vertices or the tolerance is as wide as the area.
    """
    west, south, east, north = reach.bounds
    span_deg = max(east - west, north - south)
    valid_neighbours = [part if part.is_valid else shapely.make_valid(part) for part in neighbours]
    while True:
        large = [part for part in parts if part.area >= tolerance_deg**2] or parts[:1]
        simplified = shapely.make_valid(shapely.simplify(large, tolerance_deg))
        grown = shapely.buffer(simplified, tolerance_deg, quad_segs=DISPLAY_CORNER_SEGMENTS)
        # The reach is simplified too, because its sea side holds every vertex of the
        # boundary. The simplified reach can hold lines where islets collapsed, so only
        # its polygons are kept.
        coarse = reach.simplify(tolerance_deg, preserve_topology=True)
        coarse_reach = shapely.union_all(_polygonal_parts(coarse))
        within_reach = shapely.intersection(shapely.union_all(grown), coarse_reach)
        exclusion = _display_exclusion(valid_neighbours, coarse_reach)
        outline = shapely.normalize(shapely.difference(within_reach, exclusion))
        if (
            shapely.get_num_coordinates(outline) <= MAX_DISPLAY_VERTICES
            or tolerance_deg >= span_deg
        ):
            return outline

        tolerance_deg *= 2


def _display_exclusion(
    neighbours: Sequence[BaseGeometry], coarse_reach: BaseGeometry
) -> BaseGeometry:
    """The neighbour land inside the simplified reach, grown by one rounding step.

    Simplifying the reach can bridge across a border indentation when the tolerance is larger
    than the growth margin, so the whole neighbour inside the simplified reach is removed.
    Only the neighbours near the simplified reach are read, so far-away detail never enters
    the outline.
    """
    if not neighbours:
        return shapely.GeometryCollection()

    valid_reach = shapely.union_all(_polygonal_parts(shapely.make_valid(coarse_reach)))
    if valid_reach.is_empty:
        return valid_reach

    clipped = shapely.intersection(list(neighbours), valid_reach.envelope)
    polygons = _polygonal_parts(clipped)
    nearby = shapely.union_all(polygons) if polygons else shapely.GeometryCollection()
    if nearby.is_empty:
        return nearby

    # Buffer before any grid snapping, which can erase a neighbour narrower than the grid.
    relevant = shapely.intersection(shapely.make_valid(nearby), valid_reach)

    return relevant.buffer(OUTLINE_PRECISION_DEG, join_style="mitre")


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
    stored_west, stored_east = STORED_LONGITUDE_RANGE_DEG
    neighbours = []
    for shift_deg in (0, WORLD_WIDTH_DEG, -WORLD_WIDTH_DEG):
        window = (
            west - GROW_DEG - shift_deg,
            south - GROW_DEG,
            east + GROW_DEG - shift_deg,
            north + GROW_DEG,
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
        with ProcessPoolExecutor(workers, mp_context=get_context("spawn")) as pool:
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
        clip_area_to_land(db_path, store, area)
    except AreaError:
        print(f"land clips: {boundary_id} has no land, skipped", flush=True)
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
