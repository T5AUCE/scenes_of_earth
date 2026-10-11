"""Offline tests: planning, block mean, hillshade, synthetic end-to-end builds, boundary import."""
import json
from dataclasses import replace

import numpy as np
import pytest
import zarr
from shapely.geometry import MultiPolygon, box, mapping

from soe.areas import Area, AreaError, check_months, clean_polygon, plan, unwrap
from soe.build import build_scene, hillshade
from soe.bundle import validate
from soe.sources import (REGISTRY, SyntheticSource, _tile_index, block_mean, glo90_tiles,
                         make_registry, month_list, terrain_by_blocks, terrain_res)

NAIROBI = box(36.5, -1.5, 37.5, -0.5)
SYN = make_registry(SyntheticSource())
RAIN, TERRAIN = SYN['chirps_monthly'], SYN['glo90_terrain']


def poly(x0, y0, x1, y1):
    return mapping(box(x0, y0, x1, y1))


def plan_months(area, datasets, months=12):
    """plan() for a period of `months` months starting 1990-01."""
    end = f"{1990 + (months - 1) // 12}-{(months - 1) % 12 + 1:02d}"
    return plan(area, datasets, "1990-01", end)


def test_months():
    assert month_list("2015-11", "2016-02") == ["2015-11", "2015-12", "2016-01", "2016-02"]
    check_months("1981-01", "2026-08", "1981-01", "2026-08")

    bad_ranges = (("1980-12", "1990-01"), ("2020-05", "2020-04"), ("2020-01", "2026-09"),
                  ("2020-13", "2020-14"))

    for start, end in bad_ranges:
        with pytest.raises(AreaError):
            check_months(start, end, "1981-01", "2026-08")


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
        plan_months(Area(box(36.8, -1.1, 36.9, -1.0)), [RAIN])

    with pytest.raises(AreaError, match="more than 180 degrees"):
        wide = box(0, 0, 90, 10).union(box(180, 0, 270, 10)).union(box(90, 0, 91, 1))
        plan_months(Area(wide), [RAIN])

    with pytest.raises(AreaError, match="outside"):
        plan_months(Area(box(0, 62, 5, 70)), [RAIN])

    with pytest.raises(AreaError, match="too large to read"):  # 2M source cells x 240 months > 100M
        plan_months(Area(box(-60, -20, 40, 10)), [RAIN], 240)

    assert REGISTRY.keys() == {'chirps_monthly', 'glo90_terrain'}
    assert len(glo90_tiles((36, -2, 38, 0))) == 4

    with pytest.raises(AreaError, match="source tiles"):  # 8190 existing tiles > 2500
        plan_months(Area(box(-100, -50, 70, 60)), [TERRAIN], 1)

    assert plan_months(Area(box(0, 0, 11, 11)), [TERRAIN], 1).bbox == [0, 0, 11, 11]


def test_plan_aggregates_and_snaps():
    # 360k cells x 120 months x 2 B is more than 50 MB.
    p = plan_months(Area(box(30, -20, 60, 10)), [RAIN], 120)
    lp = p.layers["chirps_monthly"]
    f = lp.factor

    assert f == 2

    w, s, e, n = lp.bbox

    cell = 0.05 * f

    edges = (w + 180, 60 - n, e + 180, 60 - s)

    assert all(v / cell == pytest.approx(round(v / cell)) for v in edges)
    assert lp.shape == (round((n - s) / 0.1), round((e - w) / 0.1))
    assert lp.transform.a == pytest.approx(cell)
    assert any("averaged" in note for note in lp.notices)
    assert lp.shape[0] * lp.shape[1] * 120 * 2 <= 50_000_000
    assert len(lp.steps) == 120


def test_plan_tiny_named_area_falls_back_to_all_touched():
    tiny = box(36.99, -1.01, 37.0, -1.0)  # sits between cell centres
    p = plan_months(Area(tiny, {"name": "Tinyville"}), [RAIN])

    lp = p.layers["chirps_monthly"]

    assert lp.cells_inside >= 1
    assert any("touches" in n for n in lp.notices)
    assert any("padded" in n for n in p.notices)

    w, s, e, n = p.bbox
    assert e - w >= 0.5 - 1e-9 and n - s >= 0.5 - 1e-9


