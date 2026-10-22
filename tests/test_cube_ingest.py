"""Test cube ingestion offline using ERA5-Land temperature as the main fixture.

Check GRIB decoding and grid placement. Verify update recovery and CDS request scheduling.
"""
import hashlib
import json
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
import rasterio.shutil
import zarr
from rasterio.transform import Affine, from_origin

from soe import cube_ingest
from soe.cube_ingest import (
    INGEST_SPECS,
    MonthField,
    grib_expvers,
    ingest,
    open_grib,
    read_months,
    write_months,
)
from soe.sources import (
    ERA5_GRID,
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_LAND_TEMPERATURE_GRID,
    MonthlyCube,
    SourceUnavailable,
)
from soe.sources.cubes import month_index

pytestmark = pytest.mark.slow

GRIB_SECTION1_BYTES = 52  # long enough to hold the ECMWF experiment version
EXPVER_IN_SECTION1_BYTES = 45
UNPUBLISHED = "None of the data you have requested is available yet, please try again later."
JAN_2016_SECS = 1451606400
SHAPE = (ERA5_LAND_TEMPERATURE_GRID.rows, ERA5_LAND_TEMPERATURE_GRID.columns)
LAND = INGEST_SPECS["era5land_temperature"]
ERA5_TEMPERATURE = INGEST_SPECS["era5_temperature"]
ERA5_PRECIPITATION = INGEST_SPECS["era5_precipitation"]
ERA5_SHAPE = (ERA5_GRID.rows, ERA5_GRID.columns)
FEB_2016_SECS = 1454284800
CUBE_NAME = "era5land_temperature.zarr"
CUBE_ARRAY = "t2m"


def grib1_message(
    expver: str,
    edition: int = 1,
    payload: bytes = bytes(8),
    large: bool = False,
    section1_length: int = GRIB_SECTION1_BYTES,
) -> bytes:
    """A GRIB message with an ECMWF section 1 and a data section holding the payload.

    `large` uses ECMWF's large-message length code; otherwise the length is plain, which for
    a payload over 8 MiB sets the high bit of the stated length.
    """
    section1 = bytearray(GRIB_SECTION1_BYTES)
    section1[:3] = section1_length.to_bytes(3, "big")
    section1[EXPVER_IN_SECTION1_BYTES:EXPVER_IN_SECTION1_BYTES + 4] = expver.encode()
    plain_total = 8 + GRIB_SECTION1_BYTES + 3 + len(payload) + 4
    if large:
        units = (plain_total - 4 + 119) // 120
        data_length = units * 120 + 4 - plain_total
        stated_total = 0x800000 | units
    else:
        data_length = 3 + len(payload)
        stated_total = plain_total

    body = bytes(section1) + data_length.to_bytes(3, "big") + payload + b"7777"
    return b"GRIB" + stated_total.to_bytes(3, "big") + bytes([edition]) + body


def write_raster(
    path: Path,
    west_edge: float,
    res: float,
    width: int,
    height: int,
    values: np.ndarray,
    valid_seconds: list[int] | None = None,
    north_edge: float = ERA5_LAND_TEMPERATURE_GRID.north_deg,
    unit: str = "[K]",
) -> None:
    """A Kelvin raster with one band per entry of valid_seconds, tagged as the GRIB driver does."""
    valid_seconds = valid_seconds or [JAN_2016_SECS]
    profile = {
        "driver": "GTiff",
        "width": width,
        "height": height,
        "count": len(valid_seconds),
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": from_origin(west_edge, north_edge, res, res),
        "nodata": 9999,
    }
    with rasterio.open(path, "w", **profile) as dataset:
        for band, seconds in enumerate(valid_seconds, start=1):
            dataset.write(values.astype("float32"), band)
            dataset.update_tags(band, GRIB_VALID_TIME=f"{seconds} sec UTC", GRIB_UNIT=unit)


