"""Offline tests: Overture divisions become boundary rows, parts and combined areas."""

import json
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry

from soe import cli, db, overture_import
from soe.overture_import import (
    Catalog,
    Credit,
    DisputedLine,
    Division,
    DivisionArea,
    cached_admin_levels,
    import_overture,
    is_compact,
    open_release,
    parse_overpass_levels,
    tiling_municipalities,
    update_overture_levels,
)
from tests.helpers import boundary_row

RELEASE = "2026-10-21.0"
OSM: Credit = ("OpenStreetMap", "ODbL-1.0")
ESRI: Credit = ("Esri Community Maps", "CC-BY-4.0")


def division(
    division_id: str,
    country: str | None,
    subtype: str,
    parent_id: str | None = None,
    name: str | None = None,
    english: str | None = None,
    **fields: str | frozenset[Credit] | None,
) -> Division:
    return Division(
        id=division_id,
        country=country,
        subtype=subtype,
        parent_id=parent_id,
        region_code=fields.get("region_code"),
        primary_name=name or division_id,
        common_names={"en": english} if english else {},
        local_type=fields.get("local_type"),
        record_id=fields.get("record_id"),
        credits=fields.get("credits", frozenset()),
    )


def land(
    division_id: str, geometry: BaseGeometry, credits: frozenset[Credit] = frozenset()
) -> DivisionArea:
    return DivisionArea(division_id, False, geometry, credits)


def sea(division_id: str, geometry: BaseGeometry) -> DivisionArea:
    return DivisionArea(division_id, True, geometry)


class FakeSource:
    def __init__(self, divisions: list[Division], areas: list[DivisionArea]) -> None:
        self._divisions = divisions
        self._areas = areas
        self.disputed = []

    def divisions(self) -> list[Division]:
        return self._divisions

    def areas(self, country: str, subtypes: tuple[str, ...]) -> Iterator[DivisionArea]:
        owners = {item.id: item for item in self._divisions}
        for area in self._areas:
            owner = owners[area.division_id]
            if owner.country == country and owner.subtype in subtypes:
                yield area

    def disputed_lines(self) -> list[DisputedLine]:
        return self.disputed


def no_levels(relation_ids: list[int]) -> dict[int, int | None]:
    return {}


def run_import(
    tmp_path: Path,
    source: FakeSource,
    fetch_levels: Callable[[list[int]], dict[int, int | None]] = no_levels,
) -> str:
    path = str(tmp_path / "soe.db")
    db.init(path)
    import_overture(path, source, fetch_levels)

    return path


def stored(path: str, row_id: str) -> dict:
    with db.connect(path) as connection:
        row = connection.execute("SELECT * FROM boundaries WHERE id = ?", (row_id,)).fetchone()

    return dict(row) if row else {}


def test_dependency_row_is_its_own_country_level_area(tmp_path):
    source = FakeSource(
        [
            division("fr", "FR", "country", name="France"),
            division("gf", "GF", "dependency", "fr", name="Guyane", local_type="department"),
        ],
        [land("fr", box(0, 45, 5, 50)), land("gf", box(-54, 3, -52, 5))],
    )

    path = run_import(tmp_path, source)

    guyane = stored(path, "ovt:GF")
    assert guyane["level"] == "country"
    assert guyane["iso3"] == "GUF"
    assert guyane["parent_name"] == "France"
    assert guyane["kind"] == "Department"


def test_local_type_that_repeats_the_subtype_gives_no_kind():
    catalog = Catalog([division("a", "CZ", "localadmin", local_type="localadmin")])
    parish = division("b", "GB", "localadmin", local_type="civil_parish")

    assert catalog.kind(catalog.divisions_at("CZ", "municipality")[0]) is None
    assert catalog.kind(parish) == "Civil parish"


def test_division_without_a_country_is_left_out():
    catalog = Catalog([division("a", None, "county"), division("b", "FR", "county")])

    assert catalog.country_codes() == ["FR"]


def test_region_id_uses_iso_code_and_falls_back_to_gers(tmp_path):
    source = FakeSource(
        [
            division("fr", "FR", "country"),
            division("r1", "FR", "region", "fr", region_code="FR-BRE"),
            division("r2", "FR", "region", "fr", region_code="FR-DUP"),
            division("r3", "FR", "region", "fr", region_code="FR-DUP"),
            division("r4", "FR", "region", "fr"),
        ],
        [
            land(name, box(index, 45, index + 1, 46))
            for index, name in enumerate(["r1", "r2", "r3", "r4"])
        ],
    )

    path = run_import(tmp_path, source)

    with db.connect(path) as connection:
        ids = {
            row["id"]
            for row in connection.execute("SELECT id FROM boundaries WHERE level = 'state'")
        }

    assert ids == {"ovt:FR-BRE", "ovt:r2", "ovt:r3", "ovt:r4"}


