"""Read the lithology COG as the most common rock class in each output cell.

`soe.ingest.lithology` writes the COG from the OpenLandMap lithology map, and a build only reads it.
"""
from collections.abc import Callable
from pathlib import Path

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError, WarpOperationError
from rasterio.transform import Affine, from_origin

from ..areas import WORLD_WIDTH_DEG
from .datasets import StaticDataset
from .grid import (
    MAX_STATIC_DIVISIONS,
    MAX_STATIC_SIDE_PX,
    STATIC_BUDGET_PX,
    Bbox,
    budget_res,
)
from .remote import SourceUnavailable
from .worldcover import overview_factor, overview_level, warp_modes, worldcover_tiles

LITHOLOGY_FILE = "lithology.tif"  # in the cubes folder
LITHOLOGY_RES_DEG = 1 / 480
ANTIMERIDIAN_DEG = WORLD_WIDTH_DEG / 2

# Values 1 to 15 are the source classes in file-name order with water and undefined as no data.
GEOLOGY_CLASSES = [
    {"value": 14, "label": "Unconsolidated sediment", "color": "#fdf0a8", "group": "Sediments"},
    {"value": 13, "label": "Siliciclastic sedimentary", "color": "#e8c33c", "group": "Sediments"},
    {"value": 11, "label": "Mixed sedimentary", "color": "#c2ab5a", "group": "Sediments"},
    {"value": 5, "label": "Carbonate sedimentary", "color": "#6fa8d6", "group": "Sediments"},
    {"value": 6, "label": "Evaporite", "color": "#c5a3d6", "group": "Sediments"},
    {"value": 12, "label": "Pyroclastic", "color": "#d9753b", "group": "Volcanic"},
    {"value": 2, "label": "Acid volcanic", "color": "#e57373", "group": "Volcanic"},
    {"value": 9, "label": "Intermediate volcanic", "color": "#c0392b", "group": "Volcanic"},
    {"value": 4, "label": "Basic volcanic", "color": "#6c3483", "group": "Volcanic"},
    {"value": 1, "label": "Acid plutonic", "color": "#f194b4", "group": "Plutonic"},
    {"value": 8, "label": "Intermediate plutonic", "color": "#d65d8a", "group": "Plutonic"},
    {"value": 3, "label": "Basic plutonic", "color": "#8e2f5c", "group": "Plutonic"},
    {"value": 10, "label": "Metamorphic", "color": "#8a9a7b", "group": "Metamorphic"},
    {"value": 7, "label": "Ice and glaciers", "color": "#f2f6f8", "group": "Ice"},
]
UNDEFINED_CLASS = 15
WATER_CLASS = 255


class LithologyReader:
    """The lithology COG on local disk."""

    def __init__(self, cubes_dir: Path | str) -> None:
        self._lithology_path = Path(cubes_dir) / LITHOLOGY_FILE

    def has_lithology(self) -> bool:
        """Return whether the lithology COG has been ingested."""
        return self._lithology_path.exists()

    def lithology(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
    ) -> tuple[np.ndarray, Affine]:
        """Class (uint8) on bounds at res; 0 where the map has no rock class.

        Longitudes above 180 wrap, so bounds may cross the antimeridian. on_block() is called
        once, after the read. Returns (array, transform).
        """
        west, south, east, north = bounds
        height, width = round((north - south) / res), round((east - west) / res)
        classes = np.zeros((height, width), "uint8")
        level = overview_level(overview_factor(res, LITHOLOGY_RES_DEG))
        try:
            with rasterio.open(self._lithology_path, overview_level=level) as source:
                for part_west, part_east, file_shift in _split_at_antimeridian(west, east):
                    column = round((part_west - west) / res)
                    part = np.zeros((height, round((part_east - part_west) / res)), "uint8")
                    warp_modes(source, part, part_west + file_shift, north, res)
                    classes[:, column:column + part.shape[1]] = part
        except (RasterioIOError, WarpOperationError) as error:
            raise SourceUnavailable("The lithology map could not be read") from error

        on_block()
        return classes, from_origin(west, north, res, res)


def _split_at_antimeridian(west: float, east: float) -> list[tuple[float, float, float]]:
    """The (west, east, shift to the file's frame) of the parts of the bounds either side of 180."""
    if east <= ANTIMERIDIAN_DEG:
        return [(west, east, 0)]

    return [
        (west, ANTIMERIDIAN_DEG, 0),
        (ANTIMERIDIAN_DEG, east, -WORLD_WIDTH_DEG),
    ]


class GeologyDataset(StaticDataset):
    """The most common rock class in each cell, at a size set by the area."""

    def __post_init__(self) -> None:
        """Mark the dataset as needing land tiles, so open sea is refused early."""
        self.needs_tiles = True

    def tile_count(self, bbox: Bbox) -> int:
        """Return the land tile count of bbox, which is zero over open sea."""
        # Geology is land-only like land cover, so the same tile check refuses open sea early.
        return len(worldcover_tiles(bbox))

    def res_for(self, bbox: Bbox) -> float:
        """Return the cell size in degrees that fits bbox within the static pixel budget."""
        return budget_res(bbox, STATIC_BUDGET_PX, MAX_STATIC_SIDE_PX, MAX_STATIC_DIVISIONS)

    def read(
        self,
        bbox: Bbox,
        res: float,
        on_block: Callable[[], None] | None = None,
    ) -> tuple[dict[str, np.ndarray], Affine]:
        """Return uint8 classes over bbox at cell size `res`."""
        classes, transform = self.backend.lithology(
            tuple(bbox),
            res,
            on_block or (lambda: None),
        )
        return {"value": classes}, transform

    def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
        """Return notices about the scale of the source map, its seams and its missing islands."""
        return [
            "Rock type comes from a global map at about 1:3.75 million, so boundaries are "
            "approximate at local scale and can jump where national source maps meet and at "
            "180° longitude. Small islands and some coasts have no rock class in the source "
            "map, so they stay uncoloured.",
        ]
