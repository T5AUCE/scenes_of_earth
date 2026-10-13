"""Command line: `python -m soe.cli import-boundaries --cgaz DIR --ucdb FILE`."""
import argparse
import json
import logging
import os
import zipfile
from pathlib import Path

from . import db
from .areas import AreaError, unwrap
from .sources import GLO90_TILE_INDEX

GLO90_TILE_LIST = "https://copernicus-dem-90m.s3.amazonaws.com/tileList.txt"
GLO90_TILE_PATTERN = r"Copernicus_DSM_COG_30_([NS])(\d+)_00_([EW])(\d+)_00_DEM"
DOWNLOAD_TIMEOUT_SECS = 60
TILE_GRID_SHAPE = (180, 360)
TILE_ROW_OFFSET_DEG = 90  # row = lat + 90
TILE_COL_OFFSET_DEG = 180  # column = lon + 180

CGAZ_SOURCE = "geoBoundaries CGAZ"
CGAZ_LEVELS = {0: "country", 1: "state", 2: "county"}
UCDB_SOURCE = "GHSL UCDB R2024A"
MIN_CITY_POP = 1_000_000
BOUNDARY_LICENCE = "CC BY 4.0"

SIMPLIFY_TOLERANCE_DEG = 0.01
COVERAGE_BOUNDS_DEG = (-180, -60, 180, 60)  # the rain coverage
CELL_DEG2 = 0.05 * 0.05


def main(argv=None):
    parser = argparse.ArgumentParser(prog="soe")
    subparsers = parser.add_subparsers(dest="command", required=True)
    import_parser = subparsers.add_parser(
        "import-boundaries",
        help="load CGAZ ADM0/1/2 and GHSL UCDB cities into SQLite",
    )
    import_parser.add_argument("--cgaz", help="folder with the CGAZ ADM0/ADM1/ADM2 GeoPackages")
    import_parser.add_argument("--ucdb", help="GHS UCDB R2024A GeoPackage or zip")
    import_parser.add_argument("--db", default=os.environ.get("SOE_DB", "./data/soe.db"))
    subparsers.add_parser(
        "glo90-index",
        help="rebuild soe/data/glo90_tiles.bin from the GLO-90 tile list (downloads 1 MB)",
    )
    args = parser.parse_args(argv)

    if args.command == "glo90-index":
        tile_count = build_glo90_index(GLO90_TILE_INDEX)
        print("GLO-90 tiles:", tile_count)
        return

    if not (args.cgaz or args.ucdb):
        parser.error("give --cgaz and/or --ucdb")

    logging.basicConfig(level=logging.INFO)
    db.init(args.db)
    if args.cgaz:
        print("CGAZ rows:", import_cgaz(args.db, args.cgaz))
    if args.ucdb:
        print("UCDB city rows:", import_ucdb(args.db, args.ucdb))


def build_glo90_index(path):
    """Write the bitmap of GLO-90 tiles that exist (GLO90_TILE_INDEX) from the bucket list."""
    import re
    import urllib.request

    import numpy as np

    exists = np.zeros(TILE_GRID_SHAPE, bool)
    with urllib.request.urlopen(GLO90_TILE_LIST, timeout=DOWNLOAD_TIMEOUT_SECS) as response:
        lines = response.read().decode().splitlines()
    for line in lines:
        match = re.match(GLO90_TILE_PATTERN, line)
        if match:
            north_or_south, lat_digits, east_or_west, lon_digits = match.groups()
            lat = int(lat_digits) * (1 if north_or_south == "N" else -1)
            lon = int(lon_digits) * (1 if east_or_west == "E" else -1)
            exists[lat + TILE_ROW_OFFSET_DEG, lon + TILE_COL_OFFSET_DEG] = True

    Path(path).write_bytes(np.packbits(exists).tobytes())
    return int(exists.sum())


