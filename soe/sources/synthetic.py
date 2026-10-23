"""Generate deterministic offline stand-ins for rainfall, terrain, land cover and cube data.

Offline runs and tests use it, so nothing here needs the network or a cube.
"""
from collections.abc import Callable

import numpy as np
from rasterio.transform import Affine, from_origin

from .chirps import FIRST_MONTH
from .cubes import FINAL_EXPVER, MONTHS_PER_YEAR, PRELIMINARY_EXPVER, CubeSpec, month_index
from .era5 import ERA5_PRECIPITATION_CUBE, ERA5_TEMPERATURE_CUBE
from .era5land_temperature import ERA5_LAND_TEMPERATURE_CUBE
from .grid import Bbox, CellWindow
from .periods import MONTH_CHARS, add_duration
from .terrain import terrain_block_count
from .worldcover import WORLDCOVER_CLASSES, PlacedTile, land_cover_by_tiles


class SyntheticSource:
    """Provide deterministic offline data and count rain and cube reads in `reads`."""

    synthetic = True

    def __init__(self, latest: str = "2026-08") -> None:
        self._latest = latest
        self.reads = 0

    def latest_month(self) -> str:
        return self._latest

    def current_revision(self, month: str) -> str:
        return "synthetic"

    def has_cube(self, spec: CubeSpec) -> bool:
        """Return True because the synthetic cubes need no files."""
        return True

    def cube_months(self, spec: CubeSpec) -> dict[str, str]:
        """Return monthly markers from 1981-01 and mark the latest two months preliminary."""
        months = []
        month_start = f"{FIRST_MONTH}-01"
        while month_start[:MONTH_CHARS] <= self._latest:
            months.append(month_start[:MONTH_CHARS])
            month_start = add_duration(month_start, "P1M")

        expvers = [FINAL_EXPVER] * (len(months) - 2) + [PRELIMINARY_EXPVER] * 2
        return {month: f"{expver}:synthetic" for month, expver in zip(months, expvers)}

    def read_cube(self, spec: CubeSpec, month: str, window: CellWindow) -> np.ndarray:
        """Return fake values of one month in the cube's units, with NaN for rows past the grid."""
        self.reads += 1
        col, row, width, height = window
        cols, rows = np.meshgrid(np.arange(col, col + width), np.arange(row, row + height))
        values = CUBE_FIELDS[spec.name](month, cols, rows, spec).astype("float32")
        values[rows >= spec.grid.rows] = np.nan
        return values

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
        """Fractional float64 elevation on bounds at res with its transform."""
        west, south, east, north = bounds
        width, height = round((east - west) / res), round((north - south) / res)
        transform = from_origin(west, north, res, res)

        cols, rows = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
        lon, lat = transform @ (cols, rows)
        elevation = 1000 + 800 * np.sin(lon * 20) * np.cos(lat * 20)
        for _ in range(terrain_block_count(bounds)):
            on_block()
        return elevation.astype("float64"), transform

    def land_cover(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
    ) -> tuple[np.ndarray, Affine]:
        """Return deterministic class bands over bounds with zeroes where no tile exists."""
        return land_cover_by_tiles(bounds, res, _synthetic_classes, on_block)


def _synthetic_classes(tile: PlacedTile, part: Bbox, res: float) -> np.ndarray:
    """Return diagonal class bands in the frame of the bounds, so they continue across 180."""
    west, south, east, north = part
    width, height = round((east - west) / res), round((north - south) / res)
    lon = west + (np.arange(width) + 0.5) * res
    lat = north - (np.arange(height) + 0.5) * res
    bands = np.floor(lon * 4)[None, :] + np.floor(lat * 4)[:, None]
    values = np.array([entry["value"] for entry in WORLDCOVER_CLASSES], "uint8")
    return values[bands.astype(int) % len(values)]


def _land_temperature(month: str, cols: np.ndarray, rows: np.ndarray, spec: CubeSpec) -> np.ndarray:
    """Return a seasonal field that falls poleward and has holes to exercise NaN-aware means."""
    temperature = _temperature(month, rows, spec)
    temperature[(cols * 5 + rows * 11) % 13 == 0] = np.nan
    return temperature


def _era5_temperature(month: str, cols: np.ndarray, rows: np.ndarray, spec: CubeSpec) -> np.ndarray:
    """Return a field a degree cooler than the land field, without holes."""
    return _temperature(month, rows, spec) - 1


def _era5_precipitation(
    month: str,
    cols: np.ndarray,
    rows: np.ndarray,
    spec: CubeSpec,
) -> np.ndarray:
    month_number = int(month[:4]) * 12 + int(month[5:7])
    return 70 + 30 * np.sin(cols / 6 + month_number * 0.5) * np.cos(rows / 5)


def _temperature(month: str, rows: np.ndarray, spec: CubeSpec) -> np.ndarray:
    seasonal = np.sin(month_index(month) * 2 * np.pi / MONTHS_PER_YEAR)
    lat = spec.grid.north_deg - rows * spec.grid.res
    return 28 - 0.5 * np.abs(lat) + 8 * seasonal


CUBE_FIELDS = {
    ERA5_LAND_TEMPERATURE_CUBE.name: _land_temperature,
    ERA5_TEMPERATURE_CUBE.name: _era5_temperature,
    ERA5_PRECIPITATION_CUBE.name: _era5_precipitation,
}
