"""Test offline hillshade, build progress and synthetic end-to-end builds."""
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
from soe.build import SourceChanged, build_scene, encode_values
from soe.bundle import JsonObject, validate
from soe.plan import plan
from soe.sources import (
    SOURCES,
    Bbox,
    CellWindow,
    CubeSpec,
    Role,
    SeriesDataset,
    StaticDataset,
    SyntheticSource,
    hillshade,
    make_registry,
    terrain_res,
)
from tests.helpers import (
    BOUNDARY,
    COARSE,
    FIJI,
    HASH_A,
    HASH_B,
    HASH_C,
    NAIROBI,
    RAIN,
    TERRAIN,
    ReingestedSource,
    build_nairobi,
    plan_months,
)

ProgressEvent = tuple[float, str | None]  # (fraction done, stage text) of one progress call

TRIANGLE = Polygon([(36.5, -1.5), (37.5, -1.5), (36.5, -0.5)])


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
        longitude = root[name]["lon"][:]

        assert np.all(np.diff(longitude) > 0) and longitude[-1] > 180

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

    latitude = root["chirps_monthly/lat"][...]

    assert (
        latitude[0] > latitude[-1]
        and doc["area"]["bbox"][3] == pytest.approx(latitude[0] + 0.025)
    )


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


def test_series_at_different_factors_keep_grid_and_array_shapes_consistent(tmp_path):
    area = Area(box(30, -10, 50, 10), BOUNDARY)
    # 140 months come to 56 MB at native resolution, so only the finer rain layer is averaged.
    months = 140
    end = f"{1990 + (months - 1) // 12}-{(months - 1) % 12 + 1:02d}"

    build_scene(HASH_A, area, "1990-01", end, [RAIN, COARSE], "Two", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    store = zarr.open_group(str(tmp_path / HASH_A / "data.zarr"), mode="r")

    assert validate(doc) == []
    layers = {layer["id"]: layer for layer in doc["layers"]}
    assert layers["chirps_monthly"]["grid"]["aggregation"] == 2
    assert layers["coarse_monthly"]["grid"]["aggregation"] == 1
    for layer_id, layer in layers.items():
        grid = layer["grid"]
        for block in layer["arrays"].values():
            assert store[block["path"]].shape[-2:] == (grid["ny"], grid["nx"])


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


def test_negative_values_survive_int16_encoding():
    values = np.array([-5.5, 0, 20, np.nan])

    encoded = encode_values(values, "int16", 0.01, 0, -32768)

    assert encoded.tolist() == [-550, 0, 2000, -32768]


def test_no_value_encodes_to_a_minimum_fill():
    values = np.array([-1e9, -327.68, -327.67])

    encoded = encode_values(values, "int16", 0.01, 0, -32768)

    assert encoded.tolist() == [-32767, -32767, -32767]


def test_no_value_encodes_to_a_maximum_fill():
    encoded = encode_values(np.array([1e9, 6553.5]), "uint16", 0.1, 0, 65535)

    assert encoded.tolist() == [65534, 65534]


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
    steps = rain["time"]["values"]
    expected = np.stack([RAIN.read_step_filled(step, bbox).values for step in steps])

    assert np.isnan(RAIN.read_step(steps[0], bbox)).any()
    assert not np.isnan(expected).any() and not (raw == 65535).any()
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


def land_cover_dataset(classes: Role) -> StaticDataset:
    """Make a static layer with one uint8 role, read as the constant 40."""

    class LandCover(StaticDataset):
        def read(
            self,
            bbox: Bbox,
            res: float,
            on_block: Callable[[], None] | None = None,
        ) -> tuple[dict[str, np.ndarray], Affine]:
            height = round((bbox[3] - bbox[1]) / res)
            width = round((bbox[2] - bbox[0]) / res)
            arrays = {"classes": np.full((height, width), 40, "uint8")}
            transform = Affine(res, 0, bbox[0], 0, -res, bbox[3])
            return arrays, transform

    return LandCover(
        **{
            **vars(TERRAIN),
            "id": "landcover",
            "resolution_deg": 0.01,
            "roles": {"classes": classes},
        },
    )


def test_static_role_without_a_fill_value_fails_the_build_without_a_bundle(tmp_path):
    dataset = land_cover_dataset(Role("landcover", "uint8"))

    with pytest.raises(ValueError, match="needs a fill value"):
        build_scene(HASH_A, Area(NAIROBI), "2015-01", "2015-02", [dataset], "Test", tmp_path)

    assert not (tmp_path / HASH_A).exists()


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

    assert len(arrays) == 4

    for layer, array_doc in arrays.values():
        outside = root[layer["mask"]["path"]][...] == 0
        stored = root[array_doc["path"]][...]

        assert outside.any() and (~outside).any()
        assert (stored[..., outside] == array_doc["fill"]).all()
        assert (stored[..., ~outside] != array_doc["fill"]).any()


def test_finite_touched_cell_survives_masking_while_source_no_data_stays_missing(tmp_path):
    marked = _rain_with_marked_boundary(missing_cell=True)
    off_grid = box(36.54, -1.46, 37.46, -0.54)
    build_scene(HASH_A, Area(off_grid, BOUNDARY), "2015-01", "2015-01", [marked], "Test", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    root = zarr.open_group(tmp_path / HASH_A / "data.zarr", mode="r")
    layer = doc["layers"][0]
    mask = root["chirps_monthly/mask"][...]
    precip = root["chirps_monthly/precip"][0]
    fill = layer["arrays"]["value"]["fill"]
    height, width = precip.shape
    valid_cells = height * width - 1
    ordinary_cells = valid_cells - height
    expected_mean = (50 * height + 10 * ordinary_cells) / valid_cells

    assert layer["mask"]["rule"] == "touched by the area"
    assert layer["mask"]["cells_inside"] == mask.sum()
    assert root["chirps_monthly/mask"].attrs["long_name"] == "1 = cell touched by the area"
    assert mask[:, 0].all() and mask[5, 5] == 1
    assert (precip[:, 0] * layer["arrays"]["value"]["scale_factor"] == 50).all()
    assert precip[5, 5] == fill
    assert layer["stats"]["mean"] == pytest.approx(expected_mean, abs=0.01)


def _rain_with_marked_boundary(missing_cell: bool = False) -> SeriesDataset:
    """Return rain with a distinct western edge and an optional missing interior cell."""

    class MarkedRain(type(RAIN)):
        def read_step(
            self,
            step: str,
            bbox: Bbox,
            factor: int = 1,
        ) -> np.ndarray:
            """Return a known field for checking touched-cell masking and statistics."""
            res = self.grid.res * factor
            height = round((bbox[3] - bbox[1]) / res)
            width = round((bbox[2] - bbox[0]) / res)
            raster = np.full((height, width), 10, "float32")
            raster[:, 0] = 50
            if missing_cell:
                raster[5, 5] = np.nan
            return raster

    return MarkedRain(**{**vars(RAIN), "backend": EmptyFallbackSource()})


class EmptyFallbackSource(SyntheticSource):
    """Keep main-source gaps unfilled by returning no values from fallback cubes."""

    def read_cube(self, spec: CubeSpec, month: str, window: CellWindow) -> np.ndarray:
        return np.full((window[3], window[2]), np.nan, "float32")


def test_area_statistics_follow_the_touched_cells(tmp_path):
    marked = _rain_with_marked_boundary()
    off_grid = box(36.54, -1.46, 37.46, -0.54)
    build_scene(HASH_A, Area(off_grid, BOUNDARY), "2015-01", "2015-01", [marked], "Test", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    width = 20
    expected_mean = (50 + 10 * (width - 1)) / width

    assert doc["layers"][0]["stats"]["max"] == 50
    assert doc["layers"][0]["stats"]["mean"] == pytest.approx(expected_mean, abs=0.01)


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


def test_layer_notices_see_the_planned_steps():
    class Noting(type(RAIN)):
        def notices(self, bbox: Bbox, steps: list[str]) -> list[str]:
            return [f"{len(steps)} steps from {steps[0]}"]

    noting = Noting(**vars(RAIN))

    scene_plan = plan_months(Area(NAIROBI, BOUNDARY), [noting], months=3)

    assert scene_plan.layers[noting.id].notices == ["3 steps from 1990-01-01"]


def test_temperature_below_zero_survives_the_bundle(tmp_path):
    cold = box(10, 55.5, 11, 56.5)  # synthetic October at 56 degrees north is about -8
    temperature = make_registry(SyntheticSource())["era5land_temperature"]
    build_scene(HASH_A, Area(cold, BOUNDARY), "2015-10", "2015-10", [temperature], "Test", tmp_path)
    root = zarr.open_group(tmp_path / HASH_A / "data.zarr", mode="r")
    t2m = root["era5land_temperature/t2m"]

    inside = root["era5land_temperature/mask"][...] == 1
    decoded = t2m[0][inside] * t2m.attrs["scale_factor"]

    assert t2m.dtype == "int16" and (decoded < -5).all()


def test_temperature_layer_states_mean_and_its_own_grid(tmp_path):
    temperature = make_registry(SyntheticSource())["era5land_temperature"]
    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), "2015-01", "2015-03", [temperature], "T", tmp_path)

    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    layer = doc["layers"][0]

    assert layer["time"]["method"] == "mean"
    assert layer["grid"]["res"] == 0.1
    assert layer["grid"]["bbox"] == pytest.approx([36.45, -1.55, 37.55, -0.45])
    assert layer["arrays"]["value"]["dtype"] == "int16"


def test_scene_with_preliminary_months_carries_the_notice(tmp_path):
    temperature = make_registry(SyntheticSource())["era5land_temperature"]
    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), "2026-06", "2026-08", [temperature], "T", tmp_path)

    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))

    assert doc["notices"]["limits"][0] == (
        "Temperature 2026-07 to 2026-08 is preliminary ERA5-Land or ERA5 data; final data "
        "replaces it about two months later, and the scene then gets a new id."
    )


