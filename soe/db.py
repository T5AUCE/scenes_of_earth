"""SQLite: boundaries, scene jobs, source revisions and land clips; one WAL connection per call."""

import hashlib
import json
import logging
import sqlite3
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .country_names import OFFICIAL_NAMES

SqlValue = str | int | float | None
Record = dict[str, Any]  # one table row as column -> value
BoundaryValues = tuple[SqlValue, ...]  # one boundaries row in INSERT_BOUNDARY column order
PreviewWrite = tuple[str, str, str | None, str]  # id, preview, expected digest, new digest
# Land clip, display outline, solid land borders and disputed land borders, as WKB.
LandClipWkbs = tuple[bytes, bytes, bytes, bytes]

BOUNDARY_NAMES_SCHEMA = """
CREATE TABLE IF NOT EXISTS boundary_names (
    boundary_id TEXT NOT NULL,
    name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_boundary_names_name ON boundary_names(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS ix_boundary_names_boundary ON boundary_names(boundary_id);

CREATE TABLE IF NOT EXISTS imported_country_iso3 (
    iso3 TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS search_migration (
    version TEXT PRIMARY KEY,
    finished TEXT NOT NULL
);
"""

# Bump when the token scheme changes, so an older migration no longer counts.
SEARCH_MIGRATION_VERSION = "1"

