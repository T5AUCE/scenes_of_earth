"""Download monthly ERA5-Land and ERA5 variables and store each one in its local cube.

Months are requested from the Climate Data Store one year at a time as GRIB. Each file is checked
against the cube grid and converted to the cube's units. A cube is written in a way that lets
readers see new data only together with its revision marker. Months that are still preliminary
are fetched again on later runs, so that final data replaces them. Year files that were
downloaded beforehand can be stored without a request.
"""
import calendar
import logging
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

import numpy as np
import rasterio

from ..sources import (
    ERA5_LAND_PRECIPITATION_84N_CUBE,
    ERA5_LAND_TEMPERATURE_84N_CUBE,
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_PRECIPITATION_84N_CUBE,
    ERA5_PRECIPITATION_CUBE,
    ERA5_TEMPERATURE_84N_CUBE,
    ERA5_TEMPERATURE_CUBE,
    CubeSpec,
    Grid,
)
from ..sources.cubes import (
    FINAL_EXPVER,
    HIGH_LATITUDE_SUFFIX,
    PRELIMINARY_EXPVER,
    is_preliminary,
)
from ..sources.periods import MONTH_CHARS
from .cubes import (
    DOWNLOADS_DIR,
    RESOLUTION_TOLERANCE_DEG,
    MonthField,
    cube_attrs,
    months_between,
    newest_month,
    next_month,
    previous_month,
    write_months,
    year_batches,
)

if TYPE_CHECKING:
    import cdsapi

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
CENTRE_TOLERANCE_CELLS = 1e-6  # how far a cell centre may lie from a multiple of the cell size
CELSIUS_ZERO_K = 273.15
MM_PER_M = 1000
YEAR_CHARS = 4
AREA_DECIMALS = 3  # of the request area, which absorbs float noise in the grid edges

log = logging.getLogger("soe")


class IngestSpec(NamedTuple):
    """Describe how to download a cube variable and convert it to the cube units."""

    cube: CubeSpec
    cds_dataset: str
    variable: str
    grib_unit: str  # as GDAL reports it with GRIB_NORMALIZE_UNITS=NO
    convert: Callable[[np.ndarray, str], np.ndarray]  # (values in grib_unit, month) -> cube units
    complete: bool  # the source has a value in every cell, so a gap marks a damaged file

    @property
    def files_name(self) -> str:
        """The name that precedes the year in the year files downloaded beforehand."""
        return self.cube.name.removesuffix(HIGH_LATITUDE_SUFFIX)


def ingest(
    cube_dir: Path | str,
    spec: IngestSpec,
    start_month: str,
    client: "cdsapi.Client | None" = None,
    files_dir: Path | str | None = None,
) -> None:
    """Add the published months from `start_month` to the cube, and refresh preliminary ones.

    The first run starts at `start_month`; later runs continue after the last stored month. A
    `start_month` before the first stored month adds the earlier months, newest year first, so the
    stored months stay contiguous. With `files_dir`, each year's months that the cube lacks are
    stored from its year file where they join the stored months, and the files stay where they
    are. All other months are requested from the Climate Data Store, which needs the `cdsapi`
    package and a CDS key in `~/.cdsapirc` unless a client is supplied.
    """
    cube_dir = Path(cube_dir)
    newest = newest_month()
    attrs = cube_attrs(cube_dir, spec.cube)
    stored = attrs.get("months", {})
    months = _wanted_months(stored, attrs.get("pending", []), start_month, newest)
    batches = year_batches(months, newest, min(stored, default=None))
    year_files = _year_files(Path(files_dir), spec) if files_dir is not None else {}
    downloads = cube_dir / DOWNLOADS_DIR
    for batch in batches:
        year_file = year_files.get(int(batch[0][:YEAR_CHARS]))
        to_request = _store_from_year_file(cube_dir, spec, batch, start_month, year_file)
        if not to_request:
            continue

        if client is None:
            import cdsapi

            client = cdsapi.Client()

        downloads.mkdir(parents=True, exist_ok=True)
        log.info("%s: requesting %s to %s", spec.cube.title, to_request[0], to_request[-1])
        _ingest_batch(client, cube_dir, spec, to_request, downloads, to_request == [newest])


def _year_files(files_dir: Path, spec: IngestSpec) -> dict[int, Path]:
    """Return the finished year files by year.

    A file that is still downloading ends in `.part` instead of `.grib`, so it never matches.
    """
    pattern = f"{spec.files_name}-[0-9][0-9][0-9][0-9].grib"
    return {int(path.stem[-YEAR_CHARS:]): path for path in files_dir.glob(pattern)}


