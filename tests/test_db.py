"""Database tests: schema upgrades of existing files and scene state across restarts."""

import json
import sqlite3
from pathlib import Path

import pytest
from shapely.geometry import box, mapping

from soe import db, land
from soe.areas import Area
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
        path, "Overture Maps divisions", [boundary_row("ovt:KE", "country", "Kenya", iso3="KEN")]
    )

    assert [row["id"] for row in db.search(path, "Kenya")] == ["ovt:KE"]


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
        path, "Overture Maps divisions", [boundary_row("ovt:KE", "country", "Kenya", iso3="KEN")]
    )

    assert db.get_boundary(path, "sample:kenya")["name"] == "Kenya"


def test_search_returns_each_countrys_own_level_name(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [
            boundary_row("ovt:KEN1", "state", "Nakuru", "Kenya", "KEN"),
            boundary_row("ovt:KE", "country", "Kenya", iso3="KEN"),
            boundary_row("city:nairobi", "city", "Nairobi", "Kenya", "KEN"),
            boundary_row("ovt:CHE1", "county", "Sion", "Valais", "CHE"),
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
        "Overture Maps divisions",
        [
            boundary_row("ovt:A", "state", "Springfield", iso3="USA"),
            boundary_row("ovt:B", "state", "Springfield", iso3="CAN"),
        ],
    )

    assert {row["id"] for row in db.search(path, "Springfield")} == {"ovt:A", "ovt:B"}


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
        "Overture Maps divisions",
        [
            boundary_row("ovt:US", "country", "United States", iso3="USA"),
            boundary_row("ovt:GB", "country", "United Kingdom", iso3="GBR"),
        ],
    )

    assert [row["id"] for row in db.search(path, "america")] == ["ovt:US"]


def test_search_matches_official_long_name_for_kingdom(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [
            boundary_row("ovt:US", "country", "United States", iso3="USA"),
            boundary_row("ovt:GB", "country", "United Kingdom", iso3="GBR"),
            boundary_row("ovt:SA", "country", "Saudi Arabia", iso3="SAU"),
        ],
    )
    hits = [row["id"] for row in db.search(path, "kingdom")]

    assert "ovt:GB" in hits
    assert "ovt:SA" in hits
    assert hits[0] == "ovt:GB"


def test_geometry_digest_changes_on_geometry_edit_but_not_on_identical_reimport(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [boundary_row("ovt:NBO", "state", "Nairobi", "Kenya", "KEN")],
    )
    before = db.get_boundary(path, "ovt:NBO")["geom_digest"]

    legacy = boundary_row("ovt:NBO", "state", "Nairobi", "Kenya", "KEN")
    with db.connect(path) as connection:
        connection.execute(db.INSERT_BOUNDARY, db._complete_row(legacy))

    assert db.get_boundary(path, "ovt:NBO")["geom_digest"] == before

    edited = boundary_row(
        "ovt:NBO", "state", "Nairobi", "Kenya", "KEN", geometry='{"edited": true}'
    )
    db.add_boundaries(path, "Overture Maps divisions", [edited])

    assert db.get_boundary(path, "ovt:NBO")["geom_digest"] != before


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
            "1, '{}', 'Overture Maps divisions', 'CC BY 4.0')"
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
    db.add_boundaries(path, "Overture Maps divisions", [stored])

    light = db.get_boundary(path, "x:1", with_geometry=False)

    assert "geom_geojson" not in light
    assert light["geom_digest"] == db.geometry_digest(stored[10])
    assert light["preview_geojson"] is None
    assert db.get_boundary(path, "x:1")["geom_geojson"] == stored[10]


