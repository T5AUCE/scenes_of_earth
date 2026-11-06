"""Test that planning stores per-layer geometry and area weights, with a zero-area guard."""
import math

import numpy as np
import pytest
from shapely.geometry import MultiPolygon, box

from soe.area_weights import area_weights
from soe.areas import Area, AreaError, unwrap
from soe.plan import plan
from soe.sources import SyntheticSource, make_registry
from tests.helpers import FIJI, NAIROBI, RAIN, harmonic_island, plan_months


def test_layer_plan_stores_geometry_and_area_weights():
    area = Area(NAIROBI)
    layer = plan_months(area, [RAIN], 2).layers["chirps_monthly"]

    assert layer.geometry.bounds == pytest.approx(area.geom.bounds)
    assert layer.area_weights.shape == layer.mask.shape
    assert layer.area_weights.dtype == np.float64
    assert float(layer.area_weights.sum()) > 0
    assert (layer.area_weights[layer.mask != 1] == 0).all()
    assert float(layer.area_weights[layer.mask == 1].max()) > 0


def test_antimeridian_plan_weights_match_unwrapped_geometry():
    split = plan_months(Area(FIJI), [RAIN], 1).layers["chirps_monthly"]
    merged = plan_months(Area(unwrap(FIJI)), [RAIN], 1).layers["chirps_monthly"]

    assert split.geometry.equals(merged.geometry)
    np.testing.assert_allclose(split.area_weights, merged.area_weights)


def test_coarsened_plan_keeps_valid_weights(monkeypatch):
    monkeypatch.setattr("soe.plan.MAX_OUTPUT_BYTES", 600)
    off_grid = box(36.54, -1.46, 37.46, -0.54)
    layer = plan_months(Area(off_grid), [RAIN], months=1).layers["chirps_monthly"]

    assert layer.factor == 2
    assert layer.area_weights.shape == layer.mask.shape
    assert layer.area_weights.dtype == np.float64
    assert float(layer.area_weights.sum()) > 0
    assert (layer.area_weights[layer.mask != 1] == 0).all()


def test_polygon_touching_coverage_edge_keeps_weights():
    inside = box(36.0, 58.0, 37.0, 59.0)
    touching = box(38.0, 60.0, 39.0, 61.0)
    layer = plan_months(Area(MultiPolygon([inside, touching])), [RAIN], 1).layers["chirps_monthly"]
    members = getattr(layer.geometry, "geoms", [layer.geometry])
    polygons = []
    for member in members:
        if member.geom_type == "Polygon":
            polygons.append(member)
        elif member.geom_type == "MultiPolygon":
            polygons.extend(member.geoms)
    expected = area_weights(MultiPolygon(polygons), layer.transform, layer.shape, layer.mask)
    west = layer.transform.c
    north = layer.transform.f
    step = layer.transform.a
    first = round((38.0 - west) / step)
    last = round((39.0 - west) / step)
    top = round((north - 60.0) / step)

    assert layer.area_weights.shape == layer.mask.shape
    assert float(layer.area_weights.sum()) > 0
    assert (layer.area_weights[layer.mask != 1] == 0).all()
    np.testing.assert_allclose(layer.area_weights, expected, rtol=1e-12, atol=0.0)
    assert (layer.area_weights[top : top + 1, first:last] == 0.0).all()


def test_zero_weights_rejected_before_source_reads(monkeypatch):
    source = SyntheticSource()
    rain = make_registry(source)["chirps_monthly"]
    monkeypatch.setattr(
        "soe.plan.area_weights",
        lambda geometry, transform, shape, mask: np.zeros(shape, dtype="float64"),
    )

    with pytest.raises(AreaError, match="positive overlap"):
        plan(Area(box(36.5, -1.5, 37.5, -0.5)), [rain], "1990-01", "1990-02")

    assert source.reads == 0


def test_plan_weights_match_the_full_outline_exactly():
    island = harmonic_island(2000)

    layer = plan_months(Area(island), [RAIN], 1).layers["chirps_monthly"]
    expected = area_weights(layer.geometry, layer.transform, layer.shape, layer.mask)

    assert layer.geometry.equals(island)
    np.testing.assert_allclose(layer.area_weights, expected, rtol=1e-12, atol=0.0)


def test_plan_keeps_a_sub_tolerance_headland_and_its_cells():
    headland = box(36.6, -0.55, 37.4, -0.5451)
    geometry = box(36.5, -1.5, 37.5, -0.55).union(headland)
    layer = plan_months(Area(geometry), [RAIN], 1).layers["chirps_monthly"]

    for index in range(16):
        column, row = ~layer.transform @ (36.625 + 0.05 * index, -0.5475)
        column, row = int(column), int(row)
        centre = layer.transform.f + (row + 0.5) * layer.transform.e
        fraction = layer.area_weights[row, column] / math.cos(math.radians(centre))

        assert layer.mask[row, column] == 1
        assert fraction == pytest.approx(0.098, abs=1e-9)


def test_plan_accepts_a_tiny_named_area_with_positive_overlap():
    tiny = box(36.9999, -1.0001, 37.0, -1.0)

    layer = plan_months(Area(tiny, {"name": "Tinyville"}), [RAIN], 1).layers["chirps_monthly"]

    assert layer.cells_inside >= 1
    assert float(layer.area_weights.sum()) > 0