def write_gdal_grib(path: Path, celsius: float) -> None:
    """A one-field GRIB2 temperature file on the cube grid, written by GDAL's GRIB driver."""
    source = path.with_suffix(".tif")
    profile = {
        "driver": "GTiff",
        "width": ERA5_LAND_TEMPERATURE_GRID.columns,
        "height": ERA5_LAND_TEMPERATURE_GRID.rows,
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": ERA5_LAND_TEMPERATURE_GRID.transform,
    }
    with rasterio.open(source, "w", **profile) as dataset:
        dataset.write(np.full(SHAPE, celsius, "float32"), 1)
        dataset.update_tags(
            1,
            GRIB_DISCIPLINE="0",
            GRIB_IDS="CENTER=98(ECMWF) SUBCENTER=0 MASTER_TABLE=28 LOCAL_TABLE=0 "
            "SIGNF_REF_TIME=1(Start_of_Forecast) REF_TIME=2016-01-01T00:00:00Z "
            "PROD_STATUS=0(Operational) TYPE=1(Forecast)",
            GRIB_PDS_PDTN="0",
            GRIB_PDS_TEMPLATE_NUMBERS="0 0 2 0 0 0 0 0 1 0 0 0 0 103 0 0 0 0 2 255 0 0 0 0 0",
        )
    rasterio.shutil.copy(source, path, driver="GRIB")


def celsius_field(value: float) -> np.ndarray:
    return np.full(SHAPE, value, "float32")


def land_cube(cubes_dir: Path) -> MonthlyCube:
    return MonthlyCube(ERA5_LAND_TEMPERATURE_CUBE, cubes_dir)


@pytest.mark.parametrize(
    ("payload_bytes", "large", "first_expver"),
    [
        (9, False, "0001"),
        (500, True, "0005"),
        (9 * 1024 * 1024, False, "0001"),
        (9 * 1024 * 1024 + 7, True, "0005"),
    ],
    ids=["plain", "large-code", "plain-over-8-mib", "large-over-8-mib"],
)
def test_expvers_follow_message_lengths_even_with_grib_bytes_in_the_data(
    tmp_path,
    payload_bytes,
    large,
    first_expver,
):
    path = tmp_path / "months.grib"
    payload = b"xxGRIB\x02yy"
    payload += bytes(payload_bytes - len(payload))
    second_expver = "0005" if first_expver == "0001" else "0001"
    message = grib1_message(first_expver, payload=payload, large=large)
    path.write_bytes(message + grib1_message(second_expver))

    assert grib_expvers(path) == [first_expver, second_expver]


def test_impossible_section_bounds_are_refused(tmp_path):
    path = tmp_path / "months.grib"

    for message in (
        grib1_message("0001", section1_length=0),
        grib1_message("0001", section1_length=10),
        grib1_message("0001", section1_length=0x7FFFFF),
    ):
        path.write_bytes(message)
        with pytest.raises(ValueError, match="impossible length"):
            grib_expvers(path)


def test_data_section_length_that_disagrees_with_the_message_is_refused(tmp_path):
    path = tmp_path / "months.grib"
    message = bytearray(grib1_message("0001"))
    data_section_at = 8 + GRIB_SECTION1_BYTES
    message[data_section_at:data_section_at + 3] = (500).to_bytes(3, "big")

    path.write_bytes(bytes(message))

    with pytest.raises(ValueError, match="wrong data section length"):
        grib_expvers(path)


def test_message_too_short_for_its_sections_is_refused(tmp_path):
    path = tmp_path / "months.grib"
    message = bytearray(grib1_message("0001"))
    message[4:7] = (8 + GRIB_SECTION1_BYTES + 4).to_bytes(3, "big")

    path.write_bytes(bytes(message))

    with pytest.raises(ValueError):
        grib_expvers(path)


def test_truncated_or_trailing_bytes_are_refused(tmp_path):
    path = tmp_path / "months.grib"
    message = grib1_message("0001")

    path.write_bytes(message[:-6])
    with pytest.raises(ValueError, match="truncated"):
        grib_expvers(path)

    path.write_bytes(message + b"junk")
    with pytest.raises(ValueError, match="expected a GRIB message"):
        grib_expvers(path)


@pytest.mark.parametrize(
    ("edition", "expver", "error"),
    [(2, "0001", "edition 1"), (1, "0042", "experiment version")],
    ids=["grib2", "unknown-expver"],
)
def test_unsupported_grib_metadata_is_refused(tmp_path, edition, expver, error):
    path = tmp_path / "months.grib"
    path.write_bytes(grib1_message(expver, edition=edition))

    with pytest.raises(ValueError, match=error):
        grib_expvers(path)


