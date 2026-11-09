"""Build the regional geology COGs that patch the global rock-age and rock-type maps.

Each source is ingested once to its own uint8 class COGs on the existing geology grids (age at
1/120 degrees, type at 1/480 degrees), with 0 for no data. The per-source builders below fetch
the published archives, keep only the needed records, classify them through the name tables in
`soe.ingest.geology_classification` and rasterise the units. Unknown age or rock names fail the
ingest with the full unmapped list before any COG is published.
"""
import logging
import os
import shutil
import struct
import tempfile
import urllib.request
import zipfile
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import rasterio
import shapely
from rasterio.features import rasterize
from rasterio.io import DatasetReader
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject, transform_bounds
from shapely import unary_union
from shapely.affinity import translate
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry

from ..geology_age import GEOLOGY_AGE_RES_DEG
from ..geology_regional import (
    ALASKA_AGE_FILE,
    ALASKA_TYPE_FILE,
    CANADA_AGE_FILE,
    CANADA_TYPE_FILE,
    EGDI_TYPE_FILE,
    GMNA_AGE_FILE,
    GMNA_TYPE_FILE,
    IGME_AGE_FILE,
    IGME_TYPE_FILE,
    SGMC_AGE_FILE,
    SGMC_TYPE_FILE,
)
from ..geology_type import LITHOLOGY_RES_DEG
from ..sources.grid import Bbox
from .cog import BLOCK_PX, publish_cog, write_tiled_raster
from .cubes import DOWNLOADS_DIR
from .geology_classification import (
    canada_age_batch,
    canada_type_batch,
    egdi_type_batch,
    gmna_age_batch,
    gmna_type_batch,
    igme_age_batch,
    igme_type_batch,
    sgmc_age_batch,
    sgmc_type_batch,
    sim3340_age_batch,
    sim3340_type_batch,
)

if TYPE_CHECKING:
    import geopandas as gpd

log = logging.getLogger(__name__)

CANADA_URL = (
    "https://ftp.maps.canada.ca/pub/nrcan_rncan/Geology_Geologie/"
    "bedrock_geology_geologie_du_socle/geological_map_canada_wheeler.gdb.zip"
)
CANADA_DIR = "canada-5m"
CANADA_GDB = "geological_map_canada_wheeler.gdb"
CANADA_LAYER = "Roxcan"
CANADA_SEGMENT_M = 20_000

IGME_URL = "https://download.bgr.de/bgr/Geologie/IGME5000/shp/IGME5000.zip"
IGME_DIR = "igme5000"
IGME_SHAPE = "europe/data/IGME5000_europeEPSG3034shp_geology_poly_v01.shp"
IGME_SEGMENT_M = 20_000

EGDI_URL = (
    "https://zenodo.org/api/records/12607973/files/"
    "EGDI_GE_GeologicUnit_EN_1M_Surface_LithologyPolygon_v2_250m_epsg.3035.tif/content"
)
EGDI_DIR = "egdi"
EGDI_FILE = "egdi_surface_lithology_250m_epsg3035.tif"

SGMC_URL = (
    "https://www.sciencebase.gov/catalog/file/get/5888bf4fe4b05ccb964bab9d"
    "?f=__disk__24%2Ff6%2Fe1%2F24f6e139c181fd9fe43df2aaf7f50b1c5b3b6297"
)
SGMC_DIR = "sgmc"
SGMC_ZIP = "USGS_SGMC_Geodatabase.zip"
SGMC_GDB = "USGS_SGMC_Geodatabase/USGS_StateGeologicMapCompilation_ver1.1.gdb"
SGMC_LAYER = "SGMC_Geology"
SGMC_LITHOLOGY_LAYER = "Lithology"

SIM3340_URL = "https://pubs.usgs.gov/sim/3340/sim3340_gdb.zip"
SIM3340_DIR = "sim3340"
SIM3340_GDB = "sim3340_gdb/AKgeol_web_gdb/geologic_data/AKStategeol.gdb"
SIM3340_LAYER = "AKStategeol_poly"
SIM3340_AGE_LAYER = "nsaage"
SIM3340_LITHOLOGY_LAYER = "nsalith"

