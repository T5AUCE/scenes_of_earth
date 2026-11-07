"""Database tests: schema upgrades of existing files and scene state across restarts."""
import sqlite3
from pathlib import Path

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