def rain_with_gaps(
    gaps_in: Callable[[str], list[tuple[int, int]]],
    backend: SyntheticSource | None = None,
) -> SeriesDataset:
    """Return 10 mm rainfall except at the row-column pairs listed by `gaps_in(step)`."""

    class GappyRain(type(RAIN)):
        def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
            res = self.grid.res * factor
            raster = np.full(
                (round((bbox[3] - bbox[1]) / res), round((bbox[2] - bbox[0]) / res)),
                10,
                "float32",
            )
            for row, column in gaps_in(step):
                raster[row, column] = np.nan
            return raster

    return GappyRain(**{**vars(RAIN), "backend": backend or SyntheticSource()})


def build_rain(
    tmp_path: Path,
    rain: SeriesDataset,
    area: Area | None = None,
) -> tuple[JsonObject, zarr.Group]:
    """Build two months of `rain` over Nairobi; return scene.json and the opened Zarr store."""
    area = area or Area(NAIROBI, BOUNDARY)
    build_scene(HASH_A, area, "2015-01", "2015-02", [rain], "Test", tmp_path)
    document = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    return document, zarr.open_group(tmp_path / HASH_A / "data.zarr", mode="r")


def test_gap_cells_take_the_fallback_value_and_finite_cells_keep_theirs(tmp_path):
    rain = rain_with_gaps(lambda step: [(3, 4)])

    document, root = build_rain(tmp_path, rain)

    precip = root["chirps_monthly/precip"]
    expected = rain.read_step_filled("2015-01-01", document["layers"][0]["grid"]["bbox"]).values
    decoded = precip[0] * precip.attrs["scale_factor"]
    assert np.allclose(decoded, expected, atol=0.051)
    assert 40 <= expected[3, 4] <= 100
    assert (np.delete(decoded.ravel(), 3 * 20 + 4) == 10).all()


