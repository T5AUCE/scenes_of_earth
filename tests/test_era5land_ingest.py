"""Offline tests: GRIB header parsing, cube grid normalisation and writing, CDS requests."""
import hashlib
import json
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
import rasterio.shutil
import zarr
from rasterio.transform import Affine, from_origin

from soe import era5land_ingest
from soe.era5land_ingest import (
    MonthField,
    grib_expvers,
    ingest,
    open_grib,
    read_months,
    write_months,
)
from soe.sources import ERA5_LAND_GRID, Era5LandCube, SourceUnavailable
from soe.sources.era5land import CUBE_ARRAY, CUBE_NAME, month_index

GRIB_SECTION1_BYTES = 52  # long enough to hold the ECMWF experiment version
EXPVER_IN_SECTION1_BYTES = 45
UNPUBLISHED = "None of the data you have requested is available yet, please try again later."
JAN_2016_SECS = 1451606400
SHAPE = (ERA5_LAND_GRID.rows, ERA5_LAND_GRID.columns)


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
    north_edge: float = ERA5_LAND_GRID.north_deg,
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
        "width": ERA5_LAND_GRID.columns,
        "height": ERA5_LAND_GRID.rows,
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": ERA5_LAND_GRID.transform,
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


def test_expver_is_read_from_each_grib1_message(tmp_path):
    path = tmp_path / "months.grib"
    path.write_bytes(grib1_message("0001") + grib1_message("0005"))

    assert grib_expvers(path) == ["0001", "0005"]


def test_message_with_grib_bytes_in_its_data_is_one_message(tmp_path):
    path = tmp_path / "months.grib"
    path.write_bytes(grib1_message("0001", payload=b"xxGRIB\x02yy") + grib1_message("0005"))

    assert grib_expvers(path) == ["0001", "0005"]


def test_ecmwf_large_message_length_code_is_followed(tmp_path):
    path = tmp_path / "months.grib"
    large = grib1_message("0005", payload=bytes(500), large=True)
    path.write_bytes(large + grib1_message("0001"))

    assert grib_expvers(path) == ["0005", "0001"]


def test_plain_message_over_8_mib_is_not_taken_for_a_large_one(tmp_path):
    path = tmp_path / "months.grib"
    path.write_bytes(grib1_message("0001", payload=bytes(9 * 1024 * 1024)) + grib1_message("0005"))

    assert grib_expvers(path) == ["0001", "0005"]


def test_genuine_ecmwf_large_message_is_walked(tmp_path):
    path = tmp_path / "months.grib"
    large = grib1_message("0005", payload=bytes(9 * 1024 * 1024 + 7), large=True)
    path.write_bytes(large + grib1_message("0001"))

    assert grib_expvers(path) == ["0005", "0001"]


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


def test_grib2_message_is_refused(tmp_path):
    path = tmp_path / "months.grib"
    path.write_bytes(grib1_message("0001", edition=2))

    with pytest.raises(ValueError, match="edition 1"):
        grib_expvers(path)


def test_unknown_experiment_version_is_refused(tmp_path):
    path = tmp_path / "months.grib"
    path.write_bytes(grib1_message("0042"))

    with pytest.raises(ValueError, match="experiment version"):
        grib_expvers(path)


@pytest.mark.parametrize("west_edge", [-0.05, -180.05])
def test_grid_with_any_longitude_origin_lands_on_the_cube_grid(tmp_path, west_edge):
    path = tmp_path / "field.tif"
    width = ERA5_LAND_GRID.columns
    centres = west_edge + (np.arange(width) + 0.5) * 0.1
    row = (centres % 360).astype("float32")
    write_raster(path, west_edge, 0.1, width, ERA5_LAND_GRID.rows, np.tile(row, (SHAPE[0], 1)))

    with rasterio.open(path) as dataset:
        [(month, celsius, expver)] = read_months(dataset, ["0001"])

    cube_centres = -180 + np.arange(width) * 0.1
    assert (month, expver) == ("2016-01", "0001")
    assert np.allclose(celsius[0] + 273.15, cube_centres % 360, atol=1e-3)


