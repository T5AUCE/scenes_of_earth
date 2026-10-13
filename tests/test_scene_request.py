"""Scene preparation tests: validation, revision cache and scene ids (no network)."""
import json

import pytest
from shapely.geometry import box, mapping

from soe import db
from soe.areas import AreaError
from soe.scene_request import (
    DRAWN_AREA_TITLE,
    ID_CHARS,
    PreparedScene,
    compute_scene_id,
    prepare_scene,
)
from soe.sources import RealSource, SourceUnavailable, SyntheticSource, make_registry

SQUARE = mapping(box(36.5, -1.5, 37.5, -0.5))
PINNED_REVISION = "Tue, 01 Sep 2015 00:00:00 GMT"
PINNED_SCENE_ID = "dbb1ffc5d99da2225a23"  # Computed before the revision refactor.


class RevisionSource(RealSource):
    """A real-mode backend (so revisions are stored) that reads synthetic data and no network."""

    def __init__(self):
        super().__init__(latest="2026-08")
        self.data = SyntheticSource()
        self.revision = "first"
        self.down = False
        self.revision_calls = 0

    def current_revision(self, month):
        self.revision_calls += 1
        if self.down:
            raise SourceUnavailable("down")
        return self.revision

    def read_rain(self, month, window):
        return self.data.read_rain(month, window)

    def terrain(self, bounds, res):
        return self.data.terrain(bounds, res)


def request_body(**overrides):
    return json.dumps({
        "area": {"type": "polygon", "geometry": SQUARE},
        "start": "2015-01",
        "end": "2015-06",
        "layers": ["glo90_terrain", "chirps_monthly"],
        **overrides,
    })


@pytest.fixture
def db_path(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)
    return path


def test_valid_request_gets_an_id_and_request_json(db_path):
    prepared = prepare_scene(db_path, make_registry(SyntheticSource()), request_body())

    assert isinstance(prepared, PreparedScene)
    assert len(prepared.scene_id) == ID_CHARS
    assert json.loads(prepared.request_json)["title"] == DRAWN_AREA_TITLE


def test_unknown_layer_is_an_area_error(db_path):
    registry = make_registry(SyntheticSource())

    with pytest.raises(AreaError):
        prepare_scene(db_path, registry, request_body(layers=["nope"]))


def test_stored_revision_serves_a_built_scene_when_the_source_goes_down(
    db_path,
    monkeypatch,
):
    source = RevisionSource()
    registry = make_registry(source)
    first = prepare_scene(db_path, registry, request_body())

    monkeypatch.setattr("soe.scene_request.REVISION_FRESH_SECS", 0)
    source.down = True
    again = prepare_scene(db_path, registry, request_body())

    assert again.scene_id == first.scene_id


def test_unavailable_source_without_stored_revision_fails_before_any_read(db_path):
    source = RevisionSource()
    source.down = True

    with pytest.raises(SourceUnavailable):
        prepare_scene(db_path, make_registry(source), request_body())

    assert source.data.reads == 0


def test_fresh_stored_revision_is_not_asked_again(db_path):
    source = RevisionSource()
    registry = make_registry(source)

    prepare_scene(db_path, registry, request_body())
    prepare_scene(db_path, registry, request_body())

    assert source.revision_calls == 1


def test_synthetic_backend_does_not_touch_the_revision_table(db_path):
    prepare_scene(db_path, make_registry(SyntheticSource()), request_body())

    assert db.get_revision(db_path, "chirps_monthly", "2015-06") is None


def test_changed_revision_after_recovery_gives_a_new_scene_id(db_path, monkeypatch):
    source = RevisionSource()
    registry = make_registry(source)
    first = prepare_scene(db_path, registry, request_body())

    monkeypatch.setattr("soe.scene_request.REVISION_FRESH_SECS", 0)
    source.revision = "revised"
    second = prepare_scene(db_path, registry, request_body())

    assert second.scene_id != first.scene_id


def test_scene_id_is_unchanged_for_known_inputs():
    registry = make_registry(RealSource())

    scene_id = compute_scene_id(
        "poly:abc",
        ["chirps_monthly", "glo90_terrain"],
        "2015-01",
        "2015-06",
        [registry["chirps_monthly"], registry["glo90_terrain"]],
        {"chirps_monthly": PINNED_REVISION},
    )

    assert scene_id == PINNED_SCENE_ID


def test_synthetic_and_real_terrain_scenes_get_different_ids():
    terrain = ["glo90_terrain"]

    def scene_id(registry):
        return compute_scene_id(
            "g",
            terrain,
            "2015-01",
            "2015-02",
            [registry["glo90_terrain"]],
            revisions={},
        )

    synthetic = make_registry(SyntheticSource())
    real = make_registry(RealSource())

    assert scene_id(synthetic) != scene_id(real)
