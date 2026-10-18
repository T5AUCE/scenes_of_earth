"""Offline tests: drawn-shape validation, unwrapping across 180 and scene planning."""
from dataclasses import replace

import pytest
from shapely.geometry import LineString, MultiPolygon, Polygon, box, mapping

from soe.areas import Area, AreaError, clean_polygon, unwrap
from soe.bundle import JsonObject
from soe.sources import RealSource, make_registry, terrain_tiles
from tests.helpers import COARSE, FIJI, NAIROBI, RAIN, TERRAIN, plan_months


def poly(x0: float, y0: float, x1: float, y1: float) -> JsonObject:
    """Return a GeoJSON rectangle with the given opposite corners."""
    return mapping(box(x0, y0, x1, y1))


def test_clean_polygon_rules():
    polygon = clean_polygon({"type": "Feature", "geometry": poly(36.5, -1.5, 37.5, -0.5)})
    assert polygon.area == pytest.approx(1.0)

    bowtie = {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]}
    assert clean_polygon(bowtie).area > 0

    bad = [
        {"type": "Point", "coordinates": [0, 0]},
        {"type": "Polygon", "coordinates": [[[0, 0], [200, 0], [200, 1], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [float("nan"), 0], [1, 1], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [2, 2], [0, 0]]]},  # zero area
        {"type": "Polygon", "coordinates": [[[i / 1e4, (i % 7) / 1e4] for i in range(5001)]]},
        "nope",
    ]

    for geometry in bad:
        with pytest.raises(AreaError):
            clean_polygon(geometry)


def test_dedupe_shape_is_canonical():
    jittered = clean_polygon(poly(36.50001, -1.5, 37.5, -0.49999))
    exact = clean_polygon(poly(36.5, -1.5, 37.5, -0.5))

    assert jittered.wkb == exact.wkb


def test_clean_polygon_malformed_inputs():
    malformed_coordinates = (
        [[[0, 0], [10 ** 400, 0], [1, 1], [0, 0]]],
        [[["a", 0], [1, 0], [1, 1], [0, 0]]],
        [[[[[[[0, 0]]]]]]],  # too deeply nested
    )

    for coordinates in malformed_coordinates:
        with pytest.raises(AreaError):
            clean_polygon({"type": "Polygon", "coordinates": coordinates})


def test_unwrap_merges_parts_split_at_180_into_valid_shape():
    split = MultiPolygon([box(179, -1, 180, 1), box(-180, -1, -179, 1)])

    merged = unwrap(split)

    assert split.is_valid and merged.is_valid
    assert merged.geom_type == "Polygon"
    assert merged.bounds == (179, -1, 181, 1)


def test_unwrap_repairs_a_self_intersecting_part_crossing_180():
    bow_tie = Polygon([(179, -1), (181, 1), (181, -1), (179, 1)])
    west_part = box(-180, 2, -179, 3)

    merged = unwrap(MultiPolygon([bow_tie, west_part]))

    assert merged.is_valid
    assert merged.geom_type in ("Polygon", "MultiPolygon")
    assert merged.bounds == (179, -1, 181, 3)


def test_unwrap_rejects_a_shape_with_no_polygon_area():
    line_across_180 = LineString([(179, 0), (-179, 0)])

    with pytest.raises(AreaError, match="empty"):
        unwrap(line_across_180)


def test_unwrap_and_plan_across_180():
    assert unwrap(FIJI).bounds == (178, -19, 182, -17)

    scene_plan = plan_months(Area(FIJI), [RAIN], 2)
    layer_plan = scene_plan.layers["chirps_monthly"]

    assert scene_plan.bbox[2] > 180 and layer_plan.bbox[2] > 180 and layer_plan.mask.sum() > 0


def test_plan_rejections(tmp_path):
    with pytest.raises(AreaError, match="too small"):
        plan_months(Area(box(36.8, -1.1, 36.9, -1.0)), [RAIN])

    wide = box(0, 0, 90, 10).union(box(180, 0, 270, 10)).union(box(90, 0, 91, 1))
    with pytest.raises(AreaError, match="more than 180 degrees"):
        plan_months(Area(wide), [RAIN])

    with pytest.raises(AreaError, match="outside"):
        plan_months(Area(box(0, 62, 5, 70)), [RAIN])

    with pytest.raises(AreaError, match="too large to read"):  # 2M source cells x 240 months > 100M
        plan_months(Area(box(-60, -20, 40, 10)), [RAIN], 240)

    without_cube = make_registry(RealSource(cubes_dir=tmp_path))
    assert without_cube.keys() == {"chirps_monthly", "copdem_terrain"}
    assert len(terrain_tiles((36, -2, 38, 0), "glo90")) == 4

    with pytest.raises(AreaError, match="source tiles"):  # 8190 existing tiles > 2500
        plan_months(Area(box(-100, -50, 70, 60)), [TERRAIN], 1)

    assert plan_months(Area(box(0, 0, 11, 11)), [TERRAIN], 1).bbox == [0, 0, 11, 11]


