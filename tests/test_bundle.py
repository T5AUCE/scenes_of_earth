"""Test scene.json validation and the credit lines of a bundle."""
import json

import pytest

from soe.areas import Area
from soe.build import build_scene
from soe.bundle import SYNTHETIC_DATA_CREDIT, credits, validate
from soe.sources import SOURCES
from tests.helpers import HASH_A, HASH_B, LAND_COVER, NAIROBI, RAIN, TERRAIN, build_nairobi


def test_validate_catches_missing_attribution(tmp_path):
    build_scene(HASH_B, Area(NAIROBI), "2015-01", "2015-03", [TERRAIN, RAIN], "T", tmp_path)

    doc = json.loads((tmp_path / HASH_B / "scene.json").read_text(encoding="utf-8"))
    doc["layers"][0]["source"]["disclaimer"] = "not in credits.disclaimers"

    assert any("disclaimer" in problem for problem in validate(doc))

    doc["layers"][1]["source"]["attribution"] = ""
    assert any("attribution" in problem for problem in validate(doc))


def test_validate_requires_the_disclaimer_a_source_marks_required(tmp_path):
    build_scene(HASH_B, Area(NAIROBI), "2015-01", "2015-03", [TERRAIN, RAIN], "T", tmp_path)

    doc = json.loads((tmp_path / HASH_B / "scene.json").read_text(encoding="utf-8"))
    del doc["layers"][0]["source"]["disclaimer"]

    assert any("missing disclaimer" in problem for problem in validate(doc))


def test_validate_checks_the_layer_contract(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    terrain, rain = doc["layers"]

    rain["time"]["count"] = 5
    terrain["time"] = {"count": 0, "values": []}
    terrain["mask"]["cells_inside"] = 0
    del rain["grid"]

    problems = validate(doc)

    assert any("time axis" in problem for problem in problems)
    assert any("static layer" in problem for problem in problems)
    assert any("mask.cells_inside" in problem for problem in problems)
    assert any("missing grid" in problem for problem in problems)


def test_bundle_rejects_unsorted_stops_and_missing_encodings(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    terrain, rain = doc["layers"]

    rain["style"]["stops"] = [0, 50, 20]
    del terrain["style"]["encodings"]

    problems = validate(doc)

    assert any("must not decrease" in problem for problem in problems)
    assert any("encodings" in problem for problem in problems)

    rain["style"]["stops"] = [0] * 10

    assert any("2-9 values" in problem for problem in validate(doc))


def test_bundle_rejects_stops_that_are_not_finite_numbers(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    rain = doc["layers"][1]

    for stops in (["a", "b"], [False, True], [0, float("nan")], [0, float("inf")], [0, "b"], 5):
        rain["style"]["stops"] = stops

        assert any("stops" in problem for problem in validate(doc)), stops

    rain["style"]["stops"] = [3, 3]

    assert validate(doc) == []


def test_bundle_rejects_non_text_style_names(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    terrain, rain = doc["layers"]

    terrain["style"]["kind"] = 3
    terrain["style"]["parts"] = ["contours", 1]
    rain["style"]["palette"] = None

    problems = validate(doc)

    assert any("style.kind" in problem for problem in problems)
    assert any("style.parts" in problem for problem in problems)
    assert any("style.palette" in problem for problem in problems)


def test_scene_json_states_the_requested_period(tmp_path):
    doc, store = build_nairobi(tmp_path, ("2015-01", "2016-02"))
    rain = doc["layers"][1]

    assert doc["version"] == "0.6"
    assert doc["period"] == {"start": "2015-01-01", "end": "2016-03-01", "step": "P1M"}
    assert rain["time"]["method"] == "sum"
    assert store["chirps_monthly/precip"].attrs["cell_methods"] == "time: sum"


def test_validate_rejects_a_previous_bundle_format(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))
    doc["version"] = "0.5"

    assert validate(doc, "0.6") == ["version must be 0.6"]


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("path", "another/mask"),
        ("rule", "touched by the area"),
        ("cells_inside", 0),
        ("cells_inside", -1),
        ("cells_inside", 1.5),
        ("cells_inside", True),
        ("cells_inside", "1"),
        ("cells_inside", None),
    ],
)
def test_validate_rejects_an_invalid_mask_block(tmp_path, key, value):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))
    doc["layers"][0]["mask"][key] = value

    assert any(f"mask.{key}" in problem for problem in validate(doc))


