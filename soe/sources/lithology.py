"""Read categorical geology COGs from disk without owning taxonomy or compositing."""
from collections.abc import Callable
from pathlib import Path

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError, WarpOperationError
from rasterio.transform import Affine, from_origin

from ..areas import WORLD_WIDTH_DEG
from ..geology_type import (
    GEOLOGY_CLASSES,
    GLIM_FAMILIES,
    GLIM_LEVEL2_NAMES,
    GLIM_SOURCE,
    GLIM_VALUES,
    LITHOLOGY_FILE,
    LITHOLOGY_RES_DEG,
    LITHOLOGY_SOURCE_TAG,
    OPENLANDMAP_CLASSES,
    OPENLANDMAP_SOURCE,
    UNDEFINED_CLASS,
    WATER_CLASS,
)
from .geology import PROVENANCE_ROLE, GeologyDataset
from .grid import Bbox
from .remote import SourceUnavailable
from .worldcover import overview_factor, overview_level, warp_modes

ANTIMERIDIAN_DEG = WORLD_WIDTH_DEG / 2


class LithologyReader:
    """The lithology COG on local disk."""

    def __init__(self, cubes_dir: Path | str) -> None:
        self._cubes_dir = Path(cubes_dir)

    def has_lithology(self, file: str = LITHOLOGY_FILE) -> bool:
        """Return whether the COG `file` has been ingested."""
        return (self._cubes_dir / file).exists()

    def lithology_source(self, file: str = LITHOLOGY_FILE) -> str:
        """Return which map built the COG, GLIM_SOURCE or OPENLANDMAP_SOURCE for rock type."""
        try:
            with rasterio.open(self._cubes_dir / file) as source:
                return source.tags().get(LITHOLOGY_SOURCE_TAG, OPENLANDMAP_SOURCE)
        except RasterioIOError:
            # A read of the unreadable COG reports it, so the dataset only needs some source.
            return OPENLANDMAP_SOURCE

    def lithology(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
        file: str = LITHOLOGY_FILE,
    ) -> tuple[np.ndarray, Affine]:
        """Class (uint8) on bounds at res from the COG `file`; 0 where the map has no class.

        Longitudes above 180 wrap, so bounds may cross the antimeridian. on_block() is called
        once, after the read. Returns (array, transform).
        """
        west, south, east, north = bounds
        height, width = round((north - south) / res), round((east - west) / res)
        classes = np.zeros((height, width), "uint8")
        path = self._cubes_dir / file
        try:
            with rasterio.open(path) as full:
                native_res = full.res[0]
            level = overview_level(overview_factor(res, native_res))
            with rasterio.open(path, overview_level=level) as source:
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