def test_add_boundaries_stores_a_digest_for_legacy_rows(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    stored = boundary_row("x:1", "state", "Old")
    db.add_boundaries(path, "Overture Maps divisions", [stored])

    row = db.get_boundary(path, "x:1")

    assert row["preview_geojson"] is None
    assert row["geom_digest"] == db.geometry_digest(stored[10])


def test_add_boundaries_rejects_a_row_of_the_wrong_length(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)

    with pytest.raises(ValueError, match="expected 13, 14 or 15"):
        db.add_boundaries(path, "Overture Maps divisions", [("x:1",)])


def test_boundary_preview_helpers_count_fetch_and_store(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [boundary_row("x:1", "state", "One"), boundary_row("x:2", "state", "Two")],
    )

    assert db.count_boundaries_missing_preview(path) == 2
    assert [record["id"] for record in db.fetch_boundaries_missing_preview(path, 1)] == ["x:1"]

    first = db.get_boundary(path, "x:1")

    assert db.set_boundary_preview(path, "x:1", "{}", first["geom_digest"], first["geom_digest"])

    assert db.count_boundaries_missing_preview(path) == 1

    second = db.get_boundary(path, "x:2")

    assert (
        db.set_boundary_previews(
            path, [("x:2", "{}", second["geom_digest"], second["geom_digest"])]
        )
        == 1
    )

    assert db.count_boundaries_missing_preview(path) == 0
    assert db.get_boundary(path, "x:2", with_geometry=False)["preview_geojson"] == "{}"


def test_guarded_preview_write_stores_when_the_geometry_is_unchanged(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(path, "Overture Maps divisions", [boundary_row("x:1", "state", "One")])
    row = db.get_boundary(path, "x:1")

    assert db.set_boundary_preview(
        path, "x:1", '{"new": true}', row["geom_digest"], row["geom_digest"]
    )

    assert db.get_boundary(path, "x:1")["preview_geojson"] == '{"new": true}'


def test_guarded_preview_write_keeps_a_concurrent_reimport(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [boundary_row("x:1", "state", "One", geometry='{"old": true}')],
    )
    fetched = db.get_boundary(path, "x:1")
    old_preview = '{"old": true}'

    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [boundary_row("x:1", "state", "One", geometry='{"new": true}')],
    )
    current = db.get_boundary(path, "x:1")
    db.set_boundary_preview(
        path, "x:1", '{"fresh": true}', current["geom_digest"], current["geom_digest"]
    )

    assert (
        db.set_boundary_preview(
            path, "x:1", old_preview, fetched["geom_digest"], db.geometry_digest('{"old": true}')
        )
        is False
    )

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
            "1, '{}', 'Overture Maps divisions', 'CC BY 4.0')"
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
    db.add_boundaries(path, "Overture Maps divisions", [boundary_row("x:1", "state", "One")])
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
    db.add_boundaries(path, "Overture Maps divisions", [boundary_row("x:1", "state", "One")])

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
        "Overture Maps divisions",
        [boundary_row("x:bad", "state", "Bad", geometry="not json")],
    )

    assert backfill_area_previews(path, batch_size=1) == 0
    assert db.count_boundaries_missing_preview(path) == 1
    assert "skipping x:bad" in capsys.readouterr().out


def test_search_matches_local_name_and_alias(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [
            boundary_row(
                "ovt:NO", "country", "Norway", iso3="NOR", source="Overture Maps divisions"
            ),
            boundary_row(
                "ovt:CN", "country", "China", iso3="CHN", source="Overture Maps divisions"
            ),
            boundary_row(
                "ovt:GF", "country", "French Guiana", iso3="GUF", source="Overture Maps divisions"
            ),
        ],
    )
    with db.connect(path) as connection:
        connection.execute(
            "UPDATE boundaries SET name_local = 'Norge', aliases = ? WHERE id = 'ovt:NO'",
            (json.dumps(["Noreg"]),),
        )
        connection.execute("UPDATE boundaries SET name_local = '中国' WHERE id = 'ovt:CN'")
        connection.execute("UPDATE boundaries SET aliases = '\"oops\"' WHERE id = 'ovt:CN'")
        connection.execute(
            "UPDATE boundaries SET aliases = ? WHERE id = 'ovt:GF'",
            (json.dumps(["Région Guyane"]),),
        )

    db.sync_search_names(path)

    assert [row["id"] for row in db.search(path, "norge")] == ["ovt:NO"]
    assert [row["id"] for row in db.search(path, "noreg")] == ["ovt:NO"]
    assert [row["id"] for row in db.search(path, "中国")] == ["ovt:CN"]
    assert [row["id"] for row in db.search(path, "guyane")] == ["ovt:GF"]


def test_plain_country_ranks_above_combined_area(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [
            boundary_row(
                "ovt:FI",
                "country",
                "Finland",
                iso3="FIN",
                cells=100,
                source="Overture Maps divisions",
            ),
            boundary_row(
                "ovt:FI+overseas",
                "country",
                "Finland with Åland Islands",
                iso3="FIN",
                cells=200,
                source="Overture Maps divisions",
            ),
        ],
    )

    assert [row["id"] for row in db.search(path, "finland")] == ["ovt:FI", "ovt:FI+overseas"]
    assert [row["id"] for row in db.search(path, "Åland")] == ["ovt:FI+overseas"]


