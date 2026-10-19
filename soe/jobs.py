"""Scene build jobs: queue a validated request, build its bundle, record status in the db."""
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import db
from .areas import AreaError
from .build import SourceChanged, build_scene
from .scene_request import prepare_scene, resolve_area
from .sources import Registry

PROGRESS_STEP = 0.02  # fraction of the build; smaller moves are not written to the database

log = logging.getLogger("soe")


class SceneJobs:
    """Registers scene requests and builds the new ones on a small thread pool."""

    def __init__(
        self,
        db_path: Path | str,
        scenes_dir: Path,
        registry: Registry,
        max_builds: int,
        max_queue: int,
    ) -> None:
        self._db_path = db_path
        self._scenes_dir = scenes_dir
        self._registry = registry
        self._max_queue = max_queue
        # Builds get their own small pool, so waiting jobs never hold Starlette's request threads.
        self._executor = ThreadPoolExecutor(max_builds, "soe-build")

    def submit(self, body: bytes) -> db.Record:
        """Validate a request body and queue its scene, starting the build when it is new.

        Returns the scene row. Raises AreaError, SourceUnavailable or db.Busy (queue full) before
        any data is read.
        """
        prepared = prepare_scene(self._db_path, self._registry, body)
        bundle_exists = (self._scenes_dir / prepared.scene_id / "scene.json").exists()
        row, start_build = db.submit(
            self._db_path,
            prepared.scene_id,
            prepared.request_json,
            bundle_exists,
            self._max_queue,
        )
        if start_build:
            self._executor.submit(self._run, prepared.scene_id)
        return row

    def shutdown(self) -> None:
        """Stop taking builds and cancel the queued ones without waiting for the running ones."""
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _run(self, scene_id: str) -> None:
        try:
            self._build(scene_id)
        except Exception as error:
            log.exception("scene %s failed", scene_id)
            _record_failure(self._db_path, scene_id, error)

    def _build(self, scene_id: str) -> None:
        request = json.loads(db.get_scene(self._db_path, scene_id)["request_json"])
        db.update_scene(self._db_path, scene_id, status="running")

        area = resolve_area(self._db_path, request["area"])
        size = build_scene(
            scene_id,
            area,
            request["start"],
            request["end"],
            [self._registry[layer_id] for layer_id in request["layers"]],
            request["title"],
            self._scenes_dir,
            _ProgressRecorder(self._db_path, scene_id),
            request.get("local_revisions"),
        )
        db.update_scene(
            self._db_path,
            scene_id,
            status="done",
            progress=1.0,
            stage=None,
            bytes=size,
            finished=db.now(),
        )


class _ProgressRecorder:
    """Writes build progress and stage text to the database, only when moved by PROGRESS_STEP."""

    def __init__(self, db_path: Path | str, scene_id: str) -> None:
        self._db_path = db_path
        self._scene_id = scene_id
        self._last_written = 0.0

    def __call__(self, progress: float, stage: str | None) -> None:
        if progress - self._last_written >= PROGRESS_STEP or progress >= 1:
            self._last_written = progress
            db.update_scene(
                self._db_path,
                self._scene_id,
                progress=round(progress, 3),
                stage=stage,
            )


def _record_failure(db_path: Path | str, scene_id: str, error: Exception) -> None:
    # Only our own error texts are safe to show; other errors may contain server paths.
    if isinstance(error, AreaError):
        message = str(error)
    elif isinstance(error, SourceChanged):
        message = "The data changed while the scene was waiting; request the scene again."
    else:
        message = "build failed; see the server log"
    try:
        db.update_scene(
            db_path,
            scene_id,
            status="failed",
            stage=None,
            error=message,
            error_class=type(error).__name__,
            finished=db.now(),
        )
    except Exception:
        log.exception("scene %s: could not record the failure", scene_id)