def _store_from_year_file(
    cube_dir: Path,
    spec: IngestSpec,
    batch: list[str],
    start_month: str,
    year_file: Path | None,
) -> list[str]:
    """Store the months of the batch that the year file holds and the cube can take now.

    A month is stored only if it joins the stored months without a gap, which earlier batches may
    have just made possible. A stored month is never replaced, so that final data fetched later is
    not overwritten by an older file. Return the months of the batch that still need fetching.
    """
    if year_file is None:
        return batch

    attrs = cube_attrs(cube_dir, spec.cube)
    stored = attrs.get("months", {})
    kept = stored.keys() - set(attrs.get("pending", []))
    replaceable = set(batch) - kept
    fields = {
        field[0]: field
        for field in read_grib_months(year_file, spec)
        if field[0] in replaceable
    }
    joining = _joining_months(stored, fields.keys(), start_month)
    if joining:
        log.info("%s: storing %d months from %s", spec.cube.title, len(joining), year_file.name)
        write_months(cube_dir, spec.cube, spec.complete, [fields[month] for month in joining])
    return [month for month in batch if month not in joining]


def _joining_months(stored: dict[str, str], candidates: Iterable[str], first: str) -> set[str]:
    """Return the candidates that replace a stored month or extend the stored months.

    An empty cube is extended from `first`.
    """
    candidates = set(candidates)
    joining = candidates & stored.keys()
    forward = next_month(max(stored)) if stored else first
    joining |= _consecutive_from(forward, next_month, candidates)
    if stored:
        joining |= _consecutive_from(previous_month(min(stored)), previous_month, candidates)
    return joining


def _consecutive_from(
    month: str,
    following: Callable[[str], str],
    candidates: set[str],
) -> set[str]:
    """Return the candidates from `month` on, stopping at the first month that is not one."""
    run = set()
    while month in candidates:
        run.add(month)
        month = following(month)
    return run


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
    first = next_month(max(stored)) if stored else start_month
    new = months_between(first, newest)
    earlier = months_between(start_month, previous_month(min(stored))) if stored else []

    preliminary = [month for month, marker in stored.items() if is_preliminary(marker)]
    return sorted({*new, *earlier, *preliminary, *pending})


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
            write_months(cube_dir, spec.cube, spec.complete, read_grib_months(target, spec))
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
        "area": _area(spec.cube.grid),
    }


def _area(grid: Grid) -> list[float]:
    """The request area N, W, S, E that spans the centres of the grid's first and last rows."""
    north, south = _row_extent_deg(grid)
    return [north, -180, south, 180]


def _row_extent_deg(grid: Grid) -> tuple[float, float]:
    """Latitudes of the centres of the grid's first and last rows."""
    north = round(grid.north_deg - grid.res / 2, AREA_DECIMALS)
    return north, round(north - (grid.rows - 1) * grid.res, AREA_DECIMALS)


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
        valid_time = datetime.fromtimestamp(valid_seconds, timezone.utc)
        # ERA5 monthly accumulations can be stamped at 18:00 on the previous month's last day.
        month = (valid_time + timedelta(days=1)).strftime("%Y-%m")
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
        north, south = _row_extent_deg(grid)
        raise ValueError(f"the raster rows must run from {north:g}N to {abs(south):g}S")

    return rows, columns


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
        IngestSpec(
            ERA5_LAND_TEMPERATURE_84N_CUBE,
            "reanalysis-era5-land-monthly-means",
            "2m_temperature",
            "[K]",
            _kelvin_to_celsius,
            complete=False,
        ),
        IngestSpec(
            ERA5_LAND_PRECIPITATION_84N_CUBE,
            "reanalysis-era5-land-monthly-means",
            "total_precipitation",
            "[m]",
            _metres_per_day_to_mm_per_month,
            complete=False,
        ),
        IngestSpec(
            ERA5_TEMPERATURE_84N_CUBE,
            "reanalysis-era5-single-levels-monthly-means",
            "2m_temperature",
            "[K]",
            _kelvin_to_celsius,
            complete=True,
        ),
        IngestSpec(
            ERA5_PRECIPITATION_84N_CUBE,
            "reanalysis-era5-single-levels-monthly-means",
            "total_precipitation",
            "[m]",
            _metres_per_day_to_mm_per_month,
            complete=True,
        ),
    )
}
