"""Test lithology COG preparation and reads, registry behaviour and Geology bundles offline."""
import io
import json
import time
import urllib.request
from pathlib import Path

import numpy as np
import pytest
import rasterio
import zarr
from fastapi.testclient import TestClient
from rasterio.transform import from_origin
from shapely.geometry import box, mapping

from soe.api import create_app
from soe.areas import Area
from soe.build import build_scene
from soe.bundle import JsonObject, validate
from soe.ingest.cubes import DOWNLOADS_DIR
from soe.ingest.lithology import NORTH_EDGE_DEG, build_lithology_cog, ingest_lithology
from soe.scene_request import compute_scene_id
from soe.sources import RealSource, Registry, SourceUnavailable, SyntheticSource, make_registry
from soe.sources import lithology
from soe.sources.lithology import GEOLOGY_CLASSES, LITHOLOGY_FILE, WATER_CLASS
from soe.sources.licences import SOURCES
from tests.helpers import BOUNDARY, FIJI, HASH_A, NAIROBI, write_cube

SOURCE_RES_DEG = 0.5
WEST_CLASS, EAST_CLASS = 14, 5
UNDEFINED_COLUMN, WATER_COLUMN = 100, 101
POLL_ATTEMPTS = 100
POLL_INTERVAL_SECS = 0.1


@pytest.fixture(autouse=True)
def coarse_source(monkeypatch):
    """Make the test rasters, which have 0.5 degree cells, count as the native resolution."""
    monkeypatch.setattr(lithology, "LITHOLOGY_RES_DEG", SOURCE_RES_DEG)


def write_source_map(path: Path) -> None:
    """Write a 70°N-62°S map: class 14 west of 0, class 5 east of it and two odd columns."""
    columns, rows = 720, 264
    values = np.full((rows, columns), EAST_CLASS, "uint8")
    values[:, : columns // 2] = WEST_CLASS
    values[:, UNDEFINED_COLUMN] = lithology.UNDEFINED_CLASS
    values[:, WATER_COLUMN] = WATER_CLASS
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        dtype="uint8",
        count=1,
        width=columns,
        height=rows,
        crs="EPSG:4326",
        transform=from_origin(-180, 70, SOURCE_RES_DEG, SOURCE_RES_DEG),
        nodata=WATER_CLASS,
    ) as dataset:
        dataset.write(values, 1)


@pytest.fixture
def cubes_dir(tmp_path):
    folder = tmp_path / "cubes"
    folder.mkdir()
    write_source_map(tmp_path / "source.tif")
    build_lithology_cog(tmp_path / "source.tif", folder / LITHOLOGY_FILE)
    return folder


def write_edge_source(path: Path) -> np.ndarray:
    """Write a 70°N-60°S map of class 9 with bad edge columns; return its values.

    The first and last columns hold classes 1 and 14 like the bad edge columns of the real
    map, the second column alternates 9 and 5 by row, and column 5 holds class 2.
    """
    columns, rows = 12, 260
    values = np.full((rows, columns), 9, "uint8")
    values[:, 0] = 1
    values[:, -1] = 14
    values[:, 1] = np.where(np.arange(rows) % 2 == 0, 9, 5)
    values[:, 5] = 2
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        dtype="uint8",
        count=1,
        width=columns,
        height=rows,
        crs="EPSG:4326",
        transform=from_origin(-180, 70, SOURCE_RES_DEG, SOURCE_RES_DEG),
        nodata=WATER_CLASS,
    ) as dataset:
        dataset.write(values, 1)
    return values


def test_cog_covers_60_south_to_60_north_and_has_no_water_or_undefined_class(cubes_dir):
    with rasterio.open(cubes_dir / LITHOLOGY_FILE) as dataset:
        values = dataset.read(1)

        assert dataset.bounds.top == 60 and dataset.bounds.bottom == -60
        assert dataset.profile["tiled"] and dataset.nodata == 0

    assert (values[:, UNDEFINED_COLUMN] == 0).all() and (values[:, WATER_COLUMN] == 0).all()
    assert set(np.unique(values)) == {0, WEST_CLASS, EAST_CLASS}


def test_edge_columns_are_replaced_by_their_inner_neighbours(tmp_path):
    write_edge_source(tmp_path / "edge.tif")
    build_lithology_cog(tmp_path / "edge.tif", tmp_path / "cleaned.tif")
    with rasterio.open(tmp_path / "edge.tif") as source:
        skipped_rows = round((source.bounds.top - NORTH_EDGE_DEG) / SOURCE_RES_DEG)
        source_values = source.read(1)
    with rasterio.open(tmp_path / "cleaned.tif") as dataset:
        cleaned = dataset.read(1)

    assert (cleaned[:, 0] == source_values[skipped_rows:, 1]).all()
    assert (cleaned[:, -1] == source_values[skipped_rows:, -2]).all()
    assert (cleaned[:, 2:5] == 9).all()
    assert (cleaned[:, 5] == 2).all()
    assert (cleaned[:, 6:-1] == 9).all()