def test_grid_with_another_resolution_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    write_raster(path, -180, 0.25, 10, 10, np.zeros((10, 10)))

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match="0.1 degree cells"):
        list(read_months(dataset, ["0001"]))


def test_raster_that_misses_part_of_the_grid_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    write_raster(path, -180.05, 0.1, 100, 100, np.zeros((100, 100)))

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match="does not cover"):
        list(read_months(dataset, ["0001"]))


def test_kelvin_becomes_celsius_and_ocean_becomes_fill(tmp_path):
    path = tmp_path / "field.tif"
    kelvin = np.full(SHAPE, 300.15)
    kelvin[0, 0] = 9999
    write_raster(path, -180.05, 0.1, SHAPE[1], SHAPE[0], kelvin)

    with rasterio.open(path) as dataset:
        write_months(tmp_path / "cubes", read_months(dataset, ["0001"]))

    stored = zarr.open_group(tmp_path / "cubes" / CUBE_NAME, mode="r")[CUBE_ARRAY]
    january_2016 = 66 * 12
    assert stored[january_2016, 1, 1] == 2700
    assert stored[january_2016, 0, 0] == -32768


def test_gdal_grib_temperature_is_read_in_kelvin_and_converted_once(tmp_path):
    path = tmp_path / "field.grb2"
    write_gdal_grib(path, celsius=27.0)

    with open_grib(path) as dataset:
        [(month, celsius, _)] = read_months(dataset, ["0001"])

    assert month == "2016-01"
    assert celsius[5, 5] == pytest.approx(27.0, abs=0.01)


def test_temperature_already_in_celsius_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    write_raster(path, -180.05, 0.1, SHAPE[1], SHAPE[0], np.full(SHAPE, 27), unit="[C]")

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match=r"\[K\]"):
        list(read_months(dataset, ["0001"]))


def test_raster_shifted_one_row_north_is_refused(tmp_path):
    path = tmp_path / "field.tif"
    shifted_north = ERA5_LAND_GRID.north_deg + 0.1
    write_raster(path, -180.05, 0.1, SHAPE[1], SHAPE[0], np.zeros(SHAPE), north_edge=shifted_north)

    with rasterio.open(path) as dataset, pytest.raises(ValueError, match="60N to 60S"):
        list(read_months(dataset, ["0001"]))


def test_rotated_raster_is_refused():
    rotated = Affine(0.1, 0.01, -180.05, 0, -0.1, 60.05)
    dataset = SimpleNamespace(count=1, transform=rotated, width=SHAPE[1], height=SHAPE[0])

    with pytest.raises(ValueError, match="unrotated"):
        list(read_months(dataset, ["0001"]))


def test_rewriting_an_unchanged_month_keeps_its_marker(tmp_path):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0001")])
    marker = Era5LandCube(tmp_path).t2m_months()["2016-01"]

    write_months(tmp_path, [("2016-01", celsius_field(20), "0001")])
    unchanged = Era5LandCube(tmp_path).t2m_months()["2016-01"]
    write_months(tmp_path, [("2016-01", celsius_field(21), "0001")])
    changed = Era5LandCube(tmp_path).t2m_months()["2016-01"]

    assert unchanged == marker
    assert changed != marker and changed.startswith("0001:")


def test_gap_between_months_is_refused(tmp_path):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0001")])

    with pytest.raises(ValueError, match="gap"):
        write_months(tmp_path, [("2016-03", celsius_field(20), "0001")])

    assert list(Era5LandCube(tmp_path).t2m_months()) == ["2016-01"]


