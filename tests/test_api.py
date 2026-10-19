"""API tests with FastAPI's TestClient and the synthetic source (no network)."""
import json
import threading
import time
from dataclasses import replace

import numpy as np
import pytest
import zarr
from fastapi import FastAPI
from fastapi.testclient import TestClient
from shapely.geometry import box, mapping, shape

from soe import db
from soe.api import QUEUE_RETRY_AFTER_SECS, SOURCE_RETRY_AFTER_SECS, create_app
from soe.bundle import SYNTHETIC_DATA_CREDIT, JsonObject
from soe.scene_request import ID_CHARS
from soe.sources import (
    CellWindow,
    CubeSpec,
    RealSource,
    SourceUnavailable,
    SyntheticSource,
    make_registry,
)
from tests.helpers import FIJI, ReingestedSource, boundary_row, write_cube

POLL_ATTEMPTS = 100
POLL_INTERVAL_SECS = 0.1
SQUARE = mapping(box(36.5, -1.5, 37.5, -0.5))


@pytest.fixture
def env(tmp_path):
    source = SyntheticSource()
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(source))
    with TestClient(app) as client:
        geometry = box(36.5, -1.5, 37.5, -0.5)
        nairobi = boundary_row(
            "cgaz:ADM1:NBO",
            "state",
            "Nairobi",
            "Kenya",
            "KEN",
            geometry.bounds,
            geometry=json.dumps(mapping(geometry)),
        )
        washington = boundary_row("cgaz:ADM2:WA", "county", "Washington County", "Maine", "USA")
        db.add_boundaries(
            str(tmp_path / "soe.db"),
            "geoBoundaries CGAZ",
            [nairobi, washington],
        )
        yield client, source, tmp_path


def test_health_and_search(env):
    client, _, _ = env
    assert client.get("/api/health").json()["ok"] is True

    hits = client.get("/api/areas/search", params={"q": "nair"}).json()
    assert hits[0]["id"] == "cgaz:ADM1:NBO" and hits[0]["parent_name"] == "Kenya"

    county = client.get("/api/areas/search", params={"q": "county"}).json()[0]
    assert county["name"] == "Washington County"

    assert client.get("/api/areas/search", params={"q": "x", "level": "planet"}).status_code == 422

    assert "geometry" in client.get("/api/areas/cgaz:ADM1:NBO").json()
    assert client.get("/api/areas/nope").status_code == 404


def test_post_poll_and_serve(env):
    client, source, _ = env
    response = client.post("/api/scenes", json=body())
    scene_id = response.json()["id"]
    assert response.status_code == 202

    done = wait_for(client, scene_id)
    assert done["status"] == "done", done

    scene = client.get(done["bundle_url"]).json()
    assert scene["credits"]["lines"] and scene["id"] == scene_id
    assert [layer["id"] for layer in scene["layers"]] == ["terrain", "chirps_monthly"]
    terrain = scene["layers"][0]
    assert scene["version"] == "0.5" and terrain["arrays"] == {} and terrain["stats"]["p98"] > 0
    assert terrain["tiles"]["source"]["attribution"] in scene["credits"]["lines"]
    assert client.get(f"/scenes/{scene_id}/scene.json").json()["id"] == scene_id

    assert client.get(f"/scenes/{scene_id}/data.zarr/zarr.json").status_code == 200
    assert client.get(f"/scenes/.tmp/{scene_id}/scene.json").status_code == 404

    # Immutable bundles must be reusable without new reads.
    reads = source.reads
    repeat = client.post("/api/scenes", json=body())

    assert repeat.status_code == 200 and repeat.json()["id"] == scene_id
    assert len(scene_id) == ID_CHARS
    assert source.reads == reads

    jittered = body()
    jittered["area"]["geometry"] = mapping(box(36.50001, -1.5, 37.5, -0.50001))

    assert client.post("/api/scenes", json=jittered).json()["id"] == scene_id

    reordered = body()
    reordered["area"]["geometry"] = {
        "type": "Polygon",
        "coordinates": [
            [[37.5, -0.5], [37.5, -1.5], [36.5, -1.5], [36.5, -0.5], [37.5, -0.5]],
        ],
    }

    assert client.post("/api/scenes", json=reordered).json()["id"] == scene_id

    # Bundles are content-addressed, so they are served as immutable.
    assert "immutable" in client.get(f"/scenes/{scene_id}/scene.json").headers["cache-control"]


