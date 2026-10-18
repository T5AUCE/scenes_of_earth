"""Fill the ERA5-Land temperature cube from the Climate Data Store (one GRIB request per year)."""
import hashlib
import logging
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from itertools import groupby
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import rasterio
import zarr

from .build import COMPRESSION, encode_values
from .sources import ERA5_LAND_GRID
from .sources.chirps import MONTH_CHARS, previous_month
from .sources.era5land import (
    CUBE_ARRAY,
    CUBE_FILL,
    CUBE_NAME,
    CUBE_SCALE,
    CUBE_TIME_ORIGIN,
    FINAL_EXPVER,
    PRELIMINARY_EXPVER,
    is_preliminary,
    month_index,
)
from .sources.periods import add_duration

if TYPE_CHECKING:
    import cdsapi

CDS_DATASET = "reanalysis-era5-land-monthly-means"
DOWNLOADS_DIR = ".downloads"  # inside the cubes directory

UNPUBLISHED_MESSAGES = ("none of the data you have requested is available yet",)

GRIB_MAGIC = b"GRIB"
GRIB_END = b"7777"
GRIB_SECTION0_BYTES = 8
GRIB_EDITION_OFFSET_BYTES = 7
GRIB_LENGTH_BYTES = 3  # of the total message and of each section
GRIB_FLAGS_OFFSET_BYTES = 7  # in section 1
GDS_PRESENT_FLAG = 0x80
BMS_PRESENT_FLAG = 0x40
PDS_MIN_BYTES = 28
GDS_MIN_BYTES = 6
BMS_MIN_BYTES = 6
BDS_MIN_BYTES = 11
LARGE_MESSAGE_FLAG = 0x800000  # set by ECMWF large messages, but also by plain ones over 8 MiB
LARGE_MESSAGE_UNIT_BYTES = 120
LARGE_MESSAGE_LENGTH_MASK = 0x7FFFFF
EXPVER_OFFSET_BYTES = 45  # in section 1; octets 46-49
EXPVER_CHARS = 4
KELVIN_UNIT = "[K]"
RESOLUTION_TOLERANCE_DEG = 1e-6
CENTRE_TOLERANCE = 1e-6  # in cells
CELSIUS_ZERO_K = 273.15
TIME_CHUNK_MONTHS = 12
LAT_LON_CHUNK_CELLS = 32
LAT_LON_SHARD_CELLS = 512

log = logging.getLogger("soe")

MonthField = tuple[str, np.ndarray, str]  # month 'YYYY-MM', degrees C, expver


def ingest(cube_dir: Path | str, start_month: str, client: "cdsapi.Client | None" = None) -> None:
    """Add the published months from `start_month` to the cube, and refresh preliminary ones.

    The first run starts at `start_month`; later runs continue after the last stored month.
    Needs the `cdsapi` package and a CDS key in ~/.cdsapirc unless a `client` is given.
    """
    if client is None:
        import cdsapi

        client = cdsapi.Client()

    cube_dir = Path(cube_dir)
    newest = _newest_month()
    attrs = _cube_attrs(cube_dir)
    months = _wanted_months(attrs.get("months", {}), attrs.get("pending", []), start_month, newest)
    downloads = cube_dir / DOWNLOADS_DIR
    downloads.mkdir(parents=True, exist_ok=True)

    for batch in _batches(months, newest):
        log.info("ERA5-Land temperature: requesting %s to %s", batch[0], batch[-1])
        _ingest_batch(client, cube_dir, batch, downloads, batch == [newest])


def _newest_month() -> str:
    """The month before the current one, the newest that can be complete."""
    now = datetime.now(timezone.utc)
    return "{:04d}-{:02d}".format(*previous_month(now.year, now.month))


def _cube_attrs(cube_dir: Path) -> dict:
    path = cube_dir / CUBE_NAME
    return dict(zarr.open_group(path, mode="r").attrs) if path.exists() else {}


def _wanted_months(
    stored: dict[str, str],
    pending: list[str],
    start_month: str,
    newest: str,
) -> list[str]:
    """New months up to `newest`, plus the stored months that are still preliminary or pending."""
    first = _next_month(max(stored)) if stored else start_month
    new = []
    month = first
    while month <= newest:
        new.append(month)
        month = _next_month(month)

    preliminary = [month for month, marker in stored.items() if is_preliminary(marker)]
    return sorted({*new, *preliminary, *pending})


def _next_month(month: str) -> str:
    return add_duration(f"{month}-01", "P1M")[:MONTH_CHARS]


