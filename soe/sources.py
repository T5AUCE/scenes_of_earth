"""Data sources: CHIRPS rain, Copernicus GLO-90 terrain, a synthetic stand-in, and licence text.

Rain grid: global CHIRPS 0.05 degree grid, row 0 is the north edge (60N).
Windows are integer (col, row, width, height) cell windows on that grid, so reads are never resampled.
"""
import math
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

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

CHIRPS_URL = "https://data.chc.ucsb.edu/products/CHIRPS/v3.0/monthly/global/cogs/chirps-v3.0.{ym}.cog"
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
        "citation": "Funk, C. et al. (2026) The Climate Hazards Center Infrared Precipitation with Stations, "
                    "Version 3. Scientific Data 13, 718. doi:10.1038/s41597-026-07096-4; dataset doi:10.15780/G2JQ0P",
        "modified": "negative fill values masked; block-mean aggregation when stated in the layer resolution",
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
        "disclaimer": "The organisations in charge of the Copernicus programme by law or by delegation "
                      "do not incur any liability for any use of the Copernicus WorldDEM™-90",
        "citation": "doi:10.5270/ESA-c5d3d65",
        "modified": "hillshade (Horn, az 315°, alt 45°) and resampled elevation",
    },
    "geoBoundaries CGAZ": {
        "name": "geoBoundaries CGAZ",
        "licence": "CC BY 4.0",
        "licence_url": "https://www.geoboundaries.org/",
        "attribution": "Boundaries: geoBoundaries (https://www.geoboundaries.org)",
        "citation": "Runfola, D. et al. (2020) geoBoundaries: A global database of political administrative "
                    "boundaries. PLoS ONE 15(4): e0231866. https://doi.org/10.1371/journal.pone.0231866",
        "modified": "simplified 0.01°, clipped to 60°S-60°N",
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
    y, m = int(start[:4]), int(start[5:7])
    out = []
    while f"{y:04d}-{m:02d}" <= end:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def glo90_tiles(bounds):
    """GLO-90 tile names (1 degree, named by the south-west corner) covering bounds (W, S, E, N)."""
    w, s, e, n = bounds
    names = []
    for lat in range(math.floor(s + 1e-9), math.ceil(n - 1e-9)):
        for lon in range(math.floor(w + 1e-9), math.ceil(e - 1e-9)):
            ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
            names.append(f"Copernicus_DSM_COG_30_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM")
    return names


def terrain_res(bounds):
    """Terrain cell size: 2048 px on the long side, but no finer than native."""
    w, s, e, n = bounds
    return max(NATIVE_TERRAIN_RES, max(e - w, n - s) / 2048)


def with_margin(bounds, res):
    """Bounds grown by one pixel: GLO-90 tiles are half a pixel off-grid, so the margin is cropped after merging."""
    w, s, e, n = bounds
    return (w - res, s - res, e + res, n + res)


def _head(url):
    """(exists, Last-Modified) for a URL; (False, None) on 404 or any network error."""
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=15) as r:
            return True, r.headers.get("Last-Modified")
    except (urllib.error.URLError, OSError):
        return False, None


def _is_404(url):
    try:
        urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=15).close()
    except urllib.error.HTTPError as e:
        return e.code == 404
    except OSError:
        pass
    return False


class SourceUnavailable(RuntimeError):
    """The remote data server could not be reached; the API turns this into a 503."""


class RealSource:
    """CHIRPS COGs and GLO-90 tiles over HTTP."""

    def __init__(self, latest=None):
        self._latest = latest  # optional fixed 'YYYY-MM' (SOE_LATEST); else probed and cached for a day
        self._probed = None

    def latest_month(self):
        if self._latest:
            return self._latest
        if self._probed and time.time() - self._probed[1] < 86400:
            return self._probed[0]
        now = datetime.now(timezone.utc)
        y, m = now.year, now.month
        found = None
        for _ in range(7):
            ym = f"{y:04d}-{m:02d}"
            if _head(CHIRPS_URL.format(ym=ym.replace("-", ".")))[0]:
                found = ym
                break
            y, m = (y - 1, 12) if m == 1 else (y, m - 1)
        if found is None:  # offline: assume the usual two-month lag
            y, m = now.year, now.month - 2
            if m < 1:
                y, m = y - 1, m + 12
            found = f"{y:04d}-{m:02d}"
        self._probed = (found, time.time())
        return found

    def vintage(self, ym):
        """Last-Modified of a month's file; changes when CHC revises a recent month."""
        last_modified = _head(CHIRPS_URL.format(ym=ym.replace("-", ".")))[1]
        if not last_modified:
            raise SourceUnavailable("CHIRPS server did not answer")
        return last_modified

    def read_rain(self, ym, win):
        """One month, native resolution, float32; fill values (< 0) become NaN. Opens its own dataset."""
        col, row, w, h = win
        with rasterio.Env(**GDAL_OPTS):
            with rasterio.open(CHIRPS_URL.format(ym=ym.replace("-", "."))) as ds:
                if (ds.width, ds.height) != (NCOLS, NROWS):
                    raise RuntimeError(f"unexpected CHIRPS grid {ds.width}x{ds.height}")
                a = ds.read(1, window=Window(col, row, w, h)).astype("float32")
        a[a < 0] = np.nan
        return a

    def terrain(self, bounds, res):
        """Merged elevation (int16) on bounds at res; missing (ocean) tiles are 0. Returns (array, transform)."""
        w, s, e, n = bounds
        ext = with_margin(bounds, res)
        names = glo90_tiles(ext)

        def open_tile(n):
            url = GLO90_URL.format(n=n)
            for attempt in range(3):
                with rasterio.Env(**GDAL_OPTS):
                    try:
                        return rasterio.open(url)
                    except RasterioIOError:
                        if _is_404(url):  # ocean tiles do not exist: treated as elevation 0
                            return None
                        if attempt == 2:
                            raise
                        time.sleep(1)

        with ThreadPoolExecutor(8) as ex:
            dss = [d for d in ex.map(open_tile, names) if d is not None]
        ny, nx = round((n - s) / res), round((e - w) / res)
        try:
            if not dss:
                return np.zeros((ny, nx), "int16"), from_origin(w, n, res, res)
            with rasterio.Env(**GDAL_OPTS):
                arr, _ = merge(dss, bounds=ext, res=res, nodata=0)
        finally:
            for d in dss:
                d.close()
        z = np.rint(arr[0][1:1 + ny, 1:1 + nx]).clip(-32768, 32767).astype("int16")
        return z, from_origin(w, n, res, res)


