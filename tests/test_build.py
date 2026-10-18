"""Offline tests: hillshade, build progress and synthetic end-to-end builds."""
import json
import shutil
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import zarr
from rasterio.transform import Affine
from shapely.geometry import Polygon, box

from soe.areas import Area, AreaError
from soe.build import build_scene
from soe.bundle import validate
from soe.plan import plan
from soe.sources import (
    SOURCES,
    Bbox,
    CellWindow,
    Role,
    StaticDataset,
    SyntheticSource,
    hillshade,
    make_registry,
    terrain_res,
)
from tests.helpers import (
    BOUNDARY,
    FIJI,
    HASH_A,
    HASH_B,
    HASH_C,
    NAIROBI,
    RAIN,
    TERRAIN,
    build_nairobi,
    plan_months,
)

ProgressEvent = tuple[float, str | None]  # (fraction done, stage text) of one progress call


def array_bytes(scene_dir: Path) -> dict[str, bytes]:
    """Every array of the bundle as raw bytes; stored chunks carry a gzip time stamp."""
    root = zarr.open_group(scene_dir / "data.zarr", mode="r")
    return {
        path: member[:].tobytes()
        for path, member in root.members(max_depth=None)
        if isinstance(member, zarr.Array)
    }


def record_progress(tmp_path: Path, area: Area = Area(NAIROBI, BOUNDARY)) -> list[ProgressEvent]:
    """Build a 6-month Nairobi scene and return every progress call it made."""
    seen = []
    build_scene(
        HASH_A,
        area,
        "2015-01",
        "2015-06",
        [TERRAIN, RAIN],
        "Test",
        tmp_path,
        lambda fraction, stage: seen.append((fraction, stage)),
    )
    return seen


def test_terrain_cache_hit_builds_identical_arrays(tmp_path):
    class CountingSource(SyntheticSource):
        reads = 0

        def terrain(
            self,
            bounds: tuple,
            res: float,
            on_block: Callable[[], None] = lambda: None,
        ) -> tuple[np.ndarray, object]:
            self.reads += 1
            return super().terrain(bounds, res, on_block)

    source = CountingSource()
    terrain = make_registry(source)["copdem_terrain"]
    area = Area(NAIROBI, BOUNDARY)
    build_scene(HASH_A, area, "2015-01", "2015-02", [terrain], "Test", tmp_path / "cold")
    shutil.copytree(tmp_path / "cold" / ".cache", tmp_path / "warm" / ".cache")

    build_scene(HASH_A, area, "2015-01", "2015-02", [terrain], "Test", tmp_path / "warm")

    cold, warm = array_bytes(tmp_path / "cold" / HASH_A), array_bytes(tmp_path / "warm" / HASH_A)

    assert source.reads == 1
    assert "copdem_terrain/elevation" in cold and cold == warm


def test_progress_never_decreases_and_ends_at_one(tmp_path):
    fractions = [fraction for fraction, _ in record_progress(tmp_path)]

    assert fractions == sorted(fractions)
    assert fractions[-1] == 1.0 and fractions[-2] < 1.0


def test_progress_stage_names_terrain_blocks_then_rain_months(tmp_path):
    stages = [stage for _, stage in record_progress(tmp_path)]

    assert any(stage and stage.startswith(f"{TERRAIN.title} 1/") for stage in stages)
    assert any(stage and stage.startswith(RAIN.title) and "2015-0" in stage for stage in stages)
    assert stages[-1] is None


def test_terrain_reports_every_block_of_a_multi_block_area(tmp_path):
    area = Area(box(0.5, 0.5, 4.5, 2.5), BOUNDARY)

    stages = [stage for _, stage in record_progress(tmp_path, area)]

    counts = [stage.split()[-1] for stage in stages if stage and stage.startswith(TERRAIN.title)]
    block_count = int(counts[0].split("/")[1])
    every_block = [f"{done}/{block_count}" for done in range(block_count + 1)]

    assert block_count > 1
    assert counts == every_block + [f"{block_count}/{block_count}"]


def test_terrain_cache_hit_gives_terrain_almost_no_share(tmp_path):
    first = record_progress(tmp_path / "cold")
    shutil.copytree(tmp_path / "cold" / ".cache", tmp_path / "warm" / ".cache")

    warm = record_progress(tmp_path / "warm")

    def terrain_end(seen: list[ProgressEvent]) -> float:
        return max(fraction for fraction, stage in seen if stage and TERRAIN.title in stage)

    assert terrain_end(first) > terrain_end(warm)
    assert terrain_end(warm) < 0.1


def test_terrain_cache_hit_never_shows_zero_blocks_read(tmp_path):
    record_progress(tmp_path / "cold")
    shutil.copytree(tmp_path / "cold" / ".cache", tmp_path / "warm" / ".cache")

    stages = [stage for _, stage in record_progress(tmp_path / "warm")]

    assert not any(stage and stage.startswith(f"{TERRAIN.title} 0/") for stage in stages)


