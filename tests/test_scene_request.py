"""Test scene request validation, the revision cache and scene ids without network."""

import json
from dataclasses import replace
from pathlib import Path

import pytest
from shapely.geometry import box, mapping

from soe import db, land
from soe.areas import AreaError
from soe.land import write_land_store
from soe.scene_request import (
    DRAWN_AREA_TITLE,
    ID_CHARS,
    LAND_CHANGED_MESSAGE,
    PreparedScene,
    check_period,
    compute_scene_id,
    prepare_scene,
    resolve_area,
)
from soe.sources import (
    CubeSpec,
    RealSource,
    Registry,
    SeriesDataset,
    SourceUnavailable,
    SyntheticSource,
    make_registry,
    request_range,
)
from tests.conftest import RevisionSource
from tests.helpers import RAIN, boundary_row, write_cube

SQUARE = mapping(box(36.5, -1.5, 37.5, -0.5))
LAND_VERSION = "2026-11-14"
PINNED_REVISION = "Tue, 01 Sep 2015 00:00:00 GMT"
PINNED_SCENE_ID = "bdafee6364463965855c"  # Computed for soe 0.9.1 and scene format 0.7.
IN_RANGE_SCENE_ID = "22136ea1c3d6ca07ce8b"  # Nairobi square, as built before 84N support.
EDGE_SCENE_ID = "263edbc91e2eb67d8d83"  # A polygon ending just below 60N, built before 84N support.
PREVIOUS_SCENE_ID = "51c67b0430f967920733"  # The same inputs under soe 0.9.0.


def db_path_of(tmp_path: Path, name: str) -> str:
    """Return the path of the named database in tmp_path, creating it on first use."""
    path = tmp_path / f"{name}.db"
    if not path.exists():
        db.init(str(path))

    return str(path)


def request_body(**overrides: object) -> str:
    """Encode a six-month Nairobi polygon request with optional overrides."""
    return json.dumps(
        {
            "area": {"type": "polygon", "geometry": SQUARE},
            "start": "2015-01",
            "end": "2015-06",
            "layers": ["terrain", "chirps_monthly"],
            **overrides,
        }
    )


@pytest.fixture(autouse=True)
def land_store(tmp_path, monkeypatch):
    """A land store covering the request square, for scenes of layers that are not offline."""
    store = tmp_path / "land.sqlite"
    write_land_store(store, LAND_VERSION, [box(36, -2, 38, 0)])
    monkeypatch.setenv("SOE_LAND", str(store))

    return store


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
    db_path, monkeypatch, revision_source
):
    registry = make_registry(revision_source)
    first = prepare_scene(db_path, registry, request_body())

    monkeypatch.setattr("soe.scene_request.REVISION_FRESH_SECS", 0)
    revision_source.down = True
    again = prepare_scene(db_path, registry, request_body())

    assert again.scene_id == first.scene_id


def test_unavailable_source_without_stored_revision_fails_before_any_read(db_path, revision_source):
    revision_source.down = True

    with pytest.raises(SourceUnavailable):
        prepare_scene(db_path, make_registry(revision_source), request_body())

    assert revision_source.data.reads == 0


def test_fresh_stored_revision_is_not_asked_again(db_path, revision_source):
    registry = make_registry(revision_source)

    prepare_scene(db_path, registry, request_body())
    prepare_scene(db_path, registry, request_body())

    assert revision_source.revision_calls == 1


def test_synthetic_backend_does_not_touch_the_revision_table(db_path):
    prepare_scene(db_path, make_registry(SyntheticSource()), request_body())

    assert db.get_revision(db_path, "chirps_monthly:remote", "2015-01-01/2015-06-01") is None


def test_changed_revision_after_recovery_gives_a_new_scene_id(
    db_path, monkeypatch, revision_source
):
    registry = make_registry(revision_source)
    first = prepare_scene(db_path, registry, request_body())

    monkeypatch.setattr("soe.scene_request.REVISION_FRESH_SECS", 0)
    revision_source.revision = "revised"
    second = prepare_scene(db_path, registry, request_body())

    assert second.scene_id != first.scene_id


def test_scene_id_is_unchanged_for_known_inputs(tmp_path):
    assert known_scene_id(tmp_path) == PINNED_SCENE_ID