def test_source_array_codes_main_fallback_and_both(tmp_path):
    def gaps_in(step: str) -> list[tuple[int, int]]:
        return [(3, 4), (5, 6)] if step == "2015-01-01" else [(3, 4)]

    document, root = build_rain(tmp_path, rain_with_gaps(gaps_in))
    codes = root["chirps_monthly/source"][...]
    block = document["layers"][0]["arrays"]["source"]

    assert block["dtype"] == "uint8" and block["fill"] == 0
    assert codes.dtype == "uint8"
    assert root["chirps_monthly/source"].attrs["flag_values"] == [1, 2, 3]
    assert (codes[3, 4], codes[5, 6], codes[0, 0]) == (2, 3, 1)


def test_source_array_is_zero_outside_the_area(tmp_path):
    triangle = Area(Polygon([(36.5, -1.5), (37.5, -1.5), (37.5, -0.5)]), BOUNDARY)

    _, root = build_rain(tmp_path, rain_with_gaps(lambda step: [(0, 0), (19, 19)]), triangle)

    outside = root["chirps_monthly/mask"][...] == 0
    assert outside.any() and (root["chirps_monthly/source"][...][outside] == 0).all()


def test_fallback_is_credited_and_noticed_with_its_cell_counts(tmp_path):
    document, _ = build_rain(tmp_path, rain_with_gaps(lambda step: [(3, 4), (5, 6)]))
    layer = document["layers"][0]

    assert [source["name"] for source in layer["fallback_sources"]] == [SOURCES["era5"]["name"]]
    assert document["credits"]["lines"].count(SOURCES["era5"]["attribution"]) == 1
    assert document["notices"]["limits"][-1].startswith("Rainfall uses ERA5 model rain")
    assert "in 2 of 400 cells" in document["notices"]["limits"][-1]
    assert validate(document) == []


