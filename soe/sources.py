"""Data sources: CHIRPS rain, Copernicus GLO-90 terrain, a synthetic stand-in, and licence text.

Rain grid: global CHIRPS 0.05 degree grid, row 0 is the north edge (60N).
Windows are integer (col, row, width, height) cell windows on that grid, so reads are never
resampled.
"""
import math
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
from rasterio.merge import merge
from rasterio.transform import Affine, from_origin
from rasterio.windows import Window

GRID = Affine(0.05, 0, -180, 0, -0.05, 60)
NCOLS, NROWS = 7200, 2400
CELL_DEG = 0.05  # CHIRPS cell size
CELLS_PER_DEG2_AT_CHIRPS_RES = 400  # (1 / 0.05) ** 2
FIRST_MONTH = "1981-01"
WORLD_WIDTH_DEG = 360

NATIVE_TERRAIN_RES_DEG = 1 / 1200
NATIVE_RES_TOLERANCE = 1e-9  # relative; coarser than this counts as resampled
LONGITUDE_DEGREE_AT_EQUATOR_M = 111_320  # for the notice's approximate cell size
TERRAIN_BUDGET_PX = 2048 * 2048
MAX_TERRAIN_SIDE_PX = 4096
MAX_TERRAIN_DIVISIONS = 60  # 0.05 / 60 is the native 90 m cell
BLOCK_DEG = 2  # terrain is read in blocks of this many whole degrees
TERRAIN_THREADS = 32

