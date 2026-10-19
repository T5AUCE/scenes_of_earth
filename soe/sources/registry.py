from pathlib import Path

from .chirps import CHIRPS_GRID, ChirpsReader, RainDataset
from .cubes import DEFAULT_CUBES_DIR, CubeStore
from .datasets import Registry, Role
from .era5 import (
    ERA5_PRECIPITATION_CUBE,
    ERA5_PRECIPITATION_FALLBACK,
    ERA5_TEMPERATURE_CUBE,
    ERA5_TEMPERATURE_FALLBACK,
)
from .era5land_temperature import (
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_LAND_TEMPERATURE_GRID,
    Era5LandTemperatureDataset,
)
from .grid import CELL_DEG
from .licences import SOURCES
from .synthetic import SyntheticSource
from .terrain import GLO30_RES_DEG, CopernicusDemReader, TerrainDataset, terrain_tiles_block


CUBE_SPECS = (ERA5_LAND_TEMPERATURE_CUBE, ERA5_TEMPERATURE_CUBE, ERA5_PRECIPITATION_CUBE)


class RealSource(ChirpsReader, CopernicusDemReader, CubeStore):
    """Read CHIRPS and terrain over HTTP and the monthly cubes from local disk."""

    synthetic = False

    def __init__(
        self,
        latest: str | None = None,
        cubes_dir: Path | str = DEFAULT_CUBES_DIR,
    ) -> None:
        ChirpsReader.__init__(self, latest)
        CubeStore.__init__(self, CUBE_SPECS, cubes_dir)


def make_registry(backend: RealSource | SyntheticSource) -> Registry:
    """Return the datasets that can read through `backend`.

    Rainfall and Temperature are listed only when the backend has all of their cubes, so no
    layer lacks the fallback that fills its gaps.
    """
    registry = {}
    if backend.has_cube(ERA5_PRECIPITATION_CUBE):
        registry["chirps_monthly"] = _chirps_monthly(backend)
    registry["terrain"] = _terrain(backend)
    if backend.has_cube(ERA5_LAND_TEMPERATURE_CUBE) and backend.has_cube(ERA5_TEMPERATURE_CUBE):
        registry["era5land_temperature"] = _era5land_temperature(backend)
    return registry


def _chirps_monthly(backend: RealSource | SyntheticSource) -> RainDataset:
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
        grid=CHIRPS_GRID,
        max_tiles=2500,
        synthetic=backend.synthetic,
        tiles=terrain_tiles_block(),
    )


def _era5land_temperature(backend: RealSource | SyntheticSource) -> Era5LandTemperatureDataset:
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
        step="P1M",
        cell_method="mean",
        synthetic=backend.synthetic,
        remote=False,
        fallback=ERA5_TEMPERATURE_FALLBACK,
    )


REGISTRY = make_registry(RealSource())
