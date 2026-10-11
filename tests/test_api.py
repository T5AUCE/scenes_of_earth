"""API tests with FastAPI's TestClient and the synthetic source (no network)."""
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import box, mapping

from soe import db
from soe.api import create_app
from soe.sources import SourceUnavailable, SyntheticSource, make_registry

SQUARE = mapping(box(36.5, -1.5, 37.5, -0.5))


def body(**kw):
    return {"area": {"type": "polygon", "geometry": SQUARE}, "start": "2015-01", "end": "2015-06",
            "layers": ["glo90_terrain", "chirps_monthly"], **kw}


def wait_for(client, sid, want="done"):
    for _ in range(100):
        r = client.get(f"/api/scenes/{sid}").json()
        if r["status"] in (want, "failed"):
            return r
        time.sleep(0.1)
    raise AssertionError("timeout")


@pytest.fixture
def env(tmp_path):
    src = SyntheticSource()
    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(src))
    with TestClient(app) as client:
        geom = box(36.5, -1.5, 37.5, -0.5)
        db.add_boundaries(str(tmp_path / "soe.db"), "geoBoundaries CGAZ", [
            ("cgaz:ADM1:NBO", "state", "Nairobi", "Kenya", "KEN", 36.5, -1.5, 37.5, -0.5, 400,
             json.dumps(mapping(geom)), "geoBoundaries CGAZ", "CC BY 4.0"),
            ("cgaz:ADM2:WA", "county", "Washington County", "Maine", "USA", 0, 0, 1, 1, 400, "{}",
             "geoBoundaries CGAZ", "CC BY 4.0"),
        ])
        yield client, src, tmp_path


def test_health_and_search(env):
    client, _, _ = env
    assert client.get("/api/health").json()["ok"] is True
    hits = client.get("/api/areas/search", params={"q": "nair"}).json()
    assert hits[0]["id"] == "cgaz:ADM1:NBO" and hits[0]["parent_name"] == "Kenya"
    assert client.get("/api/areas/search", params={"q": "county"}).json()[0]["name"] == "Washington County"
    assert client.get("/api/areas/search", params={"q": "x", "level": "planet"}).status_code == 422
    assert "geometry" in client.get("/api/areas/cgaz:ADM1:NBO").json()
    assert client.get("/api/areas/nope").status_code == 404


def test_post_poll_and_serve(env):
    client, _, tmp = env
    r = client.post("/api/scenes", json=body())
    assert r.status_code == 202
    sid = r.json()["id"]
    done = wait_for(client, sid)
    assert done["status"] == "done", done
    scene = client.get(done["bundle_url"]).json()
    assert scene["credits"]["lines"] and scene["id"] == sid
    assert [l["id"] for l in scene["layers"]] == ["glo90_terrain", "chirps_monthly"]
    assert client.get(f"/scenes/{sid}/scene.json").json()["id"] == sid  # path is the content hash
    assert client.get(f"/scenes/{sid}/data.zarr/zarr.json").status_code == 200
    assert client.get(f"/scenes/.tmp/{sid}/scene.json").status_code == 404
    # same request again: done, instant, no new rain reads
    reads = env[1].reads
    r2 = client.post("/api/scenes", json=body())
    assert r2.status_code == 200 and r2.json()["id"] == sid and len(sid) == 20 and env[1].reads == reads
    # a rounded-off shape, and the same ring rotated and reversed, dedupe too
    jittered = body()
    jittered["area"]["geometry"] = mapping(box(36.50001, -1.5, 37.5, -0.50001))
    assert client.post("/api/scenes", json=jittered).json()["id"] == sid
    reordered = body()
    reordered["area"]["geometry"] = {"type": "Polygon", "coordinates": [
        [[37.5, -0.5], [37.5, -1.5], [36.5, -1.5], [36.5, -0.5], [37.5, -0.5]]]}
    assert client.post("/api/scenes", json=reordered).json()["id"] == sid
    # bundles are content-addressed, so they are served as immutable
    assert "immutable" in client.get(f"/scenes/{sid}/scene.json").headers["cache-control"]


