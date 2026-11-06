"""Test scene.json validation and the credit lines of a bundle."""
import copy
import json

import pytest

from soe.areas import Area
from soe.build import build_scene
from soe.bundle import SYNTHETIC_DATA_CREDIT, credits, validate
from soe.sources import SOURCES
from tests.helpers import (
    CONTRACT_VERSION,
    GENERATOR_VERSION,
    HASH_A,
    HASH_B,
    LAND_COVER,
    NAIROBI,
    RAIN,
    TERRAIN,
    build_nairobi,
)


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

    assert doc["version"] == "0.7"
    assert doc["period"] == {"start": "2015-01-01", "end": "2016-03-01", "step": "P1M"}
    assert rain["time"]["method"] == "sum"
    assert store["chirps_monthly/precip"].attrs["cell_methods"] == "time: sum"


def test_validate_rejects_a_previous_bundle_format(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))
    doc["version"] = "0.6"

    assert validate(doc, "0.7") == ["version must be 0.7"]


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
    del terrain["distribution"]

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


def test_p6_bundle_carries_the_current_contract_and_generator(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    rain = next(layer for layer in doc["layers"] if layer["id"] == "chirps_monthly")
    terrain = next(layer for layer in doc["layers"] if layer["id"] == "terrain")
    series = rain["area_series"]
    distribution = terrain["distribution"]

    assert doc["version"] == CONTRACT_VERSION
    assert doc["generator"]["version"] == GENERATOR_VERSION
    assert doc["generator"]["name"] == "soe"
    assert series["statistic"] == "mean"
    assert series["weights"] == "cell_area_inside_outline"
    assert len(series["values"]) == rain["time"]["count"]
    assert len(series["valid_fraction"]) == rain["time"]["count"]
    assert len(series["fallback_fraction"]) == rain["time"]["count"]
    assert distribution["statistic"] == "quantiles"
    assert distribution["weights"] == "cell_area_inside_outline"
    assert distribution["percent"] == 1
    assert len(distribution["values"]) == 101
    assert validate(doc) == []


def test_area_series_applicability_follows_time_not_dataset_id(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    rain = next(layer for layer in doc["layers"] if layer["id"] == "chirps_monthly")
    terrain = next(layer for layer in doc["layers"] if layer["id"] == "terrain")

    assert "area_series" in rain
    assert "area_series" not in terrain
    assert validate(doc) == []

    present = copy.deepcopy(doc)
    present["layers"][0]["area_series"] = copy.deepcopy(rain["area_series"])

    assert any("static layer must not have area_series" in problem for problem in validate(present))

    missing = copy.deepcopy(doc)
    del missing["layers"][1]["area_series"]

    assert any("needs area_series" in problem for problem in validate(missing))


def test_distribution_applicability_follows_kind_not_dataset_id(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    layers = {layer["id"]: layer for layer in doc["layers"]}

    assert "distribution" in layers["terrain"]
    assert "distribution" not in layers["chirps_monthly"]
    assert validate(doc) == []

    missing = copy.deepcopy(doc)
    del missing["layers"][0]["distribution"]

    assert any("needs distribution" in problem for problem in validate(missing))

    extra = copy.deepcopy(doc)
    extra["layers"][1]["distribution"] = copy.deepcopy(doc["layers"][0]["distribution"])

    assert any("must not have distribution" in problem for problem in validate(extra))

    build_scene(HASH_B, Area(NAIROBI), None, None, [LAND_COVER], "T", tmp_path)
    cover_doc = json.loads((tmp_path / HASH_B / "scene.json").read_text(encoding="utf-8"))
    cover_extra = copy.deepcopy(cover_doc)
    cover_extra["layers"][0]["distribution"] = copy.deepcopy(doc["layers"][0]["distribution"])

    assert any("must not have distribution" in problem for problem in validate(cover_extra))


def test_contract_checks_types_before_indexing(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))
    cases = [
        ("layers", "not-a-list"),
        ("area", "not-an-object"),
        ("credits", "not-an-object"),
        ("generator", "not-an-object"),
    ]

    for key, value in cases:
        mutated = copy.deepcopy(doc)
        mutated[key] = value

        assert validate(mutated) != []

    mutated = copy.deepcopy(doc)
    mutated["layers"] = ["not-an-object", None, 3]

    assert any("layer must be an object" in problem for problem in validate(mutated))

    malformed = copy.deepcopy(doc)
    malformed["layers"][1]["area_series"] = [1, 2]
    malformed["layers"][0]["distribution"] = "values"
    malformed["layers"][1]["grid"] = "grid"
    malformed["layers"][1]["time"] = "time"

    assert any("area_series must be an object" in problem for problem in validate(malformed))
    assert any("distribution must be an object" in problem for problem in validate(malformed))
    assert any("grid must be an object" in problem for problem in validate(malformed))
    assert any("time axis" in problem for problem in validate(malformed))


@pytest.mark.parametrize("value", [True, False])
def test_contract_rejects_bool_as_number(tmp_path, value):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))

    for mutated, needle in [
        (_with_series_value(doc, value), "area_series.values[0]"),
        (_with_valid_share(doc, value), "valid_fraction[0]"),
        (_with_fallback_share(doc, value), "fallback_fraction[0]"),
        (_with_grid_res(doc, value), "grid.res"),
        (_with_distribution_value(doc, value), "distribution.values"),
    ]:
        assert any(needle in problem for problem in validate(mutated)), needle

    rain_mutated = copy.deepcopy(doc)
    rain_mutated["layers"][1]["time"]["count"] = value

    assert any("time axis" in problem for problem in validate(rain_mutated))

    terrain_mutated = copy.deepcopy(doc)
    terrain_mutated["layers"][0]["stats"]["mean"] = value

    assert any("stats need numbers" in problem for problem in validate(terrain_mutated))


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_contract_rejects_nonfinite_numbers(tmp_path, value):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))

    assert any(
        "finite number or null" in problem
        for problem in validate(_with_series_value(doc, value))
    )
    assert any(
        "between 0 and 1" in problem
        for problem in validate(_with_valid_share(doc, value))
    )
    assert any(
        "finite numbers" in problem
        for problem in validate(_with_distribution_value(doc, value))
    )
    assert any(
        "positive finite" in problem for problem in validate(_with_grid_res(doc, value))
    )


