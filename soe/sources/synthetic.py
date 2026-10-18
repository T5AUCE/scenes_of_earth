"""Deterministic fake rain, terrain and temperature that stand in for the real readers.

Offline runs and tests use it, so nothing here needs the network or a temperature cube.
"""
from collections.abc import Callable

import numpy as np
from rasterio.transform import Affine, from_origin

from .chirps import FIRST_MONTH, MONTH_CHARS
from .era5land_temperature import (
    ERA5_LAND_TEMPERATURE_GRID,
    FINAL_EXPVER,
    MONTHS_PER_YEAR,
    PRELIMINARY_EXPVER,
    month_index,
)
from .grid import Bbox, CellWindow
from .periods import add_duration
from .terrain import terrain_block_count


class SyntheticSource:
    """Deterministic fake data, no network. `reads` counts rain and temperature reads."""

    synthetic = True

    def __init__(self, latest: str = "2026-08") -> None:
        self._latest = latest
        self.reads = 0

    def latest_month(self) -> str:
        return self._latest

    def current_revision(self, month: str) -> str:
        return "synthetic"

    def has_t2m(self) -> bool:
        """Always true: the synthetic cube needs no files."""
        return True

    def t2m_months(self) -> dict[str, str]:
        """Months from 1981-01 to the latest, the last two preliminary."""
        months = []
        month_start = f"{FIRST_MONTH}-01"
        while month_start[:MONTH_CHARS] <= self._latest:
            months.append(month_start[:MONTH_CHARS])
            month_start = add_duration(month_start, "P1M")

        expvers = [FINAL_EXPVER] * (len(months) - 2) + [PRELIMINARY_EXPVER] * 2
        return {month: f"{expver}:synthetic" for month, expver in zip(months, expvers)}

    def read_t2m(self, month: str, window: CellWindow) -> np.ndarray:
        """Fake temperature in degrees C of one month, seasonal and falling poleward."""
        self.reads += 1
        col, row, width, height = window
        seasonal = np.sin(month_index(month) * 2 * np.pi / MONTHS_PER_YEAR)
        cols, rows = np.meshgrid(np.arange(col, col + width), np.arange(row, row + height))

        lat = ERA5_LAND_TEMPERATURE_GRID.north_deg - rows * ERA5_LAND_TEMPERATURE_GRID.res
        temperature = 28 - 0.5 * np.abs(lat) + 8 * seasonal
        temperature = temperature.astype("float32")
        temperature[(cols * 5 + rows * 11) % 13 == 0] = np.nan  # Holes exercise NaN-aware means.
        return temperature

    def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
        self.reads += 1
        col, row, width, height = window
        month_number = int(month[:4]) * 12 + int(month[5:7])
        cols, rows = np.meshgrid(np.arange(col, col + width), np.arange(row, row + height))

        rain = 100 + 80 * np.sin(cols / 15 + month_number * 0.5) * np.cos(rows / 11)
        rain = rain.astype("float32")
        rain[(cols * 7 + rows * 13) % 11 == 0] = np.nan  # Holes, to exercise NaN-aware means.
        return rain

    def terrain(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
    ) -> tuple[np.ndarray, Affine]:
        west, south, east, north = bounds
        width, height = round((east - west) / res), round((north - south) / res)
        transform = from_origin(west, north, res, res)

        cols, rows = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
        lon, lat = transform @ (cols, rows)
        elevation = 1000 + 800 * np.sin(lon * 20) * np.cos(lat * 20)
        for _ in range(terrain_block_count(bounds)):
            on_block()
        return elevation.astype("int16"), transform
