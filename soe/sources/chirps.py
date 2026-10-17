"""CHIRPS monthly rain: the dataset, its grid and the reader of the COGs."""
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np
import rasterio
from rasterio.windows import Window

from .datasets import SeriesDataset
from .grid import CELL_DEG, Bbox, CellWindow, Grid, block_mean
from .months import month_list, previous_month
from .remote import GDAL_OPTS, SourceUnavailable

FIRST_MONTH = "1981-01"

CHIRPS_GRID = Grid(-180, 60, CELL_DEG, 7200, 2400)

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


class ChirpsReader:
    """CHIRPS monthly COGs over HTTP."""

    def __init__(self, latest: str | None = None) -> None:
        # An optional fixed 'YYYY-MM' (SOE_LATEST); otherwise the latest month is probed and cached.
        self._latest = latest
        self._probed = None  # (month, expiry time) of the last probe
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
            year, month = previous_month(year, month)

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
            year, month = previous_month(year, month)
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
