"""Share a real-mode source that reads synthetic data so tests need no network."""
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest
import zarr
from rasterio.transform import Affine

from soe.sources import (
    CHIRPS_CUBE,
    Bbox,
    CellWindow,
    CubeSpec,
    RealSource,
    SourceUnavailable,
    SyntheticSource,
)


class RevisionSource(RealSource):
    """A real-mode backend (so revisions are stored) that reads synthetic data and no network."""

    def __init__(self) -> None:
        super().__init__(latest="2026-08")
        self.data = SyntheticSource()
        self.revision = "first"
        self.down = False
        self.revision_calls = 0

    def current_revision(self, month: str) -> str:
        self.revision_calls += 1
        if self.down:
            raise SourceUnavailable("down")

        return self.revision

    def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
        return self.data.read_rain(month, window)

    def has_cube(self, spec: CubeSpec) -> bool:
        return self.data.has_cube(spec)

    def cube_months(self, spec: CubeSpec) -> dict[str, str]:
        return self.data.cube_months(spec)

    def optional_cube_months(self, spec: CubeSpec) -> dict[str, str]:
        return self.data.optional_cube_months(spec)

    def read_cube(self, spec: CubeSpec, month: str, window: CellWindow) -> np.ndarray:
        return self.data.read_cube(spec, month, window)

    def terrain(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
    ) -> tuple[np.ndarray, Affine]:
        return self.data.terrain(bounds, res, on_block)


def write_updating_chirps_cube(cubes_dir: Path) -> None:
    """Store a CHIRPS cube with one month still pending, as while an ingest is publishing."""
    group = zarr.open_group(cubes_dir / f"{CHIRPS_CUBE.name}.zarr", mode="w")
    group.create_array(CHIRPS_CUBE.array, shape=(1, 1, 1), dtype=CHIRPS_CUBE.dtype)
    group.attrs["months"] = {"2016-01": "0001:final"}
    group.attrs["pending"] = ["2016-01"]


@pytest.fixture
def revision_source():
    return RevisionSource()
