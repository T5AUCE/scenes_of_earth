"""Download CHIRPS monthly COGs serially and store them in the local cube.

The ingest probes forward from storage until the first missing month, re-checks the last year
plus the first month for revisions and downloads one file at a time because the server throttles
bursts. Each calendar year is published on its own, so an interrupted run continues after the
last stored month.
"""
import logging
import time
from collections.abc import Iterator
from datetime import datetime, timezone
from email.message import Message
from email.utils import parsedate_to_datetime
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
import rasterio

from .cube_ingest import (
    DOWNLOADS_DIR,
    RESOLUTION_TOLERANCE_DEG,
    MonthField,
    _batches,
    _cube_attrs,
    _months_between,
    _newest_month,
    _next_month,
    _previous_month,
    write_months,
)
from .sources.chirps import CHIRPS_CUBE, CHIRPS_URL, FIRST_MONTH
from .sources.cubes import FINAL_EXPVER, CubeSpec
from .sources.grid import Grid

HEAD_TIMEOUT_SECS = 30
DOWNLOAD_TIMEOUT_SECS = 2 * 60

MAX_ATTEMPTS = 6
BACKOFF_SECS = (2, 4, 8, 16, 32)

REVISION_MONTHS = 12

SOURCE_MODIFIED_ATTR = "source_modified"

log = logging.getLogger("soe")


def ingest(
    cube_dir: Path | str,
    start_month: str,
    cube: CubeSpec = CHIRPS_CUBE,
) -> None:
    """Add CHIRPS months from `start_month` to the cube, refreshing revised ones.

    The first run starts at `start_month`; later runs continue after the last stored month and
    re-check the last year plus the first month for revisions. Each calendar year is published on
    its own, so an interrupted run continues after the last stored month.
    """
    cube_dir = Path(cube_dir)
    stored, source_modified, pending = _stored_state(cube_dir, cube)
    newest = _newest_month()
    new_months, first_unpublished = _probe_new_months(stored, start_month, newest)
    refetch = _revision_months(stored, source_modified)
    earlier = _months_between(start_month, _previous_month(min(stored))) if stored else []
    wanted = sorted({*new_months, *refetch, *earlier, *pending})
    if not wanted:
        return

    pending_newest = first_unpublished or _next_month(newest)
    batches = _batches(wanted, pending_newest, min(stored, default=None))
    downloads = cube_dir / DOWNLOADS_DIR
    downloads.mkdir(parents=True, exist_ok=True)
    for batch in batches:
        log.info("%s: ingesting %s to %s", cube.title, batch[0], batch[-1])
        _ingest_batch(cube_dir, cube, batch, downloads)


def _stored_state(
    cube_dir: Path,
    cube: CubeSpec,
) -> tuple[dict[str, str], dict[str, str], list[str]]:
    """Return stored markers, Last-Modified dates and pending months, empty when missing."""
    stored_attrs = _cube_attrs(cube_dir, cube)
    return (
        dict(stored_attrs.get("months", {})),
        dict(stored_attrs.get(SOURCE_MODIFIED_ATTR, {})),
        list(stored_attrs.get("pending", [])),
    )


def _probe_new_months(
    stored: dict[str, str],
    start_month: str,
    newest: str,
) -> tuple[list[str], str | None]:
    """Return months published after storage and the first month that is not yet published.

    Probe forward serially because the server throttles bursts. A trailing run of missing months
    ends the probe, while a missing month before a published one means the archive has a gap.
    """
    first = _next_month(max(stored)) if stored else start_month
    candidates = _months_between(first, newest)
    exists_by_month = {}
    for month in candidates:
        exists, _ = _head_month(month)
        exists_by_month[month] = exists

    published = [month for month in candidates if exists_by_month[month]]
    first_unpublished = None
    for month in reversed(candidates):
        if exists_by_month[month]:
            break

        first_unpublished = month

    if not stored and candidates and not published:
        raise ValueError(f"{first} is missing, so the archive has a gap")

    for month in candidates:
        missing_before_end = not exists_by_month[month] and (
            first_unpublished is None or month < first_unpublished
        )
        if missing_before_end:
            raise ValueError(f"{month} is missing, so the archive has a gap")

    return published, first_unpublished


def _revision_months(
    stored: dict[str, str],
    source_modified: dict[str, str],
) -> list[str]:
    """Return stored months whose Last-Modified changed, checking the last year plus the first.

    The first month stands in for the whole archive because a republish stamps it as well.
    """
    if not stored:
        return []

    recent = sorted(stored)[-REVISION_MONTHS:]
    candidates = sorted({*recent, FIRST_MONTH} & set(stored))
    refetch = []
    for month in candidates:
        exists, last_modified = _head_month(month)
        if not exists:
            raise ValueError(f"{month} is missing, so the archive has a gap")

        if last_modified is None:
            continue

        if source_modified.get(month) != last_modified:
            refetch.append(month)

    return refetch


def _ingest_batch(
    cube_dir: Path,
    cube: CubeSpec,
    batch: list[str],
    downloads: Path,
) -> None:
    """Download one year batch, check it and publish it with its Last-Modified dates."""
    targets = {month: downloads / f"{cube.name}-{month}.cog" for month in batch}
    combined = dict(_cube_attrs(cube_dir, cube).get(SOURCE_MODIFIED_ATTR, {}))
    try:
        fields = _batch_fields(batch, targets, cube, combined)
        write_months(
            cube_dir,
            cube,
            False,
            fields,
            {SOURCE_MODIFIED_ATTR: combined},
        )
    finally:
        for target in targets.values():
            target.unlink(missing_ok=True)


