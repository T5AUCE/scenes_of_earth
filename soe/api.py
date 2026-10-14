"""FastAPI app: boundary search, scene build jobs, and static scene files.

Config (environment): SOE_DB, SOE_SCENES_DIR, SOE_PUBLIC_BASE, SOE_MAX_BUILDS, SOE_MAX_QUEUE,
SOE_SYNTHETIC, SOE_LATEST. With SOE_SYNTHETIC=1 an empty boundaries table is seeded from
soe/data/sample_areas.geojson.
"""
import json
import logging
import os
import re
import threading
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from shapely.geometry import shape
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import Scope

from . import __version__, db
from .areas import MAX_BODY_BYTES, AreaError, unwrap
from .build import build_scene
from .bundle import JsonObject
from .scene_request import ID_CHARS, prepare_scene, resolve_area
from .sources import (
    REGISTRY,
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
PROGRESS_STEP = 0.02

LEVELS = ("country", "state", "county", "city")
DEFAULT_LAYERS = ["chirps_monthly", "glo90_terrain"]
MAX_SEARCH_LIMIT = 50

SAMPLE_AREAS = Path(__file__).parent / "data" / "sample_areas.geojson"
SAMPLE_CELL_AREA_DEG2 = 0.05**2

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
    max_queue = max_queue or int(os.environ.get("SOE_MAX_QUEUE", "20"))
    
    if registry is None:
        registry = _default_registry()
    # Builds run on their own small pool, so waiting jobs never occupy Starlette's request threads.
    executor = ThreadPoolExecutor(
        max_builds or int(os.environ.get("SOE_MAX_BUILDS", "1")),
        "soe-build",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        scenes_dir.mkdir(parents=True, exist_ok=True)
        db.init(db_path)
        if os.environ.get("SOE_SYNTHETIC") == "1":
            seed_sample_areas(db_path)
        threading.Thread(target=_warm_latest_months, args=(registry,), daemon=True).start()
        yield
        executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Scenes of Earth", version=__version__, lifespan=lifespan)

    def scene_out(row: db.Record) -> JsonObject:
        done = row["status"] == "done"
        return {
            "id": row["id"],
            "status": row["status"],
            "progress": row["progress"],
            "error": row["error"],
            "error_class": row["error_class"],
            "bundle_url": f"{public}/{row['id']}/scene.json" if done else None,
        }

    def run_job(scene_id: str) -> None:
        try:
            request = json.loads(db.get_scene(db_path, scene_id)["request_json"])
            db.update_scene(db_path, scene_id, status="running")

            area = resolve_area(db_path, request["area"])
            size = build_scene(
                scene_id,
                area,
                request["start"],
                request["end"],
                [registry[layer_id] for layer_id in request["layers"]],
                request["title"],
                scenes_dir,
                _ProgressRecorder(db_path, scene_id),
            )
            db.update_scene(
                db_path,
                scene_id,
                status="done",
                progress=1.0,
                bytes=size,
                finished=db.now(),
            )
        except Exception as error:
            log.exception("scene %s failed", scene_id)
            _record_failure(db_path, scene_id, error)

    def prepare(body: bytes) -> tuple[int, JsonObject, bool]:
        """Register a scene request. Returns (status code, payload, start the job?)."""
        prepared = prepare_scene(db_path, registry, body)
        bundle_exists = (scenes_dir / prepared.scene_id / "scene.json").exists()
        try:
            row, start_job = db.submit(
                db_path,
                prepared.scene_id,
                prepared.request_json,
                bundle_exists,
                max_queue,
            )
        except db.Busy:
            raise HTTPException(
                503,
                "too many scenes are being built, retry later",
                headers={"Retry-After": str(QUEUE_RETRY_AFTER_SECS)},
            )

        status_code = 202 if row["status"] in ("queued", "running") else 200
        return status_code, scene_out(row), start_job

    @app.get("/api/health", response_model=None)
    def health() -> JsonObject:
        return {"ok": True, "version": __version__}

    @app.get("/api/layers", response_model=None)
    def layers() -> JsonObject:
        return {
            "default": [layer_id for layer_id in DEFAULT_LAYERS if layer_id in registry],
            "layers": [_layer_out(dataset) for dataset in registry.values()],
        }

    @app.get("/api/areas/search", response_model=None)
    def search(q: str, level: str | None = None, limit: int = 20) -> list[JsonObject]:
        if level is not None and level not in LEVELS:
            raise HTTPException(422, "level must be one of " + ", ".join(LEVELS))

        query = q.strip()
        if not query:
            return []
        
        rows = db.search(db_path, query, level, max(1, min(limit, MAX_SEARCH_LIMIT)))
        return [_area_out(row) for row in rows]

    @app.get("/api/areas/{area_id:path}", response_model=None)
    def get_area(area_id: str) -> JsonObject:
        row = db.get_boundary(db_path, area_id)
        if row is None:
            raise HTTPException(404, "unknown area")
        
        return {**_area_out(row), "geometry": json.loads(row["geom_geojson"])}

    @app.post("/api/scenes")
    async def post_scene(request: Request) -> JSONResponse:
        body = await read_body(request)
        try:
            status_code, out, start_job = await run_in_threadpool(prepare, body)
        except AreaError as error:
            raise HTTPException(422, str(error))
        except SourceUnavailable:
            raise HTTPException(
                503,
                "data source unavailable, retry shortly",
                headers={"Retry-After": str(SOURCE_RETRY_AFTER_SECS)},
            )

        if start_job:
            executor.submit(run_job, out["id"])

        return JSONResponse(out, status_code)

    @app.get("/api/scenes/{scene_id}", response_model=None)
    def get_scene(scene_id: str) -> JsonObject:
        row = db.get_scene(db_path, scene_id) if ID_RE.fullmatch(scene_id) else None
        if row is None:
            raise HTTPException(404, "unknown scene")
        
        return scene_out(row)

    app.mount(
        public if public.startswith("/") else "/scenes",
        SceneFiles(directory=scenes_dir, check_dir=False),
        name="scenes",
    )

    return app


def _default_registry() -> Registry:
    if os.environ.get("SOE_SYNTHETIC") == "1":
        return make_registry(SyntheticSource())
    if os.environ.get("SOE_LATEST"):
        return make_registry(RealSource(os.environ["SOE_LATEST"]))
    return REGISTRY


def seed_sample_areas(db_path: Path | str) -> None:
    """Synthetic mode only: reload the sample outlines unless real boundaries are loaded."""
    if db.has_boundaries_besides(db_path, "synthetic"):
        return

    features = json.loads(SAMPLE_AREAS.read_text())["features"]
    db.add_boundaries(db_path, "synthetic", [_sample_row(feature) for feature in features])


def _sample_row(feature: JsonObject) -> db.BoundaryValues:
    geometry, properties = shape(feature["geometry"]), feature["properties"]
    west, south, east, north = unwrap(geometry).bounds
    cells = max(1, round(geometry.area / SAMPLE_CELL_AREA_DEG2))

    return (
        properties["id"],
        properties["level"],
        properties["name"],
        properties["parent_name"],
        properties["iso3"],
        west,
        south,
        east,
        north,
        cells,
        json.dumps(feature["geometry"]),
        "synthetic",
        f"{properties['license']} ({properties['source']})",
    )


def _warm_latest_months(registry: Registry) -> None:
    """Probe each series' latest month now so the first page load does not wait for it."""
    for dataset in registry.values():
        if not isinstance(dataset, SeriesDataset):
            continue

        try:
            dataset.latest()
        except Exception:
            log.warning("could not warm latest month of %s", dataset.id, exc_info=True)


class _ProgressRecorder:
    """Writes build progress to the database, but only when moved by PROGRESS_STEP."""

    def __init__(self, db_path: Path | str, scene_id: str) -> None:
        self._db_path = db_path
        self._scene_id = scene_id
        self._last_written = 0.0

    def __call__(self, progress: float) -> None:
        if progress - self._last_written >= PROGRESS_STEP or progress >= 1:
            self._last_written = progress
            db.update_scene(self._db_path, self._scene_id, progress=round(progress, 3))


def _record_failure(db_path: Path | str, scene_id: str, error: Exception) -> None:
    # Only our own AreaError texts are safe to show; other errors may contain server paths.
    message = str(error) if isinstance(error, AreaError) else "build failed; see the server log"
    try:
        db.update_scene(
            db_path,
            scene_id,
            status="failed",
            error=message,
            error_class=type(error).__name__,
            finished=db.now(),
        )
    except Exception:
        log.exception("scene %s: could not record the failure", scene_id)


def _layer_out(dataset: Dataset) -> JsonObject:
    time_axis = None
    if isinstance(dataset, SeriesDataset):
        time_axis = {
            "step": dataset.step,
            "first": dataset.first(),
            "latest": dataset.latest(),
        }

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
        "iso3": row["iso3"],
        "parent_name": row["parent_name"],
        "bbox": [row["bbox_w"], row["bbox_s"], row["bbox_e"], row["bbox_n"]],
        "cells": row["cells"],
    }


async def read_body(request: Request) -> bytes:
    """Request body, capped at MAX_BODY_BYTES (413 beyond; 400 for a malformed Content-Length)."""
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


class SceneFiles(StaticFiles):
    """Serves scene bundles: hides in-progress builds (.tmp) and marks files as
    cacheable forever, since a scene id changes whenever its data would."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        if path.startswith("."):
            raise StarletteHTTPException(404)

        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            response.headers["Cache-Control"] = IMMUTABLE
        return response


app = create_app()
