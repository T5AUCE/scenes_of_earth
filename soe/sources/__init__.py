"""Data sources: one module per source, the dataset contract and the registry.

Importers use these names; the modules are the homes: chirps.py and terrain.py read a source,
synthetic.py stands in for both offline, registry.py lists the datasets.
"""
from .chirps import CHIRPS_GRID, FIRST_MONTH, RainDataset
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
from .grid import CELL_DEG, Bbox, CellSpan, CellWindow, Grid
from .licences import SOURCES
from .months import month_list
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
    "FIRST_MONTH",
    "REGISTRY",
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
    "hillshade",
    "make_registry",
    "month_list",
    "terrain_res",
    "terrain_tiles",
]
