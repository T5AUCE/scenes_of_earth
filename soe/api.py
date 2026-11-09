"""Serve boundary search, scene build jobs and static scene files through FastAPI.

Environment settings are SOE_DB, SOE_SCENES_DIR, SOE_PUBLIC_BASE, SOE_MAX_BUILDS,
SOE_MAX_QUEUE, SOE_SYNTHETIC, SOE_LATEST, SOE_CUBES_DIR and SOE_TERRAIN_TILES.
SOE_LATEST applies only without the CHIRPS cube, and SOE_CUBES_DIR holds the ERA5 and CHIRPS cubes.
SOE_TERRAIN_TILES defaults to hosted Mapterhorn tiles. With SOE_SYNTHETIC=1 an empty
boundaries table is seeded from soe/data/sample_areas.geojson.
"""
import json
import logging
import os
import re
import threading
from collections import OrderedDict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from shapely.geometry import shape
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send

from . import __version__, db
from .areas import AreaError, display_preview
from .bundle import JsonObject
from .jobs import SceneJobs
from .sample_areas import seed_sample_areas
from .scene_request import ID_CHARS, default_layers, request_bounds
from .sources import (
    DEFAULT_CUBES_DIR,
    REQUEST_STEP,
    Dataset,
    RealSource,
    Registry,
    SeriesDataset,
    SourceUnavailable,
    SyntheticSource,
    make_registry,
)

ID_RE = re.compile(r"[0-9a-f]{%d}" % ID_CHARS)
IMMUTABLE_MAX_AGE_SECS = 365 * 24 * 60 * 60
IMMUTABLE = f"public, max-age={IMMUTABLE_MAX_AGE_SECS}, immutable"

AREA_MAX_AGE_SECS = 60 * 60
AREA_CACHE_CONTROL = f"public, max-age={AREA_MAX_AGE_SECS}, must-revalidate"

GEOMETRY_CACHE_SIZE = 64
GeometryKey = tuple[str, str | None, tuple[float, float, float, float]]
# id, geometry digest and bbox, all cheap to read so hits skip the text.
_geometry_cache: OrderedDict[GeometryKey, JsonObject] = OrderedDict()
_geometry_cache_lock = threading.Lock()

GZIP_MINIMUM_SIZE_BYTES = 1000

MAX_BODY_BYTES = 1_000_000
LEVELS = ("country", "state", "county", "city")
MAX_SEARCH_LIMIT = 50

DEFAULT_MAX_BUILDS = 1
DEFAULT_MAX_QUEUE = 20

SOURCE_RETRY_AFTER_SECS = 30
QUEUE_RETRY_AFTER_SECS = 60

log = logging.getLogger("soe")