GMNA_URL = "https://ngmdb.usgs.gov/gis_files/gmna_shapefiles.zip"
GMNA_DIR = "gmna"
GMNA_SHAPE = "GMNA_SHAPES/Geologic_units.shp"
GMNA_SEGMENT_M = 20_000

TILED_SEGMENT_M = 20_000  # longest polygon edge kept before reprojection, so edges bend right
ANTIMERIDIAN_WRAP_DEG = 180  # a reprojected polygon wider than this crossed the antimeridian
TILE_QUERY_PAD_M = 10_000  # so a curved tile edge in the source projection never drops a polygon

DOWNLOAD_TIMEOUT_SECS = 600
DOWNLOAD_CHUNK_BYTES = 1 << 20
USER_AGENT = "Mozilla/5.0 (Scenes of Earth ingest)"

SOURCE_IDS = (
    "canada_5m",
    "us_sgmc",
    "europe_igme5000",
    "europe_egdi",
    "alaska_sim3340",
    "north_america_gmna",
)


def ingest_geology_regional(
    cubes_dir: Path | str,
    source_id: str,
    archive_path: Path | str | None = None,
) -> list[Path]:
    """Publish the COGs of one regional source and return their paths."""
    if source_id not in SOURCE_IDS:
        raise ValueError(f"unknown regional source: {source_id}")
    builders = {
        "canada_5m": ingest_canada,
        "europe_igme5000": ingest_igme,
        "europe_egdi": ingest_egdi,
        "us_sgmc": ingest_sgmc,
        "alaska_sim3340": ingest_sim3340,
        "north_america_gmna": ingest_gmna,
    }
    return builders[source_id](Path(cubes_dir), archive_path)


def ingest_canada(cubes_dir: Path, archive_path: Path | str | None = None) -> list[Path]:
    """Publish the Canada age and type COGs from the GSC 1:5M geodatabase."""
    folder = cubes_dir / DOWNLOADS_DIR / CANADA_DIR
    gdb = _ensure_member(CANADA_URL, folder, CANADA_GDB, archive_path)
    log.info("Classifying the Canada map units")
    classified = _read_canada_units(gdb)
    age_cog = cubes_dir / CANADA_AGE_FILE
    type_cog = cubes_dir / CANADA_TYPE_FILE
    return [
        _publish_units(classified, "age", GEOLOGY_AGE_RES_DEG, age_cog, "canada-5m"),
        _publish_units(classified, "type", LITHOLOGY_RES_DEG, type_cog, "canada-5m"),
    ]


def ingest_igme(cubes_dir: Path, archive_path: Path | str | None = None) -> list[Path]:
    """Publish the IGME5000 age and type COGs from the BGR shapefile."""
    folder = cubes_dir / DOWNLOADS_DIR / IGME_DIR
    shape = _ensure_member(IGME_URL, folder, IGME_SHAPE, archive_path)
    log.info("Classifying the IGME5000 units")
    classified = _read_igme_units(shape)
    age_cog = cubes_dir / IGME_AGE_FILE
    type_cog = cubes_dir / IGME_TYPE_FILE
    return [
        _publish_units(classified, "age", GEOLOGY_AGE_RES_DEG, age_cog, "igme5000"),
        _publish_units(classified, "type", LITHOLOGY_RES_DEG, type_cog, "igme5000"),
    ]


def ingest_egdi(cubes_dir: Path, archive_path: Path | str | None = None) -> list[Path]:
    """Publish the Europe type COG from the EGDI 250 m surface lithology raster."""
    folder = cubes_dir / DOWNLOADS_DIR / EGDI_DIR
    source = _ensure_file(EGDI_URL, folder / EGDI_FILE, archive_path)
    log.info("Reprojecting the EGDI raster")
    cog = cubes_dir / EGDI_TYPE_FILE
    publish_cog(partial(_write_egdi_raster, source), "egdi", cog)
    return [cog]


