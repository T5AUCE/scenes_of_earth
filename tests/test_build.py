"""Offline tests: planning rules, block mean, hillshade, a synthetic end-to-end build, boundary import."""
import json

import numpy as np
import pytest
import zarr
from shapely.geometry import box, mapping

from soe.areas import Area, AreaError, check_months, clean_polygon, plan
from soe.build import build_scene, hillshade
from soe.bundle import validate
from soe.sources import REGISTRY, SyntheticSource, block_mean, glo90_tiles, make_registry, month_list, terrain_res

NAIROBI = box(36.5, -1.5, 37.5, -0.5)
SYN = make_registry(SyntheticSource())
RAIN, TERRAIN = SYN['chirps_monthly'], SYN['glo90_terrain']


def poly(x0, y0, x1, y1):
    return mapping(box(x0, y0, x1, y1))


def test_months():
    assert month_list("2015-11", "2016-02") == ["2015-11", "2015-12", "2016-01", "2016-02"]
    check_months("1981-01", "2026-08", "2026-08")
    for start, end in (("1980-12", "1990-01"), ("2020-05", "2020-04"), ("2020-01", "2026-09"), ("2020-13", "2020-14")):
        with pytest.raises(AreaError):
            check_months(start, end, "2026-08")


def test_block_mean_is_nan_aware():
    a = np.array([[1, 3, np.nan, np.nan], [5, np.nan, np.nan, np.nan]], "float32")
    out = block_mean(a, 2)
    assert out[0, 0] == 3 and np.isnan(out[0, 1])


def test_hillshade_flat_and_slope():
    flat = hillshade(np.zeros((8, 8)), 0.01, 10.0)
    assert (flat == round(255 * np.sin(np.radians(45)))).all()
    west_facing = np.tile(np.arange(8) * 50.0, (8, 1))  # rises eastwards, so faces the NW sun
    east_facing = west_facing[:, ::-1]
    assert hillshade(west_facing, 0.01, 10.0)[4, 4] > hillshade(east_facing, 0.01, 10.0)[4, 4]


def test_clean_polygon_rules():
    ok = clean_polygon({"type": "Feature", "geometry": poly(36.5, -1.5, 37.5, -0.5)})
    assert ok.area == pytest.approx(1.0)
    bowtie = {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]}
    assert clean_polygon(bowtie).area > 0  # repaired by make_valid
    bad = [
        {"type": "Point", "coordinates": [0, 0]},
        {"type": "Polygon", "coordinates": [[[0, 0], [200, 0], [200, 1], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [float("nan"), 0], [1, 1], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [2, 2], [0, 0]]]},  # zero area
        {"type": "Polygon", "coordinates": [[[i / 1e4, (i % 7) / 1e4] for i in range(5001)]]},
        "nope",
    ]
    for b in bad:
        with pytest.raises(AreaError):
            clean_polygon(b)


def test_dedupe_shape_is_canonical():
    a = clean_polygon(poly(36.50001, -1.5, 37.5, -0.49999))
    b = clean_polygon(poly(36.5, -1.5, 37.5, -0.5))
    assert a.wkb == b.wkb


def test_plan_rejections():
    with pytest.raises(AreaError, match="too small"):
        plan(Area(box(36.8, -1.1, 36.9, -1.0)), 12, [RAIN])
    with pytest.raises(AreaError, match="antimeridian"):
        plan(Area(box(-170, 0, 170, 10)), 12, [RAIN])
    with pytest.raises(AreaError, match="outside"):
        plan(Area(box(0, 62, 5, 70)), 12, [RAIN])
    with pytest.raises(AreaError, match="too large to read"):  # 2M source cells x 240 months > 100M
        plan(Area(box(-60, -20, 40, 10)), 240, [RAIN])
    assert REGISTRY.keys() == {'chirps_monthly', 'glo90_terrain'}
    assert len(glo90_tiles((36, -2, 38, 0))) == 4
    with pytest.raises(AreaError, match="source tiles"):  # 11 x 11 degrees = 121 tiles
        plan(Area(box(0, 0, 11, 11)), 1, [TERRAIN])