def test_contract_rejects_wrong_lengths_and_fractions(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    rain_id = "chirps_monthly"

    shortened = copy.deepcopy(doc)
    shortened["layers"][1]["area_series"]["values"] = shortened["layers"][1][
        "area_series"
    ]["values"][:-1]

    assert any("time.count entries" in problem for problem in validate(shortened))

    shortened_fallback = copy.deepcopy(doc)
    shortened_fallback["layers"][1]["area_series"]["fallback_fraction"] = [0.0]

    assert any("time.count entries" in problem for problem in validate(shortened_fallback))

    high_valid = _with_valid_share(doc, 1.5)

    assert any("between 0 and 1" in problem for problem in validate(high_valid))

    negative_fallback = _with_fallback_share(doc, -0.1)

    assert any("between 0 and 1" in problem for problem in validate(negative_fallback))

    exceeds = copy.deepcopy(doc)
    exceeds["layers"][1]["area_series"]["valid_fraction"][0] = 0.2
    exceeds["layers"][1]["area_series"]["fallback_fraction"][0] = 0.5

    assert any("must not exceed valid_fraction" in problem for problem in validate(exceeds))

    assert any(f"{rain_id}" in problem for problem in validate(exceeds))


def test_contract_rejects_reserved_blocks_paths_and_reducers(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))

    for block in ("area_series", "distribution"):
        index = 1 if block == "area_series" else 0
        with_path = copy.deepcopy(doc)
        with_path["layers"][index][block]["path"] = "future/table.zarr"

        assert any("path is reserved" in problem for problem in validate(with_path))

    with_shares = copy.deepcopy(doc)
    with_shares["layers"][1]["categorical_shares"] = []

    assert any("categorical_shares is reserved" in problem for problem in validate(with_shares))

    bad_statistic = copy.deepcopy(doc)
    bad_statistic["layers"][1]["area_series"]["statistic"] = "sum"

    assert any("area_series.statistic" in problem for problem in validate(bad_statistic))

    bad_weights = copy.deepcopy(doc)
    bad_weights["layers"][1]["area_series"]["weights"] = "cell_count"

    assert any("area_series.weights" in problem for problem in validate(bad_weights))

    bad_quantiles = copy.deepcopy(doc)
    bad_quantiles["layers"][0]["distribution"]["statistic"] = "mean"

    assert any("distribution.statistic" in problem for problem in validate(bad_quantiles))

    bad_percent = copy.deepcopy(doc)
    bad_percent["layers"][0]["distribution"]["percent"] = 5

    assert any("distribution.percent" in problem for problem in validate(bad_percent))

    short_quantiles = copy.deepcopy(doc)
    short_quantiles["layers"][0]["distribution"]["values"] = [1.0] * 100

    assert any("101 numbers" in problem for problem in validate(short_quantiles))

    decreasing = copy.deepcopy(doc)
    decreasing["layers"][0]["distribution"]["values"][50] = (
        decreasing["layers"][0]["distribution"]["values"][0] - 1.0
    )

    assert any("must not decrease" in problem for problem in validate(decreasing))


