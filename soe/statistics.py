"""Area-weighted means and quantiles for chart blocks, without rounding.

Each weight pairs a cell with its outlined physical area on the layer grid, so
chart blocks describe that area exactly. Later steps feed raw decoded values
here before packing, so packed integers never shape the means.
"""
import numpy as np

from .areas import AreaError

WEIGHTS_NAME = "cell_area_inside_outline"

STATISTIC_MEAN = "mean"
STATISTIC_QUANTILES = "quantiles"

QUANTILE_COUNT = 101
QUANTILE_PERCENT = 1


def weighted_step(
    values: np.ndarray,
    weights: np.ndarray,
    filled: np.ndarray | None = None,
) -> tuple[float | None, float, float | None]:
    """Return the weighted mean and area shares of one grid step.

    Missing values and zero-weight cells never contribute, while fallback-filled
    cells stay included in the mean. The tuple holds the mean with None when
    nothing is valid, then the valid share and then the fallback share with None
    when no fallback mask was given.
    """
    checked_weights, total = _checked_weights(weights)
    return _step_shares(values, checked_weights, filled, total)


class AreaSeriesAccumulator:
    """Feed time steps in order and finish with the exact area_series block."""

    def __init__(self, weights: np.ndarray, has_fallback: bool = False) -> None:
        """Remember the grid weights and whether a fallback share is configured."""
        checked_weights, total = _checked_weights(weights)
        self._weights = checked_weights
        self._total = total
        self._has_fallback = bool(has_fallback)
        self._means: list[float | None] = []
        self._valid: list[float] = []
        self._fallback: list[float] = []

    def add(
        self,
        values: np.ndarray,
        filled: np.ndarray | None = None,
    ) -> None:
        """Append one batch of time steps, keeping their arrival order."""
        steps = np.asanyarray(values, dtype="float64")
        if steps.ndim != 3 or steps.shape[1:] != self._weights.shape:
            raise ValueError("expected values shaped (time, height, width)")
        falls: np.ndarray | None = None
        if filled is not None:
            falls = np.asanyarray(filled, dtype=bool)
            if falls.shape != steps.shape:
                raise ValueError("expected filled shaped like values")
        for index in range(steps.shape[0]):
            wanted = None if falls is None else falls[index]
            mean, valid_fraction, fallback_fraction = _step_shares(
                steps[index],
                self._weights,
                wanted if self._has_fallback else None,
                self._total,
            )
            self._means.append(mean)
            self._valid.append(valid_fraction)
            if self._has_fallback:
                self._fallback.append(0.0 if fallback_fraction is None else fallback_fraction)

    def finish(self) -> dict[str, object]:
        """Return the area_series block with one entry per fed step."""
        block: dict[str, object] = {
            "statistic": STATISTIC_MEAN,
            "weights": WEIGHTS_NAME,
            "values": list(self._means),
            "valid_fraction": list(self._valid),
        }
        if self._has_fallback:
            block["fallback_fraction"] = list(self._fallback)
        return block


def weighted_distribution(
    values: np.ndarray,
    weights: np.ndarray,
    reference_values: list[dict] | None = None,
) -> dict[str, object]:
    """Return the weighted distribution block of one grid, with exact extrema and mean.

    The quantiles follow the inverse empirical curve, so each entry is the first
    sorted value whose combined weight reaches its share of valid area. Reference
    markers ride along unchanged and never enter the samples.
    """
    checked_weights, total = _checked_weights(weights)
    grid = np.asanyarray(values, dtype="float64")
    if grid.shape != checked_weights.shape:
        raise ValueError("expected values shaped like weights")
    valid = np.isfinite(grid) & (checked_weights > 0)
    valid_weight = float(np.sum(checked_weights[valid], dtype="float64"))
    if valid_weight == 0:
        raise AreaError("area has no valid values, so no distribution exists")
    samples = grid[valid]
    sample_weights = checked_weights[valid]
    minimum = float(np.min(samples))
    maximum = float(np.max(samples))
    mean = float(np.sum(samples * sample_weights, dtype="float64")) / valid_weight
    unique_values, summed_weights = _combined_weights(samples, sample_weights)
    cumulative = np.cumsum(summed_weights, dtype="float64")
    shares = np.arange(QUANTILE_COUNT, dtype="float64") / (QUANTILE_COUNT - 1)
    thresholds = shares * valid_weight
    indices = np.searchsorted(cumulative, thresholds, side="left")
    indices = np.clip(indices, 0, unique_values.size - 1)
    quantiles = [float(unique_values[index]) for index in indices]
    # Pinning guards a last-ulp threshold overshoot, so the endpoints stay exact.
    quantiles[0] = minimum
    quantiles[-1] = maximum
    return {
        "statistic": STATISTIC_QUANTILES,
        "weights": WEIGHTS_NAME,
        "percent": QUANTILE_PERCENT,
        "values": quantiles,
        "min": minimum,
        "max": maximum,
        "mean": mean,
        "valid_fraction": valid_weight / total,
        "reference_values": list(reference_values) if reference_values is not None else [],
    }


def _checked_weights(weights: np.ndarray) -> tuple[np.ndarray, float]:
    """Return float64 weights with their total, rejecting an empty outline."""
    checked = np.asanyarray(weights, dtype="float64")
    total = float(np.sum(checked, dtype="float64"))
    if not np.isfinite(total) or total <= 0:
        raise AreaError("area has no positive weight, so statistics are undefined")
    return checked, total


def _step_shares(
    step: np.ndarray,
    weights: np.ndarray,
    filled: np.ndarray | None,
    total: float,
) -> tuple[float | None, float, float | None]:
    """Return one step's mean with its valid and fallback shares of outlined area."""
    grid = np.asanyarray(step, dtype="float64")
    if grid.shape != weights.shape:
        raise ValueError("expected values shaped like weights")
    mask: np.ndarray | None = None
    if filled is not None:
        mask = np.asanyarray(filled, dtype=bool)
        if mask.shape != grid.shape:
            raise ValueError("expected filled shaped like values")
    valid = np.isfinite(grid) & (weights > 0)
    valid_weight = float(np.sum(weights[valid], dtype="float64"))
    if valid_weight == 0:
        return None, 0.0, 0.0 if mask is not None else None
    weighted_sum = float(np.sum(grid[valid] * weights[valid], dtype="float64"))
    mean = weighted_sum / valid_weight
    if mask is None:
        return mean, valid_weight / total, None
    fallback_weight = float(np.sum(weights[valid & mask], dtype="float64"))
    return mean, valid_weight / total, fallback_weight / total


def _combined_weights(
    samples: np.ndarray,
    sample_weights: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Return sorted unique values with their summed weights, keeping runs deterministic."""
    order = np.argsort(samples, kind="stable")
    ordered_values = samples[order]
    ordered_weights = sample_weights[order]
    unique_values, inverse = np.unique(ordered_values, return_inverse=True)
    summed = np.bincount(inverse, weights=ordered_weights)
    return unique_values, summed
