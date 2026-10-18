"""Data sources: one module per source, the dataset contract and the registry.

Importers use these names; the modules are the homes: chirps.py, era5land.py and terrain.py read
a source, synthetic.py stands in for all of them offline, registry.py lists the datasets.
"""
from .chirps import CHIRPS_GRID, RainDataset
from .datasets import (
    STOP_COUNT,
    SUPPORTED_BOUNDS_DEG,
    TOP_PERCENTILE,
    Dataset,
    Registry,
    Role,
    SeriesDataset,
    StaticDataset,
)
from .era5land import DEFAULT_CUBES_DIR, ERA5_LAND_GRID, Era5LandCube, TemperatureDataset
from .grid import CELL_DEG, Bbox, CellSpan, CellWindow, Grid, read_wrapped
from .licences import SOURCES
from .periods import (
    REQUEST_FORMATS,
    REQUEST_STEP,
    add_duration,
    is_request_label,
    request_label,
    request_range,
)
from .registry import REGISTRY, RealSource, make_registry
from .remote import SourceUnavailable
from .synthetic import SyntheticSource
from .terrain import (
    TERRAIN_PRODUCTS,
    TILE_COL_OFFSET_DEG,
    TILE_GRID_SHAPE,
    TILE_ROW_OFFSET_DEG,
    TerrainDataset,
    hillshade,
    terrain_res,
    terrain_tiles,
)

__all__ = [
    "CELL_DEG",
    "CHIRPS_GRID",
    "DEFAULT_CUBES_DIR",
    "ERA5_LAND_GRID",
    "REGISTRY",
    "REQUEST_FORMATS",
    "REQUEST_STEP",
    "SOURCES",
    "STOP_COUNT",
    "SUPPORTED_BOUNDS_DEG",
    "TERRAIN_PRODUCTS",
    "TOP_PERCENTILE",
    "TILE_COL_OFFSET_DEG",
    "TILE_GRID_SHAPE",
    "TILE_ROW_OFFSET_DEG",
    "Bbox",
    "CellSpan",
    "CellWindow",
    "Dataset",
    "Era5LandCube",
    "Grid",
    "RainDataset",
    "RealSource",
    "Registry",
    "Role",
    "SeriesDataset",
    "SourceUnavailable",
    "StaticDataset",
    "SyntheticSource",
    "TemperatureDataset",
    "TerrainDataset",
    "add_duration",
    "hillshade",
    "is_request_label",
    "make_registry",
    "read_wrapped",
    "request_label",
    "request_range",
    "terrain_res",
    "terrain_tiles",
]
