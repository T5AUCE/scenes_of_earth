"""Test fractional geometry weights on the layer grid, with cosine latitude scaling."""
import math
import time

import numpy as np
import pytest
from rasterio.transform import Affine
from shapely.geometry import MultiPolygon, Polygon, box

from soe.area_weights import area_weights

RES_DEG = 1.0  # cell size of the synthetic grids below


def test_half_cell_outline_gives_fraction_one_half():
    transform, shape, mask = _single_cell()

    weights = area_weights(box(0.0, -0.5, 0.5, 0.5), transform, shape, mask)

    assert weights.shape == (1, 1)
    assert weights.dtype == np.float64
    assert weights[0, 0] == pytest.approx(0.5)


def _single_cell(north_deg: float = 0.5, west_deg: float = 0.0) -> tuple[
    Affine,
    tuple[int, int],
    np.ndarray,
]:
    """Return transform, shape and all-inside mask of one cell with the given top edge."""
    transform = Affine(RES_DEG, 0.0, west_deg, 0.0, -RES_DEG, north_deg)
    shape = (1, 1)
    mask = np.ones(shape, dtype="uint8")
    return transform, shape, mask


def test_quarter_cell_outline_gives_fraction_one_quarter():
    transform, shape, mask = _single_cell()

    weights = area_weights(box(0.0, 0.0, 0.5, 0.5), transform, shape, mask)

    assert weights[0, 0] == pytest.approx(0.25)


def test_tiny_island_away_from_centre_keeps_positive_weight():
    transform, shape, mask = _single_cell(north_deg=60.5)

    weights = area_weights(box(0.05, 60.25, 0.15, 60.35), transform, shape, mask)

    expected = 0.01 * math.cos(math.radians(60.0))
    assert weights[0, 0] == pytest.approx(expected, abs=1e-9)


def test_untouched_inside_cells_keep_fraction_one():
    transform = Affine(RES_DEG, 0.0, 0.0, 0.0, -RES_DEG, 0.5)
    shape = (1, 3)
    mask = np.ones(shape, dtype="uint8")

    weights = area_weights(box(0.0, -0.5, 2.5, 0.5), transform, shape, mask)

    assert weights[0].tolist() == pytest.approx([1.0, 1.0, 0.5])


def test_hole_subtracts_its_overlap():
    transform, shape, mask = _single_cell()
    shell = box(0.0, -0.5, 1.0, 0.5)
    holed = Polygon(shell.exterior.coords, [box(0.25, -0.25, 0.75, 0.25).exterior.coords])

    assert holed.is_valid

    full = area_weights(shell, transform, shape, mask)
    weights = area_weights(holed, transform, shape, mask)

    assert full[0, 0] == pytest.approx(1.0)
    assert weights[0, 0] == pytest.approx(0.75)


def test_edge_contact_contributes_zero():
    transform, shape, mask = _single_cell()

    edge = area_weights(box(1.0, -0.5, 2.0, 0.5), transform, shape, mask)
    corner = area_weights(box(1.0, 0.5, 2.0, 1.5), transform, shape, mask)

    assert edge[0, 0] == pytest.approx(0.0)
    assert corner[0, 0] == pytest.approx(0.0)


def test_weights_follow_cosine_of_row_centre_latitude():
    equatorial_transform, equatorial_shape, equatorial_mask = _single_cell(north_deg=0.5)
    high_transform, high_shape, high_mask = _single_cell(north_deg=60.5)
    equatorial_half = box(0.0, -0.5, 0.5, 0.5)
    high_half = box(0.0, 59.5, 0.5, 60.5)

    equatorial = area_weights(
        equatorial_half,
        equatorial_transform,
        equatorial_shape,
        equatorial_mask,
    )
    high = area_weights(
        high_half,
        high_transform,
        high_shape,
        high_mask,
    )

    assert equatorial[0, 0] == pytest.approx(0.5 * math.cos(math.radians(0.0)))
    assert high[0, 0] == pytest.approx(0.5 * math.cos(math.radians(60.0)))