def ingest_sgmc(cubes_dir: Path, archive_path: Path | str | None = None) -> list[Path]:
    """Publish the SGMC age and type COGs from the USGS geodatabase.

    The polygons carry their age range, and the lithology comes from the first Major row of
    the Lithology table per unit. A direct range read of the members is impractical because
    the query-string download URL breaks GDAL's remote paths, so the geodatabase zip is
    downloaded once as the task allows.
    """
    folder = cubes_dir / DOWNLOADS_DIR / SGMC_DIR
    gdb = _ensure_member(SGMC_URL, folder, SGMC_GDB, archive_path, archive_name=SGMC_ZIP)
    log.info("Classifying the SGMC units")
    return [
        _publish_sgmc(gdb, "age", GEOLOGY_AGE_RES_DEG, cubes_dir / SGMC_AGE_FILE),
        _publish_sgmc(gdb, "type", LITHOLOGY_RES_DEG, cubes_dir / SGMC_TYPE_FILE),
    ]


def ingest_sim3340(cubes_dir: Path, archive_path: Path | str | None = None) -> list[Path]:
    """Publish the Alaska age and type COGs from the USGS SIM 3340 geodatabase.

    The polygons carry a unit class whose age range and first Major lithology come from the
    nsaage and nsalith tables, like SGMC. All names are classified before any COG is published.
    """
    folder = cubes_dir / DOWNLOADS_DIR / SIM3340_DIR
    gdb = _ensure_member(SIM3340_URL, folder, SIM3340_GDB, archive_path)
    log.info("Classifying the SIM 3340 units")
    ages = _read_sim3340_ages(gdb)
    types = _read_sim3340_types(gdb)
    return [
        _publish_by_key(
            gdb,
            SIM3340_LAYER,
            "NSACLASS",
            values,
            res_deg,
            cubes_dir / file,
            "sim3340",
        )
        for values, res_deg, file in (
            (ages, GEOLOGY_AGE_RES_DEG, ALASKA_AGE_FILE),
            (types, LITHOLOGY_RES_DEG, ALASKA_TYPE_FILE),
        )
    ]


def ingest_gmna(cubes_dir: Path, archive_path: Path | str | None = None) -> list[Path]:
    """Publish the GMNA age and type COGs from the USGS shapefile of geologic units.

    Seafloor units (an asterisk ends their abbreviation) stay out like the Canada offshore
    polygons, because the global base maps hold no ocean data. All names are classified
    before any COG is published.
    """
    folder = cubes_dir / DOWNLOADS_DIR / GMNA_DIR
    shape = _ensure_member(GMNA_URL, folder, GMNA_SHAPE, archive_path)
    log.info("Classifying the GMNA units")
    classified = _read_gmna_units(shape)
    age_cog = cubes_dir / GMNA_AGE_FILE
    type_cog = cubes_dir / GMNA_TYPE_FILE
    return [
        _publish_units(classified, "age", GEOLOGY_AGE_RES_DEG, age_cog, "gmna"),
        _publish_units(classified, "type", LITHOLOGY_RES_DEG, type_cog, "gmna"),
    ]


def _ensure_file(url: str, target: Path, archive_path: Path | str | None) -> Path:
    """Return the downloaded file, fetching it or copying the local archive instead."""
    if archive_path is not None:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(archive_path, target)
        return target
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        _download(url, target)
    return target


def _ensure_member(
    url: str,
    folder: Path,
    member: str,
    archive_path: Path | str | None,
    archive_name: str | None = None,
) -> Path:
    """Return the extracted archive member, fetching and unpacking unless it is present."""
    target = folder / member
    if target.exists():
        return target
    folder.mkdir(parents=True, exist_ok=True)
    if archive_path is not None and Path(archive_path).is_file():
        archive_file = Path(archive_path)
    elif archive_path is not None and Path(archive_path).is_dir():
        return Path(archive_path) / member
    else:
        archive_file = folder / (archive_name or Path(url).name.split("?")[0])
        if not archive_file.exists():
            _download(url, archive_file)
    with zipfile.ZipFile(archive_file) as archive:
        archive.extractall(folder)
    return target