def test_search_matches_phrase_after_a_word_boundary(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [
            boundary_row(
                "ovt:NSW",
                "state",
                "New South Wales",
                "Australia",
                "AUS",
                source="Overture Maps divisions",
            )
        ],
    )
    with db.connect(path) as connection:
        connection.execute(
            "UPDATE boundaries SET name_local = 'Nueva Gales del Sur' WHERE id = 'ovt:NSW'"
        )
        connection.execute(
            "UPDATE boundaries SET aliases = ? WHERE id = 'ovt:NSW'",
            (json.dumps(["Great Southern Land"]),),
        )

    db.sync_search_names(path)

    assert [row["id"] for row in db.search(path, "south wa")] == ["ovt:NSW"]
    assert [row["id"] for row in db.search(path, "gales del")] == ["ovt:NSW"]
    assert [row["id"] for row in db.search(path, "southern la")] == ["ovt:NSW"]
    assert db.search(path, "outh wa") == []
    assert db.search(path, "ew south") == []


def staged_row(
    row_id: str,
    level: str = "state",
    name: str = "X",
    source: str = "Overture Maps divisions",
    aliases: str = "[]",
) -> tuple:
    """One staged Overture row in STAGED_COLUMNS order, for direct store_overture calls."""
    return (
        row_id,
        level,
        name,
        "",
        "TST",
        0,
        0,
        1,
        1,
        10,
        "{}",
        "0" * 16,
        None,
        source,
        "ODbL 1.0",
        None,
        None,
        None,
        None,
        0,
        None,
        aliases,
        "[]",
        0,
        None,
    )


def token_ids(path: Path | str) -> set[str]:
    """Ids that hold search tokens."""
    with db.connect(path) as connection:
        return {
            row["boundary_id"]
            for row in connection.execute("SELECT DISTINCT boundary_id FROM boundary_names")
        }


def orphan_token_count(path: Path | str) -> int:
    """Token rows whose boundary no longer exists."""
    with db.connect(path) as connection:
        return connection.execute(
            "SELECT COUNT(*) FROM boundary_names "
            "WHERE boundary_id NOT IN (SELECT id FROM boundaries)"
        ).fetchone()[0]


def test_failed_replacement_rolls_back_rows_and_tokens(tmp_path, monkeypatch):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path, "Overture Maps divisions", [boundary_row("ovt:OLD", "country", "Oldland", iso3="OLD")]
    )

    def boom(connection: sqlite3.Connection, source: str | None, levels=None) -> int:
        raise RuntimeError("token build failed")

    monkeypatch.setattr(db, "_insert_source_search_state", boom)

    with pytest.raises(RuntimeError, match="token build failed"):
        db.add_boundaries(
            path,
            "Overture Maps divisions",
            [boundary_row("ovt:NEW", "country", "Newland", iso3="NEW")],
        )

    assert db.get_boundary(path, "ovt:OLD")["name"] == "Oldland"
    assert db.get_boundary(path, "ovt:NEW") is None
    assert [row["id"] for row in db.search(path, "oldland")] == ["ovt:OLD"]
    assert db.search(path, "newland") == []
    assert token_ids(path) == {"ovt:OLD"}


def test_replacement_removes_tokens_of_replaced_ids(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [boundary_row("ovt:A", "state", "Alpha"), boundary_row("ovt:B", "state", "Beta")],
    )
    db.add_boundaries(path, "Overture Maps divisions", [boundary_row("ovt:C", "state", "Gamma")])

    assert token_ids(path) == {"ovt:C"}
    assert orphan_token_count(path) == 0
    assert db.search(path, "alpha") == []
    assert [row["id"] for row in db.search(path, "gamma")] == ["ovt:C"]