def _batch_fields(
    batch: list[str],
    targets: dict[str, Path],
    cube: CubeSpec,
    combined: dict[str, str],
) -> Iterator[MonthField]:
    """Yield each month after downloading it, recording its Last-Modified date."""
    for month in batch:
        last_modified = _download_month(month, targets[month])
        if last_modified is not None:
            combined[month] = last_modified

        yield _read_cog_month(targets[month], month, cube)


def _download_month(month: str, target: Path) -> str | None:
    """Fetch one COG to `target` with retries and return its Last-Modified date."""
    body, last_modified = _fetch_with_retries(_chirps_url(month))
    target.write_bytes(body)
    return last_modified


def _fetch_with_retries(url: str) -> tuple[bytes, str | None]:
    """GET with retries on throttles, server errors, timeouts and short bodies."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            return _fetch_once(url, DOWNLOAD_TIMEOUT_SECS)
        except HTTPError as error:
            if not _is_retryable_code(error.code) or attempt == MAX_ATTEMPTS - 1:
                raise

            _sleep_before_retry(attempt, error.headers)
        except (URLError, TimeoutError, OSError, IncompleteRead) as error:
            if attempt == MAX_ATTEMPTS - 1:
                raise OSError(f"{url}: {error}") from error

            _sleep_before_retry(attempt, None)


def _fetch_once(url: str, timeout: float) -> tuple[bytes, str | None]:
    """Single GET attempt; short bodies raise for a retry because the server throttles bursts."""
    with urlopen(url, timeout=timeout) as response:
        body = response.read()
        headers = response.headers
        expected = headers.get("Content-Length")
        if expected is not None and len(body) < int(expected):
            raise OSError(f"short body {len(body)} of {expected}")

        return body, headers.get("Last-Modified")


def _read_cog_month(path: Path | str, month: str, cube: CubeSpec) -> MonthField:
    """Return the month's cube-grid values with negative fill masked to NaN."""
    with rasterio.open(path) as dataset:
        _check_grid(dataset, cube.grid)
        values = dataset.read(1).astype("float32")

    values[values < 0] = np.nan
    return month, values, FINAL_EXPVER


def _check_grid(dataset: rasterio.DatasetReader, grid: Grid) -> None:
    """Reject a raster whose edges, size or rotation do not match the cube grid."""
    transform = dataset.transform
    if (dataset.width, dataset.height) != (grid.columns, grid.rows):
        raise ValueError(
            f"expected {grid.columns}x{grid.rows} cells, "
            f"got {dataset.width}x{dataset.height}",
        )

    aligned = (
        abs(transform.a - grid.res) < RESOLUTION_TOLERANCE_DEG
        and abs(transform.e + grid.res) < RESOLUTION_TOLERANCE_DEG
        and abs(transform.b) < RESOLUTION_TOLERANCE_DEG
        and abs(transform.d) < RESOLUTION_TOLERANCE_DEG
        and abs(transform.c - grid.west_deg) < RESOLUTION_TOLERANCE_DEG
        and abs(transform.f - grid.north_deg) < RESOLUTION_TOLERANCE_DEG
    )
    if not aligned:
        raise ValueError(
            f"expected unrotated {grid.res} degree cells from "
            f"{grid.west_deg}E {grid.north_deg}N, got {transform}",
        )


def _chirps_url(month: str) -> str:
    """Return the COG URL of month 'YYYY-MM'."""
    return CHIRPS_URL.format(ym=month.replace("-", "."))


def _head_month(month: str) -> tuple[bool, str | None]:
    """Return whether the month is published and its Last-Modified date, retrying throttles."""
    return _head_with_retries(_chirps_url(month))


def _head_with_retries(url: str) -> tuple[bool, str | None]:
    """HEAD with retries on throttles, server errors and timeouts, honouring Retry-After."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            return _head_once(url, HEAD_TIMEOUT_SECS)
        except HTTPError as error:
            if not _is_retryable_code(error.code) or attempt == MAX_ATTEMPTS - 1:
                raise

            _sleep_before_retry(attempt, error.headers)
        except (URLError, TimeoutError, OSError):
            if attempt == MAX_ATTEMPTS - 1:
                raise

            _sleep_before_retry(attempt, None)


def _head_once(url: str, timeout: float) -> tuple[bool, str | None]:
    """Single HEAD attempt; 404 means missing, throttles and timeouts raise for a retry."""
    try:
        request = Request(url, method="HEAD")
        with urlopen(request, timeout=timeout) as response:
            return True, response.headers.get("Last-Modified")
    except HTTPError as error:
        if error.code == 404:
            return False, None

        raise
    except (URLError, TimeoutError, OSError):
        raise


def _is_retryable_code(code: int) -> bool:
    """Return whether an HTTP status is a throttle or server error that a retry may clear."""
    return code == 429 or 500 <= code <= 599


def _sleep_before_retry(attempt: int, headers: Message | None) -> None:
    """Sleep the backoff for `attempt`, honouring Retry-After when it asks for longer."""
    delay = BACKOFF_SECS[attempt]
    if headers is not None:
        delay = max(delay, _retry_after_delay(headers))

    _sleep(delay)


def _retry_after_delay(headers: Message) -> float:
    """Seconds requested by Retry-After, or zero when it is absent or unparseable."""
    value = headers.get("Retry-After", "")
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        pass
    try:
        date = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return 0
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    return max(0, (date - now).total_seconds())


def _sleep(seconds: float) -> None:
    """Sleep, wrapped so tests run without waiting."""
    time.sleep(seconds)