def test_missing_english_name_falls_back_to_primary(tmp_path):
    source = FakeSource(
        [
            division("cn", "CN", "country", name="中国", english="China"),
            division("tw", "TW", "country", name="台灣"),
        ],
        [land("cn", box(100, 20, 110, 30)), land("tw", box(120, 22, 122, 25))],
    )

    path = run_import(tmp_path, source)

    assert stored(path, "ovt:CN")["name"] == "China"
    assert stored(path, "ovt:CN")["name_local"] == "中国"
    assert stored(path, "ovt:TW")["name"] == "台灣"
    assert json.loads(stored(path, "ovt:CN")["aliases"]) == ["China"]


def test_maritime_row_wins_over_land_row(tmp_path):
    source = FakeSource(
        [division("fr", "FR", "country"), division("de", "DE", "country")],
        [land("fr", box(0, 0, 1, 1)), sea("fr", box(-1, -1, 2, 2)), land("de", box(10, 0, 11, 1))],
    )

    path = run_import(tmp_path, source)

    assert stored(path, "ovt:FR")["bbox_w"] == -1
    assert stored(path, "ovt:FR")["has_maritime"] == 1
    assert stored(path, "ovt:DE")["has_maritime"] == 0


def test_overpass_levels_are_cached_by_relation_version(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)
    asked: list[list[int]] = []

    def fetch(relation_ids: list[int]) -> dict[int, int | None]:
        asked.append(relation_ids)
        return {relation_id: 4 for relation_id in relation_ids if relation_id != 7}

    first = cached_admin_levels(path, ["r5@1", "r7@2", "r8@1"], fetch)
    second = cached_admin_levels(path, ["r5@1", "r7@2", "r5@2"], fetch)

    assert first == {"r5@1": 4, "r7@2": None, "r8@1": 4}
    assert second == {"r5@1": 4, "r7@2": None, "r5@2": 4}
    assert asked == [[5, 7, 8], [5]]


def test_overpass_levels_parse_missing_tags_as_none():
    answer = {
        "elements": [
            {"id": 12, "tags": {"admin_level": "4"}},
            {"id": 13, "tags": {"name": "no level"}},
            {"id": 14, "tags": {"admin_level": "abc"}},
        ]
    }

    assert parse_overpass_levels(json.dumps(answer)) == {12: 4, 13: None, 14: None}


@pytest.mark.parametrize(
    "answer",
    [
        '{"elements": [{"id": 12, "tags": {"admin_le',
        '{"elements": [], "remark": "runtime error: Query timed out"}',
        '{"remark": "something else"}',
        "<html>Too many requests</html>",
    ],
)
def test_incomplete_overpass_answer_exits_instead_of_reading_as_no_levels(answer):
    with pytest.raises(SystemExit, match="Overpass"):
        parse_overpass_levels(answer)


def test_first_overpass_failure_leaves_the_database_unchanged(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)

    def failing(relation_ids: list[int]) -> dict[int, int | None]:
        raise SystemExit("Overpass request failed")

    with pytest.raises(SystemExit):
        cached_admin_levels(path, ["r5@1"], failing)

    with db.connect(path) as connection:
        tables = {row["name"] for row in connection.execute("SELECT name FROM sqlite_master")}

    assert "osm_levels" not in tables


def test_overpass_batches_already_fetched_stay_cached_when_a_later_one_fails(tmp_path, monkeypatch):
    path = str(tmp_path / "soe.db")
    db.init(path)
    monkeypatch.setattr(overture_import, "OVERPASS_BATCH_IDS", 2)
    calls: list[list[int]] = []

    def fails_second(relation_ids: list[int]) -> dict[int, int | None]:
        calls.append(relation_ids)
        if len(calls) == 2:
            raise SystemExit("Overpass request failed")

        return dict.fromkeys(relation_ids, 4)

    with pytest.raises(SystemExit):
        cached_admin_levels(path, ["r1@1", "r2@1", "r3@1"], fails_second)

    assert cached_admin_levels(path, ["r1@1", "r2@1"], no_levels) == {"r1@1": 4, "r2@1": 4}


class _FakeOverpassResponse:
    def __init__(self, text: str) -> None:
        self._text = text

    def __enter__(self) -> "_FakeOverpassResponse":
        return self

    def __exit__(self, *args: object) -> bool:
        return False

    def read(self) -> bytes:
        return self._text.encode()


class _DelayedReplaceConnection:
    """Delays the replace after its level-fill read, so a writer thread lands in the window."""

    def __init__(self, real: sqlite3.Connection, filled: threading.Event) -> None:
        self._real = real
        self._filled = filled

    def execute(self, sql: str, *args: object, **kwargs: object) -> sqlite3.Cursor:
        result = self._real.execute(sql, *args, **kwargs)
        if "UPDATE staging.boundaries" in sql:
            self._filled.set()
            time.sleep(0.5)
        return result

    def __getattr__(self, name: str) -> object:
        return getattr(self._real, name)