def body(**overrides: object) -> JsonObject:
    """Make a six-month Nairobi polygon request with optional overrides."""
    return {
        "area": {"type": "polygon", "geometry": SQUARE},
        "start": "2015-01",
        "end": "2015-06",
        "layers": ["terrain", "chirps_monthly"],
        **overrides,
    }


def wait_for(client: TestClient, scene_id: str, wanted_status: str = "done") -> JsonObject:
    """Poll until the scene reaches the wanted status or fails; raise on timeout."""
    for _ in range(POLL_ATTEMPTS):
        scene = client.get(f"/api/scenes/{scene_id}").json()
        if scene["status"] in (wanted_status, "failed"):
            return scene
        time.sleep(POLL_INTERVAL_SECS)
    raise AssertionError("timeout")


def test_series_without_steps_is_refused_before_any_read(tmp_path):
    source = SyntheticSource()
    registry = make_registry(source)
    registry["chirps_monthly"] = no_steps_rain = replace(registry["chirps_monthly"])
    no_steps_rain.steps = lambda start, end: []
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", registry)

    with TestClient(app) as client:
        response = client.post("/api/scenes", json=body())

    assert response.status_code == 422
    assert "no data in the requested period" in response.text
    assert source.reads == 0


def test_boundary_scene(env):
    client, _, _ = env

    nairobi = {"type": "boundary", "id": "cgaz:ADM1:NBO"}
    response = client.post("/api/scenes", json={**body(), "area": nairobi})
    assert response.status_code == 202

    done = wait_for(client, response.json()["id"])
    scene = client.get(done["bundle_url"]).json()
    assert done["status"] == "done"
    assert scene["area"]["boundary"]["attribution"].startswith("Boundaries:")
    assert SYNTHETIC_DATA_CREDIT in scene["credits"]["lines"]

    unknown = {"type": "boundary", "id": "zzz"}
    assert client.post("/api/scenes", json={**body(), "area": unknown}).status_code == 422


def test_rejections_happen_before_any_read(env):
    client, source, _ = env
    tiny = mapping(box(36.8, -1.1, 36.9, -1.0))  # about 10 km: too small

    cases = [
        {"area": {"type": "polygon", "geometry": tiny}},
        {"start": "1980-01"},
        {"start": "2016-01", "end": "2015-01"},
        {"end": "2030-01"},
        {"layers": ["lava"]},
        {"layers": ["rain"]},
        {"area": {"type": "polygon", "geometry": {"type": "Point", "coordinates": [0, 0]}}},
        {
            "area": {"type": "polygon", "geometry": mapping(box(-60, -20, 40, 10))},
            "start": "1981-01",
            "end": "2026-08",
        },
        {
            "area": {"type": "polygon", "geometry": mapping(box(-100, -50, 70, 60))},
            "layers": ["terrain"],
        },
    ]

    for extra in cases:
        response = client.post("/api/scenes", json={**body(), **extra})
        assert response.status_code == 422, (extra, response.text)

    assert source.reads == 0


def test_non_ascii_digit_months_are_rejected_before_any_read(env):
    client, source, _ = env

    for month in ("2020-0\u00b2", "\u0662020-01", "2020-\u0660\u0661"):
        for field in ("start", "end"):
            response = client.post("/api/scenes", json=body(**{field: month}))

            assert response.status_code == 422, (field, month)
            assert response.json()["detail"] == "start and end must be 'YYYY-MM'"

    assert source.reads == 0