def test_plan_aggregates_and_snaps():
    # 360k cells x 120 months x 2 B is more than 50 MB.
    scene_plan = plan_months(Area(box(30, -20, 60, 10)), [RAIN], 120)
    layer_plan = scene_plan.layers["chirps_monthly"]
    factor = layer_plan.factor

    assert factor == 2

    west, south, east, north = layer_plan.bbox
    cell = 0.05 * factor
    edges = (west + 180, 60 - north, east + 180, 60 - south)

    assert all(edge / cell == pytest.approx(round(edge / cell)) for edge in edges)
    assert layer_plan.shape == (round((north - south) / 0.1), round((east - west) / 0.1))
    assert layer_plan.transform.a == pytest.approx(cell)
    assert any("averaged" in note for note in layer_plan.notices)
    assert layer_plan.shape[0] * layer_plan.shape[1] * 120 * 2 <= 50_000_000
    assert len(layer_plan.steps) == 120


def test_plan_tiny_named_area_falls_back_to_all_touched():
    tiny = box(36.99, -1.01, 37.0, -1.0)  # sits between cell centres
    scene_plan = plan_months(Area(tiny, {"name": "Tinyville"}), [RAIN])
    layer_plan = scene_plan.layers["chirps_monthly"]

    assert layer_plan.cells_inside >= 1
    assert any("touches" in note for note in layer_plan.notices)
    assert any("padded" in note for note in scene_plan.notices)

    west, south, east, north = scene_plan.bbox

    assert east - west >= 0.5 - 1e-9 and north - south >= 0.5 - 1e-9


def test_plan_gives_each_layer_its_own_grid_and_mask():
    scene_plan = plan_months(Area(NAIROBI), [TERRAIN, RAIN])
    terrain, rain = scene_plan.layers["copdem_terrain"], scene_plan.layers["chirps_monthly"]

    assert terrain.res == pytest.approx(0.05 / 102) and rain.res == pytest.approx(0.05)
    assert terrain.shape == (2040, 2040) and rain.shape == (20, 20)
    assert terrain.mask.shape == terrain.shape and rain.mask.shape == rain.shape
    assert terrain.cells_inside == terrain.mask.sum() and rain.cells_inside == rain.mask.sum()
    assert terrain.factor == 1 and terrain.steps == [] and len(rain.steps) == 12


def test_output_budget_is_summed_across_layers():
    area = Area(box(30, -10, 50, 10))  # 160k rain cells

    assert plan_months(area, [RAIN], 140).layers["chirps_monthly"].factor == 1  # 44.8 MB

    both = plan_months(area, [TERRAIN, RAIN], 140)  # terrain takes 12 MB of the 50

    assert both.layers["chirps_monthly"].factor == 2 and both.layers["copdem_terrain"].factor == 1


def test_each_series_gets_its_own_factor():
    area = Area(box(30, -10, 50, 10))  # 160k rain cells, 40k coarse cells

    layers = plan_months(area, [RAIN, COARSE], 140).layers  # 56 MB at native resolution

    assert (layers["chirps_monthly"].factor, layers["coarse_monthly"].factor) == (2, 1)
    assert layers["chirps_monthly"].res == pytest.approx(layers["coarse_monthly"].res)


def test_finest_series_is_coarsened_first():
    area = Area(box(30, -10, 50, 10))

    layers = plan_months(area, [RAIN, COARSE], 400).layers  # 64 MB even once rain is at 0.1

    assert (layers["chirps_monthly"].res, layers["coarse_monthly"].res) == pytest.approx((0.1, 0.2))


def test_series_that_fit_keep_native_resolution():
    layers = plan_months(Area(NAIROBI), [RAIN, COARSE]).layers

    assert (layers["chirps_monthly"].factor, layers["coarse_monthly"].factor) == (1, 1)
    resolutions = (layers["chirps_monthly"].res, layers["coarse_monthly"].res)

    assert resolutions == pytest.approx((0.05, 0.1))


def test_refuses_when_every_series_is_at_the_resolution_cap(monkeypatch):
    monkeypatch.setattr("soe.plan.MAX_OUTPUT_BYTES", 10_000)

    with pytest.raises(AreaError, match="even at 0.4 degree aggregation"):
        plan_months(Area(box(36, -2, 38, 0)), [RAIN, COARSE], 240)


def test_series_steps_come_from_the_dataset_axis():
    sixteen_day = replace(RAIN, id="ndvi", title="Vegetation", step="P16D")
    sixteen_day.steps = lambda start, end: ["2020-01-01", "2020-01-17", "2020-02-02"]

    scene_plan = plan_months(Area(NAIROBI), [RAIN, sixteen_day], 2)

    assert scene_plan.layers["chirps_monthly"].steps == ["1990-01-01", "1990-02-01"]
    assert scene_plan.layers["ndvi"].steps == ["2020-01-01", "2020-01-17", "2020-02-02"]


def test_static_layers_over_budget_get_their_own_message(monkeypatch):
    monkeypatch.setattr("soe.plan.MAX_OUTPUT_BYTES", 1_000_000)

    with pytest.raises(AreaError, match="static layers alone"):
        plan_months(Area(NAIROBI), [TERRAIN], 1)