def test_failed_batch_changes_neither_data_nor_marker(tmp_path):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0005")])
    before = Era5LandCube(tmp_path).t2m_months()["2016-01"]

    def failing_batch() -> Iterator[MonthField]:
        yield "2016-01", celsius_field(21), "0001"
        raise ValueError("second field is invalid")

    with pytest.raises(ValueError, match="second field"):
        write_months(tmp_path, failing_batch())

    cube = Era5LandCube(tmp_path)
    assert cube.t2m_months()["2016-01"] == before
    assert cube.read_t2m("2016-01", (0, 0, 1, 1))[0, 0] == pytest.approx(20)


def test_published_marker_matches_the_stored_bytes(tmp_path):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0001")])
    stored = zarr.open_group(tmp_path / CUBE_NAME, mode="r")[CUBE_ARRAY][month_index("2016-01")]

    marker = Era5LandCube(tmp_path).t2m_months()["2016-01"]

    assert marker == "0001:" + hashlib.sha256(stored.tobytes()).hexdigest()[:12]


def test_field_of_the_wrong_shape_is_refused_before_anything_is_written(tmp_path):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0005")])
    before = Era5LandCube(tmp_path).t2m_months()

    for bad_shape in ((1200, 3600), (1201, 3599), (3600,)):
        later_bad = [
            ("2016-01", celsius_field(21), "0001"),
            ("2016-02", np.full(bad_shape, 21, "float32"), "0001"),
        ]
        with pytest.raises(ValueError, match="not the cube grid"):
            write_months(tmp_path, later_bad)

    cube = Era5LandCube(tmp_path)
    assert cube.t2m_months() == before
    assert cube.read_t2m("2016-01", (0, 0, 1, 1))[0, 0] == pytest.approx(20)


def two_months() -> list[MonthField]:
    return [("2016-01", celsius_field(21), "0001"), ("2016-02", celsius_field(22), "0001")]


def test_failure_while_storing_data_leaves_the_cube_unavailable_until_rewritten(
    tmp_path,
    monkeypatch,
):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0005")])
    store_month = era5land_ingest._store_month
    stored = []

    def store_then_fail(array, month, encoded) -> None:
        if stored:
            raise OSError("disk full")

        store_month(array, month, encoded)
        stored.append(month)

    monkeypatch.setattr(era5land_ingest, "_store_month", store_then_fail)
    with pytest.raises(OSError, match="disk full"):
        write_months(tmp_path, two_months())

    cube = Era5LandCube(tmp_path)
    assert not cube.has_t2m()
    with pytest.raises(SourceUnavailable, match="being updated"):
        cube.read_t2m("2016-01", (0, 0, 1, 1))

    monkeypatch.undo()
    write_months(tmp_path, two_months())

    recovered = Era5LandCube(tmp_path)
    assert list(recovered.t2m_months()) == ["2016-01", "2016-02"]
    assert recovered.read_t2m("2016-01", (0, 0, 1, 1))[0, 0] == pytest.approx(21)


def test_failure_while_publishing_markers_leaves_the_cube_unavailable_until_rewritten(
    tmp_path,
    monkeypatch,
):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0005")])

    def fail_to_publish(group, markers, pending) -> None:
        raise OSError("metadata not written")

    monkeypatch.setattr(era5land_ingest, "_publish", fail_to_publish)
    with pytest.raises(OSError, match="metadata"):
        write_months(tmp_path, two_months())

    assert not Era5LandCube(tmp_path).has_t2m()

    monkeypatch.undo()
    write_months(tmp_path, [two_months()[1]])
    assert not Era5LandCube(tmp_path).has_t2m()

    write_months(tmp_path, two_months())
    recovered = Era5LandCube(tmp_path)
    assert recovered.t2m_months()["2016-01"].startswith("0001:")
    assert recovered.read_t2m("2016-02", (0, 0, 1, 1))[0, 0] == pytest.approx(22)


def test_failure_before_the_update_starts_changes_nothing(tmp_path, monkeypatch):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0005")])
    before = Era5LandCube(tmp_path).t2m_months()

    def fail_to_begin(group, pending) -> None:
        raise OSError("metadata not written")

    monkeypatch.setattr(era5land_ingest, "_begin_update", fail_to_begin)
    with pytest.raises(OSError):
        write_months(tmp_path, two_months())

    cube = Era5LandCube(tmp_path)
    assert cube.t2m_months() == before
    assert cube.read_t2m("2016-01", (0, 0, 1, 1))[0, 0] == pytest.approx(20)