def test_body_cap_and_bad_json(env):
    client, _, _ = env
    assert client.post("/api/scenes", content=b"x" * 1_100_000).status_code == 413
    assert client.post("/api/scenes", content=b"{nope").status_code == 422
    assert client.post("/api/scenes", json=[1]).status_code == 422


def test_scene_id_must_be_hex(env):
    client, _, _ = env
    assert client.get("/api/scenes/../etc").status_code == 404
    assert client.get("/api/scenes/" + "Z" * ID_CHARS).status_code == 404
    assert client.get("/api/scenes/" + "0" * ID_CHARS).status_code == 404


def test_malformed_requests_are_4xx_not_500(env):
    client, _, _ = env
    huge_int = body()
    huge_int["area"]["geometry"] = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [10 ** 400, 0], [1, 1], [0, 0]]],
    }

    response = client.post("/api/scenes", content=json.dumps(huge_int))
    assert response.status_code == 422

    for deep in (b"[" * 400_000, b'{"area":' * 100_000):
        assert client.post("/api/scenes", content=deep).status_code == 422

    nested = body()
    nested["area"]["geometry"] = {
        "type": "Polygon",
        "coordinates": json.loads("[" * 50 + "]" * 50),
    }

    assert client.post("/api/scenes", json=nested).status_code == 422

    response = client.post("/api/scenes", content=b"{}", headers={"content-length": "abc"})
    assert 400 <= response.status_code < 500


def test_queue_full_gives_503_and_unreachable_source_gives_503(tmp_path):
    gate = threading.Event()

    class Slow(SyntheticSource):
        def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
            gate.wait(10)
            return super().read_rain(month, window)

    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(Slow()), max_queue=1)
    with TestClient(app) as client:
        first = client.post("/api/scenes", json=body())
        assert first.status_code == 202

        second = client.post("/api/scenes", json=body(end="2015-07"))
        assert second.status_code == 503
        assert second.headers["retry-after"] == str(QUEUE_RETRY_AFTER_SECS)

        assert client.post("/api/scenes", json=body()).status_code == 202  # same job: not a new one

        gate.set()
        assert wait_for(client, first.json()["id"])["status"] == "done"

    class Down(SyntheticSource):
        def current_revision(self, month: str) -> str:
            raise SourceUnavailable("down")

    app = create_app(tmp_path / "b.db", tmp_path / "scenes2", make_registry(Down()))
    with TestClient(app) as client:
        response = client.post("/api/scenes", json=body())
        assert response.status_code == 503
        assert response.headers["retry-after"] == str(SOURCE_RETRY_AFTER_SECS)


def test_built_scene_is_served_again_when_the_source_goes_down(
    tmp_path,
    monkeypatch,
    revision_source,
):
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(revision_source))
    with TestClient(app) as client:
        first = client.post("/api/scenes", json=body())
        assert wait_for(client, first.json()["id"])["status"] == "done"

        monkeypatch.setattr("soe.scene_request.REVISION_FRESH_SECS", 0)
        revision_source.down = True
        again = client.post("/api/scenes", json=body())

        assert again.status_code == 200
        assert again.json()["id"] == first.json()["id"]


def test_job_queued_before_a_cube_update_fails_with_a_request_again_message(tmp_path):
    gate = threading.Event()

    class Slow(ReingestedSource):
        def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
            gate.wait(10)
            return super().read_rain(month, window)

    source = Slow()
    app = create_app(
        tmp_path / "soe.db",
        tmp_path / "scenes",
        make_registry(source),
        max_builds=1,
    )
    with TestClient(app) as client:
        client.post("/api/scenes", json=body())
        queued_id = client.post("/api/scenes", json=body(end="2015-07")).json()["id"]

        source.reingest()
        gate.set()
        out = wait_for(client, queued_id)

        assert out["status"] == "failed"
        assert out["error"] == (
            "The data changed while the scene was waiting; request the scene again."
        )
        assert not (tmp_path / "scenes" / queued_id).exists()