def create_app(
    db_path: Path | str | None = None,
    scenes_dir: Path | str | None = None,
    registry: Registry | None = None,
    max_builds: int | None = None,
    max_queue: int | None = None,
) -> FastAPI:
    """Build the FastAPI app; arguments override the environment settings (tests pass them)."""
    db_path = db_path or os.environ.get("SOE_DB", "./data/soe.db")
    scenes_dir = Path(scenes_dir or os.environ.get("SOE_SCENES_DIR", "./data/scenes"))
    public = os.environ.get("SOE_PUBLIC_BASE", "/scenes").rstrip("/")
    max_builds = max_builds or int(os.environ.get("SOE_MAX_BUILDS", DEFAULT_MAX_BUILDS))
    max_queue = max_queue or int(os.environ.get("SOE_MAX_QUEUE", DEFAULT_MAX_QUEUE))
    
    if registry is None:
        registry = _default_registry()
    jobs = SceneJobs(db_path, scenes_dir, registry, max_builds, max_queue)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        scenes_dir.mkdir(parents=True, exist_ok=True)
        db.init(db_path)
        if os.environ.get("SOE_SYNTHETIC") == "1":
            seed_sample_areas(db_path)
        threading.Thread(target=_warm_latest_months, args=(registry,), daemon=True).start()
        yield
        jobs.shutdown()

    app = FastAPI(title="Scenes of Earth", version=__version__, lifespan=lifespan)
    bundles = public if public.startswith("/") else "/scenes"
    app.add_middleware(
        ApiGzipMiddleware,
        bundles_path=bundles,
        minimum_size=GZIP_MINIMUM_SIZE_BYTES,
    )

    @app.get("/api/health", response_model=None)
    def health() -> JsonObject:
        return {"ok": True, "version": __version__}

    @app.get("/api/layers", response_model=None)
    def layers() -> JsonObject:
        return {
            "request_step": REQUEST_STEP,
            "default": default_layers(registry),
            "layers": _available_layers(registry),
        }

    @app.get("/api/areas/search", response_model=None)
    def search(q: str, level: str | None = None, limit: int = 20) -> list[JsonObject]:
        if level is not None and level not in LEVELS:
            raise HTTPException(422, "level must be one of " + ", ".join(LEVELS))

        query = q.strip()
        if not query:
            return []
        
        clamped_limit = max(1, min(limit, MAX_SEARCH_LIMIT))
        rows = db.search(db_path, query, level, clamped_limit)
        return [_area_out(row) for row in rows]

    @app.get("/api/areas/{area_id:path}", response_model=None)
    def get_area(area_id: str, request: Request) -> JSONResponse | Response:
        row = db.get_boundary(db_path, area_id, with_geometry=False)
        if row is None:
            raise HTTPException(404, "unknown area")

        etag = _area_etag(row)
        headers = {"Cache-Control": AREA_CACHE_CONTROL, "ETag": etag}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)

        detail = {**_area_out(row), "geometry": _area_geometry(row, db_path)}
        return JSONResponse(detail, headers=headers)

    @app.post("/api/scenes")
    async def post_scene(request: Request) -> JSONResponse:
        body = await read_body(request)
        try:
            row = await run_in_threadpool(jobs.submit, body)
        except AreaError as error:
            raise HTTPException(422, str(error))
        except SourceUnavailable:
            raise HTTPException(
                503,
                "data source unavailable, retry shortly",
                headers={"Retry-After": str(SOURCE_RETRY_AFTER_SECS)},
            )
        except db.Busy:
            raise HTTPException(
                503,
                "too many scenes are being built, retry later",
                headers={"Retry-After": str(QUEUE_RETRY_AFTER_SECS)},
            )

        status_code = 202 if row["status"] in ("queued", "running") else 200
        return JSONResponse(scene_out(row), status_code)

    def scene_out(row: db.Record) -> JsonObject:
        done = row["status"] == "done"

        return {
            "id": row["id"],
            "status": row["status"],
            "progress": row["progress"],
            "stage": row["stage"],
            "error": row["error"],
            "error_class": row["error_class"],
            "bundle_url": f"{public}/{row['id']}/scene.json" if done else None,
        }

    @app.get("/api/scenes/{scene_id}", response_model=None)
    def get_scene(scene_id: str) -> JsonObject:
        row = db.get_scene(db_path, scene_id) if ID_RE.fullmatch(scene_id) else None
        if row is None:
            raise HTTPException(404, "unknown scene")
        
        return scene_out(row)

    app.mount(
        bundles,
        SceneFiles(directory=scenes_dir, check_dir=False),
        name="scenes",
    )

    return app


def _default_registry() -> Registry:
    if os.environ.get("SOE_SYNTHETIC") == "1":
        return make_registry(SyntheticSource())
    cubes_dir = os.environ.get("SOE_CUBES_DIR", DEFAULT_CUBES_DIR)
    return make_registry(RealSource(os.environ.get("SOE_LATEST"), cubes_dir))


def _warm_latest_months(registry: Registry) -> None:
    """Probe each series' latest month now so the first page load does not wait for it."""
    for dataset in registry.values():
        if not isinstance(dataset, SeriesDataset):
            continue

        try:
            dataset.latest()
        except Exception:
            log.warning("could not warm latest month of %s", dataset.id, exc_info=True)


def _available_layers(registry: Registry) -> list[JsonObject]:
    """The layers of the registry, without those whose data is unavailable right now."""
    layers = []
    for dataset in registry.values():
        try:
            layers.append(_layer_out(dataset))
        except SourceUnavailable:
            log.warning("%s is unavailable, left out of the layer list", dataset.id)
    return layers


def _layer_out(dataset: Dataset) -> JsonObject:
    time_axis = None
    if isinstance(dataset, SeriesDataset):
        first, last = request_bounds(dataset)
        time_axis = {"step": dataset.step, "first": first, "last": last}

    return {
        "id": dataset.id,
        "title": dataset.title,
        "units": dataset.units,
        "kind": dataset.style["kind"],
        "time_varying": dataset.time_varying,
        "coverage": list(dataset.coverage),
        "time": time_axis,
    }


def _area_out(row: db.Record) -> JsonObject:
    return {
        "id": row["id"],
        "name": row["name"],
        "level": row["level"],
        "kind": row["kind"],
        "iso3": row["iso3"],
        "parent_name": row["parent_name"],
        "bbox": [row["bbox_w"], row["bbox_s"], row["bbox_e"], row["bbox_n"]],
        "cells": row["cells"],
    }


