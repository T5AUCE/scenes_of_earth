"""Test CHIRPS cube ingestion offline with a small grid and fake HTTP.

Check trailing-month probing, revision re-checks, grid checks and retries.
"""
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError

import numpy as np
import pytest
import rasterio
import zarr
from rasterio.transform import from_origin

from soe.ingest import chirps
from soe.ingest.chirps import SOURCE_MODIFIED_ATTR, ingest
from soe.sources import CHIRPS_CUBE
from soe.sources.cubes import CubeStore
from soe.sources.grid import Grid

TEST_GRID = Grid(-180, 60, 0.05, 10, 5)
TEST_CUBE = CHIRPS_CUBE._replace(grid=TEST_GRID)

FIRST_LAST_MODIFIED = "Wed, 25 Feb 2025 00:00:00 GMT"
SECOND_LAST_MODIFIED = "Thu, 15 May 2025 00:00:00 GMT"

JAN_MM = 10.0
FEB_MM = 20.0


def chirps_field(value: float) -> np.ndarray:
    """Return a test-grid field filled with `value`."""
    return np.full((TEST_GRID.rows, TEST_GRID.columns), value, "float32")


def write_chirps_raster(
    path: Path,
    values: np.ndarray,
    west_edge: float = -180,
    north_edge: float = 60,
    res: float = 0.05,
) -> None:
    """Write one-band test values as a GeoTIFF with the CHIRPS edge alignment."""
    profile = {
        "driver": "GTiff",
        "width": values.shape[1],
        "height": values.shape[0],
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": from_origin(west_edge, north_edge, res, res),
    }
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(values.astype("float32"), 1)


def fake_head_factory(
    exists: dict[str, bool],
    modified: dict[str, str],
) -> Callable[[str], tuple[bool, str | None]]:
    """Return a fake `_head_month` serving `exists` and Last-Modified dates."""

    def fake_head(month: str) -> tuple[bool, str | None]:
        return exists.get(month, False), modified.get(month)

    return fake_head


def fake_download_factory(
    values_by_month: dict[str, np.ndarray],
    modified: dict[str, str],
) -> Callable[[str, Path], str | None]:
    """Return a fake `_download_month` writing test rasters and Last-Modified dates."""

    def fake_download(month: str, target: Path) -> str | None:
        write_chirps_raster(target, values_by_month[month])
        return modified.get(month)

    return fake_download


def stored_months(cubes_dir: Path) -> dict[str, str]:
    """Return the markers of the test CHIRPS cube."""
    return CubeStore((TEST_CUBE,), cubes_dir).cube_months(TEST_CUBE)


def test_chirps_ingest_stops_at_the_first_unpublished_trailing_month(tmp_path, monkeypatch):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-03")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory(
            {"1981-01": True, "1981-02": True},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": FIRST_LAST_MODIFIED},
        ),
    )
    monkeypatch.setattr(
        chirps,
        "_download_month",
        fake_download_factory(
            {"1981-01": chirps_field(JAN_MM), "1981-02": chirps_field(FEB_MM)},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": FIRST_LAST_MODIFIED},
        ),
    )

    ingest(tmp_path, "1981-01", TEST_CUBE)

    assert list(stored_months(tmp_path)) == ["1981-01", "1981-02"]
    assert not list((tmp_path / ".downloads").iterdir())


def test_chirps_missing_older_month_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-03")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory(
            {"1981-01": True, "1981-03": True},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-03": FIRST_LAST_MODIFIED},
        ),
    )

    with pytest.raises(ValueError, match="missing"):
        ingest(tmp_path, "1981-01", TEST_CUBE)

    assert not (tmp_path / "chirps_monthly.zarr").exists()