@pytest.mark.parametrize("west_edge", [-0.05, -180.05])
def test_grid_with_any_longitude_origin_lands_on_the_cube_grid(tmp_path, west_edge):
    path = tmp_path / "field.tif"
    width = ERA5_LAND_TEMPERATURE_GRID.columns
    centres = west_edge + (np.arange(width) + 0.5) * 0.1
    row = (centres % 360).astype("float32")
    write_raster(path, west_edge, 0.1, width, SHAPE[0], np.tile(row, (SHAPE[0], 1)))

    with rasterio.open(path) as dataset:
        [(month, celsius, expver)] = read_months(dataset, ["0001"], LAND)

    cube_centres = -180 + np.arange(width) * 0.1
    assert (month, expver) == ("2016-01", "0001")
    assert np.allclose(celsius[0] + 273.15, cube_centres % 360, atol=1e-3)


def test_grid_with_another_resolution_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    write_raster(path, -180, 0.25, 10, 10, np.zeros((10, 10)))

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match="0.1 degree cells"):
        list(read_months(dataset, ["0001"], LAND))


def test_raster_that_misses_part_of_the_grid_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    write_raster(path, -180.05, 0.1, 100, 100, np.zeros((100, 100)))

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match="does not cover"):
        list(read_months(dataset, ["0001"], LAND))


def test_kelvin_becomes_celsius_and_ocean_becomes_fill(tmp_path):
    path = tmp_path / "field.tif"
    kelvin = np.full(SHAPE, 300.15)
    kelvin[0, 0] = 9999
    write_raster(path, -180.05, 0.1, SHAPE[1], SHAPE[0], kelvin)

    with rasterio.open(path) as dataset:
        write_months(tmp_path / "cubes", LAND, read_months(dataset, ["0001"], LAND))

    stored = zarr.open_group(tmp_path / "cubes" / CUBE_NAME, mode="r")[CUBE_ARRAY]
    january_2016 = 66 * 12
    assert stored[january_2016, 1, 1] == 2700
    assert stored[january_2016, 0, 0] == -32768


def test_gdal_grib_temperature_is_read_in_kelvin_and_converted_once(tmp_path):
    path = tmp_path / "field.grb2"
    write_gdal_grib(path, celsius=27.0)

    with open_grib(path) as dataset:
        [(month, celsius, _)] = read_months(dataset, ["0001"], LAND)

    assert month == "2016-01"
    assert celsius[5, 5] == pytest.approx(27.0, abs=0.01)


def test_temperature_already_in_celsius_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    write_raster(path, -180.05, 0.1, SHAPE[1], SHAPE[0], np.full(SHAPE, 27), unit="[C]")

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match=r"\[K\]"):
        list(read_months(dataset, ["0001"], LAND))


def test_raster_shifted_one_row_north_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    shifted_north = ERA5_LAND_TEMPERATURE_GRID.north_deg + 0.1
    write_raster(path, -180.05, 0.1, SHAPE[1], SHAPE[0], np.zeros(SHAPE), north_edge=shifted_north)

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match="60N to 60S"):
        list(read_months(dataset, ["0001"], LAND))


def test_rotated_raster_is_refused():
    rotated = Affine(0.1, 0.01, -180.05, 0, -0.1, 60.05)
    dataset = SimpleNamespace(count=1, transform=rotated, width=SHAPE[1], height=SHAPE[0])

    with pytest.raises(ValueError, match="unrotated"):
        list(read_months(dataset, ["0001"], LAND))


def test_rewriting_an_unchanged_month_keeps_its_marker(tmp_path):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0001")])
    marker = land_cube(tmp_path).months()["2016-01"]

    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0001")])
    unchanged = land_cube(tmp_path).months()["2016-01"]
    write_months(tmp_path, LAND, [("2016-01", celsius_field(21), "0001")])
    changed = land_cube(tmp_path).months()["2016-01"]

    assert unchanged == marker
    assert changed != marker and changed.startswith("0001:")


