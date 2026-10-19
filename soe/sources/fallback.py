"""Sample a coarse grid at the cell centres of a finer one, so a fallback source can fill gaps."""
from collections.abc import Callable

import numpy as np

from .grid import GRID_DECIMALS, CellWindow, Grid, read_wrapped


def read_nearest(
    fine: Grid,
    coarse: Grid,
    window: CellWindow,
    read_window: Callable[[CellWindow], np.ndarray],
) -> np.ndarray:
    """Return the coarse grid's value at the centre of each cell of a window of the fine grid.

    `read_window` reads one window of the coarse grid that does not cross its east edge. Every
    returned value is one real cell of the coarse grid, so none is blended.
    """
    columns, rows = _containing_cells(fine, coarse, window)
    first_column, first_row = columns.min(), rows.min()
    span = (first_column, columns.max() + 1, first_row, rows.max() + 1)
    covering = read_wrapped(coarse, coarse.bbox(span), read_window)
    return covering[np.ix_(rows - first_row, columns - first_column)]


def _containing_cells(
    fine: Grid,
    coarse: Grid,
    window: CellWindow,
) -> tuple[np.ndarray, np.ndarray]:
    """Return the columns and rows of the coarse cells that contain the centres of the fine cells.

    A centre on an edge shared by two coarse cells belongs to the one east or south of it. Columns
    are not wrapped, so a window past 180 degrees gives columns past the coarse grid's last.
    """
    col, row, width, height = window
    lon = fine.west_deg + (col + np.arange(width) + 0.5) * fine.res
    lat = fine.north_deg - (row + np.arange(height) + 0.5) * fine.res
    columns = np.floor(np.round((lon - coarse.west_deg) / coarse.res, GRID_DECIMALS))
    rows = np.floor(np.round((coarse.north_deg - lat) / coarse.res, GRID_DECIMALS))
    return columns.astype(int), rows.astype(int)
