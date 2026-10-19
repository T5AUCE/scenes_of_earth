"""Cell grids: the Grid of a dataset, and the bbox, window and span types on it."""
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from rasterio.transform import Affine

Bbox = Sequence[float]  # W, S, E, N in degrees; a list or a tuple
CellWindow = tuple[int, int, int, int]  # col, row, width, height on a dataset's grid
CellSpan = tuple[int, int, int, int]  # c0, c1, r0, r1 on a dataset's grid

CELL_DEG = 0.05  # CHIRPS cell size, the base resolution of terrain and boundaries
CELLS_PER_DEG2_AT_CHIRPS_RES = 400  # (1 / 0.05) ** 2

STATIC_BUDGET_PX = 2048 * 2048  # pixels of a static layer such as terrain or land cover
MAX_STATIC_SIDE_PX = 4096
MAX_STATIC_DIVISIONS = 180  # 0.05 / 180 is the native 30 m cell

GRID_DECIMALS = 6  # cell indices and bounds are rounded to this to absorb float noise


@dataclass(frozen=True)
class Grid:
    """A dataset's cell grid: cell (0, 0) has its north-west corner at (west_deg, north_deg).

    Row 0 is the north edge. Only whole cells are addressed, so reads are never resampled.
    """

    west_deg: float
    north_deg: float
    res: float  # cell size, degrees
    columns: int  # in the whole grid; longitudes wrap after this many
    rows: int

    @property
    def transform(self) -> Affine:
        """Return the affine transform from grid edges to longitude and latitude."""
        return Affine(self.res, 0, self.west_deg, 0, -self.res, self.north_deg)

    def span(self, bounds: Bbox) -> CellSpan:
        """Outward cell range (c0, c1, r0, r1) of bounds."""
        west, south, east, north = bounds
        return (
            math.floor(round((west - self.west_deg) / self.res, GRID_DECIMALS)),
            math.ceil(round((east - self.west_deg) / self.res, GRID_DECIMALS)),
            math.floor(round((self.north_deg - north) / self.res, GRID_DECIMALS)),
            math.ceil(round((self.north_deg - south) / self.res, GRID_DECIMALS)),
        )

    def bbox(self, span: CellSpan) -> list[float]:
        """[W, S, E, N] of a cell range."""
        c0, c1, r0, r1 = span
        return [
            round(value, GRID_DECIMALS)
            for value in (
                self.west_deg + c0 * self.res,
                self.north_deg - r1 * self.res,
                self.west_deg + c1 * self.res,
                self.north_deg - r0 * self.res,
            )
        ]

    def window(self, bbox: Bbox) -> CellWindow:
        """Integer (col, row, width, height) window of a grid-aligned bbox."""
        west, south, east, north = bbox
        col = round((west - self.west_deg) / self.res)
        row = round((self.north_deg - north) / self.res)
        width = round((east - west) / self.res)
        height = round((north - south) / self.res)
        return col, row, width, height


def budget_res(
    bounds: Bbox,
    budget_px: int,
    max_side_px: int,
    max_divisions: int,
) -> float:
    """Cell size 0.05 / k degrees of a static layer, so whole degrees are a whole number of cells.

    It stays within budget_px pixels and max_side_px on the long side, and never gets finer
    than 0.05 / max_divisions.
    """
    west, south, east, north = bounds
    width, height = east - west, north - south
    divisions = min(
        math.isqrt(int(budget_px / (CELLS_PER_DEG2_AT_CHIRPS_RES * width * height))),
        int(max_side_px * CELL_DEG / max(width, height)),
    )
    return CELL_DEG / min(max(divisions, 1), max_divisions)


def read_wrapped(
    grid: Grid,
    bbox: Bbox,
    read_window: Callable[[CellWindow], np.ndarray],
) -> np.ndarray:
    """Cells of a grid-aligned bbox, joining the west edge on when it runs past 180 degrees.

    `read_window` reads one window of the grid that does not cross the grid's east edge.
    """
    col, row, width, height = grid.window(bbox)
    col %= grid.columns
    east_width = min(width, grid.columns - col)
    cells = read_window((col, row, east_width, height))
    if east_width == width:
        return cells

    return np.hstack([cells, read_window((0, row, width - east_width, height))])


def block_mean(values: np.ndarray, factor: int) -> np.ndarray:
    """NaN-aware factor x factor block mean (shape must be divisible by factor)."""
    if factor == 1:
        return values

    height, width = values.shape
    blocks = values.reshape(height // factor, factor, width // factor, factor)
    valid = ~np.isnan(blocks)
    counts = valid.sum(axis=(1, 3))
    sums = np.where(valid, blocks, 0).sum(axis=(1, 3), dtype="float64")

    return np.where(counts > 0, sums / np.maximum(counts, 1), np.nan).astype("float32")
