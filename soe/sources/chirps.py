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

from .cubes import month_markers, preliminary_runs
from .datasets import SeriesDataset, revision_digest
from .grid import CELL_DEG, Bbox, CellWindow, Grid, block_mean, read_wrapped
from .periods import MONTH_CHARS
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
    """Read CHIRPS monthly rainfall and fill its gaps with ERA5 precipitation."""

    def first(self) -> str:
        """Return the first month held by CHIRPS and the fallback cube as an ISO start date."""
        return f"{max(FIRST_MONTH, next(iter(self.fallback_months())))}-01"

    def latest(self) -> str:
        """Return the last month held by CHIRPS and the fallback cube as an ISO start date."""
        return f"{min(self.backend.latest_month(), list(self.fallback_months())[-1])}-01"

    def remote_revision(self, steps: list[str]) -> str | None:
        """CHIRPS republishes a month as a whole, so its last month's marker stands for all."""
        return self.backend.current_revision(steps[-1][:MONTH_CHARS])

    def local_revision(self, steps: list[str]) -> str | None:
        """Return a hash of the fallback cube markers for exactly the requested months."""
        labels = [step[:MONTH_CHARS] for step in steps]
        return revision_digest(*month_markers(self.fallback_months(), labels))

    def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
        """Return one notice for each run of requested months that are preliminary in the fallback
        cube.
        """
        labels = [step[:MONTH_CHARS] for step in steps]
        runs = preliminary_runs(labels, self.fallback_months())
        return [_preliminary_notice(run[0], run[-1]) for run in runs]

    def stops_floor(self, stats: dict[str, float]) -> float:
        """Rainfall scales start at zero even when the sampled minimum is positive."""
        return 0

    def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """The month that starts on the ISO date `step`."""
        return self.read_month(step[:MONTH_CHARS], bbox, factor)

    def read_month(self, month: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """Rain of month 'YYYY-MM' over a grid-aligned bbox, block-averaged by `factor`."""
        rain = read_wrapped(
            self.grid,
            bbox,
            lambda window: self.backend.read_rain(month, window),
        )
        return block_mean(rain, factor)


class ChirpsReader:
    """CHIRPS monthly COGs over HTTP."""

    def __init__(self, latest: str | None = None) -> None:
        """Use a fixed latest month ('YYYY-MM') or probe and cache it on demand."""
        self._latest = latest
        self._probed = None  # (month, expiry time) of the last probe
        self._probe_lock = threading.Lock()

    def latest_month(self) -> str:
        """Return the fixed or cached latest month, probing when the cache expires."""
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

            ttl_secs = LATEST_TTL_SECS if complete else OFFLINE_LATEST_TTL_SECS
            self._probed = (found, time.time() + ttl_secs)
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

        with rasterio.Env(**GDAL_OPTS), rasterio.open(_chirps_url(month)) as dataset:
            if (dataset.width, dataset.height) != (CHIRPS_GRID.columns, CHIRPS_GRID.rows):
                raise RuntimeError(f"unexpected CHIRPS grid {dataset.width}x{dataset.height}")
            rain = dataset.read(1, window=Window(col, row, width, height)).astype("float32")

        rain[rain < 0] = np.nan
        return rain


def _preliminary_notice(first: str, last: str) -> str:
    period = first if first == last else f"{first} to {last}"
    return (
        f"The ERA5 rain that fills gaps in Rainfall {period} is preliminary; final data "
        "replaces it about two months later, and the scene then gets a new id."
    )


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


def previous_month(year: int, month: int) -> tuple[int, int]:
    """The (year, month) before the given one."""
    return (year - 1, 12) if month == 1 else (year, month - 1)
