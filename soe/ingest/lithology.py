"""Build the lithology COG that rock-type scenes read, from GLiM or the OpenLandMap map.

When the GLiM geodatabase has been downloaded, a one-off run rasterises its level 1 and 2 codes
onto the 1/480° grid between 60°S and 84°N. Otherwise it downloads the OpenLandMap map, a global
GeoTIFF in 1-row strips, crops it, turns water and the undefined class into no data (0), and
repairs its edge columns. Either way the result is a tiled COG whose overviews keep the most
common class and whose tags name the source.
"""
import logging
import os
import shutil
import tempfile
import urllib.request
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.windows import Window, from_bounds

from ..sources.grid import Bbox
from ..geology_type import (
    GLIM_SOURCE,
    GLIM_VALUES,
    LITHOLOGY_FILE,
    LITHOLOGY_RES_DEG,
    LITHOLOGY_SOURCE_TAG,
    OPENLANDMAP_SOURCE,
    UNDEFINED_CLASS,
    WATER_CLASS,
)
from .cog import (
    BLOCK_PX,
    NORTH_EDGE_DEG,
    SOUTH_EDGE_DEG,
    TILE_DEG,
    publish_cog,
    write_tiled_raster,
)
from .cubes import DOWNLOADS_DIR

if TYPE_CHECKING:
    import geopandas as gpd

LITHOLOGY_URL = (
    "https://zenodo.org/api/records/1464846/files/"
    "dtm_lithology_usgs.ecotapestry_c_250m_s0..0cm_2014_v1.0.tif/content"
)
DOWNLOAD_TIMEOUT_SECS = 60
DOWNLOAD_CHUNK_BYTES = 1 << 20
GLIM_DIR = "glim"  # in the downloads folder
GLIM_FILE = "LiMW_GIS 2015.gdb"
GLIM_CRS = "ESRI:54012"  # World Eckert IV
GLIM_CODE_CHARS = 4  # level 1 and level 2 of the 6-character Litho code
GLIM_SEGMENT_M = 20_000  # longest polygon edge kept before reprojection, so edges bend right
EDGE_REPAIR_WIDTH_DEG = 0.01  # half-width of the repaired band at each antimeridian edge
STRIP_ROWS = 512

log = logging.getLogger(__name__)


def ingest_lithology(cubes_dir: Path | str) -> Path:
    """Publish the lithology COG from GLiM when it is downloaded, else from OpenLandMap."""
    downloads = Path(cubes_dir) / DOWNLOADS_DIR
    published = Path(cubes_dir) / LITHOLOGY_FILE
    glim = downloads / GLIM_DIR / GLIM_FILE
    if glim.exists():
        log.info("Building the lithology COG from GLiM")
        build_glim_cog(glim, published)
        return published

    downloads.mkdir(parents=True, exist_ok=True)
    source = downloads / "lithology-source.tif"
    if not source.exists():
        log.info("Downloading the lithology map")
        _download(LITHOLOGY_URL, source)
    build_lithology_cog(source, published)
    return published


def build_lithology_cog(source_path: Path | str, cog_path: Path | str) -> None:
    """Write the cropped, cleaned COG of the OpenLandMap map, replacing cog_path when complete."""
    publish_cog(
        lambda cleaned: _write_cleaned(source_path, cleaned),
        OPENLANDMAP_SOURCE,
        Path(cog_path),
    )


def build_glim_cog(glim_path: Path | str, cog_path: Path | str) -> None:
    """Write the COG of GLiM level 1 and 2 classes, replacing cog_path only when complete."""
    publish_cog(
        lambda rasterised: _write_glim_raster(glim_path, rasterised),
        GLIM_SOURCE,
        Path(cog_path),
    )


