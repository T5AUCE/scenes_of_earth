"""Load geoBoundaries CGAZ shapes, GHSL UCDB urban areas, gbOpen kinds and Overture into SQLite."""

import json
import os
import re
import sqlite3
import tempfile
import zipfile
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path
from typing import TYPE_CHECKING

from shapely.geometry.base import BaseGeometry

from . import db
from .areas import AreaError, display_preview, polygonal_parts, unwrap
from .sources import CELL_DEG, SOURCES, SUPPORTED_BOUNDS_DEG

if TYPE_CHECKING:
    import geopandas as gpd
    import pandas as pd

CGAZ_SOURCE = "geoBoundaries CGAZ"
CGAZ_LEVELS = {0: "country", 1: "state", 2: "county"}
UCDB_SOURCE = "GHSL UCDB R2024A"
UCDB_LEVEL = "urban"
MIN_URBAN_POP = 1_000_000

META_FILES = {"gbOpen-ADM1.json": "state", "gbOpen-ADM2.json": "county"}
MAX_KIND_CHARS = 24
MISSING_KINDS = {"unknown", "gbopen"}
KIND_OVERRIDES: dict[str, str | None] = {
    "okres": "Okres",
    "regiões": "Região",
    "croatia": None,
    "mauritania": None,
    "chinese taipei": None,
    "régions de côte d'ivoire": None,
}
WORD_RE = re.compile(r"[^\W\d_]+")
CONNECTORS = {"and", "or"}

CELL_AREA_DEG2 = CELL_DEG * CELL_DEG

# Columns that Overture rows add after the 15 shared by every source, in write order.
OVERTURE_COLUMNS = {
    "name_local": "TEXT",
    "parent_name_local": "TEXT",
    "state_name": "TEXT",
    "kind": "TEXT",
    "has_maritime": "INTEGER",
    "border_level": "INTEGER",
    "aliases": "TEXT",
    "contributors": "TEXT",
    "border_level_sampled": "INTEGER",  # 1 when border_level was copied from a sample of its group
}
BASE_COLUMNS = (
    "id, level, name, parent_name, iso3, bbox_w, bbox_s, bbox_e, bbox_n, cells, geom_geojson, "
    "geom_digest, preview_geojson, source, licence"
)
ALL_COLUMNS = f"{BASE_COLUMNS}, {', '.join(OVERTURE_COLUMNS)}"
BOUNDARY_PARTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS boundary_parts (
    parent_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (parent_id, position)
);

CREATE TABLE IF NOT EXISTS disputed_lines (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    bbox_w REAL NOT NULL,
    bbox_s REAL NOT NULL,
    bbox_e REAL NOT NULL,
    bbox_n REAL NOT NULL,
    wkb BLOB NOT NULL
);
"""

OSM_LEVELS_SCHEMA = """
CREATE TABLE IF NOT EXISTS osm_levels (
    record_id TEXT PRIMARY KEY,
    admin_level INTEGER
)
"""
STAGED_COLUMNS = f"{ALL_COLUMNS}, osm_record_id"

PartRow = tuple[str, int, str]  # parent area id, position among its parts, part area id
DisputedRow = tuple[str, str, float, float, float, float, bytes]  # id, level, bbox, WKB


def import_cgaz(db_path: Path | str, folder: Path | str) -> int:
    """geoBoundaries CGAZ ADM0/1/2 GeoPackages, found in `folder` by 'ADM0', 'ADM1', 'ADM2'.

    Returns the number of rows stored.
    """
    frames = {level: _read_cgaz_level(folder, level) for level in CGAZ_LEVELS}
    return _store(db_path, CGAZ_SOURCE, "CGAZ", _cgaz_rows(frames))


def _read_cgaz_level(folder: Path | str, level: int) -> "gpd.GeoDataFrame":
    import geopandas as gpd

    files = sorted(Path(folder).glob(f"*ADM{level}*.gpkg"))
    if not files:
        raise SystemExit(f"no *ADM{level}*.gpkg in {folder}")

    return gpd.read_file(files[0]).to_crs(4326)


def _cgaz_rows(frames: dict[int, "gpd.GeoDataFrame"]) -> Iterator[db.BoundaryValues | None]:
    """Boundary row per CGAZ shape, countries first; None for a shape outside the coverage."""
    country_names = dict(zip(frames[0]["shapeGroup"], frames[0]["shapeName"], strict=True))
    county_states = _county_states(counties=frames[2], states=frames[1])
    for level, frame in frames.items():
        # ADM0 has no shapeID and its id column is empty, so the ISO3 group names a country.
        id_column = "shapeID" if "shapeID" in frame.columns else "shapeGroup"
        for index, record in frame.iterrows():
            country_name = country_names.get(record["shapeGroup"], "")
            yield _row(
                f"cgaz:ADM{level}:{record[id_column]}",
                level=CGAZ_LEVELS[level],
                name=record["shapeName"],
                parent=_parent_name(level, index, country_name, county_states),
                iso3=record["shapeGroup"],
                geometry=record.geometry,
                source=CGAZ_SOURCE,
            )


def _parent_name(level: int, index: int, country_name: str, county_states: "pd.Series") -> str:
    """No parent for a country, its country for a state, the containing state for a county."""
    if level == 0:
        return ""
    if level == 1:
        return country_name

    return county_states.get(index, country_name)


def _county_states(counties: "gpd.GeoDataFrame", states: "gpd.GeoDataFrame") -> "pd.Series":
    """State name per county index: the state that contains the county's representative point."""
    county_points = counties.copy()
    county_points.geometry = counties.representative_point()
    joined = county_points.sjoin(
        states[["geometry", "shapeName"]], predicate="within", rsuffix="state"
    )

    # Overlapping states can both contain the point; keep the first.
    return joined.groupby(level=0)["shapeName_state"].first()


