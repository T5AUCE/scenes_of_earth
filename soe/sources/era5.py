"""Define the general ERA5 monthly cubes used to fill temperature and rainfall gaps.

ERA5 covers land and sea at 0.25 degrees without gaps. Temperature takes it where ERA5-Land has
no land value, and rainfall takes its precipitation where CHIRPS has none. Each cube has a twin
that reaches 84N, and a layer reads the twin only for a scene that goes beyond 60N.
"""
from dataclasses import dataclass, replace

from .cubes import CubeSpec
from .datasets import Fallback, SeriesDataset
from .grid import Grid
from .licences import SOURCES

# Cell centres lie on 0.25 degree multiples, so the first column is centred on -180.
ERA5_GRID = Grid(-180.125, 60.125, 0.25, 1440, 481)
ERA5_84N_GRID = Grid(-180.125, 84.125, 0.25, 1440, 577)

ERA5_TEMPERATURE_CUBE = CubeSpec(
    name="era5_temperature",
    title="ERA5 temperature",
    array="t2m",
    grid=ERA5_GRID,
    dtype="int16",
    scale=0.01,
    fill=-32768,
    units="degC",
)
ERA5_PRECIPITATION_CUBE = CubeSpec(
    name="era5_precipitation",
    title="ERA5 precipitation",
    array="tp",
    grid=ERA5_GRID,
    dtype="uint16",
    scale=0.1,
    fill=65535,
    units="mm/month",
)

ERA5_TEMPERATURE_84N_CUBE = ERA5_TEMPERATURE_CUBE._replace(
    name="era5_temperature_84n",
    title="ERA5 temperature to 84N",
    grid=ERA5_84N_GRID,
)
ERA5_PRECIPITATION_84N_CUBE = ERA5_PRECIPITATION_CUBE._replace(
    name="era5_precipitation_84n",
    title="ERA5 precipitation to 84N",
    grid=ERA5_84N_GRID,
)

ERA5_TEMPERATURE_FALLBACK = Fallback(
    ERA5_TEMPERATURE_CUBE,
    SOURCES["era5"],
    "Temperature uses ERA5 air temperature over land and sea (about 28 km) in {filled} of "
    "{inside} cells where ERA5-Land has no land value. On small islands it describes the "
    "air over the surrounding sea.",
)
ERA5_PRECIPITATION_FALLBACK = Fallback(
    ERA5_PRECIPITATION_CUBE,
    SOURCES["era5"],
    "Rainfall uses ERA5 model rain over land and sea (about 28 km) in {filled} of {inside} "
    "cells where CHIRPS has no value.",
)
ERA5_TEMPERATURE_84N_FALLBACK = ERA5_TEMPERATURE_FALLBACK._replace(
    cube=ERA5_TEMPERATURE_84N_CUBE,
    source=SOURCES["era5_84n"],
)
# The 84N rain fallback keeps the legacy notice because southern scenes read no ERA5-Land.
ERA5_PRECIPITATION_84N_FALLBACK = ERA5_PRECIPITATION_FALLBACK._replace(
    cube=ERA5_PRECIPITATION_84N_CUBE,
    source=SOURCES["era5_84n"],
)


@dataclass
class HighLatitudeSeries(SeriesDataset):
    """A series layer whose cubes have twins that reach 84N.

    A layer reads the first cubes until `for_scene` marks the scene as one that goes beyond 60
    degrees, so a scene inside them is rebuilt with the same bytes whatever its read window.
    The marked copy takes its reads, months, revisions and notices from the twins alone, so
    none of them can name a month that the twins lack.
    """

    north_cube: CubeSpec | None = None  # the ERA5-Land cube that reaches 84N
    north_fallback: Fallback | None = None  # the ERA5 fallback that reaches 84N
    north_source: dict | None = None  # the main source as credited for the 84N cubes
    reads_north: bool = False  # set on the copy that `for_scene` returns

    def for_scene(self, beyond_legacy_extent: bool) -> "HighLatitudeSeries":
        """Return the layer as a scene reads it, with the twins when the scene goes beyond 60N/S.

        The decision is the scene's own, the one that marks its id, and is never taken from the
        padded window of a read.
        """
        if not beyond_legacy_extent or self.north_cube is None:
            return self

        return replace(
            self,
            source=self.north_source or self.source,
            fallback=self.north_fallback,
            reads_north=True,
        )