def test_chirps_month_with_a_new_last_modified_is_refetched(tmp_path, monkeypatch):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-02")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory(
            {"1981-01": True, "1981-02": True},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": FIRST_LAST_MODIFIED},
        ),
    )
    monkeypatch.setattr(
        chirps,
        "_download_month",
        fake_download_factory(
            {"1981-01": chirps_field(JAN_MM), "1981-02": chirps_field(FEB_MM)},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": FIRST_LAST_MODIFIED},
        ),
    )
    ingest(tmp_path, "1981-01", TEST_CUBE)
    before = stored_months(tmp_path)["1981-02"]

    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory(
            {"1981-01": True, "1981-02": True},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": SECOND_LAST_MODIFIED},
        ),
    )
    monkeypatch.setattr(
        chirps,
        "_download_month",
        fake_download_factory(
            {"1981-02": chirps_field(FEB_MM + 5)},
            {"1981-02": SECOND_LAST_MODIFIED},
        ),
    )
    ingest(tmp_path, "1981-01", TEST_CUBE)

    after = stored_months(tmp_path)
    assert after["1981-02"] != before
    assert CubeStore((TEST_CUBE,), tmp_path).read_cube(
        TEST_CUBE,
        "1981-02",
        (0, 0, 1, 1),
    )[0, 0] == pytest.approx(FEB_MM + 5)


def test_chirps_republish_with_identical_bytes_keeps_the_marker(tmp_path, monkeypatch):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-01")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory({"1981-01": True}, {"1981-01": FIRST_LAST_MODIFIED}),
    )
    monkeypatch.setattr(
        chirps,
        "_download_month",
        fake_download_factory(
            {"1981-01": chirps_field(JAN_MM)},
            {"1981-01": FIRST_LAST_MODIFIED},
        ),
    )
    ingest(tmp_path, "1981-01", TEST_CUBE)
    before = stored_months(tmp_path)["1981-01"]

    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory({"1981-01": True}, {"1981-01": SECOND_LAST_MODIFIED}),
    )
    monkeypatch.setattr(
        chirps,
        "_download_month",
        fake_download_factory(
            {"1981-01": chirps_field(JAN_MM)},
            {"1981-01": SECOND_LAST_MODIFIED},
        ),
    )
    ingest(tmp_path, "1981-01", TEST_CUBE)

    assert stored_months(tmp_path)["1981-01"] == before
    group = zarr.open_group(tmp_path / "chirps_monthly.zarr", mode="r")
    assert dict(group.attrs[SOURCE_MODIFIED_ATTR])["1981-01"] == SECOND_LAST_MODIFIED


def test_chirps_negative_values_become_fill(tmp_path, monkeypatch):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-01")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory({"1981-01": True}, {"1981-01": FIRST_LAST_MODIFIED}),
    )
    field = chirps_field(JAN_MM)
    field[0, 0] = -9999

    def fake_download(month: str, target: Path) -> str | None:
        write_chirps_raster(target, field)
        return FIRST_LAST_MODIFIED

    monkeypatch.setattr(chirps, "_download_month", fake_download)

    ingest(tmp_path, "1981-01", TEST_CUBE)

    values = CubeStore((TEST_CUBE,), tmp_path).read_cube(TEST_CUBE, "1981-01", (0, 0, 10, 5))
    assert np.isnan(values[0, 0])
    assert values[0, 1] == pytest.approx(JAN_MM)
    stored = zarr.open_group(tmp_path / "chirps_monthly.zarr", mode="r")["precip"]
    assert stored[0, 0, 0] == 65535


def test_chirps_values_above_the_cube_maximum_become_fill_instead_of_refusing_the_month(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-01")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory({"1981-01": True}, {"1981-01": FIRST_LAST_MODIFIED}),
    )
    field = chirps_field(JAN_MM)
    field[0, 0] = 7676
    field[0, 1] = 6553.4

    def fake_download(month: str, target: Path) -> str | None:
        write_chirps_raster(target, field)
        return FIRST_LAST_MODIFIED

    monkeypatch.setattr(chirps, "_download_month", fake_download)

    ingest(tmp_path, "1981-01", TEST_CUBE)

    values = CubeStore((TEST_CUBE,), tmp_path).read_cube(TEST_CUBE, "1981-01", (0, 0, 10, 5))
    assert np.isnan(values[0, 0])
    assert values[0, 1] == pytest.approx(6553.4, abs=0.05)
    assert values[1, 0] == pytest.approx(JAN_MM)