def test_read_that_overlaps_an_update_is_refused(tmp_path, monkeypatch):
    write_months(tmp_path, [("2016-01", celsius_field(20), "0005")])
    cube = Era5LandCube(tmp_path)
    cube.t2m_months()
    open_group = zarr.open_group

    def open_then_update(*args, **kwargs):
        monkeypatch.undo()
        group = open_group(*args, **kwargs)
        write_months(tmp_path, [("2016-01", celsius_field(21), "0001")])
        return group

    monkeypatch.setattr(zarr, "open_group", open_then_update)

    with pytest.raises(SourceUnavailable, match="being updated"):
        cube.read_t2m("2016-01", (0, 0, 1, 1))


def test_ingest_refetches_months_left_pending_by_a_failed_update(tmp_path, fake_grib):
    write_months(tmp_path, [("2016-12", celsius_field(20), "0001")])
    group = zarr.open_group(tmp_path / CUBE_NAME, mode="a")
    group.attrs["pending"] = ["2016-12"]
    client = FakeClient()

    ingest(tmp_path, "2016-12", client)

    requested = [(request["year"], request["month"]) for _, request in client.requests]
    assert (["2016"], ["12"]) in requested
    assert Era5LandCube(tmp_path).has_t2m()


def test_failed_first_batch_leaves_no_cube(tmp_path):
    def failing_batch() -> Iterator[MonthField]:
        raise ValueError("first field is invalid")
        yield

    with pytest.raises(ValueError, match="first field"):
        write_months(tmp_path, failing_batch())

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

    def read_fake(path: Path) -> Iterator[MonthField]:
        for month in json.loads(Path(path).read_text()):
            yield month, celsius_field(20), "0005" if month >= "2017" else "0001"

    monkeypatch.setattr(era5land_ingest, "read_grib_months", read_fake)
    monkeypatch.setattr(era5land_ingest, "_newest_month", lambda: "2017-02")


def test_ingest_requests_one_year_per_call_and_refetches_preliminary_months(tmp_path, fake_grib):
    client = FakeClient()
    ingest(tmp_path, "2016-11", client)
    first_run = len(client.requests)

    client.requests.clear()
    ingest(tmp_path, "2016-11", client)

    months = [(request["year"], request["month"]) for _, request in client.requests]
    assert first_run == 3
    assert months == [(["2017"], ["01"]), (["2017"], ["02"])]
    assert list(Era5LandCube(tmp_path).t2m_months()) == [
        "2016-11",
        "2016-12",
        "2017-01",
        "2017-02",
    ]
    assert not list((tmp_path / ".downloads").iterdir())


def test_unpublished_last_month_is_skipped_not_failed(tmp_path, fake_grib):
    client = FakeClient(refuse_month="2017-02")

    ingest(tmp_path, "2016-12", client)

    assert list(Era5LandCube(tmp_path).t2m_months()) == ["2016-12", "2017-01"]


def test_refused_request_for_an_older_month_fails(tmp_path, fake_grib):
    client = FakeClient(refuse_month="2016-12")

    with pytest.raises(Exception, match="available yet"):
        ingest(tmp_path, "2016-12", client)


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
        ingest(tmp_path, "2017-01", client)


def test_invalid_download_of_the_newest_month_fails_and_leaves_no_cube(tmp_path, monkeypatch):
    monkeypatch.setattr(era5land_ingest, "_newest_month", lambda: "2017-01")
    client = GribClient(grib1_message("0001", edition=2))

    with pytest.raises(ValueError, match="only GRIB edition 1"):
        ingest(tmp_path, "2017-01", client)

    assert not (tmp_path / CUBE_NAME).exists()