def test_failed_job_has_generic_error_and_class(tmp_path):
    class Boom(SyntheticSource):
        def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
            raise RuntimeError("secret path C:/x/y")

    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(Boom()))
    with TestClient(app) as client:
        scene_id = client.post("/api/scenes", json=body()).json()["id"]
        out = wait_for(client, scene_id)

        assert out["status"] == "failed" and out["error_class"] == "RuntimeError"
        assert "secret" not in out["error"]


def test_layers(env):
    client, _, _ = env
    out = client.get("/api/layers").json()
    by_id = {layer["id"]: layer for layer in out["layers"]}
    rain, terrain = by_id["chirps_monthly"], by_id["terrain"]

    assert out["default"] == ["chirps_monthly", "terrain"]
    assert out["request_step"] == "P1M"
    assert (rain["kind"], rain["time_varying"]) == ("field", True)
    assert rain["time"] == {"step": "P1M", "first": "1981-01", "last": "2026-08"}
    assert (terrain["kind"], terrain["time_varying"], terrain["time"]) == ("terrain", False, None)
    assert rain["title"] == "Rainfall" and rain["units"] == "mm/month"
    assert rain["coverage"] == [-180, -60, 180, 60]
    assert terrain["coverage"] == [-180, -60, 180, 60]


def test_layers_list_omits_rain_and_temperature_without_their_cubes(tmp_path):
    source = RealSource(latest="2026-08", cubes_dir=tmp_path / "cubes")
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(source))

    with TestClient(app) as client:
        ids = [layer["id"] for layer in client.get("/api/layers").json()["layers"]]

    assert ids == ["terrain", "esa_worldcover"]


def test_layers_list_survives_an_empty_cube_left_by_a_failed_ingest(tmp_path):
    zarr.create_group(tmp_path / "cubes" / "era5land_temperature.zarr", attributes={"months": {}})
    source = RealSource(latest="2026-08", cubes_dir=tmp_path / "cubes")
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(source))

    with TestClient(app) as client:
        response = client.get("/api/layers")

    assert response.status_code == 200
    assert "era5land_temperature" not in [layer["id"] for layer in response.json()["layers"]]


def test_layers_list_omits_rain_without_its_fallback_cube(tmp_path):
    cubes = tmp_path / "cubes"
    write_cube(cubes, "era5land_temperature", 0)
    write_cube(cubes, "era5_temperature", 0)
    source = RealSource(latest="2026-08", cubes_dir=cubes)
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(source))

    with TestClient(app) as client:
        ids = [layer["id"] for layer in client.get("/api/layers").json()["layers"]]

    assert ids == ["terrain", "esa_worldcover", "era5land_temperature"]


@pytest.mark.parametrize(
    ("cube_name", "left_out"),
    [
        ("era5land_temperature", "era5land_temperature"),
        ("era5_temperature", "era5land_temperature"),
        ("era5_precipitation", "chirps_monthly"),
    ],
)
def test_layers_list_leaves_out_a_layer_while_one_of_its_cubes_is_updating(
    tmp_path,
    cube_name,
    left_out,
):
    cubes = tmp_path / "cubes"
    for name in ("era5land_temperature", "era5_temperature", "era5_precipitation"):
        write_cube(cubes, name, 0)

    source = RealSource(latest="2026-08", cubes_dir=cubes)
    registry = make_registry(source)
    zarr.open_group(cubes / f"{cube_name}.zarr", mode="a").attrs["pending"] = ["2016-01"]

    with TestClient(create_app(tmp_path / "soe.db", tmp_path / "scenes", registry)) as client:
        response = client.get("/api/layers")

    assert left_out in registry
    assert response.status_code == 200
    ids = [layer["id"] for layer in response.json()["layers"]]
    assert left_out not in ids and len(ids) == len(registry) - 1