def _batches(months: list[str], newest: str) -> list[list[str]]:
    """One batch per year; the newest month is alone, as it may not be published yet."""
    older = [month for month in months if month != newest]
    batches = [list(year_months) for _, year_months in groupby(older, lambda month: month[:4])]
    return [*batches, [newest]] if newest in months else batches


def _ingest_batch(
    client: "cdsapi.Client",
    cube_dir: Path,
    batch: list[str],
    downloads: Path,
    may_be_unpublished: bool,
) -> None:
    target = downloads / f"{batch[0]}.grib"
    try:
        if _retrieve(client, batch, target, may_be_unpublished):
            write_months(cube_dir, read_grib_months(target))
    finally:
        target.unlink(missing_ok=True)


def _retrieve(
    client: "cdsapi.Client",
    batch: list[str],
    target: Path,
    may_be_unpublished: bool,
) -> bool:
    """Download the batch; False when the CDS says that the newest month is not published yet."""
    try:
        client.retrieve(CDS_DATASET, _request(batch), str(target))
    except Exception as error:
        # cdsapi raises a plain Exception, so the message is the only way to tell this case.
        unpublished = any(text in str(error).lower() for text in UNPUBLISHED_MESSAGES)
        if not (may_be_unpublished and unpublished):
            raise

        log.info("ERA5-Land temperature of %s is not published yet", batch[0])
        return False

    return True


def _request(batch: list[str]) -> dict:
    return {
        "product_type": ["monthly_averaged_reanalysis"],
        "variable": ["2m_temperature"],
        "year": [batch[0][:4]],
        "month": [month[5:MONTH_CHARS] for month in batch],
        "time": ["00:00"],
        "data_format": "grib",
        "download_format": "unarchived",
        "area": [60, -180, -60, 180],  # N, W, S, E
    }


def read_grib_months(path: Path | str) -> Iterator[MonthField]:
    """(month, degrees C on the cube grid, expver) of each message in a CDS GRIB file."""
    expvers = grib_expvers(path)
    with open_grib(path) as dataset:
        yield from read_months(dataset, expvers)


def grib_expvers(path: Path | str) -> list[str]:
    """The experiment version of each GRIB1 message in the file, in order.

    Messages are walked by their lengths, including ECMWF's large-message length code. Raises
    ValueError for GRIB2, a truncated or unexpected message, or an experiment version that is
    neither final nor preliminary.
    """
    content = Path(path).read_bytes()
    expvers = []
    start = 0
    while start < len(content):
        length, expver = _grib1_message(content, start)
        expvers.append(expver)
        start += length
    return expvers


def _grib1_message(content: bytes, start: int) -> tuple[int, str]:
    """(length in bytes, experiment version) of the GRIB1 message that starts at `start`."""
    if content[start:start + len(GRIB_MAGIC)] != GRIB_MAGIC:
        raise ValueError(f"expected a GRIB message at byte {start}")

    edition_at = start + GRIB_EDITION_OFFSET_BYTES
    if edition_at >= len(content) or content[edition_at] != 1:
        raise ValueError("only GRIB edition 1 is supported")

    section1 = start + GRIB_SECTION0_BYTES
    section1_length = _section_length(content, section1, PDS_MIN_BYTES)
    flags = content[section1 + GRIB_FLAGS_OFFSET_BYTES]
    data_section = section1 + section1_length
    for flag, minimum in ((GDS_PRESENT_FLAG, GDS_MIN_BYTES), (BMS_PRESENT_FLAG, BMS_MIN_BYTES)):
        if flags & flag:
            data_section += _section_length(content, data_section, minimum)

    data_section_field = _length_at(content, data_section)
    stated_length = _length_at(content, start + len(GRIB_MAGIC))
    is_large = _is_large_message(stated_length, data_section_field)
    length = stated_length
    if is_large:
        length = _large_message_length(stated_length, data_section_field)

    end = start + length
    if end > len(content) or content[end - len(GRIB_END):end] != GRIB_END:
        raise ValueError(f"GRIB message at byte {start} is truncated or has a bad length")

    data_section_bytes = end - len(GRIB_END) - data_section
    if data_section_bytes < BDS_MIN_BYTES:
        raise ValueError(f"GRIB message at byte {start} has no room for its data section")
    if not is_large and data_section_field != data_section_bytes:
        raise ValueError(f"GRIB message at byte {start} has a wrong data section length")

    return length, _experiment_version(content, section1, section1_length)