SCHEMA = (
    """
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
    geom_digest TEXT,
    preview_geojson TEXT,
    source TEXT NOT NULL,
    licence TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_boundaries_name ON boundaries(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS admin_kinds (
    iso3 TEXT NOT NULL,
    level TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (iso3, level)
);

CREATE TABLE IF NOT EXISTS land_clips (
    geom_digest TEXT NOT NULL,
    land_version TEXT NOT NULL,
    clip_method INTEGER NOT NULL,
    wkb BLOB NOT NULL,
    display_wkb BLOB NOT NULL,
    borders_wkb BLOB NOT NULL,
    disputed_wkb BLOB NOT NULL DEFAULT x'',
    PRIMARY KEY (geom_digest, land_version, clip_method)
);

CREATE TABLE IF NOT EXISTS boundary_parts (
    parent_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (parent_id, position)
);

CREATE TABLE IF NOT EXISTS disputed_lines (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    bbox_w REAL NOT NULL,
    bbox_s REAL NOT NULL,
    bbox_e REAL NOT NULL,
    bbox_n REAL NOT NULL,
    wkb BLOB NOT NULL
);

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
    + BOUNDARY_NAMES_SCHEMA
)

LEVEL_RANK = (
    "CASE boundaries.level WHEN 'country' THEN 0 WHEN 'state' THEN 1 "
    "WHEN 'county' THEN 2 ELSE 3 END"
)
# Sample countries stay in the table for offline use, so search hides each one an import covers.
SHADOWED_SYNTHETIC_COUNTRY = (
    "boundaries.level = 'country' AND boundaries.source = 'synthetic' "
    "AND boundaries.iso3 IS NOT NULL AND boundaries.iso3 != '' "
    "AND EXISTS (SELECT 1 FROM imported_country_iso3 WHERE iso3 = boundaries.iso3)"
)
ACTIVE_STATUSES = "('queued','running')"

SQLITE_TIMEOUT_SECS = 5
BUSY_TIMEOUT_MS = SQLITE_TIMEOUT_SECS * 1000

INSERT_BOUNDARY = """
    INSERT OR REPLACE INTO boundaries (
        id, level, name, parent_name, iso3,
        bbox_w, bbox_s, bbox_e, bbox_n, cells,
        geom_geojson, geom_digest, preview_geojson, source, licence
    )
    VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
"""
INSERT_BATCH_ROWS = 500
GEOM_DIGEST_CHARS = 16  # hex characters of the sha256 kept as the geometry revision

log = logging.getLogger("soe.db")


class Busy(Exception):
    """Too many queued or running scene jobs."""


def init(path: Path | str) -> None:
    """Create tables; jobs that were queued or running when the process died are marked failed."""
    ensure_schema(path)
    recover_interrupted_scenes(path)


def ensure_schema(path: Path | str) -> None:
    """Create tables and migrate old files, leaving scene jobs alone.

    Maintenance commands use this, so a backfill never touches unrelated job state.
    """
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as connection:
        connection.executescript(SCHEMA)
        # The old per-month revision cache is only a cache, so it is dropped, not migrated.
        connection.execute("DROP TABLE IF EXISTS source_revisions")
        _add_missing_columns(connection)


def require_search_names(path: Path | str) -> None:
    """Fail when stored boundaries lack a completed search migration, naming the rebuild command.

    Fresh databases pass, since there is nothing to search. The marker is written by a full
    rebuild and by any import that leaves every row tokenized, so a legacy database that only
    gained new rows still trips this.
    """
    with connect(path) as connection:
        tables = {
            row["name"]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if "boundaries" not in tables:
            return

        if connection.execute("SELECT 1 FROM boundaries LIMIT 1").fetchone() is None:
            return

        migrated = "search_migration" in tables and (
            connection.execute(
                "SELECT 1 FROM search_migration WHERE version = ?", (SEARCH_MIGRATION_VERSION,)
            ).fetchone()
            is not None
        )
        if not migrated:
            raise SystemExit(
                f"search names are missing for {path}: stop the API and importers, then run "
                f"python -m soe.cli rebuild-search-names --db {path}"
            )


def recover_interrupted_scenes(path: Path | str) -> None:
    """Mark jobs that were queued or running when the process died as failed.

    Only the app calls this at startup, so maintenance commands never see it.
    """
    with connect(path) as connection:
        connection.execute(
            "UPDATE scenes SET status='failed', error='interrupted', "  # noqa: S608 - the list is a module constant.
            "error_class='Interrupted', finished=? "
            f"WHERE status IN {ACTIVE_STATUSES}",
            (now(),),
        )


def _add_missing_columns(connection: sqlite3.Connection) -> None:
    """Databases created before a column was added to SCHEMA get it here."""
    scenes_columns = {row["name"] for row in connection.execute("PRAGMA table_info(scenes)")}
    if "stage" not in scenes_columns:
        try:
            connection.execute("ALTER TABLE scenes ADD COLUMN stage TEXT")
        except sqlite3.OperationalError as error:
            # Another process added it between the check and the ALTER.
            if "duplicate column" not in str(error):
                raise

    boundaries_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(boundaries)")
    }
    if "preview_geojson" not in boundaries_columns:
        try:
            connection.execute("ALTER TABLE boundaries ADD COLUMN preview_geojson TEXT")
        except sqlite3.OperationalError as error:
            if "duplicate column" not in str(error):
                raise

    if "geom_digest" not in boundaries_columns:
        try:
            connection.execute("ALTER TABLE boundaries ADD COLUMN geom_digest TEXT")
        except sqlite3.OperationalError as error:
            if "duplicate column" not in str(error):
                raise

    _ensure_boundary_search_columns(connection, boundaries_columns)
    _ensure_boundary_clip_columns(connection)

    _ensure_land_clips_method(connection)
    _ensure_land_clips_disputed(connection)


def _ensure_boundary_search_columns(
    connection: sqlite3.Connection, boundaries_columns: set[str] | None = None
) -> None:
    """Give a database created before local names and aliases existed their columns."""
    if boundaries_columns is None:
        boundaries_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(boundaries)")
        }

    for column in ("name_local", "parent_name_local", "aliases"):
        if column not in boundaries_columns:
            try:
                connection.execute(f"ALTER TABLE boundaries ADD COLUMN {column} TEXT")
            except sqlite3.OperationalError as error:
                if "duplicate column" not in str(error):
                    raise


def _ensure_boundary_clip_columns(connection: sqlite3.Connection) -> None:
    """Give a database created before the land clip read these columns of Overture rows theirs."""
    existing = {row["name"] for row in connection.execute("PRAGMA table_info(boundaries)")}
    for column in ("has_maritime", "border_level"):
        if column not in existing:
            try:
                connection.execute(f"ALTER TABLE boundaries ADD COLUMN {column} INTEGER")
            except sqlite3.OperationalError as error:
                if "duplicate column" not in str(error):
                    raise


def _ensure_land_clips_method(connection: sqlite3.Connection) -> None:
    """Recreate land_clips with the clip method when an older file lacks it.

    Older clips used a margin-only display subtraction, so they must never be reused.
    """
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(land_clips)")}
    if "clip_method" in columns:
        return

    connection.execute("DROP TABLE IF EXISTS land_clips")
    connection.executescript(SCHEMA)


def _ensure_land_clips_disputed(connection: sqlite3.Connection) -> None:
    """Give clips stored before disputed borders existed the column, empty."""
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(land_clips)")}
    if "disputed_wkb" in columns:
        return

    try:
        connection.execute(
            "ALTER TABLE land_clips ADD COLUMN disputed_wkb BLOB NOT NULL DEFAULT x''"
        )
    except sqlite3.OperationalError as error:
        if "duplicate column" not in str(error):
            raise


def search(path: Path | str, query: str, level: str | None = None, limit: int = 20) -> list[Record]:
    """Boundaries whose name, local name or alias starts with `query`, or continues with it.

    A match continues with the query when the query starts at a word boundary inside the name,
    so later words and phrases match as well as prefixes. Countries also match their official
    long name under the same rules, after direct matches. A plain country ranks above its
    combined area, which shares its level but holds more cells. A sample country stays listed
    only while no imported country shares its iso3.
    """
    # User text must match literally, so LIKE wildcards are escaped with '!'.
    query = query.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    prefix_pattern, word_pattern = f"{query}%", f"% {query}%"

    where = (
        "(boundaries.id IN (SELECT boundary_id FROM boundary_names WHERE name LIKE ? ESCAPE '!'))"
    )
    where += f" AND NOT ({SHADOWED_SYNTHETIC_COUNTRY})"
    if level:
        where += " AND boundaries.level = ?"

    # Combined areas share their country's level but hold more cells, so one sorts first.
    order_by = (
        "(boundaries.name LIKE ? ESCAPE '!') DESC, "
        "((boundaries.name LIKE ? ESCAPE '!') OR (boundaries.name LIKE ? ESCAPE '!')) DESC, "
        f"{LEVEL_RANK}, (boundaries.id LIKE '%+overseas') ASC, "
        "boundaries.cells DESC, boundaries.name"
    )
    sql = (
        "SELECT boundaries.id, boundaries.name, boundaries.level, boundaries.iso3, "  # noqa: S608 - only constants shape the query.
        "boundaries.parent_name, boundaries.name_local, boundaries.parent_name_local, "
        "boundaries.bbox_w, boundaries.bbox_s, boundaries.bbox_e, "
        "boundaries.bbox_n, boundaries.cells, admin_kinds.kind AS kind FROM boundaries "
        "LEFT JOIN admin_kinds ON admin_kinds.iso3 = boundaries.iso3 "
        "AND admin_kinds.level = boundaries.level "
        f"WHERE {where} ORDER BY {order_by} LIMIT ?"
    )

    arguments: list[SqlValue] = [prefix_pattern]
    arguments += [level] if level else []
    arguments += [prefix_pattern, prefix_pattern, word_pattern, limit]

    with connect(path) as connection:
        return [dict(row) for row in connection.execute(sql, arguments)]


def get_boundary(path: Path | str, boundary_id: str, with_geometry: bool = True) -> Record | None:
    """One boundaries row, or None. Without geometry only the digest and preview load.

    The preview read skips the full stored geometry, so serving it stays fast; the stored
    digest versions the row cheaply because it is computed once at import.
    """
    geometry_select = (
        "boundaries.geom_geojson, boundaries.geom_digest"
        if with_geometry
        else "boundaries.geom_digest"
    )
    with connect(path) as connection:
        row = connection.execute(
            "SELECT boundaries.id, boundaries.level, "  # noqa: S608 - one of two fixed column lists.
            "boundaries.name, boundaries.parent_name, boundaries.name_local, "
            "boundaries.parent_name_local, boundaries.iso3, boundaries.bbox_w, "
            "boundaries.bbox_s, boundaries.bbox_e, boundaries.bbox_n, boundaries.cells, "
            "boundaries.has_maritime, boundaries.border_level, "
            f"{geometry_select}, boundaries.preview_geojson, boundaries.source, "
            "boundaries.licence, admin_kinds.kind AS kind FROM boundaries "
            "LEFT JOIN admin_kinds ON admin_kinds.iso3 = boundaries.iso3 "
            "AND admin_kinds.level = boundaries.level WHERE id = ?",
            (boundary_id,),
        ).fetchone()

    return dict(row) if row else None


def boundary_ids(path: Path | str, source: str, levels: tuple[str, ...]) -> list[str]:
    """Ids of the boundaries of one source at the given levels, in id order."""
    marks = ", ".join("?" for _ in levels)
    with connect(path) as connection:
        rows = connection.execute(
            f"SELECT id FROM boundaries WHERE source = ? AND level IN ({marks}) ORDER BY id",  # noqa: S608 - only placeholders are joined in.
            (source, *levels),
        )
        return [row["id"] for row in rows]


def state_ids_of_country(path: Path | str, source: str, iso3: str) -> list[str]:
    """Ids of the states of one source in a country, in id order."""
    with connect(path) as connection:
        rows = connection.execute(
            "SELECT id FROM boundaries WHERE source = ? AND level = 'state' AND iso3 = ? "
            "ORDER BY id",
            (source, iso3),
        )
        return [row["id"] for row in rows]


def neighbour_digests(
    path: Path | str, boundary: Record, window: tuple[float, float, float, float]
) -> list[tuple[str, str]]:
    """(id, geometry digest) of the other boundaries of the same source and level in `window`.

    A boundary is listed when its bbox meets `window`, which is (west, south, east, north).
    """
    west, south, east, north = window
    with connect(path) as connection:
        rows = connection.execute(
            "SELECT id, COALESCE(geom_digest, '') AS digest FROM boundaries "
            "WHERE source = ? AND level = ? AND id != ? "
            "AND bbox_e >= ? AND bbox_w <= ? AND bbox_n >= ? AND bbox_s <= ?",
            (boundary["source"], boundary["level"], boundary["id"], west, east, south, north),
        )
        return [(row["id"], row["digest"]) for row in rows]


def boundary_part_ids(path: Path | str, parent_id: str) -> list[str]:
    """Ids of the areas that a combined area is made of, in part order."""
    with connect(path) as connection:
        rows = connection.execute(
            "SELECT member_id FROM boundary_parts WHERE parent_id = ? ORDER BY position",
            (parent_id,),
        )
        return [row["member_id"] for row in rows]


def disputed_line_wkbs(path: Path | str, window: tuple[float, float, float, float]) -> list[bytes]:
    """The WKB of the disputed lines whose bbox meets `window` (west, south, east, north)."""
    west, south, east, north = window
    with connect(path) as connection:
        rows = connection.execute(
            "SELECT wkb FROM disputed_lines "
            "WHERE bbox_e >= ? AND bbox_w <= ? AND bbox_n >= ? AND bbox_s <= ?",
            (west, east, south, north),
        )
        return [row["wkb"] for row in rows]


def get_land_clip(
    path: Path | str, geom_digest: str, land_version: str, clip_method: int
) -> LandClipWkbs | None:
    """The stored land clip of an area geometry for one land version and clip method, or None."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT wkb, display_wkb, borders_wkb, disputed_wkb FROM land_clips "
            "WHERE geom_digest = ? AND land_version = ? AND clip_method = ?",
            (geom_digest, land_version, clip_method),
        ).fetchone()

    if row is None:
        return None

    return (row["wkb"], row["display_wkb"], row["borders_wkb"], row["disputed_wkb"])


