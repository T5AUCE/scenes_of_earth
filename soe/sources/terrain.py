"""Copernicus GLO-30/90 terrain: tiles, block reads, hillshade and the dataset."""
import math
import time
import warnings
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.errors import NotGeoreferencedWarning, RasterioIOError, WarpOperationError
from rasterio.transform import Affine, from_origin
from rasterio.warp import reproject

from ..areas import WORLD_WIDTH_DEG
from .datasets import StaticDataset
from .grid import CELL_DEG, CELLS_PER_DEG2_AT_CHIRPS_RES, Bbox
from .licences import SOURCES
from .remote import GDAL_OPTS, SourceUnavailable

# The warp target is a plain array; a module filter, as catch_warnings is not thread-safe.
warnings.filterwarnings("ignore", category=NotGeoreferencedWarning)

GLO30_RES_DEG = 1 / 3600
GLO90_RES_DEG = 1 / 1200
NATIVE_RES_TOLERANCE = 1e-9  # relative; coarser than this counts as resampled

HILLSHADE_FILL = 255  # stored for cells without data, so real shades stop one below it
HILLSHADE_MAX = HILLSHADE_FILL - 1
ELEVATION_FILL = -32768  # the int16 minimum, below any real ground

LONGITUDE_DEGREE_AT_EQUATOR_M = 111_320
LATITUDE_DEGREE_M = 110_574

TERRAIN_BUDGET_PX = 2048 * 2048
MAX_TERRAIN_SIDE_PX = 4096
MAX_TERRAIN_DIVISIONS = 180  # 0.05 / 180 is the native 30 m cell
BLOCK_DEG = 2  # terrain is read in blocks of this many whole degrees
TERRAIN_THREADS = 32

GLO30_TILE_INDEX = Path(__file__).parent.parent / "data" / "glo30_tiles.bin"
GLO90_TILE_INDEX = Path(__file__).parent.parent / "data" / "glo90_tiles.bin"
TILE_GRID_SHAPE = (180, 360)
TILE_ROW_OFFSET_DEG = 90  # tile index row = lat + 90
TILE_COL_OFFSET_DEG = 180  # tile index column = lon + 180
TILE_EDGE_TOLERANCE_DEG = 1e-9  # a bound exactly on a tile edge must not pull in the next tile
NARROW_TILE_FROM_LAT_DEG = 50  # tiles from this latitude poleward have fewer pixels in x
NARROW_PIXEL_WIDTH_RATIO = 1.5  # their pixels are this much wider than the tile's height
# Wide tile edges sit 1/2 and narrow ones 3/4 of a pixel height off whole degrees; 1/4 fits both.
MIXED_BAND_PIXEL_DIVISOR = 4
CANVAS_MARGIN_DEG = 1  # the mosaic canvas reaches this far beyond the block, for overhangs
BLOCK_READ_ATTEMPTS = 3
BLOCK_RETRY_DELAY_SECS = 1

GLO30_URL = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"
GLO90_URL = "https://copernicus-dem-90m.s3.amazonaws.com/{n}/{n}.tif"


@dataclass(frozen=True)
class TerrainProduct:
    """One Copernicus DEM product: where its tiles are and how they are named."""

    url: str  # tile URL template with {n} for the tile name
    index: Path  # bitmap of the tiles that exist
    tile_code: str  # the number in the tile name that tells the products apart
    res_deg: float  # native cell size
    tile_px: int  # tile height in pixels, and width below NARROW_TILE_FROM_LAT_DEG
    cell_m: int  # native cell size in metres, for notices


# Finest first: this is also the order of a mixed scene's sources.
TERRAIN_PRODUCTS = {
    "glo30": TerrainProduct(GLO30_URL, GLO30_TILE_INDEX, "10", GLO30_RES_DEG, 3600, 30),
    "glo90": TerrainProduct(GLO90_URL, GLO90_TILE_INDEX, "30", GLO90_RES_DEG, 1200, 90),
}


def terrain_product(res: float) -> str:
    """'glo30' for cells finer than the 90 m of GLO-90, else 'glo90'."""
    return "glo30" if res < GLO90_RES_DEG * (1 - NATIVE_RES_TOLERANCE) else "glo90"


