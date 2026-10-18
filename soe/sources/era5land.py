"""ERA5-Land monthly 2 m temperature: the dataset, its grid and the reader of the local cube."""
import hashlib
from itertools import groupby
from pathlib import Path

import numpy as np
import zarr

from .chirps import MONTH_CHARS
from .datasets import SeriesDataset
from .grid import Bbox, CellWindow, Grid, block_mean, read_wrapped
from .remote import SourceUnavailable

# Cell centres sit on 0.1 degree multiples, half a cell off the CHIRPS grid.
ERA5_LAND_GRID = Grid(-180.05, 60.05, 0.1, 3600, 1201)

CUBE_NAME = "era5land_t2m.zarr"
CUBE_ARRAY = "t2m"
CUBE_TIME_ORIGIN = "1950-01"  # index 0 of the cube's time axis
CUBE_SCALE = 0.01  # stored = degrees C / CUBE_SCALE
CUBE_FILL = -32768
DEFAULT_CUBES_DIR = Path("./data/cubes")

PRELIMINARY_EXPVER = "0005"  # ERA5-Land-T, replaced by final data about two months later
FINAL_EXPVER = "0001"

NOT_INGESTED = "ERA5-Land cube not ingested"
UPDATING = "ERA5-Land cube is being updated or an update failed"
REVISION_HEX_CHARS = 12
MONTHS_PER_YEAR = 12


class TemperatureDataset(SeriesDataset):
    """ERA5-Land monthly mean 2 m air temperature, read from the local cube."""

    def first(self) -> str:
        """Start of the first month in the cube, an ISO date."""
        return f"{next(iter(self.backend.t2m_months()))}-01"

    def latest(self) -> str:
        """Start of the last month in the cube, an ISO date."""
        return f"{list(self.backend.t2m_months())[-1]}-01"

    def current_revision(self, steps: list[str]) -> str | None:
        """Hash of the cube's markers of exactly these months."""
        months = self.backend.t2m_months()
        markers = "|".join(months[step[:MONTH_CHARS]] for step in steps)
        return hashlib.sha256(markers.encode()).hexdigest()[:REVISION_HEX_CHARS]

    def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
        """One notice per run of preliminary months among `steps`."""
        months = self.backend.t2m_months()
        labels = [step[:MONTH_CHARS] for step in steps]
        runs = [
            list(run)
            for preliminary, run in groupby(labels, lambda label: is_preliminary(months[label]))
            if preliminary
        ]
        return [_preliminary_notice(run[0], run[-1]) for run in runs]

    def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """The month that starts on the ISO date `step`, in degrees C."""
        month = step[:MONTH_CHARS]
        temperature = read_wrapped(
            self.grid,
            bbox,
            lambda window: self.backend.read_t2m(month, window),
        )
        return block_mean(temperature, factor)


class Era5LandCube:
    """The ERA5-Land temperature cube on local disk, written by `soe.era5land_ingest`."""

    def __init__(self, cubes_dir: Path | str = DEFAULT_CUBES_DIR) -> None:
        self._cube_path = Path(cubes_dir) / CUBE_NAME
        self._months_read = None  # (zarr.json mtime, months) of the last read

    def has_t2m(self) -> bool:
        """Whether the cube holds at least one month and is not being updated."""
        try:
            self.t2m_months()
        except SourceUnavailable:
            return False

        return True

    def t2m_months(self) -> dict[str, str]:
        """Marker of each stored month ('YYYY-MM' -> 'expver:hash'), oldest first.

        Raises SourceUnavailable while the cube is missing, unreadable, empty or being updated.
        """
        modified = self._modified()
        if self._months_read is None or self._months_read[0] != modified:
            self._months_read = (modified, self._load_months())
        if not self._months_read[1]:
            raise SourceUnavailable(NOT_INGESTED)

        return self._months_read[1]

    def read_t2m(self, month: str, window: CellWindow) -> np.ndarray:
        """One month of the window as float32 degrees C; fill and rows past 60S become NaN.

        Raises SourceUnavailable if an ingest started or finished while the window was read.
        """
        self.t2m_months()
        modified_before = self._modified()
        col, row, width, height = window
        array = zarr.open_group(self._cube_path, mode="r")[CUBE_ARRAY]
        stored_height = max(0, min(height, ERA5_LAND_GRID.rows - row))
        stored = array[month_index(month), row:row + stored_height, col:col + width]
        if self._modified() != modified_before:
            raise SourceUnavailable(UPDATING)

        temperature = np.full((height, width), np.nan, "float32")
        decoded = stored.astype("float32") * np.float32(CUBE_SCALE)
        temperature[:stored_height] = np.where(stored == CUBE_FILL, np.nan, decoded)
        return temperature

    def _modified(self) -> int:
        """Change stamp of the cube's published state, which every ingest step updates."""
        try:
            return (self._cube_path / "zarr.json").stat().st_mtime_ns
        except FileNotFoundError:
            raise SourceUnavailable(NOT_INGESTED)

    def _load_months(self) -> dict[str, str]:
        try:
            group = zarr.open_group(self._cube_path, mode="r")
            if CUBE_ARRAY not in group:
                raise KeyError(CUBE_ARRAY)

            months = dict(group.attrs["months"])
            pending = group.attrs.get("pending", [])
        except (OSError, KeyError, ValueError, zarr.errors.BaseZarrError):
            raise SourceUnavailable(NOT_INGESTED)

        if pending:
            raise SourceUnavailable(UPDATING)

        return months


def month_index(month: str) -> int:
    """Position of month 'YYYY-MM' on the cube's time axis."""
    return _month_number(month) - _month_number(CUBE_TIME_ORIGIN)


def is_preliminary(marker: str) -> bool:
    """Whether a month marker 'expver:hash' names preliminary (ERA5-Land-T) data."""
    return marker.startswith(PRELIMINARY_EXPVER + ":")


def _month_number(month: str) -> int:
    return int(month[:4]) * MONTHS_PER_YEAR + int(month[5:MONTH_CHARS])


def _preliminary_notice(first: str, last: str) -> str:
    period = first if first == last else f"{first} to {last}"
    return (
        f"Temperature {period} is preliminary ERA5-Land data; final data replaces it "
        "about two months later, and the scene then gets a new id."
    )