def test_build_stores_terrain_in_the_cache_folder(tmp_path):
    build_nairobi(tmp_path)

    assert any((tmp_path / ".cache").glob("*.npz"))
    assert not (tmp_path / ".cache" / "scene.json").exists()


def test_hillshade_flat_and_slope():
    flat = hillshade(np.zeros((8, 8)), 0.01, 10.0)
    assert (flat == round(255 * np.sin(np.radians(45)))).all()

    # It rises eastwards, so it faces the north-west sun.
    west_facing = np.tile(np.arange(8) * 50.0, (8, 1))
    east_facing = west_facing[:, ::-1]

    assert hillshade(west_facing, 0.01, 10.0)[4, 4] > hillshade(east_facing, 0.01, 10.0)[4, 4]


def test_scene_over_a_glo30_gap_credits_the_glo90_fallback(tmp_path):
    area = Area(box(42.8, 40.0, 43.2, 40.3), BOUNDARY)
    registry = make_registry(SyntheticSource())
    build_scene(HASH_A, area, "2015-01", "2015-02", [registry["copdem_terrain"]], "Test", tmp_path)

    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    terrain = doc["layers"][0]

    assert validate(doc) == []
    assert terrain["source"]["name"] == SOURCES["glo30"]["name"]
    assert terrain["fallback_sources"] == [SOURCES["glo90"]]
    assert SOURCES["glo30"]["attribution"] in doc["credits"]["lines"]
    assert SOURCES["glo90"]["attribution"] in doc["credits"]["lines"]
    assert SOURCES["glo90"]["disclaimer"] in doc["credits"]["disclaimers"]
    assert any("GLO-90" in note for note in doc["notices"]["limits"])

    doc["credits"]["lines"].remove(SOURCES["glo90"]["attribution"])

    assert any("attribution not in credits.lines" in problem for problem in validate(doc))


def test_synthetic_build_across_180(tmp_path):
    registry = make_registry(SyntheticSource())
    layers = [registry["copdem_terrain"], registry["chirps_monthly"]]
    build_scene(
        HASH_B,
        Area(FIJI, BOUNDARY),
        "2015-01",
        "2015-03",
        layers,
        "Test",
        tmp_path,
        lambda fraction, stage: None,
    )

    out = tmp_path / HASH_B
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))

    assert validate(doc) == [] and doc["area"]["bbox"][2] > 180

    root = zarr.open_group(out / "data.zarr", mode="r")

    for name in ("chirps_monthly", "copdem_terrain"):
        lon = root[name]["lon"][:]

        assert np.all(np.diff(lon) > 0) and lon[-1] > 180

    terrain = root["copdem_terrain"]
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
    layers = [registry["copdem_terrain"], registry["chirps_monthly"]]
    size = build_scene(
        HASH_A,
        area,
        "2015-01",
        "2016-12",
        layers,
        "Test",
        tmp_path,
        lambda fraction, stage: seen.append(fraction),
    )

    assert size > 0 and seen[-1] == 1.0
    assert not (tmp_path / ".tmp" / HASH_A).exists()

    out = tmp_path / HASH_A
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))

    assert validate(doc) == []
    assert "Copernicus WorldDEM™-30" in doc["credits"]["lines"][0]
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
    assert root["copdem_terrain/hillshade"].dtype == "uint8"
    assert root["copdem_terrain/elevation"].dtype == "int16"

    lat = root["chirps_monthly/lat"][...]

    assert lat[0] > lat[-1] and doc["area"]["bbox"][3] == pytest.approx(lat[0] + 0.025)


def test_stops_increase_and_cover_all_steps(tmp_path):
    doc, _ = build_nairobi(tmp_path)
    rain = doc["layers"][-1]
    stops = rain["style"]["stops"]

    assert 2 <= len(stops) <= 9
    assert stops == sorted(set(stops))
    assert stops[-1] == pytest.approx(rain["stats"]["p98"], rel=0.05)
    assert "domain" not in rain["style"]


def test_rain_stops_start_at_zero(tmp_path):
    doc, _ = build_nairobi(tmp_path)

    assert doc["layers"][-1]["stats"]["min"] > 0
    assert doc["layers"][-1]["style"]["stops"][0] == 0


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
    narrow = replace(registry["copdem_terrain"], coverage=(-180, -30, 180, 30))

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

    assert any("clipped" in note for note in scene_plan.layers["copdem_terrain"].notices)
    assert scene_plan.layers["chirps_monthly"].notices == []
    assert scene_plan.clipped and scene_plan.layers["copdem_terrain"].bbox[3] <= 30


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
    terrain = next(layer for layer in doc["layers"] if layer["id"] == "copdem_terrain")

    assert terrain["time"] is None and terrain["grid"]["res"] == pytest.approx(0.05 / 102, abs=1e-8)
    assert "aggregation" not in terrain["grid"]
    assert set(terrain["arrays"]) == {"elevation", "hillshade"}
    assert "time" not in dict(root["copdem_terrain"].members())
    assert root["copdem_terrain/elevation"].chunks == (2040, 2040)
    assert root["copdem_terrain/hillshade"].shards is None


