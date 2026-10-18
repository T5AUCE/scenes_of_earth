"""The datasets the backend can build, and the readers they read through."""
from pathlib import Path

from .chirps import CHIRPS_GRID, ChirpsReader, RainDataset
from .datasets import Registry, Role
from .era5land_temperature import (
    DEFAULT_CUBES_DIR,
    ERA5_LAND_TEMPERATURE_GRID,
    Era5LandTemperatureCube,
    Era5LandTemperatureDataset,
)
from .grid import CELL_DEG
from .licences import SOURCES
from .synthetic import SyntheticSource
from .terrain import (
    ELEVATION_FILL,
    GLO30_RES_DEG,
    HILLSHADE_FILL,
    CopernicusDemReader,
    TerrainDataset,
)


class RealSource(ChirpsReader, CopernicusDemReader, Era5LandTemperatureCube):
    """The real readers of every dataset. HTTP for rain and terrain, local disk for temperature."""

    synthetic = False

    def __init__(
        self,
        latest: str | None = None,
        cubes_dir: Path | str = DEFAULT_CUBES_DIR,
    ) -> None:
        ChirpsReader.__init__(self, latest)
        Era5LandTemperatureCube.__init__(self, cubes_dir)


def make_registry(backend: RealSource | SyntheticSource) -> Registry:
    """The datasets, reading through `backend` (RealSource or SyntheticSource).

    Temperature is listed only when the backend has its cube, so no layer lacks data.
    """
    light = {"azimuth": 315, "altitude": 45}
    registry = {
        "chirps_monthly": RainDataset(
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
        ),
        "copdem_terrain": TerrainDataset(
            id="copdem_terrain",
            title="Terrain",
            units="m",
            resolution_deg=GLO30_RES_DEG,
            source=SOURCES["glo30"],
            roles={
                "elevation": Role(
                    "elevation",
                    "int16",
                    fill=ELEVATION_FILL,
                    units="m",
                    long_name="Elevation (resampled)",
                ),
                "hillshade": Role(
                    "hillshade",
                    "uint8",
                    fill=HILLSHADE_FILL,
                    long_name=(
                        f"Hillshade, azimuth {light['azimuth']}, "
                        f"altitude {light['altitude']} (0-254)"
                    ),
                ),
            },
            style={
                "kind": "terrain",
                "encodings": ["shade"],
                "parts": ["contours"],
                "hillshade": light,
            },
            backend=backend,
            grid=CHIRPS_GRID,
            max_tiles=2500,
            synthetic=backend.synthetic,
        ),
    }
    if backend.has_t2m():
        registry["era5land_temperature"] = _era5land_temperature(backend)
    return registry


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
    )


REGISTRY = make_registry(RealSource())