def test_plan_aggregates_and_snaps():
    p = plan(Area(box(30, -20, 60, 10)), 120, [RAIN])  # 360k cells x 120 months > 25M
    f = p.factor
    assert f == 2
    c, r, w, h = p.window
    assert c % f == 0 and r % f == 0 and w % f == 0 and h % f == 0
    assert p.shape == (h // f, w // f) and p.transform.a == pytest.approx(0.05 * f)
    assert any("averaged" in n for n in p.notices)
    assert p.shape[0] * p.shape[1] * 120 <= 25_000_000


def test_plan_tiny_named_area_falls_back_to_all_touched():
    tiny = box(36.99, -1.01, 37.0, -1.0)  # sits between cell centres
    p = plan(Area(tiny, {"name": "Tinyville"}), 12, [RAIN])
    assert p.cells_inside >= 1
    assert any("touches" in n for n in p.notices)
    assert any("padded" in n for n in p.notices)
    w, s, e, n = p.bbox
    assert e - w >= 0.5 - 1e-9 and n - s >= 0.5 - 1e-9


def test_terrain_res_not_finer_than_native():
    assert terrain_res((36.5, -1.5, 37.5, -0.5)) == pytest.approx(1 / 1200)
    assert terrain_res((0, 0, 20, 20)) == pytest.approx(20 / 2048)


HASH_A, HASH_B, HASH_C = "a" * 20, "b" * 20, "c" * 20
BOUNDARY = {"id": "cgaz:ADM1:TEST", "name": "Testland", "level": "state", "iso3": "KEN",
            "source": "geoBoundaries CGAZ", "licence": "CC BY 4.0"}


def test_synthetic_build_validates_and_opens(tmp_path):
    src = SyntheticSource()
    reg = make_registry(src)
    area = Area(NAIROBI, BOUNDARY)
    seen = []
    size = build_scene(HASH_A, area, "2015-01", "2016-12", [reg["glo90_terrain"], reg["chirps_monthly"]], "Test",
                       tmp_path, seen.append)
    assert size > 0 and seen[-1] == 1.0
    assert not (tmp_path / ".tmp" / HASH_A).exists()
    out = tmp_path / HASH_A
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))
    assert validate(doc) == []
    assert "Copernicus WorldDEM™-90" in doc["credits"]["lines"][0]
    assert doc["credits"]["disclaimers"] and doc["area"]["mask"]["cells_inside"] > 0

    root = zarr.open_group(str(out / "data.zarr"), mode="r")
    assert root.attrs["credits"] == doc["credits"]
    precip = root["chirps_monthly/precip"]
    assert precip.shape[0] == 24 and precip.metadata.codecs[-1].__class__.__name__ == "GzipCodec"
    assert precip.metadata.dimension_names == ("time", "lat", "lon")
    mask = root["chirps_monthly/mask"][...]
    assert mask.sum() == doc["area"]["mask"]["cells_inside"]
    assert np.isfinite(precip[0][mask == 1]).any()
    assert root["glo90_terrain/hillshade"].dtype == "uint8" and root["glo90_terrain/elevation"].dtype == "int16"
    lat = root["chirps_monthly/lat"][...]
    assert lat[0] > lat[-1] and doc["area"]["bbox"][3] == pytest.approx(lat[0] + 0.025)
    p98 = doc["layers"][-1]["domain"][1]
    assert 0 < p98 <= doc["layers"][-1]["stats"]["max"]


