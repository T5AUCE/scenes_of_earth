"""Run the offline data jobs from the command line.

The module imports country and city boundaries into SQLite, with each country's own names
for its administrative levels. It also backfills the stored display previews and geometry
digests of boundaries imported before them. It rebuilds the Copernicus terrain
tile indexes and the ESA WorldCover tile index. It also ingests ERA5-Land, ERA5 and CHIRPS
monthly cubes, the lithology map and the rock-age map into local folders. Run
`python -m soe.cli --help` to see the commands and their options.
"""
import argparse
import json
import logging
import os
import re
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import numpy as np
from shapely.geometry import shape

from . import db
from .areas import display_preview
from .boundary_import import import_admin_kinds, import_cgaz, import_ucdb
from .ingest import chirps
from .ingest.era5 import INGEST_SPECS, ingest
from .ingest.geology_age import ingest_geology_age
from .ingest.geology_regional import SOURCE_IDS, ingest_geology_regional
from .ingest.lithology import ingest_lithology
from .sources import (
    CHIRPS_CUBE,
    DEFAULT_CUBES_DIR,
    REQUEST_STEP,
    TERRAIN_PRODUCTS,
    TILE_COL_OFFSET_DEG,
    TILE_GRID_SHAPE,
    TILE_ROW_OFFSET_DEG,
    is_request_label,
)
from .sources.worldcover import WORLDCOVER_GRID_SHAPE, WORLDCOVER_TILE_INDEX, index_cell

TILE_LIST_URLS = {
    "glo30": "https://copernicus-dem-30m.s3.amazonaws.com/tileList.txt",
    "glo90": "https://copernicus-dem-90m.s3.amazonaws.com/tileList.txt",
}
WORLDCOVER_GRID_URL = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/esa_worldcover_grid.geojson"
)
DOWNLOAD_TIMEOUT_SECS = 60

BACKFILL_BATCH_SIZE = 100  # boundaries read and updated per backfill transaction


