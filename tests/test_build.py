"""Offline tests: hillshade, synthetic end-to-end builds, bundle credits and validation."""
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import zarr
from shapely.geometry import box

from soe.areas import Area, AreaError
from soe.build import build_scene, hillshade
from soe.bundle import SYNTHETIC_DATA_CREDIT, JsonObject, credits, validate
from soe.sources import (
    SOURCES,
    CellWindow,
    SyntheticSource,
    make_registry,
    terrain_res,
)
from tests.helpers import FIJI, NAIROBI, RAIN, TERRAIN, plan_months

BOUNDARY = {
    "id": "cgaz:ADM1:TEST",
    "name": "Testland",
    "level": "state",
    "iso3": "KEN",
    "source": "geoBoundaries CGAZ",
    "licence": "CC BY 4.0",
}

HASH_A, HASH_B, HASH_C = "a" * 20, "b" * 20, "c" * 20


def build_nairobi(
    tmp_path: Path,
    months: tuple[str, str] = ("2015-01", "2016-02"),
) -> tuple[JsonObject, zarr.Group]:
    build_scene(
        HASH_A,
        Area(NAIROBI, BOUNDARY),
        months[0],
        months[1],
        [TERRAIN, RAIN],
        "Test",
        tmp_path,
    )
    out = tmp_path / HASH_A
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))
    return doc, zarr.open_group(out / "data.zarr", mode="r")


def test_hillshade_flat_and_slope():
    flat = hillshade(np.zeros((8, 8)), 0.01, 10.0)
    assert (flat == round(255 * np.sin(np.radians(45)))).all()

    # It rises eastwards, so it faces the north-west sun.
    west_facing = np.tile(np.arange(8) * 50.0, (8, 1))
    east_facing = west_facing[:, ::-1]

    assert hillshade(west_facing, 0.01, 10.0)[4, 4] > hillshade(east_facing, 0.01, 10.0)[4, 4]


def test_synthetic_build_across_180(tmp_path):
    registry = make_registry(SyntheticSource())
    layers = [registry["glo90_terrain"], registry["chirps_monthly"]]
    build_scene(
        HASH_B,
        Area(FIJI, BOUNDARY),
        "2015-01",
        "2015-03",
        layers,
        "Test",
        tmp_path,
        lambda fraction: None,
    )

    out = tmp_path / HASH_B
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))

    assert validate(doc) == [] and doc["area"]["bbox"][2] > 180

    root = zarr.open_group(out / "data.zarr", mode="r")

    for name in ("chirps_monthly", "glo90_terrain"):
        lon = root[name]["lon"][:]

        assert np.all(np.diff(lon) > 0) and lon[-1] > 180

    terrain = root["glo90_terrain"]
    bbox = doc["area"]["bbox"]
    west, east = bbox[0], bbox[2]

    assert terrain["elevation"].shape[1] == round((east - west) / terrain_res(bbox))

    shade = terrain["hillshade"][:]
    middle = shade.shape[1] // 2

    assert not np.all(shade[:, middle] == shade[0, middle])  # no flat seam column


def test_synthetic_build_validates_and_opens(tmp_path):
    source = SyntheticSource()
    registry = make_registry(source)
    area = Area(NAIROBI, BOUNDARY)
    seen = []
    layers = [registry["glo90_terrain"], registry["chirps_monthly"]]
    size = build_scene(HASH_A, area, "2015-01", "2016-12", layers, "Test", tmp_path, seen.append)

    assert size > 0 and seen[-1] == 1.0
    assert not (tmp_path / ".tmp" / HASH_A).exists()

    out = tmp_path / HASH_A
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))

    assert validate(doc) == []
    assert "Copernicus WorldDEM™-90" in doc["credits"]["lines"][0]
    assert doc["credits"]["disclaimers"]

    root = zarr.open_group(str(out / "data.zarr"), mode="r")

    assert root.attrs["credits"] == doc["credits"]

    precip = root["chirps_monthly/precip"]

    assert precip.shape[0] == 24 and precip.metadata.dimension_names == ("time", "lat", "lon")

    for layer in doc["layers"]:
        mask = root[layer["mask"]["path"]][...]

        assert mask.sum() == layer["mask"]["cells_inside"] > 0

    mask = root["chirps_monthly/mask"][...]

    assert (precip[0][mask == 1] != 65535).any()
    assert root["glo90_terrain/hillshade"].dtype == "uint8"
    assert root["glo90_terrain/elevation"].dtype == "int16"

    lat = root["chirps_monthly/lat"][...]

    assert lat[0] > lat[-1] and doc["area"]["bbox"][3] == pytest.approx(lat[0] + 0.025)

    p98 = doc["layers"][-1]["style"]["domain"][1]

    assert 0 < p98 <= doc["layers"][-1]["stats"]["max"]


