"""The dataset contract: roles, static and series datasets, and the registry type."""
import math
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import ClassVar, NamedTuple

import numpy as np
from rasterio.transform import Affine

from .grid import Bbox, Grid
from .periods import add_duration

Registry = dict[str, "Dataset"]  # dataset id -> dataset

SUPPORTED_BOUNDS_DEG = (-180, -60, 180, 60)  # W, S, E, N; supported v1 extent

STOP_COUNT = 9  # colour stops of a series layer, one per palette colour
STOP_DIGITS = 2  # significant digits of the stops span that a stop keeps
TOP_PERCENTILE = 98  # the last stop; values above it share the top colour


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

    # Both isinstance checks and published metadata must agree on the dataset kind.
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
    cell_method: str | None = None  # how a step summarises its period: sum, mean, point or max
    max_tiles: int | None = None  # request cap for tiled datasets
    synthetic: bool = False  # offline stand-in data, kept apart from real revisions
    remote: bool = True  # revisions are asked from a remote server, so they are cached

    def __post_init__(self) -> None:
        """Runs after construction; subclasses check their invariants here."""

    def tile_count(self, bbox: Bbox) -> int:
        """Number of source tiles a read of bbox needs (0 for untiled data)."""
        return 0

    def res_for(self, bbox: Bbox) -> float:
        """Cell size of a static layer over bbox."""
        return self.resolution_deg

    def current_revision(self, steps: list[str]) -> str | None:
        """The provider's current revision marker of the period starts `steps`, or None.

        A revision is a string that changes whenever the provider republishes data of any of
        those periods. It is part of the scene id, so revised data gets a new scene.
        """
        return None

    def stops(self, stats: dict[str, float], quantiles: list[float]) -> list[float]:
        """Fitted colour stops of a series layer, increasing, at most STOP_COUNT.

        `quantiles` are the values at STOP_COUNT evenly spaced percentiles from 0 to
        TOP_PERCENTILE. Each stop is the mean of an even stretch and the quantile, so
        skewed data is spread over the palette without crowding the low colours. Stops are
        rounded to a step set by the span (so 288-300 K keeps whole degrees), and repeats are
        dropped. A constant field has no span; its stops are the same value twice.
        """
        low = self.stops_floor(stats)
        high = stats["p98"]
        if high <= low:
            return [low, high]

        evenly_spaced = np.linspace(low, high, STOP_COUNT)
        blended = [low, *((evenly_spaced[1:] + np.array(quantiles[1:])) / 2)]
        decimals = STOP_DIGITS - 1 - math.floor(math.log10(high - low))
        increasing = _strictly_increasing([round(float(stop), decimals) for stop in blended])
        return increasing if len(increasing) >= 2 else [low, high]

    def stops_floor(self, stats: dict[str, float]) -> float:
        """The first colour stop of a series layer."""
        return stats["min"]

    def sources_for(self, bbox: Bbox) -> list[dict]:
        """The sources a read of bbox uses, the main one first."""
        return [self.source]

    def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
        """Limits notices for a read of bbox over the period starts `steps`."""
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

    def __post_init__(self) -> None:
        """Reject fill values that could be confused with encoded measurements."""
        for spec in self.roles.values():
            _check_series_fill(self.id, spec)

    @abstractmethod
    def first(self) -> str:
        """Start of the first available period, an ISO date."""

    @abstractmethod
    def latest(self) -> str:
        """Start of the latest available period, an ISO date."""

    def period_end(self, step: str) -> str:
        """The ISO date after the period that starts on `step`."""
        return add_duration(step, self.step)

    def steps(self, start: str, end: str) -> list[str]:
        """Starts (ISO dates) of the periods that overlap [start, end) and are available."""
        latest = self.latest()
        steps = []
        step = self.first()
        while step < end and step <= latest:
            following = self.period_end(step)
            if following > start:
                steps.append(step)
            step = following
        return steps

    @abstractmethod
    def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
        """The step that starts on the ISO date `step`, block-averaged by `factor`."""


def _check_series_fill(dataset_id: str, spec: Role) -> None:
    """A series role's fill must be an end of its dtype range, so no value is clipped onto it."""
    limits = np.iinfo(spec.dtype)
    if spec.fill not in (limits.min, limits.max):
        raise ValueError(f"{dataset_id}: {spec.name} needs a fill at the end of its dtype range")


def _strictly_increasing(values: list[float]) -> list[float]:
    """The values, without any that does not exceed the one kept before it."""
    kept: list[float] = []
    for value in values:
        if not kept or value > kept[-1]:
            kept.append(value)
    return kept