def _download(url: str, target: Path) -> None:
    """Fetch url onto target, leaving no partial file when the download is interrupted."""
    descriptor, temp_name = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with os.fdopen(descriptor, "wb") as file:
            with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECS) as response:
                shutil.copyfileobj(response, file, DOWNLOAD_CHUNK_BYTES)
        os.replace(temp_name, target)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _read_canada_units(gdb_path: Path) -> "object":
    """Return the onshore units with the class of their age range and rock type."""
    import geopandas as gpd
    import pyogrio

    frame = pyogrio.read_dataframe(
        gdb_path,
        layer=CANADA_LAYER,
        columns=["DOMAIN", "ERA", "PERIOD", "EPOCH", "RXTP", "SUBRXTP"],
    )
    # Offshore polygons carry no onshore geology, so they stay out and become no data.
    frame = frame[frame["DOMAIN"] != "offshore"].reset_index(drop=True)
    records = frame[["ERA", "PERIOD", "EPOCH"]].fillna(" ")
    ages = canada_age_batch([tuple(row) for row in records.itertuples(index=False)])
    rocks = frame[["RXTP", "SUBRXTP"]].fillna(" ")
    types = canada_type_batch([tuple(row) for row in rocks.itertuples(index=False)])
    frame["age"] = [value or 0 for value in ages]
    frame["type"] = [value or 0 for value in types]
    frame.geometry = frame.geometry.segmentize(CANADA_SEGMENT_M)
    return gpd.GeoDataFrame(frame.to_crs(4326))


def _read_igme_units(shape_path: Path) -> "object":
    """Return the IGME5000 units with their age and rock-type classes."""
    import geopandas as gpd
    import pyogrio

    frame = pyogrio.read_dataframe(
        shape_path,
        columns=["AgeName", "Portr_Petr", "Portr_Pe_1", "Portr_IGNE", "Portr_MARI", "Portr_IceO"],
    )
    ages = igme_age_batch(frame["AgeName"].fillna("unknown").tolist())
    # Ice-only units name their cover in the IceO field instead of the petrography one.
    petr = frame["Portr_Petr"].where(frame["Portr_Petr"].notna(), frame["Portr_IceO"])
    records = list(zip(petr, frame["Portr_Pe_1"], frame["Portr_IGNE"], frame["Portr_MARI"]))

    def cleaned(value: object) -> str | None:
        return value if isinstance(value, str) else None

    types = igme_type_batch(
        [
            (cleaned(first), cleaned(secondary), cleaned(igne), cleaned(mari))
            for first, secondary, igne, mari in records
        ],
    )
    frame["age"] = [value or 0 for value in ages]
    frame["type"] = [value or 0 for value in types]
    frame.geometry = frame.geometry.segmentize(IGME_SEGMENT_M)
    return gpd.GeoDataFrame(frame.to_crs(4326))


def _read_gmna_units(shape_path: Path) -> "object":
    """Return the onshore GMNA units with the class of their age range and rock type."""
    import geopandas as gpd
    import pyogrio
    from pyogrio.raw import read as read_raw

    attributes = pyogrio.read_dataframe(
        shape_path,
        columns=["UNIT_ABBRE", "ROCKTYPE", "LITHOLOGY", "MIN_AGE", "MAX_AGE"],
        read_geometry=False,
    )
    onshore = ~attributes["UNIT_ABBRE"].fillna("").str.endswith("*")
    frame = attributes[onshore].reset_index(drop=True)
    meta, _, wkbs, _ = read_raw(shape_path, columns=["UNIT_ABBRE"])
    geometries = [_gmna_geometry(wkb) for wkb in wkbs]
    frame = gpd.GeoDataFrame(
        frame,
        geometry=[geometry for geometry, keep in zip(geometries, onshore) if keep],
        crs=meta["crs"],
    )
    pairs = list(zip(frame["MIN_AGE"].fillna(""), frame["MAX_AGE"].fillna("")))
    ages = gmna_age_batch(pairs)
    rocks = list(zip(frame["ROCKTYPE"].fillna(""), frame["LITHOLOGY"].fillna("")))
    types = gmna_type_batch(rocks)
    frame["age"] = [value or 0 for value in ages]
    frame["type"] = [value or 0 for value in types]
    frame.geometry = frame.geometry.segmentize(GMNA_SEGMENT_M)
    reprojected = gpd.GeoDataFrame(frame.to_crs(4326))
    # Aleutian polygons wrap across the dateline in the transverse mercator source.
    reprojected.geometry = gpd.GeoSeries(
        _world_geometries(reprojected.geometry),
        index=reprojected.index,
        crs=reprojected.crs,
    )
    return reprojected