def import_admin_kinds(db_path: Path | str, folder: Path | str) -> int:
    """Import short singular type names per country and level from the gbOpen metadata files.

    Reads gbOpen-ADM1.json and gbOpen-ADM2.json in `folder`, saved from the geoBoundaries
    gbOpen API. Entries without a usable name are skipped. Returns the number of names stored.
    """
    rows = [
        (iso3, level, kind)
        for filename, level in META_FILES.items()
        for iso3, kind in _meta_kinds(folder, filename)
    ]
    return db.set_admin_kinds(db_path, rows)


def _meta_kinds(folder: Path | str, filename: str) -> Iterator[tuple[str, str]]:
    """Yield (iso3, normalised kind) per country in one gbOpen metadata file."""
    path = Path(folder) / filename
    if not path.exists():
        raise SystemExit(f"no {filename} in {folder}")

    entries = json.loads(path.read_text(encoding="utf-8"))
    for entry in entries:
        kind = normalise_kind(entry.get("boundaryCanonical") or "")
        if kind is not None:
            yield entry["boundaryISO"], kind


def normalise_kind(raw: str) -> str | None:
    """Return a short singular display name for a gbOpen level type.

    Placeholders, country names and long phrases fall back to no name, while short joined
    forms stay because shortening them would misname some units.
    """
    text = raw.strip()
    lowered = text.lower()
    if not text or lowered in MISSING_KINDS:
        return None
    if lowered in KIND_OVERRIDES:
        return KIND_OVERRIDES[lowered]
    if len(text) > MAX_KIND_CHARS:
        return None

    named = WORD_RE.sub(_singularise_match, text.title())
    return _connectors_lowered(named)


def _singularise_match(match: re.Match[str]) -> str:
    """Singularise one title-cased word, so a plural names one unit."""
    word = match.group(0).lower()
    if word.endswith("ies") and len(word) > 3:
        return (word[:-3] + "y").capitalize()
    if word.endswith("ous"):
        return word.capitalize()
    # Plurals of words ending in a sibilant add es, so only those lose two letters.
    if word.endswith(("sses", "xes", "zes", "ches", "shes")) and len(word) > 4:
        return word[:-2].capitalize()
    if word.endswith("s") and len(word) > 2 and not word.endswith("ss"):
        return word[:-1].capitalize()

    return word.capitalize()


def _connectors_lowered(named: str) -> str:
    """Lowercase small joining words after the first, so joined forms read naturally."""
    words = named.split(" ")
    return " ".join(
        word.lower() if index and word.lower() in CONNECTORS else word
        for index, word in enumerate(words)
    )


def import_ucdb(db_path: Path | str, path: Path | str) -> int:
    """GHSL UCDB R2024A (GeoPackage or zip of one): urban areas with population >= 1,000,000.

    Column names are matched by substring (UCN_MAI name, POP_TOT, CNT_GAD country) because the
    exact R2024A names could not be checked offline. Returns the number of rows stored.
    """
    cities = _read_ucdb(path)
    name_column = _latest_column(cities, "UCN_MAI")
    population_column = _latest_column(cities, "POP_TOT")
    country_column = _latest_column(cities, "CNT_GAD")
    large_cities = cities[cities[population_column] >= MIN_URBAN_POP]
    rows = (
        _row(
            f"ucdb:{index}",
            level=UCDB_LEVEL,
            name=city[name_column],
            parent=city[country_column],
            iso3=None,
            geometry=city.geometry,
            source=UCDB_SOURCE,
        )
        for index, city in large_cities.iterrows()
    )

    return _store(db_path, UCDB_SOURCE, "UCDB", rows)