def test_build_with_aggregation_factor_2(tmp_path):
    registry = make_registry(SyntheticSource())
    rain = registry["chirps_monthly"]
    area = Area(box(30, -20, 60, 10), BOUNDARY)

    # 360k cells x 72 months x 2 B is more than 50 MB.
    assert plan_months(area, [rain], 72).layers["chirps_monthly"].factor == 2

    build_scene(HASH_A, area, "2015-01", "2020-12", [rain], "Big", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))

    assert validate(doc) == []
    assert doc["layers"][0]["grid"] == {
        "crs": "EPSG:4326",
        "bbox": [30, -20, 60, 10],
        "res": 0.1,
        "nx": 300,
        "ny": 300,
        "aggregation": 2,
    }
    assert any("averaged" in note for note in doc["notices"]["limits"])

    store = zarr.open_group(str(tmp_path / HASH_A / "data.zarr"), mode="r")
    precip = store["chirps_monthly/precip"]

    assert precip.shape == (72, 300, 300) and precip[0][150, 150] != 65535


def test_layer_outside_its_coverage_is_refused_before_read(tmp_path):
    source = SyntheticSource()
    registry = make_registry(source)
    north = box(36, 40, 38, 45)
    narrow = replace(registry["glo90_terrain"], coverage=(-180, -30, 180, 30))

    with pytest.raises(AreaError, match="outside Terrain coverage"):
        build_scene(
            HASH_A,
            Area(north),
            "2015-01",
            "2015-03",
            [narrow, registry["chirps_monthly"]],
            "T",
            tmp_path,
        )

    assert source.reads == 0 and not (tmp_path / HASH_A).exists()

    # Half of this area is inside the terrain coverage.
    scene_plan = plan_months(Area(box(36, 28, 38, 33)), [narrow, registry["chirps_monthly"]])

    assert any("clipped" in note for note in scene_plan.layers["glo90_terrain"].notices)
    assert scene_plan.layers["chirps_monthly"].notices == []
    assert scene_plan.clipped and scene_plan.layers["glo90_terrain"].bbox[3] <= 30


def test_failed_build_leaves_no_partial_bundle(tmp_path):
    class Boom(SyntheticSource):
        def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
            raise RuntimeError("boom")

    boom = make_registry(Boom())["chirps_monthly"]

    with pytest.raises(RuntimeError):
        build_scene(HASH_C, Area(NAIROBI), "2015-01", "2015-03", [boom], "T", tmp_path)

    assert list(tmp_path.rglob("scene.json")) == []
    assert not (tmp_path / HASH_C).exists() and not (tmp_path / ".tmp" / HASH_C).exists()


def test_rain_is_uint16_sharded_and_round_trips(tmp_path):
    doc, root = build_nairobi(tmp_path)  # 14 months: two shards in time
    precip = root["chirps_monthly/precip"]
    rain = next(layer for layer in doc["layers"] if layer["id"] == "chirps_monthly")

    assert precip.dtype == "uint16" and precip.chunks == (1, 20, 20)
    assert precip.shards == (12, 20, 20)
    assert rain["arrays"]["value"] == {
        "path": "chirps_monthly/precip",
        "dtype": "uint16",
        "scale_factor": 0.1,
        "add_offset": 0,
        "fill": 65535,
    }
    assert rain["time"]["count"] == 14
    assert rain["time"]["values"][:2] == ["2015-01-01", "2015-02-01"]

    raw = precip[...]
    decoded = np.where(raw == 65535, np.nan, raw * precip.attrs["scale_factor"])
    bbox = rain["grid"]["bbox"]
    expected = np.stack([RAIN.read_step(step, bbox) for step in rain["time"]["values"]])

    assert np.isnan(expected).any() and np.array_equal(np.isnan(decoded), np.isnan(expected))
    assert np.nanmax(np.abs(decoded - expected)) <= 0.051


def test_static_layer_has_no_time_and_one_chunk(tmp_path):
    doc, root = build_nairobi(tmp_path)
    terrain = next(layer for layer in doc["layers"] if layer["id"] == "glo90_terrain")

    assert terrain["time"] is None and terrain["grid"]["res"] == pytest.approx(1 / 1200, abs=1e-8)
    assert "aggregation" not in terrain["grid"]
    assert set(terrain["arrays"]) == {"elevation", "hillshade"}
    assert "time" not in dict(root["glo90_terrain"].members())
    assert root["glo90_terrain/elevation"].chunks == (1200, 1200)
    assert root["glo90_terrain/hillshade"].shards is None


def test_store_has_consolidated_metadata(tmp_path):
    build_nairobi(tmp_path)

    root_json = json.loads((tmp_path / HASH_A / "data.zarr" / "zarr.json").read_text())
    meta = root_json["consolidated_metadata"]["metadata"]
    expected = {"chirps_monthly/precip", "chirps_monthly/mask", "glo90_terrain/elevation"}

    assert expected <= meta.keys()


def test_validate_catches_missing_attribution(tmp_path):
    build_scene(HASH_B, Area(NAIROBI), "2015-01", "2015-03", [TERRAIN, RAIN], "T", tmp_path)

    doc = json.loads((tmp_path / HASH_B / "scene.json").read_text(encoding="utf-8"))
    del doc["layers"][0]["source"]["disclaimer"]

    assert any("disclaimer" in problem for problem in validate(doc))

    doc["layers"][1]["source"]["attribution"] = ""
    assert any("attribution" in problem for problem in validate(doc))


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