class PlacedTile(NamedTuple):
    """A terrain tile and where it sits in the (possibly unwrapped) frame of the bounds."""

    product: str
    name: str
    lon: int  # west edge, may be above 180
    lat: int  # south edge


def terrain_tiles(bounds: Bbox, product: str) -> list[tuple[str, str]]:
    """(product, name) of the existing tiles covering bounds (W, S, E, N).

    Tiles are 1 degree and named by their south-west corner. A cell that GLO-30 does not publish
    is taken from GLO-90. Longitudes above 180 wrap, so bounds may cross the antimeridian.
    """
    return [(tile.product, tile.name) for tile in placed_terrain_tiles(bounds, product)]


def placed_terrain_tiles(bounds: Bbox, product: str) -> list[PlacedTile]:
    """The tiles of terrain_tiles with their position in the frame of the bounds."""
    west, south, east, north = bounds
    candidates = list(dict.fromkeys([product, "glo90"]))
    first_lat = max(math.floor(south + TILE_EDGE_TOLERANCE_DEG), -TILE_ROW_OFFSET_DEG)
    last_lat = min(math.ceil(north - TILE_EDGE_TOLERANCE_DEG), TILE_ROW_OFFSET_DEG)
    first_lon = math.floor(west + TILE_EDGE_TOLERANCE_DEG)
    last_lon = math.ceil(east - TILE_EDGE_TOLERANCE_DEG)
    tiles = []
    for lat in range(first_lat, last_lat):
        for lon in range(first_lon, last_lon):
            tile = _placed_tile(candidates, lat, lon)
            if tile is not None:
                tiles.append(tile)
    return tiles


def _placed_tile(candidates: list[str], lat: int, lon: int) -> PlacedTile | None:
    """The tile at (lat, lon) from the first candidate product that has it, or None."""
    wrapped_lon = (lon + TILE_COL_OFFSET_DEG) % WORLD_WIDTH_DEG - TILE_COL_OFFSET_DEG
    row, column = lat + TILE_ROW_OFFSET_DEG, wrapped_lon + TILE_COL_OFFSET_DEG
    for candidate in candidates:
        if _tile_index(candidate)[row, column]:
            return PlacedTile(candidate, _tile_name(candidate, lat, wrapped_lon), lon, lat)
    return None


def _tile_name(product: str, lat: int, lon: int) -> str:
    north_south = "N" if lat >= 0 else "S"
    east_west = "E" if lon >= 0 else "W"
    return (
        f"Copernicus_DSM_COG_{TERRAIN_PRODUCTS[product].tile_code}_{north_south}{abs(lat):02d}"
        f"_00_{east_west}{abs(lon):03d}_00_DEM"
    )


@lru_cache
def _tile_index(product: str) -> np.ndarray:
    """180 x 360 bool grid of the tiles that exist in the product's bucket.

    The row is lat + 90 and the column is lon + 180.
    """
    packed = np.frombuffer(TERRAIN_PRODUCTS[product].index.read_bytes(), "uint8")
    return np.unpackbits(packed).reshape(TILE_GRID_SHAPE).astype(bool)


def terrain_res(bounds: Bbox) -> float:
    """Terrain cell size 0.05 / k degrees, so whole degrees are a whole number of cells.

    It gives about 4.2 Mpx and at most 4096 px on the long side, never finer than native.
    """
    west, south, east, north = bounds
    width, height = east - west, north - south
    divisions = min(
        math.isqrt(int(TERRAIN_BUDGET_PX / (CELLS_PER_DEG2_AT_CHIRPS_RES * width * height))),
        int(MAX_TERRAIN_SIDE_PX * CELL_DEG / max(width, height)),
    )
    return CELL_DEG / min(max(divisions, 1), MAX_TERRAIN_DIVISIONS)


def with_margin(bounds: Bbox, res: float) -> Bbox:
    """Bounds grown by one pixel.

    Copernicus tiles are half a pixel off-grid, so a tile just outside the bounds can still
    reach into them.
    """
    west, south, east, north = bounds
    return (west - res, south - res, east + res, north + res)


