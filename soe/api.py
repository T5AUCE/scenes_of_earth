"""FastAPI app: boundary search, scene build jobs, and static scene files.

Config (environment): SOE_DB, SOE_SCENES_DIR, SOE_PUBLIC_BASE, SOE_MAX_BUILDS, SOE_MAX_QUEUE,
SOE_SYNTHETIC, SOE_LATEST. With SOE_SYNTHETIC=1 an empty boundaries table is seeded from sample_areas.geojson.
"""
import hashlib
import json
import logging
import os
import re
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
from .areas import MAX_BODY, Area, AreaError, check_months, clean_polygon, plan, unwrap
from .build import build_scene
from .sources import FIRST_MONTH, REGISTRY, RealSource, SourceUnavailable, SyntheticSource, make_registry, month_list

log = logging.getLogger("soe")

LEVELS = ("country", "state", "county", "city")
ID_LEN = 20  # hex characters of the sha256 kept as the scene id (80 bits; short paths for Windows)
ID_RE = re.compile(r"[0-9a-f]{%d}" % ID_LEN)
DEFAULT_LAYERS = ["chirps_monthly", "glo90_terrain"]
COVERAGE = [-180, -60, 180, 60]  # both layers: 60S to 60N
SAMPLE_AREAS = Path(__file__).with_name("sample_areas.geojson")
IMMUTABLE = "public, max-age=31536000, immutable"


class SceneFiles(StaticFiles):
    """Serves SCENES_DIR (never the half-built .tmp directory). Bundles are content-addressed, so immutable."""

    async def get_response(self, path, scope):
        if path.startswith("."):
            raise StarletteHTTPException(404)
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            response.headers["Cache-Control"] = IMMUTABLE
        return response


def resolve_area(db_path, spec):
    """Turn {"type": "boundary", "id"} or {"type": "polygon", "geometry"} into an Area."""
    if not isinstance(spec, dict):
        raise AreaError("area must be an object")
    if spec.get("type") == "boundary":
        row = db.get_boundary(db_path, spec.get("id")) if isinstance(spec.get("id"), str) else None
        if row is None:
            raise AreaError("unknown boundary id")
        return Area(shape(json.loads(row["geom_geojson"])), row)
    if spec.get("type") == "polygon":
        return Area(clean_polygon(spec.get("geometry")))
    raise AreaError("area.type must be 'boundary' or 'polygon'")


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


def seed_sample_areas(db_path):
    """Synthetic mode only: load the hand-drawn sample shapes when no boundaries exist yet."""
    if db.search(db_path, "", None, 1):  # an empty query matches every row
        return
    rows = []
    for f in json.loads(SAMPLE_AREAS.read_text())["features"]:
        geom, p = shape(f["geometry"]), f["properties"]
        w, s, e, n = unwrap(geom).bounds
        rows.append((p["id"], p["level"], p["name"], p["parent_name"], p["iso3"], w, s, e, n,
                     max(1, round(geom.area / 0.05**2)), json.dumps(f["geometry"]), "synthetic",
                     "none (hand-drawn sample)"))
    db.add_boundaries(db_path, "synthetic", rows)