def test_statistics_count_the_filled_cells(tmp_path):
    every_cell = [(row, column) for row in range(20) for column in range(20)]

    document, _ = build_rain(tmp_path, rain_with_gaps(lambda step: every_cell))

    stats = document["layers"][0]["stats"]
    assert 40 <= stats["min"] <= stats["max"] <= 100


def test_scene_without_gaps_carries_no_trace_of_the_fallback(tmp_path):
    document, root = build_rain(tmp_path, rain_with_gaps(lambda step: []))
    layer = document["layers"][0]

    assert "source" not in layer["arrays"] and "source" not in root["chirps_monthly"]
    assert "fallback_sources" not in layer and document["notices"]["limits"] == []
    assert SOURCES["era5"]["attribution"] not in document["credits"]["lines"]


def test_cell_with_no_value_from_either_source_stays_empty_and_is_counted(tmp_path):
    rain = rain_with_gaps(lambda step: [(3, 4)], EmptyFallbackSource())

    document, root = build_rain(tmp_path, rain)

    assert root["chirps_monthly/precip"][0][3, 4] == 65535
    assert document["notices"]["limits"] == [
        "Rainfall has no value from either source in 1 of 400 cells in some months.",
    ]
    assert "source" not in root["chirps_monthly"]


def test_temperature_gaps_take_era5_and_keep_land_values(tmp_path):
    temperature = make_registry(SyntheticSource())["era5land_temperature"]
    bbox = [36.45, -1.55, 37.55, -0.45]
    land = temperature.read_step("2015-01-01", bbox)
    filled = temperature.read_step_filled("2015-01-01", bbox)

    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), "2015-01", "2015-01", [temperature], "T", tmp_path)
    root = zarr.open_group(tmp_path / HASH_A / "data.zarr", mode="r")
    t2m = root["era5land_temperature/t2m"]
    decoded = t2m[0] * t2m.attrs["scale_factor"]
    codes = root["era5land_temperature/source"][...]

    assert np.isnan(land).any() and filled.filled.any()
    assert np.allclose(decoded[~np.isnan(land)], land[~np.isnan(land)], atol=0.051)
    assert np.array_equal(codes == 2, np.isnan(land))


def prepared_local_revisions(dataset: SeriesDataset) -> dict[str, str | None]:
    return {dataset.id: dataset.local_revision(dataset.steps("2015-01-01", "2015-03-01"))}


@pytest.mark.parametrize("layer_id", ["chirps_monthly", "era5land_temperature"])
def test_build_refuses_a_scene_whose_source_changed_while_it_was_queued(tmp_path, layer_id):
    source = ReingestedSource()
    dataset = make_registry(source)[layer_id]
    expected = prepared_local_revisions(dataset)

    source.reingest()

    with pytest.raises(SourceChanged):
        build_scene(
            HASH_A,
            Area(NAIROBI, BOUNDARY),
            "2015-01",
            "2015-02",
            [dataset],
            "T",
            tmp_path,
            local_revisions=expected,
        )

    assert source.reads == 0
    assert not (tmp_path / HASH_A).exists()


