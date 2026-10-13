"""FastAPI app: boundary search, scene build jobs, and static scene files.

Config (environment): SOE_DB, SOE_SCENES_DIR, SOE_PUBLIC_BASE, SOE_MAX_BUILDS, SOE_MAX_QUEUE,
SOE_SYNTHETIC, SOE_LATEST. With SOE_SYNTHETIC=1 an empty boundaries table is seeded from
soe/data/sample_areas.geojson.
"""
import hashlib
import json
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from shapely.geometry import mapping, shape
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__, db
from .areas import (
    MAX_BODY,
    Area,
    AreaError,
    check_months,
    clean_polygon,
    plan,
    unwrap,
)
from .build import build_scene
from .sources import (
    FIRST_MONTH,
    REGISTRY,
    RealSource,
    SourceUnavailable,
    SyntheticSource,
    make_registry,
)

ID_LEN = 20  # hex characters of the sha256 kept as the scene id (80 bits; short paths for Windows)
ID_RE = re.compile(r"[0-9a-f]{%d}" % ID_LEN)
IMMUTABLE = "public, max-age=31536000, immutable"
PROGRESS_STEP = 0.02

LEVELS = ("country", "state", "county", "city")
DEFAULT_LAYERS = ["chirps_monthly", "glo90_terrain"]
DRAWN_AREA_TITLE = "Drawn area"
MAX_TITLE_LENGTH = 120
MAX_SEARCH_LIMIT = 50

SAMPLE_AREAS = Path(__file__).parent / "data" / "sample_areas.geojson"
SAMPLE_CELL_AREA_DEG2 = 0.05**2

SOURCE_RETRY_AFTER_SECONDS = 30
QUEUE_RETRY_AFTER_SECONDS = 60

log = logging.getLogger("soe")


def create_app(
    db_path=None,
    scenes_dir=None,
    registry=None,
    max_builds=None,
    max_queue=None,
):
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
    async def lifespan(app):
        scenes_dir.mkdir(parents=True, exist_ok=True)
        db.init(db_path)
        if os.environ.get("SOE_SYNTHETIC") == "1":
            seed_sample_areas(db_path)
        threading.Thread(target=_warm_latest_months, args=(registry,), daemon=True).start()
        yield
        executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Scenes of Earth", version=__version__, lifespan=lifespan)

    def scene_out(row):
        done = row["status"] == "done"
        return {
            "id": row["id"],
            "status": row["status"],
            "progress": row["progress"],
            "error": row["error"],
            "error_class": row["error_class"],
            "bundle_url": f"{public}/{row['id']}/scene.json" if done else None,
        }

    def run_job(scene_id):
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

    def prepare(body):
        """Validate and register a scene request. Returns (status code, payload, start the job?)."""
        data = _parse_body(body)
        layers = _requested_layers(data, registry)
        datasets = [registry[layer_id] for layer_id in layers]
        title = _requested_title(data)
        area = resolve_area(db_path, data.get("area"))
        start, end = _requested_period(data, datasets)
        plan(area, datasets, start, end)  # Refuses a bad request before any data is read.

        geometry_id, area_spec = _area_identity(area)
        scene_id = _scene_id(geometry_id, layers, start, end, datasets)
        request_json = json.dumps({
            "area": area_spec,
            "layers": layers,
            "start": start,
            "end": end,
            "title": title or (area.boundary["name"] if area.named else DRAWN_AREA_TITLE),
        })

        try:
            built = (scenes_dir / scene_id / "scene.json").exists()
            row, start_job = db.submit(db_path, scene_id, request_json, built, max_queue)
        except db.Busy:
            raise HTTPException(
                503,
                "too many scenes are being built, retry later",
                headers={"Retry-After": str(QUEUE_RETRY_AFTER_SECONDS)},
            )

        status_code = 202 if row["status"] in ("queued", "running") else 200
        return status_code, scene_out(row), start_job

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__}

    @app.get("/api/layers")
    def layers():
        return {
            "default": [layer_id for layer_id in DEFAULT_LAYERS if layer_id in registry],
            "layers": [_layer_out(dataset) for dataset in registry.values()],
        }

    @app.get("/api/areas/search")
    def search(q: str, level: str | None = None, limit: int = 20):
        if level is not None and level not in LEVELS:
            raise HTTPException(422, "level must be one of " + ", ".join(LEVELS))

        query = q.strip()
        if not query:
            return []
        
        rows = db.search(db_path, query, level, max(1, min(limit, MAX_SEARCH_LIMIT)))
        return [_area_out(row) for row in rows]

    @app.get("/api/areas/{area_id:path}")
    def get_area(area_id: str):
        row = db.get_boundary(db_path, area_id)
        if row is None:
            raise HTTPException(404, "unknown area")
        
        return {**_area_out(row), "geometry": json.loads(row["geom_geojson"])}

    @app.post("/api/scenes")
    async def post_scene(request: Request):
        body = await read_body(request)
        try:
            status_code, out, start_job = await run_in_threadpool(prepare, body)
        except AreaError as error:
            raise HTTPException(422, str(error))

        if start_job:
            executor.submit(run_job, out["id"])

        return JSONResponse(out, status_code)

    @app.get("/api/scenes/{scene_id}")
    def get_scene(scene_id: str):
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


def _default_registry():
    if os.environ.get("SOE_SYNTHETIC") == "1":
        return make_registry(SyntheticSource())
    if os.environ.get("SOE_LATEST"):
        return make_registry(RealSource(os.environ["SOE_LATEST"]))
    return REGISTRY