@pytest.mark.parametrize("month", ["2015-11", "2016-03"], ids=["before", "after"])
def test_gap_before_or_after_stored_months_is_refused(tmp_path, month):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0001")])

    with pytest.raises(ValueError, match="gap"):
        write_months(tmp_path, LAND, [(month, celsius_field(20), "0001")])

    assert list(land_cube(tmp_path).months()) == ["2016-01"]


def test_failed_batch_changes_neither_data_nor_marker(tmp_path):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0005")])
    before = land_cube(tmp_path).months()["2016-01"]

    def failing_batch() -> Iterator[MonthField]:
        yield "2016-01", celsius_field(21), "0001"
        raise ValueError("second field is invalid")

    with pytest.raises(ValueError, match="second field"):
        write_months(tmp_path, LAND, failing_batch())

    cube = land_cube(tmp_path)
    assert cube.months()["2016-01"] == before
    assert cube.read("2016-01", (0, 0, 1, 1))[0, 0] == pytest.approx(20)


def test_published_marker_matches_the_stored_bytes(tmp_path):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0001")])
    stored = zarr.open_group(tmp_path / CUBE_NAME, mode="r")[CUBE_ARRAY][month_index("2016-01")]

    marker = land_cube(tmp_path).months()["2016-01"]

    assert marker == "0001:" + hashlib.sha256(stored.tobytes()).hexdigest()[:12]


def test_field_of_the_wrong_shape_is_refused_before_anything_is_written(tmp_path):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0005")])
    before = land_cube(tmp_path).months()

    for bad_shape in ((1200, 3600), (1201, 3599), (3600,)):
        later_bad = [
            ("2016-01", celsius_field(21), "0001"),
            ("2016-02", np.full(bad_shape, 21, "float32"), "0001"),
        ]
        with pytest.raises(ValueError, match="not the cube grid"):
            write_months(tmp_path, LAND, later_bad)

    cube = land_cube(tmp_path)
    assert cube.months() == before
    assert cube.read("2016-01", (0, 0, 1, 1))[0, 0] == pytest.approx(20)


def two_months() -> list[MonthField]:
    return [("2016-01", celsius_field(21), "0001"), ("2016-02", celsius_field(22), "0001")]


def test_failure_while_storing_data_leaves_the_cube_unavailable_until_rewritten(
    tmp_path,
    monkeypatch,
):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0005")])
    store_month = cube_ingest._store_month
    stored = []

    def store_then_fail(array: zarr.Array, month: str, encoded: np.ndarray) -> None:
        if stored:
            raise OSError("disk full")

        store_month(array, month, encoded)
        stored.append(month)

    monkeypatch.setattr(cube_ingest, "_store_month", store_then_fail)
    with pytest.raises(OSError, match="disk full"):
        write_months(tmp_path, LAND, two_months())

    cube = land_cube(tmp_path)
    assert not cube.has_months()
    with pytest.raises(SourceUnavailable, match="being updated"):
        cube.read("2016-01", (0, 0, 1, 1))

    monkeypatch.undo()
    write_months(tmp_path, LAND, two_months())

    recovered = land_cube(tmp_path)
    assert list(recovered.months()) == ["2016-01", "2016-02"]
    assert recovered.read("2016-01", (0, 0, 1, 1))[0, 0] == pytest.approx(21)


def test_failure_while_publishing_markers_leaves_the_cube_unavailable_until_rewritten(
    tmp_path,
    monkeypatch,
):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0005")])

    def fail_to_publish(group: zarr.Group, markers: dict[str, str], pending: list[str]) -> None:
        raise OSError("metadata not written")

    monkeypatch.setattr(cube_ingest, "_publish", fail_to_publish)
    with pytest.raises(OSError, match="metadata"):
        write_months(tmp_path, LAND, two_months())

    assert not land_cube(tmp_path).has_months()

    monkeypatch.undo()
    write_months(tmp_path, LAND, [two_months()[1]])
    assert not land_cube(tmp_path).has_months()

    write_months(tmp_path, LAND, two_months())
    recovered = land_cube(tmp_path)
    assert recovered.months()["2016-01"].startswith("0001:")
    assert recovered.read("2016-02", (0, 0, 1, 1))[0, 0] == pytest.approx(22)


