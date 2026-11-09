import logging
from dataclasses import replace
from pathlib import Path

import rasterio
from rasterio.errors import RasterioIOError

from ..geology_age import AGE_CLASSES, GEOLOGY_AGE_FILE, GEOLOGY_AGE_RES_DEG
from ..geology_type import (
    GEOLOGY_CLASSES,
    GLIM_SOURCE,
    LITHOLOGY_FILE,
    LITHOLOGY_RES_DEG,
    OPENLANDMAP_CLASSES,
)
from .chirps import CHIRPS_CUBE, CHIRPS_GRID, ChirpsReader, RainDataset
from .cubes import DEFAULT_CUBES_DIR, HIGH_LATITUDE_FIRST_MONTH, CubeSpec, CubeStore
from .datasets import Registry, Role
from .era5 import (
    ERA5_PRECIPITATION_84N_CUBE,
    ERA5_PRECIPITATION_84N_FALLBACK,
    ERA5_PRECIPITATION_CUBE,
    ERA5_PRECIPITATION_FALLBACK,
    ERA5_TEMPERATURE_84N_CUBE,
    ERA5_TEMPERATURE_84N_FALLBACK,
    ERA5_TEMPERATURE_CUBE,
    ERA5_TEMPERATURE_FALLBACK,
)
from .era5land_precipitation import ERA5_LAND_PRECIPITATION_84N_CUBE, HighLatitudeRainDataset
from .era5land_temperature import (
    ERA5_LAND_84N_GRID,
    ERA5_LAND_TEMPERATURE_84N_CUBE,
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_LAND_TEMPERATURE_GRID,
    Era5LandTemperatureDataset,
)
from .grid import CELL_DEG, WORLD_GRID
from .geology import PROVENANCE_ROLE, GeologyDataset
from .licences import SOURCES
from .lithology import LithologyReader
from .remote import SourceUnavailable
from .synthetic import SyntheticSource
from .terrain import GLO30_RES_DEG, CopernicusDemReader, TerrainDataset, terrain_tiles_block
from .worldcover import (
    WORLDCOVER_CLASSES,
    WORLDCOVER_RES_DEG,
    LandCoverDataset,
    WorldCoverReader,
)


CUBE_SPECS = (
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_TEMPERATURE_CUBE,
    ERA5_PRECIPITATION_CUBE,
    CHIRPS_CUBE,
    ERA5_LAND_TEMPERATURE_84N_CUBE,
    ERA5_LAND_PRECIPITATION_84N_CUBE,
    ERA5_TEMPERATURE_84N_CUBE,
    ERA5_PRECIPITATION_84N_CUBE,
)

# The older cubes end at 60N until they are re-ingested, while the geology rasters reach 84N.
CUBE_COVERAGE_DEG = (-180, -60, 180, 60)
CUBE_COVERAGE_84N_DEG = (-180, -60, 180, 84)

log = logging.getLogger(__name__)


class RealSource(ChirpsReader, CopernicusDemReader, WorldCoverReader, LithologyReader, CubeStore):
    """Read terrain and land cover over HTTP, CHIRPS from its cube or HTTP, and cubes from disk.

    The lithology map is read from its COG in the cubes folder.
    """

    synthetic = False

    def __init__(
        self,
        latest: str | None = None,
        cubes_dir: Path | str = DEFAULT_CUBES_DIR,
    ) -> None:
        ChirpsReader.__init__(self, latest)
        CubeStore.__init__(self, CUBE_SPECS, cubes_dir)
        LithologyReader.__init__(self, cubes_dir)


def make_registry(backend: RealSource | SyntheticSource) -> Registry:
    """Return the datasets that can read through `backend`.

    Rainfall and Temperature are listed only when the backend has all of their cubes, so no
    layer lacks the fallback that fills its gaps. They reach 84N only while the cubes that reach
    it hold every month from 1981 that the ERA5 cube holds, so restart after such an ingest. A
    scene beyond 60N or S then takes its layers through `for_scene` to read those cubes alone.
    Geology is listed only when the backend has
    the lithology map and Geology age only when it has the age map.
    """
    registry = {}
    if backend.has_cube(ERA5_PRECIPITATION_CUBE):
        registry["chirps_monthly"] = _chirps_monthly(backend)
    registry["terrain"] = _terrain(backend)
    registry["esa_worldcover"] = _land_cover(backend)
    if backend.has_lithology():
        registry["geology"] = _geology(backend)
    if backend.has_lithology(GEOLOGY_AGE_FILE):
        registry["geology_age"] = _geology_age(backend)
    if backend.has_cube(ERA5_LAND_TEMPERATURE_CUBE) and backend.has_cube(ERA5_TEMPERATURE_CUBE):
        registry["era5land_temperature"] = _era5land_temperature(backend)
    return registry


