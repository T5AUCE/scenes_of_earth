"""Read ESA WorldCover land cover as the most common class in each output cell."""
import math
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import Affine, from_origin
from rasterio.warp import reproject

from ..areas import WORLD_WIDTH_DEG
from .datasets import StaticDataset
from .grid import (
    MAX_STATIC_DIVISIONS,
    MAX_STATIC_SIDE_PX,
    STATIC_BUDGET_PX,
    Bbox,
    budget_res,
)
from .remote import GDAL_OPTS, read_with_retries
from .terrain import LONGITUDE_DEGREE_AT_EQUATOR_M

WORLDCOVER_RES_DEG = 1 / 12000
TILE_DEG = 3  # tiles are named by their south-west corner, a multiple of this
SAMPLES_PER_SIDE = 4  # a cell reads at least 4 x 4 source samples where the data is fine enough
MAX_OVERVIEW_FACTOR = 64  # the coarsest overview of a tile
FACTOR_TOLERANCE = 1e-9  # relative; res = k * native * 4 is exactly on a factor boundary
WORLDCOVER_THREADS = 16

# The GDAL prefix is part of the template so that tests can point it at local files.
WORLDCOVER_URL = (
    "/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
    "ESA_WorldCover_10m_2021_v200_{n}_Map.tif"
)
WORLDCOVER_TILE_INDEX = Path(__file__).parent.parent / "data" / "worldcover_tiles.bin"
WORLDCOVER_GRID_SHAPE = (60, 120)  # rows from the south pole, columns from -180
TILE_EDGE_TOLERANCE_DEG = 1e-9  # a bound exactly on a tile edge must not pull in the next tile

WORLDCOVER_CLASSES = [
    {"value": 10, "label": "Tree cover", "color": "#006400"},
    {"value": 20, "label": "Shrubland", "color": "#ffbb22"},
    {"value": 30, "label": "Grassland", "color": "#ffff4c"},
    {"value": 40, "label": "Cropland", "color": "#f096ff"},
    {"value": 50, "label": "Built-up", "color": "#fa0000"},
    {"value": 60, "label": "Bare / sparse vegetation", "color": "#b4b4b4"},
    {"value": 70, "label": "Snow and ice", "color": "#f0f0f0"},
    {"value": 80, "label": "Permanent water bodies", "color": "#0064c8"},
    {"value": 90, "label": "Herbaceous wetland", "color": "#0096a0"},
    {"value": 95, "label": "Mangroves", "color": "#00cf75"},
    {"value": 100, "label": "Moss and lichen", "color": "#fae6a0"},
]


class PlacedTile(NamedTuple):
    """A WorldCover tile and where it sits in the (possibly unwrapped) frame of the bounds."""

    name: str  # such as S03E036
    lon: int  # west edge in the frame of the bounds, may be above 180
    lat: int  # south edge
    file_lon: int  # west edge in the tile's own frame, -180 to 177


def worldcover_tiles(bounds: Bbox) -> list[PlacedTile]:
    """The existing 3 degree tiles covering bounds (W, S, E, N).

    Longitudes above 180 wrap, so bounds may cross the antimeridian.
    """
    west, south, east, north = bounds
    first_lat = _tile_edge(max(south + TILE_EDGE_TOLERANCE_DEG, -90))
    last_lat = min(math.ceil(north - TILE_EDGE_TOLERANCE_DEG), 90)
    first_lon = _tile_edge(west + TILE_EDGE_TOLERANCE_DEG)
    last_lon = math.ceil(east - TILE_EDGE_TOLERANCE_DEG)
    tiles = []
    for lat in range(first_lat, last_lat, TILE_DEG):
        for lon in range(first_lon, last_lon, TILE_DEG):
            file_lon = (lon + 180) % WORLD_WIDTH_DEG - 180
            if _tile_index()[index_cell(lat, file_lon)]:
                tiles.append(PlacedTile(_tile_name(lat, file_lon), lon, lat, file_lon))
    return tiles


def index_cell(lat: int, file_lon: int) -> tuple[int, int]:
    """(row, column) in the tile index of the tile with this south-west corner."""
    return (lat + 90) // TILE_DEG, (file_lon + 180) // TILE_DEG


def overview_factor(res_deg: float) -> int:
    """The coarsest overview (1, 2, 4 ... 64) that still gives each cell 16 source samples.

    A cell finer than that gets the full-resolution tile.
    """
    samples_per_side = res_deg / WORLDCOVER_RES_DEG / SAMPLES_PER_SIDE
    whole = int(samples_per_side * (1 + FACTOR_TOLERANCE))
    if whole < 1:
        return 1

    return min(1 << (whole.bit_length() - 1), MAX_OVERVIEW_FACTOR)