def test_contract_rejects_invalid_resolution_and_references(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))

    for resolution in (0, -0.01, float("nan"), float("inf"), "fine", True, None):
        assert any(
            "grid.res" in problem for problem in validate(_with_grid_res(doc, resolution))
        ), resolution

    not_a_list = copy.deepcopy(doc)
    not_a_list["layers"][0]["distribution"]["reference_values"] = {}

    assert any("reference_values must be a list" in problem for problem in validate(not_a_list))

    not_an_object = copy.deepcopy(doc)
    not_an_object["layers"][0]["distribution"]["reference_values"] = [3]

    assert any("must be an object" in problem for problem in validate(not_an_object))

    bad_entry = copy.deepcopy(doc)
    bad_entry["layers"][0]["distribution"]["reference_values"] = [
        {"id": "", "value": float("nan")},
    ]

    problems = validate(bad_entry)

    assert any(".id must be text" in problem for problem in problems)
    assert any(".value" in problem for problem in problems)

    bad_sea_level = copy.deepcopy(doc)
    bad_sea_level["layers"][0]["distribution"]["reference_values"] = [
        {"id": "sea_level", "value": 2},
    ]

    assert any("sea_level reference must be 0" in problem for problem in validate(bad_sea_level))

    bad_endpoints = copy.deepcopy(doc)
    bad_endpoints["layers"][0]["distribution"]["values"][0] = (
        bad_endpoints["layers"][0]["distribution"]["min"] - 1.0
    )

    assert any("endpoints must match" in problem for problem in validate(bad_endpoints))

    bad_order = copy.deepcopy(doc)
    bad_order["layers"][0]["distribution"]["mean"] = (
        bad_order["layers"][0]["distribution"]["max"] + 1.0
    )

    assert any("min must not exceed mean" in problem for problem in validate(bad_order))

    empty_share = copy.deepcopy(doc)
    empty_share["layers"][0]["distribution"]["valid_fraction"] = 0.0

    assert any("above 0" in problem for problem in validate(empty_share))


def test_contract_rejects_positive_fallback_without_credited_sources(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))

    assert doc["layers"][1]["fallback_sources"]
    assert any(share > 0 for share in doc["layers"][1]["area_series"]["fallback_fraction"])
    assert validate(doc) == []

    uncredited = copy.deepcopy(doc)
    del uncredited["layers"][1]["fallback_sources"]

    assert any(
        "without fallback_sources" in problem for problem in validate(uncredited)
    )

    missing_shares = copy.deepcopy(doc)
    del missing_shares["layers"][1]["area_series"]["fallback_fraction"]

    assert any(
        "without fallback_fraction" in problem for problem in validate(missing_shares)
    )