def _area_geometry(row: db.Record, db_path: Path | str) -> JsonObject:
    """Return the stored boundary preview, computing and storing it when missing.

    The preview read skips the full stored geometry; a NULL preview falls back to the old
    parse-unwrap-simplify path and is written back, so only its first request pays for it.
    """
    key = _geometry_cache_key(row)
    with _geometry_cache_lock:
        cached = _geometry_cache.get(key)
        if cached is not None:
            _geometry_cache.move_to_end(key)
            return cached

    preview = _stored_preview(row)
    if preview is None:
        full = db.get_boundary(db_path, row["id"])
        if full is None:
            raise HTTPException(404, "unknown area")
        preview = _simplify_geometry(full)
        new_digest = _digest_of_full(full)
        _remember_preview(db_path, full["id"], preview, full["geom_digest"], new_digest)
        key = (full["id"], new_digest, _bbox_of(full))
    with _geometry_cache_lock:
        if key in _geometry_cache:
            _geometry_cache.move_to_end(key)
            return _geometry_cache[key]
        if len(_geometry_cache) >= GEOMETRY_CACHE_SIZE:
            _geometry_cache.popitem(last=False)
        _geometry_cache[key] = preview
    return preview


def _stored_preview(row: db.Record) -> JsonObject | None:
    """The stored preview as JSON, or None when it is missing or no longer parses."""
    if row.get("preview_geojson") is None:
        return None
    try:
        return json.loads(row["preview_geojson"])
    except ValueError:
        return None


def _remember_preview(
    db_path: Path | str,
    boundary_id: str,
    preview: JsonObject,
    expected_digest: str | None,
    new_digest: str,
) -> None:
    """Write a computed preview back, keeping the response when the write fails."""
    try:
        db.set_boundary_preview(
            db_path,
            boundary_id,
            json.dumps(preview),
            expected_digest,
            new_digest,
        )
    except Exception:
        log.warning("could not store the preview of %s", boundary_id, exc_info=True)


def _digest_of_full(row: db.Record) -> str:
    """The revision of a fully read boundary, computed when the stored one is missing."""
    if isinstance(row["geom_geojson"], str):
        return db.geometry_digest(row["geom_geojson"])
    return row["geom_digest"] or ""


def _geometry_cache_key(row: db.Record) -> GeometryKey:
    """Key the preview cheaply; a reimport changes the digest, while the bbox covers moves."""
    return (row["id"], row["geom_digest"], _bbox_of(row))


def _area_etag(row: db.Record) -> str:
    """The area detail validator from the same cheap version as the preview key."""
    return f'"{row["id"]}:{row["geom_digest"]}:{_bbox_of(row)}"'


def _bbox_of(row: db.Record) -> tuple[float, float, float, float]:
    """The bbox tuple of a boundary row, so cache keys and validators share one frame."""
    return (row["bbox_w"], row["bbox_s"], row["bbox_e"], row["bbox_n"])


def _simplify_geometry(row: db.Record) -> JsonObject:
    """Return the boundary simplified for preview, in its bbox's longitude frame.

    A stored outline that no longer parses is returned as is, as before.
    """
    try:
        geometry = shape(json.loads(row["geom_geojson"]))
    except Exception:
        return json.loads(row["geom_geojson"])
    bbox = (row["bbox_w"], row["bbox_s"], row["bbox_e"], row["bbox_n"])
    return display_preview(geometry, bbox)


async def read_body(request: Request) -> bytes:
    """Read at most MAX_BODY_BYTES; reject excess with 413 and malformed Content-Length with 400."""
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        raise HTTPException(400, "invalid Content-Length header")
    if declared > MAX_BODY_BYTES:
        raise HTTPException(413, "request body too large")

    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(413, "request body too large")
    return body


class ApiGzipMiddleware(GZipMiddleware):
    """GZip for the JSON API; bundle files skip compression so range downloads stay exact."""

    def __init__(self, app: ASGIApp, bundles_path: str, minimum_size: int) -> None:
        super().__init__(app, minimum_size=minimum_size)
        self.bundles_path = bundles_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if path == self.bundles_path or path.startswith(self.bundles_path + "/"):
            await self.app(scope, receive, send)
            return

        await super().__call__(scope, receive, send)


class SceneFiles(StaticFiles):
    """Serves scene bundles, hiding in-progress builds (.tmp).

    Files are marked cacheable forever, since a scene id changes whenever its data would.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        """Hide temporary builds and mark successful bundle responses immutable."""
        if path.startswith("."):
            raise StarletteHTTPException(404)

        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            response.headers["Cache-Control"] = IMMUTABLE
        return response


app = create_app()
