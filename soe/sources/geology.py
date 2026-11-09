"""Compose runtime rock-type and rock-age datasets with regional provenance and notices."""
from collections.abc import Callable
from dataclasses import dataclass, replace

import numpy as np
from rasterio.transform import Affine
from shapely.geometry.base import BaseGeometry

from ..geology_age import GEOLOGY_AGE_FILE, GSC_SOURCE
from ..geology_regional import (
    REGIONAL_SOURCES,
    candidates_for,
    read_composited,
    regional_notices,
    used_in,
)
from ..geology_type import GLIM_SOURCE, LITHOLOGY_FILE
from .datasets import Role, StaticDataset
from .grid import (
    CELL_DEG,
    MAX_STATIC_DIVISIONS,
    MAX_STATIC_SIDE_PX,
    STATIC_BUDGET_PX,
    Bbox,
    budget_res,
)
from .licences import SOURCES
from .worldcover import worldcover_tiles

# Static layers cannot reuse the series `source` array name, which is reserved for fallbacks.
PROVENANCE_ROLE = Role(
    "provenance",
    "uint8",
    fill=0,
    long_name="Source of the values: 1 base map, 2 and above regional sources, 0 outside",
)


@dataclass
class GeologyDataset(StaticDataset):
    """The most common rock class (type or age) in each cell, at a size set by the area.

    The global base map fills every cell first and each present regional COG overrides it in
    priority order, so a missing regional file only loses its patch. Every cell also keeps
    the code of the source behind its value for the bundle's provenance array.
    """

    file: str = LITHOLOGY_FILE  # the class COG in the cubes folder
    north_source: dict | None = None  # the base source as credited for a scene beyond 60N or S

    def __post_init__(self) -> None:
        """Remember which map built the COG for the notices and require land tiles.

        Offline data stands in for the real map. Land tiles make open sea refused early.
        """
        self.needs_tiles = True
        self.lithology_source = self.backend.lithology_source(self.file)

    def for_scene(self, beyond_legacy_extent: bool) -> "GeologyDataset":
        """Return the layer as a scene reads it, with the base source of the 84N maps beyond 60N/S.

        A scene inside 60N keeps the source it always had, so its scene id stays the same.
        """
        if not beyond_legacy_extent or self.north_source is None:
            return self

        return replace(self, source=self.north_source)

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

        Regional COGs override the base map in priority order; the provenance codes hold 0
        where no map has a value, 1 for the base and one code per regional source.
        """
        classes, codes, transform = read_composited(
            self.backend,
            self.kind,
            self.file,
            tuple(bbox),
            res,
            on_block or (lambda: None),
        )
        return {"value": classes, "provenance": codes}, transform

    @property
    def kind(self) -> str:
        """Return "age" for the rock-age COG and "type" for the rock-type one."""
        return "age" if self.file == GEOLOGY_AGE_FILE else "type"

    def sources_for(self, bbox: Bbox) -> list[dict]:
        """Return the base source with the regional ones whose footprint meets bbox."""
        regionals = candidates_for(self.kind, tuple(bbox), self.backend.has_lithology)
        return [self.source, *(self._regional_source(source) for source in regionals)]

    def _regional_source(self, source: dict) -> dict:
        """Return the licence entry of a regional source with the version of this layer."""
        entry = SOURCES[source["licence"]]
        if self.kind == "age" and "age_version" in entry:
            return {**entry, "version": entry["age_version"]}

        return entry

    def regional_versions(self, bbox: Bbox) -> list[str]:
        """Return "id:version" of each installed regional source whose footprint meets bbox."""
        installed = candidates_for(self.kind, tuple(bbox), self.backend.has_lithology)
        versions = [self._regional_source(source)["version"] for source in installed]
        return [f"{source['id']}:{version}" for source, version in zip(installed, versions)]

    def summary(
        self,
        arrays: dict[str, np.ndarray],
        weights: np.ndarray,
        transform: Affine,
        geometry: BaseGeometry,
    ) -> dict[str, object]:
        """Return the sources and notices of the cells the build keeps.

        The build passes only provenance codes of kept cells, so credits and notices follow
        the sources that really supplied the bundle; build.py writes the codes themselves.
        """
        used = used_in(arrays["provenance"])
        regional = tuple(source_id for source_id in used if source_id != "global_base")
        entries = {source["id"]: source for source in REGIONAL_SOURCES}
        base = [self.source] if "global_base" in used else []
        return {
            "used_sources": [
                *base,
                *(self._regional_source(entries[source_id]) for source_id in regional),
            ],
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