def set_land_clip(
    path: Path | str, geom_digest: str, land_version: str, clip_method: int, wkbs: LandClipWkbs
) -> None:
    """Store the land clip of an area geometry for one land version and clip method."""
    with connect(path) as connection:
        connection.execute(
            "INSERT OR REPLACE INTO land_clips "
            "(geom_digest, land_version, clip_method, wkb, display_wkb, borders_wkb, disputed_wkb) "
            "VALUES (?,?,?,?,?,?,?)",
            (geom_digest, land_version, clip_method, *wkbs),
        )


def delete_land_clips_except(path: Path | str, land_version: str, clip_method: int) -> int:
    """Drop the clips of older land versions or clip methods, which no scene id can use any more."""
    with connect(path) as connection:
        cursor = connection.execute(
            "DELETE FROM land_clips WHERE land_version != ? OR clip_method != ?",
            (land_version, clip_method),
        )
        return cursor.rowcount


def add_boundaries(path: Path | str, source: str, rows: Iterable[BoundaryValues]) -> int:
    """Replace all boundaries of one source, with their search tokens. Returns duplicates replaced.

    Rows insert in batches, so a full import never holds every geometry at once.
    """
    replaced = 0
    seen: set[SqlValue] = set()
    with connect(path) as connection:
        connection.execute("BEGIN")
        _delete_source_search_state(connection, source)
        connection.execute("DELETE FROM boundaries WHERE source = ?", (source,))
        batch: list[BoundaryValues] = []
        for row in rows:
            if row[0] in seen:
                replaced += 1

            seen.add(row[0])
            batch.append(_complete_row(row))

            if len(batch) >= INSERT_BATCH_ROWS:
                connection.executemany(INSERT_BOUNDARY, batch)
                batch = []

        if batch:
            connection.executemany(INSERT_BOUNDARY, batch)

        _insert_source_search_state(connection, source)
        connection.execute("COMMIT")

    if replaced:
        log.warning("%s: %d duplicate boundary ids replaced", source, replaced)

    return replaced


