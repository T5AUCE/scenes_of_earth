"""Data sources: CHIRPS rain, Copernicus GLO-30/90 terrain, a synthetic stand-in, licence text.

Each dataset has a Grid; CHIRPS is global at 0.05 degrees with row 0 at 60N.
Windows are integer (col, row, width, height) cell windows on a dataset's Grid, so reads are never
resampled.
"""
import math
import threading
import time
import urllib.error
import urllib.request
import warnings
from abc import ABC, abstractmethod
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import ClassVar, NamedTuple

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.errors import NotGeoreferencedWarning, RasterioIOError, WarpOperationError
from rasterio.transform import Affine, from_origin
from rasterio.warp import reproject
from rasterio.windows import Window

# The warp target is a plain array; a module filter, as catch_warnings is not thread-safe.
warnings.filterwarnings("ignore", category=NotGeoreferencedWarning)

Bbox = Sequence[float]  # W, S, E, N in degrees; a list or a tuple
CellWindow = tuple[int, int, int, int]  # col, row, width, height on a dataset's grid
CellSpan = tuple[int, int, int, int]  # c0, c1, r0, r1 on a dataset's grid
Encoding = tuple[str, float, float, int | None]  # dtype, scale_factor, add_offset, fill
Registry = dict[str, "Dataset"]  # dataset id -> dataset

# The app supports 60S-60N in v1; widen the extent here.
SUPPORTED_BOUNDS_DEG = (-180, -60, 180, 60)  # W, S, E, N

CELL_DEG = 0.05  # CHIRPS cell size
CELLS_PER_DEG2_AT_CHIRPS_RES = 400  # (1 / 0.05) ** 2
FIRST_MONTH = "1981-01"

GRID_DECIMALS = 6  # cell indices and bounds are rounded to this to absorb float noise
WORLD_WIDTH_DEG = 360


@dataclass(frozen=True)
class Grid:
    """A dataset's cell grid: cell (0, 0) has its north-west corner at (west_deg, north_deg).

    Row 0 is the north edge. Only whole cells are addressed, so reads are never resampled.
    """

    west_deg: float
    north_deg: float
    res: float  # cell size, degrees
    columns: int  # in the whole grid; longitudes wrap after this many
    rows: int

    @property
    def transform(self) -> Affine:
        return Affine(self.res, 0, self.west_deg, 0, -self.res, self.north_deg)

    def span(self, bounds: Bbox) -> CellSpan:
        """Outward cell range (c0, c1, r0, r1) of bounds."""
        west, south, east, north = bounds
        return (
            math.floor(round((west - self.west_deg) / self.res, GRID_DECIMALS)),
            math.ceil(round((east - self.west_deg) / self.res, GRID_DECIMALS)),
            math.floor(round((self.north_deg - north) / self.res, GRID_DECIMALS)),
            math.ceil(round((self.north_deg - south) / self.res, GRID_DECIMALS)),
        )

    def bbox(self, span: CellSpan) -> list[float]:
        """[W, S, E, N] of a cell range."""
        c0, c1, r0, r1 = span
        return [
            round(value, GRID_DECIMALS)
            for value in (
                self.west_deg + c0 * self.res,
                self.north_deg - r1 * self.res,
                self.west_deg + c1 * self.res,
                self.north_deg - r0 * self.res,
            )
        ]

    def window(self, bbox: Bbox) -> CellWindow:
        """Integer (col, row, width, height) window of a grid-aligned bbox."""
        west, south, east, north = bbox
        col = round((west - self.west_deg) / self.res)
        row = round((self.north_deg - north) / self.res)
        return col, row, round((east - west) / self.res), round((north - south) / self.res)


CHIRPS_GRID = Grid(-180, 60, CELL_DEG, 7200, 2400)