def import_cgaz(db_path, folder):
    """geoBoundaries CGAZ ADM0/1/2 GeoPackages, found in `folder` by 'ADM0', 'ADM1', 'ADM2'."""
    import geopandas as gpd

    frames = {}
    for level in CGAZ_LEVELS:
        files = sorted(Path(folder).glob(f"*ADM{level}*.gpkg"))
        if not files:
            raise SystemExit(f"no *ADM{level}*.gpkg in {folder}")
        frames[level] = gpd.read_file(files[0]).to_crs(4326)

    country_names = dict(zip(frames[0]["shapeGroup"], frames[0]["shapeName"]))
    county_parents = _county_parent_states(frames)
    rows = []
    for level, frame in frames.items():
        # ADM0 has no shapeID.
        id_column = "shapeID" if "shapeID" in frame.columns else "id"
        for index, record in frame.iterrows():
            country_code = record["shapeGroup"]
            country_name = country_names.get(country_code, "")
            parent = {
                0: "",
                1: country_name,
                2: county_parents.get(index, country_name),
            }[level]
            shape_id = record[id_column]
            row = _row(
                f"cgaz:ADM{level}:{shape_id}",
                CGAZ_LEVELS[level],
                record["shapeName"],
                parent,
                country_code,
                record.geometry,
                CGAZ_SOURCE,
                BOUNDARY_LICENCE,
            )
            if row:
                rows.append(row)

    replaced = db.add_boundaries(db_path, CGAZ_SOURCE, rows)
    print(f"CGAZ: {replaced} duplicate ids replaced")
    return len(rows)


def _county_parent_states(frames):
    """State name per county index: the state that contains the county's representative point."""
    counties = frames[2].copy()
    counties.geometry = counties.representative_point()
    joined = counties.sjoin(frames[1][["geometry", "shapeName"]], predicate="within", rsuffix="p")
    return joined.groupby(level=0)["shapeName_p"].first()


def import_ucdb(db_path, path):
    """GHSL UCDB R2024A (GeoPackage or zip of one): urban centres with population >= 1,000,000.

    Column names are matched by substring (UCN_MAI name, POP_TOT, CNT_GAD country) because the
    exact R2024A names could not be checked offline.
    """
    import geopandas as gpd

    path = str(path)
    if path.endswith(".zip"):
        inner = next(name for name in zipfile.ZipFile(path).namelist() if name.endswith(".gpkg"))
        path = f"zip://{path}!{inner}"
    frame = gpd.read_file(path, layer=_ucdb_layer(path)).to_crs(4326)

    name_column = _latest_column(frame, "UCN_MAI")
    population_column = _latest_column(frame, "POP_TOT")
    country_column = _latest_column(frame, "CNT_GAD")
    rows = []
    for index, record in frame[frame[population_column] >= MIN_CITY_POP].iterrows():
        row = _row(
            f"ucdb:{index}",
            "city",
            record[name_column],
            record[country_column],
            None,
            record.geometry,
            UCDB_SOURCE,
            BOUNDARY_LICENCE,
        )
        if row:
            rows.append(row)

    replaced = db.add_boundaries(db_path, UCDB_SOURCE, rows)
    print(f"UCDB: {replaced} duplicate ids replaced")
    return len(rows)


def _ucdb_layer(path):
    import pyogrio

    layers = [layer[0] for layer in pyogrio.list_layers(path)]
    general = (layer for layer in layers if "GENERAL_CHARACTERISTICS" in layer.upper())
    return next(general, layers[0])


def _latest_column(frame, part):
    """Column containing `part`; if several epochs exist (..._1975 ... _2025) take the latest."""
    return sorted(column for column in frame.columns if part in column)[-1]


def _row(row_id, level, name, parent, iso3, geometry, source, licence):
    """One boundaries row: geometry simplified, clipped to rain coverage (60S-60N)."""
    from shapely.geometry import box, mapping

    simplified = geometry.simplify(SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)
    clipped = simplified.intersection(box(*COVERAGE_BOUNDS_DEG))
    if clipped.is_empty:
        return None

    # A shape across 180 gets E > 180 instead of spanning the world.
    try:
        west, south, east, north = unwrap(clipped).bounds
    except AreaError as error:
        print(f"skipping {row_id}: {error}")
        return None

    cells = max(1, round(clipped.area / CELL_DEG2))

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
        licence,
    )


if __name__ == "__main__":
    main()