def test_failed_cog_build_leaves_no_partial_files(tmp_path):
    folder = tmp_path / "cubes"
    folder.mkdir()
    (tmp_path / "broken.tif").write_bytes(b"not a tiff")

    with pytest.raises(rasterio.errors.RasterioIOError):
        build_lithology_cog(tmp_path / "broken.tif", folder / LITHOLOGY_FILE)

    assert list(folder.iterdir()) == []


class _InterruptedBody(io.BytesIO):
    """Serve one partial chunk, then fail like a download that stops mid-stream."""

    def __init__(self) -> None:
        super().__init__(b"partial")

    def read(self, size: int | None = -1) -> bytes:
        chunk = super().read(size)
        if chunk:
            return chunk
        raise OSError("interrupted")


def test_interrupted_download_leaves_no_source_and_rerun_downloads_again(tmp_path, monkeypatch):
    write_source_map(tmp_path / "origin.tif")
    payload = (tmp_path / "origin.tif").read_bytes()
    attempts = []

    def fake_urlopen(url, timeout=None):
        attempts.append(url)
        if len(attempts) == 1:
            return _InterruptedBody()
        return io.BytesIO(payload)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cubes = tmp_path / "cubes"
    source = cubes / DOWNLOADS_DIR / "lithology-source.tif"

    with pytest.raises(OSError, match="interrupted"):
        ingest_lithology(cubes)

    assert not source.exists()
    assert list((cubes / DOWNLOADS_DIR).iterdir()) == []

    published = ingest_lithology(cubes)

    assert len(attempts) == 2
    assert source.exists()
    assert published == cubes / LITHOLOGY_FILE and published.exists()


def test_reader_gives_the_class_of_each_cell_and_no_data_as_zero(cubes_dir):
    reader = RealSource(cubes_dir=cubes_dir)
    classes, transform = reader.lithology((-2.0, -1.0, 4.0, 1.0), SOURCE_RES_DEG)

    assert classes.shape == (4, 12) and classes.dtype == np.uint8
    assert (classes[:, :4] == WEST_CLASS).all() and (classes[:, 4:] == EAST_CLASS).all()
    assert (transform.c, transform.f) == (-2.0, 1.0)


def test_reader_joins_the_two_sides_of_180_in_the_frame_of_the_bounds(cubes_dir):
    reader = RealSource(cubes_dir=cubes_dir)
    classes, _ = reader.lithology((178.0, -1.0, 182.0, 1.0), SOURCE_RES_DEG)

    assert (classes[:, :4] == EAST_CLASS).all() and (classes[:, 4:] == WEST_CLASS).all()


def test_reader_reports_one_block(cubes_dir):
    blocks = []
    reader = RealSource(cubes_dir=cubes_dir)
    reader.lithology((0.0, 0.0, 1.0, 1.0), SOURCE_RES_DEG, lambda: blocks.append(1))

    assert len(blocks) == 1


def test_unreadable_map_is_a_source_unavailable_error(tmp_path):
    (tmp_path / LITHOLOGY_FILE).write_bytes(b"not a tiff")

    with pytest.raises(SourceUnavailable):
        RealSource(cubes_dir=tmp_path).lithology((0.0, 0.0, 1.0, 1.0), SOURCE_RES_DEG)


def test_geology_is_registered_only_when_the_map_exists(tmp_path, cubes_dir):
    assert "geology" not in make_registry(RealSource(cubes_dir=tmp_path))
    assert "geology" in make_registry(RealSource(cubes_dir=cubes_dir))
    assert "geology" not in make_registry(SyntheticSource())
    assert "geology" in make_registry(SyntheticSource(lithology=True))


def test_scene_ids_do_not_change_when_the_map_is_added(tmp_path, cubes_dir):
    write_cube(tmp_path, "era5_precipitation", 0)
    write_cube(cubes_dir, "era5_precipitation", 0)

    def scene_id(folder: Path) -> str:
        registry = make_registry(RealSource(cubes_dir=folder))
        datasets = [registry["terrain"], registry["esa_worldcover"]]
        return compute_scene_id("poly:abc", ["terrain", "esa_worldcover"], None, datasets, {})

    assert scene_id(cubes_dir) == scene_id(tmp_path)


def test_lithology_version_change_only_renames_geology_scenes(monkeypatch, cubes_dir):
    plain_layers = ["terrain", "esa_worldcover"]
    registry = make_registry(RealSource(cubes_dir=cubes_dir))
    plain_id = _layered_scene_id(registry, plain_layers)
    geology_id = _layered_scene_id(registry, ["geology"])

    bumped_version = SOURCES["lithology"]["version"] + "-bumped"
    monkeypatch.setitem(SOURCES["lithology"], "version", bumped_version)
    bumped = make_registry(RealSource(cubes_dir=cubes_dir))

    assert _layered_scene_id(bumped, ["geology"]) != geology_id
    assert _layered_scene_id(bumped, plain_layers) == plain_id