def seed_sample_areas(db_path):
    """Synthetic mode only: reload the sample outlines unless real boundaries are loaded."""
    if db.has_boundaries_besides(db_path, "synthetic"):
        return

    features = json.loads(SAMPLE_AREAS.read_text())["features"]
    db.add_boundaries(db_path, "synthetic", [_sample_row(feature) for feature in features])


def _sample_row(feature):
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


def _warm_latest_months(registry):
    """Probe each series' latest month now so the first page load does not wait for it."""
    for dataset in registry.values():
        if not dataset.time_varying:
            continue

        try:
            dataset.latest()
        except Exception:
            log.warning("could not warm latest month of %s", dataset.id, exc_info=True)


def resolve_area(db_path, spec):
    """Turn {"type": "boundary", "id"} or {"type": "polygon", "geometry"} into an Area."""
    if not isinstance(spec, dict):
        raise AreaError("area must be an object")

    if spec.get("type") == "boundary":
        boundary_id = spec.get("id")
        row = db.get_boundary(db_path, boundary_id) if isinstance(boundary_id, str) else None
        if row is None:
            raise AreaError("unknown boundary id")
        return Area(shape(json.loads(row["geom_geojson"])), row)

    if spec.get("type") == "polygon":
        return Area(clean_polygon(spec.get("geometry")))

    raise AreaError("area.type must be 'boundary' or 'polygon'")


class _ProgressRecorder:
    """Writes build progress to the database, but only when moved by PROGRESS_STEP."""
    def __init__(self, db_path, scene_id):
        self._db_path = db_path
        self._scene_id = scene_id
        self._last_written = 0.0

    def __call__(self, progress):
        if progress - self._last_written >= PROGRESS_STEP or progress >= 1:
            self._last_written = progress
            db.update_scene(self._db_path, self._scene_id, progress=round(progress, 3))


def _record_failure(db_path, scene_id, error):
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


def _parse_body(body):
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        raise AreaError("body must be JSON")
    if not isinstance(data, dict):
        raise AreaError("body must be a JSON object")
    return data


def _requested_layers(data, registry):
    layers = data.get("layers", list(registry))
    valid = (
        isinstance(layers, list)
        and layers
        and all(isinstance(layer_id, str) and layer_id in registry for layer_id in layers)
    )
    if not valid:
        raise AreaError("layers must be a non-empty list of: " + ", ".join(registry))
    return sorted(set(layers))


def _requested_title(data):
    title = data.get("title")
    if title is not None and not (isinstance(title, str) and len(title) <= MAX_TITLE_LENGTH):
        raise AreaError(f"title must be a string of at most {MAX_TITLE_LENGTH} characters")
    return title


def _requested_period(data, datasets):
    series = [dataset for dataset in datasets if dataset.time_varying]
    if not series:
        # Months are irrelevant here, so every terrain-only request is one scene.
        return FIRST_MONTH, FIRST_MONTH

    start, end = data.get("start"), data.get("end")
    for dataset in series:
        check_months(start, end, dataset.first(), dataset.latest(), f"{dataset.title}: ")
    return start, end


def _area_identity(area):
    """(id that changes when the geometry does, area spec stored in the job's request)."""
    if area.named:
        boundary = area.boundary
        geometry_hash = hashlib.sha256(boundary["geom_geojson"].encode()).hexdigest()
        return boundary["id"] + ":" + geometry_hash, {"type": "boundary", "id": boundary["id"]}

    geometry_hash = hashlib.sha256(area.geom.wkb).hexdigest()
    return "poly:" + geometry_hash, {"type": "polygon", "geometry": mapping(area.geom)}


def _scene_id(geometry_id, layers, start, end, datasets):
    """Content hash of the canonical request, dataset versions, data vintage and generator."""
    try:
        vintage = {
            dataset.id: dataset.vintage(end) for dataset in datasets if dataset.time_varying
        }
    except SourceUnavailable:
        raise HTTPException(
            503,
            "data source unavailable, retry shortly",
            headers={"Retry-After": str(SOURCE_RETRY_AFTER_SECONDS)},
        )

    versions = {dataset.id: dataset.source.get("version") for dataset in datasets}
    synthetic = {dataset.id: isinstance(dataset.backend, SyntheticSource) for dataset in datasets}
    content = [geometry_id, layers, start, end, versions, vintage, synthetic, __version__]
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()[:ID_LEN]


def _layer_out(dataset):
    time_axis = None
    if dataset.time_varying:
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


def _area_out(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "level": row["level"],
        "iso3": row["iso3"],
        "parent_name": row["parent_name"],
        "bbox": [row["bbox_w"], row["bbox_s"], row["bbox_e"], row["bbox_n"]],
        "cells": row["cells"],
    }


async def read_body(request):
    """Request body, capped at MAX_BODY bytes (413 beyond; 400 for a malformed Content-Length)."""
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        raise HTTPException(400, "invalid Content-Length header")
    if declared > MAX_BODY:
        raise HTTPException(413, "request body too large")

    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY:
            raise HTTPException(413, "request body too large")
        
    return body


class SceneFiles(StaticFiles):
    """Bundles are content-addressed, so responses are cached as immutable."""
    async def get_response(self, path, scope):
        if path.startswith("."):
            raise StarletteHTTPException(404)

        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            response.headers["Cache-Control"] = IMMUTABLE
        return response


app = create_app()
