"""Data sources: CHIRPS rain, Copernicus GLO-90 terrain, a synthetic stand-in, and licence text.

Rain grid: global CHIRPS 0.05 degree grid, row 0 is the north edge (60N).
Windows are integer (col, row, width, height) cell windows on that grid, so reads are never
resampled.
"""
import math
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
FIRST_MONTH = "1981-01"
NATIVE_TERRAIN_RES = 1 / 1200
TERRAIN_PIXELS = 2048 * 2048
TERRAIN_THREADS = 32
TILE_ROW_OFFSET = 90  # tile index row = lat + 90
TILE_COL_OFFSET = 180  # tile index column = lon + 180
TILE_EDGE_TOLERANCE = 1e-9  # degrees; a bound exactly on a tile edge must not pull in the next tile
CELLS_PER_DEG2_AT_CHIRPS_RES = 400  # (1 / 0.05) ** 2
MAX_TERRAIN_SIDE_PIXELS = 4096
MAX_TERRAIN_DIVISIONS = 60  # 0.05 / 60 is the native 90 m cell
BLOCK_DEG = 2  # terrain is read in blocks of this many whole degrees
CELL_DEG = 0.05  # CHIRPS cell size
HEAD_TIMEOUT_SECONDS = 15
LATEST_MONTH_PROBES = 7
LATEST_TTL_SECONDS = 86400
OFFLINE_LATEST_TTL_SECONDS = 600
OFFLINE_ASSUMED_LAG_MONTHS = 2
TILE_OPEN_ATTEMPTS = 3
TILE_RETRY_DELAY_SECONDS = 1