def hillshade(
    elevation: np.ndarray,
    resolution_degrees: float,
    latitude_top: float,
    azimuth: float = 315,
    altitude: float = 45,
) -> np.ndarray:
    """Return uint8 hillshade (0-HILLSHADE_MAX) for a north-up grid with cells in degrees."""
    elevation = np.pad(elevation.astype("float64"), 1, mode="edge")

    height = elevation.shape[0] - 2
    latitude = latitude_top - (np.arange(height) + 0.5) * resolution_degrees

    # Gradients need cell sizes in metres to match elevation units.
    cell_width = (
        resolution_degrees
        * LONGITUDE_DEGREE_AT_EQUATOR_M
        * np.cos(np.radians(latitude))
    )[:, None].clip(min=1)
    cell_height = resolution_degrees * LATITUDE_DEGREE_M

    northwest = elevation[:-2, :-2]
    north = elevation[:-2, 1:-1]
    northeast = elevation[:-2, 2:]
    west = elevation[1:-1, :-2]
    east = elevation[1:-1, 2:]
    southwest = elevation[2:, :-2]
    south = elevation[2:, 1:-1]
    southeast = elevation[2:, 2:]

    gradient_east = (
        (northeast + 2 * east + southeast)
        - (northwest + 2 * west + southwest)
    ) / (8 * cell_width)

    gradient_north = (
        (northwest + 2 * north + northeast)
        - (southwest + 2 * south + southeast)
    ) / (8 * cell_height)

    azimuth_radians = np.radians(azimuth)
    altitude_radians = np.radians(altitude)

    light_east = np.sin(azimuth_radians) * np.cos(altitude_radians)
    light_north = np.cos(azimuth_radians) * np.cos(altitude_radians)
    light_up = np.sin(altitude_radians)

    illumination = (
        -gradient_east * light_east
        - gradient_north * light_north
        + light_up
    ) / np.sqrt(gradient_east**2 + gradient_north**2 + 1)

    return np.rint(illumination.clip(0, 1) * 255).clip(max=HILLSHADE_MAX).astype("uint8")


def terrain_by_blocks(
    bounds: Bbox,
    res: float,
    read_block: Callable[[Bbox, float], np.ndarray | None],
    on_block: Callable[[], None] = lambda: None,
) -> tuple[np.ndarray, Affine]:
    """Terrain on bounds, read in parallel in blocks of whole degrees.

    read_block(block_bounds, res) returns an array, or None for a block without terrain (left at 0).
    on_block() is called in the calling thread each time a block has been read.
    """
    west, south, east, north = bounds
    height, width = round((north - south) / res), round((east - west) / res)
    blocks = _terrain_blocks(bounds)
    with ThreadPoolExecutor(TERRAIN_THREADS) as executor:
        futures = [executor.submit(read_block, block, res) for block in blocks]
        for future in as_completed(futures):
            future.result()
            on_block()
    parts = [future.result() for future in futures]

    elevation = np.zeros((height, width), "int16")
    for (x0, y0, _, y1), part in zip(blocks, parts):
        if part is not None:
            row, col = round((north - y1) / res), round((x0 - west) / res)
            elevation[row:row + part.shape[0], col:col + part.shape[1]] = part
    return elevation, from_origin(west, north, res, res)


def terrain_block_count(bounds: Bbox) -> int:
    """How many blocks terrain_by_blocks reads for bounds."""
    return len(_terrain_blocks(bounds))


def _terrain_blocks(bounds: Bbox) -> list[Bbox]:
    west, south, east, north = bounds
    x_edges = _block_edges(west, east)
    y_edges = _block_edges(south, north)
    return [
        (x0, y0, x1, y1)
        for x0, x1 in zip(x_edges, x_edges[1:])
        for y0, y1 in zip(y_edges, y_edges[1:])
    ]


def _block_edges(low: float, high: float) -> list[float]:
    """low, every multiple of BLOCK_DEG strictly between, then high."""
    first_multiple = math.floor(low / BLOCK_DEG) * BLOCK_DEG + BLOCK_DEG
    return [low] + list(range(first_multiple, math.ceil(high), BLOCK_DEG)) + [high]