def _gmna_geometry(wkb: bytes | None) -> BaseGeometry | None:
    """Return the shape of one GMNA WKB, closing rings the archive left open.

    A few polygons end a ring without repeating its first point, which strict readers refuse.
    """
    if wkb is None:
        return None
    raw = bytes(wkb)
    try:
        return shapely.from_wkb(raw)
    except Exception:
        return shapely.from_wkb(_close_wkb_rings(raw))


def _close_wkb_rings(data: bytes) -> bytes:
    """Return the WKB with every unclosed polygon ring closed by its first point."""
    order = "<" if data[0] == 1 else ">"
    kind = struct.unpack_from(order + "I", data, 1)[0]
    if kind == 3:
        fixed, _ = _close_polygon_rings(data, 5, order)
        return data[:5] + fixed
    if kind == 6:
        count = struct.unpack_from(order + "I", data, 5)[0]
        offset = 9
        parts = [data[:9]]
        for _ in range(count):
            part_order = "<" if data[offset] == 1 else ">"
            head = data[offset : offset + 5]
            fixed, offset = _close_polygon_rings(data, offset + 5, part_order)
            parts.append(head + fixed)
        return b"".join(parts)
    return data


def _close_polygon_rings(data: bytes, offset: int, order: str) -> tuple[bytes, int]:
    """Return the WKB polygon at offset with closed rings and the offset past it."""
    rings = struct.unpack_from(order + "I", data, offset)[0]
    offset += 4
    parts = [struct.pack(order + "I", rings)]
    for _ in range(rings):
        points = struct.unpack_from(order + "I", data, offset)[0]
        offset += 4
        coords = data[offset : offset + points * 16]
        offset += points * 16
        if coords[:16] != coords[-16:]:
            coords += coords[:16]
            points += 1
        parts.append(struct.pack(order + "I", points))
        parts.append(coords)
    return b"".join(parts), offset


def _read_sgmc_lithology(gdb_path: Path) -> dict[str, int]:
    """Return the rock-type class of each SGMC unit link."""
    hierarchies = _first_major_hierarchies(
        gdb_path,
        SGMC_LITHOLOGY_LAYER,
        "UNIT_LINK",
        "LITH_RANK",
    )
    values = sgmc_type_batch(list(hierarchies.values()))
    return dict(zip(hierarchies, values))


def _read_sim3340_types(gdb_path: Path) -> dict[int, int]:
    """Return the rock-type class of each SIM 3340 unit class, 0 where the base map fills in."""
    hierarchies = _first_major_hierarchies(
        gdb_path,
        SIM3340_LITHOLOGY_LAYER,
        "NSACLASS",
        "RANK",
    )
    values = sim3340_type_batch(list(hierarchies.values()))
    return {unit: value or 0 for unit, value in zip(hierarchies, values)}


def _read_sim3340_ages(gdb_path: Path) -> dict[int, int]:
    """Return the age class of each SIM 3340 unit class, 0 where it has no age."""
    import pyogrio

    table = pyogrio.read_dataframe(
        gdb_path,
        layer=SIM3340_AGE_LAYER,
        columns=["NSACLASS", "FULL_MIN", "FULL_MAX"],
        read_geometry=False,
    )
    pairs = list(zip(table["FULL_MIN"].fillna(""), table["FULL_MAX"].fillna("")))
    values = sim3340_age_batch(pairs)
    return {unit: value or 0 for unit, value in zip(table["NSACLASS"], values)}


def _first_major_hierarchies(
    gdb_path: Path,
    layer: str,
    link_column: str,
    rank_column: str,
) -> dict:
    """Return the LITH1 to LITH5 hierarchy of each unit link of a lithology table.

    Each unit takes the hierarchy of its first Major row, or its first Indeterminate-major
    row when it has no Major one. Table order decides, so the file order is kept.
    """
    import pyogrio

    table = pyogrio.read_dataframe(gdb_path, layer=layer, read_geometry=False)
    hierarchies: dict = {}
    fallback: dict = {}
    for _, row in table.iterrows():
        link = row[link_column]
        hierarchy = (
            _cell(row["LITH1"]),
            _cell(row["LITH2"]),
            _cell(row["LITH3"]),
            _cell(row["LITH4"]),
            _cell(row["LITH5"]),
        )
        if row[rank_column] == "Major" and link not in hierarchies:
            hierarchies[link] = hierarchy
        elif row[rank_column] == "Indeterminate, major" and link not in fallback:
            fallback[link] = hierarchy
    for link, hierarchy in fallback.items():
        hierarchies.setdefault(link, hierarchy)
    return hierarchies