@pytest.mark.parametrize("layer_id", ["chirps_monthly", "era5land_temperature"])
def test_build_publishes_nothing_when_the_source_changes_between_months(tmp_path, layer_id):
    source = ReingestedSource(reads_before_reingest=1)
    dataset = make_registry(source)[layer_id]
    expected = prepared_local_revisions(dataset)

    with pytest.raises(SourceChanged):
        build_scene(
            HASH_A,
            Area(NAIROBI, BOUNDARY),
            "2015-01",
            "2015-02",
            [dataset],
            "T",
            tmp_path,
            local_revisions=expected,
        )

    assert source.reads >= 1
    assert not (tmp_path / HASH_A).exists()
    assert not list((tmp_path / ".tmp").iterdir())


def test_build_with_unchanged_local_revisions_publishes(tmp_path):
    source = SyntheticSource()
    rain = make_registry(source)["chirps_monthly"]

    build_scene(
        HASH_A,
        Area(NAIROBI, BOUNDARY),
        "2015-01",
        "2015-02",
        [rain],
        "T",
        tmp_path,
        local_revisions=prepared_local_revisions(rain),
    )

    assert (tmp_path / HASH_A / "scene.json").exists()


def test_preliminary_rain_months_without_fallback_use_carry_no_rain_notice(tmp_path):
    rain = rain_with_gaps(lambda step: [])
    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), "2026-06", "2026-08", [rain], "T", tmp_path)

    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))

    assert doc["notices"]["limits"] == []


def test_preliminary_rain_months_filled_by_the_fallback_carry_the_notice(tmp_path):
    rain = rain_with_gaps(lambda step: [(3, 4)] if step.startswith("2026-07") else [])
    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), "2026-06", "2026-08", [rain], "T", tmp_path)

    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))

    assert (
        "The ERA5 rain that fills gaps in Rainfall 2026-07 is preliminary; final data "
        "replaces it about two months later, and the scene then gets a new id."
    ) in doc["notices"]["limits"]


def test_preliminary_rain_filled_only_outside_the_area_carries_no_fallback_notice(tmp_path):
    rain = rain_with_gaps(lambda step: [(0, 19)])
    area = Area(TRIANGLE, BOUNDARY)
    build_scene(HASH_A, area, "2026-07", "2026-08", [rain], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    root = zarr.open_group(tmp_path / HASH_A / "data.zarr", mode="r")

    assert root["chirps_monthly/mask"][0, 19] == 0
    assert doc["notices"]["limits"] == []
    assert "source" not in root["chirps_monthly"]
    assert "fallback_sources" not in doc["layers"][0]
    assert SOURCES["era5"]["attribution"] not in doc["credits"]["lines"]


def test_preliminary_rain_gaps_the_fallback_cannot_fill_carry_only_the_missing_notice(tmp_path):
    rain = rain_with_gaps(lambda step: [(3, 4)], EmptyFallbackSource())
    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), "2026-07", "2026-08", [rain], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))

    assert doc["notices"]["limits"] == [
        "Rainfall has no value from either source in 1 of 400 cells in some months.",
    ]
    assert "source" not in doc["layers"][0]["arrays"]
    assert "fallback_sources" not in doc["layers"][0]


@pytest.mark.parametrize("preliminary_gaps", [[], [(0, 19)]])
def test_final_rain_fills_do_not_trigger_a_notice_for_unfilled_preliminary_months(
    tmp_path,
    preliminary_gaps,
):
    rain = rain_with_gaps(
        lambda step: [(10, 3)] if step.startswith("2026-06") else preliminary_gaps,
    )
    build_scene(HASH_A, Area(TRIANGLE, BOUNDARY), "2026-06", "2026-08", [rain], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))

    assert len(doc["notices"]["limits"]) == 1
    assert doc["notices"]["limits"][0].startswith("Rainfall uses ERA5 model rain")
    assert "source" in doc["layers"][0]["arrays"]


def test_preliminary_rain_fill_in_a_later_batch_keeps_its_month_in_the_notice(tmp_path):
    rain = rain_with_gaps(lambda step: [(3, 4)] if step.startswith("2026-07") else [])
    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), "2025-06", "2026-08", [rain], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    preliminary = [notice for notice in doc["notices"]["limits"] if "preliminary" in notice]

    assert preliminary == [
        "The ERA5 rain that fills gaps in Rainfall 2026-07 is preliminary; final data "
        "replaces it about two months later, and the scene then gets a new id.",
    ]