GLO30_RES_DEG = 1 / 3600
GLO90_RES_DEG = 1 / 1200
NATIVE_RES_TOLERANCE = 1e-9  # relative; coarser than this counts as resampled
LONGITUDE_DEGREE_AT_EQUATOR_M = 111_320  # for the notice's approximate cell size
TERRAIN_BUDGET_PX = 2048 * 2048
MAX_TERRAIN_SIDE_PX = 4096
MAX_TERRAIN_DIVISIONS = 180  # 0.05 / 180 is the native 30 m cell
BLOCK_DEG = 2  # terrain is read in blocks of this many whole degrees
TERRAIN_THREADS = 32

GLO30_TILE_INDEX = Path(__file__).parent / "data" / "glo30_tiles.bin"
GLO90_TILE_INDEX = Path(__file__).parent / "data" / "glo90_tiles.bin"
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

HEAD_TIMEOUT_SECS = 5  # latest-month probes run on the first page load
REVISION_TIMEOUT_SECS = 15
LATEST_MONTH_PROBES = 7
LATEST_TTL_SECS = 24 * 60 * 60
OFFLINE_LATEST_TTL_SECS = 10 * 60
OFFLINE_ASSUMED_LAG_MONTHS = 2

CHIRPS_URL = (
    "https://data.chc.ucsb.edu/products/CHIRPS/v3.0/monthly/global/cogs/"
    "chirps-v3.0.{ym}.cog"
)
GLO30_URL = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"
GLO90_URL = "https://copernicus-dem-90m.s3.amazonaws.com/{n}/{n}.tif"
GDAL_OPTS = {
    "GDAL_HTTP_MAX_RETRY": "5",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".cog,.tif",
    "CPL_VSIL_CURL_CACHE_SIZE": "200000000",  # bytes; blocks of one tile share fetched ranges
}


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

# Licence and attribution text, copied into every bundle (see bundle.py).
SOURCES = {
    "chirps": {
        "name": "CHIRPS v3.0 monthly",
        "version": "3.0",
        "licence": "CC BY 4.0",
        "licence_url": "http://creativecommons.org/licenses/by/4.0/",
        "attribution": "Rainfall: CHIRPS v3 (Climate Hazards Center, UC Santa Barbara)",
        "citation": (
            "Funk, C. et al. (2026) The Climate Hazards Center Infrared Precipitation with "
            "Stations, Version 3. Scientific Data 13, 718. doi:10.1038/s41597-026-07096-4; "
            "dataset doi:10.15780/G2JQ0P"
        ),
        "modified": (
            "negative fill values masked; block-mean aggregation when stated in the layer "
            "resolution"
        ),
    },
    "glo30": {
        "name": "Copernicus DEM GLO-30 Public",
        "version": "2021",
        "licence": "Copernicus WorldDEM™-30 licence (COP-DEM-GLO-30, Free & Open, Public)",
        "licence_url": (
            "https://dataspace.copernicus.eu/explore-data/data-collections/"
            "copernicus-contributing-missions/collections-description/COP-DEM"
        ),
        "attribution": (
            "produced using Copernicus WorldDEM™-30 © DLR e.V. 2010-2014 and "
            "© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS "
            "by the European Union and ESA; all rights reserved"
        ),
        "disclaimer": (
            "The organisations in charge of the Copernicus programme by law or by "
            "delegation do not incur any liability for any use of the Copernicus "
            "WorldDEM™-30"
        ),
        "citation": "doi:10.5270/ESA-c5d3d65",
        "modified": (
            "elevation area-averaged onto the scene grid; hillshade (Horn, az 315°, alt 45°)"
        ),
    },
    "glo90": {
        "name": "Copernicus DEM GLO-90",
        "version": "2021",
        "licence": "Copernicus WorldDEM™-90 licence (COP-DEM-GLO-90-F, Full, Free & Open)",
        "licence_url": (
            "https://dataspace.copernicus.eu/explore-data/data-collections/"
            "copernicus-contributing-missions/collections-description/COP-DEM"
        ),
        "attribution": (
            "produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and "
            "© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS "
            "by the European Union and ESA; all rights reserved"
        ),
        "disclaimer": (
            "The organisations in charge of the Copernicus programme by law or by "
            "delegation do not incur any liability for any use of the Copernicus "
            "WorldDEM™-90"
        ),
        "citation": "doi:10.5270/ESA-c5d3d65",
        "modified": (
            "elevation area-averaged onto the scene grid; hillshade (Horn, az 315°, alt 45°)"
        ),
    },
    "geoBoundaries CGAZ": {
        "name": "geoBoundaries CGAZ",
        "licence": "CC BY 4.0",
        "licence_url": "https://www.geoboundaries.org/",
        "attribution": "Boundaries: geoBoundaries (https://www.geoboundaries.org)",
        "citation": (
            "Runfola, D. et al. (2020) geoBoundaries: A global database of political "
            "administrative boundaries. PLoS ONE 15(4): e0231866. "
            "https://doi.org/10.1371/journal.pone.0231866"
        ),
        "modified": "simplified 0.01°, clipped to 60°S-60°N",
    },
    "synthetic": {
        "name": "Sample areas",
        "licence": "per feature: Public Domain, ODbL 1.0 or CC BY 4.0 (geoBoundaries gbOpen)",
        "attribution": (
            "Sample outlines: geoBoundaries (https://www.geoboundaries.org), simplified"
        ),
    },
    "GHSL UCDB R2024A": {
        "name": "GHSL Urban Centre Database R2024A",
        "licence": "CC BY 4.0",
        "licence_url": "https://human-settlement.emergency.copernicus.eu/ghs_ucdb_2024.php",
        "attribution": "© European Union, 1995-2026, GHS-UCDB R2024A",
        "modified": "reprojected from Mollweide, simplified 0.01°, clipped to 60°S-60°N",
    },
}