def test_contract_rejects_null_and_share_mismatches(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))

    null_with_share = copy.deepcopy(doc)
    null_with_share["layers"][1]["area_series"]["values"][0] = None
    null_with_share["layers"][1]["area_series"]["valid_fraction"][0] = 0.5

    assert any("null must match" in problem for problem in validate(null_with_share))

    value_without_share = copy.deepcopy(doc)
    value_without_share["layers"][1]["area_series"]["values"][0] = 10.0
    value_without_share["layers"][1]["area_series"]["valid_fraction"][0] = 0.0

    assert any("null must match" in problem for problem in validate(value_without_share))


def test_contract_rejects_wrong_versions_and_missing_terms(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))

    old_contract = copy.deepcopy(doc)
    old_contract["version"] = "0.6"

    assert validate(old_contract) == ["version must be 0.7"]

    old_generator = copy.deepcopy(doc)
    old_generator["generator"]["version"] = "0.8.1"

    assert any("generator version" in problem for problem in validate(old_generator))

    bad_generator = copy.deepcopy(doc)
    bad_generator["generator"] = {"name": "other", "version": GENERATOR_VERSION}

    assert any("generator name" in problem for problem in validate(bad_generator))

    missing_terms = copy.deepcopy(doc)
    del missing_terms["credits"]["terms_passthrough"]

    assert any("terms_passthrough" in problem for problem in validate(missing_terms))

    missing_endorsement = copy.deepcopy(doc)
    del missing_endorsement["credits"]["endorsement"]

    assert any("endorsement" in problem for problem in validate(missing_endorsement))


def test_terrain_stats_mirror_the_distribution(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))
    terrain = doc["layers"][0]
    distribution = terrain["distribution"]

    assert terrain["stats"]["min"] == distribution["min"]
    assert terrain["stats"]["max"] == distribution["max"]
    assert terrain["stats"]["mean"] == distribution["mean"]
    assert terrain["stats"]["p2"] == distribution["values"][2]
    assert terrain["stats"]["p98"] == distribution["values"][98]
    assert validate(doc) == []

    drifted = copy.deepcopy(doc)
    drifted["layers"][0]["stats"]["mean"] = distribution["mean"] + 1.0

    assert any("must equal the distribution" in problem for problem in validate(drifted))


def test_contract_reports_malformed_time_end_without_raising(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))

    missing = copy.deepcopy(doc)
    del missing["layers"][1]["time"]["end"]

    assert any("time.end" in problem for problem in validate(missing))

    null = copy.deepcopy(doc)
    null["layers"][1]["time"]["end"] = None

    assert any("time.end" in problem for problem in validate(null))

    for bad in (123, 12.5, True, ["2016-04-01"]):
        mutated = copy.deepcopy(doc)
        mutated["layers"][1]["time"]["end"] = bad

        assert any("time.end" in problem for problem in validate(mutated)), bad

    assert validate(doc) == []


def test_contract_rejects_oversized_integers_without_raising(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))
    huge = 10**400

    assert any("grid.res" in problem for problem in validate(_with_grid_res(doc, huge)))
    assert any(
        "area_series.values" in problem for problem in validate(_with_series_value(doc, huge))
    )
    assert any(
        "between 0 and 1" in problem for problem in validate(_with_valid_share(doc, huge))
    )
    assert any(
        "between 0 and 1" in problem for problem in validate(_with_fallback_share(doc, huge))
    )
    assert any(
        "finite numbers" in problem for problem in validate(_with_distribution_value(doc, huge))
    )

    stats_huge = copy.deepcopy(doc)
    stats_huge["layers"][0]["stats"]["mean"] = huge

    assert any("stats need numbers" in problem for problem in validate(stats_huge))

    stops_huge = copy.deepcopy(doc)
    stops_huge["layers"][1]["style"]["stops"] = [0, huge]

    assert any("stops" in problem for problem in validate(stops_huge))


