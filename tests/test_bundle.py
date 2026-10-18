"""Bundle tests: scene.json validation and credit lines."""
import json

from soe.areas import Area
from soe.build import build_scene
from soe.bundle import SYNTHETIC_DATA_CREDIT, credits, validate
from soe.sources import SOURCES
from tests.helpers import HASH_B, NAIROBI, RAIN, TERRAIN, build_nairobi


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
    assert any("mask has no cells" in problem for problem in problems)
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
