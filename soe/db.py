"""SQLite: boundaries (search), scene jobs and source revisions; one WAL connection per call."""
import logging
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS boundaries (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_name TEXT,
    iso3 TEXT,
    bbox_w REAL,
    bbox_s REAL,
    bbox_e REAL,
    bbox_n REAL,
    cells INTEGER,
    geom_geojson TEXT NOT NULL,
    source TEXT NOT NULL,
    licence TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_boundaries_name ON boundaries(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    progress REAL DEFAULT 0,
    error TEXT,
    error_class TEXT,
    request_json TEXT NOT NULL,
    bytes INTEGER,
    created TEXT NOT NULL,
    finished TEXT
);

CREATE TABLE IF NOT EXISTS source_revisions (
    dataset_id TEXT NOT NULL,
    month TEXT NOT NULL,
    revision TEXT NOT NULL,
    checked TEXT NOT NULL,
    PRIMARY KEY (dataset_id, month)
);
"""

LEVEL_RANK = (
    "CASE level WHEN 'country' THEN 0 WHEN 'state' THEN 1 WHEN 'county' THEN 2 ELSE 3 END"
)

SQLITE_TIMEOUT_SECS = 5
BUSY_TIMEOUT_MS = SQLITE_TIMEOUT_SECS * 1000
ACTIVE_STATUSES = "('queued','running')"

INSERT_BOUNDARY = """
    INSERT OR REPLACE INTO boundaries (
        id, level, name, parent_name, iso3,
        bbox_w, bbox_s, bbox_e, bbox_n, cells,
        geom_geojson, source, licence
    )
    VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
"""

log = logging.getLogger("soe.db")


class Busy(Exception):
    """Too many queued or running scene jobs."""


def init(path):
    """Create tables; jobs that were queued or running when the process died are marked failed."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as connection:
        connection.executescript(SCHEMA)
        connection.execute(
            "UPDATE scenes SET status='failed', error='interrupted', "
            "error_class='Interrupted', finished=? "
            f"WHERE status IN {ACTIVE_STATUSES}",
            (now(),),
        )


def search(path, query, level=None, limit=20):
    # User text must match literally, so LIKE wildcards are escaped with '!'.
    query = query.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    prefix_pattern, word_pattern = f"{query}%", f"% {query}%"

    where = "(name LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!')"
    if level:
        where += " AND level = ?"

    order_by = f"(name LIKE ? ESCAPE '!') DESC, {LEVEL_RANK}, cells DESC, name"
    sql = (
        "SELECT id, name, level, iso3, parent_name, bbox_w, bbox_s, bbox_e, bbox_n, cells "
        f"FROM boundaries WHERE {where} ORDER BY {order_by} LIMIT ?"
    )

    arguments = [prefix_pattern, word_pattern] + ([level] if level else [])
    arguments += [prefix_pattern, limit]

    with connect(path) as connection:
        return [dict(row) for row in connection.execute(sql, arguments)]


def get_boundary(path, boundary_id):
    with connect(path) as connection:
        row = connection.execute(
            "SELECT * FROM boundaries WHERE id = ?",
            (boundary_id,),
        ).fetchone()
    return dict(row) if row else None


def add_boundaries(path, source, rows):
    """Replace all boundaries of one source. rows: tuples in column order of INSERT_BOUNDARY."""
    replaced = len(rows) - len({row[0] for row in rows})
    if replaced:
        log.warning("%s: %d duplicate boundary ids replaced", source, replaced)

    with connect(path) as connection:
        connection.execute("BEGIN")
        connection.execute("DELETE FROM boundaries WHERE source = ?", (source,))
        connection.executemany(INSERT_BOUNDARY, rows)
        connection.execute("COMMIT")

    return replaced


def has_boundaries_besides(path, source):
    """Used to skip seeding if real boundaries exist from another source."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT 1 FROM boundaries WHERE source != ? LIMIT 1",
            (source,),
        ).fetchone()
    return row is not None


def get_scene(path, scene_id):
    with connect(path) as connection:
        row = _select_scene(connection, scene_id)
    return dict(row) if row else None


def update_scene(path, scene_id, **fields):
    assignments = ", ".join(f"{column} = ?" for column in fields)
    with connect(path) as connection:
        connection.execute(
            f"UPDATE scenes SET {assignments} WHERE id = ?",
            (*fields.values(), scene_id),
        )


def submit(path, scene_id, request_json, bundle_exists, max_active=None):
    """Register a scene job; `scene_id` is the content hash."""
    with connect(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _select_scene(connection, scene_id)
        start = _needs_build(row, bundle_exists)
        if start:
            _check_capacity(connection, max_active)
            if row is None:
                connection.execute(
                    "INSERT INTO scenes (id, status, request_json, created) VALUES (?,?,?,?)",
                    (scene_id, "queued", request_json, now()),
                )
            else:
                connection.execute(
                    "UPDATE scenes SET status='queued', progress=0, error=NULL, error_class=NULL, "
                    "finished=NULL WHERE id = ?",
                    (scene_id,),
                )
        row = _select_scene(connection, scene_id)
        connection.execute("COMMIT")
    return dict(row), start


def _select_scene(connection, scene_id):
    return connection.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()


def _needs_build(row, bundle_exists):
    if row is None or row["status"] == "failed":
        return True
    return row["status"] == "done" and not bundle_exists


def _check_capacity(connection, max_active):
    if max_active is None:
        return

    active = connection.execute(
        f"SELECT COUNT(*) FROM scenes WHERE status IN {ACTIVE_STATUSES}"
    ).fetchone()[0]
    if active >= max_active:
        raise Busy()


def get_revision(path, dataset_id, month):
    """(stored revision, seconds since the source was asked) or None."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT revision, checked FROM source_revisions WHERE dataset_id = ? AND month = ?",
            (dataset_id, month),
        ).fetchone()
    if row is None:
        return None

    age = datetime.now(timezone.utc) - datetime.fromisoformat(row["checked"])
    return row["revision"], age.total_seconds()


def set_revision(path, dataset_id, month, revision):
    """Store the source's revision of a month and the time it was asked."""
    with connect(path) as connection:
        connection.execute(
            "INSERT OR REPLACE INTO source_revisions (dataset_id, month, revision, checked) "
            "VALUES (?,?,?,?)",
            (dataset_id, month, revision, now()),
        )


@contextmanager
def connect(path):
    # isolation_level=None is autocommit; submit() and add_boundaries() use explicit BEGIN.
    connection = sqlite3.connect(
        path,
        timeout=SQLITE_TIMEOUT_SECS,
        isolation_level=None,
    )
    connection.row_factory = sqlite3.Row
    
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        yield connection
    finally:
        connection.close()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
