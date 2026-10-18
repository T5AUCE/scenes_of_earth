"""SQLite: boundaries (search), scene jobs and source revisions; one WAL connection per call."""
import logging
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SqlValue = str | int | float | None
Record = dict[str, Any]  # one table row as column -> value
BoundaryValues = tuple[SqlValue, ...]  # one boundaries row in INSERT_BOUNDARY column order

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
    stage TEXT,
    error TEXT,
    error_class TEXT,
    request_json TEXT NOT NULL,
    bytes INTEGER,
    created TEXT NOT NULL,
    finished TEXT
);

CREATE TABLE IF NOT EXISTS period_revisions (
    dataset_id TEXT NOT NULL,
    period TEXT NOT NULL,
    revision TEXT NOT NULL,
    checked TEXT NOT NULL,
    PRIMARY KEY (dataset_id, period)
);
"""

LEVEL_RANK = (
    "CASE level WHEN 'country' THEN 0 WHEN 'state' THEN 1 WHEN 'county' THEN 2 ELSE 3 END"
)
ACTIVE_STATUSES = "('queued','running')"

SQLITE_TIMEOUT_SECS = 5
BUSY_TIMEOUT_MS = SQLITE_TIMEOUT_SECS * 1000

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


def init(path: Path | str) -> None:
    """Create tables; jobs that were queued or running when the process died are marked failed."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as connection:
        connection.executescript(SCHEMA)
        # The old per-month revision cache is only a cache, so it is dropped, not migrated.
        connection.execute("DROP TABLE IF EXISTS source_revisions")
        _add_missing_columns(connection)
        connection.execute(
            "UPDATE scenes SET status='failed', error='interrupted', "
            "error_class='Interrupted', finished=? "
            f"WHERE status IN {ACTIVE_STATUSES}",
            (now(),),
        )


def _add_missing_columns(connection: sqlite3.Connection) -> None:
    """Databases created before a column was added to SCHEMA get it here."""
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(scenes)")}
    if "stage" in columns:
        return

    try:
        connection.execute("ALTER TABLE scenes ADD COLUMN stage TEXT")
    except sqlite3.OperationalError as error:
        # Another process added it between the check and the ALTER.
        if "duplicate column" not in str(error):
            raise


def search(
    path: Path | str,
    query: str,
    level: str | None = None,
    limit: int = 20,
) -> list[Record]:
    """Boundaries whose name starts with `query`, or has a word that does; best matches first."""
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


def get_boundary(path: Path | str, boundary_id: str) -> Record | None:
    """The full boundaries row, geometry included, or None."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT * FROM boundaries WHERE id = ?",
            (boundary_id,),
        ).fetchone()
    return dict(row) if row else None


def add_boundaries(path: Path | str, source: str, rows: list[BoundaryValues]) -> int:
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


def has_boundaries_besides(path: Path | str, source: str) -> bool:
    """Used to skip seeding if real boundaries exist from another source."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT 1 FROM boundaries WHERE source != ? LIMIT 1",
            (source,),
        ).fetchone()
    return row is not None


def get_scene(path: Path | str, scene_id: str) -> Record | None:
    """The scene job's row, or None."""
    with connect(path) as connection:
        row = _select_scene(connection, scene_id)
    return dict(row) if row else None


def update_scene(path: Path | str, scene_id: str, **fields: SqlValue) -> None:
    """Set the given columns of a scene job's row."""
    assignments = ", ".join(f"{column} = ?" for column in fields)
    with connect(path) as connection:
        connection.execute(
            f"UPDATE scenes SET {assignments} WHERE id = ?",
            (*fields.values(), scene_id),
        )


def submit(
    path: Path | str,
    scene_id: str,
    request_json: str,
    bundle_exists: bool,
    max_active: int | None = None,
) -> tuple[Record, bool]:
    """Register a scene job; `scene_id` is the content hash.

    Returns (the job's row, whether the caller should start the build). Raises Busy when a new
    build would exceed `max_active` queued or running jobs.
    """
    with connect(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _select_scene(connection, scene_id)
        start = _needs_build(row, bundle_exists)
        if start:
            _check_capacity(connection, max_active)
            _queue_scene(connection, scene_id, request_json, is_new=row is None)
        row = _select_scene(connection, scene_id)
        connection.execute("COMMIT")
    return dict(row), start


def _select_scene(connection: sqlite3.Connection, scene_id: str) -> sqlite3.Row | None:
    return connection.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()


def _needs_build(row: sqlite3.Row | None, bundle_exists: bool) -> bool:
    if row is None or row["status"] == "failed":
        return True
    return row["status"] == "done" and not bundle_exists


def _check_capacity(connection: sqlite3.Connection, max_active: int | None) -> None:
    if max_active is None:
        return

    active = connection.execute(
        f"SELECT COUNT(*) FROM scenes WHERE status IN {ACTIVE_STATUSES}"
    ).fetchone()[0]
    if active >= max_active:
        raise Busy()


def _queue_scene(
    connection: sqlite3.Connection,
    scene_id: str,
    request_json: str,
    is_new: bool,
) -> None:
    """Insert a new job as queued, or reset an existing one to queued."""
    if is_new:
        connection.execute(
            "INSERT INTO scenes (id, status, request_json, created) VALUES (?,?,?,?)",
            (scene_id, "queued", request_json, now()),
        )
        return

    connection.execute(
        "UPDATE scenes SET status='queued', progress=0, stage=NULL, error=NULL, "
        "error_class=NULL, finished=NULL WHERE id = ?",
        (scene_id,),
    )


def get_revision(path: Path | str, dataset_id: str, period: str) -> tuple[str, float] | None:
    """(stored revision, seconds since the source was asked) or None."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT revision, checked FROM period_revisions WHERE dataset_id = ? AND period = ?",
            (dataset_id, period),
        ).fetchone()
    if row is None:
        return None

    age = datetime.now(timezone.utc) - datetime.fromisoformat(row["checked"])
    return row["revision"], age.total_seconds()


def set_revision(path: Path | str, dataset_id: str, period: str, revision: str) -> None:
    """Store the source's revision of a period and the time it was asked."""
    with connect(path) as connection:
        connection.execute(
            "INSERT OR REPLACE INTO period_revisions (dataset_id, period, revision, checked) "
            "VALUES (?,?,?,?)",
            (dataset_id, period, revision, now()),
        )


@contextmanager
def connect(path: Path | str) -> Iterator[sqlite3.Connection]:
    """An autocommit WAL connection with a busy timeout, closed on exit."""
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


def now() -> str:
    """The current UTC time as an ISO 8601 string, to the second."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