def polygon_scene_id(db_path: str, bounds: tuple[float, float, float, float]) -> str:
    area = {"type": "polygon", "geometry": mapping(box(*bounds))}
    registry = make_registry(SyntheticSource())
    return prepare_scene(db_path, registry, request_body(area=area)).scene_id


def test_polygons_wholly_below_60_north_keep_their_scene_id(db_path):
    assert polygon_scene_id(db_path, (36.5, -1.5, 37.5, -0.5)) == IN_RANGE_SCENE_ID
    assert polygon_scene_id(db_path, (36, 59, 37, 59.9999)) == EDGE_SCENE_ID


def test_polygon_crossing_60_north_gets_a_new_scene_id(db_path):
    crossing = polygon_scene_id(db_path, (36, 58, 38, 62))

    assert crossing != polygon_scene_id(db_path, (36, 58, 38, 60))
    assert crossing != "706ce67fff9b7f9455f4"  # The id it had when its outline was clipped.


def known_scene_id(tmp_path: Path) -> str:
    """Return the id of the pinned inputs."""
    write_cube(tmp_path, "era5_precipitation", 0)
    registry = make_registry(RealSource(cubes_dir=tmp_path))
    return compute_scene_id(
        "poly:abc",
        ["chirps_monthly", "terrain"],
        ("2015-01-01", "2015-07-01"),
        [registry["chirps_monthly"], registry["terrain"]],
        {"chirps_monthly": (PINNED_REVISION, "local")},
    )


def test_rain_scene_id_differs_from_the_one_older_generator_bundles_have(tmp_path):
    assert known_scene_id(tmp_path) != PREVIOUS_SCENE_ID


def test_changing_the_bundle_format_renames_the_scene(monkeypatch):
    def scene_id() -> str:
        return compute_scene_id("g", ["chirps_monthly"], None, [RAIN], {})

    current = scene_id()
    monkeypatch.setattr("soe.scene_request.VERSION", "next-format")

    assert scene_id() != current


def test_changing_the_generator_renames_the_scene(monkeypatch):
    def scene_id() -> str:
        return compute_scene_id("g", ["chirps_monthly"], None, [RAIN], {})

    current = scene_id()
    monkeypatch.setattr("soe.scene_request.__version__", "next-generator")

    assert scene_id() != current


def test_changing_the_terrain_tiles_url_renames_the_scene(monkeypatch):
    def scene_id() -> str:
        terrain = make_registry(SyntheticSource())["terrain"]
        return compute_scene_id("g", ["terrain"], None, [terrain], revisions={})

    hosted = scene_id()

    monkeypatch.setenv("SOE_TERRAIN_TILES", "../../terrain/v1/{z}/{x}/{y}.webp")

    assert scene_id() != hosted


def test_synthetic_and_real_terrain_scenes_get_different_ids():
    terrain = ["terrain"]

    def scene_id(registry: Registry) -> str:
        return compute_scene_id("g", terrain, None, [registry["terrain"]], revisions={})

    synthetic = make_registry(SyntheticSource())
    real = make_registry(RealSource())

    assert scene_id(synthetic) != scene_id(real)


def test_check_period_accepts_the_source_range_and_rejects_bad_ranges():
    check_period("1981-01", "2026-08", RAIN)

    bad_ranges = (
        ("1980-12", "1990-01"),
        ("2020-05", "2020-04"),
        ("2020-01", "2026-09"),
        ("2020-13", "2020-14"),
    )

    for start, end in bad_ranges:
        with pytest.raises(AreaError):
            check_period(start, end, RAIN)


def test_period_outside_a_dataset_is_refused_before_any_read(db_path):
    source = SyntheticSource()

    with pytest.raises(AreaError, match="end must be 2026-08 or earlier"):
        prepare_scene(db_path, make_registry(source), request_body(end="2026-09"))

    assert source.reads == 0


def test_same_period_gives_the_same_scene_id():
    terrain = make_registry(SyntheticSource())["terrain"]
    months = request_range("2015-01", "2015-12", "P1M")
    year = request_range("2015", "2015", "P1Y")

    def scene_id(period: tuple[str, str]) -> str:
        return compute_scene_id("g", ["chirps_monthly"], period, [terrain], {})

    assert scene_id(months) == scene_id(year)
    assert scene_id(months) != scene_id(request_range("2015-01", "2015-11", "P1M"))