def test_antimeridian_and_unwrapped_geometries_agree():
    transform = Affine(RES_DEG, 0.0, 179.0, 0.0, -RES_DEG, 1.0)
    shape = (1, 2)
    mask = np.ones(shape, dtype="uint8")
    merged = box(179.25, 0.25, 180.75, 0.75)
    split = MultiPolygon(
        [box(179.25, 0.25, 180.0, 0.75), box(180.0, 0.25, 180.75, 0.75)],
    )

    merged_weights = area_weights(merged, transform, shape, mask)
    split_weights = area_weights(split, transform, shape, mask)

    np.testing.assert_allclose(merged_weights, split_weights, rtol=1e-12)


def test_ring_cells_have_zero_weight():
    transform = Affine(RES_DEG, 0.0, 0.0, 0.0, -RES_DEG, 0.5)
    shape = (1, 2)
    mask = np.array([[1, 2]], dtype="uint8")

    weights = area_weights(box(0.0, -0.5, 2.0, 0.5), transform, shape, mask)

    assert weights[0, 0] == pytest.approx(1.0)
    assert weights[0, 1] == pytest.approx(0.0)


def test_coarsened_factor_grid_keeps_fractions():
    transform = Affine(0.1, 0.0, 0.0, 0.0, -0.1, 0.05)
    shape = (1, 1)
    mask = np.ones(shape, dtype="uint8")

    weights = area_weights(box(0.0, -0.05, 0.05, 0.05), transform, shape, mask)

    assert weights.dtype == np.float64
    assert weights[0, 0] == pytest.approx(0.5)


def test_disjoint_geometry_gives_zero_weights():
    transform, shape, mask = _single_cell()

    weights = area_weights(box(5.0, -0.5, 6.0, 0.5), transform, shape, mask)

    assert weights.sum() == pytest.approx(0.0)


def test_equal_area_islands_weigh_equally_so_their_mean_is_exact():
    square = box(36.9901, -1.0101, 36.9941, -1.0061)
    triangle = Polygon(
        [(37.1901, -1.0101), (37.1981, -1.0101), (37.1901, -1.0061)],
    )
    transform = Affine(0.05, 0.0, 36.95, 0.0, -0.05, -0.95)
    shape = (3, 6)
    mask = np.ones(shape, dtype="uint8")

    square_weights = area_weights(square, transform, shape, mask)
    triangle_weights = area_weights(triangle, transform, shape, mask)
    mean = 100 * triangle_weights.sum() / (square_weights.sum() + triangle_weights.sum())

    assert square_weights.sum() == pytest.approx(triangle_weights.sum(), rel=1e-9)
    assert mean == pytest.approx(50.0, abs=1e-9)


def test_many_vertex_outline_weights_run_under_a_time_budget():
    island = _harmonic_island(200000, west=-20.0, south=-16.0, radius=15.0)
    transform = Affine(0.05, 0.0, -20.0, 0.0, -0.05, 20.0)
    shape = (800, 800)
    mask = np.ones(shape, dtype="uint8")

    started = time.monotonic()
    weights = area_weights(island, transform, shape, mask)
    elapsed = time.monotonic() - started

    assert weights.sum() > 0
    assert elapsed < 10


def _harmonic_island(
    vertex_count: int,
    west: float = 35.4,
    south: float = -2.1,
    radius: float = 1.0,
) -> Polygon:
    """An island with harmonic wiggles, standing in for a detailed country outline."""
    points = []
    for index in range(vertex_count):
        angle = 2 * math.pi * index / vertex_count
        wave = (
            1.0
            + 0.05 * math.sin(37 * angle)
            + 0.02 * math.sin(113 * angle + 1.0)
            + 0.008 * math.sin(331 * angle + 2.0)
        )
        points.append(
            (
                west + radius + radius * wave * math.cos(angle),
                south + radius + radius * wave * math.sin(angle),
            ),
        )
    return Polygon(points)
