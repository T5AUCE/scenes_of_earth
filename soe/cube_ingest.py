"""Download monthly ERA5-Land and ERA5 variables and store each one in its local cube.

Months are requested from the Climate Data Store one year at a time as GRIB. Each file is checked
against the cube grid and converted to the cube's units. A cube is written in a way that lets
readers see new data only together with its revision marker. Months that are still preliminary
are fetched again on later runs, so that final data replaces them.
"""
import calendar
import hashlib
import logging
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from itertools import groupby
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

import numpy as np
import rasterio
import zarr

from .build import COMPRESSION, encode_values
from .sources import (
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_PRECIPITATION_CUBE,
    ERA5_TEMPERATURE_CUBE,
    CubeSpec,
    Grid,
)
from .sources.chirps import previous_month
from .sources.cubes import (
    CUBE_TIME_ORIGIN,
    FINAL_EXPVER,
    PRELIMINARY_EXPVER,
    is_preliminary,
    month_index,
)
from .sources.periods import MONTH_CHARS, add_duration

if TYPE_CHECKING:
    import cdsapi

DOWNLOADS_DIR = ".downloads"  # holds each GRIB file until it has been stored

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
RESOLUTION_TOLERANCE_DEG = 1e-6
CENTRE_TOLERANCE_CELLS = 1e-6  # how far a cell centre may lie from a multiple of the cell size
CELSIUS_ZERO_K = 273.15
MM_PER_M = 1000
TIME_CHUNK_MONTHS = 12
LAT_LON_CHUNK_CELLS = 32
LAT_LON_SHARD_CELLS = 512

log = logging.getLogger("soe")

MonthField = tuple[str, np.ndarray, str]  # month 'YYYY-MM', values in the cube's units, expver


class IngestSpec(NamedTuple):
    """Describe how to download a cube variable and convert it to the cube units."""

    cube: CubeSpec
    cds_dataset: str
    variable: str
    grib_unit: str  # as GDAL reports it with GRIB_NORMALIZE_UNITS=NO
    convert: Callable[[np.ndarray, str], np.ndarray]  # (values in grib_unit, month) -> cube units
    complete: bool  # the source has a value in every cell, so a gap marks a damaged file


def ingest(
    cube_dir: Path | str,
    spec: IngestSpec,
    start_month: str,
    client: "cdsapi.Client | None" = None,
) -> None:
    """Add the published months from `start_month` to the cube, and refresh preliminary ones.

    The first run starts at `start_month`; later runs continue after the last stored month. A
    `start_month` before the first stored month adds the earlier months, newest year first, so the
    stored months stay contiguous. The ingest requires the `cdsapi` package and a CDS key in
    `~/.cdsapirc` unless a client is supplied.
    """
    if client is None:
        import cdsapi

        client = cdsapi.Client()

    cube_dir = Path(cube_dir)
    newest = _newest_month()
    attrs = _cube_attrs(cube_dir, spec.cube)
    stored = attrs.get("months", {})
    months = _wanted_months(stored, attrs.get("pending", []), start_month, newest)
    downloads = cube_dir / DOWNLOADS_DIR
    downloads.mkdir(parents=True, exist_ok=True)

    for batch in _batches(months, newest, min(stored, default=None)):
        log.info("%s: requesting %s to %s", spec.cube.title, batch[0], batch[-1])
        _ingest_batch(client, cube_dir, spec, batch, downloads, batch == [newest])


def _newest_month() -> str:
    """The month before the current one, the newest that can be complete."""
    now = datetime.now(timezone.utc)
    return "{:04d}-{:02d}".format(*previous_month(now.year, now.month))


def _cube_attrs(cube_dir: Path, cube: CubeSpec) -> dict:
    path = cube_dir / f"{cube.name}.zarr"
    return dict(zarr.open_group(path, mode="r").attrs) if path.exists() else {}


