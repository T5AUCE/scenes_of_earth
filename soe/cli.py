"""Command line: `python -m soe.cli import-boundaries --cgaz DIR --ucdb FILE`."""
import argparse
import logging
import os
import re
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from . import db
from .boundary_import import import_cgaz, import_ucdb
from .sources import (
    GLO90_TILE_INDEX,
    TILE_COL_OFFSET_DEG,
    TILE_GRID_SHAPE,
    TILE_ROW_OFFSET_DEG,
)

GLO90_TILE_LIST = "https://copernicus-dem-90m.s3.amazonaws.com/tileList.txt"
GLO90_TILE_PATTERN = r"Copernicus_DSM_COG_30_([NS])(\d+)_00_([EW])(\d+)_00_DEM"
DOWNLOAD_TIMEOUT_SECS = 60


def main(argv: list[str] | None = None) -> None:
    """Run the `glo90-index` or `import-boundaries` command given in `argv`."""
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command == "glo90-index":
        print("GLO-90 tiles:", build_glo90_index(GLO90_TILE_INDEX))
        return

    if not (args.cgaz or args.ucdb):
        parser.error("give --cgaz and/or --ucdb")

    logging.basicConfig(level=logging.INFO)
    db.init(args.db)
    if args.cgaz:
        print("CGAZ rows:", import_cgaz(args.db, args.cgaz))
    if args.ucdb:
        print("UCDB city rows:", import_ucdb(args.db, args.ucdb))


def _build_parser() -> argparse.ArgumentParser:
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
    return parser


def build_glo90_index(path: Path | str) -> int:
    """Write the bitmap of GLO-90 tiles that exist (GLO90_TILE_INDEX) from the bucket list."""
    exists = np.zeros(TILE_GRID_SHAPE, bool)
    for lat, lon in _listed_tiles():
        exists[lat + TILE_ROW_OFFSET_DEG, lon + TILE_COL_OFFSET_DEG] = True
    Path(path).write_bytes(np.packbits(exists).tobytes())
    return int(exists.sum())


def _listed_tiles() -> Iterator[tuple[int, int]]:
    """(lat, lon) of the south-west corner of each tile named in the GLO-90 bucket list."""
    with urllib.request.urlopen(GLO90_TILE_LIST, timeout=DOWNLOAD_TIMEOUT_SECS) as response:
        lines = response.read().decode().splitlines()
    matches = (re.match(GLO90_TILE_PATTERN, line) for line in lines)
    for match in filter(None, matches):
        north_or_south, lat_digits, east_or_west, lon_digits = match.groups()
        lat = int(lat_digits) if north_or_south == "N" else -int(lat_digits)
        lon = int(lon_digits) if east_or_west == "E" else -int(lon_digits)
        yield lat, lon


if __name__ == "__main__":
    main()
