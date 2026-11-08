"""Read monthly ERA5-Land air temperature and fill its missing values with general ERA5.

The dataset reports the available months and revisions shared by both cubes, which are the ones
that reach 84N for a scene beyond 60N or S. It marks preliminary months in those cubes with a
notice. It reads cells from the cubes that `soe.ingest.era5` writes, so a build makes no network
calls for temperature.
"""
from dataclasses import dataclass

import numpy as np

from .cubes import CubeSpec, month_markers, preliminary_runs
from .datasets import revision_digest
from .era5 import HighLatitudeSeries
from .grid import Bbox, Grid, block_mean, read_wrapped
from .periods import MONTH_CHARS

# Cell centres lie on 0.1 degree multiples, which puts the cell edges half a cell off CHIRPS.
ERA5_LAND_TEMPERATURE_GRID = Grid(-180.05, 60.05, 0.1, 3600, 1201)
ERA5_LAND_84N_GRID = Grid(-180.05, 84.05, 0.1, 3600, 1441)

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
ERA5_LAND_TEMPERATURE_84N_CUBE = ERA5_LAND_TEMPERATURE_CUBE._replace(
    name="era5land_temperature_84n",
    title="ERA5-Land temperature to 84N",
    grid=ERA5_LAND_84N_GRID,
)


@dataclass
class Era5LandTemperatureDataset(HighLatitudeSeries):
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
        cube = self._land_cube()
        temperature = read_wrapped(
            cube.grid,
            bbox,
            lambda window: self.backend.read_cube(cube, month, window),
        )
        return block_mean(temperature, factor)

    def _land_months(self) -> dict[str, str]:
        return self.backend.cube_months(self._land_cube())

    def _land_cube(self) -> CubeSpec:
        return self.north_cube if self.reads_north else ERA5_LAND_TEMPERATURE_CUBE


def _preliminary_notice(first: str, last: str) -> str:
    period = first if first == last else f"{first} to {last}"
    return (
        f"Temperature {period} is preliminary ERA5-Land or ERA5 data; final data replaces it "
        "about two months later, and the scene then gets a new id."
    )