def test_empty_replacement_clears_tokens_and_country_coverage(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "synthetic",
        [boundary_row("sample:kenya", "country", "Kenya", iso3="KEN", source="synthetic")],
    )
    db.add_boundaries(
        path, "Overture Maps divisions", [boundary_row("ovt:KE", "country", "Kenya", iso3="KEN")]
    )

    assert [row["id"] for row in db.search(path, "Kenya")] == ["ovt:KE"]

    db.add_boundaries(path, "Overture Maps divisions", [])

    assert [row["id"] for row in db.search(path, "Kenya")] == ["sample:kenya"]
    with db.connect(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM imported_country_iso3").fetchone()[0] == 0


def test_store_overture_failure_rolls_back_rows_and_tokens(tmp_path, monkeypatch):
    from soe.boundary_import import store_overture

    path = str(tmp_path / "soe.db")
    db.init(path)
    store_overture(
        path,
        "Overture Maps divisions",
        [staged_row("ovt:AA", level="country", name="Alandia")],
        [],
        [],
        lambda: None,
    )

    def boom(connection: sqlite3.Connection, source: str | None, levels=None) -> int:
        raise RuntimeError("token build failed")

    monkeypatch.setattr(db, "_insert_source_search_state", boom)

    with pytest.raises(RuntimeError, match="token build failed"):
        store_overture(
            path,
            "Overture Maps divisions",
            [staged_row("ovt:BB", level="country", name="Bermuda")],
            [],
            [],
            lambda: None,
        )

    assert db.get_boundary(path, "ovt:AA")["name"] == "Alandia"
    assert db.get_boundary(path, "ovt:BB") is None
    assert [row["id"] for row in db.search(path, "alandia")] == ["ovt:AA"]
    assert db.search(path, "bermuda") == []
    assert token_ids(path) == {"ovt:AA"}


def test_store_overture_city_failure_rolls_back(tmp_path, monkeypatch):
    from soe.boundary_import import store_overture

    path = str(tmp_path / "soe.db")
    db.init(path)
    store_overture(
        path,
        "Overture Maps divisions",
        [
            staged_row("ovt:CC", level="country", name="Candia"),
            staged_row("ovt:CC-1", level="city", name="Oldcity"),
        ],
        [],
        [],
        lambda: None,
    )

    def boom(connection: sqlite3.Connection, source: str | None, levels=None) -> int:
        raise RuntimeError("token build failed")

    monkeypatch.setattr(db, "_insert_source_search_state", boom)

    with pytest.raises(RuntimeError, match="token build failed"):
        store_overture(
            path,
            "Overture Maps divisions",
            [staged_row("ovt:CC-2", level="city", name="Newcity")],
            [],
            [],
            lambda: None,
            levels=("city",),
        )

    assert db.get_boundary(path, "ovt:CC-1")["name"] == "Oldcity"
    assert db.get_boundary(path, "ovt:CC-2") is None
    assert [row["id"] for row in db.search(path, "oldcity")] == ["ovt:CC-1"]
    assert db.search(path, "newcity") == []


def test_full_replacement_removes_tokens_of_replaced_ids(tmp_path):
    from soe.boundary_import import store_overture

    path = str(tmp_path / "soe.db")
    db.init(path)
    store_overture(
        path,
        "Overture Maps divisions",
        [staged_row("ovt:AA", level="country", name="Alandia")],
        [],
        [],
        lambda: None,
    )
    store_overture(
        path,
        "Overture Maps divisions",
        [staged_row("ovt:BB", level="country", name="Bermuda")],
        [],
        [],
        lambda: None,
    )

    assert db.get_boundary(path, "ovt:AA") is None
    assert token_ids(path) == {"ovt:BB"}
    assert orphan_token_count(path) == 0


def test_city_only_replacement_keeps_other_levels_tokens(tmp_path):
    from soe.boundary_import import store_overture

    path = str(tmp_path / "soe.db")
    db.init(path)
    store_overture(
        path,
        "Overture Maps divisions",
        [
            staged_row("ovt:CC", level="country", name="Candia"),
            staged_row("ovt:CC-1", level="city", name="Oldcity"),
        ],
        [],
        [],
        lambda: None,
    )
    store_overture(
        path,
        "Overture Maps divisions",
        [staged_row("ovt:CC-2", level="city", name="Newcity")],
        [],
        [],
        lambda: None,
        levels=("city",),
    )

    assert db.get_boundary(path, "ovt:CC") is not None
    assert db.get_boundary(path, "ovt:CC-1") is None
    assert token_ids(path) == {"ovt:CC", "ovt:CC-2"}
    assert orphan_token_count(path) == 0
    assert db.search(path, "oldcity") == []


def test_empty_store_overture_removes_source_tokens(tmp_path):
    from soe.boundary_import import store_overture

    path = str(tmp_path / "soe.db")
    db.init(path)
    store_overture(
        path,
        "Overture Maps divisions",
        [staged_row("ovt:AA", level="country", name="Alandia")],
        [],
        [],
        lambda: None,
    )
    store_overture(path, "Overture Maps divisions", [], [], [], lambda: None)

    assert db.get_boundary(path, "ovt:AA") is None
    assert token_ids(path) == set()
    assert orphan_token_count(path) == 0


def test_removing_one_source_keeps_other_sources_country_coverage(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "synthetic",
        [boundary_row("sample:kenya", "country", "Kenya", iso3="KEN", source="synthetic")],
    )
    db.add_boundaries(
        path, "other", [boundary_row("other:KE", "country", "Kenya", iso3="KEN", source="other")]
    )
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [boundary_row("ovt:KE", "country", "Kenya", iso3="KEN", source="Overture Maps divisions")],
    )

    assert {row["id"] for row in db.search(path, "Kenya")} == {"other:KE", "ovt:KE"}

    db.add_boundaries(path, "other", [])

    assert {row["id"] for row in db.search(path, "Kenya")} == {"ovt:KE"}