def test_contract_rejects_malformed_fallback_sources_without_crediting(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))

    for bad in ("credits", 123, {"licence": "CC BY 4.0"}):
        mutated = copy.deepcopy(doc)
        mutated["layers"][1]["fallback_sources"] = bad

        assert any("fallback_sources" in problem for problem in validate(mutated)), bad

    for bad_members in ([None], [123], [None, 123]):
        mutated = copy.deepcopy(doc)
        mutated["layers"][1]["fallback_sources"] = bad_members

        assert validate(mutated) != [], bad_members
        assert any(
            "fallback_sources" in problem or "must be an object" in problem
            for problem in validate(mutated)
        ), bad_members

    mixed = copy.deepcopy(doc)
    mixed["layers"][1]["fallback_sources"] = [*doc["layers"][1]["fallback_sources"], None]

    assert any("must be an object" in problem for problem in validate(mixed))
    assert validate(doc) == []


def test_contract_rejects_malformed_fallback_sources_on_static_terrain(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))

    for bad in (None, "credits", 123, {"licence": "CC0"}):
        mutated = copy.deepcopy(doc)
        mutated["layers"][0]["fallback_sources"] = bad

        assert any("fallback_sources" in problem for problem in validate(mutated)), bad

    control = copy.deepcopy(doc)
    control["layers"][0]["fallback_sources"] = copy.deepcopy(
        doc["layers"][1]["fallback_sources"],
    )

    assert validate(control) == []


def test_contract_enforces_exact_zero_and_nonnegative_shares(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))

    assert any(
        "between 0 and 1" in problem for problem in validate(_with_valid_share(doc, -5e-13))
    )
    assert any(
        "between 0 and 1" in problem
        for problem in validate(_with_fallback_share(doc, -5e-13))
    )

    empty_with_fallback = copy.deepcopy(doc)
    empty_with_fallback["layers"][1]["area_series"]["values"][0] = None
    empty_with_fallback["layers"][1]["area_series"]["valid_fraction"][0] = 0
    empty_with_fallback["layers"][1]["area_series"]["fallback_fraction"][0] = 5e-13

    assert any(
        "must not exceed valid_fraction" in problem
        for problem in validate(empty_with_fallback)
    )

    empty_clean = copy.deepcopy(doc)
    empty_clean["layers"][1]["area_series"]["values"][0] = None
    empty_clean["layers"][1]["area_series"]["valid_fraction"][0] = 0
    empty_clean["layers"][1]["area_series"]["fallback_fraction"][0] = 0

    assert validate(empty_clean) == []

    assert validate(_with_valid_share(doc, 1 + 5e-13)) == []

    assert any(
        "between 0 and 1" in problem
        for problem in validate(_with_valid_share(doc, 1 + 2e-12))
    )