def test_chirps_raster_off_the_edge_aligned_grid_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-01")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory({"1981-01": True}, {"1981-01": FIRST_LAST_MODIFIED}),
    )

    def fake_download(month: str, target: Path) -> str | None:
        write_chirps_raster(target, chirps_field(JAN_MM), west_edge=-180.025)
        return FIRST_LAST_MODIFIED

    monkeypatch.setattr(chirps, "_download_month", fake_download)

    with pytest.raises(ValueError, match="unrotated"):
        ingest(tmp_path, "1981-01", TEST_CUBE)

    assert not (tmp_path / "chirps_monthly.zarr").exists()


def test_chirps_ingest_retries_429_then_succeeds(monkeypatch):
    calls = []

    def fail_once(url: str, timeout: float) -> tuple[bool, str | None]:
        calls.append(url)
        if len(calls) == 1:
            raise HTTPError(url, 429, "Too Many Requests", {}, None)

        return True, FIRST_LAST_MODIFIED

    slept = []
    monkeypatch.setattr(chirps, "_head_once", fail_once)
    monkeypatch.setattr(chirps, "_sleep", slept.append)
    url = "https://example.test/file"
    def attempt() -> tuple[bool, str | None]:
        return chirps._head_once(url, chirps.HEAD_TIMEOUT_SECS)

    assert chirps._with_retries(url, attempt) == (
        True,
        FIRST_LAST_MODIFIED,
    )
    assert slept == [2]


def test_chirps_ingest_gives_up_after_repeated_429(monkeypatch):
    def always_throttled(url: str, timeout: float) -> tuple[bool, str | None]:
        raise HTTPError(url, 429, "Too Many Requests", {}, None)

    slept = []
    monkeypatch.setattr(chirps, "_head_once", always_throttled)
    monkeypatch.setattr(chirps, "_sleep", slept.append)
    url = "https://example.test/file"
    def attempt() -> tuple[bool, str | None]:
        return chirps._head_once(url, chirps.HEAD_TIMEOUT_SECS)

    with pytest.raises(HTTPError):
        chirps._with_retries(url, attempt)

    assert slept == [2, 4, 8, 16, 32]


def test_chirps_head_gives_up_with_url(monkeypatch):
    def always_fails(url: str, timeout: float) -> tuple[bool, str | None]:
        raise OSError("connection reset")

    slept = []
    monkeypatch.setattr(chirps, "_head_once", always_fails)
    monkeypatch.setattr(chirps, "_sleep", slept.append)
    url = "https://example.test/file"
    def attempt() -> tuple[bool, str | None]:
        return chirps._head_once(url, chirps.HEAD_TIMEOUT_SECS)

    with pytest.raises(OSError, match="example.test"):
        chirps._with_retries(url, attempt)

    assert slept == [2, 4, 8, 16, 32]


def test_chirps_get_retries_incomplete_read_then_succeeds(monkeypatch):
    calls = []

    def fail_once(url: str, timeout: float) -> tuple[bytes, str | None]:
        calls.append(url)
        if len(calls) == 1:
            raise IncompleteRead(b"half", 8)

        return b"body", FIRST_LAST_MODIFIED

    slept = []
    monkeypatch.setattr(chirps, "_fetch_once", fail_once)
    monkeypatch.setattr(chirps, "_sleep", slept.append)
    url = "https://example.test/file"
    def attempt() -> tuple[bytes, str | None]:
        return chirps._fetch_once(url, chirps.DOWNLOAD_TIMEOUT_SECS)

    assert chirps._with_retries(url, attempt) == (
        b"body",
        FIRST_LAST_MODIFIED,
    )
    assert slept == [2]