def test_require_search_names_fails_on_unmigrated_database(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)
    with db.connect(path) as connection:
        connection.executemany(
            db.INSERT_BOUNDARY, [db._complete_row(boundary_row("x:1", "state", "Place"))]
        )

    with pytest.raises(SystemExit, match="rebuild-search-names"):
        db.require_search_names(path)


def test_require_search_names_passes_for_empty_and_migrated_databases(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)
    db.require_search_names(path)

    db.add_boundaries(path, "Overture Maps divisions", [boundary_row("x:1", "state", "One")])
    db.require_search_names(path)


def test_rebuild_search_names_command_restores_search(tmp_path, capsys):
    from soe import cli

    path = str(tmp_path / "soe.db")
    db.init(path)
    with db.connect(path) as connection:
        connection.executemany(
            db.INSERT_BOUNDARY,
            [
                db._complete_row(boundary_row("x:1", "state", "One")),
                db._complete_row(boundary_row("x:2", "state", "Two")),
            ],
        )

    assert db.search(path, "one") == []

    cli.main(["rebuild-search-names", "--db", path])

    assert [row["id"] for row in db.search(path, "one")] == ["x:1"]
    assert [row["id"] for row in db.search(path, "two")] == ["x:2"]
    db.require_search_names(path)
    assert "Search names:" in capsys.readouterr().out


def test_startup_rejects_partially_migrated_database(tmp_path):
    from soe import cli

    path = str(tmp_path / "soe.db")
    db.init(path)
    with db.connect(path) as connection:
        connection.executemany(
            db.INSERT_BOUNDARY,
            [db._complete_row(boundary_row("old:1", "state", "Oldland", source="legacy"))],
        )

    db.add_boundaries(
        path, "Overture Maps divisions", [boundary_row("ovt:NEW", "country", "Newland")]
    )

    with pytest.raises(SystemExit, match="rebuild-search-names"):
        db.require_search_names(path)

    assert [row["id"] for row in db.search(path, "newland")] == ["ovt:NEW"]
    assert db.search(path, "oldland") == []

    cli.rebuild_search_names(path)
    db.require_search_names(path)

    assert [row["id"] for row in db.search(path, "oldland")] == ["old:1"]


def test_startup_rejects_city_only_import_on_legacy_database(tmp_path):
    from soe.boundary_import import store_overture

    path = str(tmp_path / "soe.db")
    db.init(path)
    with db.connect(path) as connection:
        connection.executemany(
            db.INSERT_BOUNDARY,
            [db._complete_row(boundary_row("old:1", "state", "Oldland", source="legacy"))],
        )

    store_overture(
        path,
        "Overture Maps divisions",
        [staged_row("ovt:CC-1", level="city", name="Newcity")],
        [],
        [],
        lambda: None,
        levels=("city",),
    )

    with pytest.raises(SystemExit, match="rebuild-search-names"):
        db.require_search_names(path)

    assert [row["id"] for row in db.search(path, "newcity")] == ["ovt:CC-1"]
    assert db.search(path, "oldland") == []


