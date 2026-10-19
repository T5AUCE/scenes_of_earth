"""Define the dataset contract that readers implement, with its roles and the registry type."""
import hashlib
import math
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import ClassVar, NamedTuple

import numpy as np
from rasterio.transform import Affine

from .cubes import CubeSpec
from .fallback import read_nearest
from .grid import Bbox, Grid, block_mean
from .periods import MONTH_CHARS, add_duration

Registry = dict[str, "Dataset"]  # dataset id -> dataset

SUPPORTED_BOUNDS_DEG = (-180, -60, 180, 60)  # W, S, E, N; supported v1 extent

STOP_COUNT = 9  # colour stops of a series layer, one per palette colour
STOP_DIGITS = 2  # significant digits of the stops span that a stop keeps
TOP_PERCENTILE = 98  # the last stop; values above it share the top colour

REVISION_HEX_CHARS = 12
FROM_MAIN = 1  # bit of a cell's code in the `source` array; both bits set make 3
FROM_FALLBACK = 2


class Role(NamedTuple):
    """One data array of a layer, with how it is stored and how the viewer decodes it."""

    name: str  # array name inside the Zarr group of the layer
    dtype: str  # stored dtype
    scale: float = 1  # decoded = stored * scale + offset
    offset: float = 0
    fill: int | None = None  # stored value that means "no data"
    units: str = ""  # CF attributes of the array; omitted when empty
    long_name: str = ""


class Fallback(NamedTuple):
    """Describe a secondary source that fills missing values in a series layer."""

    cube: CubeSpec
    source: dict  # licence and attribution, as for the main source
    notice: str  # with {filled} and {inside}, the cells filled and the cells inside the area


class FilledStep(NamedTuple):
    """Pair the values for one step with flags identifying fallback-filled cells."""

    values: np.ndarray
    filled: np.ndarray | None  # True where the fallback gave the value; None without a fallback


SOURCE_ROLE = Role(
    "source",
    "uint8",
    fill=0,
    long_name="Source of the values: 1 main, 2 fallback, 3 both; 0 outside the area or none",
)


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
    roles: dict[str, Role]  # by role, e.g. value; a layer drawn from tiles has none
    style: dict  # viewer defaults
    backend: object
    grid: Grid  # the layer's window is cut on this grid
    coverage: tuple = SUPPORTED_BOUNDS_DEG  # W, S, E, N; a narrower dataset overrides it
    step: str | None = None  # ISO 8601 duration between time steps; None for static layers
    cell_method: str | None = None  # how a step summarises its period: sum, mean, point or max
    max_tiles: int | None = None  # request cap for tiled datasets
    needs_tiles: bool = False  # a bbox without source tiles has no data, so the request is refused
    synthetic: bool = False  # offline stand-in data, kept apart from real revisions
    remote: bool = True  # has a remote revision, which scene preparation caches
    fallback: Fallback | None = None  # series layers only
    tiles: dict | None = None  # where the viewer gets display tiles: url, encoding, source, ...

    def __post_init__(self) -> None:
        """Runs after construction; subclasses check their invariants here."""

    def tile_count(self, bbox: Bbox) -> int:
        """Number of source tiles a read of bbox needs (0 for untiled data)."""
        return 0

    def res_for(self, bbox: Bbox) -> float:
        """Cell size of a static layer over bbox."""
        return self.resolution_deg

    def remote_revision(self, steps: list[str]) -> str | None:
        """Return the revision marker that a remote server gives the period starts `steps`, or None.

        It changes whenever the provider republishes data of any of those periods. Asking costs a
        request, so scene preparation caches it for a while.
        """
        return None

    def local_revision(self, steps: list[str]) -> str | None:
        """Return the revision marker that local files give the period starts `steps`, or None.

        It changes whenever one of those periods is replaced on disk. Asking is cheap, so
        preparation always reads the revision fresh. A build compares it with the value used to
        make its scene ID.
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

    def summary(
        self,
        arrays: dict[str, np.ndarray],
        mask: np.ndarray,
        transform: Affine,
    ) -> dict[str, float]:
        """Return in-area summary statistics, or none for datasets that do not publish them."""
        return {}

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
        """Return the values over bbox at cell size `res` and their transform.

        The values map each role to a 2D array in the stored dtype. `on_block` is called each
        time one of the block_count(bbox) parts has been read.
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

    def read_step_filled(self, step: str, bbox: Bbox, factor: int = 1) -> FilledStep:
        """Read the step like read_step, filling gaps from the fallback where it has values."""
        values = self.read_step(step, bbox, factor)
        if self.fallback is None:
            return FilledStep(values, None)

        gaps = np.isnan(values)
        if not gaps.any():
            return FilledStep(values, gaps)

        fallback_values = self._read_fallback(step, bbox, factor)
        filled = gaps & np.isfinite(fallback_values)
        return FilledStep(np.where(filled, fallback_values, values), filled)

    def _read_fallback(self, step: str, bbox: Bbox, factor: int) -> np.ndarray:
        month = step[:MONTH_CHARS]
        sampled = read_nearest(
            self.grid,
            self.fallback.cube.grid,
            self.grid.window(bbox),
            lambda window: self.backend.read_cube(self.fallback.cube, month, window),
        )
        return block_mean(sampled, factor)

    def fallback_notices(self, steps: list[str], filled: list[bool]) -> list[str]:
        """Return notes on the fallback values a build used; `filled` flags each of `steps`."""
        return []

    def fallback_months(self) -> dict[str, str]:
        """Return the marker of each month of the fallback's cube, oldest first."""
        return self.backend.cube_months(self.fallback.cube)


def revision_digest(*markers: str) -> str:
    """Return a short revision that changes whenever any of the markers does."""
    return hashlib.sha256("|".join(markers).encode()).hexdigest()[:REVISION_HEX_CHARS]


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
