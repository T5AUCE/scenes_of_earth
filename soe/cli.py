"""Command line: `python -m soe.cli import-boundaries --cgaz DIR --ucdb FILE`. Needs the [import] extra."""
import argparse
import json
import logging
import os
import zipfile
from pathlib import Path

from . import db
from .areas import unwrap

CELL_DEG2 = 0.05 * 0.05
MIN_CITY_POP = 1_000_000
GLO90_TILE_LIST = "https://copernicus-dem-90m.s3.amazonaws.com/tileList.txt"
CGAZ_LEVELS = {0: "country", 1: "state", 2: "county"}


def _row(rid, level, name, parent, iso3, geom, source, licence):
    """One boundaries row: geometry simplified to 0.01 degrees, clipped to rain coverage (60S-60N)."""
    from shapely.geometry import box, mapping
    geom = geom.simplify(0.01, preserve_topology=True).intersection(box(-180, -60, 180, 60))
    if geom.is_empty:
        return None
    w, s, e, n = unwrap(geom).bounds  # a shape across 180 gets E > 180 instead of spanning the world
    return (rid, level, name, parent, iso3, w, s, e, n, max(1, round(geom.area / CELL_DEG2)),
            json.dumps(mapping(geom)), source, licence)


def build_glo90_index(path):
    """Write the bitmap of GLO-90 tiles that exist (soe/glo90_tiles.bin) from the bucket's tile list."""
    import re
    import urllib.request
    import numpy as np
    bits = np.zeros((180, 360), bool)
    with urllib.request.urlopen(GLO90_TILE_LIST, timeout=60) as r:
        for line in r.read().decode().splitlines():
            m = re.match(r"Copernicus_DSM_COG_30_([NS])(\d+)_00_([EW])(\d+)_00_DEM", line)
            if m:
                lat, lon = int(m[2]) * (1 if m[1] == "N" else -1), int(m[4]) * (1 if m[3] == "E" else -1)
                bits[lat + 90, lon + 180] = True
    Path(path).write_bytes(np.packbits(bits).tobytes())
    return int(bits.sum())


def import_cgaz(db_path, folder):
    """geoBoundaries CGAZ ADM0/1/2 GeoPackages (any file in `folder` containing 'ADM0', 'ADM1', 'ADM2')."""
    import geopandas as gpd
    frames = {}
    for lvl in (0, 1, 2):
        files = sorted(Path(folder).glob(f"*ADM{lvl}*.gpkg"))
        if not files:
            raise SystemExit(f"no *ADM{lvl}*.gpkg in {folder}")
        frames[lvl] = gpd.read_file(files[0]).to_crs(4326)
    countries = dict(zip(frames[0]["shapeGroup"], frames[0]["shapeName"]))
    adm2 = frames[2].copy()  # parent of a county is the state that contains its representative point
    adm2.geometry = adm2.representative_point()
    joined = adm2.sjoin(frames[1][["geometry", "shapeName"]], predicate="within", rsuffix="p")
    parents = joined.groupby(level=0)["shapeName_p"].first()
    rows = []
    for lvl, gdf in frames.items():
        for idx, r in gdf.iterrows():
            code = r["shapeGroup"]
            parent = {0: "", 1: countries.get(code, ""), 2: parents.get(idx, countries.get(code, ""))}[lvl]
            sid = r["shapeID"] if "shapeID" in gdf.columns else r["id"]  # ADM0 has no shapeID
            row = _row(f"cgaz:ADM{lvl}:{sid}", CGAZ_LEVELS[lvl], r["shapeName"], parent, code,
                       r.geometry, "geoBoundaries CGAZ", "CC BY 4.0")
            if row:
                rows.append(row)
    replaced = db.add_boundaries(db_path, "geoBoundaries CGAZ", rows)
    print(f"CGAZ: {replaced} duplicate ids replaced")
    return len(rows)


def import_ucdb(db_path, path):
    """GHSL UCDB R2024A (GeoPackage or zip of one): urban centres with population >= 1,000,000.

    Column names are matched by substring (UCN_MAI name, POP_TOT, CNT_GAD country) because the
    exact R2024A names could not be checked offline.
    """
    import geopandas as gpd
    path = str(path)
    if path.endswith(".zip"):
        inner = next(n for n in zipfile.ZipFile(path).namelist() if n.endswith(".gpkg"))
        path = f"zip://{path}!{inner}"
    gdf = gpd.read_file(path, layer=_ucdb_layer(path)).to_crs(4326)

    def col(part):
        """Column containing `part`; if several epochs exist (..._1975 ... _2025) take the latest."""
        return sorted(c for c in gdf.columns if part in c)[-1]

    name, pop, country = col("UCN_MAI"), col("POP_TOT"), col("CNT_GAD")
    rows = []
    for idx, r in gdf[gdf[pop] >= MIN_CITY_POP].iterrows():
        row = _row(f"ucdb:{idx}", "city", r[name], r[country], None, r.geometry, "GHSL UCDB R2024A", "CC BY 4.0")
        if row:
            rows.append(row)
    replaced = db.add_boundaries(db_path, "GHSL UCDB R2024A", rows)
    print(f"UCDB: {replaced} duplicate ids replaced")
    return len(rows)


def _ucdb_layer(path):
    import pyogrio
    layers = [l[0] for l in pyogrio.list_layers(path)]
    return next((l for l in layers if "GENERAL_CHARACTERISTICS" in l.upper()), layers[0])


def main(argv=None):
    ap = argparse.ArgumentParser(prog="soe")
    sub = ap.add_subparsers(dest="cmd", required=True)
    imp = sub.add_parser("import-boundaries", help="load CGAZ ADM0/1/2 and GHSL UCDB cities into SQLite")
    imp.add_argument("--cgaz", help="folder with the CGAZ ADM0/ADM1/ADM2 GeoPackages")
    imp.add_argument("--ucdb", help="GHS UCDB R2024A GeoPackage or zip")
    imp.add_argument("--db", default=os.environ.get("SOE_DB", "./data/soe.db"))
    sub.add_parser("glo90-index", help="rebuild soe/glo90_tiles.bin from the GLO-90 tile list (downloads 1 MB)")
    args = ap.parse_args(argv)
    if args.cmd == "glo90-index":
        print("GLO-90 tiles:", build_glo90_index(Path(__file__).parent / "glo90_tiles.bin"))
        return
    logging.basicConfig(level=logging.INFO)
    if not (args.cgaz or args.ucdb):
        ap.error("give --cgaz and/or --ucdb")
    db.init(args.db)
    if args.cgaz:
        print("CGAZ rows:", import_cgaz(args.db, args.cgaz))
    if args.ucdb:
        print("UCDB city rows:", import_ucdb(args.db, args.ucdb))


if __name__ == "__main__":
    main()