def land_cover_by_tiles(
    bounds: Bbox,
    res: float,
    read_tile: Callable[[PlacedTile, Bbox, float], np.ndarray],
    on_block: Callable[[], None] = lambda: None,
) -> tuple[np.ndarray, Affine]:
    """Land cover on bounds, read in parallel with one call of read_tile per 3 degree tile.

    read_tile(tile, part, res) returns the classes of the part of the bounds that the tile
    covers. Cells without a tile stay 0. on_block() is called in the calling thread each time a
    tile has been read.
    """
    west, south, east, north = bounds
    height, width = round((north - south) / res), round((east - west) / res)
    classes = np.zeros((height, width), "uint8")
    with ThreadPoolExecutor(WORLDCOVER_THREADS) as executor:
        parts = {
            executor.submit(read_tile, tile, part, res): part
            for tile in worldcover_tiles(bounds)
            for part in [_tile_part(tile, bounds)]
        }
        for future in as_completed(parts):
            part_west, _, _, part_north = parts[future]
            row, column = round((north - part_north) / res), round((part_west - west) / res)
            block = future.result()
            classes[row:row + block.shape[0], column:column + block.shape[1]] = block
            on_block()
    return classes, from_origin(west, north, res, res)


class WorldCoverReader:
    """ESA WorldCover tiles over HTTP."""

    def land_cover(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
    ) -> tuple[np.ndarray, Affine]:
        """Class (uint8) on bounds at res; 0 where WorldCover has no tile or no value.

        on_block() is called each time one of the dataset's block_count(bounds) tiles has been
        read. Returns (array, transform).
        """
        return land_cover_by_tiles(bounds, res, _read_tile, on_block)


class LandCoverDataset(StaticDataset):
    """The most common ESA WorldCover class in each cell, at a size set by the area."""

    def tile_count(self, bbox: Bbox) -> int:
        return len(worldcover_tiles(bbox))

    def res_for(self, bbox: Bbox) -> float:
        return budget_res(bbox, STATIC_BUDGET_PX, MAX_STATIC_SIDE_PX, MAX_STATIC_DIVISIONS)

    def block_count(self, bbox: Bbox) -> int:
        return self.tile_count(bbox)

    def read(
        self,
        bbox: Bbox,
        res: float,
        on_block: Callable[[], None] | None = None,
    ) -> tuple[dict[str, np.ndarray], Affine]:
        """Return uint8 classes over bbox at cell size `res`."""
        classes, transform = self.backend.land_cover(
            tuple(bbox),
            res,
            on_block or (lambda: None),
        )
        return {"value": classes}, transform

    def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
        _, south, _, north = bbox
        centre_latitude = (south + north) / 2
        cell_m = (
            self.res_for(bbox)
            * LONGITUDE_DEGREE_AT_EQUATOR_M
            * math.cos(math.radians(centre_latitude))
        )
        return [
            f"Land cover shows the most common class in each {cell_m:,.0f} m cell "
            "(source 10 m).",
        ]


def _tile_edge(degrees: float) -> int:
    """The tile edge at or below degrees."""
    return math.floor(degrees / TILE_DEG) * TILE_DEG


def _tile_name(lat: int, lon: int) -> str:
    north_south = "N" if lat >= 0 else "S"
    east_west = "E" if lon >= 0 else "W"
    return f"{north_south}{abs(lat):02d}{east_west}{abs(lon):03d}"


@lru_cache
def _tile_index() -> np.ndarray:
    """60 x 120 bool grid of the tiles that exist in the bucket.

    The row is (lat + 90) / 3 and the column is (lon + 180) / 3.
    """
    packed = np.frombuffer(WORLDCOVER_TILE_INDEX.read_bytes(), "uint8")
    return np.unpackbits(packed).reshape(WORLDCOVER_GRID_SHAPE).astype(bool)


def _tile_part(tile: PlacedTile, bounds: Bbox) -> Bbox:
    """The part of bounds inside the tile."""
    west, south, east, north = bounds
    return (
        max(west, tile.lon),
        max(south, tile.lat),
        min(east, tile.lon + TILE_DEG),
        min(north, tile.lat + TILE_DEG),
    )


def _read_tile(tile: PlacedTile, part: Bbox, res: float) -> np.ndarray:
    """The most common class in each output cell of part, from the overview that suits res.

    Output cells never straddle a tile edge, so the mode over one tile's samples is exact.
    """
    west, south, east, north = part
    file_west = west - tile.lon + tile.file_lon
    height, width = round((north - south) / res), round((east - west) / res)
    classes = np.zeros((height, width), "uint8")
    factor = overview_factor(res)
    url = WORLDCOVER_URL.format(n=_tile_name(tile.lat, tile.file_lon))
    # Overview level 0 is the factor 2 overview.
    level = factor.bit_length() - 2 if factor > 1 else None

    def warp() -> np.ndarray:
        with rasterio.Env(**GDAL_OPTS), rasterio.open(url, overview_level=level) as source:
            reproject(
                rasterio.band(source, 1),
                classes,
                src_nodata=0,
                dst_transform=from_origin(file_west, north, res, res),
                dst_crs="EPSG:4326",
                dst_nodata=0,
                resampling=Resampling.mode,
            )
        return classes

    return read_with_retries(warp, "ESA WorldCover tiles did not answer")
