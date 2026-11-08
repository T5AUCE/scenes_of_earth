"""Write and atomically publish categorical geology COGs with mode overviews."""
import os
from collections.abc import Callable
from pathlib import Path

import numpy as np
import rasterio
from rasterio.shutil import copy as copy_raster
from rasterio.transform import Affine, from_origin
from rasterio.windows import Window

from ..areas import WORLD_WIDTH_DEG
from ..geology_type import LITHOLOGY_SOURCE_TAG
from ..sources.grid import Bbox

TILE_DEG = 10
NORTH_EDGE_DEG = 60
SOUTH_EDGE_DEG = -60
BLOCK_PX = 512


def publish_cog(write_raster: Callable[[Path], None], source_id: str, cog_path: Path) -> None:
    """Write a plain raster with write_raster, tag its source and convert it to the COG."""
    cleaned = cog_path.with_suffix(".cleaned.tif")
    partial = cog_path.with_suffix(".partial.tif")
    try:
        write_raster(cleaned)
        with rasterio.open(cleaned, "r+") as raster:
            raster.update_tags(**{LITHOLOGY_SOURCE_TAG: source_id})
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


def write_tiled_raster(
    raster_path: Path,
    res_deg: float,
    rasterize_tile: Callable[[Bbox, Affine, tuple[int, int]], np.ndarray],
) -> None:
    """Write the uint8 classes of the 60°S-60°N world at res_deg, one TILE_DEG tile at a time.

    rasterize_tile(bounds, transform, shape) returns the classes of one tile, 0 where it has none.
    """
    width = round(WORLD_WIDTH_DEG / res_deg)
    height = round((NORTH_EDGE_DEG - SOUTH_EDGE_DEG) / res_deg)
    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "count": 1,
        "nodata": 0,
        "crs": "EPSG:4326",
        "width": width,
        "height": height,
        "transform": from_origin(-WORLD_WIDTH_DEG / 2, NORTH_EDGE_DEG, res_deg, res_deg),
        "tiled": True,
        "blockxsize": BLOCK_PX,
        "blockysize": BLOCK_PX,
        "compress": "zstd",
        "BIGTIFF": "IF_SAFER",
    }
    tile_px = round(TILE_DEG / res_deg)
    with rasterio.open(raster_path, "w", **profile) as raster:
        for row in range(0, height, tile_px):
            for column in range(0, width, tile_px):
                tile = Window(column, row, min(tile_px, width - column), min(tile_px, height - row))
                classes = rasterize_tile(
                    raster.window_bounds(tile),
                    raster.window_transform(tile),
                    (tile.height, tile.width),
                )
                if classes.any():
                    raster.write(classes, 1, window=tile)