def test_failure_before_the_update_starts_changes_nothing(tmp_path, monkeypatch):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0005")])
    before = land_cube(tmp_path).months()

    def fail_to_begin(group: zarr.Group, pending: list[str]) -> None:
        raise OSError("metadata not written")

    monkeypatch.setattr(cube_ingest, "_begin_update", fail_to_begin)
    with pytest.raises(OSError):
        write_months(tmp_path, LAND, two_months())

    cube = land_cube(tmp_path)
    assert cube.months() == before
    assert cube.read("2016-01", (0, 0, 1, 1))[0, 0] == pytest.approx(20)


def test_read_that_overlaps_an_update_is_refused(tmp_path, monkeypatch):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0005")])
    cube = land_cube(tmp_path)
    cube.months()
    open_group = zarr.open_group

    def open_then_update(*args: object, **kwargs: object) -> zarr.Group:
        monkeypatch.undo()
        group = open_group(*args, **kwargs)
        write_months(tmp_path, LAND, [("2016-01", celsius_field(21), "0001")])
        return group

    monkeypatch.setattr(zarr, "open_group", open_then_update)

    with pytest.raises(SourceUnavailable, match="being updated"):
        cube.read("2016-01", (0, 0, 1, 1))


def update_between_stamp_and_validation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    publish: bool,
) -> MonthlyCube:
    """A primed cube whose reader is updated right after it samples the cube's change stamp."""
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0005")])
    cube = land_cube(tmp_path)
    cube.months()
    months_at = MonthlyCube._months_at

    def update_then_validate(self: MonthlyCube, stamp: int) -> dict[str, str]:
        monkeypatch.undo()
        if not publish:
            monkeypatch.setattr(cube_ingest, "_publish", raise_os_error)
        try:
            write_months(tmp_path, LAND, [("2016-01", celsius_field(21), "0001")])
        except OSError:
            pass

        return months_at(self, stamp)

    monkeypatch.setattr(MonthlyCube, "_months_at", update_then_validate)
    return cube


def raise_os_error(*args: object) -> None:
    raise OSError("metadata not written")


def test_read_is_refused_when_an_unfinished_update_starts_after_the_stamp(tmp_path, monkeypatch):
    cube = update_between_stamp_and_validation(tmp_path, monkeypatch, publish=False)

    with pytest.raises(SourceUnavailable, match="being updated"):
        cube.read("2016-01", (0, 0, 1, 1))

    monkeypatch.undo()
    assert not land_cube(tmp_path).has_months()


def test_read_is_refused_when_a_whole_update_happens_after_the_stamp(tmp_path, monkeypatch):
    cube = update_between_stamp_and_validation(tmp_path, monkeypatch, publish=True)

    with pytest.raises(SourceUnavailable, match="being updated"):
        cube.read("2016-01", (0, 0, 1, 1))

    monkeypatch.undo()
    assert land_cube(tmp_path).read("2016-01", (0, 0, 1, 1))[0, 0] == (
        pytest.approx(21)
    )


def test_ingest_refetches_months_left_pending_by_a_failed_update(tmp_path, fake_grib):
    write_months(tmp_path, LAND, [("2016-12", celsius_field(20), "0001")])
    group = zarr.open_group(tmp_path / CUBE_NAME, mode="a")
    group.attrs["pending"] = ["2016-12"]
    client = FakeClient()

    ingest(tmp_path, LAND, "2016-12", client)

    requested = [(request["year"], request["month"]) for _, request in client.requests]
    assert (["2016"], ["12"]) in requested
    assert land_cube(tmp_path).has_months()


def test_failed_first_batch_leaves_no_cube(tmp_path):
    def failing_batch() -> Iterator[MonthField]:
        raise ValueError("first field is invalid")
        yield

    with pytest.raises(ValueError, match="first field"):
        write_months(tmp_path, LAND, failing_batch())

    assert not (tmp_path / CUBE_NAME).exists()