def relabel_ucdb_as_urban(db_path: Path | str) -> int:
    """Move the UCDB rows stored as `city` before the urban level existed; returns the count."""
    with db.connect(db_path) as connection:
        cursor = connection.execute(
            "UPDATE boundaries SET level = ? WHERE source = ? AND level = 'city'",
            (UCDB_LEVEL, UCDB_SOURCE),
        )
        return cursor.rowcount


def _read_ucdb(path: Path | str) -> "gpd.GeoDataFrame":
    """The UCDB general-characteristics layer in WGS 84."""
    import geopandas as gpd

    path = str(path)
    if path.endswith(".zip"):
        path = _zipped_geopackage(path)

    return gpd.read_file(path, layer=_ucdb_layer(path)).to_crs(4326)


def _zipped_geopackage(zip_path: str) -> str:
    """GDAL path of the first GeoPackage inside a zip."""
    with zipfile.ZipFile(zip_path) as archive:
        inner = next(name for name in archive.namelist() if name.endswith(".gpkg"))
    return f"zip://{zip_path}!{inner}"


def _ucdb_layer(path: str) -> str:
    import pyogrio

    layers = [layer[0] for layer in pyogrio.list_layers(path)]
    general = (layer for layer in layers if "GENERAL_CHARACTERISTICS" in layer.upper())
    return next(general, layers[0])


def _latest_column(frame: "gpd.GeoDataFrame", part: str) -> str:
    """Column containing `part`; if several epochs exist (..._1975 ... _2025) take the latest."""
    return sorted(column for column in frame.columns if part in column)[-1]


def _store(
    db_path: Path | str, source: str, label: str, rows: Iterable[db.BoundaryValues | None]
) -> int:
    """Replace the boundaries of `source` with `rows`, skipping None; returns the count stored."""
    kept = _PresentRows(rows)
    replaced = db.add_boundaries(db_path, source, kept)
    print(f"{label}: {replaced} duplicate ids replaced")

    return kept.count


def store_overture(
    db_path: Path | str,
    source: str,
    rows: Iterable[db.BoundaryValues | None],
    parts: list[PartRow],
    disputed_lines: list[DisputedRow],
    before_replace: Callable[[], None],
    levels: tuple[str, ...] | None = None,
) -> Counter[str]:
    """Replace the boundaries of `source`, their parts and the disputed lines in one transaction.

    With `levels`, only the rows of `source` at those levels are replaced, and the stored parts
    and disputed lines stay as they are.

    Rows hold the 15 shared columns, the OVERTURE_COLUMNS values with an empty border_level, and
    the OpenStreetMap record id, and None rows are skipped. `before_replace` runs once the rows
    are staged, and the replace then fills border_level from the osm_levels table by record id.
    Building them takes hours, so they go to a scratch file beside the database first and
    only the final copy holds the database's write lock. Each run uses its own scratch file, so
    overlapping imports cannot share or delete each other's staging data. Returns the number of
    rows stored per level.
    """
    target = Path(db_path)
    # A unique name keeps overlapping imports from sharing one file.
    staging_fd, staging_name = tempfile.mkstemp(dir=target.parent, prefix=f"{target.name}.staging-")
    os.close(staging_fd)
    staging_path = Path(staging_name)

    try:
        stored = _stage_rows(staging_path, rows)
        before_replace()
        _replace_from_staging(db_path, staging_path, source, parts, disputed_lines, levels)
    finally:
        staging_path.unlink(missing_ok=True)

    return stored


def _stage_rows(staging_path: Path, rows: Iterable[db.BoundaryValues | None]) -> Counter[str]:
    """Write the rows to a scratch SQLite file; returns the distinct ids per level."""
    insert = f"INSERT INTO boundaries ({STAGED_COLUMNS}) VALUES ({_placeholders()})"  # noqa: S608 - only module constants are joined in.
    staging = sqlite3.connect(staging_path, isolation_level=None)
    try:
        # The file is thrown away after the copy, so a crash needs no recovery.
        staging.execute("PRAGMA journal_mode=OFF")
        staging.execute("PRAGMA synchronous=OFF")
        staging.execute(f"CREATE TABLE boundaries ({STAGED_COLUMNS})")
        staging.execute("BEGIN")
        batch: list[db.BoundaryValues] = []
        for row in rows:
            if row is None:
                continue

            batch.append(row)
            if len(batch) >= db.INSERT_BATCH_ROWS:
                staging.executemany(insert, batch)
                batch = []

        staging.executemany(insert, batch)
        staging.execute("COMMIT")

        counts = staging.execute("SELECT level, count(DISTINCT id) FROM boundaries GROUP BY level")
        return Counter(dict(counts))
    finally:
        staging.close()