def test_old_database_gains_the_disputed_clip_column_and_the_clip_columns_of_boundaries(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE land_clips (geom_digest TEXT NOT NULL, land_version TEXT NOT NULL, "
            "clip_method INTEGER NOT NULL, wkb BLOB NOT NULL, display_wkb BLOB NOT NULL, "
            "borders_wkb BLOB NOT NULL, PRIMARY KEY (geom_digest, land_version, clip_method))"
        )
        connection.execute("INSERT INTO land_clips VALUES ('x', 'v', 6, x'01', x'02', x'03')")

    db.init(path)
    db.init(path)

    with db.connect(path) as connection:
        boundary_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(boundaries)")
        }

    assert {"has_maritime", "border_level"} <= boundary_columns
    assert db.get_land_clip(path, "x", "v", 6) == (b"\x01", b"\x02", b"\x03", b"")


def test_part_ids_come_in_part_order_and_disputed_lines_in_the_window(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    with db.connect(path) as connection:
        connection.executemany(
            "INSERT INTO boundary_parts VALUES (?, ?, ?)",
            [("ovt:AA", 1, "ovt:BB"), ("ovt:AA", 0, "ovt:AA"), ("ovt:CC", 0, "ovt:CC")],
        )
        connection.executemany(
            "INSERT INTO disputed_lines VALUES (?, 'country', ?, 0, ?, 1, ?)",
            [("near", 0, 1, b"near"), ("far", 10, 11, b"far")],
        )

    assert db.boundary_part_ids(path, "ovt:AA") == ["ovt:AA", "ovt:BB"]
    assert db.boundary_part_ids(path, "ovt:ZZ") == []
    assert db.disputed_line_wkbs(path, (0.5, 0, 2, 1)) == [b"near"]


def test_delete_cgaz_removes_rows_tokens_clips_and_keeps_search_valid(tmp_path):
    path = tmp_path / "soe.db"
    db.init(path)
    db.add_boundaries(
        path,
        "synthetic",
        [boundary_row("sample:kenya", "country", "Kenya", iso3="KEN", source="synthetic")],
    )
    kenya = box(10, 10, 11, 11)
    db.add_boundaries(
        path,
        "Overture Maps divisions",
        [
            boundary_row(
                "ovt:KE",
                "country",
                "Kenya",
                iso3="KEN",
                bbox=kenya.bounds,
                geometry=json.dumps(mapping(kenya)),
                source="Overture Maps divisions",
            )
        ],
    )
    # The removed CGAZ source lingers in databases imported before Overture.
    legacy = "geoBoundaries CGAZ"
    home = box(0, 0, 1, 1)
    db.add_boundaries(
        path,
        legacy,
        [
            boundary_row(
                "legacy:KE",
                "country",
                "Kenya",
                iso3="KEN",
                bbox=home.bounds,
                geometry=json.dumps(mapping(home)),
                source=legacy,
            ),
            boundary_row(
                "legacy:NBO",
                "state",
                "Nairobi",
                "Kenya",
                "KEN",
                bbox=home.bounds,
                geometry=json.dumps(mapping(home)),
                source=legacy,
            ),
        ],
    )
    store = tmp_path / "land.sqlite"
    land.write_land_store(store, "v1", [home, kenya])
    land.clip_area_to_land(path, store, Area(home, db.get_boundary(path, "legacy:KE")))
    land.clip_area_to_land(path, store, Area(kenya, db.get_boundary(path, "ovt:KE")))
    with db.connect(path) as connection:
        keys = [row[0] for row in connection.execute("SELECT geom_digest FROM land_clips")]

    assert len(keys) == 2
    assert sum(":legacy:KE:" in key for key in keys) == 1

    counts = db.delete_cgaz(path)

    assert counts["boundaries"] == 2
    assert counts["land_clips"] == 1
    assert counts["search_names"] > 0
    assert db.get_boundary(path, "legacy:KE") is None
    assert db.get_boundary(path, "legacy:NBO") is None
    assert db.get_boundary(path, "ovt:KE") is not None
    assert {row["id"] for row in db.search(path, "Kenya")} == {"ovt:KE"}
    with db.connect(path) as connection:
        remaining = [row[0] for row in connection.execute("SELECT geom_digest FROM land_clips")]

    assert len(remaining) == 1
    assert ":ovt:KE:" in remaining[0]
    assert orphan_token_count(path) == 0
    with db.connect(path) as connection:
        covered = {
            row["iso3"] for row in connection.execute("SELECT iso3 FROM imported_country_iso3")
        }

    assert "KEN" in covered
    db.require_search_names(path)

    assert db.delete_cgaz(path) == {"boundaries": 0, "search_names": 0, "land_clips": 0}
    db.require_search_names(path)