def test_chirps_get_gives_up_on_incomplete_read_with_url(monkeypatch):
    def always_short(url: str, timeout: float) -> tuple[bytes, str | None]:
        raise IncompleteRead(b"half", 8)

    slept = []
    monkeypatch.setattr(chirps, "_fetch_once", always_short)
    monkeypatch.setattr(chirps, "_sleep", slept.append)
    url = "https://example.test/file"
    def attempt() -> tuple[bytes, str | None]:
        return chirps._fetch_once(url, chirps.DOWNLOAD_TIMEOUT_SECS)

    with pytest.raises(OSError, match="example.test"):
        chirps._with_retries(url, attempt)

    assert slept == [2, 4, 8, 16, 32]


def test_retry_after_delay_seconds_wins_over_backoff(monkeypatch):
    slept = []
    monkeypatch.setattr(chirps, "_sleep", slept.append)

    chirps._sleep_before_retry(0, {"Retry-After": "120"})

    assert slept == [120]


def test_retry_after_http_date_wins_over_backoff(monkeypatch):
    future = datetime.now(timezone.utc) + timedelta(seconds=120)
    headers = {"Retry-After": format_datetime(future, usegmt=True)}
    slept = []
    monkeypatch.setattr(chirps, "_sleep", slept.append)

    chirps._sleep_before_retry(0, headers)

    assert slept[0] == pytest.approx(120, abs=5)


@pytest.mark.parametrize("modified", [FIRST_LAST_MODIFIED, None], ids=["unchanged", "absent"])
def test_chirps_pending_month_is_repaired_without_revision_change(
    tmp_path,
    monkeypatch,
    modified,
):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-02")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory(
            {"1981-01": True, "1981-02": True},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": FIRST_LAST_MODIFIED},
        ),
    )
    monkeypatch.setattr(
        chirps,
        "_download_month",
        fake_download_factory(
            {"1981-01": chirps_field(JAN_MM), "1981-02": chirps_field(FEB_MM)},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": FIRST_LAST_MODIFIED},
        ),
    )
    ingest(tmp_path, "1981-01", TEST_CUBE)

    group = zarr.open_group(tmp_path / "chirps_monthly.zarr", mode="a")
    group.attrs["pending"] = ["1981-02"]
    assert not CubeStore((TEST_CUBE,), tmp_path).has_cube(TEST_CUBE)

    revision = {} if modified is None else {"1981-01": modified, "1981-02": modified}
    download_modified = {} if modified is None else {"1981-02": modified}
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory({"1981-01": True, "1981-02": True}, revision),
    )
    monkeypatch.setattr(
        chirps,
        "_download_month",
        fake_download_factory({"1981-02": chirps_field(FEB_MM)}, download_modified),
    )
    ingest(tmp_path, "1981-01", TEST_CUBE)

    repaired = CubeStore((TEST_CUBE,), tmp_path)
    assert repaired.has_cube(TEST_CUBE)
    assert list(repaired.cube_months(TEST_CUBE)) == ["1981-01", "1981-02"]
    assert repaired.read_cube(TEST_CUBE, "1981-02", (0, 0, 1, 1))[0, 0] == pytest.approx(
        FEB_MM,
    )


def test_source_modified_is_published_with_the_markers(tmp_path, monkeypatch):
    monkeypatch.setattr(chirps, "newest_month", lambda: "1981-02")
    monkeypatch.setattr(
        chirps,
        "_head_month",
        fake_head_factory(
            {"1981-01": True, "1981-02": True},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": SECOND_LAST_MODIFIED},
        ),
    )
    monkeypatch.setattr(
        chirps,
        "_download_month",
        fake_download_factory(
            {"1981-01": chirps_field(JAN_MM), "1981-02": chirps_field(FEB_MM)},
            {"1981-01": FIRST_LAST_MODIFIED, "1981-02": SECOND_LAST_MODIFIED},
        ),
    )

    ingest(tmp_path, "1981-01", TEST_CUBE)

    group = zarr.open_group(tmp_path / "chirps_monthly.zarr", mode="r")
    assert dict(group.attrs[SOURCE_MODIFIED_ATTR]) == {
        "1981-01": FIRST_LAST_MODIFIED,
        "1981-02": SECOND_LAST_MODIFIED,
    }
    assert list(group.attrs["months"]) == ["1981-01", "1981-02"]