def test_overpass_transient_failure_retries_then_succeeds(monkeypatch, capsys):
    calls: list[object] = []
    sleeps: list[float] = []
    good = '{"elements": [{"id": 12, "tags": {"admin_level": "4"}}]}'

    def flaky(request: object, timeout: float | None = None) -> _FakeOverpassResponse:
        calls.append(request)
        if len(calls) == 1:
            raise urllib.error.HTTPError(
                overture_import.OVERPASS_URL, 503, "Service Unavailable", None, None
            )

        return _FakeOverpassResponse(good)

    monkeypatch.setattr(urllib.request, "urlopen", flaky)

    levels = overture_import._fetch_overpass_levels(
        [12], sleep=sleeps.append, fetch_status=_status_unreachable
    )

    assert levels == {12: 4}
    assert len(calls) == 2
    assert sleeps[0] == overture_import.OVERPASS_RETRY_DELAY_SECS
    assert sleeps[-1] == overture_import.OVERPASS_PAUSE_SECS
    assert "attempt 1/8" in capsys.readouterr().out


def _status_unreachable() -> str:
    raise OSError("status unreachable")


@pytest.mark.parametrize(
    ("status", "expected_wait"),
    [
        ("Connected as: 1.2.3.4\nRate limit: 2\n2 slots available now.\n", 5),
        (
            "Rate limit: 2\n0 slots available now.\n"
            "Slot available after: 2026-11-17T20:30:05Z, in 7 seconds.\n"
            "Slot available after: 2026-11-17T20:30:09Z, in 11 seconds.\n",
            9,
        ),
        (
            "Slot available after: 2026-11-17T20:30:05Z, in 9000 seconds.",
            overture_import.OVERPASS_RETRY_MAX_DELAY_SECS,
        ),
        ("<html>Bad Gateway</html>", overture_import.OVERPASS_RETRY_DELAY_SECS),
    ],
    ids=["slot-now", "slot-after", "slot-after-capped", "unparsable-falls-back"],
)
def test_overpass_retry_waits_for_the_reported_free_slot(monkeypatch, status, expected_wait):
    sleeps: list[float] = []
    busy = '{"remark": "runtime error: Query timed out", "elements": []}'
    good = '{"elements": [{"id": 12, "tags": {"admin_level": "4"}}]}'
    answers = iter([busy, good])
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda request, timeout=None: _FakeOverpassResponse(next(answers)),
    )

    overture_import._fetch_overpass_levels([12], sleep=sleeps.append, fetch_status=lambda: status)

    assert sleeps[0] == expected_wait


def test_overpass_status_url_is_derived_from_the_query_url():
    assert overture_import.OVERPASS_STATUS_URL == "https://overpass-api.de/api/status"


def test_overpass_runtime_errors_give_up_without_caching(tmp_path, monkeypatch, capsys):
    path = str(tmp_path / "soe.db")
    db.init(path)
    monkeypatch.setattr(overture_import, "OVERPASS_MAX_TRIES", 3)
    calls: list[object] = []
    sleeps: list[float] = []
    busy = '{"remark": "runtime error: Query timed out", "elements": []}'

    def always_busy(request: object, timeout: float | None = None) -> _FakeOverpassResponse:
        calls.append(request)

        return _FakeOverpassResponse(busy)

    monkeypatch.setattr(urllib.request, "urlopen", always_busy)

    def fetch(relation_ids: list[int]) -> dict[int, int | None]:
        return overture_import._fetch_overpass_levels(
            relation_ids, sleep=sleeps.append, fetch_status=_status_unreachable
        )

    with pytest.raises(SystemExit, match="run again"):
        cached_admin_levels(path, ["r1@1"], fetch)

    assert len(calls) == 3
    first_wait = overture_import.OVERPASS_RETRY_DELAY_SECS
    assert sleeps == [first_wait, first_wait * 2]
    assert "attempt 2/3" in capsys.readouterr().out
    with db.connect(path) as connection:
        tables = {row["name"] for row in connection.execute("SELECT name FROM sqlite_master")}

    assert "osm_levels" not in tables


def test_malformed_release_fails_before_any_write(tmp_path, monkeypatch):
    path = str(tmp_path / "soe.db")
    written: list[str] = []
    monkeypatch.setattr(cli.db, "ensure_schema", lambda db_path: written.append("schema"))
    monkeypatch.setattr(cli, "import_cgaz", lambda *args: written.append("cgaz"))

    with pytest.raises(SystemExit, match="must look like"):
        cli.main(["import-boundaries", "--cgaz", "folder", "--overture", "latest", "--db", path])

    assert written == []
    assert not Path(path).exists()


