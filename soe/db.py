"""SQLite: boundaries (search) and scene jobs. One connection per call, WAL, busy_timeout 5000."""
import logging
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS boundaries (
    id TEXT PRIMARY KEY, level TEXT NOT NULL, name TEXT NOT NULL, parent_name TEXT, iso3 TEXT,
    bbox_w REAL, bbox_s REAL, bbox_e REAL, bbox_n REAL, cells INTEGER,
    geom_geojson TEXT NOT NULL, source TEXT NOT NULL, licence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_boundaries_name ON boundaries(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, progress REAL DEFAULT 0,
    error TEXT, error_class TEXT, request_json TEXT NOT NULL, bytes INTEGER, created TEXT NOT NULL, finished TEXT
);
"""
log = logging.getLogger("soe.db")
LEVEL_RANK = "CASE level WHEN 'country' THEN 0 WHEN 'state' THEN 1 WHEN 'county' THEN 2 ELSE 3 END"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect(path):
    conn = sqlite3.connect(path, timeout=5, isolation_level=None)  # autocommit; submit() uses BEGIN
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        yield conn
    finally:
        conn.close()


def init(path):
    """Create tables; jobs that were queued or running when the process died are marked failed."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as c:
        c.executescript(SCHEMA)
        c.execute("UPDATE scenes SET status='failed', error='interrupted', error_class='Interrupted', finished=? "
                  "WHERE status IN ('queued','running')", (now(),))


def search(path, q, level=None, limit=20):
    q = q.replace("!", "!!").replace("%", "!%").replace("_", "!_")  # LIKE escape character is '!'
    start, word = f"{q}%", f"% {q}%"
    sql = ("SELECT id, name, level, iso3, parent_name, bbox_w, bbox_s, bbox_e, bbox_n, cells FROM boundaries "
           "WHERE (name LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!')" + (" AND level = ?" if level else "") +
           f" ORDER BY (name LIKE ? ESCAPE '!') DESC, {LEVEL_RANK}, cells DESC, name LIMIT ?")
    args = [start, word] + ([level] if level else []) + [start, limit]
    with connect(path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def get_boundary(path, bid):
    with connect(path) as c:
        r = c.execute("SELECT * FROM boundaries WHERE id = ?", (bid,)).fetchone()
    return dict(r) if r else None


class Busy(Exception):
    """Too many queued or running scene jobs."""


def add_boundaries(path, source, rows):
    """Replace all boundaries of one source. rows: tuples in column order of the INSERT below.

    Duplicate ids inside `rows` overwrite each other (INSERT OR REPLACE); returns how many were replaced.
    """
    replaced = len(rows) - len({r[0] for r in rows})
    if replaced:
        log.warning("%s: %d duplicate boundary ids replaced", source, replaced)
    with connect(path) as c:
        c.execute("BEGIN")
        c.execute("DELETE FROM boundaries WHERE source = ?", (source,))
        c.executemany("INSERT OR REPLACE INTO boundaries (id, level, name, parent_name, iso3, bbox_w, bbox_s, bbox_e, "
                      "bbox_n, cells, geom_geojson, source, licence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        c.execute("COMMIT")
    return replaced


def submit(path, sid, request_json, done_ok, max_active=None):
    """Register a scene job; `sid` is the content hash. Returns (row, start): start is True when the caller must run the build.

    An existing done row is reused only if done_ok (its files exist); failed rows are re-queued.
    Raises Busy when a new job would exceed `max_active` queued + running jobs.
    """
    with connect(path) as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM scenes WHERE id = ?", (sid,)).fetchone()
        if max_active is not None and (row is None or row["status"] == "failed" or (row["status"] == "done" and not done_ok)):
            n = c.execute("SELECT COUNT(*) FROM scenes WHERE status IN ('queued','running')").fetchone()[0]
            if n >= max_active:
                raise Busy()
        if row is None:
            c.execute("INSERT INTO scenes (id, status, request_json, created) VALUES (?,?,?,?)",
                      (sid, "queued", request_json, now()))
            start = True
        elif row["status"] == "failed" or (row["status"] == "done" and not done_ok):
            c.execute("UPDATE scenes SET status='queued', progress=0, error=NULL, error_class=NULL, finished=NULL WHERE id = ?",
                      (row["id"],))
            start = True
        else:
            start = False
        row = c.execute("SELECT * FROM scenes WHERE id = ?", (sid,)).fetchone()
        c.execute("COMMIT")
    return dict(row), start


def get_scene(path, sid):
    with connect(path) as c:
        r = c.execute("SELECT * FROM scenes WHERE id = ?", (sid,)).fetchone()
    return dict(r) if r else None


def update_scene(path, sid, **fields):
    cols = ", ".join(f"{k} = ?" for k in fields)
    with connect(path) as c:
        c.execute(f"UPDATE scenes SET {cols} WHERE id = ?", (*fields.values(), sid))