def _delete_source_search_state(
    connection: sqlite3.Connection, source: str | None, levels: tuple[str, ...] | None = None
) -> None:
    """Drop the tokens of rows about to be replaced, while those rows still exist."""
    token_filter, token_args = _source_filter(source, levels)
    connection.execute(
        "DELETE FROM boundary_names WHERE boundary_id IN "  # noqa: S608 - the filter is code constants and placeholders.
        f"(SELECT id FROM boundaries WHERE {token_filter})",
        token_args,
    )


def _insert_source_search_state(
    connection: sqlite3.Connection, source: str | None, levels: tuple[str, ...] | None = None
) -> int:
    """Tokenize the stored rows of a source and refresh which countries imports cover.

    Coverage is recomputed from every remaining non-synthetic country row, so replacing
    one source cannot erase another source's coverage.
    """
    token_filter, token_args = _source_filter(source, levels)
    rows = connection.execute(
        f"SELECT id, level, name, name_local, aliases, iso3 FROM boundaries WHERE {token_filter}",  # noqa: S608 - the filter joins code constants and placeholders.
        token_args,
    )

    stored = 0
    batch: list[tuple[str, str]] = []
    for row in rows:
        for token in _search_tokens(
            row["name"], row["name_local"], row["aliases"], row["iso3"], row["level"]
        ):
            batch.append((row["id"], token))
            if len(batch) >= INSERT_BATCH_ROWS:
                _insert_name_batch(connection, "boundary_names", batch)
                stored += len(batch)
                batch = []

    _insert_name_batch(connection, "boundary_names", batch)
    stored += len(batch)

    if levels is None or "country" in levels:
        connection.execute("DELETE FROM imported_country_iso3")
        connection.execute(
            "INSERT OR IGNORE INTO imported_country_iso3 SELECT DISTINCT iso3 FROM boundaries "
            "WHERE level = 'country' AND source != 'synthetic' "
            "AND iso3 IS NOT NULL AND iso3 != ''"
        )

    _refresh_search_migration(connection)

    return stored