def test_absent_release_fails_before_any_write(tmp_path, monkeypatch):
    path = str(tmp_path / "soe.db")
    written: list[str] = []

    def absent(release: str) -> None:
        raise SystemExit(f"Overture release {release} not found")

    monkeypatch.setattr(overture_import, "DuckDbSource", absent)
    monkeypatch.setattr(cli.db, "ensure_schema", lambda db_path: written.append("schema"))
    monkeypatch.setattr(cli, "import_cgaz", lambda *args: written.append("cgaz"))

    with pytest.raises(SystemExit, match="not found"):
        cli.main(["import-boundaries", "--cgaz", "folder", "--overture", RELEASE, "--db", path])

    assert written == []
    assert not Path(path).exists()


def test_release_name_is_checked_before_opening_s3():
    with pytest.raises(SystemExit, match="must look like"):
        open_release("2026-10-21")


def test_locality_under_region_becomes_municipality_only_without_localadmin(tmp_path):
    divisions = [
        division("it", "IT", "country"),
        division("lazio", "IT", "region", "it"),
        division("rome", "IT", "locality", "lazio", record_id="r1@1"),
        division("hamlet", "IT", "locality", "lazio", record_id="w2@1"),
        division("cz", "CZ", "country"),
        division("praha", "CZ", "region", "cz"),
        division("obec", "CZ", "localadmin", "praha", record_id="r3@1"),
        division("village", "CZ", "locality", "praha", record_id="r4@1"),
    ]
    catalog = Catalog(divisions)

    assert [item.id for item in catalog.divisions_at("IT", "municipality")] == ["rome"]
    assert [item.id for item in catalog.divisions_at("CZ", "municipality")] == ["obec"]


def test_locality_under_county_also_becomes_municipality_without_localadmin():
    catalog = Catalog(
        [
            division("it", "IT", "country"),
            division("lazio", "IT", "region", "it"),
            division("rm", "IT", "county", "lazio"),
            division("rome", "IT", "locality", "rm", record_id="r1@1"),
        ]
    )

    assert [item.id for item in catalog.divisions_at("IT", "municipality")] == ["rome"]


def test_municipalities_that_do_not_tile_their_parent_are_dropped():
    parts = [division(f"a{index}", "XX", "localadmin", "whole") for index in range(2)]
    scattered = [division(f"s{index}", "XX", "localadmin", "sparse") for index in range(3)]
    lone = [division("lone", "XX", "localadmin", "single")]
    areas = {"whole": 4.0, "a0": 2.0, "a1": 1.95, "sparse": 100.0, "s0": 1, "s1": 1, "s2": 1}
    areas |= {"single": 1.0, "lone": 1.0}

    kept, dropped_parents = tiling_municipalities([*parts, *scattered, *lone], areas)

    assert [item.id for item in kept] == ["a0", "a1"]
    assert dropped_parents == 2


def test_municipality_parent_names_county_and_state(tmp_path):
    source = FakeSource(
        [
            division("br", "BR", "country", english="Brazil"),
            division("sp", "BR", "region", "br", english="São Paulo"),
            division("campinas-county", "BR", "county", "sp", english="Campinas County"),
            division("campinas", "BR", "localadmin", "campinas-county", english="Campinas"),
            division("sumare", "BR", "localadmin", "campinas-county", english="Sumaré"),
        ],
        [
            land("br", box(-50, -25, -40, -20)),
            land("sp", box(-48, -24, -44, -22)),
            land("campinas-county", box(-47, -23, -45, -22)),
            land("campinas", box(-47, -23, -46, -22)),
            land("sumare", box(-46, -23, -45, -22)),
        ],
    )

    path = run_import(tmp_path, source)

    municipality = stored(path, "ovt:campinas")
    assert municipality["level"] == "municipality"
    assert municipality["parent_name"] == "Campinas County"
    assert municipality["state_name"] == "São Paulo"
    assert stored(path, "ovt:campinas-county")["parent_name"] == "São Paulo"


def test_parts_list_each_parent_with_its_dependencies_in_order(tmp_path):
    source = FakeSource(
        [
            division("fr", "FR", "country"),
            division("gf", "GF", "dependency", "fr"),
            division("re", "RE", "dependency", "fr"),
            division("de", "DE", "country"),
        ],
        [
            land("fr", box(0, 45, 5, 50)),
            land("gf", box(-54, 3, -52, 5)),
            land("re", box(55, -21, 56, -20)),
            land("de", box(6, 47, 14, 54)),
        ],
    )

    path = run_import(tmp_path, source)

    with db.connect(path) as connection:
        parts = [tuple(row) for row in connection.execute("SELECT * FROM boundary_parts")]

    assert parts == [("ovt:FR", 0, "ovt:FR"), ("ovt:FR", 1, "ovt:GF"), ("ovt:FR", 2, "ovt:RE")]
    assert stored(path, "ovt:FR+overseas") == {}