class CopernicusDemReader:
    """Copernicus GLO-30 / GLO-90 tiles over HTTP."""

    def terrain(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
    ) -> tuple[np.ndarray, Affine]:
        """Elevation (int16) on bounds at res; ocean (no tile) is 0. Returns (array, transform).

        on_block() is called each time one of terrain_block_count(bounds) blocks has been read.
        """
        return terrain_by_blocks(bounds, res, _warp_block, on_block)


def _warp_block(bounds: Bbox, res: float) -> np.ndarray | None:
    """One block: elevation area-averaged onto its grid, or None if no tile exists there."""
    product = terrain_product(res)
    tiles = placed_terrain_tiles(with_margin(bounds, res), product)
    if not tiles:
        return None

    mosaic = _mosaic_xml(tiles, bounds, product)
    for attempt in range(BLOCK_READ_ATTEMPTS):
        try:
            return _average_onto_grid(mosaic, bounds, res)
        # GDAL reports a tile download that fails inside the warp as WarpOperationError.
        except (RasterioIOError, WarpOperationError) as error:
            if attempt == BLOCK_READ_ATTEMPTS - 1:
                raise SourceUnavailable("Copernicus DEM tiles did not answer") from error

            # The bucket drops connections now and then.
            time.sleep(BLOCK_RETRY_DELAY_SECS)


def _mosaic_xml(tiles: list[PlacedTile], bounds: Bbox, product: str) -> str:
    """VRT that lays the tiles side by side at their true footprints, in the frame of bounds.

    A tile's pixel centres sit on whole degrees, so its footprint reaches half a pixel beyond its
    name. The canvas origin is on the half-pixel grid of the scene's product.
    """
    west, south, east, north = bounds
    pixel_height = TERRAIN_PRODUCTS[product].res_deg
    pixel_width, origin_shift = _canvas_pixel(tiles, south, north, pixel_height)
    left = math.floor(west) - CANVAS_MARGIN_DEG - origin_shift
    top = math.ceil(north) + CANVAS_MARGIN_DEG + pixel_height / 2
    width_deg = math.ceil(east) - math.floor(west) + 2 * CANVAS_MARGIN_DEG
    height_deg = math.ceil(north) - math.floor(south) + 2 * CANVAS_MARGIN_DEG
    width = round(width_deg / pixel_width) + 1
    height = round(height_deg / pixel_height) + 1
    sources = "".join(
        _tile_source_xml(tile, left, top, pixel_width, pixel_height) for tile in tiles
    )
    return (
        f'<VRTDataset rasterXSize="{width}" rasterYSize="{height}">'
        "<SRS>EPSG:4326</SRS>"
        f"<GeoTransform>{left}, {pixel_width}, 0, {top}, 0, {-pixel_height}</GeoTransform>"
        f'<VRTRasterBand dataType="Float32" band="1">{sources}</VRTRasterBand>'
        "</VRTDataset>"
    )


def _canvas_pixel(
    tiles: list[PlacedTile],
    south: float,
    north: float,
    pixel_height: float,
) -> tuple[float, float]:
    """(canvas pixel width, west shift of the canvas origin from whole degrees).

    The pixels are as wide as the block's latitude band has, so that band's tiles land on whole
    canvas pixels. A block with tiles of both bands uses a pixel that divides both tile widths and
    edge offsets exactly, with the origin on whole degrees.
    """
    if {_is_narrow_tile(tile) for tile in tiles} == {False, True}:
        return pixel_height / MIXED_BAND_PIXEL_DIVISOR, 0

    narrow = _is_narrow_band(south, north)
    pixel_width = pixel_height * (NARROW_PIXEL_WIDTH_RATIO if narrow else 1)
    return pixel_width, pixel_width / 2


def _is_narrow_band(south: float, north: float) -> bool:
    """Whether a block lies in the latitudes whose tiles have fewer pixels in x.

    Blocks start and end on even degrees, so each lies on one side of the 50-degree boundary,
    but the tiles it reads, margin included, can come from both sides.
    """
    return abs(south + north) / 2 >= NARROW_TILE_FROM_LAT_DEG


def _is_narrow_tile(tile: PlacedTile) -> bool:
    """Whether a tile has fewer pixels in x; its centre latitude decides the band."""
    return abs(tile.lat + 0.5) >= NARROW_TILE_FROM_LAT_DEG