def test_terrain_res_budget():
    assert terrain_res((36.5, -1.5, 37.5, -0.5)) == pytest.approx(1 / 1200)
    assert terrain_res((33, -4, 42, 6)) == pytest.approx(0.005)
    assert terrain_res((-70, -30, -30, 10)) == pytest.approx(0.025)
    assert terrain_res((19, 41, 191, 60)) == pytest.approx(0.05)

    boxes = ((33, -4, 42, 6), (-70, -30, -30, 10), (19, 41, 191, 60), (0, 0, 2, 2), (0, 0, 0.5, 40))

    for b in boxes:
        res = terrain_res(b)
        nx, ny = (b[2] - b[0]) / res, (b[3] - b[1]) / res
        assert nx == pytest.approx(round(nx)) and ny == pytest.approx(round(ny))
        assert nx * ny <= 2048 * 2048 and max(nx, ny) <= 4096


def test_tile_index():
    assert _tile_index().sum() == 26475
    assert glo90_tiles((6, 0, 7, 1)) == ["Copernicus_DSM_COG_30_N00_00_E006_00_DEM"]
    assert glo90_tiles((-130, -10, -120, 0)) == []  # mid-Pacific
    assert TERRAIN.tile_count([-130, -10, -120, 0]) == 0
    assert glo90_tiles((179, -18, 181, -17)) == ["Copernicus_DSM_COG_30_S18_00_E179_00_DEM",
                                                 "Copernicus_DSM_COG_30_S18_00_W180_00_DEM"]


def test_terrain_blocks_equal_one_read():
    syn = SyntheticSource()
    for bounds in ((177.35, -19.1, 181.65, -15.85), (36.5, -1.5, 37.5, -0.5)):
        res = terrain_res(bounds)
        whole, _ = syn.terrain(bounds, res)
        blocks, t = terrain_by_blocks(bounds, res, lambda b, r: syn.terrain(b, r)[0])

        assert np.abs(whole.astype(int) - blocks).max() <= 1  # float rounding at block edges only
        assert t.c == bounds[0] and t.f == bounds[3]


FIJI = MultiPolygon([box(178, -19, 180, -17), box(-180, -19, -178, -17)])


def test_unwrap_and_plan_across_180():
    assert unwrap(FIJI).bounds == (178, -19, 182, -17)

    p = plan_months(Area(FIJI), [RAIN], 2)
    lp = p.layers["chirps_monthly"]

    assert p.bbox[2] > 180 and lp.bbox[2] > 180 and lp.mask.sum() > 0


def test_read_month_wraps_at_180():
    src = SyntheticSource()
    rain = make_registry(src)["chirps_monthly"]
    bbox = [179, -1, 181, 1]
    a = rain.read_month("2015-01", bbox, 2)
    left = src.read_rain("2015-01", (7180, 1180, 20, 40))
    right = src.read_rain("2015-01", (0, 1180, 20, 40))

    assert src.reads == 4 and a.shape == (20, 20)
    assert np.array_equal(a, block_mean(np.hstack([left, right]), 2), equal_nan=True)


