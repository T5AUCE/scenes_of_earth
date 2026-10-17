"""Deterministic fake data for offline runs and tests."""
from collections.abc import Callable

import numpy as np
from rasterio.transform import Affine, from_origin

from .grid import Bbox, CellWindow
from .terrain import terrain_block_count


class SyntheticSource:
    """Deterministic fake data, no network. `reads` counts rain reads (tests use it)."""

    synthetic = True

    def __init__(self, latest: str = "2026-08") -> None:
        self._latest = latest
        self.reads = 0

    def latest_month(self) -> str:
        return self._latest

    def current_revision(self, month: str) -> str:
        return "synthetic"

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