def _tile_source_xml(
    tile: PlacedTile,
    left: float,
    top: float,
    pixel_width: float,
    pixel_height: float,
) -> str:
    """VRT SimpleSource that draws one tile at its footprint on the canvas."""
    tile_px = TERRAIN_PRODUCTS[tile.product].tile_px
    narrow = _is_narrow_tile(tile)
    width_px = round(tile_px / NARROW_PIXEL_WIDTH_RATIO) if narrow else tile_px
    url = "/vsicurl/" + TERRAIN_PRODUCTS[tile.product].url.format(n=tile.name)
    column = (tile.lon - 0.5 / width_px - left) / pixel_width
    row = (top - (tile.lat + 1 + 0.5 / tile_px)) / pixel_height
    return (
        f'<SimpleSource><SourceFilename relativeToVRT="0">{url}</SourceFilename>'
        "<SourceBand>1</SourceBand>"
        f'<SrcRect xOff="0" yOff="0" xSize="{width_px}" ySize="{tile_px}"/>'
        f'<DstRect xOff="{column}" yOff="{row}" xSize="{1 / pixel_width}" '
        f'ySize="{1 / pixel_height}"/></SimpleSource>'
    )


def _average_onto_grid(mosaic: str, bounds: Bbox, res: float) -> np.ndarray:
    """Area-average the mosaic VRT onto the output grid of bounds."""
    west, south, east, north = bounds
    height, width = round((north - south) / res), round((east - west) / res)
    elevation = np.zeros((height, width), "float32")
    with rasterio.Env(**GDAL_OPTS), rasterio.open(mosaic) as source:
        reproject(
            rasterio.band(source, 1),
            elevation,
            dst_transform=from_origin(west, north, res, res),
            dst_crs="EPSG:4326",
            resampling=Resampling.average,
        )
    return np.rint(elevation).clip(-32768, 32767).astype("int16")


class TerrainDataset(StaticDataset):
    """Copernicus GLO-30 or GLO-90 elevation, read at a resolution that depends on the area size."""

    def tile_count(self, bbox: Bbox) -> int:
        return len(self._tiles(bbox))

    def res_for(self, bbox: Bbox) -> float:
        return terrain_res(bbox)

    def sources_for(self, bbox: Bbox) -> list[dict]:
        used = {product for product, _ in self._tiles(bbox)}
        products = [product for product in TERRAIN_PRODUCTS if product in used]
        return [SOURCES[product] for product in products or [terrain_product(terrain_res(bbox))]]

    def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
        res = terrain_res(bbox)
        product = terrain_product(res)
        native = TERRAIN_PRODUCTS[product]
        notices = []
        if res > native.res_deg * (1 + NATIVE_RES_TOLERANCE):
            cell_size_m = round(res * LONGITUDE_DEGREE_AT_EQUATOR_M)
            notices.append(
                f"Terrain resampled to {cell_size_m} m cells (source {native.cell_m} m)."
            )

        has_fallback = any(tile_product != product for tile_product, _ in self._tiles(bbox))
        if has_fallback:
            fallback = TERRAIN_PRODUCTS["glo90"]
            notices.append(
                f"Terrain uses {fallback.cell_m} m Copernicus GLO-90 where GLO-30 is not public."
            )
        return notices

    def block_count(self, bbox: Bbox) -> int:
        return terrain_block_count(tuple(bbox))

    def read(
        self,
        bbox: Bbox,
        res: float,
        on_block: Callable[[], None] | None = None,
    ) -> tuple[dict[str, np.ndarray], Affine]:
        """Elevation (int16) and its hillshade (uint8) over bbox at cell size `res`."""
        if on_block is None:
            elevation, transform = self.backend.terrain(tuple(bbox), res)
        else:
            elevation, transform = self.backend.terrain(tuple(bbox), res, on_block)

        light = self.style["hillshade"]
        shade = hillshade(
            elevation,
            abs(transform.a),
            transform.f,
            light["azimuth"],
            light["altitude"],
        )
        return {"elevation": elevation, "hillshade": shade}, transform

    def _tiles(self, bbox: Bbox) -> list[tuple[str, str]]:
        return terrain_tiles(bbox, terrain_product(terrain_res(bbox)))