class SyntheticSource:
    """Deterministic fake data, no network. `reads` counts rain reads (tests use it)."""

    def __init__(self, latest="2026-08"):
        self._latest = latest
        self.reads = 0

    def latest_month(self):
        return self._latest

    def vintage(self, ym):
        return "synthetic"

    def read_rain(self, ym, win):
        self.reads += 1
        col, row, w, h = win
        mi = int(ym[:4]) * 12 + int(ym[5:7])
        cc, rr = np.meshgrid(np.arange(col, col + w), np.arange(row, row + h))
        a = 100 + 80 * np.sin(cc / 15 + mi * 0.5) * np.cos(rr / 11)
        a = a.astype("float32")
        a[(cc * 7 + rr * 13) % 11 == 0] = np.nan  # holes, to exercise NaN-aware means
        return a

    def terrain(self, bounds, res):
        w, s, e, n = bounds
        nx, ny = round((e - w) / res), round((n - s) / res)
        tr = from_origin(w, n, res, res)
        cc, rr = np.meshgrid(np.arange(nx) + 0.5, np.arange(ny) + 0.5)
        lon, lat = tr @ (cc, rr)
        z = 1000 + 800 * np.sin(lon * 20) * np.cos(lat * 20)
        return z.astype("int16"), tr


def block_mean(a, f):
    """NaN-aware f x f block mean (shape must be divisible by f)."""
    if f == 1:
        return a
    h, w = a.shape
    b = a.reshape(h // f, f, w // f, f)
    ok = ~np.isnan(b)
    n = ok.sum(axis=(1, 3))
    s = np.where(ok, b, 0).sum(axis=(1, 3), dtype="float64")
    return np.where(n > 0, s / np.maximum(n, 1), np.nan).astype("float32")


def window_of(bbox):
    """Integer (col, row, width, height) window on the global rain grid for a grid-aligned bbox."""
    w, s, e, n = bbox
    c0, r0 = round((w + 180) / 0.05), round((60 - n) / 0.05)
    return c0, r0, round((e - w) / 0.05), round((n - s) / 0.05)


@dataclass
class Dataset:
    """A layer the backend can build. Static datasets implement read(bbox) -> (2D array, transform);
    time-varying ones are read month by month with read_month()."""
    id: str
    units: str
    resolution_deg: float  # native cell size
    time_varying: bool
    source: dict  # licence, licence_url, attribution, citation, modified, version, ...
    arrays: tuple  # data array names inside the Zarr group `id`
    style: dict  # viewer defaults
    backend: object
    max_tiles: int | None = None  # request cap for tiled datasets

    def tile_count(self, bbox):
        return 0

    def vintage(self, last_month):
        return None


class RainDataset(Dataset):
    def vintage(self, last_month):
        return self.backend.vintage(last_month)

    def read_month(self, ym, bbox, factor=1):
        return block_mean(self.backend.read_rain(ym, window_of(bbox)), factor)


class TerrainDataset(Dataset):
    def tile_count(self, bbox):
        return len(glo90_tiles(with_margin(bbox, terrain_res(bbox))))

    def read(self, bbox):
        return self.backend.terrain(tuple(bbox), terrain_res(bbox))


def make_registry(backend):
    """The two datasets, reading through `backend` (RealSource or SyntheticSource)."""
    return {
        "chirps_monthly": RainDataset(
            "chirps_monthly", "mm/month", 0.05, True, SOURCES["chirps"], ("precip",),
            {"colormap": "Blues", "domain_min": 0}, backend),
        "glo90_terrain": TerrainDataset(
            "glo90_terrain", "m", NATIVE_TERRAIN_RES, False, SOURCES["glo90"], ("elevation", "hillshade"),
            {"hillshade": {"azimuth": 315, "altitude": 45}}, backend, max_tiles=100),
    }


REGISTRY = make_registry(RealSource())  # tests use make_registry(SyntheticSource())