CHIRPS_URL = ("https://data.chc.ucsb.edu/products/CHIRPS/v3.0/monthly/global/cogs/"
              "chirps-v3.0.{ym}.cog")
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
        "citation": "Funk, C. et al. (2026) The Climate Hazards Center Infrared Precipitation with "
                    "Stations, Version 3. Scientific Data 13, 718. doi:10.1038/s41597-026-07096-4; "
                    "dataset doi:10.15780/G2JQ0P",
        "modified": "negative fill values masked; block-mean aggregation when stated in the layer "
                    "resolution",
    },
    "glo90": {
        "name": "Copernicus DEM GLO-90",
        "version": "2021",
        "licence": "Copernicus WorldDEM™-90 licence (COP-DEM-GLO-90-F, Full, Free & Open)",
        "licence_url": "https://dataspace.copernicus.eu/explore-data/data-collections/"
                       "copernicus-contributing-missions/collections-description/COP-DEM",
        "attribution": "produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and "
                       "© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS "
                       "by the European Union and ESA; all rights reserved",
        "disclaimer": "The organisations in charge of the Copernicus programme by law or by "
                      "delegation do not incur any liability for any use of the Copernicus "
                      "WorldDEM™-90",
        "citation": "doi:10.5270/ESA-c5d3d65",
        "modified": "hillshade (Horn, az 315°, alt 45°) and resampled elevation",
    },
    "geoBoundaries CGAZ": {
        "name": "geoBoundaries CGAZ",
        "licence": "CC BY 4.0",
        "licence_url": "https://www.geoboundaries.org/",
        "attribution": "Boundaries: geoBoundaries (https://www.geoboundaries.org)",
        "citation": "Runfola, D. et al. (2020) geoBoundaries: A global database of political "
                    "administrative boundaries. PLoS ONE 15(4): e0231866. "
                    "https://doi.org/10.1371/journal.pone.0231866",
        "modified": "simplified 0.01°, clipped to 60°S-60°N",
    },
    "synthetic": {
        "name": "Sample areas",
        "licence": "none (hand-drawn sample)",
        "attribution": "Boundaries: hand-drawn sample shapes, not real borders",
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


def _previous_month(year, month):
    return (year - 1, 12) if month == 1 else (year, month - 1)


@lru_cache
def _tile_index():
    """180 x 360 bool grid of the tiles that exist in the GLO-90 bucket.

    The row is lat + 90 and the column is lon + 180.
    """
    packed = np.frombuffer((Path(__file__).parent / "glo90_tiles.bin").read_bytes(), "uint8")
    return np.unpackbits(packed).reshape(180, 360).astype(bool)


def glo90_tiles(bounds):
    """Names of the existing GLO-90 tiles covering bounds (W, S, E, N).

    Tiles are 1 degree and named by their south-west corner. Longitudes above 180 wrap, so bounds
    may cross the antimeridian.
    """
    west, south, east, north = bounds
    tile_exists = _tile_index()
    names = []
    first_lat = max(math.floor(south + TILE_EDGE_TOLERANCE), -TILE_ROW_OFFSET)
    last_lat = min(math.ceil(north - TILE_EDGE_TOLERANCE), TILE_ROW_OFFSET)
    for lat in range(first_lat, last_lat):
        for lon in range(
            math.floor(west + TILE_EDGE_TOLERANCE), math.ceil(east - TILE_EDGE_TOLERANCE)
        ):
            lon = (lon + TILE_COL_OFFSET) % 360 - TILE_COL_OFFSET
            if tile_exists[lat + TILE_ROW_OFFSET, lon + TILE_COL_OFFSET]:
                north_south = "N" if lat >= 0 else "S"
                east_west = "E" if lon >= 0 else "W"
                names.append(
                    f"Copernicus_DSM_COG_30_{north_south}{abs(lat):02d}"
                    f"_00_{east_west}{abs(lon):03d}_00_DEM"
                )
    return names


def terrain_res(bounds):
    """Terrain cell size 0.05 / k degrees, so whole degrees are a whole number of cells.

    It gives about 4.2 Mpx and at most 4096 px on the long side, never finer than native.
    """
    west, south, east, north = bounds
    width, height = east - west, north - south
    divisions = min(
        math.isqrt(int(TERRAIN_PIXELS / (CELLS_PER_DEG2_AT_CHIRPS_RES * width * height))),
        int(MAX_TERRAIN_SIDE_PIXELS * CELL_DEG / max(width, height)),
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


def _head(url):
    """(exists, Last-Modified) for a URL; (False, None) on 404 or any network error."""
    try:
        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=HEAD_TIMEOUT_SECONDS) as response:
            return True, response.headers.get("Last-Modified")
    except (urllib.error.URLError, OSError):
        return False, None


def _chirps_url(month):
    return CHIRPS_URL.format(ym=month.replace("-", "."))


class SourceUnavailable(RuntimeError):
    """The remote data server could not be reached; the API turns this into a 503."""


class RealSource:
    """CHIRPS COGs and GLO-90 tiles over HTTP."""

    def __init__(self, latest=None):
        # An optional fixed 'YYYY-MM' (SOE_LATEST); otherwise the latest month is probed and cached.
        self._latest = latest
        self._probed = None

    def latest_month(self):
        if self._latest:
            return self._latest
        if self._probed and time.time() < self._probed[1]:
            return self._probed[0]

        now = datetime.now(timezone.utc)
        found = self._probe_latest_month(now)
        ttl = LATEST_TTL_SECONDS
        if found is None:
            # Offline: assume the usual two-month lag, and probe again soon.
            found = self._assumed_latest_month(now)
            ttl = OFFLINE_LATEST_TTL_SECONDS
        self._probed = (found, time.time() + ttl)
        return found

    def _probe_latest_month(self, now):
        year, month = now.year, now.month
        for _ in range(LATEST_MONTH_PROBES):
            candidate = f"{year:04d}-{month:02d}"
            if _head(_chirps_url(candidate))[0]:
                return candidate
            year, month = _previous_month(year, month)
        return None

    def _assumed_latest_month(self, now):
        year, month = now.year, now.month
        for _ in range(OFFLINE_ASSUMED_LAG_MONTHS):
            year, month = _previous_month(year, month)
        return f"{year:04d}-{month:02d}"

    def vintage(self, month):
        """Last-Modified of a month's file; changes when CHC revises a recent month."""
        last_modified = _head(_chirps_url(month))[1]
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
            west, east = west - 360, east - 360

        padded_bounds = with_margin((west, south, east, north), res)
        names = glo90_tiles(padded_bounds)
        if not names:
            return None

        with ExitStack() as open_tiles:
            tiles = [open_tiles.enter_context(_open_tile(GLO90_URL.format(n=name)))
                     for name in names]
            with rasterio.Env(**GDAL_OPTS):
                merged, _ = merge(tiles, bounds=padded_bounds, res=res, nodata=0)

        elevation = _crop_margin(merged[0], bounds, res)
        if east == 180:
            # Tiles are half a pixel off-grid and the next tile is across the seam.
            elevation[:, -1] = elevation[:, -2]
        return elevation


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
            time.sleep(TILE_RETRY_DELAY_SECONDS)


class SyntheticSource:
    """Deterministic fake data, no network. `reads` counts rain reads (tests use it)."""

    def __init__(self, latest="2026-08"):
        self._latest = latest
        self.reads = 0

    def latest_month(self):
        return self._latest

    def vintage(self, month):
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

    def vintage(self, last_month):
        """A string that changes when the source revises `last_month`, or None."""
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
        return [f"{ym}-01" for ym in month_list(start, end)]

    def vintage(self, last_month):
        return self.backend.vintage(last_month)

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
        if res > NATIVE_TERRAIN_RES * (1 + 1e-9):
            return f"Terrain resampled to {round(res * 111320)} m cells (source 90 m)."

    def read(self, bbox, res):
        """Elevation over bbox at cell size `res`: (int16 array, transform)."""
        return self.backend.terrain(tuple(bbox), res)


def make_registry(backend):
    """The two datasets, reading through `backend` (RealSource or SyntheticSource)."""
    return {
        "chirps_monthly": RainDataset(
            "chirps_monthly", "Rainfall", "mm/month", CELL_DEG, True, SOURCES["chirps"],
            {"value": "precip"}, {"value": ("uint16", 0.1, 0, 65535)},
            {"kind": "series-colormap", "colormap": "Blues"}, backend,
            long_name="Monthly precipitation", step="P1M"),
        "glo90_terrain": TerrainDataset(
            "glo90_terrain", "Terrain", "m", NATIVE_TERRAIN_RES, False, SOURCES["glo90"],
            {"elevation": "elevation", "hillshade": "hillshade"},
            {"elevation": ("int16", 1, 0, None), "hillshade": ("uint8", 1, 0, None)},
            {"kind": "terrain", "hillshade": {"azimuth": 315, "altitude": 45}}, backend,
            max_tiles=2500),
    }


REGISTRY = make_registry(RealSource())