def main(argv: list[str] | None = None) -> None:
    """Run the command named on the command line; `--help` lists them."""
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command == "terrain-index":
        for product, terrain_product in TERRAIN_PRODUCTS.items():
            print(f"{product} tiles:", build_tile_index(product, terrain_product.index))
        return

    if args.command == "worldcover-index":
        print("WorldCover tiles:", build_worldcover_index(WORLDCOVER_TILE_INDEX))
        return

    if args.command == "backfill-area-previews":
        if args.batch_size < 1:
            parser.error("--batch-size must be at least 1")

        logging.basicConfig(level=logging.INFO)
        print(f"Area previews: {backfill_area_previews(args.db, args.batch_size)} backfilled")
        return

    if args.command == "ingest-cube":
        if not is_request_label(args.start, REQUEST_STEP):
            parser.error("--from must be YYYY-MM")

        logging.basicConfig(level=logging.INFO)
        if args.cube == CHIRPS_CUBE.name:
            if args.from_files:
                parser.error("--from-files holds ERA5 year files, not CHIRPS")

            chirps.ingest(args.cubes, args.start)
        else:
            ingest(args.cubes, INGEST_SPECS[args.cube], args.start, files_dir=args.from_files)
        return

    if args.command == "ingest-lithology":
        logging.basicConfig(level=logging.INFO)
        print("Lithology COG:", ingest_lithology(args.cubes))
        return

    if args.command == "ingest-geology-age":
        logging.basicConfig(level=logging.INFO)
        print("Geological age COG:", ingest_geology_age(args.cubes, args.archive))
        return

    if args.command == "ingest-geology-regional":
        logging.basicConfig(level=logging.INFO)
        published = ingest_geology_regional(args.cubes, args.source, args.archive)
        print("Regional geology COGs:", *published)
        return

    if not (args.cgaz or args.ucdb or args.meta):
        parser.error("give at least one of --cgaz, --ucdb, --meta")

    logging.basicConfig(level=logging.INFO)
    db.ensure_schema(args.db)
    if args.cgaz:
        print("CGAZ rows:", import_cgaz(args.db, args.cgaz))
    if args.ucdb:
        print("UCDB city rows:", import_ucdb(args.db, args.ucdb))
    if args.meta:
        print("Admin kind rows:", import_admin_kinds(args.db, args.meta))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="soe")
    subparsers = parser.add_subparsers(dest="command", required=True)
    import_parser = subparsers.add_parser(
        "import-boundaries",
        help="load CGAZ ADM0/1/2, GHSL UCDB cities and gbOpen level names into SQLite",
    )
    import_parser.add_argument("--cgaz", help="folder with the CGAZ ADM0/ADM1/ADM2 GeoPackages")
    import_parser.add_argument("--ucdb", help="GHS UCDB R2024A GeoPackage or zip")
    import_parser.add_argument(
        "--meta",
        help="folder with the gbOpen ADM1/ADM2 metadata JSON files",
    )
    import_parser.add_argument("--db", default=os.environ.get("SOE_DB", "./data/soe.db"))
    subparsers.add_parser(
        "terrain-index",
        help="rebuild the GLO-30 and GLO-90 tile bitmaps in soe/data (downloads 2 MB)",
    )
    subparsers.add_parser(
        "worldcover-index",
        help="rebuild the ESA WorldCover tile bitmap in soe/data (downloads 0.5 MB)",
    )
    backfill_parser = subparsers.add_parser(
        "backfill-area-previews",
        help="store display previews and geometry digests for boundaries imported before them",
    )
    backfill_parser.add_argument("--db", default=os.environ.get("SOE_DB", "./data/soe.db"))
    backfill_parser.add_argument(
        "--batch-size",
        type=int,
        default=BACKFILL_BATCH_SIZE,
        help="boundaries read and updated per transaction",
    )
    lithology_parser = subparsers.add_parser(
        "ingest-lithology",
        help="write the Rock type COG from the downloaded GLiM, else the OpenLandMap map (232 MB)",
    )
    lithology_parser.add_argument(
        "--cubes",
        default=os.environ.get("SOE_CUBES_DIR", DEFAULT_CUBES_DIR),
        help="folder of the cubes (default: SOE_CUBES_DIR or ./data/cubes)",
    )
    age_parser = subparsers.add_parser(
        "ingest-geology-age",
        help="write the Geological age COG from the GSC world geology map (fetches 27 MB)",
    )
    age_parser.add_argument(
        "--archive",
        help="a local copy of GSC Open File 5529 (of_5529.zip), instead of fetching it",
    )
    age_parser.add_argument(
        "--cubes",
        default=os.environ.get("SOE_CUBES_DIR", DEFAULT_CUBES_DIR),
        help="folder of the cubes (default: SOE_CUBES_DIR or ./data/cubes)",
    )
    regional_parser = subparsers.add_parser(
        "ingest-geology-regional",
        help="write one regional geology patchwork source's class COGs (age and/or type)",
    )
    regional_parser.add_argument("source", choices=SOURCE_IDS, help="the regional source to build")
    regional_parser.add_argument(
        "--archive",
        help="a local copy of the source archive (zip, geodatabase folder or raster)",
    )
    regional_parser.add_argument(
        "--cubes",
        default=os.environ.get("SOE_CUBES_DIR", DEFAULT_CUBES_DIR),
        help="folder of the cubes (default: SOE_CUBES_DIR or ./data/cubes)",
    )
    ingest_parser = subparsers.add_parser(
        "ingest-cube",
        help="download a monthly variable into its local cube (ERA5 via CDS, CHIRPS via HTTP)",
    )
    ingest_parser.add_argument(
        "cube",
        choices=[*INGEST_SPECS, CHIRPS_CUBE.name],
        help="the cube to fill or update",
    )
    ingest_parser.add_argument(
        "--from",
        dest="start",
        required=True,
        metavar="YYYY-MM",
        help="first month of a new cube, or an earlier month to extend it; later runs continue on",
    )
    ingest_parser.add_argument(
        "--from-files",
        metavar="DIR",
        help="store the months of the finished <name>-<year>.grib files in DIR before asking "
        "the CDS for the rest; the files are kept",
    )
    ingest_parser.add_argument(
        "--cubes",
        default=os.environ.get("SOE_CUBES_DIR", DEFAULT_CUBES_DIR),
        help="folder of the cubes (default: SOE_CUBES_DIR or ./data/cubes)",
    )
    return parser


def backfill_area_previews(db_path: Path | str, batch_size: int = BACKFILL_BATCH_SIZE) -> int:
    """Store digests and previews for boundaries missing them, in batches.

    Returns the previews filled. Rows whose geometry cannot even be kept as is stay NULL
    for the request fallback.
    """
    db.ensure_schema(db_path)
    _backfill_missing_digests(db_path, batch_size)
    return _backfill_missing_previews(db_path, batch_size)


