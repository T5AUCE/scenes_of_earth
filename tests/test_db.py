"""Database tests: schema upgrades of existing files."""
import sqlite3

from soe import db

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


def scene_columns(path) -> set[str]:
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
