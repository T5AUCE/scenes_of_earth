"""Sample a coarse grid bilinearly at the cell centres of a finer one.

A fallback source can then fill gaps with a smooth estimate rather than sharp coarse blocks.
"""
from collections.abc import Callable

import numpy as np

from .grid import GRID_DECIMALS, CellWindow, Grid, read_wrapped


def read_bilinear(
    fine: Grid,
    coarse: Grid,
    window: CellWindow,
    read_window: Callable[[CellWindow], np.ndarray],
) -> np.ndarray:
    """Return the coarse grid's values blended at the centres of a window of the fine grid.

    `read_window` reads one window of the coarse grid that does not cross its east edge. A coarse
    cell is an average over a wider area than a fine cell, so blending the four cells around a
    centre gives a smoother estimate than a block of one coarse value. A neighbour outside the
    grid or without data gives way to the nearest finite one, because no-data should not spread.
    """
    columns, rows, fraction_x, fraction_y = _fractional_cells(fine, coarse, window)
    first_column, first_row = columns.min(), rows.min()
    span = (first_column, columns.max() + 2, first_row, rows.max() + 2)
    covering = read_wrapped(coarse, coarse.bbox(span), read_window)
    column_offsets = columns - first_column
    row_offsets = rows - first_row
    neighbours = (
        covering[np.ix_(row_offsets, column_offsets)],
        covering[np.ix_(row_offsets, column_offsets + 1)],
        covering[np.ix_(row_offsets + 1, column_offsets)],
        covering[np.ix_(row_offsets + 1, column_offsets + 1)],
    )
    return _blend(neighbours, fraction_x, fraction_y)


def _fractional_cells(
    fine: Grid,
    coarse: Grid,
    window: CellWindow,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return the west and north coarse cell and the fraction towards the next for each centre.

    Columns are not wrapped, so a window past 180 degrees gives columns past the coarse grid's
    last. A centre on a coarse cell centre has fraction zero.
    """
    col, row, width, height = window
    lon = fine.west_deg + (col + np.arange(width) + 0.5) * fine.res
    lat = fine.north_deg - (row + np.arange(height) + 0.5) * fine.res
    x = np.round((lon - coarse.west_deg) / coarse.res - 0.5, GRID_DECIMALS)
    y = np.round((coarse.north_deg - lat) / coarse.res - 0.5, GRID_DECIMALS)
    columns = np.floor(x).astype(int)
    rows = np.floor(y).astype(int)
    return columns, rows, x - columns, y - rows


def _blend(
    neighbours: tuple[np.ndarray, ...],
    fraction_x: np.ndarray,
    fraction_y: np.ndarray,
) -> np.ndarray:
    """Blend four coarse cells, taking the nearest finite one when any neighbour holds no data."""
    east_weight = fraction_x[None, :]
    south_weight = fraction_y[:, None]
    north_west, north_east, south_west, south_east = neighbours
    blended = (
        north_west * (1 - east_weight) * (1 - south_weight)
        + north_east * east_weight * (1 - south_weight)
        + south_west * (1 - east_weight) * south_weight
        + south_east * east_weight * south_weight
    )
    missing = ~np.isfinite(blended)
    if not missing.any():
        return blended.astype("float32")

    nearest = _nearest_finite(neighbours, fraction_x, fraction_y)
    return np.where(missing, nearest, blended).astype("float32")


def _nearest_finite(
    neighbours: tuple[np.ndarray, ...],
    fraction_x: np.ndarray,
    fraction_y: np.ndarray,
) -> np.ndarray:
    """Return the finite coarse neighbour closest to each point, or NaN if none is finite."""
    x = fraction_x[None, :]
    y = fraction_y[:, None]
    distances = np.stack(
        [
            x**2 + y**2,
            (1 - x) ** 2 + y**2,
            x**2 + (1 - y) ** 2,
            (1 - x) ** 2 + (1 - y) ** 2,
        ],
    )
    values = np.stack(neighbours)
    finite = np.isfinite(values)
    nearest = np.argmin(np.where(finite, distances, np.inf), axis=0)
    return np.take_along_axis(values, nearest[None], axis=0)[0]