def _download(url: str, target: Path) -> None:
    """Fetch url onto target, leaving no partial file when the download is interrupted."""
    descriptor, temp_name = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as file:
            with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECS) as response:
                shutil.copyfileobj(response, file, DOWNLOAD_CHUNK_BYTES)
        os.replace(temp_name, target)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _write_cleaned(source_path: Path | str, cleaned_path: Path) -> None:
    """Copy the 60°S-84°N rows strip by strip, clearing water and undefined cells to 0.

    The source columns within EDGE_REPAIR_WIDTH_DEG of each file edge are replaced by their
    nearest inner column, per row.
    """
    with rasterio.open(source_path) as source:
        crop = from_bounds(
            source.bounds.left,
            SOUTH_EDGE_DEG,
            source.bounds.right,
            NORTH_EDGE_DEG,
            source.transform,
        ).round_offsets().round_lengths()
        profile = {
            "driver": "GTiff",
            "dtype": "uint8",
            "count": 1,
            "nodata": 0,
            "crs": source.crs,
            "width": crop.width,
            "height": crop.height,
            "transform": source.window_transform(crop),
            "tiled": True,
            "blockxsize": BLOCK_PX,
            "blockysize": BLOCK_PX,
            "compress": "zstd",
            "BIGTIFF": "IF_SAFER",
        }
        with rasterio.open(cleaned_path, "w", **profile) as cleaned:
            edge_pixels = max(1, round(EDGE_REPAIR_WIDTH_DEG / abs(source.transform.a)))
            for row in range(0, crop.height, STRIP_ROWS):
                height = min(STRIP_ROWS, crop.height - row)
                source_strip = Window(crop.col_off, crop.row_off + row, crop.width, height)
                values = source.read(1, window=source_strip)
                values[np.isin(values, (UNDEFINED_CLASS, WATER_CLASS))] = 0
                _repair_edge_columns(values, edge_pixels)
                cleaned.write(values, 1, window=Window(0, row, crop.width, height))


def _repair_edge_columns(values: np.ndarray, edge_pixels: int) -> None:
    """Overwrite the bands at both file edges with their nearest inner column, per row.

    The crop spans the full longitude range, so the strip columns are the file columns. The
    source map holds bad pixel columns at its -180/+180 edges, so each band takes the values
    of the column just inside it.
    """
    if values.shape[1] <= 2 * edge_pixels:
        return
    values[:, :edge_pixels] = values[:, edge_pixels:edge_pixels + 1]
    values[:, -edge_pixels:] = values[:, -edge_pixels - 1:-edge_pixels]


def _write_glim_raster(glim_path: Path | str, raster_path: Path) -> None:
    """Rasterise the GLiM codes tile by tile onto the 60°S-84°N grid of LITHOLOGY_RES_DEG."""
    write_tiled_raster(
        raster_path,
        LITHOLOGY_RES_DEG,
        partial(_rasterize_glim_tile, glim_path),
    )


def _rasterize_glim_tile(
    glim_path: Path | str,
    bounds: Bbox,
    transform: Affine,
    shape: tuple[int, int],
) -> np.ndarray:
    """Return the class of each cell of the tile, 0 where GLiM has none, water or no data."""
    polygons = _read_glim_polygons(glim_path, bounds)
    # Water bodies and no data are left out of GLIM_VALUES so that they stay 0.
    values = polygons["code"].map(GLIM_VALUES).fillna(0).astype("uint8")
    classed = [(geometry, value) for geometry, value in zip(polygons.geometry, values) if value]
    if not classed:
        return np.zeros(shape, "uint8")

    return rasterize(classed, out_shape=shape, transform=transform, dtype="uint8")


def _read_glim_polygons(glim_path: Path | str, bounds: Bbox) -> "gpd.GeoDataFrame":
    """Read the polygons touching bounds (W, S, E, N) in WGS 84 with their level 1 + 2 code."""
    import pyogrio
    from pyproj import Transformer

    west, south, east, north = bounds
    lons, lats = np.meshgrid(np.linspace(west, east, 9), np.linspace(south, north, 9))
    xs, ys = Transformer.from_crs(4326, GLIM_CRS, always_xy=True).transform(lons, lats)
    polygons = pyogrio.read_dataframe(
        glim_path,
        columns=["Litho"],
        bbox=(xs.min(), ys.min(), xs.max(), ys.max()),
    )
    polygons["code"] = polygons["Litho"].str[:GLIM_CODE_CHARS]
    polygons.geometry = polygons.geometry.segmentize(GLIM_SEGMENT_M)
    return polygons.to_crs(4326)
