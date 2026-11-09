"""Load geoBoundaries CGAZ shapes, GHSL UCDB cities and gbOpen level names into SQLite."""
import json
import re
import zipfile
from collections.abc import Iterable, Iterator
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
MIN_CITY_POP = 1_000_000

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


def _cgaz_rows(
    frames: dict[int, "gpd.GeoDataFrame"],
) -> Iterator[db.BoundaryValues | None]:
    """Boundary row per CGAZ shape, countries first; None for a shape outside the coverage."""
    country_names = dict(zip(frames[0]["shapeGroup"], frames[0]["shapeName"]))
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


def _parent_name(
    level: int,
    index: int,
    country_name: str,
    county_states: "pd.Series",
) -> str:
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
        states[["geometry", "shapeName"]],
        predicate="within",
        rsuffix="state",
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
    """GHSL UCDB R2024A (GeoPackage or zip of one): urban centres with population >= 1,000,000.

    Column names are matched by substring (UCN_MAI name, POP_TOT, CNT_GAD country) because the
    exact R2024A names could not be checked offline. Returns the number of rows stored.
    """
    cities = _read_ucdb(path)
    name_column = _latest_column(cities, "UCN_MAI")
    population_column = _latest_column(cities, "POP_TOT")
    country_column = _latest_column(cities, "CNT_GAD")
    large_cities = cities[cities[population_column] >= MIN_CITY_POP]
    rows = (
        _row(
            f"ucdb:{index}",
            level="city",
            name=city[name_column],
            parent=city[country_column],
            iso3=None,
            geometry=city.geometry,
            source=UCDB_SOURCE,
        )
        for index, city in large_cities.iterrows()
    )
    return _store(db_path, UCDB_SOURCE, "UCDB", rows)


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
    db_path: Path | str,
    source: str,
    label: str,
    rows: Iterable[db.BoundaryValues | None],
) -> int:
    """Replace the boundaries of `source` with `rows`, skipping None; returns the count stored."""
    kept = _PresentRows(rows)
    replaced = db.add_boundaries(db_path, source, kept)
    print(f"{label}: {replaced} duplicate ids replaced")
    return kept.count


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
) -> db.BoundaryValues | None:
    """Return a repaired boundary row clipped to the supported extent, keeping every vertex."""
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
        SOURCES[source]["licence"],
    )
