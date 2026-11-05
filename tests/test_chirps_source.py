"""Test CHIRPS rainfall revisions, cube and HTTP reads, notices and probes offline."""
import time
from dataclasses import replace
from datetime import datetime, timezone

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from soe.sources import (
    CHIRPS_CUBE,
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_TEMPERATURE_CUBE,
    CellWindow,
    CubeSpec,
    Grid,
    RainDataset,
    RealSource,
    SourceUnavailable,
    SyntheticSource,
    chirps,
    make_registry,
)
from soe.sources.chirps import previous_month
from soe.sources.grid import CELL_DEG, block_mean
from tests.helpers import RAIN, write_cube, write_updating_chirps_cube

NAIROBI_BBOX = [36.5, -1.5, 37.5, -0.5]


class FakeRainBackend:
    """Provide fixed CHIRPS revisions, a CHIRPS cube and fallback-cube month markers."""

    def __init__(
        self,
        fallback: dict[str, str],
        chirps_revision: str = "chirps",
        chirps_cube: dict[str, str] | None = None,
    ) -> None:
        self.markers = {"era5_precipitation": fallback}
        self.chirps_revision = chirps_revision
        self.chirps_cube = chirps_cube or {}
        self.revised_months = []

    def cube_months(self, spec: CubeSpec) -> dict[str, str]:
        return self.markers[spec.name]

    def latest_month(self) -> str:
        return "2026-08"

    def current_revision(self, month: str) -> str:
        self.revised_months.append(month)
        return self.chirps_revision

    def optional_cube_months(self, spec: CubeSpec) -> dict[str, str]:
        return self.chirps_cube


def test_rain_remote_revision_follows_the_chirps_file_and_local_one_the_fallback_marker():
    steps = ["2026-06-01", "2026-07-01"]
    markers = {"2026-06": "0001:a", "2026-07": "0005:b"}
    base = replace(RAIN, backend=FakeRainBackend(markers))
    revised_chirps = replace(RAIN, backend=FakeRainBackend(markers, "chirps again"))
    final_fallback = replace(
        RAIN,
        backend=FakeRainBackend({"2026-06": "0001:a", "2026-07": "0001:c"}),
    )

    assert base.remote_revision(steps) != revised_chirps.remote_revision(steps)
    assert base.local_revision(steps) == revised_chirps.local_revision(steps)
    assert base.remote_revision(steps) == final_fallback.remote_revision(steps)
    assert base.local_revision(steps) != final_fallback.local_revision(steps)
    assert base.local_revision(steps[:1]) == final_fallback.local_revision(steps[:1])


def rain_over(
    chirps_cube: dict[str, str],
    fallback_months: tuple[str, ...] = ("2026-06", "2026-07"),
) -> tuple[RainDataset, FakeRainBackend]:
    fallback = {month: "0001:a" for month in fallback_months}
    backend = FakeRainBackend(fallback, "http file", chirps_cube)
    return replace(RAIN, backend=backend), backend


def test_rain_revision_is_local_only_when_the_cube_holds_every_month():
    rain, backend = rain_over({"2026-06": "0001:c", "2026-07": "0001:d"})

    assert rain.remote_revision(["2026-06-01", "2026-07-01"]) is None
    assert backend.revised_months == []


def test_rain_remote_revision_follows_the_last_month_read_over_http():
    rain, backend = rain_over({"2026-06": "0001:c"})

    assert rain.remote_revision(["2026-06-01", "2026-07-01"]) == "http file"
    assert backend.revised_months == ["2026-07"]


def test_rain_revision_changes_when_a_cube_month_is_replaced():
    steps = ["2026-06-01", "2026-07-01"]
    first, _ = rain_over({"2026-06": "0001:c", "2026-07": "0001:d"})
    replaced, _ = rain_over({"2026-06": "0001:c", "2026-07": "0001:e"})

    assert first.local_revision(steps) != replaced.local_revision(steps)
    assert first.local_revision(steps[:1]) == replaced.local_revision(steps[:1])


def test_rain_revision_tells_a_cube_month_from_one_read_over_http():
    steps = ["2026-06-01", "2026-07-01"]
    over_http, _ = rain_over({})
    from_cube, _ = rain_over({"2026-06": "0001:c", "2026-07": "0001:d"})
    mixed, _ = rain_over({"2026-06": "0001:c"})

    revisions = {rain.local_revision(steps) for rain in (over_http, from_cube, mixed)}

    assert len(revisions) == 3