def _backfill_missing_digests(db_path: Path | str, batch_size: int) -> int:
    """Store the geometry revision of rows missing it; returns the digests filled."""
    total = db.count_boundaries_missing_digest(db_path)
    done = 0
    while True:
        batch = db.fetch_boundaries_missing_digest(db_path, batch_size)
        if not batch:
            break
        digests = [
            (record["id"], db.geometry_digest(record["geom_geojson"]))
            for record in batch
            if isinstance(record["geom_geojson"], str)
        ]
        done += db.set_boundary_digests(db_path, digests)
        print(f"area digests: {done}/{total} stored")
    return done


def _backfill_missing_previews(db_path: Path | str, batch_size: int) -> int:
    """Store previews for boundaries missing them; returns the previews filled."""
    total = db.count_boundaries_missing_preview(db_path)
    done, skipped = 0, 0
    while True:
        batch = db.fetch_boundaries_missing_preview(db_path, batch_size, skipped)
        if not batch:
            break
        previews = [
            (record["id"], preview, record["geom_digest"], _digest_for_backfill(record))
            for record in batch
            if (preview := _preview_for_backfill(record)) is not None
        ]
        done += db.set_boundary_previews(db_path, previews)
        skipped += len(batch) - len(previews)
        print(f"area previews: {done}/{total} stored")
    return done


def _digest_for_backfill(record: db.Record) -> str:
    """The geometry revision of a fetched row, computed from its stored text."""
    if isinstance(record["geom_geojson"], str):
        return db.geometry_digest(record["geom_geojson"])
    return record["geom_digest"] or ""


def _preview_for_backfill(record: db.Record) -> str | None:
    """The preview GeoJSON of a boundary row missing it, or None when its geometry is broken."""
    try:
        geometry = shape(json.loads(record["geom_geojson"]))
    except Exception:
        try:
            json.loads(record["geom_geojson"])
        except ValueError:
            print(f"skipping {record['id']}: stored geometry is not JSON")
            return None
        return record["geom_geojson"]
    bbox = (record["bbox_w"], record["bbox_s"], record["bbox_e"], record["bbox_n"])
    return json.dumps(display_preview(geometry, bbox))


def build_tile_index(product: str, path: Path | str) -> int:
    """Write the bitmap of the product's existing tiles (TERRAIN_PRODUCTS index) from its list."""
    exists = np.zeros(TILE_GRID_SHAPE, bool)
    for lat, lon in _listed_tiles(product):
        exists[lat + TILE_ROW_OFFSET_DEG, lon + TILE_COL_OFFSET_DEG] = True
    Path(path).write_bytes(np.packbits(exists).tobytes())
    return int(exists.sum())


def _listed_tiles(product: str) -> Iterator[tuple[int, int]]:
    """(lat, lon) of the south-west corner of each tile named in the product's bucket list."""
    with urllib.request.urlopen(TILE_LIST_URLS[product], timeout=DOWNLOAD_TIMEOUT_SECS) as response:
        lines = response.read().decode().splitlines()
    tile_code = TERRAIN_PRODUCTS[product].tile_code
    pattern = rf"Copernicus_DSM_COG_{tile_code}_([NS])(\d+)_00_([EW])(\d+)_00_DEM"
    matches = (re.match(pattern, line) for line in lines)
    for match in filter(None, matches):
        north_or_south, lat_digits, east_or_west, lon_digits = match.groups()
        lat = int(lat_digits) if north_or_south == "N" else -int(lat_digits)
        lon = int(lon_digits) if east_or_west == "E" else -int(lon_digits)
        yield lat, lon


def build_worldcover_index(path: Path | str) -> int:
    """Write the bitmap of the existing ESA WorldCover tiles from the product's grid file."""
    exists = np.zeros(WORLDCOVER_GRID_SHAPE, bool)
    for lat, lon in _worldcover_grid_tiles():
        exists[index_cell(lat, lon)] = True
    Path(path).write_bytes(np.packbits(exists).tobytes())
    return int(exists.sum())


def _worldcover_grid_tiles() -> Iterator[tuple[int, int]]:
    """(lat, lon) of the south-west corner of each tile in the product's grid file."""
    with urllib.request.urlopen(WORLDCOVER_GRID_URL, timeout=DOWNLOAD_TIMEOUT_SECS) as response:
        grid = json.load(response)
    for feature in grid["features"]:
        match = re.fullmatch(r"([NS])(\d+)([EW])(\d+)", feature["properties"]["ll_tile"])
        north_or_south, lat_digits, east_or_west, lon_digits = match.groups()
        lat = int(lat_digits) if north_or_south == "N" else -int(lat_digits)
        lon = int(lon_digits) if east_or_west == "E" else -int(lon_digits)
        yield lat, lon


if __name__ == "__main__":
    main()