def test_synthetic_build_across_180(tmp_path):
    reg = make_registry(SyntheticSource())
    layers = [reg["glo90_terrain"], reg["chirps_monthly"]]
    build_scene(HASH_B, Area(FIJI, BOUNDARY), "2015-01", "2015-03", layers, "Test", tmp_path,
                lambda fraction: None)

    out = tmp_path / HASH_B
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))

    assert validate(doc) == [] and doc["area"]["bbox"][2] > 180

    g = zarr.open_group(out / "data.zarr", mode="r")

    for name in ("chirps_monthly", "glo90_terrain"):
        lon = g[name]["lon"][:]
        assert np.all(np.diff(lon) > 0) and lon[-1] > 180

    t = g["glo90_terrain"]
    w, e = doc["area"]["bbox"][0], doc["area"]["bbox"][2]

    assert t["elevation"].shape[1] == round((e - w) / terrain_res(doc["area"]["bbox"]))

    hs = t["hillshade"][:]
    assert not np.all(hs[:, hs.shape[1] // 2] == hs[0, hs.shape[1] // 2])  # no flat seam column


HASH_A, HASH_B, HASH_C = "a" * 20, "b" * 20, "c" * 20
BOUNDARY = {"id": "cgaz:ADM1:TEST", "name": "Testland", "level": "state", "iso3": "KEN",
            "source": "geoBoundaries CGAZ", "licence": "CC BY 4.0"}


def test_synthetic_build_validates_and_opens(tmp_path):
    src = SyntheticSource()
    reg = make_registry(src)
    area = Area(NAIROBI, BOUNDARY)
    seen = []
    layers = [reg["glo90_terrain"], reg["chirps_monthly"]]
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
    reg = make_registry(SyntheticSource())
    rain = reg["chirps_monthly"]
    area = Area(box(30, -20, 60, 10), BOUNDARY)

    # 360k cells x 72 months x 2 B is more than 50 MB.
    assert plan_months(area, [rain], 72).layers["chirps_monthly"].factor == 2

    build_scene(HASH_A, area, "2015-01", "2020-12", [rain], "Big", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))

    assert validate(doc) == []
    assert doc["layers"][0]["grid"] == {"crs": "EPSG:4326", "bbox": [30, -20, 60, 10], "res": 0.1,
                                        "nx": 300, "ny": 300, "aggregation": 2}
    assert any("averaged" in n for n in doc["notices"]["limits"])

    store = zarr.open_group(str(tmp_path / HASH_A / "data.zarr"), mode="r")
    precip = store["chirps_monthly/precip"]

    assert precip.shape == (72, 300, 300) and precip[0][150, 150] != 65535


def test_clean_polygon_malformed_inputs():
    for coords in ([[[0, 0], [10 ** 400, 0], [1, 1], [0, 0]]], [[["a", 0], [1, 0], [1, 1], [0, 0]]],
                   [[[[[[[0, 0]]]]]]]):  # too deeply nested
        with pytest.raises(AreaError):
            clean_polygon({"type": "Polygon", "coordinates": coords})


def test_add_boundaries_replaces_duplicate_ids(tmp_path):
    from soe import db
    path = str(tmp_path / "soe.db")
    db.init(path)

    row = ("x:1", "state", "Dup", "", "TST", 0, 0, 1, 1, 400, "{}", "geoBoundaries CGAZ",
           "CC BY 4.0")

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
    levels = ((0, country, "Testland"), (1, state, "West State"), (2, county, "Small County"))
    for lvl, g, nm in levels:
        gpd.GeoDataFrame({"shapeName": [nm], "shapeGroup": ["TST"], "shapeID": [f"id{lvl}"]},
                         geometry=[g], crs=4326).to_file(
            tmp_path / f"geoBoundariesCGAZ_ADM{lvl}.gpkg")

    gpd.GeoDataFrame({"GC_UCN_MAI_2025": ["Big City", "Small Town"], "GC_POP_TOT_2025": [2e6, 5e4],
                      "GC_CNT_GAD_2025": ["Testland", "Testland"]},
                     geometry=[box(36.5, -1.5, 36.9, -1.1), box(37, -1, 37.1, -0.9)],
                     crs=4326).to_file(tmp_path / "ucdb.gpkg",
                                       layer="GHS_UCDB_THEME_GENERAL_CHARACTERISTICS")

    path = str(tmp_path / "soe.db")
    db.init(path)

    assert import_cgaz(path, tmp_path) == 3
    assert import_ucdb(path, tmp_path / "ucdb.gpkg") == 1

    county_row = db.search(path, "small", "county")[0]
    assert county_row["parent_name"] == "West State" and county_row["iso3"] == "TST"

    assert db.search(path, "t")[0]["level"] == "country"
    assert db.search(path, "big")[0]["level"] == "city"
    assert db.get_boundary(path, "ucdb:0")["licence"] == "CC BY 4.0"


def build_nairobi(tmp_path, months=("2015-01", "2016-02")):
    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), months[0], months[1], [TERRAIN, RAIN], "Test",
                tmp_path)
    out = tmp_path / HASH_A
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))

    return doc, zarr.open_group(out / "data.zarr", mode="r")