def test_compact_parent_gets_a_combined_area_named_after_its_dependencies(tmp_path):
    source = FakeSource(
        [
            division("cn", "CN", "country", name="中国", english="China"),
            division("hk", "HK", "dependency", "cn", name="香港", english="Hong Kong"),
            division("mo", "MO", "dependency", "cn", name="澳門", english="Macao"),
        ],
        [
            land("cn", box(75, 20, 130, 50)),
            land("hk", box(113.8, 22.1, 114.4, 22.6)),
            land("mo", box(113.5, 22.1, 113.6, 22.2)),
        ],
    )

    path = run_import(tmp_path, source)

    combined = stored(path, "ovt:CN+overseas")
    assert combined["name"] == "China with Hong Kong and Macao"
    assert combined["name_local"] == "中国 with 香港 and 澳門"
    assert combined["level"] == "country"


def test_combined_area_skips_parents_over_180_degrees():
    mainland = (-125.0, 25.0, -66.0, 49.0)
    guam = (144.0, 13.0, 145.0, 14.0)
    alaska_and_guam = (-170.0, 13.0, 144.0, 70.0)

    assert not is_compact([mainland, guam])
    assert not is_compact([alaska_and_guam, mainland])


def test_combined_area_skips_parents_that_would_be_mostly_empty_sea():
    norway = (4.0, 58.0, 31.0, 71.0)
    bouvet = (3.0, -54.5, 3.6, -54.3)
    china = (73.0, 18.0, 135.0, 54.0)
    hong_kong = (113.8, 22.1, 114.4, 22.6)

    assert not is_compact([norway, bouvet])
    assert is_compact([china, hong_kong])


def test_disputed_lines_are_stored_with_their_level(tmp_path):
    source = FakeSource([division("fr", "FR", "country")], [land("fr", box(0, 0, 1, 1))])
    source.disputed = [DisputedLine("line-1", "region", box(0, 0, 1, 2).exterior)]

    path = run_import(tmp_path, source)

    with db.connect(path) as connection:
        line = connection.execute("SELECT id, level, bbox_n FROM disputed_lines").fetchone()

    assert tuple(line) == ("line-1", "state", 2.0)


def test_import_replaces_earlier_overture_rows_and_keeps_other_sources(tmp_path):
    source = FakeSource([division("fr", "FR", "country")], [land("fr", box(0, 0, 1, 1))])
    path = run_import(tmp_path, source)
    db.add_boundaries(path, "other", [boundary_row("old:1", "state", "Old", source="other")])

    import_overture(path, source, no_levels)

    assert db.get_boundary(path, "old:1") is not None
    assert stored(path, "ovt:FR")["licence"] == "ODbL 1.0"
    assert not Path(f"{path}.staging").exists()


def test_other_run_staging_file_is_neither_attached_nor_deleted(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)

    other = tmp_path / "soe.db.staging-other-run"
    with sqlite3.connect(other) as connection:
        connection.execute("CREATE TABLE boundaries (id TEXT)")
        connection.execute("INSERT INTO boundaries VALUES ('ovt:DECOY')")
        connection.execute("COMMIT")
    before = other.read_bytes()

    source = FakeSource([division("fr", "FR", "country")], [land("fr", box(0, 0, 1, 1))])
    import_overture(path, source, no_levels)

    assert other.read_bytes() == before
    assert stored(path, "ovt:FR")
    assert stored(path, "ovt:DECOY") == {}
    assert list(tmp_path.glob("soe.db.staging-*")) == [other]


def test_row_credits_come_from_the_division_and_area_sources(tmp_path):
    source = FakeSource(
        [
            division("fr", "FR", "country", credits=frozenset({OSM})),
            division("de", "DE", "country", credits=frozenset({OSM, ESRI})),
            division("it", "IT", "country", credits=frozenset({OSM})),
        ],
        [
            land("fr", box(0, 0, 1, 1)),
            land("de", box(10, 0, 11, 1)),
            land("it", box(20, 0, 21, 1), frozenset({("geoBoundaries", "CC-BY-4.0")})),
        ],
    )

    path = run_import(tmp_path, source)

    assert stored(path, "ovt:FR")["licence"] == "ODbL 1.0"
    assert json.loads(stored(path, "ovt:FR")["contributors"]) == ["OpenStreetMap"]
    assert stored(path, "ovt:DE")["licence"] == "CC BY 4.0; ODbL 1.0"
    assert json.loads(stored(path, "ovt:DE")["contributors"]) == [
        "Esri Community Maps",
        "OpenStreetMap",
    ]
    assert json.loads(stored(path, "ovt:IT")["contributors"]) == ["OpenStreetMap", "geoBoundaries"]


def test_combined_area_credits_every_member(tmp_path):
    source = FakeSource(
        [
            division("cn", "CN", "country", credits=frozenset({OSM})),
            division("hk", "HK", "dependency", "cn", credits=frozenset({ESRI})),
        ],
        [land("cn", box(75, 20, 130, 50)), land("hk", box(113.8, 22.1, 114.4, 22.6))],
    )

    path = run_import(tmp_path, source)

    combined = stored(path, "ovt:CN+overseas")
    assert combined["licence"] == "CC BY 4.0; ODbL 1.0"
    assert json.loads(combined["contributors"]) == ["Esri Community Maps", "OpenStreetMap"]