def _refresh_search_migration(connection: sqlite3.Connection) -> None:
    """Record whether every boundary now has search tokens, so startup skips the probe.

    The marker is written only when no boundary lacks tokens, so a partial import never
    marks the database complete.
    """
    connection.execute("DELETE FROM search_migration")
    connection.execute(
        "INSERT INTO search_migration (version, finished) SELECT ?, ? WHERE NOT EXISTS ("
        "SELECT 1 FROM boundaries WHERE id NOT IN (SELECT boundary_id FROM boundary_names)"
        ")",
        (SEARCH_MIGRATION_VERSION, now()),
    )


def _insert_name_batch(
    connection: sqlite3.Connection, table: str, batch: list[tuple[str, str]]
) -> None:
    """Insert one batch of search tokens into the names table."""
    connection.executemany(
        f"INSERT INTO {table} (boundary_id, name) VALUES (?, ?)",  # noqa: S608 - the table is a code constant at each caller.
        batch,
    )


def _source_filter(
    source: str | None, levels: tuple[str, ...] | None
) -> tuple[str, list[SqlValue]]:
    """The WHERE fragment matching one source and level set, or every row when both are None."""
    clauses: list[str] = []
    args: list[SqlValue] = []
    if source is not None:
        clauses.append("source = ?")
        args.append(source)
    if levels is not None:
        marks = ", ".join("?" for _ in levels)
        clauses.append(f"level IN ({marks})")
        args.extend(levels)

    return (" AND ".join(clauses) if clauses else "1 = 1"), args