def _layered_scene_id(registry: Registry, layers: list[str]) -> str:
    """Return the scene id of the registry's datasets named by `layers`."""
    datasets = [registry[layer_id] for layer_id in layers]
    return compute_scene_id("poly:abc", layers, None, datasets, {})


def test_class_values_are_unique_and_every_class_names_a_group():
    values = [entry["value"] for entry in GEOLOGY_CLASSES]

    assert len(set(values)) == len(values)
    assert {entry["group"] for entry in GEOLOGY_CLASSES} == {
        "Sediments",
        "Volcanic",
        "Plutonic",
        "Metamorphic",
        "Ice",
    }


def build_geology(tmp_path: Path, area: Area) -> JsonObject:
    registry = make_registry(SyntheticSource(lithology=True))
    build_scene(HASH_A, area, None, None, [registry["geology"]], "Test", tmp_path)
    return json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))


def test_geology_layer_is_valid_and_credits_the_lithology_map(tmp_path):
    doc = build_geology(tmp_path, Area(NAIROBI, BOUNDARY))
    layer = doc["layers"][0]

    assert validate(doc) == []
    assert layer["id"] == "geology" and layer["title"] == "Geology"
    assert layer["style"]["kind"] == "categorical" and layer["style"]["palette"] == "painted"
    assert layer["style"]["classes"][0]["group"] == "Sediments"
    assert SOURCES["lithology"]["attribution"] in doc["credits"]["lines"]
    assert any("CC BY-SA 4.0" in line for line in doc["credits"]["lines"])


def test_geology_notice_states_the_scale_of_the_source_map(tmp_path):
    doc = build_geology(tmp_path, Area(NAIROBI, BOUNDARY))

    assert any("1:3.75 million" in notice for notice in doc["notices"]["limits"])
    assert any("180° longitude" in notice for notice in doc["notices"]["limits"])
    assert any("stay uncoloured" in notice for notice in doc["notices"]["limits"])


def test_geology_keeps_only_known_classes_and_zero_outside_the_area(tmp_path):
    doc = build_geology(tmp_path, Area(FIJI, BOUNDARY))
    root = zarr.open_group(str(tmp_path / HASH_A / "data.zarr"), mode="r")
    classes = root["geology/class"][...]
    mask = root["geology/mask"][...]
    valid = {0, *(entry["value"] for entry in doc["layers"][0]["style"]["classes"])}

    assert (classes[mask == 0] == 0).all()
    assert set(np.unique(classes)) <= valid


def test_class_group_must_be_a_non_empty_string(tmp_path):
    doc = build_geology(tmp_path, Area(NAIROBI, BOUNDARY))
    doc["layers"][0]["style"]["classes"][0]["group"] = ""

    assert any("group must be a non-empty string" in problem for problem in validate(doc))


def request_body(**overrides: object) -> JsonObject:
    return {
        "area": {"type": "polygon", "geometry": mapping(box(36.5, -1.5, 37.5, -0.5))},
        "start": "2015-01",
        "end": "2015-06",
        "layers": ["geology"],
        **overrides,
    }


def test_geology_builds_offline_and_is_not_a_default_layer(tmp_path):
    source = SyntheticSource(lithology=True)
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(source))

    with TestClient(app) as client:
        scene_id = client.post("/api/scenes", json=request_body()).json()["id"]
        for _ in range(POLL_ATTEMPTS):
            status = client.get(f"/api/scenes/{scene_id}").json()["status"]
            if status in ("done", "failed"):
                break
            time.sleep(POLL_INTERVAL_SECS)
        layers = client.get("/api/layers").json()

    assert status == "done"
    assert "geology" in [layer["id"] for layer in layers["layers"]]
    assert "geology" not in layers["default"]


def test_geology_is_refused_before_any_read_when_the_map_is_not_ingested(tmp_path):
    class NoReads(SyntheticSource):
        def lithology(self, *args: object) -> None:
            raise AssertionError("read before the refusal")

    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(NoReads()))

    with TestClient(app) as client:
        response = client.post("/api/scenes", json=request_body())

    assert response.status_code == 422


def test_geology_over_open_sea_is_refused_before_any_read(tmp_path):
    class NoReads(SyntheticSource):
        def lithology(self, *args: object) -> None:
            raise AssertionError("read before the refusal")

    sea = mapping(box(-150, 0, -148, 2))
    app = create_app(
        tmp_path / "soe.db",
        tmp_path / "scenes",
        make_registry(NoReads(lithology=True)),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/scenes",
            json=request_body(area={"type": "polygon", "geometry": sea}),
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "Geology has no data in this area"