def test_other_writers_are_not_blocked_while_rows_are_built(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)

    class WritesWhileBuilding(FakeSource):
        def areas(self, country: str, subtypes: tuple[str, ...]) -> Iterator[DivisionArea]:
            db.add_boundaries(path, "other", [boundary_row("o:1", "state", "O", source="other")])
            yield from super().areas(country, subtypes)

    building = WritesWhileBuilding([division("fr", "FR", "country")], [land("fr", box(0, 0, 1, 1))])

    import_overture(path, building, no_levels)

    assert db.get_boundary(path, "o:1") is not None
    assert stored(path, "ovt:FR")


def test_unrelated_writer_during_level_fill_keeps_the_import(tmp_path, monkeypatch):
    path = str(tmp_path / "soe.db")
    db.init(path)
    with db.connect(path) as connection:
        connection.execute("CREATE TABLE probe (id TEXT)")

    filled = threading.Event()
    original_connect = db.connect

    @contextmanager
    def delayed_connect(target: Path | str) -> Iterator[_DelayedReplaceConnection]:
        with original_connect(target) as real:
            yield _DelayedReplaceConnection(real, filled)

    writer_errors: list[Exception] = []

    def unrelated_write() -> None:
        assert filled.wait(timeout=10)
        try:
            with original_connect(path) as connection:
                connection.execute("INSERT INTO probe VALUES ('w1')")
        except Exception as error:  # noqa: BLE001 - the test reports the failure below.
            writer_errors.append(error)

    monkeypatch.setattr(db, "connect", delayed_connect)
    writer = threading.Thread(target=unrelated_write, daemon=True)
    writer.start()
    source = FakeSource(
        [division("fr", "FR", "country", record_id="r1@1")], [land("fr", box(0, 0, 1, 1))]
    )

    import_overture(path, source, no_levels)
    writer.join(timeout=10)

    assert not writer_errors
    assert stored(path, "ovt:FR")
    with original_connect(path) as connection:
        probe_count = connection.execute("SELECT count(*) FROM probe").fetchone()[0]

    assert probe_count == 1
    assert list(tmp_path.glob("soe.db.staging-*")) == []


def test_interrupted_disputed_lines_stops_the_levels_worker(tmp_path, monkeypatch):
    path = str(tmp_path / "soe.db")
    db.init(path)
    monkeypatch.setattr(overture_import, "OVERPASS_BATCH_IDS", 1)
    fetch_started = threading.Event()
    released = threading.Event()
    calls: list[list[int]] = []

    def gated_fetch(relation_ids: list[int]) -> dict[int, int | None]:
        calls.append(relation_ids)
        if len(calls) == 1:
            fetch_started.set()
            assert released.wait(timeout=10)
            time.sleep(0.3)
        return dict.fromkeys(relation_ids, 4)

    class InterruptsDisputed(FakeSource):
        def disputed_lines(self) -> list[DisputedLine]:
            assert fetch_started.wait(timeout=10)
            released.set()
            raise KeyboardInterrupt()

    created: list[overture_import._BackgroundLevels] = []
    original_levels = overture_import._BackgroundLevels

    class RecordingLevels(original_levels):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, **kwargs)
            created.append(self)

    monkeypatch.setattr(overture_import, "_BackgroundLevels", RecordingLevels)
    source = InterruptsDisputed(
        [
            division("fr", "FR", "country", record_id="r1@1"),
            division("de", "DE", "country", record_id="r2@1"),
        ],
        [land("fr", box(0, 0, 1, 1)), land("de", box(10, 0, 11, 1))],
    )

    with pytest.raises(KeyboardInterrupt):
        import_overture(path, source, gated_fetch)

    worker = created[0]
    worker.wait()
    assert worker._stopped.is_set()
    assert calls == [[1]]


def test_levels_fetched_while_geometry_is_read_fill_border_level(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)
    fetch_started = threading.Event()

    def fetch(relation_ids: list[int]) -> dict[int, int | None]:
        fetch_started.set()
        return dict.fromkeys(relation_ids, 4)

    class WaitsForFetch(FakeSource):
        def areas(self, country: str, subtypes: tuple[str, ...]) -> Iterator[DivisionArea]:
            assert fetch_started.wait(timeout=5)
            yield from super().areas(country, subtypes)

    source = WaitsForFetch(
        [division("fr", "FR", "country", record_id="r1@1")], [land("fr", box(0, 0, 1, 1))]
    )

    import_overture(path, source, fetch)

    assert stored(path, "ovt:FR")["border_level"] == 4
    assert list(tmp_path.glob("soe.db.staging-*")) == []


