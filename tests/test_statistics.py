"""Exact area-weighted means, shares and quantiles for chart blocks."""
import json

import numpy as np
import pytest

from soe.areas import AreaError
from soe.statistics import AreaSeriesAccumulator, weighted_distribution, weighted_step

FIRST_VALUE = 0.123456789
SECOND_VALUE = 10.987654321


def test_weighted_mean_matches_hand_computed_fraction():
    values = np.array([[FIRST_VALUE, SECOND_VALUE]])
    weights = np.array([[1.0, 3.0]])

    mean, valid_fraction, fallback = weighted_step(values, weights)

    expected = (FIRST_VALUE + 3 * SECOND_VALUE) / 4
    assert mean == expected
    assert mean != round(expected, 2)
    assert valid_fraction == 1.0
    assert fallback is None


def test_two_cell_distribution_carries_exact_shape_and_median():
    values = np.array([[FIRST_VALUE, SECOND_VALUE]])
    weights = np.array([[1.0, 3.0]])

    block = weighted_distribution(values, weights)

    assert block["statistic"] == "quantiles"
    assert block["weights"] == "cell_area_inside_outline"
    assert block["percent"] == 1
    assert len(block["values"]) == 101
    assert block["values"][50] == SECOND_VALUE
    assert block["values"][0] == FIRST_VALUE
    assert block["values"][-1] == SECOND_VALUE
    assert block["min"] == FIRST_VALUE
    assert block["max"] == SECOND_VALUE
    assert block["mean"] == (FIRST_VALUE + 3 * SECOND_VALUE) / 4
    assert block["valid_fraction"] == 1.0
    assert block["reference_values"] == []


def test_tied_values_combine_their_weights():
    values = np.array([[2.0, 1.0, 1.0, 3.0]])
    weights = np.ones((1, 4))

    block = weighted_distribution(values, weights)

    assert block["values"][50] == 1.0
    assert block["values"][25] == 1.0
    assert block["values"][75] == 2.0
    ordered = block["values"]
    assert all(later >= earlier for earlier, later in zip(ordered, ordered[1:]))


def test_negative_and_fractional_values_reduce_exactly():
    values = np.array([[-2.5, 0.5, 3.25]])
    weights = np.ones((1, 3))

    mean, valid_fraction, _ = weighted_step(values, weights)
    block = weighted_distribution(values, weights)

    assert mean == (-2.5 + 0.5 + 3.25) / 3
    assert valid_fraction == 1.0
    assert block["min"] == -2.5
    assert block["max"] == 3.25
    assert block["mean"] == mean
    assert block["values"][50] == 0.5


def test_constant_grid_gives_flat_quantiles():
    values = np.full((2, 2), 7.5)
    weights = np.array([[1.0, 2.0], [3.0, 4.0]])

    block = weighted_distribution(values, weights)

    assert block["min"] == 7.5
    assert block["max"] == 7.5
    assert block["mean"] == 7.5
    assert block["values"] == [7.5] * 101


def test_missing_values_are_excluded_from_mean_and_shares():
    values = np.array([[1.0, np.nan], [3.0, 4.0]])
    weights = np.array([[1.0, 2.0], [3.0, 4.0]])
    filled = np.array([[False, False], [True, False]])

    mean, valid_fraction, fallback_fraction = weighted_step(values, weights, filled)

    assert mean == (1.0 + 9.0 + 16.0) / 8
    assert valid_fraction == 0.8
    assert fallback_fraction == 0.3

    infinite = np.array([[1.0, np.inf], [3.0, 4.0]])
    mean, valid_fraction, _ = weighted_step(infinite, weights)

    assert mean == (1.0 + 9.0 + 16.0) / 8
    assert valid_fraction == 0.8

    block = weighted_distribution(values, weights)

    assert block["valid_fraction"] == 0.8
    assert block["min"] == 1.0
    assert block["max"] == 4.0
    assert block["mean"] == mean


def test_all_missing_step_yields_null_while_neighbours_keep_values():
    weights = np.ones((1, 2))
    accumulator = AreaSeriesAccumulator(weights, has_fallback=True)
    accumulator.add(np.full((1, 1, 2), np.nan), np.zeros((1, 1, 2), bool))
    accumulator.add(np.array([[[1.0, 3.0]]]), np.zeros((1, 1, 2), bool))

    block = accumulator.finish()

    assert block["statistic"] == "mean"
    assert block["weights"] == "cell_area_inside_outline"
    assert block["values"] == [None, 2.0]
    assert block["valid_fraction"] == [0.0, 1.0]
    assert block["fallback_fraction"] == [0.0, 0.0]