def _wanted_months(
    stored: dict[str, str],
    pending: list[str],
    start_month: str,
    newest: str,
) -> list[str]:
    """Return the months that need fetching in ascending order.

    These are the new months up to `newest` and the earlier ones back to `start_month`. They also
    include the stored months that are still preliminary or pending.
    """
    first = _next_month(max(stored)) if stored else start_month
    new = _months_between(first, newest)
    earlier = _months_between(start_month, _previous_month(min(stored))) if stored else []

    preliminary = [month for month, marker in stored.items() if is_preliminary(marker)]
    return sorted({*new, *earlier, *preliminary, *pending})


def _months_between(first: str, last: str) -> list[str]:
    """Return the inclusive month range or an empty list when `first` is after `last`."""
    months = []
    month = first
    while month <= last:
        months.append(month)
        month = _next_month(month)
    return months


def _next_month(month: str) -> str:
    return add_duration(f"{month}-01", "P1M")[:MONTH_CHARS]


def _previous_month(month: str) -> str:
    return add_duration(f"{month}-01", "P1M", -1)[:MONTH_CHARS]


def _batches(months: list[str], newest: str, first_stored: str | None = None) -> list[list[str]]:
    """Group requested months by year in an order that keeps stored months contiguous.

    Earlier years are fetched newest first so each batch joins the stored interval. The newest
    month is requested separately because it may not be published yet.
    """
    older = [month for month in months if month != newest]
    batches = [list(year_months) for _, year_months in groupby(older, lambda month: month[:4])]
    if first_stored is not None:
        earlier = [batch for batch in batches if batch[0] < first_stored]
        batches = [*reversed(earlier), *batches[len(earlier):]]
    return [*batches, [newest]] if newest in months else batches


def _ingest_batch(
    client: "cdsapi.Client",
    cube_dir: Path,
    spec: IngestSpec,
    batch: list[str],
    downloads: Path,
    may_be_unpublished: bool,
) -> None:
    target = downloads / f"{spec.cube.name}-{batch[0]}.grib"
    try:
        if _retrieve(client, spec, batch, target, may_be_unpublished):
            write_months(cube_dir, spec, read_grib_months(target, spec))
    finally:
        target.unlink(missing_ok=True)


def _retrieve(
    client: "cdsapi.Client",
    spec: IngestSpec,
    batch: list[str],
    target: Path,
    may_be_unpublished: bool,
) -> bool:
    """Download the batch; False when the CDS says that the newest month is not published yet."""
    try:
        client.retrieve(spec.cds_dataset, _request(spec, batch), str(target))
    except Exception as error:
        # cdsapi raises a plain Exception, so the message is the only way to tell this case.
        unpublished = any(text in str(error).lower() for text in UNPUBLISHED_MESSAGES)
        if not (may_be_unpublished and unpublished):
            raise

        log.info("%s of %s is not published yet", spec.cube.title, batch[0])
        return False

    return True


def _request(spec: IngestSpec, batch: list[str]) -> dict:
    return {
        "product_type": ["monthly_averaged_reanalysis"],
        "variable": [spec.variable],
        "year": [batch[0][:4]],
        "month": [month[5:MONTH_CHARS] for month in batch],
        "time": ["00:00"],
        "data_format": "grib",
        "download_format": "unarchived",
        "area": [60, -180, -60, 180],  # N, W, S, E
    }


def read_grib_months(path: Path | str, spec: IngestSpec) -> Iterator[MonthField]:
    """Yield each GRIB message as its month and cube-grid values together with its experiment
    version.
    """
    expvers = grib_expvers(path)
    with open_grib(path) as dataset:
        yield from read_months(dataset, expvers, spec)


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
    spec: IngestSpec,
) -> Iterator[MonthField]:
    """Yield each raster band as its month and cube-grid values together with its experiment
    version.

    Raise ValueError unless the band count matches `expvers` and the raster uses the expected units
    and cube grid.
    """
    if dataset.count != len(expvers):
        raise ValueError(f"{dataset.count} bands but {len(expvers)} GRIB messages")

    grid = spec.cube.grid
    rows, columns = _cube_positions(dataset, grid)
    for band, expver in enumerate(expvers, start=1):
        tags = dataset.tags(band)
        if tags.get("GRIB_UNIT") != spec.grib_unit:
            raise ValueError(f"expected {spec.grib_unit} values, got {tags.get('GRIB_UNIT')}")

        valid_seconds = int(tags["GRIB_VALID_TIME"].split()[0])
        month = datetime.fromtimestamp(valid_seconds, timezone.utc).strftime("%Y-%m")
        source = dataset.read(band, masked=True).astype("float32").filled(np.nan)
        # Unit conversion clamps, so a -inf cell would otherwise turn into a plausible zero.
        if spec.complete and not np.isfinite(source).all():
            raise ValueError(f"{month}: the source has no value in some cells")

        values = np.full((grid.rows, grid.columns), np.nan, "float32")
        values[np.ix_(rows, columns)] = spec.convert(source, month)
        yield month, values, expver