def test_request_without_layers_builds_the_defaults_not_temperature(tmp_path):
    class LateCube(SyntheticSource):
        def cube_months(self, spec: CubeSpec) -> dict[str, str]:
            if spec.name == "era5_precipitation":
                return super().cube_months(spec)

            return {"2016-01": "0001:a", "2016-02": "0001:b"}

    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(LateCube()))
    request = body()
    del request["layers"]

    with TestClient(app) as client:
        response = client.post("/api/scenes", json=request)
        done = wait_for(client, response.json()["id"])
        layers = client.get(done["bundle_url"]).json()["layers"]

    assert response.status_code == 202
    assert sorted(layer["id"] for layer in layers) == ["chirps_monthly", "terrain"]


def test_temperature_period_before_the_cube_start_is_refused_before_any_read(tmp_path):
    class LateCube(SyntheticSource):
        def cube_months(self, spec: CubeSpec) -> dict[str, str]:
            return {"2016-01": "0001:a", "2016-02": "0001:b"}

    source = LateCube()
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(source))

    with TestClient(app) as client:
        response = client.post(
            "/api/scenes",
            json=body(layers=["era5land_temperature"], start="2015-12", end="2016-02"),
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "Temperature: start must be 2016-01 or later"
    assert source.reads == 0


def test_layers_list_request_bounds_in_request_granularity(env):
    client, _, _ = env

    rain = next(layer for layer in client.get("/api/layers").json()["layers"] if layer["time"])

    assert (rain["time"]["first"], rain["time"]["last"]) == ("1981-01", "2026-08")


def test_area_geometry_is_in_the_same_frame_as_its_bbox(env):
    client, _, tmp_path = env
    fiji = boundary_row(
        "cgaz:ADM0:FJI",
        "country",
        "Fiji",
        iso3="FJI",
        bbox=(178, -19, 182, -17),
        geometry=json.dumps(mapping(FIJI)),
    )
    db.add_boundaries(str(tmp_path / "soe.db"), "geoBoundaries CGAZ", [fiji])

    area = client.get("/api/areas/cgaz:ADM0:FJI").json()
    west, _, east, _ = area["bbox"]
    shape_west, _, shape_east, _ = shape(area["geometry"]).bounds

    assert west <= shape_west and shape_east <= east
    assert shape_east == 182


def test_sample_areas_seed_only_in_synthetic_mode_and_when_empty(tmp_path, monkeypatch):
    monkeypatch.delenv("SOE_SYNTHETIC", raising=False)

    def app_in(name: str) -> FastAPI:
        return create_app(
            tmp_path / name / "soe.db",
            tmp_path / name / "scenes",
            make_registry(SyntheticSource()),
        )

    def sample_ids(client: TestClient) -> set[str]:
        names = ["Kenya", "Fiji", "Nairobi", "Cusco", "Burkina"]
        hits = [client.get("/api/areas/search", params={"q": name}).json() for name in names]
        return {hit["id"] for found in hits for hit in found if hit["id"].startswith("sample:")}

    with TestClient(app_in("real")) as client:
        assert sample_ids(client) == set()

    monkeypatch.setenv("SOE_SYNTHETIC", "1")
    with TestClient(app_in("synthetic")) as client:
        assert sample_ids(client) == {
            "sample:kenya",
            "sample:fiji",
            "sample:nairobi",
            "sample:cusco",
            "sample:burkina-faso",
        }

        assert client.get("/api/areas/sample:fiji").json()["bbox"][2] > 180

        nairobi = {"type": "boundary", "id": "sample:nairobi"}
        posted = client.post(
            "/api/scenes",
            json={"area": nairobi, "start": "2015-01", "end": "2015-02"},
        )
        scene_id = posted.json()["id"]

        assert wait_for(client, scene_id)["status"] == "done"

    db_path = str(tmp_path / "other" / "soe.db")  # a non-empty table is left alone
    db.init(db_path)
    db.add_boundaries(db_path, "geoBoundaries CGAZ", [boundary_row("x", "state", "Other")])

    with TestClient(app_in("other")) as client:
        assert sample_ids(client) == set()


def test_startup_survives_a_failing_latest_month_warmup(tmp_path):
    class BrokenSource(SyntheticSource):
        def latest_month(self) -> str:
            raise RuntimeError("network down")

    registry = make_registry(SyntheticSource())
    registry["chirps_monthly"] = replace(registry["chirps_monthly"], backend=BrokenSource())

    with TestClient(create_app(tmp_path / "soe.db", tmp_path / "scenes", registry)) as client:
        assert client.get("/api/health").json()["ok"] is True


def test_terrain_only_ignores_months(env):
    client, _, _ = env
    periods = (("2015-01", "2015-02"), ("2020-05", "2020-09"))
    ids = {
        client.post(
            "/api/scenes",
            json=body(layers=["terrain"], start=start, end=end),
        ).json()["id"]
        for start, end in periods
    }

    assert len(ids) == 1
    assert wait_for(client, ids.pop())["status"] == "done"


def test_month_range_is_checked_per_dataset(tmp_path):
    source = SyntheticSource()
    registry = make_registry(source)
    late = replace(registry["chirps_monthly"], id="late_rain", title="Late rain")
    late.first = lambda: "2000-01"
    registry["late_rain"] = late

    with TestClient(create_app(tmp_path / "soe.db", tmp_path / "scenes", registry)) as client:
        both = body(layers=["chirps_monthly", "late_rain"], start="1999-01", end="2000-03")
        response = client.post("/api/scenes", json=both)

        assert response.status_code == 422
        assert response.json()["detail"] == "Late rain: start must be 2000-01 or later"

        early_only = body(layers=["chirps_monthly"], start="1999-01", end="2000-03")
        assert client.post("/api/scenes", json=early_only).status_code == 202


def test_status_has_a_stage_while_building_and_null_when_done(tmp_path):
    release, reading = threading.Event(), threading.Event()

    class Slow(SyntheticSource):
        def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
            reading.set()
            release.wait(10)
            return super().read_rain(month, window)

    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(Slow()))
    with TestClient(app) as client:
        scene_id = client.post("/api/scenes", json=body()).json()["id"]
        assert reading.wait(10)

        running = client.get(f"/api/scenes/{scene_id}").json()
        release.set()
        done = wait_for(client, scene_id)

    assert running["status"] == "running" and running["stage"].startswith("Terrain")
    assert done["status"] == "done" and done["stage"] is None and done["progress"] == 1.0


