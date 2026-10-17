"""Shared test helpers: a real-mode source that reads synthetic data (no network)."""
from collections.abc import Callable

import numpy as np
import pytest
from rasterio.transform import Affine

from soe.sources import (
    Bbox,
    CellWindow,
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

    def terrain(
        self,
        bounds: Bbox,
        res: float,
        on_block: Callable[[], None] = lambda: None,
    ) -> tuple[np.ndarray, Affine]:
        return self.data.terrain(bounds, res, on_block)


@pytest.fixture
def revision_source():
    return RevisionSource()