def test_zero_weight_cells_ignore_extreme_values():
    weights = np.array([[2.0, 0.0]])

    mean, valid_fraction, _ = weighted_step(np.array([[5.0, np.inf]]), weights)

    assert mean == 5.0
    assert valid_fraction == 1.0

    mean, _, _ = weighted_step(np.array([[5.0, 1e300]]), weights)

    assert mean == 5.0

    block = weighted_distribution(np.array([[5.0, np.nan]]), weights)

    assert block["mean"] == 5.0
    assert block["values"] == [5.0] * 101
    assert block["valid_fraction"] == 1.0


def test_distribution_ignores_finite_zero_weight_ring_cells():
    values = np.array([[-2.5, 3.25, -1e9, 1e9]])
    weights = np.array([[1.0, 3.0, 0.0, 0.0]])

    block = weighted_distribution(values, weights)

    assert block["min"] == -2.5
    assert block["max"] == 3.25
    assert block["mean"] == 1.8125
    assert block["valid_fraction"] == 1.0
    assert block["values"] == [-2.5] * 26 + [3.25] * 75


def test_zero_total_weight_raises_area_error():
    weights = np.zeros((1, 2))
    values = np.ones((1, 2))

    with pytest.raises(AreaError):
        weighted_step(values, weights)
    with pytest.raises(AreaError):
        AreaSeriesAccumulator(weights)
    with pytest.raises(AreaError):
        weighted_distribution(values, weights)


def test_empty_samples_raise_for_distribution_but_not_for_a_step():
    values = np.full((1, 2), np.nan)
    weights = np.ones((1, 2))

    with pytest.raises(AreaError):
        weighted_distribution(values, weights)

    mean, valid_fraction, fallback = weighted_step(values, weights, np.ones((1, 2), bool))

    assert mean is None
    assert valid_fraction == 0.0
    assert fallback == 0.0


def test_fallback_share_appears_only_when_configured():
    weights = np.ones((1, 2))
    values = np.array([[[1.0, 3.0]]])

    plain = AreaSeriesAccumulator(weights)
    plain.add(values)

    assert "fallback_fraction" not in plain.finish()

    configured = AreaSeriesAccumulator(weights, has_fallback=True)
    configured.add(values)

    assert configured.finish()["fallback_fraction"] == [0.0]

    stepped = np.array([[2.0, 4.0]])
    filled = np.array([[True, False]])
    with_fallback, _, share = weighted_step(stepped, weights, filled)
    without_fallback, _, _ = weighted_step(stepped, weights)

    assert with_fallback == without_fallback == 3.0
    assert share == 0.5


def test_batch_splits_give_identical_series():
    generator = np.random.default_rng(7)
    weights = generator.uniform(0.1, 1.0, size=(3, 4))
    values = generator.normal(10.0, 5.0, size=(5, 3, 4))
    values[2, 0, 0] = np.nan
    filled = generator.uniform(size=(5, 3, 4)) < 0.2

    whole = AreaSeriesAccumulator(weights, has_fallback=True)
    whole.add(values, filled)

    split = AreaSeriesAccumulator(weights, has_fallback=True)
    split.add(values[:2], filled[:2])
    split.add(values[2:], filled[2:])

    assert split.finish() == whole.finish()


def test_accumulator_reports_hand_computed_fallback_shares():
    weights = np.array([[1.0, 3.0, 0.0]])
    values = np.array([[[10.0, 20.0, -1e9]], [[np.nan, 6.0, 999.0]], [[4.0, 8.0, 5.0]]])
    filled = np.array([[[True, False, True]], [[True, True, False]], [[False, False, True]]])
    accumulator = AreaSeriesAccumulator(weights, has_fallback=True)
    accumulator.add(values, filled)

    block = accumulator.finish()

    assert block["values"] == [17.5, 6.0, 7.0]
    assert block["valid_fraction"] == [1.0, 0.75, 1.0]
    assert block["fallback_fraction"] == [0.25, 0.75, 0.0]


def test_blocks_survive_json_round_trip():
    weights = np.array([[1.0, 3.0]])
    accumulator = AreaSeriesAccumulator(weights, has_fallback=True)
    accumulator.add(np.full((1, 1, 2), np.nan), np.zeros((1, 1, 2), bool))
    accumulator.add(np.array([[[FIRST_VALUE, SECOND_VALUE]]]), np.zeros((1, 1, 2), bool))
    series = accumulator.finish()

    assert json.loads(json.dumps(series)) == series
    assert series["values"][1] != round(series["values"][1], 2)

    references = [{"id": "sea_level", "value": 0}]
    block = weighted_distribution(
        np.array([[FIRST_VALUE, SECOND_VALUE]]),
        weights,
        references,
    )

    assert json.loads(json.dumps(block)) == block
    assert block["reference_values"] == references