def test_failed_level_fetch_leaves_border_level_empty_and_completes_the_import(tmp_path, capsys):
    source = FakeSource(
        [
            division("fr", "FR", "country", record_id="r1@1"),
            division("de", "DE", "country", record_id="r2@1"),
        ],
        [land("fr", box(0, 0, 1, 1)), land("de", box(10, 0, 11, 1))],
    )

    def failing(relation_ids: list[int]) -> dict[int, int | None]:
        raise SystemExit("Overpass request failed")

    path = run_import(tmp_path, source, failing)

    assert stored(path, "ovt:FR")["border_level"] is None
    assert stored(path, "ovt:DE")["name"] == "de"
    assert "--overture-levels" in capsys.readouterr().out


def test_overture_levels_command_fills_only_the_missing_levels(tmp_path, monkeypatch):
    monkeypatch.setattr(overture_import, "OVERPASS_BATCH_IDS", 1)
    source = FakeSource(
        [
            division("fr", "FR", "country", record_id="r1@1"),
            division("de", "DE", "country", record_id="r2@1"),
        ],
        [land("fr", box(0, 0, 1, 1)), land("de", box(10, 0, 11, 1))],
    )
    calls: list[list[int]] = []

    def fails_second(relation_ids: list[int]) -> dict[int, int | None]:
        calls.append(relation_ids)
        if len(calls) == 2:
            raise SystemExit("Overpass request failed")

        return dict.fromkeys(relation_ids, 4)

    path = run_import(tmp_path, source, fails_second)
    asked: list[list[int]] = []

    def fetch(relation_ids: list[int]) -> dict[int, int | None]:
        asked.append(relation_ids)
        return dict.fromkeys(relation_ids, 6)

    filled = update_overture_levels(path, source, fetch)

    assert (stored(path, "ovt:FR")["border_level"], stored(path, "ovt:DE")["border_level"]) == (
        4,
        6,
    )
    assert filled == 1
    assert asked == [[2]]


def counties(count: int, parents: int = 3) -> FakeSource:
    """`count` US counties c1.. spread over `parents` parents, each with its own OSM relation."""
    numbers = range(1, count + 1)
    return FakeSource(
        [
            division(f"c{n}", "US", "county", f"p{n % parents}", record_id=f"r{n}@1")
            for n in numbers
        ],
        [land(f"c{n}", box(n, 0, n + 0.5, 1)) for n in numbers],
    )


def level_columns(path: str, count: int) -> list[tuple[int | None, int | None]]:
    return [
        (row["border_level"], row["border_level_sampled"])
        for row in (stored(path, f"ovt:c{n}") for n in range(1, count + 1))
    ]


def recording_fetch(
    level_of: Callable[[int], int | None], asked: list[int]
) -> Callable[[list[int]], dict[int, int | None]]:
    def fetch(relation_ids: list[int]) -> dict[int, int | None]:
        asked.extend(relation_ids)
        return {relation_id: level_of(relation_id) for relation_id in relation_ids}

    return fetch


def test_agreeing_sample_fills_the_whole_group_and_marks_the_rows_sampled(tmp_path, capsys):
    asked: list[int] = []

    path = run_import(tmp_path, counties(25), recording_fetch(lambda _: 6, asked))

    assert len(asked) == 10
    assert sorted(level_columns(path, 25)) == [(6, 0)] * 10 + [(6, 1)] * 15
    assert "1 groups, 10 relations sampled, 0 mixed, 15 rows filled, 0 rows without" in (
        capsys.readouterr().out
    )


def test_disagreeing_sample_fetches_the_whole_group(tmp_path, capsys):
    asked: list[int] = []

    path = run_import(tmp_path, counties(25), recording_fetch(lambda n: 6 + n % 2, asked))

    assert sorted(set(asked)) == list(range(1, 26))
    assert level_columns(path, 25) == [(6 + n % 2, 0) for n in range(1, 26)]
    assert "US county without state: mixed sample, fetching 15" in capsys.readouterr().out


def test_sample_without_any_level_leaves_the_group_empty(tmp_path):
    asked: list[int] = []

    path = run_import(tmp_path, counties(25), recording_fetch(lambda _: None, asked))

    assert len(asked) == 10
    assert level_columns(path, 25) == [(None, 0)] * 25


def test_levels_already_cached_count_toward_the_sample(tmp_path):
    source = counties(25)
    path = str(tmp_path / "soe.db")
    db.init(path)
    sample = overture_import._spread_sample(
        next(iter(Catalog(source.divisions()).relation_groups().values()))
    )
    overture_import._store_levels(path, {division.record_id: 5 for division in sample})
    asked: list[int] = []

    import_overture(path, source, recording_fetch(lambda _: 9, asked))

    assert asked == []
    assert level_columns(path, 25).count((5, 1)) == 15


def test_agreeing_sample_with_a_differing_cached_level_elsewhere_counts_as_mixed(tmp_path):
    source = counties(25)
    path = str(tmp_path / "soe.db")
    db.init(path)
    divisions = next(iter(Catalog(source.divisions()).relation_groups().values()))
    sample = overture_import._spread_sample(divisions)
    outside = next(division for division in divisions if division not in sample)
    levels = {division.record_id: 5 for division in sample} | {outside.record_id: 7}
    overture_import._store_levels(path, levels)
    asked: list[int] = []

    import_overture(path, source, recording_fetch(lambda _: 5, asked))

    assert sorted(set(asked)) == sorted(set(range(1, 26)) - {int(r[1:-2]) for r in levels})
    assert level_columns(path, 25).count((5, 0)) == 24