def month_list(start: str, end: str) -> list[str]:
    """'YYYY-MM' strings from start to end inclusive."""
    year, month = int(start[:4]), int(start[5:7])
    months = []
    while f"{year:04d}-{month:02d}" <= end:
        months.append(f"{year:04d}-{month:02d}")
        year, month = _next_month(year, month)
    return months


def _next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


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
    tiles = []
    first_lat = max(math.floor(south + TILE_EDGE_TOLERANCE_DEG), -TILE_ROW_OFFSET_DEG)
    last_lat = min(math.ceil(north - TILE_EDGE_TOLERANCE_DEG), TILE_ROW_OFFSET_DEG)
    for lat in range(first_lat, last_lat):
        for lon in range(
            math.floor(west + TILE_EDGE_TOLERANCE_DEG), math.ceil(east - TILE_EDGE_TOLERANCE_DEG)
        ):
            wrapped_lon = (lon + TILE_COL_OFFSET_DEG) % WORLD_WIDTH_DEG - TILE_COL_OFFSET_DEG
            for candidate in candidates:
                if _tile_index(candidate)[
                    lat + TILE_ROW_OFFSET_DEG, wrapped_lon + TILE_COL_OFFSET_DEG
                ]:
                    name = _tile_name(candidate, lat, wrapped_lon)
                    tiles.append(PlacedTile(candidate, name, lon, lat))
                    break
    return tiles


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


class SourceUnavailable(RuntimeError):
    """The remote data server could not be reached; the API turns this into a 503."""


