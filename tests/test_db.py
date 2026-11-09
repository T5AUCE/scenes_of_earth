"""Database tests: schema upgrades of existing files and scene state across restarts."""
import json
import sqlite3
from pathlib import Path

import pytest

from soe import db
from soe.scene_request import ID_CHARS
from tests.helpers import boundary_row

OLD_SCENES_TABLE = """
    CREATE TABLE scenes (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        progress REAL DEFAULT 0,
        error TEXT,
        error_class TEXT,
        request_json TEXT NOT NULL,
        bytes INTEGER,
        created TEXT NOT NULL,
        finished TEXT
    )
"""


def scene_columns(path: Path | str) -> set[str]:
    with db.connect(path) as connection:
        return {row["name"] for row in connection.execute("PRAGMA table_info(scenes)")}


def test_database_without_stage_column_gets_it_and_keeps_its_rows(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as connection:
        connection.execute(OLD_SCENES_TABLE)
        connection.execute(
            "INSERT INTO scenes (id, status, request_json, created) VALUES ('a', 'done', '{}', 'x')"
        )

    db.init(path)

    with db.connect(path) as connection:
        row = connection.execute("SELECT status, stage FROM scenes WHERE id='a'").fetchone()
    assert "stage" in scene_columns(path)
    assert row["status"] == "done" and row["stage"] is None


def test_init_twice_keeps_one_stage_column(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.init(path)

    assert "stage" in scene_columns(path)


def test_resubmitting_a_failed_scene_clears_its_stage(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.submit(path, "a", "{}", bundle_exists=False)
    db.update_scene(path, "a", status="failed", stage="Terrain 3/40")

    row, _ = db.submit(path, "a", "{}", bundle_exists=False)

    assert row["status"] == "queued" and row["stage"] is None


def test_search_hides_sample_country_covered_by_import(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "synthetic",
        [boundary_row("sample:kenya", "country", "Kenya", iso3="KEN", source="synthetic")],
    )
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [boundary_row("cgaz:ADM0:KEN", "country", "Kenya", iso3="KEN")],
    )

    assert [row["id"] for row in db.search(path, "Kenya")] == ["cgaz:ADM0:KEN"]


def test_search_finds_sample_country_without_import(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "synthetic",
        [boundary_row("sample:kenya", "country", "Kenya", iso3="KEN", source="synthetic")],
    )

    assert [row["id"] for row in db.search(path, "Kenya")] == ["sample:kenya"]


def test_imported_country_leaves_sample_lookup_by_id(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "synthetic",
        [boundary_row("sample:kenya", "country", "Kenya", iso3="KEN", source="synthetic")],
    )
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [boundary_row("cgaz:ADM0:KEN", "country", "Kenya", iso3="KEN")],
    )

    assert db.get_boundary(path, "sample:kenya")["name"] == "Kenya"


def test_search_returns_each_countrys_own_level_name(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [
            boundary_row("cgaz:ADM1:KEN1", "state", "Nakuru", "Kenya", "KEN"),
            boundary_row("cgaz:ADM0:KEN", "country", "Kenya", iso3="KEN"),
            boundary_row("city:nairobi", "city", "Nairobi", "Kenya", "KEN"),
            boundary_row("cgaz:ADM2:CHE1", "county", "Sion", "Valais", "CHE"),
        ],
    )
    db.set_admin_kinds(path, [("KEN", "state", "County"), ("CHE", "county", "District")])

    assert db.search(path, "Nakuru")[0]["kind"] == "County"
    assert db.search(path, "Sion")[0]["kind"] == "District"
    assert db.search(path, "Kenya")[0]["kind"] is None
    assert db.search(path, "Nairobi")[0]["kind"] is None


def test_set_admin_kinds_counts_distinct_keys_once(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    repeated = ("IND", "state", "State / Union Territory")

    assert db.set_admin_kinds(path, [repeated, repeated]) == 1


def test_search_keeps_same_name_states(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [
            boundary_row("cgaz:ADM1:A", "state", "Springfield", iso3="USA"),
            boundary_row("cgaz:ADM1:B", "state", "Springfield", iso3="CAN"),
        ],
    )

    assert {row["id"] for row in db.search(path, "Springfield")} == {
        "cgaz:ADM1:A",
        "cgaz:ADM1:B",
    }


def test_startup_marks_interrupted_and_repost_requeues(tmp_path):
    path = str(tmp_path / "soe.db")
    scene_id = "a" * ID_CHARS
    db.init(path)
    db.submit(path, scene_id, "{}", True)
    db.update_scene(path, scene_id, status="running")
    db.init(path)  # simulated restart

    row = db.get_scene(path, scene_id)
    assert row["status"] == "failed" and row["error"] == "interrupted"

    row, start = db.submit(path, scene_id, "{}", True)
    assert start and row["status"] == "queued" and row["error"] is None

    assert db.submit(path, scene_id, "{}", True)[1] is False


def test_search_matches_official_long_name_for_america(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [
            boundary_row("cgaz:ADM0:USA", "country", "United States", iso3="USA"),
            boundary_row("cgaz:ADM0:GBR", "country", "United Kingdom", iso3="GBR"),
        ],
    )

    assert [row["id"] for row in db.search(path, "america")] == ["cgaz:ADM0:USA"]


def test_search_matches_official_long_name_for_kingdom(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [
            boundary_row("cgaz:ADM0:USA", "country", "United States", iso3="USA"),
            boundary_row("cgaz:ADM0:GBR", "country", "United Kingdom", iso3="GBR"),
            boundary_row("cgaz:ADM0:SAU", "country", "Saudi Arabia", iso3="SAU"),
        ],
    )
    hits = [row["id"] for row in db.search(path, "kingdom")]

    assert "cgaz:ADM0:GBR" in hits
    assert "cgaz:ADM0:SAU" in hits
    assert hits[0] == "cgaz:ADM0:GBR"


def test_geometry_digest_changes_on_geometry_edit_but_not_on_identical_reimport(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [boundary_row("cgaz:ADM1:NBO", "state", "Nairobi", "Kenya", "KEN")],
    )
    before = db.get_boundary(path, "cgaz:ADM1:NBO")["geom_digest"]

    legacy = boundary_row("cgaz:ADM1:NBO", "state", "Nairobi", "Kenya", "KEN")
    with db.connect(path) as connection:
        connection.execute(db.INSERT_BOUNDARY, db._complete_row(legacy))
    assert db.get_boundary(path, "cgaz:ADM1:NBO")["geom_digest"] == before

    edited = boundary_row(
        "cgaz:ADM1:NBO",
        "state",
        "Nairobi",
        "Kenya",
        "KEN",
        geometry='{"edited": true}',
    )
    db.add_boundaries(path, "geoBoundaries CGAZ", [edited])

    assert db.get_boundary(path, "cgaz:ADM1:NBO")["geom_digest"] != before


def test_old_database_without_preview_column_gets_it_with_null_previews(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE boundaries (id TEXT PRIMARY KEY, level TEXT NOT NULL, "
            "name TEXT NOT NULL, parent_name TEXT, iso3 TEXT, bbox_w REAL, bbox_s REAL, "
            "bbox_e REAL, bbox_n REAL, cells INTEGER, geom_geojson TEXT NOT NULL, "
            "source TEXT NOT NULL, licence TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT INTO boundaries VALUES ('x', 'state', 'Old', '', 'TST', 0, 0, 1, 1, "
            "1, '{}', 'geoBoundaries CGAZ', 'CC BY 4.0')"
        )

    db.init(path)
    db.init(path)

    with db.connect(path) as connection:
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(boundaries)")}
    assert "preview_geojson" in columns
    assert db.get_boundary(path, "x")["preview_geojson"] is None


def test_get_boundary_without_geometry_skips_the_full_text(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    stored = boundary_row("x:1", "state", "Big", geometry='{"waste": "%s"}' % ("x" * 1000))
    db.add_boundaries(path, "geoBoundaries CGAZ", [stored])

    light = db.get_boundary(path, "x:1", with_geometry=False)

    assert "geom_geojson" not in light
    assert light["geom_digest"] == db.geometry_digest(stored[10])
    assert light["preview_geojson"] is None
    assert db.get_boundary(path, "x:1")["geom_geojson"] == stored[10]


def test_add_boundaries_stores_a_digest_for_legacy_rows(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    stored = boundary_row("x:1", "state", "Old")
    db.add_boundaries(path, "geoBoundaries CGAZ", [stored])

    row = db.get_boundary(path, "x:1")

    assert row["preview_geojson"] is None
    assert row["geom_digest"] == db.geometry_digest(stored[10])


def test_add_boundaries_rejects_a_row_of_the_wrong_length(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)

    with pytest.raises(ValueError, match="expected 13, 14 or 15"):
        db.add_boundaries(path, "geoBoundaries CGAZ", [("x:1",)])


def test_boundary_preview_helpers_count_fetch_and_store(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [boundary_row("x:1", "state", "One"), boundary_row("x:2", "state", "Two")],
    )

    assert db.count_boundaries_missing_preview(path) == 2
    assert [record["id"] for record in db.fetch_boundaries_missing_preview(path, 1)] == ["x:1"]

    first = db.get_boundary(path, "x:1")

    assert db.set_boundary_preview(path, "x:1", "{}", first["geom_digest"], first["geom_digest"])

    assert db.count_boundaries_missing_preview(path) == 1

    second = db.get_boundary(path, "x:2")

    assert db.set_boundary_previews(
        path,
        [("x:2", "{}", second["geom_digest"], second["geom_digest"])],
    ) == 1

    assert db.count_boundaries_missing_preview(path) == 0
    assert db.get_boundary(path, "x:2", with_geometry=False)["preview_geojson"] == "{}"


def test_guarded_preview_write_stores_when_the_geometry_is_unchanged(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(path, "geoBoundaries CGAZ", [boundary_row("x:1", "state", "One")])
    row = db.get_boundary(path, "x:1")

    assert db.set_boundary_preview(
        path,
        "x:1",
        '{"new": true}',
        row["geom_digest"],
        row["geom_digest"],
    )

    assert db.get_boundary(path, "x:1")["preview_geojson"] == '{"new": true}'


def test_guarded_preview_write_keeps_a_concurrent_reimport(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [boundary_row("x:1", "state", "One", geometry='{"old": true}')],
    )
    fetched = db.get_boundary(path, "x:1")
    old_preview = '{"old": true}'

    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [boundary_row("x:1", "state", "One", geometry='{"new": true}')],
    )
    current = db.get_boundary(path, "x:1")
    db.set_boundary_preview(
        path,
        "x:1",
        '{"fresh": true}',
        current["geom_digest"],
        current["geom_digest"],
    )

    assert db.set_boundary_preview(
        path,
        "x:1",
        old_preview,
        fetched["geom_digest"],
        db.geometry_digest('{"old": true}'),
    ) is False

    assert db.get_boundary(path, "x:1")["preview_geojson"] == '{"fresh": true}'


def test_old_database_without_digest_column_gets_it_with_null_digests(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE boundaries (id TEXT PRIMARY KEY, level TEXT NOT NULL, "
            "name TEXT NOT NULL, parent_name TEXT, iso3 TEXT, bbox_w REAL, bbox_s REAL, "
            "bbox_e REAL, bbox_n REAL, cells INTEGER, geom_geojson TEXT NOT NULL, "
            "source TEXT NOT NULL, licence TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT INTO boundaries VALUES ('x', 'state', 'Old', '', 'TST', 0, 0, 1, 1, "
            "1, '{}', 'geoBoundaries CGAZ', 'CC BY 4.0')"
        )

    db.init(path)
    db.init(path)

    with db.connect(path) as connection:
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(boundaries)")}
    assert "geom_digest" in columns
    assert "preview_geojson" in columns
    assert db.get_boundary(path, "x")["geom_digest"] is None

    assert db.count_boundaries_missing_digest(path) == 1

    from soe.cli import backfill_area_previews

    assert backfill_area_previews(str(path)) == 1
    assert db.count_boundaries_missing_digest(path) == 0
    assert db.get_boundary(path, "x")["geom_digest"] == db.geometry_digest("{}")


def test_backfill_leaves_queued_and_running_scenes_alone(tmp_path):
    from soe.cli import backfill_area_previews

    path = str(tmp_path / "soe.db")
    db.init(path)
    db.add_boundaries(path, "geoBoundaries CGAZ", [boundary_row("x:1", "state", "One")])
    db.submit(path, "a" * ID_CHARS, "{}", bundle_exists=False)
    db.submit(path, "b" * ID_CHARS, "{}", bundle_exists=False)
    db.update_scene(path, "b" * ID_CHARS, status="running")

    assert backfill_area_previews(path) == 1
    assert backfill_area_previews(path) == 0

    assert db.get_scene(path, "a" * ID_CHARS)["status"] == "queued"
    assert db.get_scene(path, "b" * ID_CHARS)["status"] == "running"


def test_ensure_schema_leaves_queued_and_running_scenes_alone(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)
    db.submit(path, "a" * ID_CHARS, "{}", bundle_exists=False)
    db.update_scene(path, "a" * ID_CHARS, status="running")

    db.ensure_schema(path)

    assert db.get_scene(path, "a" * ID_CHARS)["status"] == "running"


def test_backfill_area_previews_fills_missing_previews(tmp_path):
    from soe import api
    from soe.cli import backfill_area_previews

    path = str(tmp_path / "soe.db")
    db.init(path)
    db.add_boundaries(path, "geoBoundaries CGAZ", [boundary_row("x:1", "state", "One")])

    assert db.count_boundaries_missing_preview(path) == 1
    assert backfill_area_previews(path) == 1

    row = db.get_boundary(path, "x:1")

    assert json.loads(row["preview_geojson"]) == api._simplify_geometry(row)
    assert db.count_boundaries_missing_preview(path) == 0


def test_backfill_area_previews_skips_a_row_whose_geometry_is_not_json(tmp_path, capsys):
    from soe.cli import backfill_area_previews

    path = str(tmp_path / "soe.db")
    db.init(path)
    db.add_boundaries(
        path,
        "geoBoundaries CGAZ",
        [boundary_row("x:bad", "state", "Bad", geometry="not json")],
    )

    assert backfill_area_previews(path, batch_size=1) == 0
    assert db.count_boundaries_missing_preview(path) == 1
    assert "skipping x:bad" in capsys.readouterr().out