def test_plan_gives_each_layer_its_own_grid_and_mask():
    p = plan_months(Area(NAIROBI), [TERRAIN, RAIN])
    terrain, rain = p.layers["glo90_terrain"], p.layers["chirps_monthly"]

    assert terrain.res == pytest.approx(1 / 1200) and rain.res == pytest.approx(0.05)
    assert terrain.shape == (1200, 1200) and rain.shape == (20, 20)
    assert terrain.mask.shape == terrain.shape and rain.mask.shape == rain.shape
    assert terrain.cells_inside == terrain.mask.sum() and rain.cells_inside == rain.mask.sum()
    assert terrain.factor == 1 and terrain.steps == [] and len(rain.steps) == 12


def test_output_budget_is_summed_across_layers():
    area = Area(box(30, -10, 50, 10))  # 160k rain cells

    assert plan_months(area, [RAIN], 140).layers["chirps_monthly"].factor == 1  # 44.8 MB

    both = plan_months(area, [TERRAIN, RAIN], 140)  # terrain takes 12 MB of the 50

    assert both.layers["chirps_monthly"].factor == 2 and both.layers["glo90_terrain"].factor == 1


def test_layer_outside_its_coverage_is_refused_before_read(tmp_path):
    src = SyntheticSource()
    reg = make_registry(src)
    north = box(36, 40, 38, 45)
    narrow = replace(reg["glo90_terrain"], coverage=(-180, -30, 180, 30))

    with pytest.raises(AreaError, match="outside Terrain coverage"):
        build_scene(HASH_A, Area(north), "2015-01", "2015-03", [narrow, reg["chirps_monthly"]], "T",
                    tmp_path)

    assert src.reads == 0 and not (tmp_path / HASH_A).exists()

    # Half of this area is inside the terrain coverage.
    p = plan_months(Area(box(36, 28, 38, 33)), [narrow, reg["chirps_monthly"]])

    assert any("clipped" in n for n in p.layers["glo90_terrain"].notices)
    assert p.layers["chirps_monthly"].notices == []
    assert p.clipped and p.layers["glo90_terrain"].bbox[3] <= 30


def test_series_steps_come_from_the_dataset_axis():
    sixteen_day = replace(RAIN, id="ndvi", title="Vegetation", step="P16D")
    sixteen_day.steps = lambda start, end: ["2020-01-01", "2020-01-17", "2020-02-02"]

    p = plan_months(Area(NAIROBI), [RAIN, sixteen_day], 2)

    assert p.layers["chirps_monthly"].steps == ["1990-01-01", "1990-02-01"]
    assert p.layers["ndvi"].steps == ["2020-01-01", "2020-01-17", "2020-02-02"]


def test_rain_is_uint16_sharded_and_round_trips(tmp_path):
    doc, root = build_nairobi(tmp_path)  # 14 months: two shards in time
    precip = root["chirps_monthly/precip"]
    rain = next(layer for layer in doc["layers"] if layer["id"] == "chirps_monthly")

    assert precip.dtype == "uint16" and precip.chunks == (1, 20, 20)
    assert precip.shards == (12, 20, 20)
    assert rain["arrays"]["value"] == {"path": "chirps_monthly/precip", "dtype": "uint16",
                                       "scale_factor": 0.1, "add_offset": 0, "fill": 65535}
    assert rain["time"]["count"] == 14
    assert rain["time"]["values"][:2] == ["2015-01-01", "2015-02-01"]

    raw = precip[...]
    decoded = np.where(raw == 65535, np.nan, raw * precip.attrs["scale_factor"])
    bbox = rain["grid"]["bbox"]
    expected = np.stack([RAIN.read_step(d, bbox) for d in rain["time"]["values"]])

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


def test_validate_checks_the_layer_contract(tmp_path):
    doc, _ = build_nairobi(tmp_path, ("2015-01", "2015-03"))
    terrain, rain = doc["layers"]

    rain["time"]["count"] = 5
    terrain["time"] = {"count": 0, "values": []}
    terrain["mask"]["cells_inside"] = 0
    del rain["grid"]

    problems = validate(doc)

    assert any("time axis" in p for p in problems) and any("static layer" in p for p in problems)
    assert any("mask has no cells" in p for p in problems)
    assert any("missing grid" in p for p in problems)


def test_static_layers_over_budget_get_their_own_message(monkeypatch):
    monkeypatch.setattr("soe.areas.MAX_OUTPUT_BYTES", 1_000_000)

    with pytest.raises(AreaError, match="static layers alone"):
        plan_months(Area(NAIROBI), [TERRAIN], 1)