def test_boundary_scene(env):
    client, _, _ = env
    r = client.post("/api/scenes", json={**body(), "area": {"type": "boundary", "id": "cgaz:ADM1:NBO"}})
    assert r.status_code == 202
    done = wait_for(client, r.json()["id"])
    scene = client.get(done["bundle_url"]).json()
    assert done["status"] == "done" and scene["area"]["boundary"]["attribution"].startswith("Boundaries:")
    assert client.post("/api/scenes", json={**body(), "area": {"type": "boundary", "id": "zzz"}}).status_code == 422


def test_rejections_happen_before_any_read(env):
    client, src, _ = env
    tiny = mapping(box(36.8, -1.1, 36.9, -1.0))  # about 10 km: too small
    cases = [
        {"area": {"type": "polygon", "geometry": tiny}},
        {"start": "1980-01"},
        {"start": "2016-01", "end": "2015-01"},
        {"end": "2030-01"},
        {"layers": ["lava"]},
        {"layers": ["rain"]},
        {"area": {"type": "polygon", "geometry": {"type": "Point", "coordinates": [0, 0]}}},
        {"area": {"type": "polygon", "geometry": mapping(box(-60, -20, 40, 10))}, "start": "1981-01", "end": "2026-08"},
        {"area": {"type": "polygon", "geometry": mapping(box(-100, -50, 70, 60))}, "layers": ["glo90_terrain"]},
    ]
    for extra in cases:
        r = client.post("/api/scenes", json={**body(), **extra})
        assert r.status_code == 422, (extra, r.text)
    assert src.reads == 0


def test_body_cap_and_bad_json(env):
    client, _, _ = env
    assert client.post("/api/scenes", content=b"x" * 1_100_000).status_code == 413
    assert client.post("/api/scenes", content=b"{nope").status_code == 422
    assert client.post("/api/scenes", json=[1]).status_code == 422


def test_scene_id_must_be_hex(env):
    client, _, _ = env
    assert client.get("/api/scenes/../etc").status_code == 404
    assert client.get("/api/scenes/" + "Z" * 20).status_code == 404
    assert client.get("/api/scenes/" + "0" * 20).status_code == 404


def test_startup_marks_interrupted_and_repost_requeues(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)
    db.submit(path, "a" * 20, "{}", True)
    db.update_scene(path, "a" * 20, status="running")
    db.init(path)  # simulated restart
    row = db.get_scene(path, "a" * 20)
    assert row["status"] == "failed" and row["error"] == "interrupted"
    row, start = db.submit(path, "a" * 20, "{}", True)
    assert start and row["status"] == "queued" and row["error"] is None
    assert db.submit(path, "a" * 20, "{}", True)[1] is False


def test_malformed_requests_are_4xx_not_500(env):
    client, _, _ = env
    huge_int = body()
    huge_int["area"]["geometry"] = {"type": "Polygon", "coordinates": [[[0, 0], [10 ** 400, 0], [1, 1], [0, 0]]]}
    r = client.post("/api/scenes", content=json.dumps(huge_int))
    assert r.status_code == 422
    for deep in (b"[" * 400_000, b'{"area":' * 100_000):
        assert client.post("/api/scenes", content=deep).status_code == 422
    nested = body()
    nested["area"]["geometry"] = {"type": "Polygon", "coordinates": json.loads("[" * 50 + "]" * 50)}
    assert client.post("/api/scenes", json=nested).status_code == 422
    r = client.post("/api/scenes", content=b"{}", headers={"content-length": "abc"})
    assert 400 <= r.status_code < 500