def _replace_from_staging(
    db_path: Path | str,
    staging_path: Path,
    source: str,
    parts: list[PartRow],
    disputed_lines: list[DisputedRow],
    levels: tuple[str, ...] | None,
) -> None:
    with db.connect(db_path) as connection:
        _add_overture_columns(connection)
        connection.executescript(BOUNDARY_PARTS_SCHEMA)
        connection.execute(OSM_LEVELS_SCHEMA)
        connection.execute("ATTACH DATABASE ? AS staging", (str(staging_path),))
        # Immediate holds the write lock during the level read, so another writer cannot slip in.
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "UPDATE staging.boundaries SET border_level = ("
            "SELECT admin_level FROM main.osm_levels WHERE record_id = osm_record_id)"
        )
        if levels:
            marks = ", ".join("?" for _ in levels)
            connection.execute(
                f"DELETE FROM boundaries WHERE source = ? AND level IN ({marks})",  # noqa: S608 - only placeholders are joined in.
                (source, *levels),
            )
        else:
            connection.execute("DELETE FROM boundaries WHERE source = ?", (source,))
            connection.execute("DELETE FROM boundary_parts")
            connection.execute("DELETE FROM disputed_lines")

        connection.execute(
            f"INSERT OR REPLACE INTO boundaries ({ALL_COLUMNS}) "  # noqa: S608 - only module constants are joined in.
            f"SELECT {ALL_COLUMNS} FROM staging.boundaries"
        )
        connection.executemany("INSERT INTO boundary_parts VALUES (?, ?, ?)", parts)
        connection.executemany(
            "INSERT INTO disputed_lines VALUES (?, ?, ?, ?, ?, ?, ?)", disputed_lines
        )
        connection.execute("COMMIT")


def _placeholders() -> str:
    return ", ".join("?" for _ in STAGED_COLUMNS.split(", "))


def _add_overture_columns(connection: sqlite3.Connection) -> None:
    """Give a database created before these columns existed the columns Overture rows fill."""
    existing = {row["name"] for row in connection.execute("PRAGMA table_info(boundaries)")}
    for column, column_type in OVERTURE_COLUMNS.items():
        if column not in existing:
            connection.execute(f"ALTER TABLE boundaries ADD COLUMN {column} {column_type}")


class _PresentRows:
    """Filter None rows while counting how many were kept, so the count stays with the iteration."""

    def __init__(self, rows: Iterable[db.BoundaryValues | None]) -> None:
        self._rows = rows
        self.count = 0

    def __iter__(self) -> Iterator[db.BoundaryValues]:
        for row in self._rows:
            if row is not None:
                self.count += 1
                yield row


def _row(
    row_id: str,
    level: str,
    name: str,
    parent: str,
    iso3: str | None,
    geometry: BaseGeometry,
    source: str,
    licence: str | None = None,
) -> db.BoundaryValues | None:
    """Return a repaired boundary row clipped to the supported extent, keeping every vertex.

    The licence comes from SOURCES unless the caller states it.
    """
    from shapely.errors import GEOSException
    from shapely.geometry import MultiPolygon, box, mapping

    # A missing name breaks the NOT NULL constraint, and NaN never equals itself.
    if not name or name != name:
        print(f"skipping {row_id}: missing name")
        return None

    polygons = polygonal_parts(geometry)
    if not polygons:
        print(f"skipping {row_id}: no polygonal parts after repair")
        return None

    merged = MultiPolygon(polygons) if len(polygons) > 1 else polygons[0]
    try:
        clipped = merged.intersection(box(*SUPPORTED_BOUNDS_DEG))
    except GEOSException as error:
        print(f"skipping {row_id}: cannot clip to the supported extent ({error})")
        return None

    if clipped.is_empty:
        return None

    # A shape across 180 gets E > 180 instead of spanning the world.
    try:
        west, south, east, north = unwrap(clipped).bounds
    except AreaError as error:
        print(f"skipping {row_id}: {error}")
        return None

    cells = max(1, round(clipped.area / CELL_AREA_DEG2))
    geometry_text = json.dumps(mapping(clipped))
    preview = json.dumps(display_preview(clipped, (west, south, east, north)))

    return (
        row_id,
        level,
        name,
        parent,
        iso3,
        west,
        south,
        east,
        north,
        cells,
        geometry_text,
        db.geometry_digest(geometry_text),
        preview,
        source,
        licence or SOURCES[source]["licence"],
    )
