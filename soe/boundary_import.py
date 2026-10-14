"""Load geoBoundaries CGAZ shapes and GHSL UCDB cities into the boundaries table."""
import json
import zipfile
from pathlib import Path

from . import db
from .areas import AreaError, unwrap
from .sources import CELL_DEG, SOURCES, SUPPORTED_BOUNDS_DEG

CGAZ_SOURCE = "geoBoundaries CGAZ"
CGAZ_LEVELS = {0: "country", 1: "state", 2: "county"}
UCDB_SOURCE = "GHSL UCDB R2024A"
MIN_CITY_POP = 1_000_000

SIMPLIFY_TOLERANCE_DEG = 0.01
CELL_AREA_DEG2 = CELL_DEG * CELL_DEG


def import_cgaz(db_path, folder):
    """geoBoundaries CGAZ ADM0/1/2 GeoPackages, found in `folder` by 'ADM0', 'ADM1', 'ADM2'.

    Returns the number of rows stored.
    """
    frames = {level: _read_cgaz_level(folder, level) for level in CGAZ_LEVELS}
    return _store(db_path, CGAZ_SOURCE, "CGAZ", _cgaz_rows(frames))


def _read_cgaz_level(folder, level):
    import geopandas as gpd

    files = sorted(Path(folder).glob(f"*ADM{level}*.gpkg"))
    if not files:
        raise SystemExit(f"no *ADM{level}*.gpkg in {folder}")
    return gpd.read_file(files[0]).to_crs(4326)


def _cgaz_rows(frames):
    """Boundary row per CGAZ shape, countries first; None for a shape outside the coverage."""
    country_names = dict(zip(frames[0]["shapeGroup"], frames[0]["shapeName"]))
    county_states = _county_states(counties=frames[2], states=frames[1])
    for level, frame in frames.items():
        # ADM0 has no shapeID.
        id_column = "shapeID" if "shapeID" in frame.columns else "id"
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


def _parent_name(level, index, country_name, county_states):
    """No parent for a country, its country for a state, the containing state for a county."""
    if level == 0:
        return ""
    if level == 1:
        return country_name
    return county_states.get(index, country_name)


def _county_states(counties, states):
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


def import_ucdb(db_path, path):
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


def _read_ucdb(path):
    """The UCDB general-characteristics layer in WGS 84."""
    import geopandas as gpd

    path = str(path)
    if path.endswith(".zip"):
        path = _zipped_geopackage(path)
    return gpd.read_file(path, layer=_ucdb_layer(path)).to_crs(4326)


def _zipped_geopackage(zip_path):
    """GDAL path of the first GeoPackage inside a zip."""
    with zipfile.ZipFile(zip_path) as archive:
        inner = next(name for name in archive.namelist() if name.endswith(".gpkg"))
    return f"zip://{zip_path}!{inner}"


def _ucdb_layer(path):
    import pyogrio

    layers = [layer[0] for layer in pyogrio.list_layers(path)]
    general = (layer for layer in layers if "GENERAL_CHARACTERISTICS" in layer.upper())
    return next(general, layers[0])


def _latest_column(frame, part):
    """Column containing `part`; if several epochs exist (..._1975 ... _2025) take the latest."""
    return sorted(column for column in frame.columns if part in column)[-1]


def _store(db_path, source, label, rows):
    """Replace the boundaries of `source` with `rows`, skipping None; returns the count stored."""
    kept = [row for row in rows if row]
    replaced = db.add_boundaries(db_path, source, kept)
    print(f"{label}: {replaced} duplicate ids replaced")
    return len(kept)


def _row(row_id, level, name, parent, iso3, geometry, source):
    """One boundaries row: geometry simplified, clipped to the supported extent (60S-60N)."""
    from shapely.geometry import box, mapping

    simplified = geometry.simplify(SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)
    clipped = simplified.intersection(box(*SUPPORTED_BOUNDS_DEG))
    if clipped.is_empty:
        return None

    # A shape across 180 gets E > 180 instead of spanning the world.
    try:
        west, south, east, north = unwrap(clipped).bounds
    except AreaError as error:
        print(f"skipping {row_id}: {error}")
        return None

    cells = max(1, round(clipped.area / CELL_AREA_DEG2))

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
        json.dumps(mapping(clipped)),
        source,
        SOURCES[source]["licence"],
    )
