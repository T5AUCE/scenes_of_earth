"""Read monthly Zarr cubes from local disk and expose their revision markers.

A cube holds one variable on a fixed grid with one slice per month. `soe.cube_ingest` writes the
cubes, and a build only reads them, so it makes no network calls for cube data. Each month carries
a marker that changes whenever its data is replaced, which lets scene ids follow revisions.
"""
from itertools import groupby
from pathlib import Path
from typing import NamedTuple

import numpy as np
import zarr

from .grid import CellWindow, Grid
from .periods import MONTH_CHARS
from .remote import SourceUnavailable

DEFAULT_CUBES_DIR = Path("./data/cubes")

CUBE_TIME_ORIGIN = "1950-01"  # index 0 of every cube's time axis
MONTHS_PER_YEAR = 12

PRELIMINARY_EXPVER = "0005"  # ERA5T and ERA5-Land-T, replaced by final data about two months later
FINAL_EXPVER = "0001"


class CubeSpec(NamedTuple):
    """Describe a cube's variable and grid together with its encoding."""

    name: str  # of the cube folder, which is <name>.zarr
    title: str  # in messages
    array: str
    grid: Grid
    dtype: str
    scale: float  # stored = decoded / scale
    fill: int  # stored value that means "no data"
    units: str


class MonthlyCube:
    """Read a monthly cube maintained on local disk by `soe.cube_ingest`."""

    def __init__(self, spec: CubeSpec, cubes_dir: Path | str = DEFAULT_CUBES_DIR) -> None:
        self._spec = spec
        self._cube_path = Path(cubes_dir) / f"{spec.name}.zarr"
        self._months_read = None  # (change stamp, months) from the last load

    def has_months(self) -> bool:
        """Return whether the cube has published months and no pending update."""
        try:
            self.months()
        except SourceUnavailable:
            return False

        return True

    def months(self) -> dict[str, str]:
        """Return the marker of each stored month ('YYYY-MM' -> 'expver:hash'), oldest first.

        Raise SourceUnavailable unless the cube is readable and contains published months with
        no pending update.
        """
        return self._months_at(self._modified())

    def read(self, month: str, window: CellWindow) -> np.ndarray:
        """Return one month of the window as float32, with NaN for fill and rows past the edge.

        The cube must be published and unchanged from before it is checked until the window has
        been read, so the bytes always belong to the markers. Otherwise this raises
        SourceUnavailable.
        """
        stamp = self._modified()
        self._months_at(stamp)
        col, row, width, height = window
        array = zarr.open_group(self._cube_path, mode="r")[self._spec.array]
        stored_height = max(0, min(height, self._spec.grid.rows - row))
        stored = array[month_index(month), row:row + stored_height, col:col + width]
        if self._modified() != stamp:
            raise SourceUnavailable(self._updating)

        values = np.full((height, width), np.nan, "float32")
        decoded = stored.astype("float32") * np.float32(self._spec.scale)
        values[:stored_height] = np.where(stored == self._spec.fill, np.nan, decoded)
        return values

    @property
    def _not_ingested(self) -> str:
        return f"{self._spec.title} cube not ingested"

    @property
    def _updating(self) -> str:
        return f"{self._spec.title} cube is being updated or an update failed"

    def _months_at(self, stamp: int) -> dict[str, str]:
        """Return the published months while the cube still has `stamp`, read once per stamp."""
        if self._months_read is None or self._months_read[0] != stamp:
            months = self._load_months()
            if self._modified() != stamp:
                raise SourceUnavailable(self._updating)

            self._months_read = (stamp, months)
        if not self._months_read[1]:
            raise SourceUnavailable(self._not_ingested)

        return self._months_read[1]

    def _modified(self) -> int:
        """Return the change stamp of the published state, which every ingest step updates."""
        try:
            return (self._cube_path / "zarr.json").stat().st_mtime_ns
        except FileNotFoundError:
            raise SourceUnavailable(self._not_ingested)

    def _load_months(self) -> dict[str, str]:
        try:
            group = zarr.open_group(self._cube_path, mode="r")
            if self._spec.array not in group:
                raise KeyError(self._spec.array)

            months = dict(group.attrs["months"])
            pending = group.attrs.get("pending", [])
        except (OSError, KeyError, ValueError, zarr.errors.BaseZarrError):
            raise SourceUnavailable(self._not_ingested)

        if pending:
            raise SourceUnavailable(self._updating)

        return months


class CubeStore:
    """Manage monthly cubes in one folder and select them by specification."""

    def __init__(self, specs: tuple[CubeSpec, ...], cubes_dir: Path | str) -> None:
        self._cubes = {spec.name: MonthlyCube(spec, cubes_dir) for spec in specs}

    def has_cube(self, spec: CubeSpec) -> bool:
        """Return whether the cube has published months and no pending update."""
        return self._cubes[spec.name].has_months()

    def cube_months(self, spec: CubeSpec) -> dict[str, str]:
        """Return the marker of each month the cube stores, oldest first; see MonthlyCube.months."""
        return self._cubes[spec.name].months()

    def read_cube(self, spec: CubeSpec, month: str, window: CellWindow) -> np.ndarray:
        """Return one month of the window as float32 in the cube's units; see MonthlyCube.read."""
        return self._cubes[spec.name].read(month, window)


def month_index(month: str) -> int:
    """Return the position of month 'YYYY-MM' on the cubes' time axis."""
    return _month_number(month) - _month_number(CUBE_TIME_ORIGIN)


def is_preliminary(marker: str) -> bool:
    """Return whether an `expver:hash` marker identifies preliminary data."""
    return marker.startswith(PRELIMINARY_EXPVER + ":")


def month_markers(months: dict[str, str], labels: list[str]) -> list[str]:
    """Return the markers of the months 'YYYY-MM' in `labels`, from a cube's `months`.

    Raise SourceUnavailable if a requested month is no longer stored.
    """
    missing = [label for label in labels if label not in months]
    if missing:
        raise SourceUnavailable(f"The cube does not hold {missing[0]} any more")

    return [months[label] for label in labels]


def preliminary_runs(labels: list[str], *cube_months: dict[str, str]) -> list[list[str]]:
    """Return the runs of consecutive months in `labels` that are preliminary in any cube."""
    return [
        list(run)
        for preliminary, run in groupby(
            labels,
            lambda label: any(is_preliminary(months[label]) for months in cube_months),
        )
        if preliminary
    ]


def _month_number(month: str) -> int:
    return int(month[:4]) * MONTHS_PER_YEAR + int(month[5:MONTH_CHARS])