def _cell(value: object) -> str:
    return value if isinstance(value, str) else ""


def _publish_units(frame: object, kind: str, res_deg: float, cog_path: Path, tag: str) -> Path:
    """Write the COG of one kind ("age" or "type"), replacing cog_path only when complete."""
    import geopandas as gpd

    polygons: gpd.GeoDataFrame = frame  # type: ignore[assignment]
    publish_cog(
        lambda raster: write_tiled_raster(
            raster,
            res_deg,
            partial(_rasterize_units, polygons, kind),
        ),
        tag,
        cog_path,
    )
    return cog_path


def _publish_sgmc(gdb_path: Path, kind: str, res_deg: float, cog_path: Path) -> Path:
    """Write an SGMC COG, validating all age and rock names first.

    The names come from attribute-only reads, so an unknown name fails before any COG is
    published.
    """
    import pyogrio

    attributes = pyogrio.read_dataframe(
        gdb_path,
        layer=SGMC_LAYER,
        columns=["UNIT_LINK", "AGE_MIN", "AGE_MAX"],
        read_geometry=False,
    )
    pairs = list(zip(attributes["AGE_MIN"].fillna(""), attributes["AGE_MAX"].fillna("")))
    ages = sgmc_age_batch(pairs)
    if kind == "age":
        values = dict(zip(attributes["UNIT_LINK"], [value or 0 for value in ages]))
    else:
        lithology = _read_sgmc_lithology(gdb_path)
        values = {link: (value or 0) for link, value in lithology.items()}
    return _publish_by_key(gdb_path, SGMC_LAYER, "UNIT_LINK", values, res_deg, cog_path, "us-sgmc")


def _publish_by_key(
    gdb_path: Path,
    layer: str,
    key_column: str,
    values: dict,
    res_deg: float,
    cog_path: Path,
    tag: str,
) -> Path:
    """Write a COG tile by tile, so hundreds of thousands of polygons never sit in memory.

    Each polygon takes the class that `values` gives its key, and keys without one stay no data.
    """
    import pyogrio
    from pyproj import Transformer

    native_crs = pyogrio.read_info(gdb_path, layer=layer)["crs"]
    transformer = Transformer.from_crs(4326, native_crs, always_xy=True)

    def rasterize_tile(bounds: Bbox, transform: Affine, shape: tuple[int, int]) -> np.ndarray:
        lons, lats = np.meshgrid(
            np.linspace(bounds[0], bounds[2], 9),
            np.linspace(bounds[1], bounds[3], 9),
        )
        xs, ys = transformer.transform(lons, lats)
        tile = pyogrio.read_dataframe(
            gdb_path,
            layer=layer,
            columns=[key_column],
            bbox=(
                xs.min() - TILE_QUERY_PAD_M,
                ys.min() - TILE_QUERY_PAD_M,
                xs.max() + TILE_QUERY_PAD_M,
                ys.max() + TILE_QUERY_PAD_M,
            ),
        )
        if tile.empty:
            return np.zeros(shape, "uint8")
        tile["value"] = [values.get(key, 0) for key in tile[key_column]]
        classed = tile[tile["value"] != 0]
        if classed.empty:
            return np.zeros(shape, "uint8")
        classed.geometry = classed.geometry.segmentize(TILED_SEGMENT_M)
        return rasterize(
            zip(_world_geometries(classed.geometry.to_crs(4326)), classed["value"]),
            out_shape=shape,
            transform=transform,
            dtype="uint8",
        )

    publish_cog(
        lambda raster: write_tiled_raster(raster, res_deg, rasterize_tile),
        tag,
        cog_path,
    )
    return cog_path


def _world_geometries(geometries: "gpd.GeoSeries") -> list[BaseGeometry]:
    """Return the geometries with each one that wraps across 180 degrees split into its two sides.

    A polygon over the antimeridian comes out of the reprojection spanning the whole world,
    which would paint a band of cells instead of a few islands.
    """
    widths = geometries.bounds["maxx"] - geometries.bounds["minx"]
    return [
        _split_at_antimeridian(geometry) if width > ANTIMERIDIAN_WRAP_DEG else geometry
        for geometry, width in zip(geometries, widths)
    ]


