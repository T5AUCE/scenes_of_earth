"""Read monthly ERA5-Land air temperature and fill its missing values with general ERA5.

The dataset reports the available months and revisions shared by both cubes. It marks preliminary
months with a notice. It reads cells from the cubes that `soe.cube_ingest` writes, so a build makes
no network calls for temperature.
"""
import numpy as np

from .cubes import CubeSpec, month_markers, preliminary_runs
from .datasets import SeriesDataset, revision_digest
from .grid import Bbox, Grid, block_mean, read_wrapped
from .periods import MONTH_CHARS

# Cell centres lie on 0.1 degree multiples, which puts the cell edges half a cell off CHIRPS.
ERA5_LAND_TEMPERATURE_GRID = Grid(-180.05, 60.05, 0.1, 3600, 1201)

ERA5_LAND_TEMPERATURE_CUBE = CubeSpec(
    name="era5land_temperature",
    title="ERA5-Land temperature",
    array="t2m",
    grid=ERA5_LAND_TEMPERATURE_GRID,
    dtype="int16",
    scale=0.01,
    fill=-32768,
    units="degC",
)


class Era5LandTemperatureDataset(SeriesDataset):
    """Read ERA5-Land monthly mean air temperature and fill missing values with ERA5."""

    def first(self) -> str:
        """Return the first month held by both cubes as an ISO start date."""
        return f"{max(next(iter(self._land_months())), next(iter(self.fallback_months())))}-01"

    def latest(self) -> str:
        """Return the last month held by both cubes as an ISO start date."""
        return f"{min(list(self._land_months())[-1], list(self.fallback_months())[-1])}-01"

    def local_revision(self, steps: list[str]) -> str | None:
        """Return a hash of both cubes' markers for exactly the requested months."""
        labels = [step[:MONTH_CHARS] for step in steps]
        return revision_digest(
            *month_markers(self._land_months(), labels),
            *month_markers(self.fallback_months(), labels),
        )

    def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
        """Return one notice for each run of requested months that are preliminary in either cube.
        """
        labels = [step[:MONTH_CHARS] for step in steps]
        runs = preliminary_runs(labels, self._land_months(), self.fallback_months())
        return [_preliminary_notice(run[0], run[-1]) for run in runs]

    def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """Read the month starting on ISO date `step` from ERA5-Land alone and return degrees
        Celsius.
        """
        month = step[:MONTH_CHARS]
        temperature = read_wrapped(
            self.grid,
            bbox,
            lambda window: self.backend.read_cube(ERA5_LAND_TEMPERATURE_CUBE, month, window),
        )
        return block_mean(temperature, factor)

    def _land_months(self) -> dict[str, str]:
        return self.backend.cube_months(ERA5_LAND_TEMPERATURE_CUBE)


def _preliminary_notice(first: str, last: str) -> str:
    period = first if first == last else f"{first} to {last}"
    return (
        f"Temperature {period} is preliminary ERA5-Land or ERA5 data; final data replaces it "
        "about two months later, and the scene then gets a new id."
    )
