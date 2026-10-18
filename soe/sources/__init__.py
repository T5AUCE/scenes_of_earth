"""Data sources: one module per source, the dataset contract and the registry.

Importers use these names, while the modules hold the code. Each of chirps.py,
era5land_temperature.py and terrain.py reads one source, synthetic.py stands in for all of them
offline, and registry.py lists the datasets.
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
from .era5land_temperature import (
    DEFAULT_CUBES_DIR,
    ERA5_LAND_TEMPERATURE_GRID,
    Era5LandTemperatureCube,
    Era5LandTemperatureDataset,
)
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
    "ERA5_LAND_TEMPERATURE_GRID",
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
    "Era5LandTemperatureCube",
    "Era5LandTemperatureDataset",
    "Grid",
    "RainDataset",
    "RealSource",
    "Registry",
    "Role",
    "SeriesDataset",
    "SourceUnavailable",
    "StaticDataset",
    "SyntheticSource",
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