def test_contract_rejects_timed_terrain(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    rain_time = copy.deepcopy(doc["layers"][1]["time"])

    timed = copy.deepcopy(doc)
    timed["layers"][0]["time_varying"] = True
    timed["layers"][0]["time"] = copy.deepcopy(rain_time)

    assert any(
        "must be static" in problem or "must not have distribution" in problem
        for problem in validate(timed)
    )

    timed_without_distribution = copy.deepcopy(timed)
    del timed_without_distribution["layers"][0]["distribution"]

    assert any("must be static" in problem for problem in validate(timed_without_distribution))

    timed_with_series = copy.deepcopy(timed)
    timed_with_series["layers"][0]["area_series"] = copy.deepcopy(
        doc["layers"][1]["area_series"],
    )

    assert any("must be static" in problem for problem in validate(timed_with_series))
    assert validate(doc) == []


def test_contract_rejects_explicit_null_blocks_and_shares(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))

    static_null_series = copy.deepcopy(doc)
    static_null_series["layers"][0]["area_series"] = None

    assert any(
        "static layer must not have area_series" in problem
        for problem in validate(static_null_series)
    )

    timed_null_distribution = copy.deepcopy(doc)
    timed_null_distribution["layers"][1]["distribution"] = None

    assert any(
        "must not have distribution" in problem
        for problem in validate(timed_null_distribution)
    )

    null_fallback = copy.deepcopy(doc)
    null_fallback["layers"][1]["area_series"]["fallback_fraction"] = None

    assert any(
        "fallback_fraction must be a list" in problem for problem in validate(null_fallback)
    )

    null_sources = copy.deepcopy(doc)
    null_sources["layers"][1]["fallback_sources"] = None

    assert any(
        "fallback_sources must be a list" in problem for problem in validate(null_sources)
    )

    categorical_null = copy.deepcopy(doc)
    categorical_null["layers"][0]["style"]["kind"] = "categorical"
    categorical_null["layers"][0]["style"]["classes"] = [
        {"value": 10, "label": "Tree cover", "color": "#006400"},
    ]
    del categorical_null["layers"][0]["distribution"]
    categorical_null["layers"][0]["distribution"] = None

    assert any(
        "must not have distribution" in problem for problem in validate(categorical_null)
    )

    static_field_null = copy.deepcopy(doc)
    static_field_null["layers"][0]["style"]["kind"] = "field"
    static_field_null["layers"][0]["style"]["palette"] = "viridis"
    static_field_null["layers"][0]["style"]["stops"] = [0, 10]
    static_field_null["layers"][0]["distribution"] = None

    assert any(
        "distribution must be an object" in problem
        for problem in validate(static_field_null)
    )


def test_contract_rejects_boolean_distribution_percent(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-01"))

    for bad in (True, False):
        mutated = copy.deepcopy(doc)
        mutated["layers"][0]["distribution"]["percent"] = bad

        assert any(
            "distribution.percent" in problem for problem in validate(mutated)
        ), bad


def test_bundle_outline_is_a_named_display_feature(tmp_path):
    from shapely.geometry import shape

    build_nairobi(tmp_path, ("2015-01", "2015-03"))
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    feature = json.loads((tmp_path / HASH_A / "area.geojson").read_text(encoding="utf-8"))

    assert doc["area"]["geometry_href"] == "area.geojson"
    assert feature["type"] == "Feature" and feature["properties"]["name"] == "Testland"
    assert shape(feature["geometry"]).is_valid
    assert validate(doc) == []


def _with_series_value(doc: dict, value: object) -> dict:
    """Return a copy of `doc` with the first area mean replaced by `value`."""
    mutated = copy.deepcopy(doc)
    mutated["layers"][1]["area_series"]["values"][0] = value
    return mutated


def _with_valid_share(doc: dict, value: object) -> dict:
    """Return a copy of `doc` with the first valid share replaced by `value`."""
    mutated = copy.deepcopy(doc)
    mutated["layers"][1]["area_series"]["valid_fraction"][0] = value
    return mutated


def _with_fallback_share(doc: dict, value: object) -> dict:
    """Return a copy of `doc` with the first fallback share replaced by `value`."""
    mutated = copy.deepcopy(doc)
    mutated["layers"][1]["area_series"]["fallback_fraction"][0] = value
    return mutated


def _with_grid_res(doc: dict, value: object) -> dict:
    """Return a copy of `doc` with the terrain resolution replaced by `value`."""
    mutated = copy.deepcopy(doc)
    mutated["layers"][0]["grid"]["res"] = value
    return mutated


def _with_distribution_value(doc: dict, value: object) -> dict:
    """Return a copy of `doc` with the first quantile replaced by `value`."""
    mutated = copy.deepcopy(doc)
    mutated["layers"][0]["distribution"]["values"][0] = value
    return mutated