def test_revision_is_asked_with_every_step_of_the_range(db_path, revision_source):
    class Recording(type(RAIN)):
        asked: list[str]

        def remote_revision(self, steps: list[str]) -> str:
            self.asked = steps
            return "recorded"

    registry = make_registry(revision_source)
    rain = registry["chirps_monthly"]
    registry["chirps_monthly"] = Recording(**{name: getattr(rain, name) for name in vars(rain)})

    prepare_scene(db_path, registry, request_body(end="2015-03"))

    assert registry["chirps_monthly"].asked == ["2015-01-01", "2015-02-01", "2015-03-01"]


def test_local_source_revision_is_not_cached(db_path):
    class MovingCube:
        marker = "0005:first"

        def cube_months(self, spec: CubeSpec) -> dict[str, str]:
            return {"2016-01": self.marker, "2016-02": self.marker}

    cube = MovingCube()
    temperature = replace(
        make_registry(SyntheticSource())["era5land_temperature"], backend=cube, synthetic=False
    )
    registry = {"era5land_temperature": temperature}
    body = request_body(layers=["era5land_temperature"], start="2016-01", end="2016-02")

    first = prepare_scene(db_path, registry, body)
    cube.marker = "0001:final"
    second = prepare_scene(db_path, registry, body)

    assert second.scene_id != first.scene_id
    assert db.get_revision(db_path, "era5land_temperature:remote", "2016-01-01/2016-02-01") is None


def test_scene_id_changes_when_only_the_fallback_cube_is_revised(db_path):
    class Cubes:
        fallback_marker = "0005:first"

        def cube_months(self, spec: CubeSpec) -> dict[str, str]:
            marker = "0001:land" if spec.name == "era5land_temperature" else self.fallback_marker
            return {"2016-01": marker, "2016-02": marker}

    cubes = Cubes()
    temperature = replace(
        make_registry(SyntheticSource())["era5land_temperature"], backend=cubes, synthetic=False
    )
    registry = {"era5land_temperature": temperature}
    body = request_body(layers=["era5land_temperature"], start="2016-01", end="2016-02")

    first = prepare_scene(db_path, registry, body)
    cubes.fallback_marker = "0001:final"
    second = prepare_scene(db_path, registry, body)

    assert second.scene_id != first.scene_id


def test_request_without_layers_gets_the_default_layers(db_path):
    registry = make_registry(SyntheticSource())
    request = json.loads(request_body())
    del request["layers"]

    prepared = prepare_scene(db_path, registry, json.dumps(request))

    assert json.loads(prepared.request_json)["layers"] == ["chirps_monthly", "terrain"]


def revised_cube_months(
    source: RevisionSource, monkeypatch: pytest.MonkeyPatch, month: str
) -> None:
    """Make the fallback cube of `month` hold new data, as an ingest would."""
    months = source.data.cube_months

    def cube_months(spec: CubeSpec) -> dict[str, str]:
        return {**months(spec), month: "0001:revised"}

    monkeypatch.setattr(source, "cube_months", cube_months)


def test_rain_scene_id_follows_the_fallback_cube_while_the_chirps_revision_is_cached(
    db_path, monkeypatch, revision_source
):
    registry = make_registry(revision_source)
    first = prepare_scene(db_path, registry, request_body())

    revised_cube_months(revision_source, monkeypatch, "2015-03")
    second = prepare_scene(db_path, registry, request_body())

    assert second.scene_id != first.scene_id
    assert revision_source.revision_calls == 1


def test_rain_scene_id_follows_the_fallback_cube_while_chirps_is_down(
    db_path, monkeypatch, revision_source
):
    registry = make_registry(revision_source)
    first = prepare_scene(db_path, registry, request_body())

    monkeypatch.setattr("soe.scene_request.REVISION_FRESH_SECS", 0)
    revision_source.down = True
    unchanged = prepare_scene(db_path, registry, request_body())
    revised_cube_months(revision_source, monkeypatch, "2015-03")
    revised = prepare_scene(db_path, registry, request_body())

    assert unchanged.scene_id == first.scene_id
    assert revised.scene_id != first.scene_id


