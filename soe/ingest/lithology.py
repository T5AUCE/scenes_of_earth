"""Build the lithology COG that rock-type scenes read, from the OpenLandMap lithology map.

The source is one global GeoTIFF in 1-row strips, so a one-off run crops it to 60°S-60°N, turns
water and the undefined class into no data (0), and writes a tiled COG whose overviews keep the
most common class.
"""
import logging
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.shutil import copy as copy_raster
from rasterio.windows import Window, from_bounds

from ..sources.lithology import LITHOLOGY_FILE, UNDEFINED_CLASS, WATER_CLASS
from .cubes import DOWNLOADS_DIR

LITHOLOGY_URL = (
    "https://zenodo.org/api/records/1464846/files/"
    "dtm_lithology_usgs.ecotapestry_c_250m_s0..0cm_2014_v1.0.tif/content"
)
DOWNLOAD_TIMEOUT_SECS = 60
DOWNLOAD_CHUNK_BYTES = 1 << 20
NORTH_EDGE_DEG = 60
SOUTH_EDGE_DEG = -60
EDGE_REPAIR_WIDTH_DEG = 0.01  # half-width of the repaired band at each antimeridian edge
STRIP_ROWS = 512
BLOCK_PX = 512

log = logging.getLogger(__name__)


def ingest_lithology(cubes_dir: Path | str) -> Path:
    """Download the lithology map unless it is already there, publish its COG, return its path."""
    downloads = Path(cubes_dir) / DOWNLOADS_DIR
    downloads.mkdir(parents=True, exist_ok=True)
    source = downloads / "lithology-source.tif"
    if not source.exists():
        log.info("Downloading the lithology map")
        _download(LITHOLOGY_URL, source)
    published = Path(cubes_dir) / LITHOLOGY_FILE
    build_lithology_cog(source, published)
    return published


def build_lithology_cog(source_path: Path | str, cog_path: Path | str) -> None:
    """Write the cropped, cleaned COG of the source map, replacing cog_path only when complete."""
    cog_path = Path(cog_path)
    cleaned = cog_path.with_suffix(".cleaned.tif")
    partial = cog_path.with_suffix(".partial.tif")
    try:
        _write_cleaned(source_path, cleaned)
        copy_raster(
            cleaned,
            partial,
            driver="COG",
            BLOCKSIZE=BLOCK_PX,
            COMPRESS="ZSTD",
            OVERVIEW_RESAMPLING="MODE",
            BIGTIFF="IF_SAFER",
        )
        os.replace(partial, cog_path)
    finally:
        cleaned.unlink(missing_ok=True)
        partial.unlink(missing_ok=True)


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
    """Copy the 60°S-60°N rows strip by strip, clearing water and undefined cells to 0.

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