def test_queue_full_gives_503_and_unreachable_source_gives_503(tmp_path):
    gate = threading.Event()

    class Slow(SyntheticSource):
        def read_rain(self, ym, win):
            gate.wait(10)
            return super().read_rain(ym, win)

    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(Slow()), max_queue=1)
    with TestClient(app) as client:
        first = client.post("/api/scenes", json=body())
        assert first.status_code == 202
        second = client.post("/api/scenes", json=body(end="2015-07"))
        assert second.status_code == 503 and "retry-after" in second.headers
        assert client.post("/api/scenes", json=body()).status_code == 202  # same job: not a new one
        gate.set()
        assert wait_for(client, first.json()["id"])["status"] == "done"

    class Down(SyntheticSource):
        def vintage(self, ym):
            raise SourceUnavailable("down")

    app = create_app(tmp_path / "b.db", tmp_path / "scenes2", make_registry(Down()))
    with TestClient(app) as client:
        assert client.post("/api/scenes", json=body()).status_code == 503


def test_failed_job_has_generic_error_and_class(tmp_path):
    class Boom(SyntheticSource):
        def read_rain(self, ym, win):
            raise RuntimeError("secret path C:/x/y")

    app = create_app(tmp_path / "soe.db", tmp_path / "scenes", make_registry(Boom()))
    with TestClient(app) as client:
        sid = client.post("/api/scenes", json=body()).json()["id"]
        out = wait_for(client, sid)
        assert out["status"] == "failed" and out["error_class"] == "RuntimeError"
        assert "secret" not in out["error"]


def test_layers(env):
    client, _, _ = env
    out = client.get("/api/layers").json()
    by_id = {layer["id"]: layer for layer in out["layers"]}
    assert out["default"] == ["chirps_monthly", "glo90_terrain"]
    rain, terrain = by_id["chirps_monthly"], by_id["glo90_terrain"]
    assert (rain["kind"], rain["time_varying"], rain["first_month"], rain["latest_month"]) == \
        ("series-colormap", True, "1981-01", "2026-08")
    assert (terrain["kind"], terrain["time_varying"], terrain["first_month"]) == ("terrain", False, None)
    assert rain["title"] and rain["units"] == "mm/month" and rain["coverage"] == [-180, -60, 180, 60]


def test_sample_areas_seed_only_in_synthetic_mode_and_when_empty(tmp_path, monkeypatch):
    def app_in(name):
        return create_app(tmp_path / name / "soe.db", tmp_path / name / "scenes", make_registry(SyntheticSource()))

    def sample_hits(client):
        return client.get("/api/areas/search", params={"q": "Sample"}).json()

    with TestClient(app_in("real")) as client:
        assert sample_hits(client) == []
    monkeypatch.setenv("SOE_SYNTHETIC", "1")
    with TestClient(app_in("synthetic")) as client:
        assert len(sample_hits(client)) == 5
        assert client.get("/api/areas/sample:fiji").json()["bbox"][2] > 180
        sid = client.post("/api/scenes", json={"area": {"type": "boundary", "id": "sample:nairobi"},
                                              "start": "2015-01", "end": "2015-02"}).json()["id"]
        assert wait_for(client, sid)["status"] == "done"
    db_path = str(tmp_path / "other" / "soe.db")  # a non-empty table is left alone
    db.init(db_path)
    db.add_boundaries(db_path, "geoBoundaries CGAZ", [("x", "state", "Other", None, None, 0, 0, 1, 1, 400, "{}",
                                                      "geoBoundaries CGAZ", "CC BY 4.0")])
    with TestClient(app_in("other")) as client:
        assert sample_hits(client) == []


def test_terrain_only_ignores_months(env):
    client, _, _ = env
    ids = {client.post("/api/scenes", json=body(layers=["glo90_terrain"], start=a, end=b)).json()["id"]
           for a, b in (("2015-01", "2015-02"), ("2020-05", "2020-09"))}
    assert len(ids) == 1
    assert wait_for(client, ids.pop())["status"] == "done"
