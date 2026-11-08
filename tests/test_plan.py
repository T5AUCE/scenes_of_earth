"""Test that planning stores per-layer geometry and area weights, with a zero-area guard."""
import math
from dataclasses import replace

import numpy as np
import pytest
import shapely
from shapely.geometry import MultiPolygon, Polygon, box

from soe.area_weights import area_weights
from soe.areas import Area, AreaError, unwrap
from soe.plan import plan, scene_datasets
from soe.sources import SyntheticSource, make_registry
from tests.helpers import FIJI, LAND_COVER, NAIROBI, RAIN, TERRAIN, harmonic_island, plan_months


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


def test_area_crossing_60_north_keeps_its_outline_and_each_layer_its_own_coverage():
    crossing = box(36.0, 58.0, 38.0, 62.0)

    scene_plan = plan_months(Area(crossing), [RAIN, TERRAIN], 1)
    rain, terrain = scene_plan.layers["chirps_monthly"], scene_plan.layers["terrain"]

    assert scene_plan.geometry.equals(crossing)
    assert scene_plan.clipped
    assert rain.bbox[3] == 60 and rain.geometry.equals(box(36.0, 58.0, 38.0, 60.0))
    assert terrain.bbox[3] >= 62 and terrain.geometry.equals(crossing)
    assert any("outside Rainfall coverage" in note for note in rain.notices)
    assert terrain.notices == []
    assert terrain.coverage[3] == 84
    assert scene_plan.bbox[3] == terrain.bbox[3]


def test_area_wholly_beyond_the_rain_cube_is_refused_for_rain_only():
    arctic = box(36.0, 70.0, 38.0, 72.0)

    with pytest.raises(AreaError, match="outside Rainfall coverage"):
        plan_months(Area(arctic), [RAIN, TERRAIN], 1)

    assert plan_months(Area(arctic), [TERRAIN], 1).layers["terrain"].bbox[3] >= 72


def test_area_beyond_84_north_is_outside_every_layer():
    with pytest.raises(AreaError, match="outside Terrain coverage"):
        plan_months(Area(box(36.0, 85.0, 38.0, 86.0)), [TERRAIN], 1)


def test_area_just_below_60_north_keeps_its_windows_below_60():
    edge = box(36.0, 59.0, 37.0, 59.9999)

    scene_plan = plan_months(Area(edge), [RAIN, TERRAIN, LAND_COVER], 1)

    assert scene_plan.bbox[3] == 60
    assert scene_plan.geometry.equals(edge)


def test_area_crossing_60_north_reads_beyond_60_for_terrain_and_land_cover():
    crossing = box(36.0, 59.0, 37.0, 60.5)

    scene_plan = plan_months(Area(crossing), [TERRAIN, LAND_COVER], 1)

    assert scene_plan.layers["terrain"].bbox[3] > 60
    assert scene_plan.layers["esa_worldcover"].bbox[3] > 60


TWO_ISLANDS = MultiPolygon(
    [
        box(36.5, -1.5, 37.5, -0.5),
        box(42.6, 10.8, 43.8, 11.9),
    ],
)


def test_tile_cap_counts_only_tiles_the_outline_touches():
    area = Area(TWO_ISLANDS)

    scene_plan = plan(area, [TERRAIN, LAND_COVER], None, None)
    terrain_layer = scene_plan.layers["terrain"]
    cover_layer = scene_plan.layers["esa_worldcover"]

    assert TERRAIN.tile_count(terrain_layer.bbox) > TERRAIN.tile_count(
        terrain_layer.bbox,
        terrain_layer.geometry,
    )
    assert LAND_COVER.tile_count(cover_layer.bbox) > LAND_COVER.tile_count(
        cover_layer.bbox,
        cover_layer.geometry,
    )


def test_tile_cap_passes_when_only_touched_tiles_fit_and_fails_on_them():
    area = Area(TWO_ISLANDS)

    assert plan(area, [replace(TERRAIN, max_tiles=10)], None, None)
    with pytest.raises(AreaError, match="needs more than 7 source tiles"):
        plan(area, [replace(TERRAIN, max_tiles=7)], None, None)

    assert plan(area, [replace(LAND_COVER, max_tiles=2)], None, None)
    with pytest.raises(AreaError, match="needs more than 1 source tiles"):
        plan(area, [replace(LAND_COVER, max_tiles=1)], None, None)