def _cube_positions(dataset: rasterio.DatasetReader, grid: Grid) -> tuple[np.ndarray, np.ndarray]:
    """Cube (rows, columns) of the raster's rows and columns, whatever its longitude origin."""
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
    # Cell centres lie on multiples of the cell size, so the cube's first centre is -180.
    columns_exact = (lon_centres + 180) / grid.res
    rows_exact = (grid.north_deg - grid.res / 2 - lat_centres) / grid.res
    columns, rows = np.rint(columns_exact), np.rint(rows_exact)
    on_centres = (
        np.allclose(columns_exact, columns, rtol=0, atol=CENTRE_TOLERANCE_CELLS)
        and np.allclose(rows_exact, rows, rtol=0, atol=CENTRE_TOLERANCE_CELLS)
    )
    if not on_centres:
        raise ValueError(f"cell centres are not on {grid.res} degree multiples")

    columns = columns.astype(int) % grid.columns
    rows = rows.astype(int)
    if not np.array_equal(np.unique(columns), np.arange(grid.columns)):
        raise ValueError("the raster does not cover all longitudes")
    if not np.array_equal(rows, np.arange(grid.rows)):
        raise ValueError("the raster rows must run from 60N to 60S")

    return rows, columns


def write_months(cube_dir: Path | str, spec: IngestSpec, months: Iterable[MonthField]) -> None:
    """Store months in the cube, creating it if needed, and mark each with its revision.

    A month must replace a stored one, follow the last stored one, or precede the first as part of
    a contiguous batch. Every month is checked and
    encoded before anything is written. The cube is then flagged as updating, which readers
    treat as unavailable, until the data and all markers are published in one step. If a write
    fails, the flag stays and the next run of these months clears it.
    """
    cube_dir = Path(cube_dir)
    attrs = _cube_attrs(cube_dir, spec.cube)
    markers = dict(attrs.get("months", {}))
    staged = _stage_months(months, markers, spec)
    if not staged:
        return

    group = _open_cube(cube_dir, spec.cube)
    staged_months = {month for month, _, _ in staged}
    pending = sorted({*attrs.get("pending", []), *staged_months})
    _begin_update(group, pending)
    for month, encoded, marker in staged:
        _store_month(group[spec.cube.array], month, encoded)
        markers[month] = marker

    _publish(group, markers, [month for month in pending if month not in staged_months])


def _stage_months(
    months: Iterable[MonthField],
    stored: dict[str, str],
    spec: IngestSpec,
) -> list[tuple[str, np.ndarray, str]]:
    """Check that each month fits the cube, then return it with its encoded values and marker."""
    cube = spec.cube
    markers = dict(stored)
    staged = []
    for month, values, expver in months:
        if values.shape != (cube.grid.rows, cube.grid.columns):
            raise ValueError(f"{month}: field shape {values.shape} is not the cube grid")
        if spec.complete and not np.isfinite(values).all():
            raise ValueError(f"{month}: the source has no value in some cells")

        _check_before_origin(month)
        _check_in_range(month, values, cube)
        encoded = encode_values(values, cube.dtype, cube.scale, 0, cube.fill)
        marker = f"{expver}:{hashlib.sha256(encoded.tobytes()).hexdigest()[:12]}"
        markers[month] = marker
        staged.append((month, encoded, marker))

    _check_not_a_gap(markers)
    return staged


