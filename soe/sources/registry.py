"""The datasets the backend can build, and the readers they read through."""
from .chirps import CHIRPS_GRID, ChirpsReader, RainDataset
from .datasets import Registry, Role
from .grid import CELL_DEG
from .licences import SOURCES
from .synthetic import SyntheticSource
from .terrain import GLO30_RES_DEG, CopernicusDemReader, TerrainDataset


class RealSource(ChirpsReader, CopernicusDemReader):
    """The real readers of every dataset, over HTTP."""

    synthetic = False


def make_registry(backend: RealSource | SyntheticSource) -> Registry:
    """The two datasets, reading through `backend` (RealSource or SyntheticSource)."""
    light = {"azimuth": 315, "altitude": 45}
    return {
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
            style={"kind": "series-colormap", "colormap": "Blues"},
            backend=backend,
            grid=CHIRPS_GRID,
            step="P1M",
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
                    units="m",
                    long_name="Elevation (resampled)",
                ),
                "hillshade": Role(
                    "hillshade",
                    "uint8",
                    long_name=f"Hillshade, azimuth {light['azimuth']}, "
                    f"altitude {light['altitude']} (0-255)",
                ),
            },
            style={"kind": "terrain", "hillshade": light},
            backend=backend,
            grid=CHIRPS_GRID,
            max_tiles=2500,
            synthetic=backend.synthetic,
        ),
    }


REGISTRY = make_registry(RealSource())