def test_rain_latest_follows_the_cube_without_probing():
    class CubeUpTo202605(SyntheticSource):
        def latest_month(self) -> str:
            raise AssertionError("a build with a cube must not probe CHIRPS")

        def optional_cube_months(self, spec: CubeSpec) -> dict[str, str]:
            months = super().optional_cube_months(spec)
            return {month: marker for month, marker in months.items() if month <= "2026-05"}

    lagging = make_registry(CubeUpTo202605(chirps_cube=True))["chirps_monthly"]

    assert lagging.latest() == "2026-05-01"
    assert make_registry(SyntheticSource())["chirps_monthly"].latest() == "2026-08-01"


class RecordingSource(SyntheticSource):
    """Record the CHIRPS months read over HTTP and from the cube."""

    def __init__(self, cube_months: tuple[str, ...] = ()) -> None:
        super().__init__()
        self.held = cube_months
        self.http_reads = []
        self.cube_reads = []

    def optional_cube_months(self, spec: CubeSpec) -> dict[str, str]:
        return {month: "0001:cube" for month in self.held}

    def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
        self.http_reads.append(month)
        return super().read_rain(month, window)

    def read_cube(self, spec: CubeSpec, month: str, window: CellWindow) -> np.ndarray:
        if spec.name == CHIRPS_CUBE.name:
            self.cube_reads.append(month)
        return super().read_cube(spec, month, window)


def test_rain_reads_months_held_by_the_cube_without_http():
    source = RecordingSource(("2020-03", "2020-04"))

    make_registry(source)["chirps_monthly"].read_step("2020-03-01", NAIROBI_BBOX)

    assert (source.cube_reads, source.http_reads) == (["2020-03"], [])


def test_rain_reads_months_missing_from_the_cube_over_http():
    source = RecordingSource()

    make_registry(source)["chirps_monthly"].read_step("2020-03-01", NAIROBI_BBOX)

    assert (source.cube_reads, source.http_reads) == ([], ["2020-03"])


def test_http_rain_above_the_cube_maximum_or_negative_becomes_no_value(tmp_path, monkeypatch):
    path = tmp_path / "chirps.tif"
    values = np.array([[100, 6553.4, 6553.5], [7676, -9999, 0]], "float32")
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "count": 1,
        "width": 3,
        "height": 2,
        "crs": "EPSG:4326",
        "transform": from_origin(-180, 60, CELL_DEG, CELL_DEG),
    }
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(values, 1)
    monkeypatch.setattr(chirps, "_chirps_url", lambda month: str(path))
    monkeypatch.setattr(chirps, "CHIRPS_GRID", Grid(-180, 60, CELL_DEG, 3, 2))

    rain = chirps.ChirpsReader().read_rain("2020-03", (0, 0, 3, 2))

    assert rain[0, :2] == pytest.approx([100, 6553.4])
    assert np.isnan(rain[0, 2]) and np.isnan(rain[1, :2]).all() and rain[1, 2] == 0


def test_rain_reads_each_month_from_the_path_that_holds_it():
    source = RecordingSource(("2020-04",))
    rain = make_registry(source)["chirps_monthly"]

    rain.read_step("2020-03-01", NAIROBI_BBOX)
    rain.read_step("2020-04-01", NAIROBI_BBOX)

    assert (source.http_reads, source.cube_reads) == (["2020-03"], ["2020-04"])


def test_rain_cube_that_is_updating_is_unavailable_instead_of_read_over_http(tmp_path):
    write_updating_chirps_cube(tmp_path)
    source = RealSource(cubes_dir=tmp_path)

    with pytest.raises(SourceUnavailable):
        source.optional_cube_months(CHIRPS_CUBE)


@pytest.mark.parametrize(
    ("chirps_cube", "chirps_has_cube"),
    [(True, True), (False, False)],
)
def test_synthetic_has_cube_follows_the_chirps_flag_and_keeps_era5_cubes(
    chirps_cube,
    chirps_has_cube,
):
    source = SyntheticSource(chirps_cube=chirps_cube)

    assert source.has_cube(CHIRPS_CUBE) is chirps_has_cube
    assert source.has_cube(ERA5_TEMPERATURE_CUBE) is True
    assert source.has_cube(ERA5_LAND_TEMPERATURE_CUBE) is True


def test_rain_without_a_cube_folder_has_no_cube_months(tmp_path):
    assert RealSource(cubes_dir=tmp_path).optional_cube_months(CHIRPS_CUBE) == {}