class FakeClient:
    """Records CDS requests and answers each with a file naming the months requested."""

    def __init__(self, refuse_month: str | None = None, error: Exception | None = None) -> None:
        self.requests = []
        self._refuse_month = refuse_month
        self._error = error or Exception(UNPUBLISHED)

    def retrieve(self, dataset: str, request: dict, target: str) -> None:
        self.requests.append((dataset, request))
        months = [f"{request['year'][0]}-{month}" for month in request["month"]]
        if self._refuse_month in months:
            raise self._error

        Path(target).write_text(json.dumps(months))


class GribClient:
    """Answers every request with the same GRIB bytes."""

    def __init__(self, content: bytes) -> None:
        self._content = content

    def retrieve(self, dataset: str, request: dict, target: str) -> None:
        Path(target).write_bytes(self._content)


@pytest.fixture
def fake_grib(monkeypatch):
    """Reads the fake client's files; months of the year 2017 onward are preliminary."""

    def read_fake(path: Path, spec: cube_ingest.IngestSpec) -> Iterator[MonthField]:
        for month in json.loads(Path(path).read_text()):
            yield month, celsius_field(20), "0005" if month >= "2017" else "0001"

    monkeypatch.setattr(cube_ingest, "read_grib_months", read_fake)
    monkeypatch.setattr(cube_ingest, "_newest_month", lambda: "2017-02")


def test_ingest_requests_one_year_per_call_and_refetches_preliminary_months(tmp_path, fake_grib):
    client = FakeClient()
    ingest(tmp_path, LAND, "2016-11", client)
    first_run = len(client.requests)

    client.requests.clear()
    ingest(tmp_path, LAND, "2016-11", client)

    months = [(request["year"], request["month"]) for _, request in client.requests]
    assert first_run == 3
    assert months == [(["2017"], ["01"]), (["2017"], ["02"])]
    assert list(land_cube(tmp_path).months()) == [
        "2016-11",
        "2016-12",
        "2017-01",
        "2017-02",
    ]
    assert not list((tmp_path / ".downloads").iterdir())


def test_unpublished_last_month_is_skipped_not_failed(tmp_path, fake_grib):
    client = FakeClient(refuse_month="2017-02")

    ingest(tmp_path, LAND, "2016-12", client)

    assert list(land_cube(tmp_path).months()) == ["2016-12", "2017-01"]


def test_refused_request_for_an_older_month_fails(tmp_path, fake_grib):
    client = FakeClient(refuse_month="2016-12")

    with pytest.raises(Exception, match="available yet"):
        ingest(tmp_path, LAND, "2016-12", client)


@pytest.mark.parametrize(
    "error",
    [PermissionError("invalid CDS credentials"), Exception("401 Client Error: Unauthorized")],
)
def test_other_failures_of_the_newest_month_are_not_taken_for_unpublished(
    tmp_path,
    fake_grib,
    error,
):
    client = FakeClient(refuse_month="2017-02", error=error)

    with pytest.raises(Exception, match="credentials|Unauthorized"):
        ingest(tmp_path, LAND, "2017-01", client)


def test_invalid_download_of_the_newest_month_fails_and_leaves_no_cube(tmp_path, monkeypatch):
    monkeypatch.setattr(cube_ingest, "_newest_month", lambda: "2017-01")
    client = GribClient(grib1_message("0001", edition=2))

    with pytest.raises(ValueError, match="only GRIB edition 1"):
        ingest(tmp_path, LAND, "2017-01", client)

    assert not (tmp_path / CUBE_NAME).exists()


@pytest.mark.parametrize("width", [1440, 1441])
def test_era5_raster_lands_on_the_quarter_degree_grid_with_or_without_the_repeated_edge(
    tmp_path,
    width,
):
    path = tmp_path / "field.tif"
    centres = -180 + np.arange(width) * 0.25
    row = (centres % 360 + 273.15).astype("float32")
    write_raster(
        path,
        -180.125,
        0.25,
        width,
        ERA5_GRID.rows,
        np.tile(row, (ERA5_GRID.rows, 1)),
        north_edge=ERA5_GRID.north_deg,
    )

    with rasterio.open(path) as dataset:
        [(month, values, _)] = read_months(dataset, ["0001"], ERA5_TEMPERATURE)

    assert month == "2016-01" and values.shape == ERA5_SHAPE
    assert np.allclose(values[0], (-180 + np.arange(1440) * 0.25) % 360, atol=1e-3)