def _chirps_monthly(backend: RealSource | SyntheticSource) -> RainDataset:
    rain = _chirps_to_60n(backend)
    north_cubes = (ERA5_LAND_PRECIPITATION_84N_CUBE, ERA5_PRECIPITATION_84N_CUBE)
    if not _reaches_84n(backend, ERA5_PRECIPITATION_CUBE, *north_cubes):
        return rain

    return HighLatitudeRainDataset(
        **{
            **vars(rain),
            "grid": WORLD_GRID,
            "coverage": CUBE_COVERAGE_84N_DEG,
            "north_cube": ERA5_LAND_PRECIPITATION_84N_CUBE,
            "north_fallback": ERA5_PRECIPITATION_84N_FALLBACK,
        },
    )


def _chirps_to_60n(backend: RealSource | SyntheticSource) -> RainDataset:
    return RainDataset(
        id="chirps_monthly",
        title="Rainfall",
        units="mm/month",
        resolution_deg=CELL_DEG,
        source=SOURCES["chirps"],
        roles={
            "value": Role(
                "precip",
                "uint16",
                scale=0.1,
                fill=65535,
                units="mm/month",
                long_name="Monthly precipitation",
            ),
        },
        style={
            "kind": "field",
            "encodings": ["ramp", "dots", "isolines", "chroma"],
            "palette": "ink-blue",
        },
        backend=backend,
        grid=CHIRPS_GRID,
        coverage=CUBE_COVERAGE_DEG,
        step="P1M",
        cell_method="sum",
        synthetic=backend.synthetic,
        fallback=ERA5_PRECIPITATION_FALLBACK,
    )


def _terrain(backend: RealSource | SyntheticSource) -> TerrainDataset:
    return TerrainDataset(
        id="terrain",
        title="Terrain",
        units="m",
        resolution_deg=GLO30_RES_DEG,
        source=SOURCES["glo30"],
        roles={},
        style={
            "kind": "terrain",
            "encodings": ["shade"],
            "parts": ["contours"],
        },
        backend=backend,
        grid=WORLD_GRID,
        max_tiles=2500,
        synthetic=backend.synthetic,
        tiles=terrain_tiles_block(),
    )


def _land_cover(backend: RealSource | SyntheticSource) -> LandCoverDataset:
    return LandCoverDataset(
        id="esa_worldcover",
        title="Land Cover",
        units="",
        resolution_deg=WORLDCOVER_RES_DEG,
        source=SOURCES["worldcover"],
        roles={
            "value": Role(
                "class",
                "uint8",
                fill=0,
                long_name="ESA WorldCover 2021 class",
            ),
        },
        style={
            "kind": "categorical",
            "encodings": ["fill"],
            "palette": "painted",
            "classes": WORLDCOVER_CLASSES,
        },
        backend=backend,
        grid=WORLD_GRID,
        max_tiles=2500,
        needs_tiles=True,
        synthetic=backend.synthetic,
    )


def _geology(backend: RealSource | SyntheticSource) -> GeologyDataset:
    # The COG records which map built it, so the registry passes that map's source and classes.
    if backend.lithology_source() == GLIM_SOURCE:
        source, north_source = SOURCES["glim"], SOURCES["glim_84n"]
        classes = GEOLOGY_CLASSES
    else:
        source, north_source = SOURCES["lithology"], SOURCES["lithology_84n"]
        classes = OPENLANDMAP_CLASSES
    return GeologyDataset(
        id="geology",
        title="Rock Type",
        units="",
        resolution_deg=LITHOLOGY_RES_DEG,
        source=source,
        roles={
            "value": Role(
                "class",
                "uint8",
                fill=0,
                long_name="Lithology class",
            ),
            "provenance": PROVENANCE_ROLE,
        },
        style={
            "kind": "categorical",
            "encodings": ["fill"],
            "palette": "painted",
            "classes": classes,
        },
        backend=backend,
        grid=WORLD_GRID,
        coverage=_geology_coverage(backend, LITHOLOGY_FILE),
        synthetic=backend.synthetic,
        north_source=north_source,
    )