def test_failed_build_clears_the_stage(tmp_path):
    class Boom(SyntheticSource):
        def read_rain(self, month: str, window: CellWindow) -> np.ndarray:
            raise RuntimeError("boom")

    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(Boom()))
    with TestClient(app) as client:
        scene_id = client.post("/api/scenes", json=body()).json()["id"]
        failed = wait_for(client, scene_id)

    assert failed["status"] == "failed" and failed["stage"] is None


def test_land_cover_builds_offline_and_is_not_a_default_layer(env):
    client, _, _ = env
    request = body(layers=["esa_worldcover"])
    scene_id = client.post("/api/scenes", json=request).json()["id"]

    assert wait_for(client, scene_id)["status"] == "done"
    assert "esa_worldcover" not in client.get("/api/layers").json()["default"]


def test_land_cover_over_open_sea_is_refused_before_any_read(tmp_path):
    class NoReads(SyntheticSource):
        def land_cover(self, *args: object) -> None:
            raise AssertionError("read before the refusal")

    sea = mapping(box(-150, 0, -148, 2))
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(NoReads()))

    with TestClient(app) as client:
        response = client.post(
            "/api/scenes",
            json=body(area={"type": "polygon", "geometry": sea}, layers=["esa_worldcover"]),
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "Land cover has no data in this area"