def test_cube_scene_id_ignores_the_remote_revision_cache_of_an_earlier_http_scene(
    tmp_path, monkeypatch, revision_source
):
    prepare_scene(db_path_of(tmp_path, "http"), make_registry(revision_source), request_body())
    revision_source.data = SyntheticSource(chirps_cube=True)
    registry = make_registry(revision_source)
    calls_before = revision_source.revision_calls

    fresh = prepare_scene(db_path_of(tmp_path, "http"), registry, request_body())
    empty = prepare_scene(db_path_of(tmp_path, "empty"), registry, request_body())
    monkeypatch.setattr("soe.scene_request.REVISION_FRESH_SECS", 0)
    revision_source.down = True
    expired = prepare_scene(db_path_of(tmp_path, "http"), registry, request_body())

    assert fresh.scene_id == empty.scene_id == expired.scene_id
    assert revision_source.revision_calls == calls_before


def test_mixed_scene_does_not_reuse_a_revision_stored_for_other_http_months(
    tmp_path, revision_source
):
    path = db_path_of(tmp_path, "mixed")
    prepare_scene(path, make_registry(revision_source), request_body())
    revision_source.data = SyntheticSource(chirps_cube=True)
    registry = make_registry(revision_source)
    cube_months = revision_source.data.optional_cube_months
    revision_source.optional_cube_months = lambda spec: {
        month: marker for month, marker in cube_months(spec).items() if month != "2015-06"
    }

    prepare_scene(path, registry, request_body())

    assert revision_source.revision_calls == 2


def test_a_revision_stored_before_the_local_part_existed_is_not_reused(db_path, revision_source):
    db.set_revision(db_path, "chirps_monthly", "2015-01-01/2015-06-01", "old combined digest")

    registry = make_registry(revision_source)

    prepare_scene(db_path, registry, request_body())

    assert revision_source.revision_calls == 1
    assert db.get_revision(db_path, "chirps_monthly:remote", "2015-01-01/2015-06-01")[0] == "first"


def test_scene_id_changes_when_only_the_fallback_source_version_changes():
    registry = make_registry(SyntheticSource())
    rain = registry["chirps_monthly"]
    newer_source = {**rain.fallback.source, "version": "ERA5 (newer release)"}
    newer = replace(rain, fallback=rain.fallback._replace(source=newer_source))

    def scene_id(dataset: SeriesDataset) -> str:
        return compute_scene_id(
            "g",
            ["chirps_monthly"],
            ("2015-01-01", "2015-02-01"),
            [dataset],
            {"chirps_monthly": ("remote", "local")},
        )

    assert scene_id(newer) != scene_id(rain)


def test_request_keeps_the_local_revisions_its_id_was_made_from(db_path):
    registry = make_registry(SyntheticSource())

    prepared = prepare_scene(db_path, registry, request_body())

    rain = registry["chirps_monthly"]
    steps = rain.steps("2015-01-01", "2015-07-01")

    assert json.loads(prepared.request_json)["local_revisions"] == {
        "chirps_monthly": rain.local_revision(steps)
    }


def test_scene_id_names_the_land_version_the_area_was_cut_to(db_path, land_store, revision_source):
    registry = make_registry(revision_source)
    first = prepare_scene(db_path, registry, request_body())

    write_land_store(land_store, "2026-12-01", [box(36, -2, 38, 0)])
    second = prepare_scene(db_path, registry, request_body())

    assert json.loads(first.request_json)["area"]["land"] == LAND_VERSION
    assert second.scene_id != first.scene_id


def test_scene_of_offline_layers_is_not_cut_to_land(db_path, monkeypatch):
    monkeypatch.setenv("SOE_LAND", "missing.sqlite")

    prepared = prepare_scene(db_path, make_registry(SyntheticSource()), request_body())

    assert "land" not in json.loads(prepared.request_json)["area"]


def test_missing_land_store_fails_before_any_read(db_path, monkeypatch, revision_source):
    monkeypatch.setenv("SOE_LAND", "missing.sqlite")

    with pytest.raises(SourceUnavailable):
        prepare_scene(db_path, make_registry(revision_source), request_body())

    assert revision_source.revision_calls == 0
    assert revision_source.data.reads == 0


