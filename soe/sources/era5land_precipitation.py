"""Read monthly ERA5-Land rain north of CHIRPS, which ends at 60N, on top of the CHIRPS rain layer.

CHIRPS keeps every cell it covers. North of 60N the layer takes ERA5-Land precipitation from the
cube that `soe.ingest.era5` writes, and ERA5 still fills the cells where ERA5-Land has no land
value. The layer sits on the world grid so that it reaches 84N, while CHIRPS stays on its own grid.
"""
from dataclasses import dataclass

import numpy as np

from .chirps import CHIRPS_GRID, RainDataset
from .cubes import CubeSpec, month_markers, preliminary_runs
from .datasets import FilledStep, revision_digest
from .era5 import ERA5_PRECIPITATION_FALLBACK, HighLatitudeSeries
from .era5land_temperature import ERA5_LAND_84N_GRID
from .fallback import read_bilinear
from .grid import WORLD_GRID, Bbox, CellWindow, block_mean
from .licences import SOURCES
from .periods import MONTH_CHARS

ERA5_LAND_PRECIPITATION_84N_CUBE = CubeSpec(
    name="era5land_precipitation_84n",
    title="ERA5-Land precipitation to 84N",
    array="tp",
    grid=ERA5_LAND_84N_GRID,
    dtype="uint16",
    scale=0.1,
    fill=65535,
    units="mm/month",
)

# Rows of the world grid that lie north of the CHIRPS grid.
CHIRPS_ROW_OFFSET = round((WORLD_GRID.north_deg - CHIRPS_GRID.north_deg) / WORLD_GRID.res)

NORTH_FILL_NOTICE = (
    "Rainfall north of CHIRPS uses ERA5-Land rain (about 11 km), and ERA5 model rain "
    "(about 28 km) where ERA5-Land has no land value, in {filled} of {inside} cells where "
    "CHIRPS has no value."
)


@dataclass
class HighLatitudeRainDataset(RainDataset, HighLatitudeSeries):
    """Read CHIRPS rain with ERA5-Land rain north of it, and fill gaps with ERA5 precipitation.

    Cells that take ERA5-Land rain count as filled, like those that take ERA5, because neither
    comes from CHIRPS.
    """

    def __post_init__(self) -> None:
        """Assume a northern window until a read proves otherwise, so direct notice calls keep working."""
        super().__post_init__()
        self._has_north = True

    def first(self) -> str:
        """Return the first month held by every cube the scene reads as an ISO start date."""
        first = super().first()
        if not self.reads_north:
            return first

        return max(first, f"{next(iter(self._land_months()))}-01")

    def latest(self) -> str:
        """Return the last month held by every cube the scene reads as an ISO start date."""
        latest = super().latest()
        if not self.reads_north:
            return latest

        return min(latest, f"{list(self._land_months())[-1]}-01")

    def local_revision(self, steps: list[str]) -> str | None:
        """Return a hash of the markers of every cube the scene reads for the months."""
        revision = super().local_revision(steps)
        if not self.reads_north:
            return revision

        labels = [step[:MONTH_CHARS] for step in steps]
        return revision_digest(revision, *month_markers(self._land_months(), labels))

    def sources_for(self, bbox: Bbox) -> list[dict]:
        """The sources a read of bbox uses, with ERA5-Land added when it reaches north of CHIRPS."""
        has_north = bool(self._land_height(self.grid.window(bbox)))
        self._remember_north(has_north)
        if not has_north:
            return [self.source]

        return [self.source, SOURCES["era5land_rain_84n"]]

    def fallback_notices(self, steps: list[str], filled: list[bool]) -> list[str]:
        """Return one notice for each run of months where preliminary rain filled a gap."""
        if not self.reads_north or not self._has_north:
            return super().fallback_notices(steps, filled)

        labels = [step[:MONTH_CHARS] for step in steps]
        used = [
            _markers_of_filled_months(labels, months, filled)
            for months in (self._land_months(), self.fallback_months())
        ]
        runs = preliminary_runs(labels, *used)
        return [_preliminary_notice(run[0], run[-1]) for run in runs]

    def read_step_filled(self, step: str, bbox: Bbox, factor: int = 1) -> FilledStep:
        """Read the step like the base layer, flagging the cells that took ERA5-Land rain too."""
        self._remember_north(bool(self._land_height(self.grid.window(bbox))))
        read = super().read_step_filled(step, bbox, factor)
        if not self.reads_north:
            return read

        north_of_chirps = block_mean(self._north_of_chirps(bbox), factor) > 0
        return FilledStep(read.values, read.filled | (north_of_chirps & np.isfinite(read.values)))

    def _read_window(self, month: str, window: CellWindow) -> np.ndarray:
        col, row, width, height = window
        land_height = self._land_height(window)
        parts = []
        if land_height:
            parts.append(self._read_land(month, (col, row, width, land_height)))
        if land_height < height:
            chirps_row = row + land_height - CHIRPS_ROW_OFFSET
            chirps_window = (col, chirps_row, width, height - land_height)
            parts.append(super()._read_window(month, chirps_window))
        return np.vstack(parts)

    def _read_land(self, month: str, window: CellWindow) -> np.ndarray:
        """Return ERA5-Land rain at the cell centres of a window north of CHIRPS."""
        return read_bilinear(
            self.grid,
            ERA5_LAND_84N_GRID,
            window,
            lambda land_window: self.backend.read_cube(self.north_cube, month, land_window),
        )

    def _north_of_chirps(self, bbox: Bbox) -> np.ndarray:
        """Return 1 for the cells of the bbox that lie north of the CHIRPS grid and 0 elsewhere."""
        window = self.grid.window(bbox)
        _, _, width, height = window
        cells = np.zeros((height, width), "float32")
        cells[:self._land_height(window)] = 1
        return cells

    def _land_height(self, window: CellWindow) -> int:
        """Return the rows of the window that lie north of the CHIRPS grid, none unless north."""
        _, row, _, height = window
        if not self.reads_north:
            return 0

        return min(max(CHIRPS_ROW_OFFSET - row, 0), height)

    def _land_months(self) -> dict[str, str]:
        return self.backend.cube_months(self.north_cube)

    def _remember_north(self, has_north: bool) -> None:
        """Keep the fill notice naming only the sources the window reads."""
        self._has_north = has_north
        if not self.reads_north or self.fallback is None:
            return
        notice = NORTH_FILL_NOTICE if has_north else ERA5_PRECIPITATION_FALLBACK.notice
        if self.fallback.notice != notice:
            self.fallback = self.fallback._replace(notice=notice)


def _markers_of_filled_months(
    labels: list[str],
    months: dict[str, str],
    filled: list[bool],
) -> dict[str, str]:
    """Map each label to its marker, or to an empty one, which is never preliminary, if unfilled."""
    return {label: months[label] if was_filled else "" for label, was_filled in zip(labels, filled)}


def _preliminary_notice(first: str, last: str) -> str:
    period = first if first == last else f"{first} to {last}"
    return (
        f"The ERA5-Land and ERA5 rain north of CHIRPS or filling its gaps in Rainfall {period} "
        "is preliminary; final data replaces it about two months later, and the scene then "
        "gets a new id."
    )