def _split_at_antimeridian(geometry: BaseGeometry) -> BaseGeometry:
    """Return the geometry cut at 180 degrees, with the part east of it back on the -180 side."""
    continuous = shapely.transform(geometry, lambda xy: np.column_stack((xy[:, 0] % 360, xy[:, 1])))
    west = continuous.intersection(box(0, -90, 180, 90))
    east = translate(continuous.intersection(box(180, -90, 360, 90)), xoff=-360)
    return unary_union([west, east])


def _rasterize_units(
    frame: object,
    kind: str,
    bounds: Bbox,
    transform: Affine,
    shape: tuple[int, int],
) -> np.ndarray:
    """Return the class of each tile cell, 0 where no unit covers it."""
    import geopandas as gpd

    polygons: gpd.GeoDataFrame = frame  # type: ignore[assignment]
    nearby = polygons.iloc[polygons.sindex.query(box(*bounds), predicate="intersects")]
    if nearby.empty:
        return np.zeros(shape, "uint8")
    classed = nearby[nearby[kind] != 0]
    if classed.empty:
        return np.zeros(shape, "uint8")
    return rasterize(
        zip(classed.geometry, classed[kind]),
        out_shape=shape,
        transform=transform,
        dtype="uint8",
    )


def _write_egdi_raster(source_path: Path | str, raster_path: Path) -> None:
    """Reproject the EGDI INSPIRE raster onto the type grid with mode resampling.

    Classes are mapped before resampling, so each output cell takes the most common GLiM
    class around it rather than the most common INSPIRE code.
    """
    classes_path = raster_path.with_suffix(".classes.tif")
    try:
        with rasterio.open(source_path) as source:
            footprint = transform_bounds(source.crs, "EPSG:4326", *source.bounds)
            _write_egdi_classes(source, classes_path)

        with rasterio.open(classes_path) as classes:
            write_tiled_raster(
                raster_path,
                LITHOLOGY_RES_DEG,
                partial(_reproject_egdi_tile, classes, footprint),
            )
    finally:
        classes_path.unlink(missing_ok=True)


def _reproject_egdi_tile(
    classes: DatasetReader,
    footprint: Bbox,
    bounds: Bbox,
    transform: Affine,
    shape: tuple[int, int],
) -> np.ndarray:
    """Return the most common class of the source cells under each cell of the tile."""
    tile = np.zeros(shape, "uint8")
    west, south, east, north = footprint
    if bounds[0] >= east or bounds[2] <= west or bounds[1] >= north or bounds[3] <= south:
        return tile

    reproject(
        rasterio.band(classes, 1),
        tile,
        dst_transform=transform,
        dst_crs="EPSG:4326",
        src_nodata=0,
        dst_nodata=0,
        resampling=Resampling.mode,
    )
    return tile


def _write_egdi_classes(source: DatasetReader, classes_path: Path) -> None:
    """Write the GLiM class of every source cell, block by block because the raster is huge."""
    lookup = _egdi_lookup(source)
    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "count": 1,
        "crs": source.crs,
        "width": source.width,
        "height": source.height,
        "transform": source.transform,
        "nodata": 0,
        "tiled": True,
        "blockxsize": BLOCK_PX,
        "blockysize": BLOCK_PX,
        "compress": "zstd",
        "BIGTIFF": "IF_SAFER",
    }
    with rasterio.open(classes_path, "w", **profile) as classes:
        for _, window in source.block_windows(1):
            values = source.read(1, window=window)
            indexes = np.where(values == source.nodata, 0, values).astype(int)
            classes.write(lookup[indexes], 1, window=window)


def _egdi_lookup(source: DatasetReader) -> np.ndarray:
    """Return the GLiM class of each EGDI value as an array indexed by value, 0 for no data."""
    present: set[int] = set()
    for _, window in source.block_windows(1):
        present.update(np.unique(source.read(1, window=window)).astype(int).tolist())
    present.discard(int(source.nodata))
    values = sorted(present)
    lookup = np.zeros(values[-1] + 1, "uint8")
    for value, cls in zip(values, egdi_type_batch(values)):
        lookup[value] = cls or 0
    return lookup