GLO90_TILE_INDEX = Path(__file__).parent / "data" / "glo90_tiles.bin"
TILE_GRID_SHAPE = (180, 360)
TILE_ROW_OFFSET_DEG = 90  # tile index row = lat + 90
TILE_COL_OFFSET_DEG = 180  # tile index column = lon + 180
TILE_EDGE_TOLERANCE_DEG = 1e-9  # a bound exactly on a tile edge must not pull in the next tile
TILE_OPEN_ATTEMPTS = 3
TILE_RETRY_DELAY_SECS = 1

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
GLO90_URL = "https://copernicus-dem-90m.s3.amazonaws.com/{n}/{n}.tif"
GDAL_OPTS = {
    "GDAL_HTTP_MAX_RETRY": "5",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".cog,.tif",
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
        "modified": "hillshade (Horn, az 315°, alt 45°) and resampled elevation",
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


def month_list(start, end):
    """'YYYY-MM' strings from start to end inclusive."""
    year, month = int(start[:4]), int(start[5:7])
    months = []
    while f"{year:04d}-{month:02d}" <= end:
        months.append(f"{year:04d}-{month:02d}")
        year, month = _next_month(year, month)
    return months


def _next_month(year, month):
    return (year + 1, 1) if month == 12 else (year, month + 1)


def glo90_tiles(bounds):
    """Names of the existing GLO-90 tiles covering bounds (W, S, E, N).

    Tiles are 1 degree and named by their south-west corner. Longitudes above 180 wrap, so bounds
    may cross the antimeridian.
    """
    west, south, east, north = bounds
    tile_exists = _tile_index()
    names = []
    first_lat = max(math.floor(south + TILE_EDGE_TOLERANCE_DEG), -TILE_ROW_OFFSET_DEG)
    last_lat = min(math.ceil(north - TILE_EDGE_TOLERANCE_DEG), TILE_ROW_OFFSET_DEG)
    for lat in range(first_lat, last_lat):
        for lon in range(
            math.floor(west + TILE_EDGE_TOLERANCE_DEG), math.ceil(east - TILE_EDGE_TOLERANCE_DEG)
        ):
            lon = (lon + TILE_COL_OFFSET_DEG) % WORLD_WIDTH_DEG - TILE_COL_OFFSET_DEG
            if tile_exists[lat + TILE_ROW_OFFSET_DEG, lon + TILE_COL_OFFSET_DEG]:
                north_south = "N" if lat >= 0 else "S"
                east_west = "E" if lon >= 0 else "W"
                names.append(
                    f"Copernicus_DSM_COG_30_{north_south}{abs(lat):02d}"
                    f"_00_{east_west}{abs(lon):03d}_00_DEM"
                )
    return names


@lru_cache
def _tile_index():
    """180 x 360 bool grid of the tiles that exist in the GLO-90 bucket.

    The row is lat + 90 and the column is lon + 180.
    """
    packed = np.frombuffer(GLO90_TILE_INDEX.read_bytes(), "uint8")
    return np.unpackbits(packed).reshape(TILE_GRID_SHAPE).astype(bool)


def terrain_res(bounds):
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


def with_margin(bounds, res):
    """Bounds grown by one pixel.

    GLO-90 tiles are half a pixel off-grid, so the margin is cropped after merging.
    """
    west, south, east, north = bounds
    return (west - res, south - res, east + res, north + res)


def terrain_by_blocks(bounds, res, read_block):
    """Terrain on bounds, read in parallel in blocks of whole degrees, so no block crosses 180.

    read_block(block_bounds, res) returns an array, or None for a block without terrain (left at 0).
    """
    west, south, east, north = bounds
    height, width = round((north - south) / res), round((east - west) / res)
    x_edges = _block_edges(west, east)
    y_edges = _block_edges(south, north)
    blocks = [
        (x0, y0, x1, y1)
        for x0, x1 in zip(x_edges, x_edges[1:])
        for y0, y1 in zip(y_edges, y_edges[1:])
    ]
    with ThreadPoolExecutor(TERRAIN_THREADS) as executor:
        parts = list(executor.map(lambda block: read_block(block, res), blocks))

    elevation = np.zeros((height, width), "int16")
    for (x0, y0, _, y1), part in zip(blocks, parts):
        if part is not None:
            row, col = round((north - y1) / res), round((x0 - west) / res)
            elevation[row:row + part.shape[0], col:col + part.shape[1]] = part
    return elevation, from_origin(west, north, res, res)


def _block_edges(low, high):
    """low, every multiple of BLOCK_DEG strictly between, then high."""
    first_multiple = math.floor(low / BLOCK_DEG) * BLOCK_DEG + BLOCK_DEG
    return [low] + list(range(first_multiple, math.ceil(high), BLOCK_DEG)) + [high]


class SourceUnavailable(RuntimeError):
    """The remote data server could not be reached; the API turns this into a 503."""


class RealSource:
    """CHIRPS COGs and GLO-90 tiles over HTTP."""

    def __init__(self, latest=None):
        # An optional fixed 'YYYY-MM' (SOE_LATEST); otherwise the latest month is probed and cached.
        self._latest = latest
        self._probed = None
        self._probe_lock = threading.Lock()

    def latest_month(self):
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

    def _probe_latest_month(self, now):
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

    def _assumed_latest_month(self, now):
        year, month = now.year, now.month
        for _ in range(OFFLINE_ASSUMED_LAG_MONTHS):
            year, month = _previous_month(year, month)
        return f"{year:04d}-{month:02d}"

    def current_revision(self, month):
        """Last-Modified date of the month's CHIRPS file.

        It changes whenever CHC republishes (revises) that month's data.
        """
        last_modified = _head(_chirps_url(month), REVISION_TIMEOUT_SECS)[1]
        if not last_modified:
            raise SourceUnavailable("CHIRPS server did not answer")

        return last_modified

    def read_rain(self, month, window):
        """One month at native resolution as float32; fill values (< 0) become NaN."""
        col, row, width, height = window

        with rasterio.Env(**GDAL_OPTS):
            with rasterio.open(_chirps_url(month)) as dataset:
                if (dataset.width, dataset.height) != (NCOLS, NROWS):
                    raise RuntimeError(f"unexpected CHIRPS grid {dataset.width}x{dataset.height}")
                rain = dataset.read(1, window=Window(col, row, width, height)).astype("float32")

        rain[rain < 0] = np.nan
        return rain

    def terrain(self, bounds, res):
        """Elevation (int16) on bounds at res; ocean (no tile) is 0. Returns (array, transform)."""
        return terrain_by_blocks(bounds, res, self._merge)

    def _merge(self, bounds, res):
        """One block: merged elevation, or None if no tile exists there.

        Bounds above 180 read the tiles west of it.
        """
        west, south, east, north = bounds
        if west >= 180:
            west, east = west - WORLD_WIDTH_DEG, east - WORLD_WIDTH_DEG

        padded_bounds = with_margin((west, south, east, north), res)
        names = glo90_tiles(padded_bounds)
        if not names:
            return None

        with ExitStack() as open_tiles:
            tiles = [
                open_tiles.enter_context(_open_tile(GLO90_URL.format(n=name)))
                for name in names
            ]
            with rasterio.Env(**GDAL_OPTS):
                merged, _ = merge(tiles, bounds=padded_bounds, res=res, nodata=0)

        elevation = _crop_margin(merged[0], bounds, res)
        if east == 180:
            # Tiles are half a pixel off-grid and the next tile is across the seam.
            elevation[:, -1] = elevation[:, -2]
        return elevation


def _previous_month(year, month):
    return (year - 1, 12) if month == 1 else (year, month - 1)


def _chirps_url(month):
    return CHIRPS_URL.format(ym=month.replace("-", "."))


def _head(url, timeout=HEAD_TIMEOUT_SECS):
    """(exists, Last-Modified) for a URL: (False, None) on 404, (None, None) if unreachable."""
    try:
        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return True, response.headers.get("Last-Modified")
    except urllib.error.HTTPError as error:
        return (False if error.code == 404 else None), None
    except (urllib.error.URLError, OSError):
        return None, None


def _crop_margin(merged, bounds, res):
    """Elevation of `bounds` as int16, cropped from the merge that had a one-pixel margin."""
    west, south, east, north = bounds
    height, width = round((north - south) / res), round((east - west) / res)
    elevation = np.rint(merged[1:1 + height, 1:1 + width]).clip(-32768, 32767)
    return elevation.astype("int16")


def _open_tile(url):
    """Open one GLO-90 tile, retrying a few times because the bucket drops connections."""
    for attempt in range(1, TILE_OPEN_ATTEMPTS + 1):
        try:
            with rasterio.Env(**GDAL_OPTS):
                return rasterio.open(url)
        except RasterioIOError:
            if attempt == TILE_OPEN_ATTEMPTS:
                raise
            time.sleep(TILE_RETRY_DELAY_SECS)


class SyntheticSource:
    """Deterministic fake data, no network. `reads` counts rain reads (tests use it)."""

    def __init__(self, latest="2026-08"):
        self._latest = latest
        self.reads = 0

    def latest_month(self):
        return self._latest

    def current_revision(self, month):
        return "synthetic"

    def read_rain(self, month, window):
        self.reads += 1
        col, row, width, height = window
        month_number = int(month[:4]) * 12 + int(month[5:7])
        cols, rows = np.meshgrid(np.arange(col, col + width), np.arange(row, row + height))

        rain = 100 + 80 * np.sin(cols / 15 + month_number * 0.5) * np.cos(rows / 11)
        rain = rain.astype("float32")
        rain[(cols * 7 + rows * 13) % 11 == 0] = np.nan  # Holes, to exercise NaN-aware means.
        return rain

    def terrain(self, bounds, res):
        west, south, east, north = bounds
        width, height = round((east - west) / res), round((north - south) / res)
        transform = from_origin(west, north, res, res)

        cols, rows = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
        lon, lat = transform @ (cols, rows)
        elevation = 1000 + 800 * np.sin(lon * 20) * np.cos(lat * 20)
        return elevation.astype("int16"), transform


def block_mean(values, factor):
    """NaN-aware factor x factor block mean (shape must be divisible by factor)."""
    if factor == 1:
        return values

    height, width = values.shape
    blocks = values.reshape(height // factor, factor, width // factor, factor)
    valid = ~np.isnan(blocks)
    counts = valid.sum(axis=(1, 3))
    sums = np.where(valid, blocks, 0).sum(axis=(1, 3), dtype="float64")

    return np.where(counts > 0, sums / np.maximum(counts, 1), np.nan).astype("float32")


def window_of(bbox):
    """Integer (col, row, width, height) window on the global rain grid for a grid-aligned bbox."""
    west, south, east, north = bbox
    col, row = round((west + 180) / CELL_DEG), round((60 - north) / CELL_DEG)
    return col, row, round((east - west) / CELL_DEG), round((north - south) / CELL_DEG)


@dataclass
class Dataset:
    """A layer the backend can build.

    Static datasets implement read(bbox, res) -> (2D array, transform). Time-varying ones implement
    first(), latest(), steps(start, end) and read_step(step, bbox, factor).
    """

    id: str
    title: str
    units: str
    resolution_deg: float  # native cell size
    time_varying: bool
    source: dict  # licence, licence_url, attribution, citation, modified, version, ...
    arrays: dict  # role -> data array name inside the Zarr group `id`
    encoding: dict  # role -> (stored dtype, scale_factor, add_offset, fill value or None)
    style: dict  # viewer defaults
    backend: object
    long_name: str = ""  # CF long_name of the main array
    coverage: tuple = (-180, -60, 180, 60)  # W, S, E, N
    anchor_res: float = 0.05  # the layer's window is cut on a grid of this cell size
    step: str | None = None  # ISO 8601 duration between time steps; None for static layers
    max_tiles: int | None = None  # request cap for tiled datasets

    def tile_count(self, bbox):
        """Number of source tiles a read of bbox needs (0 for untiled data)."""
        return 0

    def res_for(self, bbox):
        """Cell size of a static layer over bbox."""
        return self.resolution_deg

    def current_revision(self, last_month):
        """The provider's current revision marker of `last_month`, or None for static data.

        A revision is a string that changes whenever the provider republishes that month's
        data. It is part of the scene id, so revised data gets a new scene.
        """
        return None

    def domain(self, stats):
        """Colour-scale range of a series layer, from the stats of its values."""
        return [stats["min"], stats["p98"]]

    def notice(self, bbox):
        """A limits notice for a read of bbox, or None."""
        return None


class RainDataset(Dataset):
    """CHIRPS monthly rain."""

    def first(self):
        """First available month, 'YYYY-MM'."""
        return FIRST_MONTH

    def latest(self):
        """Latest available month, 'YYYY-MM'."""
        return self.backend.latest_month()

    def steps(self, start, end):
        """Period starts ('YYYY-MM-DD') of the months start..end ('YYYY-MM')."""
        return [f"{month}-01" for month in month_list(start, end)]

    def current_revision(self, last_month):
        return self.backend.current_revision(last_month)

    def domain(self, stats):
        return [0, stats["p98"]]

    def read_step(self, step, bbox, factor=1):
        """The month that starts on the ISO date `step`."""
        return self.read_month(step[:7], bbox, factor)

    def read_month(self, month, bbox, factor=1):
        """Rain of month 'YYYY-MM' over a grid-aligned bbox, block-averaged by `factor`."""
        col, row, width, height = window_of(bbox)
        col %= NCOLS
        rain = self.backend.read_rain(month, (col, row, min(width, NCOLS - col), height))
        
        if col + width > NCOLS:
            # The window continues past 180 degrees, so the rest is at the west edge of the grid.
            west_edge = self.backend.read_rain(month, (0, row, col + width - NCOLS, height))
            rain = np.hstack([rain, west_edge])

        return block_mean(rain, factor)


class TerrainDataset(Dataset):
    """Copernicus GLO-90 elevation, read at a resolution that depends on the area size."""

    def tile_count(self, bbox):
        return len(glo90_tiles(with_margin(bbox, terrain_res(bbox))))

    def res_for(self, bbox):
        return terrain_res(bbox)

    def notice(self, bbox):
        res = terrain_res(bbox)
        if res > NATIVE_TERRAIN_RES_DEG * (1 + NATIVE_RES_TOLERANCE):
            cell_size_m = round(res * LONGITUDE_DEGREE_AT_EQUATOR_M)
            return f"Terrain resampled to {cell_size_m} m cells (source 90 m)."

    def read(self, bbox, res):
        """Elevation over bbox at cell size `res`: (int16 array, transform)."""
        return self.backend.terrain(tuple(bbox), res)


def make_registry(backend):
    """The two datasets, reading through `backend` (RealSource or SyntheticSource)."""
    return {
        "chirps_monthly": RainDataset(
            id="chirps_monthly",
            title="Rainfall",
            units="mm/month",
            resolution_deg=CELL_DEG,
            time_varying=True,
            source=SOURCES["chirps"],
            arrays={"value": "precip"},
            encoding={"value": ("uint16", 0.1, 0, 65535)},
            style={"kind": "series-colormap", "colormap": "Blues"},
            backend=backend,
            long_name="Monthly precipitation",
            step="P1M",
        ),
        "glo90_terrain": TerrainDataset(
            id="glo90_terrain",
            title="Terrain",
            units="m",
            resolution_deg=NATIVE_TERRAIN_RES_DEG,
            time_varying=False,
            source=SOURCES["glo90"],
            arrays={"elevation": "elevation", "hillshade": "hillshade"},
            encoding={"elevation": ("int16", 1, 0, None), "hillshade": ("uint8", 1, 0, None)},
            style={"kind": "terrain", "hillshade": {"azimuth": 315, "altitude": 45}},
            backend=backend,
            max_tiles=2500,
        ),
    }


REGISTRY = make_registry(RealSource())