def _check_in_range(month: str, values: np.ndarray, cube: CubeSpec) -> None:
    """Reject a month that the cube's encoding would clip, which a wrong unit would cause."""
    finite = values[np.isfinite(values)]
    limits = np.iinfo(cube.dtype)
    lowest = (limits.min + (cube.fill == limits.min)) * cube.scale
    highest = (limits.max - (cube.fill == limits.max)) * cube.scale
    if finite.size and (finite.min() < lowest or finite.max() > highest):
        raise ValueError(f"{month}: values outside {lowest:g} to {highest:g} {cube.units}")


def _check_before_origin(month: str) -> None:
    if month_index(month) < 0:
        raise ValueError(f"{month} is before the cube's first month {CUBE_TIME_ORIGIN}")


def _check_not_a_gap(markers: dict[str, str]) -> None:
    """Reject months that are not consecutive, whatever order the batch had them in."""
    ordered = sorted(markers)
    for before, after in zip(ordered, ordered[1:]):
        if month_index(after) != month_index(before) + 1:
            raise ValueError(f"{after} would leave a gap after {before}")


def _open_cube(cube_dir: Path, cube: CubeSpec) -> zarr.Group:
    group = zarr.open_group(cube_dir / f"{cube.name}.zarr", mode="a")
    if "months" not in group.attrs:
        group.attrs.update(
            {
                "time_origin": CUBE_TIME_ORIGIN,
                "grid": [
                    cube.grid.west_deg,
                    cube.grid.north_deg,
                    cube.grid.res,
                    cube.grid.columns,
                    cube.grid.rows,
                ],
                "months": {},
                "pending": [],
            },
        )
    if cube.array not in group:
        group.create_array(
            cube.array,
            shape=(0, cube.grid.rows, cube.grid.columns),
            chunks=(TIME_CHUNK_MONTHS, LAT_LON_CHUNK_CELLS, LAT_LON_CHUNK_CELLS),
            shards=(TIME_CHUNK_MONTHS, LAT_LON_SHARD_CELLS, LAT_LON_SHARD_CELLS),
            dtype=cube.dtype,
            fill_value=cube.fill,
            compressors=COMPRESSION,
            dimension_names=["time", "lat", "lon"],
            attributes={"units": cube.units, "scale_factor": cube.scale, "add_offset": 0},
        )
    return group


def _begin_update(group: zarr.Group, pending: list[str]) -> None:
    group.attrs["pending"] = pending


def _store_month(array: zarr.Array, month: str, encoded: np.ndarray) -> None:
    index = month_index(month)
    if index >= array.shape[0]:
        array.resize((index + 1, *array.shape[1:]))

    array[index] = encoded


def _publish(group: zarr.Group, markers: dict[str, str], pending: list[str]) -> None:
    group.attrs.update({"months": dict(sorted(markers.items())), "pending": pending})


def _kelvin_to_celsius(values: np.ndarray, month: str) -> np.ndarray:
    return values - CELSIUS_ZERO_K


def _metres_per_day_to_mm_per_month(values: np.ndarray, month: str) -> np.ndarray:
    """Monthly mean precipitation is a depth per day, so the month's total is days times that."""
    days = calendar.monthrange(int(month[:4]), int(month[5:MONTH_CHARS]))[1]
    # GRIB packing noise can leave tiny negative precipitation values.
    return np.maximum(values * MM_PER_M * days, 0)


INGEST_SPECS = {
    spec.cube.name: spec
    for spec in (
        IngestSpec(
            ERA5_LAND_TEMPERATURE_CUBE,
            "reanalysis-era5-land-monthly-means",
            "2m_temperature",
            "[K]",
            _kelvin_to_celsius,
            complete=False,
        ),
        IngestSpec(
            ERA5_TEMPERATURE_CUBE,
            "reanalysis-era5-single-levels-monthly-means",
            "2m_temperature",
            "[K]",
            _kelvin_to_celsius,
            complete=True,
        ),
        IngestSpec(
            ERA5_PRECIPITATION_CUBE,
            "reanalysis-era5-single-levels-monthly-means",
            "total_precipitation",
            "[m]",
            _metres_per_day_to_mm_per_month,
            complete=True,
        ),
    )
}
