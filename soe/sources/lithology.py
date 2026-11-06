"""Read the lithology COG as the most common rock class in each output cell.

`soe.ingest.lithology` writes the COG from GLiM or the OpenLandMap lithology map, and a build only
reads it. The COG records which one, and the registry takes the classes and source from that.
Table order fixes the class values, so new codes may only be appended. The rock-age COG of
`soe.ingest.geology_age` is read the same way, from its own file.
"""
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError, WarpOperationError
from rasterio.transform import Affine, from_origin
from shapely.geometry.base import BaseGeometry

from ..areas import WORLD_WIDTH_DEG
from ..geology_age import GEOLOGY_AGE_FILE, GSC_SOURCE
from .datasets import StaticDataset
from .grid import (
    CELL_DEG,
    MAX_STATIC_DIVISIONS,
    MAX_STATIC_SIDE_PX,
    STATIC_BUDGET_PX,
    Bbox,
    budget_res,
)
from .licences import SOURCES
from .remote import SourceUnavailable
from .worldcover import overview_factor, overview_level, warp_modes, worldcover_tiles

LITHOLOGY_FILE = "lithology.tif"  # in the cubes folder
LITHOLOGY_RES_DEG = 1 / 480
ANTIMERIDIAN_DEG = WORLD_WIDTH_DEG / 2

OPENLANDMAP_SOURCE = "openlandmap"
GLIM_SOURCE = "glim"
LITHOLOGY_SOURCE_TAG = "LITHOLOGY_SOURCE"  # in the COG; a COG without it came from OpenLandMap