def create_app(db_path=None, scenes_dir=None, registry=None, max_builds=None, max_queue=None):
    db_path = db_path or os.environ.get("SOE_DB", "./data/soe.db")
    scenes_dir = Path(scenes_dir or os.environ.get("SOE_SCENES_DIR", "./data/scenes"))
    public = os.environ.get("SOE_PUBLIC_BASE", "/scenes").rstrip("/")
    max_queue = max_queue or int(os.environ.get("SOE_MAX_QUEUE", "20"))
    # Builds run on their own small pool, so waiting jobs never occupy Starlette's request threads.
    executor = ThreadPoolExecutor(max_builds or int(os.environ.get("SOE_MAX_BUILDS", "1")), "soe-build")
    if registry is None:
        if os.environ.get("SOE_SYNTHETIC") == "1":
            registry = make_registry(SyntheticSource())
        elif os.environ.get("SOE_LATEST"):
            registry = make_registry(RealSource(os.environ["SOE_LATEST"]))
        else:
            registry = REGISTRY
    series = next(ds for ds in registry.values() if ds.time_varying)

    @asynccontextmanager
    async def lifespan(app):
        scenes_dir.mkdir(parents=True, exist_ok=True)
        db.init(db_path)
        if os.environ.get("SOE_SYNTHETIC") == "1":
            seed_sample_areas(db_path)
        yield
        executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Scenes of Earth", version=__version__, lifespan=lifespan)

    def scene_out(row):
        return {"id": row["id"], "status": row["status"], "progress": row["progress"], "error": row["error"],
                "error_class": row["error_class"],
                "bundle_url": f"{public}/{row['id']}/scene.json" if row["status"] == "done" else None}

    def run_job(sid):
        try:
            row = db.get_scene(db_path, sid)
            req, last = json.loads(row["request_json"]), [0.0]

            def progress(p):
                if p - last[0] >= 0.02 or p >= 1:
                    last[0] = p
                    db.update_scene(db_path, sid, progress=round(p, 3))

            db.update_scene(db_path, sid, status="running")
            area = resolve_area(db_path, req["area"])
            size = build_scene(sid, area, req["start"], req["end"], [registry[k] for k in req["layers"]],
                               req["title"], scenes_dir, progress)
            db.update_scene(db_path, sid, status="done", progress=1.0, bytes=size, finished=db.now())
        except Exception as e:
            log.exception("scene %s failed", sid)
            # Our own AreaError texts are safe to show; anything else may contain paths, so stays in the log.
            message = str(e) if isinstance(e, AreaError) else "build failed; see the server log"
            try:
                db.update_scene(db_path, sid, status="failed", error=message, error_class=type(e).__name__,
                                finished=db.now())
            except Exception:
                log.exception("scene %s: could not record the failure", sid)

    def prepare(body):
        """Validate and register a scene request. Returns (status code, payload, start the job?)."""
        try:
            data = json.loads(body)
        except (ValueError, RecursionError):
            raise AreaError("body must be JSON")
        if not isinstance(data, dict):
            raise AreaError("body must be a JSON object")
        layers = data.get("layers", list(registry))
        if not (isinstance(layers, list) and layers and all(isinstance(v, str) and v in registry for v in layers)):
            raise AreaError("layers must be a non-empty list of: " + ", ".join(registry))
        layers = sorted(set(layers))
        datasets = [registry[k] for k in layers]
        title = data.get("title")
        if title is not None and not (isinstance(title, str) and len(title) <= 120):
            raise AreaError("title must be a string of at most 120 characters")
        area = resolve_area(db_path, data.get("area"))
        if any(ds.time_varying for ds in datasets):
            start, end = data.get("start"), data.get("end")
            check_months(start, end, series.backend.latest_month())
        else:
            start = end = FIRST_MONTH  # months are irrelevant here, so every terrain-only request is one scene
        plan(area, len(month_list(start, end)), datasets)  # raises AreaError before any data read
        # The scene id is the content hash: canonical request + dataset versions + data vintage + generator.
        if area.named:
            geom_id = area.boundary["id"] + ":" + hashlib.sha1(area.boundary["geom_geojson"].encode()).hexdigest()
            spec = {"type": "boundary", "id": area.boundary["id"]}
        else:
            geom_id = "poly:" + hashlib.sha1(area.geom.wkb).hexdigest()
            spec = {"type": "polygon", "geometry": mapping(area.geom)}
        try:
            vintage = {ds.id: ds.vintage(end) for ds in datasets if ds.time_varying}
        except SourceUnavailable:
            raise HTTPException(503, "data source unavailable, retry shortly", headers={"Retry-After": "30"})
        content = [geom_id, layers, start, end, {ds.id: ds.source.get("version") for ds in datasets},
                   vintage, __version__]
        sid = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()[:ID_LEN]
        request_json = json.dumps({"area": spec, "layers": layers, "start": start, "end": end,
                                   "title": title or (area.boundary["name"] if area.named else "Drawn area")})
        try:
            row, start_job = db.submit(db_path, sid, request_json, (scenes_dir / sid / "scene.json").exists(),
                                       max_queue)
        except db.Busy:
            raise HTTPException(503, "too many scenes are being built, retry later", headers={"Retry-After": "60"})
        return (202 if row["status"] in ("queued", "running") else 200), scene_out(row), start_job

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__}

    @app.get("/api/layers")
    def layers():
        latest = series.backend.latest_month()
        return {"default": [k for k in DEFAULT_LAYERS if k in registry],
                "layers": [{"id": ds.id, "title": ds.style["title"], "units": ds.units, "kind": ds.style["kind"],
                            "time_varying": ds.time_varying, "coverage": COVERAGE,
                            "first_month": FIRST_MONTH if ds.time_varying else None,
                            "latest_month": latest if ds.time_varying else None} for ds in registry.values()]}

    @app.get("/api/areas/search")
    def search(q: str, level: str | None = None, limit: int = 20):
        if level is not None and level not in LEVELS:
            raise HTTPException(422, "level must be one of " + ", ".join(LEVELS))
        rows = db.search(db_path, q.strip(), level, max(1, min(limit, 50))) if q.strip() else []
        return [_area_out(r) for r in rows]

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
            code, out, start = await run_in_threadpool(prepare, body)
        except AreaError as e:
            raise HTTPException(422, str(e))
        if start:
            executor.submit(run_job, out["id"])
        return JSONResponse(out, code)

    @app.get("/api/scenes/{scene_id}")
    def get_scene(scene_id: str):
        row = db.get_scene(db_path, scene_id) if ID_RE.fullmatch(scene_id) else None
        if row is None:
            raise HTTPException(404, "unknown scene")
        return scene_out(row)

    app.mount(public if public.startswith("/") else "/scenes", SceneFiles(directory=scenes_dir, check_dir=False),
              name="scenes")
    return app


def _area_out(r):
    return {"id": r["id"], "name": r["name"], "level": r["level"], "iso3": r["iso3"],
            "parent_name": r["parent_name"], "bbox": [r["bbox_w"], r["bbox_s"], r["bbox_e"], r["bbox_n"]],
            "cells": r["cells"]}


app = create_app()