def test_build_with_aggregation_factor_2(tmp_path):
    reg = make_registry(SyntheticSource())
    rain = reg["chirps_monthly"]
    area = Area(box(30, -20, 60, 10), BOUNDARY)
    assert plan(area, 72, [rain]).factor == 2  # 360k cells x 72 months > 25M
    build_scene(HASH_A, area, "2015-01", "2020-12", [rain], "Big", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    assert validate(doc) == []
    assert doc["layers"][0]["resolution"] == {"deg": 0.1, "nx": 300, "ny": 300, "aggregation": 2, "method": "block mean"}
    assert any("averaged" in n for n in doc["notices"]["limits"])
    precip = zarr.open_group(str(tmp_path / HASH_A / "data.zarr"), mode="r")["chirps_monthly/precip"]
    assert precip.shape == (72, 300, 300) and np.isfinite(precip[0][150, 150])


def test_clean_polygon_malformed_inputs():
    for coords in ([[[0, 0], [10 ** 400, 0], [1, 1], [0, 0]]], [[["a", 0], [1, 0], [1, 1], [0, 0]]],
                   [[[[[[[0, 0]]]]]]]):  # too deeply nested
        with pytest.raises(AreaError):
            clean_polygon({"type": "Polygon", "coordinates": coords})


def test_add_boundaries_replaces_duplicate_ids(tmp_path):
    from soe import db
    path = str(tmp_path / "soe.db")
    db.init(path)
    row = ("x:1", "state", "Dup", "", "TST", 0, 0, 1, 1, 400, "{}", "geoBoundaries CGAZ", "CC BY 4.0")
    assert db.add_boundaries(path, "geoBoundaries CGAZ", [row, row, ("x:2",) + row[1:]]) == 1
    assert len(db.search(path, "Dup")) == 2


def test_validate_catches_missing_attribution(tmp_path):
    build_scene(HASH_B, Area(NAIROBI), "2015-01", "2015-03", [TERRAIN, RAIN], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_B / "scene.json").read_text(encoding="utf-8"))
    del doc["layers"][0]["source"]["disclaimer"]
    assert any("disclaimer" in p for p in validate(doc))
    doc["layers"][1]["source"]["attribution"] = ""
    assert any("attribution" in p for p in validate(doc))


def test_failed_build_leaves_no_partial_bundle(tmp_path):
    class Boom(SyntheticSource):
        def read_rain(self, ym, win):
            raise RuntimeError("boom")

    boom = make_registry(Boom())["chirps_monthly"]
    with pytest.raises(RuntimeError):
        build_scene(HASH_C, Area(NAIROBI), "2015-01", "2015-03", [boom], "T", tmp_path)
    assert list(tmp_path.rglob("scene.json")) == []
    assert not (tmp_path / HASH_C).exists() and not (tmp_path / ".tmp" / HASH_C).exists()


def test_import_boundaries_tiny_geopackage(tmp_path):
    gpd = pytest.importorskip("geopandas")
    from soe import db
    from soe.cli import import_cgaz, import_ucdb

    country, state, county = box(36, -2, 38, 0), box(36, -2, 37, 0), box(36, -1, 36.5, 0)
    for lvl, g, nm in ((0, country, "Testland"), (1, state, "West State"), (2, county, "Small County")):
        gpd.GeoDataFrame({"shapeName": [nm], "shapeGroup": ["TST"], "shapeID": [f"id{lvl}"]},
                         geometry=[g], crs=4326).to_file(tmp_path / f"geoBoundariesCGAZ_ADM{lvl}.gpkg")
    gpd.GeoDataFrame({"GC_UCN_MAI_2025": ["Big City", "Small Town"], "GC_POP_TOT_2025": [2e6, 5e4],
                      "GC_CNT_GAD_2025": ["Testland", "Testland"]},
                     geometry=[box(36.5, -1.5, 36.9, -1.1), box(37, -1, 37.1, -0.9)],
                     crs=4326).to_file(tmp_path / "ucdb.gpkg", layer="GHS_UCDB_THEME_GENERAL_CHARACTERISTICS")
    path = str(tmp_path / "soe.db")
    db.init(path)
    assert import_cgaz(path, tmp_path) == 3
    assert import_ucdb(path, tmp_path / "ucdb.gpkg") == 1
    county_row = db.search(path, "small", "county")[0]
    assert county_row["parent_name"] == "West State" and county_row["iso3"] == "TST"
    assert db.search(path, "t")[0]["level"] == "country"
    assert db.search(path, "big")[0]["level"] == "city"
    assert db.get_boundary(path, "ucdb:0")["licence"] == "CC BY 4.0"