class RealSource:
    """CHIRPS COGs and GLO-30 / GLO-90 tiles over HTTP."""

    def __init__(self, latest: str | None = None) -> None:
        # An optional fixed 'YYYY-MM' (SOE_LATEST); otherwise the latest month is probed and cached.
        self._latest = latest
        self._probed = None
        self._probe_lock = threading.Lock()

    def latest_month(self) -> str:
        if self._latest:
            return self._latest

        # Concurrent first requests share one probe.
        with self._probe_lock:
            if self._probed and time.time() < self._probed[1]:
                return self._probed[0]

            now = datetime.now(timezone.utc)
            found, complete = self._probe_latest_month(now)
            if found is None:
                # Offline: assume the usual two-month lag, and probe again soon.
                found = self._assumed_latest_month(now)
                complete = False

            ttl = LATEST_TTL_SECS if complete else OFFLINE_LATEST_TTL_SECS
            self._probed = (found, time.time() + ttl)
            return found

    def _probe_latest_month(self, now: datetime) -> tuple[str | None, bool]:
        candidates = []
        year, month = now.year, now.month
        for _ in range(LATEST_MONTH_PROBES):
            candidates.append(f"{year:04d}-{month:02d}")
            year, month = _previous_month(year, month)

        urls = [_chirps_url(candidate) for candidate in candidates]
        with ThreadPoolExecutor(LATEST_MONTH_PROBES) as pool:
            exists = [answer[0] for answer in pool.map(_head, urls)]

        if True not in exists:
            return None, False

        newest_index = exists.index(True)
        return candidates[newest_index], None not in exists[:newest_index]

    def _assumed_latest_month(self, now: datetime) -> str:
        year, month = now.year, now.month
        for _ in range(OFFLINE_ASSUMED_LAG_MONTHS):
            year, month = _previous_month(year, month)
        return f"{year:04d}-{month:02d}"

    def current_revision(self, month: str) -> str:
        """Last-Modified date of the month's CHIRPS file.

        It changes whenever CHC republishes (revises) that month's data.
        """
        last_modified = _head(_chirps_url(month), REVISION_TIMEOUT_SECS)[1]
        if not last_modified:
            raise SourceUnavailable("CHIRPS server did not answer")

        return last_modified

    def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
        """One month at native resolution as float32; fill values (< 0) become NaN."""
        col, row, width, height = window

        with rasterio.Env(**GDAL_OPTS):
            with rasterio.open(_chirps_url(month)) as dataset:
                if (dataset.width, dataset.height) != (CHIRPS_GRID.columns, CHIRPS_GRID.rows):
                    raise RuntimeError(f"unexpected CHIRPS grid {dataset.width}x{dataset.height}")
                rain = dataset.read(1, window=Window(col, row, width, height)).astype("float32")

        rain[rain < 0] = np.nan
        return rain

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


def _previous_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def _chirps_url(month: str) -> str:
    return CHIRPS_URL.format(ym=month.replace("-", "."))