def test_era5_month_with_a_missing_cell_is_refused_and_leaves_no_cube(tmp_path):
    field = np.full(ERA5_SHAPE, 20, "float32")
    field[7, 7] = np.nan

    with pytest.raises(ValueError, match="no value in some cells"):
        write_months(tmp_path, ERA5_TEMPERATURE, [("2016-01", field, "0001")])

    assert not (tmp_path / "era5_temperature.zarr").exists()


def test_era5land_month_with_missing_cells_is_still_accepted(tmp_path):
    field = celsius_field(20)
    field[7, 7] = np.nan

    write_months(tmp_path, LAND, [("2016-01", field, "0001")])

    assert np.isnan(land_cube(tmp_path).read("2016-01", (7, 7, 1, 1))[0, 0])


@pytest.mark.parametrize(("seconds", "days"), [(JAN_2016_SECS, 31), (FEB_2016_SECS, 29)])
def test_precipitation_in_metres_per_day_becomes_mm_for_the_whole_month(tmp_path, seconds, days):
    path = tmp_path / "field.tif"
    write_precipitation_raster(path, np.full(ERA5_SHAPE, 0.002), [seconds])

    with rasterio.open(path) as dataset:
        [(_, values, _)] = read_months(dataset, ["0001"], ERA5_PRECIPITATION)

    assert values[5, 5] == pytest.approx(2 * days, rel=1e-5)


def write_precipitation_raster(
    path: Path,
    values: np.ndarray,
    valid_seconds: list[int] | None = None,
) -> None:
    """Write GRIB-like precipitation bands on the ERA5 grid in metres per day."""
    write_raster(
        path,
        ERA5_GRID.west_deg,
        ERA5_GRID.res,
        ERA5_GRID.columns,
        ERA5_GRID.rows,
        values,
        valid_seconds,
        ERA5_GRID.north_deg,
        unit="[m]",
    )


@pytest.mark.parametrize(
    ("valid_time", "month", "days"),
    [
        ("2019-12-31T18:00:00+00:00", "2020-01", 31),
        ("2020-01-31T18:00:00+00:00", "2020-02", 29),
        ("2021-01-31T18:00:00+00:00", "2021-02", 28),
    ],
)
def test_precipitation_stamped_before_month_uses_next_month_and_its_day_count(
    tmp_path,
    valid_time,
    month,
    days,
):
    path = tmp_path / "field.tif"
    valid_seconds = int(datetime.fromisoformat(valid_time).timestamp())
    write_precipitation_raster(path, np.full(ERA5_SHAPE, 0.002), [valid_seconds])
    with rasterio.open(path) as dataset:
        write_months(
            tmp_path,
            ERA5_PRECIPITATION,
            read_months(dataset, ["0001"], ERA5_PRECIPITATION),
        )
    cube = MonthlyCube(ERA5_PRECIPITATION.cube, tmp_path)

    assert list(cube.months()) == [month]
    assert cube.read(month, (5, 5, 1, 1))[0, 0] == pytest.approx(2 * days)


def test_precipitation_packing_noise_below_zero_becomes_zero(tmp_path):
    path = tmp_path / "field.tif"
    write_precipitation_raster(path, np.full(ERA5_SHAPE, -1e-9))

    with rasterio.open(path) as dataset:
        [(_, values, _)] = read_months(dataset, ["0001"], ERA5_PRECIPITATION)

    assert (values == 0).all()


def test_precipitation_cube_stores_tenths_of_a_millimetre(tmp_path):
    field = np.full(ERA5_SHAPE, 58.04, "float32")

    write_months(tmp_path, ERA5_PRECIPITATION, [("2016-01", field, "0001")])

    stored = zarr.open_group(tmp_path / "era5_precipitation.zarr", mode="r")["tp"]
    assert stored.dtype == "uint16" and stored[66 * 12, 3, 3] == 580