@pytest.mark.parametrize("key", ["path", "rule", "cells_inside"])
def test_validate_reports_a_missing_mask_field_without_raising(tmp_path, key):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))
    del doc["layers"][0]["mask"][key]

    assert any(f"mask.{key}" in problem for problem in validate(doc))


def test_static_only_scene_has_no_period(tmp_path):
    build_scene(HASH_B, Area(NAIROBI), None, None, [TERRAIN], "T", tmp_path)

    doc = json.loads((tmp_path / HASH_B / "scene.json").read_text(encoding="utf-8"))

    assert doc["period"] is None and validate(doc) == []

    doc["period"] = {"start": "2015-01-01", "end": "2015-02-01", "step": "P1M"}

    assert any("period must be null" in problem for problem in validate(doc))


def test_time_end_is_the_end_of_the_last_period(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-11", "2015-12"))
    rain = doc["layers"][1]

    assert rain["time"]["values"][-1] == "2015-12-01" and rain["time"]["end"] == "2016-01-01"

    rain["time"]["end"] = "2015-12-01"

    assert any("time.end" in problem for problem in validate(doc))


def test_categorical_layer_without_classes_is_invalid(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    terrain = doc["layers"][0]
    terrain["style"]["kind"] = "categorical"

    assert any("style.classes" in problem for problem in validate(doc))

    terrain["style"]["classes"] = [
        {"value": 10, "label": "Tree cover", "color": "#006400"},
        {"value": 20, "label": "Shrubland", "color": "#ffbb22"},
    ]

    assert validate(doc) == []

    terrain["style"]["classes"][1]["value"] = 10

    assert any("unique" in problem for problem in validate(doc))

    terrain["style"]["classes"][1].update(value=20, color="orange")

    assert any("#rrggbb" in problem for problem in validate(doc))


def test_field_layer_without_stops_is_invalid_even_when_static(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    doc["layers"][0]["style"]["kind"] = "field"

    problems = validate(doc)

    assert any("style.palette" in problem for problem in problems)
    assert any("style.stops" in problem for problem in problems)


def test_credits_of_a_real_mode_sample_boundary_do_not_claim_synthetic_data():
    layer_blocks = [{"source": SOURCES["chirps"]}, {"source": SOURCES["glo90"]}]

    lines = credits(layer_blocks, SOURCES["synthetic"])["lines"]

    assert not any("synthetic" in line.lower() for line in lines)
    assert any("geoBoundaries" in line for line in lines)


def test_credits_announce_synthetic_data_only_for_the_synthetic_source():
    layer_blocks = [{"source": SOURCES["chirps"]}]
    line = SYNTHETIC_DATA_CREDIT

    assert line in credits(layer_blocks, None, synthetic=True)["lines"]
    assert line not in credits(layer_blocks, None)["lines"]


@pytest.mark.parametrize("missing", [("start",), ("end",), ("start", "end")])
def test_period_without_an_endpoint_is_a_problem_not_an_error(tmp_path, missing):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    for key in missing:
        del doc["period"][key]

    assert any("period must have start before end" in problem for problem in validate(doc))


def test_validate_accepts_the_provenance_array_of_a_filled_layer(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    rain = doc["layers"][1]

    assert "source" in rain["arrays"] and rain["fallback_sources"]
    assert validate(doc) == []


@pytest.mark.parametrize(
    ("key", "value"),
    [("dtype", "float64"), ("fill", 255), ("scale_factor", 0.1), ("add_offset", 1)],
)
def test_validate_rejects_a_provenance_array_with_the_wrong_encoding(tmp_path, key, value):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    doc["layers"][1]["arrays"]["source"][key] = value

    assert any(f"arrays.source.{key}" in problem for problem in validate(doc))


def test_validate_rejects_a_provenance_array_without_a_fallback_source(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    del doc["layers"][1]["fallback_sources"]

    assert any("without fallback_sources" in problem for problem in validate(doc))


def test_validate_rejects_a_provenance_array_in_a_static_layer(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    terrain = doc["layers"][0]
    terrain["arrays"]["source"] = dict(doc["layers"][1]["arrays"]["source"])
    terrain["arrays"]["source"]["path"] = f"{terrain['id']}/source"
    terrain["fallback_sources"] = doc["layers"][1]["fallback_sources"]

    assert any("static layer cannot have a source array" in problem for problem in validate(doc))


def test_terrain_layer_without_tiles_is_invalid(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    terrain = doc["layers"][0]

    assert validate(doc) == []

    del terrain["tiles"]

    assert any("needs tiles" in problem for problem in validate(doc))


def test_terrain_layer_needs_the_statistics_that_seed_the_contours(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    del doc["layers"][0]["stats"]["slope_p90_deg"]

    assert any("slope_p90_deg" in problem for problem in validate(doc))


def test_tile_source_without_an_attribution_is_invalid(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    doc["layers"][0]["tiles"]["source"]["attribution"] = ""

    problems = validate(doc)

    assert any("tiles.source needs a licence and an attribution" in problem for problem in problems)
    assert any("missing attribution" in problem for problem in problems)


def test_tiles_need_a_url_template_and_integer_sizes(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    tiles = doc["layers"][0]["tiles"]
    tiles.update(url="https://example.org/dem.webp", tile_size="512", encoding="mapbox")

    problems = validate(doc)

    assert any("tiles.url" in problem for problem in problems)
    assert any("tiles.tile_size" in problem for problem in problems)
    assert any("tiles.encoding" in problem for problem in problems)


def test_layer_without_arrays_and_without_tiles_is_invalid(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    terrain = doc["layers"][0]

    assert terrain["arrays"] == {}

    del terrain["tiles"]
    terrain["style"]["kind"] = "categorical"
    terrain["style"]["classes"] = [{"value": 10, "label": "Tree cover", "color": "#006400"}]

    assert any("missing arrays" in problem for problem in validate(doc))


def test_the_tile_source_attribution_is_in_the_credits(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    attribution = SOURCES["mapterhorn"]["attribution"]

    assert attribution in doc["credits"]["lines"]

    doc["credits"]["lines"].remove(attribution)

    assert any("attribution not in credits.lines" in problem for problem in validate(doc))


def test_tiled_layers_still_require_an_arrays_object(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    del doc["layers"][0]["arrays"]

    assert any("arrays must be an object" in problem for problem in validate(doc))


def test_terrain_statistics_must_be_an_object(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    doc["layers"][0]["stats"] = [1, 2]

    assert any("stats must be an object" in problem for problem in validate(doc))


@pytest.mark.parametrize("value", [None, float("nan"), float("inf"), True])
def test_terrain_statistics_reject_nonfinite_or_nonnumeric_values(tmp_path, value):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    doc["layers"][0]["stats"]["slope_p90_deg"] = value

    assert any("slope_p90_deg" in problem for problem in validate(doc))


def test_tiles_need_positive_size_and_nonnegative_zoom(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    doc["layers"][0]["tiles"].update(tile_size=0, maxzoom=-1)

    problems = validate(doc)

    assert any("tiles.tile_size is out of range" in problem for problem in problems)
    assert any("tiles.maxzoom is out of range" in problem for problem in problems)


def test_land_cover_layer_is_valid_and_credits_worldcover(tmp_path):
    build_scene(HASH_A, Area(NAIROBI), None, None, [LAND_COVER], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    layer = doc["layers"][0]

    assert validate(doc) == []
    assert layer["style"]["kind"] == "categorical" and layer["style"]["palette"] == "painted"
    assert layer["arrays"]["value"]["fill"] == 0
    assert SOURCES["worldcover"]["attribution"] in doc["credits"]["lines"]


@pytest.mark.parametrize("style_palette", [{}, {"palette": "painted"}])
def test_categorical_palette_may_be_missing_or_known(tmp_path, style_palette):
    build_scene(HASH_A, Area(NAIROBI), None, None, [LAND_COVER], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    style = doc["layers"][0]["style"]
    del style["palette"]
    style.update(style_palette)

    assert validate(doc) == []


@pytest.mark.parametrize("palette", ["unknown", "ink-blue", "", None, 1, True, [], {}])
def test_categorical_palette_rejects_unknown_names_and_non_text_values(tmp_path, palette):
    build_scene(HASH_A, Area(NAIROBI), None, None, [LAND_COVER], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    layer = doc["layers"][0]
    layer["style"]["palette"] = palette

    assert validate(doc) == [
        f"{layer['id']}: style.palette must be omitted or one of: painted",
    ]
