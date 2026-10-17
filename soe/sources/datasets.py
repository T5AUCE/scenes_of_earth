"""The dataset contract: roles, static and series datasets, and the registry type."""
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import ClassVar, NamedTuple

import numpy as np
from rasterio.transform import Affine

from .grid import Bbox, Grid

Registry = dict[str, "Dataset"]  # dataset id -> dataset

# The app supports 60S-60N in v1; widen the extent here.
SUPPORTED_BOUNDS_DEG = (-180, -60, 180, 60)  # W, S, E, N


class Role(NamedTuple):
    """One data array of a layer: where it is stored, how, and how the viewer decodes it."""

    name: str  # array name inside the Zarr group of the layer
    dtype: str  # stored dtype
    scale: float = 1  # decoded = stored * scale + offset
    offset: float = 0
    fill: int | None = None  # stored value that means "no data"
    units: str = ""  # CF attributes of the array; omitted when empty
    long_name: str = ""


@dataclass
class Dataset(ABC):
    """A layer the backend can build; subclass StaticDataset or SeriesDataset, not this."""

    # Set only by StaticDataset/SeriesDataset; some code branches on it, some on isinstance.
    time_varying: ClassVar[bool]  # published in scene.json and /api/layers

    id: str
    title: str
    units: str
    resolution_deg: float  # native cell size
    source: dict  # licence, licence_url, attribution, citation, modified, version, ...
    roles: dict[str, Role]  # by role, e.g. value, elevation, hillshade
    style: dict  # viewer defaults
    backend: object
    grid: Grid  # the layer's window is cut on this grid
    coverage: tuple = SUPPORTED_BOUNDS_DEG  # W, S, E, N; a narrower dataset overrides it
    step: str | None = None  # ISO 8601 duration between time steps; None for static layers
    max_tiles: int | None = None  # request cap for tiled datasets
    synthetic: bool = False  # offline stand-in data, kept apart from real revisions

    def tile_count(self, bbox: Bbox) -> int:
        """Number of source tiles a read of bbox needs (0 for untiled data)."""
        return 0

    def res_for(self, bbox: Bbox) -> float:
        """Cell size of a static layer over bbox."""
        return self.resolution_deg

    def current_revision(self, last_month: str) -> str | None:
        """The provider's current revision marker of `last_month`, or None for static data.

        A revision is a string that changes whenever the provider republishes that month's
        data. It is part of the scene id, so revised data gets a new scene.
        """
        return None

    def domain(self, stats: dict[str, float]) -> list[float]:
        """Colour-scale range of a series layer, from the stats of its values."""
        return [stats["min"], stats["p98"]]

    def sources_for(self, bbox: Bbox) -> list[dict]:
        """The sources a read of bbox uses, the main one first."""
        return [self.source]

    def notices(self, bbox: Bbox) -> list[str]:
        """Limits notices for a read of bbox."""
        return []


class StaticDataset(Dataset):
    """A layer without a time axis, read as one 2D grid."""

    time_varying = False

    def block_count(self, bbox: Bbox) -> int:
        """Number of parts a read of bbox reports through on_block; the weight of its progress."""
        return 1

    @abstractmethod
    def read(
        self,
        bbox: Bbox,
        res: float,
        on_block: Callable[[], None] | None = None,
    ) -> tuple[dict[str, np.ndarray], Affine]:
        """Values over bbox at cell size `res`: ({role: 2D array in the stored dtype}, transform).

        on_block() is called each time one of block_count(bbox) parts has been read.
        """


class SeriesDataset(Dataset):
    """A layer with a time axis, read one step at a time on its grid."""

    time_varying = True

    @abstractmethod
    def first(self) -> str:
        """First available month, 'YYYY-MM'."""

    @abstractmethod
    def latest(self) -> str:
        """Latest available month, 'YYYY-MM'."""

    @abstractmethod
    def steps(self, start: str, end: str) -> list[str]:
        """Period starts (ISO dates) of the months start..end ('YYYY-MM')."""

    @abstractmethod
    def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """The step that starts on the ISO date `step`, block-averaged by `factor`."""