def _geology_coverage(
    backend: RealSource | SyntheticSource,
    file: str,
) -> tuple[float, float, float, float]:
    """Return the 84N coverage when the COG behind `file` reaches 84N, else the 60N one.

    Synthetic data stands in for the rebaked maps, so it always reaches 84N. An older
    on-disk COG that still ends at 60N would otherwise leave geology empty above 60N.
    """
    if isinstance(backend, SyntheticSource):
        return CUBE_COVERAGE_84N_DEG
    # No public accessor leads to the COG, so the registry reads through the reader's folder.
    north = _cog_north_deg(backend._cubes_dir / file)
    if north is not None and north >= CUBE_COVERAGE_84N_DEG[3]:
        return CUBE_COVERAGE_84N_DEG
    log.warning("Geology COG %s reaches only %s, so geology keeps the 60N coverage", file, north)
    return CUBE_COVERAGE_DEG


def _cog_north_deg(path: Path) -> float | None:
    """Return the north edge of the COG at path in degrees, None when it cannot be read."""
    try:
        with rasterio.open(path) as source:
            return source.bounds.top
    except RasterioIOError:
        return None


def _geology_age(backend: RealSource | SyntheticSource) -> GeologyDataset:
    return GeologyDataset(
        id="geology_age",
        title="Geological Age",
        units="",
        resolution_deg=GEOLOGY_AGE_RES_DEG,
        source=SOURCES["gsc_world"],
        roles={
            "value": Role(
                "class",
                "uint8",
                fill=0,
                long_name="Rock age class",
            ),
            "provenance": PROVENANCE_ROLE,
        },
        style={
            "kind": "categorical",
            "encodings": ["fill"],
            "classes": AGE_CLASSES,
        },
        backend=backend,
        grid=WORLD_GRID,
        coverage=_geology_coverage(backend, GEOLOGY_AGE_FILE),
        synthetic=backend.synthetic,
        file=GEOLOGY_AGE_FILE,
        north_source=SOURCES["gsc_world_84n"],
    )


def _era5land_temperature(backend: RealSource | SyntheticSource) -> Era5LandTemperatureDataset:
    temperature = _era5land_temperature_to_60n(backend)
    north_cubes = (ERA5_LAND_TEMPERATURE_84N_CUBE, ERA5_TEMPERATURE_84N_CUBE)
    if not _reaches_84n(backend, ERA5_TEMPERATURE_CUBE, *north_cubes):
        return temperature

    return replace(
        temperature,
        grid=ERA5_LAND_84N_GRID,
        coverage=CUBE_COVERAGE_84N_DEG,
        north_cube=ERA5_LAND_TEMPERATURE_84N_CUBE,
        north_fallback=ERA5_TEMPERATURE_84N_FALLBACK,
        north_source=SOURCES["era5land_84n"],
    )


def _era5land_temperature_to_60n(
    backend: RealSource | SyntheticSource,
) -> Era5LandTemperatureDataset:
    return Era5LandTemperatureDataset(
        id="era5land_temperature",
        title="Temperature",
        units="°C",
        resolution_deg=0.1,
        source=SOURCES["era5land"],
        roles={
            "value": Role(
                "t2m",
                "int16",
                scale=0.1,
                fill=-32768,
                units="degC",
                long_name="Monthly mean 2 m air temperature",
            ),
        },
        style={
            "kind": "field",
            "encodings": ["ramp", "isolines", "warmth"],
            "palette": "climate",
        },
        backend=backend,
        grid=ERA5_LAND_TEMPERATURE_GRID,
        coverage=CUBE_COVERAGE_DEG,
        step="P1M",
        cell_method="mean",
        synthetic=backend.synthetic,
        remote=False,
        fallback=ERA5_TEMPERATURE_FALLBACK,
    )


def _reaches_84n(
    backend: RealSource | SyntheticSource,
    reference: CubeSpec,
    *north_cubes: CubeSpec,
) -> bool:
    """Return whether each cube that reaches 84N holds all months of the reference cube since 1981.

    A cube that is missing or being updated counts as incomplete, so the layer keeps its extent.
    """
    try:
        stored = [backend.optional_cube_months(cube) for cube in north_cubes]
        if not all(stored):
            return False

        wanted = {
            month
            for month in backend.cube_months(reference)
            if month >= HIGH_LATITUDE_FIRST_MONTH
        }
    except SourceUnavailable:
        return False

    return all(wanted <= months.keys() for months in stored)


REGISTRY = make_registry(RealSource())