def test_layer_credits_follow_the_bbox_when_the_outline_touches_fewer_tiles():
    outline = box(42.3, 39.3, 43.0, 39.7).union(box(42.3, 39.3, 42.7, 40.2))

    layer = plan(Area(outline), [TERRAIN], None, None).layers["terrain"]

    assert TERRAIN.tile_count(layer.bbox, layer.geometry) < TERRAIN.tile_count(layer.bbox)
    assert [source["name"] for source in layer.sources] == [
        "Copernicus DEM GLO-30 Public",
        "Copernicus DEM GLO-90",
    ]
    assert layer.sources == TERRAIN.sources_for(layer.bbox)


def test_plan_keeps_edge_only_contact_across_outline_sizes():
    inside = box(36.0, 58.0, 37.0, 59.0)
    touching = box(38.0, 60.0, 39.0, 61.0)
    small = MultiPolygon([inside, touching])
    large = shapely.segmentize(small, 0.005)

    small_layer = plan_months(Area(small), [RAIN], 1).layers["chirps_monthly"]
    large_layer = plan_months(Area(large), [RAIN], 1).layers["chirps_monthly"]

    assert small_layer.geometry.bounds == pytest.approx((36.0, 58.0, 39.0, 60.0))
    assert small_layer.transform == large_layer.transform
    assert small_layer.shape == large_layer.shape
    assert small_layer.bbox == large_layer.bbox
    np.testing.assert_array_equal(small_layer.mask, large_layer.mask)
    np.testing.assert_allclose(
        small_layer.area_weights,
        large_layer.area_weights,
        rtol=1e-12,
        atol=0.0,
    )
    assert small_layer.sources == large_layer.sources
    assert small_layer.geometry.equals(large_layer.geometry)


def test_plan_keeps_hole_crossing_coverage_edge_across_outline_sizes():
    outer = box(36.0, 58.0, 38.0, 62.0)
    hole = box(36.5, 59.5, 37.5, 60.5)
    small = Polygon(outer.exterior.coords, [hole.exterior.coords])
    large = shapely.segmentize(small, 0.005)

    small_layer = plan_months(Area(small), [RAIN], 1).layers["chirps_monthly"]
    large_layer = plan_months(Area(large), [RAIN], 1).layers["chirps_monthly"]

    assert small_layer.transform == large_layer.transform
    assert small_layer.shape == large_layer.shape
    assert small_layer.bbox == large_layer.bbox
    np.testing.assert_array_equal(small_layer.mask, large_layer.mask)
    np.testing.assert_allclose(
        small_layer.area_weights,
        large_layer.area_weights,
        rtol=1e-12,
        atol=0.0,
    )
    assert small_layer.sources == large_layer.sources
    assert small_layer.geometry.equals(large_layer.geometry)


def test_plan_keeps_touching_parts_across_outline_sizes():
    lower = box(36.0, 58.0, 37.0, 60.0)
    upper = box(37.0, 60.0, 38.0, 62.0)
    small = MultiPolygon([lower, upper])
    large = shapely.segmentize(small, 0.005)

    small_layer = plan_months(Area(small), [RAIN], 1).layers["chirps_monthly"]
    large_layer = plan_months(Area(large), [RAIN], 1).layers["chirps_monthly"]

    assert small_layer.geometry.bounds == pytest.approx((36.0, 58.0, 38.0, 60.0))
    assert small_layer.transform == large_layer.transform
    assert small_layer.shape == large_layer.shape
    assert small_layer.bbox == large_layer.bbox
    np.testing.assert_array_equal(small_layer.mask, large_layer.mask)
    np.testing.assert_allclose(
        small_layer.area_weights,
        large_layer.area_weights,
        rtol=1e-12,
        atol=0.0,
    )
    assert small_layer.sources == large_layer.sources
    assert small_layer.geometry.equals(large_layer.geometry)


def test_scene_datasets_decide_beyond_60_north_by_the_area_outline():
    class Marked(type(RAIN)):
        def for_scene(self, beyond_legacy_extent):
            return replace(self, title=f"beyond={beyond_legacy_extent}")

    marked = Marked(**vars(RAIN))

    inside = scene_datasets(Area(box(10, 50, 11, 60)), [marked])
    beyond = scene_datasets(Area(box(10, 59, 11, 61)), [marked])

    assert [dataset.title for dataset in inside] == ["beyond=False"]
    assert [dataset.title for dataset in beyond] == ["beyond=True"]
    assert scene_datasets(Area(NAIROBI), [RAIN]) == [RAIN]