def _head(url: str, timeout: float = HEAD_TIMEOUT_SECS) -> tuple[bool | None, str | None]:
    """(exists, Last-Modified) for a URL: (False, None) on 404, (None, None) if unreachable."""
    try:
        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return True, response.headers.get("Last-Modified")
    except urllib.error.HTTPError as error:
        return (False if error.code == 404 else None), None
    except (urllib.error.URLError, OSError):
        return None, None


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
    name. The canvas origin is on the half-pixel grid of the scene's product, and its pixels are
    as wide as the block's latitude band has, so that band's tiles land on whole canvas pixels.
    A block with tiles of both bands uses a pixel that divides both tile widths and edge offsets
    exactly, with the origin on whole degrees.
    """
    west, south, east, north = bounds
    pixel_height = TERRAIN_PRODUCTS[product].res_deg
    if {_is_narrow_tile(tile) for tile in tiles} == {False, True}:
        pixel_width = pixel_height / MIXED_BAND_PIXEL_DIVISOR
        origin_shift = 0
    else:
        narrow = _is_narrow_band(south, north)
        pixel_width = pixel_height * (NARROW_PIXEL_WIDTH_RATIO if narrow else 1)
        origin_shift = pixel_width / 2
    left = math.floor(west) - CANVAS_MARGIN_DEG - origin_shift
    top = math.ceil(north) + CANVAS_MARGIN_DEG + pixel_height / 2
    width = round((math.ceil(east) - math.floor(west) + 2 * CANVAS_MARGIN_DEG) / pixel_width) + 1
    span_deg = math.ceil(north) - math.floor(south) + 2 * CANVAS_MARGIN_DEG
    height = round(span_deg / pixel_height) + 1
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


class SyntheticSource:
    """Deterministic fake data, no network. `reads` counts rain reads (tests use it)."""

    def __init__(self, latest: str = "2026-08") -> None:
        self._latest = latest
        self.reads = 0

    def latest_month(self) -> str:
        return self._latest

    def current_revision(self, month: str) -> str:
        return "synthetic"

    def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
        self.reads += 1
        col, row, width, height = window
        month_number = int(month[:4]) * 12 + int(month[5:7])
        cols, rows = np.meshgrid(np.arange(col, col + width), np.arange(row, row + height))

        rain = 100 + 80 * np.sin(cols / 15 + month_number * 0.5) * np.cos(rows / 11)
        rain = rain.astype("float32")
        rain[(cols * 7 + rows * 13) % 11 == 0] = np.nan  # Holes, to exercise NaN-aware means.
        return rain

    def terrain(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
    ) -> tuple[np.ndarray, Affine]:
        west, south, east, north = bounds
        width, height = round((east - west) / res), round((north - south) / res)
        transform = from_origin(west, north, res, res)

        cols, rows = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
        lon, lat = transform @ (cols, rows)
        elevation = 1000 + 800 * np.sin(lon * 20) * np.cos(lat * 20)
        for _ in range(terrain_block_count(bounds)):
            on_block()
        return elevation.astype("int16"), transform


def block_mean(values: np.ndarray, factor: int) -> np.ndarray:
    """NaN-aware factor x factor block mean (shape must be divisible by factor)."""
    if factor == 1:
        return values

    height, width = values.shape
    blocks = values.reshape(height // factor, factor, width // factor, factor)
    valid = ~np.isnan(blocks)
    counts = valid.sum(axis=(1, 3))
    sums = np.where(valid, blocks, 0).sum(axis=(1, 3), dtype="float64")

    return np.where(counts > 0, sums / np.maximum(counts, 1), np.nan).astype("float32")


@dataclass
class Dataset(ABC):
    """A layer the backend can build; subclass StaticDataset or SeriesDataset, not this."""

    # Set only by StaticDataset/SeriesDataset; some code branches on it, some on isinstance.
    time_varying: ClassVar[bool]  # published in scene.json and /api/layers

    id: str
    title: str
    units: str
    resolution_deg: float  # native cell size
    source: dict  # licence, licence_url, attribution, citation, modified, version, ...
    arrays: dict  # role -> data array name inside the Zarr group `id`
    encoding: dict  # role -> (stored dtype, scale_factor, add_offset, fill value or None)
    style: dict  # viewer defaults
    backend: object
    grid: Grid  # the layer's window is cut on this grid
    long_name: str = ""  # CF long_name of the main array
    coverage: tuple = SUPPORTED_BOUNDS_DEG  # W, S, E, N; a narrower dataset overrides it
    step: str | None = None  # ISO 8601 duration between time steps; None for static layers
    max_tiles: int | None = None  # request cap for tiled datasets

    def tile_count(self, bbox: Bbox) -> int:
        """Number of source tiles a read of bbox needs (0 for untiled data)."""
        return 0

    def res_for(self, bbox: Bbox) -> float:
        """Cell size of a static layer over bbox."""
        return self.resolution_deg

    def current_revision(self, last_month: str) -> str | None:
        """The provider's current revision marker of `last_month`, or None for static data.

        A revision is a string that changes whenever the provider republishes that month's
        data. It is part of the scene id, so revised data gets a new scene.
        """
        return None

    def domain(self, stats: dict[str, float]) -> list[float]:
        """Colour-scale range of a series layer, from the stats of its values."""
        return [stats["min"], stats["p98"]]

    def sources_for(self, bbox: Bbox) -> list[dict]:
        """The sources a read of bbox uses, the main one first."""
        return [self.source]

    def notices(self, bbox: Bbox) -> list[str]:
        """Limits notices for a read of bbox."""
        return []


class StaticDataset(Dataset):
    """A layer without a time axis, read as one 2D grid."""

    time_varying = False

    def block_count(self, bbox: Bbox) -> int:
        """Number of parts a read of bbox reports through on_block; the weight of its progress."""
        return 1

    @abstractmethod
    def read(
        self,
        bbox: Bbox,
        res: float,
        on_block: Callable[[], None] | None = None,
    ) -> tuple[np.ndarray, Affine]:
        """Values over bbox at cell size `res`: (2D array, transform).

        on_block() is called each time one of block_count(bbox) parts has been read.
        """


class SeriesDataset(Dataset):
    """A layer with a time axis, read one step at a time on its grid."""

    time_varying = True

    @abstractmethod
    def first(self) -> str:
        """First available month, 'YYYY-MM'."""

    @abstractmethod
    def latest(self) -> str:
        """Latest available month, 'YYYY-MM'."""

    @abstractmethod
    def steps(self, start: str, end: str) -> list[str]:
        """Period starts (ISO dates) of the months start..end ('YYYY-MM')."""

    @abstractmethod
    def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """The step that starts on the ISO date `step`, block-averaged by `factor`."""


class RainDataset(SeriesDataset):
    """CHIRPS monthly rain."""

    def first(self) -> str:
        """First available month, 'YYYY-MM'."""
        return FIRST_MONTH

    def latest(self) -> str:
        """Latest available month, 'YYYY-MM'."""
        return self.backend.latest_month()

    def steps(self, start: str, end: str) -> list[str]:
        """Period starts ('YYYY-MM-DD') of the months start..end ('YYYY-MM')."""
        return [f"{month}-01" for month in month_list(start, end)]

    def current_revision(self, last_month: str) -> str | None:
        return self.backend.current_revision(last_month)

    def domain(self, stats: dict[str, float]) -> list[float]:
        return [0, stats["p98"]]

    def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """The month that starts on the ISO date `step`."""
        return self.read_month(step[:7], bbox, factor)

    def read_month(self, month: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """Rain of month 'YYYY-MM' over a grid-aligned bbox, block-averaged by `factor`."""
        columns = self.grid.columns
        col, row, width, height = self.grid.window(bbox)
        col %= columns
        rain = self.backend.read_rain(month, (col, row, min(width, columns - col), height))
        
        if col + width > columns:
            # The window continues past 180 degrees, so the rest is at the west edge of the grid.
            west_edge = self.backend.read_rain(month, (0, row, col + width - columns, height))
            rain = np.hstack([rain, west_edge])

        return block_mean(rain, factor)


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

    def notices(self, bbox: Bbox) -> list[str]:
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

    def _tiles(self, bbox: Bbox) -> list[tuple[str, str]]:
        return terrain_tiles(bbox, terrain_product(terrain_res(bbox)))

    def block_count(self, bbox: Bbox) -> int:
        return terrain_block_count(tuple(bbox))

    def read(
        self,
        bbox: Bbox,
        res: float,
        on_block: Callable[[], None] | None = None,
    ) -> tuple[np.ndarray, Affine]:
        """Elevation over bbox at cell size `res`: (int16 array, transform)."""
        if on_block is None:
            return self.backend.terrain(tuple(bbox), res)

        return self.backend.terrain(tuple(bbox), res, on_block)


def make_registry(backend: RealSource | SyntheticSource) -> Registry:
    """The two datasets, reading through `backend` (RealSource or SyntheticSource)."""
    return {
        "chirps_monthly": RainDataset(
            id="chirps_monthly",
            title="Rainfall",
            units="mm/month",
            resolution_deg=CELL_DEG,
            source=SOURCES["chirps"],
            arrays={"value": "precip"},
            encoding={"value": ("uint16", 0.1, 0, 65535)},
            style={"kind": "series-colormap", "colormap": "Blues"},
            backend=backend,
            grid=CHIRPS_GRID,
            long_name="Monthly precipitation",
            step="P1M",
        ),
        "copdem_terrain": TerrainDataset(
            id="copdem_terrain",
            title="Terrain",
            units="m",
            resolution_deg=GLO30_RES_DEG,
            source=SOURCES["glo30"],
            arrays={"elevation": "elevation", "hillshade": "hillshade"},
            encoding={"elevation": ("int16", 1, 0, None), "hillshade": ("uint8", 1, 0, None)},
            style={"kind": "terrain", "hillshade": {"azimuth": 315, "altitude": 45}},
            backend=backend,
            grid=CHIRPS_GRID,
            max_tiles=2500,
        ),
    }


REGISTRY = make_registry(RealSource())