def test_store_has_consolidated_metadata(tmp_path):
    build_nairobi(tmp_path)

    root_json = json.loads((tmp_path / HASH_A / "data.zarr" / "zarr.json").read_text())
    meta = root_json["consolidated_metadata"]["metadata"]
    expected = {"chirps_monthly/precip", "chirps_monthly/mask", "copdem_terrain/elevation"}

    assert expected <= meta.keys()


def land_cover_dataset(classes: Role) -> StaticDataset:
    """A static layer with one uint8 role of the given spec, read as the constant 40."""

    class LandCover(StaticDataset):
        def read(
            self,
            bbox: Bbox,
            res: float,
            on_block: Callable[[], None] | None = None,
        ) -> tuple[dict[str, np.ndarray], Affine]:
            height, width = round((bbox[3] - bbox[1]) / res), round((bbox[2] - bbox[0]) / res)
            return {"classes": np.full((height, width), 40, "uint8")}, Affine(
                res, 0, bbox[0], 0, -res, bbox[3]
            )

    return LandCover(
        **{
            **vars(TERRAIN),
            "id": "landcover",
            "resolution_deg": 0.01,
            "roles": {"classes": classes},
        }
    )


def test_static_dataset_with_its_own_role_is_written_without_a_special_case(tmp_path):
    classes = Role("landcover", "uint8", scale=2, offset=1, fill=7, long_name="Land cover class")
    dataset = land_cover_dataset(classes)

    build_scene(HASH_A, Area(NAIROBI), "2015-01", "2015-02", [dataset], "Test", tmp_path)

    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    array = zarr.open_group(tmp_path / HASH_A / "data.zarr", mode="r")["landcover/landcover"]

    assert doc["layers"][0]["arrays"]["classes"]["path"] == "landcover/landcover"
    assert doc["layers"][0]["arrays"]["classes"]["fill"] == 7
    assert array.dtype == "uint8" and array.attrs["long_name"] == "Land cover class"
    assert (array.attrs["scale_factor"], array.attrs["add_offset"]) == (2, 1)
    assert array.metadata.fill_value == 7
    assert (array[:] == 40).all()


def test_static_role_without_a_fill_value_fails_the_build_without_a_bundle(tmp_path):
    dataset = land_cover_dataset(Role("landcover", "uint8"))

    with pytest.raises(ValueError, match="needs a fill value"):
        build_scene(HASH_A, Area(NAIROBI), "2015-01", "2015-02", [dataset], "Test", tmp_path)

    assert not (tmp_path / HASH_A).exists()


TRIANGLE = Polygon([(36.5, -1.5), (37.5, -1.5), (36.5, -0.5)])


def build_triangle(tmp_path: Path) -> tuple[dict, zarr.Group]:
    """Build a terrain and rain scene over a triangle, so a third of the grid is outside."""
    build_scene(
        HASH_A,
        Area(TRIANGLE, BOUNDARY),
        "2015-01",
        "2015-03",
        [TERRAIN, RAIN],
        "Test",
        tmp_path,
    )
    out = tmp_path / HASH_A
    doc = json.loads((out / "scene.json").read_text(encoding="utf-8"))
    return doc, zarr.open_group(out / "data.zarr", mode="r")


def test_cells_outside_the_area_hold_the_fill_value_in_every_layer(tmp_path):
    doc, root = build_triangle(tmp_path)
    arrays = {
        (layer["id"], role): (layer, array_doc)
        for layer in doc["layers"]
        for role, array_doc in layer["arrays"].items()
    }

    assert len(arrays) == 3

    for layer, array_doc in arrays.values():
        outside = root[layer["mask"]["path"]][...] == 0
        stored = root[array_doc["path"]][...]

        assert outside.any() and (~outside).any()
        assert (stored[..., outside] == array_doc["fill"]).all()
        assert (stored[..., ~outside] != array_doc["fill"]).any()


def test_hillshade_at_the_area_edge_is_computed_before_masking(tmp_path):
    doc, root = build_triangle(tmp_path)
    terrain = next(layer for layer in doc["layers"] if layer["id"] == "copdem_terrain")
    inside = root[terrain["mask"]["path"]][...] == 1
    layer_plan = plan(Area(TRIANGLE, BOUNDARY), [TERRAIN, RAIN], "2015-01", "2015-03").layers[
        "copdem_terrain"
    ]
    unmasked, _ = TERRAIN.read(tuple(layer_plan.bbox), layer_plan.res)

    stored = root["copdem_terrain/hillshade"][...]

    assert (stored[inside] == unmasked["hillshade"][inside]).all()
    assert stored[inside].max() <= 254