def _is_large_message(stated_length: int, data_section_field: int) -> bool:
    """Whether the message uses ECMWF's large-message length code, as ecCodes decides it.

    A plain message over 8 MiB also sets the high bit, but its data section is long; in a
    large message that field is under 120 because it counts padding.
    """
    has_flag = bool(stated_length & LARGE_MESSAGE_FLAG)
    return has_flag and data_section_field < LARGE_MESSAGE_UNIT_BYTES


def _large_message_length(stated_length: int, data_section_field: int) -> int:
    units = stated_length & LARGE_MESSAGE_LENGTH_MASK
    return units * LARGE_MESSAGE_UNIT_BYTES - data_section_field + len(GRIB_END)


def _experiment_version(content: bytes, section1: int, section1_length: int) -> str:
    if EXPVER_OFFSET_BYTES + EXPVER_CHARS > section1_length:
        raise ValueError("GRIB message has no experiment version")

    expver_at = section1 + EXPVER_OFFSET_BYTES
    expver = content[expver_at:expver_at + EXPVER_CHARS].decode("ascii", errors="replace")
    if expver not in (FINAL_EXPVER, PRELIMINARY_EXPVER):
        raise ValueError(f"unknown experiment version {expver!r}")

    return expver


def _section_length(content: bytes, offset: int, minimum: int) -> int:
    length = _length_at(content, offset)
    if length < minimum or offset + length > len(content):
        raise ValueError(f"GRIB section at byte {offset} has an impossible length {length}")

    return length


def _length_at(content: bytes, offset: int) -> int:
    if offset < 0 or offset + GRIB_LENGTH_BYTES > len(content):
        raise ValueError("GRIB message is truncated")

    return int.from_bytes(content[offset:offset + GRIB_LENGTH_BYTES], "big")


@contextmanager
def open_grib(path: Path | str) -> Iterator[rasterio.DatasetReader]:
    """Open a GRIB file with the units of the file, not GDAL's converted ones."""
    with rasterio.Env(GRIB_NORMALIZE_UNITS="NO"), rasterio.open(path) as dataset:
        yield dataset


def read_months(
    dataset: rasterio.DatasetReader,
    expvers: list[str],
) -> Iterator[MonthField]:
    """Each band of an open raster as (month, degrees C on the cube grid, expver).

    Raises ValueError unless the bands match `expvers`, are in Kelvin, and the grid is the
    cube's 0.1 degree grid, in any longitude origin.
    """
    if dataset.count != len(expvers):
        raise ValueError(f"{dataset.count} bands but {len(expvers)} GRIB messages")

    rows, columns = _cube_positions(dataset)
    for band, expver in enumerate(expvers, start=1):
        tags = dataset.tags(band)
        if tags.get("GRIB_UNIT") != KELVIN_UNIT:
            raise ValueError(f"expected temperature in {KELVIN_UNIT}, got {tags.get('GRIB_UNIT')}")

        valid_seconds = int(tags["GRIB_VALID_TIME"].split()[0])
        month = datetime.fromtimestamp(valid_seconds, timezone.utc).strftime("%Y-%m")
        kelvin = dataset.read(band, masked=True).astype("float32")

        celsius = np.full((ERA5_LAND_GRID.rows, ERA5_LAND_GRID.columns), np.nan, "float32")
        celsius[np.ix_(rows, columns)] = kelvin.filled(np.nan) - CELSIUS_ZERO_K
        yield month, celsius, expver


def _cube_positions(dataset: rasterio.DatasetReader) -> tuple[np.ndarray, np.ndarray]:
    """Cube (rows, columns) of the raster's rows and columns, whatever its longitude origin."""
    grid = ERA5_LAND_GRID
    transform = dataset.transform
    straight = max(abs(transform.b), abs(transform.d)) < RESOLUTION_TOLERANCE_DEG
    right_size = (
        abs(transform.a - grid.res) < RESOLUTION_TOLERANCE_DEG
        and abs(-transform.e - grid.res) < RESOLUTION_TOLERANCE_DEG
    )
    if not (straight and right_size):
        raise ValueError(f"expected unrotated {grid.res} degree cells, got {transform}")

    lon_centres = transform.c + (np.arange(dataset.width) + 0.5) * transform.a
    lat_centres = transform.f + (np.arange(dataset.height) + 0.5) * transform.e
    # Cell centres lie on 0.1 degree multiples, so the cube's first centre is -180.
    columns_exact = (lon_centres + 180) / grid.res
    rows_exact = (grid.north_deg - grid.res / 2 - lat_centres) / grid.res
    columns, rows = np.rint(columns_exact), np.rint(rows_exact)
    on_centres = (
        np.allclose(columns_exact, columns, rtol=0, atol=CENTRE_TOLERANCE)
        and np.allclose(rows_exact, rows, rtol=0, atol=CENTRE_TOLERANCE)
    )
    if not on_centres:
        raise ValueError("cell centres are not on 0.1 degree multiples")

    columns = columns.astype(int) % grid.columns
    rows = rows.astype(int)
    if not np.array_equal(np.unique(columns), np.arange(grid.columns)):
        raise ValueError("the raster does not cover all longitudes")
    if not np.array_equal(rows, np.arange(grid.rows)):
        raise ValueError("the raster rows must run from 60N to 60S")

    return rows, columns