def test_month_that_the_cube_encoding_would_clip_is_refused(tmp_path):
    field = np.full(ERA5_SHAPE, 7000, "float32")

    with pytest.raises(ValueError, match="values outside 0 to 6553.4 mm/month"):
        write_months(tmp_path, ERA5_PRECIPITATION, [("2016-01", field, "0001")])

    assert not (tmp_path / "era5_precipitation.zarr").exists()


def test_precipitation_file_in_kelvin_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    write_raster(path, -180.125, 0.25, 1440, ERA5_GRID.rows, np.zeros(ERA5_SHAPE), None, 60.125)

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match=r"expected \[m\]"):
        list(read_months(dataset, ["0001"], ERA5_PRECIPITATION))


@pytest.mark.parametrize(
    ("name", "dataset", "variable"),
    [
        ("era5land_temperature", "reanalysis-era5-land-monthly-means", "2m_temperature"),
        ("era5_temperature", "reanalysis-era5-single-levels-monthly-means", "2m_temperature"),
        (
            "era5_precipitation",
            "reanalysis-era5-single-levels-monthly-means",
            "total_precipitation",
        ),
    ],
)
def test_ingest_asks_the_cds_for_the_dataset_and_variable_of_the_cube(
    tmp_path,
    monkeypatch,
    name,
    dataset,
    variable,
):
    monkeypatch.setattr(cube_ingest, "read_grib_months", lambda path, spec: iter(()))
    monkeypatch.setattr(cube_ingest, "_newest_month", lambda: "2016-02")
    client = FakeClient()

    ingest(tmp_path, INGEST_SPECS[name], "2016-01", client)

    assert {asked for asked, _ in client.requests} == {dataset}
    assert all(request["variable"] == [variable] for _, request in client.requests)
    assert all(request["area"] == [60, -180, -60, 180] for _, request in client.requests)


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_precipitation_with_a_non_finite_cell_is_refused_when_read(tmp_path, bad):
    path = tmp_path / "field.tif"
    field = np.full(ERA5_SHAPE, 0.002)
    field[7, 7] = bad
    write_precipitation_raster(path, field)

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match="no value in some cells"):
        list(read_months(dataset, ["0001"], ERA5_PRECIPITATION))


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_precipitation_with_a_non_finite_cell_is_refused_when_written(tmp_path, bad):
    field = np.full(ERA5_SHAPE, 20, "float32")
    field[7, 7] = bad

    with pytest.raises(ValueError, match="no value in some cells"):
        write_months(tmp_path, ERA5_PRECIPITATION, [("2016-01", field, "0001")])

    assert not (tmp_path / "era5_precipitation.zarr").exists()


def test_earlier_months_extend_a_cube_backwards_and_leave_later_ones_alone(tmp_path):
    write_months(tmp_path, LAND, [("2016-01", celsius_field(20), "0001")])
    later = land_cube(tmp_path).read("2016-01", (7, 7, 1, 1))
    shape_before = zarr.open_group(tmp_path / CUBE_NAME, mode="r")[CUBE_ARRAY].shape

    earlier = [("2015-11", celsius_field(5), "0001"), ("2015-12", celsius_field(6), "0001")]
    write_months(tmp_path, LAND, earlier)

    cube = land_cube(tmp_path)
    assert list(cube.months()) == ["2015-11", "2015-12", "2016-01"]
    assert cube.read("2015-11", (7, 7, 1, 1))[0, 0] == pytest.approx(5)
    assert cube.read("2016-01", (7, 7, 1, 1)) == pytest.approx(later)
    assert zarr.open_group(tmp_path / CUBE_NAME, mode="r")[CUBE_ARRAY].shape == shape_before


def test_ingest_from_an_earlier_month_adds_the_earlier_years_newest_year_first(tmp_path, fake_grib):
    client = FakeClient()
    ingest(tmp_path, LAND, "2016-11", client)
    client.requests.clear()

    ingest(tmp_path, LAND, "2014-11", client)

    requested = [(request["year"][0], request["month"][0]) for _, request in client.requests]
    assert requested[:3] == [("2016", "01"), ("2015", "01"), ("2014", "11")]
    months = list(land_cube(tmp_path).months())
    assert (months[0], months[-1], len(months)) == ("2014-11", "2017-02", 28)
