"""Define the general ERA5 monthly cubes used to fill temperature and rainfall gaps.

ERA5 covers land and sea at 0.25 degrees without gaps. Temperature takes it where ERA5-Land has
no land value, and rainfall takes its precipitation where CHIRPS has none.
"""
from .cubes import CubeSpec
from .datasets import Fallback
from .grid import Grid
from .licences import SOURCES

# Cell centres lie on 0.25 degree multiples, so the first column is centred on -180.
ERA5_GRID = Grid(-180.125, 60.125, 0.25, 1440, 481)

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