def sync_search_names(path: Path | str, source: str | None = None) -> int:
    """Rebuild the search tokens of one source, or of every boundary; returns stored rows.

    Imports keep tokens current inside their own transaction; this covers databases
    written before that and the offline rebuild command.
    """
    with connect(path) as connection:
        _ensure_boundary_search_columns(connection)
        connection.executescript(BOUNDARY_NAMES_SCHEMA)
        connection.execute("BEGIN")
        _delete_source_search_state(connection, source)
        stored = _insert_source_search_state(connection, source)
        connection.execute("COMMIT")

    return stored


def _search_tokens(
    name: str | None,
    name_local: str | None,
    aliases_text: str | None,
    iso3: str | None,
    level: str | None,
) -> list[str]:
    """The full names and their word-boundary suffixes that one boundary is found by.

    Storing each suffix lets a prefix seek serve the phrase rule, so the query never scans.
    Countries also carry their official long name, which today's search matches separately.
    """
    texts = [name, name_local, *_parse_aliases(aliases_text)]
    if level == "country" and iso3:
        texts.append(OFFICIAL_NAMES.get(iso3))

    tokens = set()
    for text in texts:
        stripped = (text or "").strip()
        if not stripped:
            continue

        words = stripped.split(" ")
        for index, word in enumerate(words):
            if word:
                tokens.add(" ".join(words[index:]))

    return sorted(tokens)


def _parse_aliases(aliases_text: str | None) -> list[str]:
    """The alias list of a boundaries row, or nothing when it is missing or malformed."""
    if not aliases_text:
        return []

    try:
        aliases = json.loads(aliases_text)
    except ValueError:
        return []

    if not isinstance(aliases, list):
        return []

    return [alias for alias in aliases if isinstance(alias, str) and alias]


def _complete_row(row: BoundaryValues) -> BoundaryValues:
    """A boundaries row in INSERT_BOUNDARY order, computing a missing geometry digest."""
    if len(row) == 15:
        if row[11] is None and isinstance(row[10], str):
            return (*row[:11], geometry_digest(row[10]), *row[12:])
        return row

    if len(row) == 14:
        digest = geometry_digest(row[10]) if isinstance(row[10], str) else None
        return (*row[:11], digest, *row[11:])

    if len(row) == 13:
        digest = geometry_digest(row[10]) if isinstance(row[10], str) else None
        return (*row[:11], digest, None, *row[11:])

    raise ValueError(f"boundary row has {len(row)} values, expected 13, 14 or 15")


def geometry_digest(geometry_text: str) -> str:
    """The short sha256 revision of stored geometry text, computed once at import."""
    return hashlib.sha256(geometry_text.encode("utf-8")).hexdigest()[:GEOM_DIGEST_CHARS]


def count_boundaries_missing_preview(path: Path | str) -> int:
    """The number of boundaries whose display preview is not stored yet."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT COUNT(*) FROM boundaries WHERE preview_geojson IS NULL"
        ).fetchone()
    return row[0]


def fetch_boundaries_missing_preview(path: Path | str, limit: int, offset: int = 0) -> list[Record]:
    """Up to `limit` boundaries without a stored preview, oldest first, geometry included.

    `offset` skips rows, so a backfill moves past geometries too broken to store a preview
    for instead of fetching them again.
    """
    with connect(path) as connection:
        rows = connection.execute(
            "SELECT id, bbox_w, bbox_s, bbox_e, bbox_n, geom_geojson, geom_digest "
            "FROM boundaries WHERE preview_geojson IS NULL ORDER BY rowid LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [dict(row) for row in rows]


def count_boundaries_missing_digest(path: Path | str) -> int:
    """The number of boundaries whose geometry revision is not stored yet."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT COUNT(*) FROM boundaries WHERE geom_digest IS NULL"
        ).fetchone()
    return row[0]