def test_sample_takes_every_parent_before_any_parent_twice():
    divisions = [
        division(f"a{n}", "US", "county", "pa", record_id=f"r{n}@1") for n in range(20)
    ] + [
        division("b", "US", "county", "pb", record_id="r30@1"),
        division("c", "US", "county", "pc", record_id="r31@1"),
    ]

    parents = [item.parent_id for item in overture_import._spread_sample(divisions)]

    assert (parents.count("pa"), parents.count("pb"), parents.count("pc")) == (8, 1, 1)


def test_full_levels_replace_sampled_values_and_clear_the_mark(tmp_path):
    source = counties(25)
    path = run_import(tmp_path, source, recording_fetch(lambda _: 6, []))
    asked: list[int] = []

    filled = update_overture_levels(path, source, recording_fetch(lambda _: 7, asked), full=True)

    assert len(asked) == 15
    assert filled == 15
    assert sorted(level_columns(path, 25)) == [(6, 0)] * 10 + [(7, 0)] * 15


def test_fetch_layer_finds_the_osm_relation_in_any_source_position():
    duckdb = pytest.importorskip("duckdb")
    connection = duckdb.connect()
    connection.execute(
        "CREATE TABLE division AS SELECT * FROM (VALUES "
        "('a', 'IT', 'locality', 'p', 'IT-X', {'primary': 'A', 'common': MAP {'en': 'A'}}, "
        "MAP {'en': 'x'}, [{'dataset': 'Esri Community Maps', 'license': 'CC-BY-4.0', "
        "'record_id': 'R1'}, {'dataset': 'OpenStreetMap', 'license': 'ODbL-1.0', "
        "'record_id': 'r5@3'}]), "
        "('b', 'IT', 'locality', 'p', 'IT-X', {'primary': 'B', 'common': MAP {}}, "
        "MAP {}, [{'dataset': 'OpenStreetMap', 'license': 'ODbL-1.0', 'record_id': 'w9@1'}])"
        ") AS t(id, country, subtype, parent_division_id, region, names, local_type, sources)"
    )
    source = object.__new__(overture_import.DuckDbSource)
    source._connection = connection

    found = source.divisions()

    assert [(item.id, item.record_id) for item in found] == [("a", "r5@3")]
    assert found[0].credits == {ESRI, OSM}


def two_states(per_state: int) -> FakeSource:
    """Counties c1.. split over states s0 (first half) and s1, each with its own OSM relation."""
    numbers = range(1, 2 * per_state + 1)
    counties_ = [
        division(f"c{n}", "US", "county", "s0" if n <= per_state else "s1", record_id=f"r{n}@1")
        for n in numbers
    ]
    states = [division(state, "US", "region") for state in ("s0", "s1")]

    return FakeSource(states + counties_, [land(f"c{n}", box(n, 0, n + 0.5, 1)) for n in numbers])


def test_mixed_group_whose_states_agree_is_filled_by_state_without_a_full_fetch(tmp_path, capsys):
    asked: list[int] = []

    path = run_import(
        tmp_path, two_states(25), recording_fetch(lambda n: 6 if n <= 25 else 7, asked)
    )

    assert len(set(asked)) < 50
    columns = level_columns(path, 50)
    assert [level for level, _ in columns] == [6] * 25 + [7] * 25
    assert sum(sampled for _, sampled in columns) == 30
    assert "US county: mixed, splitting into 2 states" in capsys.readouterr().out


def test_mixed_state_is_fetched_whole_while_agreeing_state_is_sampled(tmp_path, capsys):
    asked: list[int] = []

    path = run_import(
        tmp_path, two_states(25), recording_fetch(lambda n: 5 + n % 2 if n <= 25 else 8, asked)
    )

    assert set(range(1, 26)) <= set(asked)
    assert len(set(asked) - set(range(1, 26))) < 25
    columns = level_columns(path, 50)
    assert columns[:25] == [(5 + n % 2, 0) for n in range(1, 26)]
    assert [level for level, _ in columns[25:]] == [8] * 25
    assert "US county s0: mixed sample, fetching" in capsys.readouterr().out


def test_mixed_states_share_one_fetch_batch(tmp_path, capsys):
    batches: list[list[int]] = []

    def fetch(relation_ids: list[int]) -> dict[int, int | None]:
        batches.append(relation_ids)
        return {relation_id: 5 + relation_id % 2 for relation_id in relation_ids}

    run_import(tmp_path, two_states(25), fetch)

    assert [len(batch) for batch in batches] == [10, 10, 30]
    assert "Fetching 30 relations for 2 mixed states" in capsys.readouterr().out