def test_revision_of_a_month_the_cube_lost_is_unavailable():
    rain = replace(RAIN, backend=FakeRainBackend({"2026-06": "0001:a"}))

    with pytest.raises(SourceUnavailable):
        rain.local_revision(["2026-06-01", "2026-07-01"])


def test_rain_preliminary_months_filled_by_the_fallback_get_one_notice_per_run():
    markers = {"2026-04": "0001:a", "2026-05": "0005:a", "2026-06": "0005:a", "2026-07": "0001:a"}
    rain = replace(RAIN, backend=FakeRainBackend(markers))
    steps = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"]

    notices = rain.fallback_notices(steps, [True, True, True, True])

    assert len(notices) == 1
    assert "Rainfall 2026-05 to 2026-06" in notices[0] and "preliminary" in notices[0]


def test_rain_preliminary_months_the_fallback_did_not_fill_get_no_notice():
    markers = {"2026-05": "0005:a", "2026-06": "0005:a", "2026-07": "0005:a"}
    rain = replace(RAIN, backend=FakeRainBackend(markers))
    steps = ["2026-05-01", "2026-06-01", "2026-07-01"]

    notices = rain.fallback_notices(steps, [True, False, True])

    assert len(notices) == 2
    assert "Rainfall 2026-05 is" in notices[0] and "Rainfall 2026-07 is" in notices[1]
    assert rain.fallback_notices(steps, [False, False, False]) == []


def test_rain_final_fallback_months_get_no_notice():
    rain = replace(RAIN, backend=FakeRainBackend({"2026-06": "0001:a", "2026-07": "0001:b"}))

    assert rain.fallback_notices(["2026-06-01", "2026-07-01"], [True, True]) == []


def test_rain_has_no_notice_before_the_build_shows_the_fallback_was_used():
    rain = replace(RAIN, backend=FakeRainBackend({"2026-05": "0005:a"}))

    assert rain.notices([0, 0, 1, 1], ["2026-05-01"]) == []


def test_rain_months_are_those_chirps_and_the_fallback_cube_hold():
    fallback = {"2016-03": "0001:a", "2026-05": "0001:a"}

    rain = replace(RAIN, backend=FakeRainBackend(fallback))

    assert (rain.first(), rain.latest()) == ("2016-03-01", "2026-05-01")


def test_rain_needs_its_fallback_cube_to_be_listed(tmp_path):
    assert "chirps_monthly" not in make_registry(RealSource(cubes_dir=tmp_path))

    write_cube(tmp_path, "era5_precipitation", 0)

    assert "chirps_monthly" in make_registry(RealSource(cubes_dir=tmp_path))


def test_latest_month_probe_picks_the_newest_existing_month(monkeypatch):
    now = datetime.now(timezone.utc)
    newest_existing = previous_month(*previous_month(now.year, now.month))
    existing_urls = set()
    year, month = newest_existing
    for _ in range(3):
        existing_urls.add(chirps._chirps_url(f"{year:04d}-{month:02d}"))
        year, month = previous_month(year, month)

    monkeypatch.setattr(chirps, "_head", lambda url: (url in existing_urls, None))

    latest = RealSource().latest_month()

    assert latest == f"{newest_existing[0]:04d}-{newest_existing[1]:02d}"


def test_latest_month_is_rechecked_soon_when_a_newer_month_was_unreachable(monkeypatch):
    now = datetime.now(timezone.utc)
    this_month = chirps._chirps_url(f"{now.year:04d}-{now.month:02d}")
    monkeypatch.setattr(
        chirps,
        "_head",
        lambda url: (None, None) if url == this_month else (True, None),
    )
    source = RealSource()

    source.latest_month()

    ttl_secs = source._probed[1] - time.time()
    assert ttl_secs <= chirps.OFFLINE_LATEST_TTL_SECS


def test_read_month_wraps_at_180():
    source = SyntheticSource()
    rain = make_registry(source)["chirps_monthly"]
    bbox = [179, -1, 181, 1]
    rain_month = rain.read_month("2015-01", bbox, 2)
    left = source.read_rain("2015-01", (7180, 1180, 20, 40))
    right = source.read_rain("2015-01", (0, 1180, 20, 40))

    assert source.reads == 4 and rain_month.shape == (20, 20)
    assert np.array_equal(rain_month, block_mean(np.hstack([left, right]), 2), equal_nan=True)