def fetch_boundaries_missing_digest(path: Path | str, limit: int, offset: int = 0) -> list[Record]:
    """Up to `limit` boundaries without a stored digest, oldest first, geometry included."""
    with connect(path) as connection:
        rows = connection.execute(
            "SELECT id, geom_geojson FROM boundaries "
            "WHERE geom_digest IS NULL ORDER BY rowid LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [dict(row) for row in rows]


def set_boundary_digests(path: Path | str, digests: Iterable[tuple[str, str]]) -> int:
    """Store geometry digests as (boundary id, digest) pairs; returns the rows stored.

    Rows whose digest is already set keep it, so a concurrent reimport is never overwritten.
    """
    with connect(path) as connection:
        before = connection.total_changes
        connection.execute("BEGIN")
        connection.executemany(
            "UPDATE boundaries SET geom_digest = ? WHERE id = ? AND geom_digest IS NULL",
            [(digest, boundary_id) for boundary_id, digest in digests],
        )
        connection.execute("COMMIT")

        return connection.total_changes - before


def set_boundary_preview(
    path: Path | str,
    boundary_id: str,
    preview_geojson: str,
    expected_digest: str | None,
    new_digest: str,
) -> bool:
    """Store one display preview, guarded on the digest the computation was based on.

    Returns True when stored; False when a concurrent reimport changed the geometry first.
    """
    return (
        set_boundary_previews(path, [(boundary_id, preview_geojson, expected_digest, new_digest)])
        == 1
    )


def set_boundary_previews(path: Path | str, previews: Iterable[PreviewWrite]) -> int:
    """Store display previews; returns the rows stored, skipping concurrent reimports.

    Each write holds (boundary id, preview GeoJSON, the digest the computation was based on,
    the digest of the geometry it was computed from), so an older computation never
    overwrites a reimported geometry and its preview.
    """
    with connect(path) as connection:
        before = connection.total_changes
        connection.execute("BEGIN")
        connection.executemany(
            "UPDATE boundaries SET preview_geojson = ?, geom_digest = ? "
            "WHERE id = ? AND geom_digest IS ?",
            [
                (preview, new_digest, boundary_id, expected)
                for boundary_id, preview, expected, new_digest in previews
            ],
        )
        connection.execute("COMMIT")

        return connection.total_changes - before


def set_admin_kinds(path: Path | str, rows: list[tuple[str, str, str]]) -> int:
    """Replace the per-country level names; rows hold (iso3, level, kind).

    Returns the number of rows stored, so duplicate keys count once.
    """
    with connect(path) as connection:
        connection.execute("BEGIN")
        connection.execute("DELETE FROM admin_kinds")
        connection.executemany(
            "INSERT OR REPLACE INTO admin_kinds (iso3, level, kind) VALUES (?,?,?)", rows
        )
        connection.execute("COMMIT")
        stored = connection.execute("SELECT COUNT(*) FROM admin_kinds").fetchone()[0]

    return stored


def has_boundaries_besides(path: Path | str, source: str) -> bool:
    """Used to skip seeding if real boundaries exist from another source."""
    with connect(path) as connection:
        row = connection.execute(
            "SELECT 1 FROM boundaries WHERE source != ? LIMIT 1", (source,)
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
            f"UPDATE scenes SET {assignments} WHERE id = ?",  # noqa: S608 - keys are code column names.
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
        f"SELECT COUNT(*) FROM scenes WHERE status IN {ACTIVE_STATUSES}"  # noqa: S608 - the list is a module constant.
    ).fetchone()[0]
    if active >= max_active:
        raise Busy()


def _queue_scene(
    connection: sqlite3.Connection, scene_id: str, request_json: str, is_new: bool
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

    age = datetime.now(UTC) - datetime.fromisoformat(row["checked"])
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
    connection = sqlite3.connect(path, timeout=SQLITE_TIMEOUT_SECS, isolation_level=None)
    connection.row_factory = sqlite3.Row

    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        yield connection
    finally:
        connection.close()


def now() -> str:
    """The current UTC time as an ISO 8601 string, to the second."""
    return datetime.now(UTC).isoformat(timespec="seconds")