# OpenLandMap values 1 to 15 are the source classes in file-name order with water and undefined
# as no data.
OPENLANDMAP_CLASSES = [
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

# The per-cell source behind a geology value: 1 for the global base map, one code per
# regional source, 0 where no map has a value. Static layers cannot reuse the series
# `source` array name, which the contract reserves for layers with a fallback.
PROVENANCE_ROLE = Role(
    "provenance",
    "uint8",
    fill=0,
    long_name="Source of the values: 1 base map, 2 and above regional sources, 0 outside",
)

# Each family lists its level 2 codes in value order, with "__" for no level 2 code.
GLIM_FAMILIES = [
    (
        "su",
        "Unconsolidated",
        "Sediments",
        "#fdf0a8",
        "mx ss sh pu py ad ds la lo or",
    ),
    (
        "ss",
        "Siliciclastic",
        "Sediments",
        "#e8c33c",
        "mx ss sh py am la lo",
    ),
    (
        "sm",
        "Mixed",
        "Sediments",
        "#c2ab5a",
        "mx ss sh py ad ds la lo or am gr",
    ),
    (
        "sc",
        "Carbonate",
        "Sediments",
        "#6fa8d6",
        "mx ss sh pu py ad la lo am",
    ),
    (
        "ev",
        "Evaporites",
        "Sediments",
        "#c5a3d6",
        "__ mx ss sh pu",
    ),
    (
        "py",
        "Pyroclastics",
        "Volcanic",
        "#d9753b",
        "__ mx ss sh pu or am",
    ),
    (
        "va",
        "Acid",
        "Volcanic",
        "#e57373",
        "__ pu py am",
    ),
    (
        "vi",
        "Intermediate",
        "Volcanic",
        "#c0392b",
        "__ mx pu py am",
    ),
    (
        "vb",
        "Basic",
        "Volcanic",
        "#6c3483",
        "__ mx pu py la am gr",
    ),
    (
        "pa",
        "Acid",
        "Plutonic",
        "#f194b4",
        "__ pu py am gr",
    ),
    (
        "pi",
        "Intermediate",
        "Plutonic",
        "#d65d8a",
        "__ pu py am gr",
    ),
    (
        "pb",
        "Basic",
        "Plutonic",
        "#8e2f5c",
        "__ pu py am",
    ),
    (
        "mt",
        "Metamorphic",
        "Metamorphic",
        "#8a9a7b",
        "__ mx sh pu py la am gr",
    ),
    (
        "ig",
        "Ice and glaciers",
        "Ice/other",
        "#f2f4f5",
        "__",
    ),
]
GLIM_LEVEL2_NAMES = {
    "__": "",
    "mx": "mixed grain",
    "ss": "coarse grain",
    "sh": "fine grain",
    "pu": "pure",
    "py": "with pyroclasts",
    "ad": "alluvial",
    "ds": "dunes",
    "la": "lateritic",
    "lo": "loess",
    "or": "organic",
    "am": "amphibolite",
    "gr": "greenschist",
}


def _glim_class_table() -> list[tuple[str, dict]]:
    """Return (level 1 + level 2 code, class) for each GLiM class, valued in table order."""
    table = []
    for code, name, group, color, level2_codes in GLIM_FAMILIES:
        for variant, level2 in enumerate(level2_codes.split()):
            suffix = GLIM_LEVEL2_NAMES[level2]
            entry = {
                "value": len(table) + 1,
                "label": f"{name}, {suffix}" if suffix else name,
                "color": color,
                "group": group,
                "parent": code,
                "variant": variant,
            }
            table.append((code + level2, entry))
    return table


_GLIM_TABLE = _glim_class_table()
GEOLOGY_CLASSES = [entry for _, entry in _GLIM_TABLE]  # the classes of the GLiM COG
# Water bodies (wb) and no data (nd) have no value, so the COG stores them as 0.
GLIM_VALUES = {code: entry["value"] for code, entry in _GLIM_TABLE}


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


@dataclass
class GeologyDataset(StaticDataset):
    """The most common rock class (type or age) in each cell, at a size set by the area.

    The global base map fills every cell first and each present regional COG overrides it in
    priority order, so a missing regional file only loses its patch. Every cell also keeps
    the code of the source behind its value for the bundle's provenance array.
    """

    file: str = LITHOLOGY_FILE  # the class COG in the cubes folder

    def __post_init__(self) -> None:
        """Remember which map built the COG for the notices and require land tiles.

        Offline data stands in for the real map. Land tiles make open sea refused early.
        """
        self.needs_tiles = True
        self.lithology_source = self.backend.lithology_source(self.file)

    def tile_count(self, bbox: Bbox) -> int:
        """Return the land tile count of bbox, which is zero over open sea."""
        # Geology is land-only like land cover, so the same tile check refuses open sea early.
        return len(worldcover_tiles(bbox))

    def res_for(self, bbox: Bbox) -> float:
        """Return the cell size in degrees that fits bbox within the static pixel budget.

        The grid never goes finer than the COG's native cells, so geology keeps one
        source class per cell instead of replicating staircases.
        """
        native_divisions = round(CELL_DEG / self.resolution_deg)
        max_divisions = min(MAX_STATIC_DIVISIONS, native_divisions)
        return budget_res(bbox, STATIC_BUDGET_PX, MAX_STATIC_SIDE_PX, max_divisions)

    def read(
        self,
        bbox: Bbox,
        res: float,
        on_block: Callable[[], None] | None = None,
    ) -> tuple[dict[str, np.ndarray], Affine]:
        """Return uint8 classes over bbox at cell size `res` with their source codes.

        Regional COGs override the base map in priority order; the codes array holds 0 where
        no map has a value, 1 for the base and one code per regional source.
        """
        from ..geology_regional import read_composited

        classes, codes, transform = read_composited(
            self.backend,
            self.kind,
            self.file,
            tuple(bbox),
            res,
            on_block or (lambda: None),
        )
        return {"value": classes, "source": codes}, transform

    @property
    def kind(self) -> str:
        """Return "age" for the rock-age COG and "type" for the rock-type one."""
        return "age" if self.file == GEOLOGY_AGE_FILE else "type"

    def sources_for(self, bbox: Bbox) -> list[dict]:
        """Return the base source with the regional ones whose footprint meets bbox."""
        from ..geology_regional import candidates_for

        regionals = candidates_for(self.kind, tuple(bbox), self.backend.has_lithology)
        return [self.source, *(SOURCES[source["licence"]] for source in regionals)]

    def summary(
        self,
        arrays: dict[str, np.ndarray],
        weights: np.ndarray,
        transform: Affine,
        geometry: BaseGeometry,
    ) -> dict[str, object]:
        """Return the regional provenance of the build for the bundle's source array.

        `fallback_used` reuses the series key so the bundle carries the per-cell source codes
        in its `source` array without a new contract field. Notices name only the regional
        sources behind weighted cells.
        """
        from ..geology_regional import regional_notices, used_in

        used = used_in(arrays["source"], weights)
        regional = tuple(source_id for source_id in used if source_id != "global_base")
        if not regional:
            return {}
        return {
            "fallback_used": True,
            "regional_used": True,
            "notices": regional_notices(regional, self.kind),
        }

    def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
        """Return notices about the scale of the source map, its seams and its gaps."""
        if self.lithology_source == GSC_SOURCE:
            return [
                "Rock age comes from the Geological Survey of Canada world geology map at about "
                "1:35 million, the worldwide fallback, so boundaries are approximate by tens of "
                "kilometres. About a third of the mapped area is dated only to an era or wider, "
                "and ages are generalised to ICS periods, so each colour is the smallest period "
                "or era that holds the whole age range of its unit. Lakes, rivers and unmapped "
                "islands have no rock age and are hatched as no data.",
            ]

        if self.lithology_source == GLIM_SOURCE:
            return [
                "Rock type comes from the Global Lithological Map (GLiM) at about 1:3.75 "
                "million, so boundaries are approximate at local scale and can jump where "
                "the 92 source maps it joins meet. Lakes and rivers "
                "have no rock class, so they stay uncoloured. Some islands and coastal "
                "strips have no mapped rock type and are hatched as no data.",
            ]

        return [
            "Rock type comes from a global map at about 1:3.75 million, so boundaries are "
            "approximate at local scale and can jump where national source maps meet and at "
            "180° longitude. Small islands and some coasts have no rock class in the source "
            "map, so they stay uncoloured.",
        ]