def write_months(cube_dir: Path | str, months: Iterable[MonthField]) -> None:
    """Store months in the cube, creating it if needed, and mark each with its revision.

    A month must follow the last stored one or replace a stored one. Every month is checked and
    encoded before anything is written. The cube is then flagged as updating, which readers
    treat as unavailable, until the data and all markers are published in one step. If a write
    fails, the flag stays and the next run of these months clears it.
    """
    cube_dir = Path(cube_dir)
    attrs = _cube_attrs(cube_dir)
    markers = dict(attrs.get("months", {}))
    staged = _stage_months(months, markers)
    if not staged:
        return

    group = _open_cube(cube_dir)
    staged_months = {month for month, _, _ in staged}
    pending = sorted({*attrs.get("pending", []), *staged_months})
    _begin_update(group, pending)
    for month, encoded, marker in staged:
        _store_month(group[CUBE_ARRAY], month, encoded)
        markers[month] = marker

    _publish(group, markers, [month for month in pending if month not in staged_months])


def _begin_update(group: zarr.Group, pending: list[str]) -> None:
    group.attrs["pending"] = pending


def _store_month(array: zarr.Array, month: str, encoded: np.ndarray) -> None:
    index = month_index(month)
    if index >= array.shape[0]:
        array.resize((index + 1, *array.shape[1:]))

    array[index] = encoded


def _publish(group: zarr.Group, markers: dict[str, str], pending: list[str]) -> None:
    group.attrs.update({"months": dict(sorted(markers.items())), "pending": pending})


def _stage_months(
    months: Iterable[MonthField],
    stored: dict[str, str],
) -> list[tuple[str, np.ndarray, str]]:
    """(month, encoded values, marker) of each month, after checking that they fit the cube."""
    markers = dict(stored)
    staged = []
    for month, celsius, expver in months:
        if celsius.shape != (ERA5_LAND_GRID.rows, ERA5_LAND_GRID.columns):
            raise ValueError(f"{month}: field shape {celsius.shape} is not the cube grid")

        _check_not_a_gap(month, markers)
        encoded = encode_values(celsius, "int16", CUBE_SCALE, 0, CUBE_FILL)
        marker = f"{expver}:{hashlib.sha256(encoded.tobytes()).hexdigest()[:12]}"
        markers[month] = marker
        staged.append((month, encoded, marker))
    return staged


def _open_cube(cube_dir: Path) -> zarr.Group:
    group = zarr.open_group(cube_dir / CUBE_NAME, mode="a")
    if "months" not in group.attrs:
        group.attrs.update(
            {
                "time_origin": CUBE_TIME_ORIGIN,
                "grid": [
                    ERA5_LAND_GRID.west_deg,
                    ERA5_LAND_GRID.north_deg,
                    ERA5_LAND_GRID.res,
                    ERA5_LAND_GRID.columns,
                    ERA5_LAND_GRID.rows,
                ],
                "months": {},
                "pending": [],
            },
        )
    if CUBE_ARRAY not in group:
        group.create_array(
            CUBE_ARRAY,
            shape=(0, ERA5_LAND_GRID.rows, ERA5_LAND_GRID.columns),
            chunks=(TIME_CHUNK_MONTHS, LAT_LON_CHUNK_CELLS, LAT_LON_CHUNK_CELLS),
            shards=(TIME_CHUNK_MONTHS, LAT_LON_SHARD_CELLS, LAT_LON_SHARD_CELLS),
            dtype="int16",
            fill_value=CUBE_FILL,
            compressors=COMPRESSION,
            dimension_names=["time", "lat", "lon"],
            attributes={"units": "degC", "scale_factor": CUBE_SCALE, "add_offset": 0},
        )
    return group


def _check_not_a_gap(month: str, markers: dict[str, str]) -> None:
    if month_index(month) < 0:
        raise ValueError(f"{month} is before the cube's first month {CUBE_TIME_ORIGIN}")
    if markers and month not in markers and month_index(month) != month_index(max(markers)) + 1:
        raise ValueError(f"{month} would leave a gap after {max(markers)}")