def test_area_without_land_is_refused_before_any_read(db_path, revision_source):
    sea = {"type": "polygon", "geometry": mapping(box(10, 10, 11, 11))}

    with pytest.raises(AreaError, match="no land"):
        prepare_scene(db_path, make_registry(revision_source), request_body(area=sea))

    assert revision_source.revision_calls == 0
    assert revision_source.data.reads == 0


def test_a_land_version_sent_by_the_client_is_not_trusted(db_path, revision_source):
    area = {"type": "polygon", "geometry": SQUARE, "land": "made-up"}

    prepared = prepare_scene(db_path, make_registry(revision_source), request_body(area=area))

    assert json.loads(prepared.request_json)["area"]["land"] == LAND_VERSION


def test_queued_scene_is_cut_to_the_land_version_its_id_names(db_path, land_store, revision_source):
    prepared = prepare_scene(db_path, make_registry(revision_source), request_body())
    spec = json.loads(prepared.request_json)["area"]

    assert resolve_area(db_path, spec).land_version == LAND_VERSION

    write_land_store(land_store, "2026-12-01", [box(36, -2, 38, 0)])

    with pytest.raises(AreaError, match=LAND_CHANGED_MESSAGE):
        resolve_area(db_path, spec)


def add_named_pair(db_path, neighbour_east_deg):
    """Two same-level boundaries side by side; the second one ends at `neighbour_east_deg`."""
    parts = {"A": box(36, -2, 37, 0), "B": box(37, -2, neighbour_east_deg, 0)}
    rows = [
        boundary_row(
            f"cgaz:ADM1:{name}", "state", name, bbox=part.bounds, geometry=json.dumps(mapping(part))
        )
        for name, part in parts.items()
    ]
    db.add_boundaries(db_path, "geoBoundaries CGAZ", rows)


def test_scene_id_names_the_neighbours_the_area_was_cut_against(db_path, revision_source):
    registry = make_registry(revision_source)
    area = {"type": "boundary", "id": "cgaz:ADM1:A"}
    add_named_pair(db_path, 38)
    first = prepare_scene(db_path, registry, request_body(area=area))

    add_named_pair(db_path, 38.5)
    second = prepare_scene(db_path, registry, request_body(area=area))

    assert second.scene_id != first.scene_id
    assert json.loads(second.request_json)["area"]["neighbours"]


def test_queued_scene_is_refused_when_a_neighbour_changed_while_it_waited(db_path, revision_source):
    add_named_pair(db_path, 38)
    area = {"type": "boundary", "id": "cgaz:ADM1:A"}
    prepared = prepare_scene(db_path, make_registry(revision_source), request_body(area=area))
    spec = json.loads(prepared.request_json)["area"]

    assert resolve_area(db_path, spec).neighbour_revision == spec["neighbours"]

    add_named_pair(db_path, 38.5)

    with pytest.raises(AreaError, match="neighbouring boundaries changed"):
        resolve_area(db_path, spec)


def test_scene_id_names_the_clip_method_the_area_was_cut_with(
    db_path, revision_source, monkeypatch
):
    registry = make_registry(revision_source)
    first = prepare_scene(db_path, registry, request_body())

    monkeypatch.setattr(land, "CLIP_METHOD_VERSION", land.CLIP_METHOD_VERSION + 1)
    second = prepare_scene(db_path, registry, request_body())

    assert second.scene_id != first.scene_id
    assert json.loads(second.request_json)["area"]["clip"] == land.CLIP_METHOD_VERSION


def test_queued_scene_is_refused_when_the_clip_method_changed_while_it_waited(
    db_path, revision_source, monkeypatch
):
    prepared = prepare_scene(db_path, make_registry(revision_source), request_body())
    spec = json.loads(prepared.request_json)["area"]

    assert resolve_area(db_path, spec).land_version == spec["land"]

    monkeypatch.setattr(land, "CLIP_METHOD_VERSION", land.CLIP_METHOD_VERSION + 1)

    with pytest.raises(AreaError, match="request the scene again"):
        resolve_area(db_path, spec)
