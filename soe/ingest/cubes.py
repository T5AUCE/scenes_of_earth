"""Write monthly cubes and share the month calendar that every cube ingest uses.

A cube is written in a way that lets readers see new data only together with its revision marker.
The month helpers pick which months a run fetches and group them into yearly batches that keep the
stored months contiguous.
"""
import hashlib
from collections.abc import Iterable
from datetime import datetime, timezone
from itertools import groupby
from pathlib import Path

import numpy as np
import zarr

from ..build import COMPRESSION, encode_values
from ..sources import CubeSpec
from ..sources.cubes import CUBE_TIME_ORIGIN, month_index
from ..sources.periods import MONTH_CHARS, add_duration

DOWNLOADS_DIR = ".downloads"  # holds each downloaded file until it has been stored

RESOLUTION_TOLERANCE_DEG = 1e-6

TIME_CHUNK_MONTHS = 12
LAT_LON_CHUNK_CELLS = 32
LAT_LON_SHARD_CELLS = 512

MonthField = tuple[str, np.ndarray, str]  # month 'YYYY-MM', values in the cube's units, expver


def write_months(
    cube_dir: Path | str,
    cube: CubeSpec,
    complete: bool,
    months: Iterable[MonthField],
    attrs: dict[str, object] | None = None,
) -> None:
    """Store months in the cube, creating it if needed, and mark each with its revision.

    A month must replace a stored one, follow the last stored one, or precede the first as part of
    a contiguous batch. Every month is checked and encoded before anything is written. The cube is
    then flagged as updating, which readers treat as unavailable, until the data and all markers
    are published in one step. If a write fails, the flag stays and the next run of these months
    clears it. Extra group attributes in `attrs` are published with the markers, so they cannot
    disagree with the data.
    """
    cube_dir = Path(cube_dir)
    stored = cube_attrs(cube_dir, cube)
    markers = dict(stored.get("months", {}))
    staged = _stage_months(months, markers, cube, complete)
    if not staged:
        return

    group = _open_cube(cube_dir, cube)
    staged_months = {month for month, _, _ in staged}
    pending = sorted({*stored.get("pending", []), *staged_months})
    _begin_update(group, pending)
    _store_run(group[cube.array], staged)
    for month, _, marker in staged:
        markers[month] = marker

    _publish(
        group,
        markers,
        [month for month in pending if month not in staged_months],
        attrs,
    )


def _stage_months(
    months: Iterable[MonthField],
    stored: dict[str, str],
    cube: CubeSpec,
    complete: bool,
) -> list[tuple[str, np.ndarray, str]]:
    """Check that each month fits the cube, then return it with its encoded values and marker."""
    markers = dict(stored)
    staged = []
    for month, values, expver in months:
        if values.shape != (cube.grid.rows, cube.grid.columns):
            raise ValueError(f"{month}: field shape {values.shape} is not the cube grid")
        if complete and not np.isfinite(values).all():
            raise ValueError(f"{month}: the source has no value in some cells")

        _check_before_origin(month)
        _check_in_range(month, values, cube)
        encoded = encode_values(values, cube.dtype, cube.scale, 0, cube.fill)
        marker = f"{expver}:{hashlib.sha256(encoded.tobytes()).hexdigest()[:12]}"
        markers[month] = marker
        staged.append((month, encoded, marker))

    _check_not_a_gap(markers)
    return staged


def _check_before_origin(month: str) -> None:
    if month_index(month) < 0:
        raise ValueError(f"{month} is before the cube's first month {CUBE_TIME_ORIGIN}")


def _check_in_range(month: str, values: np.ndarray, cube: CubeSpec) -> None:
    """Reject a month that the cube's encoding would clip, which a wrong unit would cause."""
    finite = values[np.isfinite(values)]
    limits = np.iinfo(cube.dtype)
    lowest = (limits.min + (cube.fill == limits.min)) * cube.scale
    highest = (limits.max - (cube.fill == limits.max)) * cube.scale
    if finite.size and (finite.min() < lowest or finite.max() > highest):
        raise ValueError(f"{month}: values outside {lowest:g} to {highest:g} {cube.units}")


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


def _store_run(array: zarr.Array, staged: list[tuple[str, np.ndarray, str]]) -> None:
    """Store staged months with one slice assignment per consecutive run."""
    for run in _consecutive_runs(staged):
        first = month_index(run[0][0])
        last = month_index(run[-1][0])
        if last + 1 > array.shape[0]:
            array.resize((last + 1, *array.shape[1:]))

        array[first:last + 1] = np.stack([encoded for _, encoded, _ in run])


def _consecutive_runs(
    staged: list[tuple[str, np.ndarray, str]],
) -> list[list[tuple[str, np.ndarray, str]]]:
    """Group staged months into consecutive runs in ascending order."""
    ordered = sorted(staged)
    runs = [[ordered[0]]]
    for entry in ordered[1:]:
        if month_index(entry[0]) == month_index(runs[-1][-1][0]) + 1:
            runs[-1].append(entry)
        else:
            runs.append([entry])

    return runs


def _publish(
    group: zarr.Group,
    markers: dict[str, str],
    pending: list[str],
    attrs: dict[str, object] | None = None,
) -> None:
    """Publish markers, pending and extra attributes together so they cannot disagree."""
    group.attrs.update(
        {
            "months": dict(sorted(markers.items())),
            "pending": pending,
            **(attrs or {}),
        },
    )


def cube_attrs(cube_dir: Path, cube: CubeSpec) -> dict:
    """Return the cube's group attributes, or an empty dict before its first write."""
    path = cube_dir / f"{cube.name}.zarr"
    return dict(zarr.open_group(path, mode="r").attrs) if path.exists() else {}


def newest_month() -> str:
    """The month before the current one, the newest that can be complete."""
    return previous_month(datetime.now(timezone.utc).strftime("%Y-%m"))


def months_between(first: str, last: str) -> list[str]:
    """Return the inclusive month range or an empty list when `first` is after `last`."""
    months = []
    month = first
    while month <= last:
        months.append(month)
        month = next_month(month)
    return months


def next_month(month: str) -> str:
    """Return the month 'YYYY-MM' after `month`."""
    return add_duration(f"{month}-01", "P1M")[:MONTH_CHARS]


def previous_month(month: str) -> str:
    """Return the month 'YYYY-MM' before `month`."""
    return add_duration(f"{month}-01", "P1M", -1)[:MONTH_CHARS]


def year_batches(
    months: list[str],
    newest: str,
    first_stored: str | None = None,
) -> list[list[str]]:
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
