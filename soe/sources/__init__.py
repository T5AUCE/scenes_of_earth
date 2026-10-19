"""Expose the dataset contracts and registry alongside the source readers.

Importers use these names, while the modules hold the code. Each of chirps.py,
era5land_temperature.py and terrain.py reads one source. The era5.py module holds the general
ERA5 cubes that fill the gaps of the first two. The synthetic.py module stands in for all of
them offline. The registry.py module lists the datasets.
"""
from .chirps import CHIRPS_GRID, RainDataset
from .cubes import DEFAULT_CUBES_DIR, CubeSpec, CubeStore, MonthlyCube
from .datasets import (
    FROM_FALLBACK,
    FROM_MAIN,
    SOURCE_ROLE,
    STOP_COUNT,
    SUPPORTED_BOUNDS_DEG,
    TOP_PERCENTILE,
    Dataset,
    Fallback,
    FilledStep,
    Registry,
    Role,
    SeriesDataset,
    StaticDataset,
)
from .era5 import ERA5_GRID, ERA5_PRECIPITATION_CUBE, ERA5_TEMPERATURE_CUBE
from .era5land_temperature import (
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_LAND_TEMPERATURE_GRID,
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
    "ERA5_GRID",
    "ERA5_LAND_TEMPERATURE_CUBE",
    "ERA5_LAND_TEMPERATURE_GRID",
    "ERA5_PRECIPITATION_CUBE",
    "ERA5_TEMPERATURE_CUBE",
    "FROM_FALLBACK",
    "FROM_MAIN",
    "REGISTRY",
    "REQUEST_FORMATS",
    "REQUEST_STEP",
    "SOURCE_ROLE",
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
    "CubeSpec",
    "CubeStore",
    "Dataset",
    "Era5LandTemperatureDataset",
    "Fallback",
    "FilledStep",
    "Grid",
    "MonthlyCube",
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
