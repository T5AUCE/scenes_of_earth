"""Build immutable scene bundles containing raster data and metadata."""
import json
import os
import shutil
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import zarr
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry

from . import __version__
from .areas import Area, simplify_for_display
from .bundle import VERSION, JsonObject, make, validate
from .layer_writer import LayerProgress, ProgressCallback, _write_layers
from .plan import Plan, plan as make_plan, scene_datasets
from .sources import Dataset
from .zarr_encoding import (
    COMPRESSION,
    DeterministicGzipCodec,
    _DeterministicGZip,
    encode_values,
)

CACHE_DIR_NAME = ".cache"  # in the scenes directory; the leading dot keeps it unserved

# The bundle outline is display-only, so a quarter of the finest grid cell hides the deviation.
DISPLAY_SIMPLIFY_DIVISOR = 4
MIN_DISPLAY_TOLERANCE_DEG = 0.0005


class SourceChanged(Exception):
    """Local source data was replaced after the scene's id was made, so the id would be wrong."""


def build_scene(
    scene_id: str,
    area: Area,
    start: str | None,
    end: str | None,
    datasets: list[Dataset],
    title: str,
    scenes_dir: Path | str,
    progress: ProgressCallback = lambda fraction, stage: None,
    local_revisions: dict[str, str | None] | None = None,
) -> int:
    """Build or reuse the scene's bundle and return its size in bytes.

    `start` and `end` are request periods ('YYYY-MM'), or None for scenes without series.
    `local_revisions` are the local revisions that the scene id was made from. The build checks
    them before reading and again before publishing, and raises SourceChanged without publishing
    if any differs. Without them nothing is checked.
    """
    scenes_dir = Path(scenes_dir)
    final_dir = scenes_dir / scene_id

    # Content-addressed bundles are immutable and can be reused.
    if final_dir.is_dir():
        size = _directory_size(final_dir)
        progress(1.0, None)
        return size

    datasets = scene_datasets(area, datasets)
    scene_plan = make_plan(area, datasets, start, end)
    _check_local_revisions(datasets, scene_plan, local_revisions)

    with _temporary_scene_directory(scenes_dir, scene_id) as temp_dir:
        layer_metadata, root = _write_layers(
            temp_dir,
            scene_plan,
            datasets,
            scenes_dir / CACHE_DIR_NAME,
            progress,
        )

        scene_document = make(
            scene_id,
            title,
            area,
            scene_plan,
            datasets,
            layer_metadata,
        )

        _finalize_scene(
            root,
            temp_dir,
            scene_document,
            title,
            area,
            scene_plan,
        )

        _check_local_revisions(datasets, scene_plan, local_revisions)
        built_size = _directory_size(temp_dir)
        # If another build published this scene first, keep the existing bundle.
        bundle_size = _publish_scene(temp_dir, final_dir, built_size)

    progress(1.0, None)
    return bundle_size


def _check_local_revisions(
    datasets: list[Dataset],
    scene_plan: Plan,
    expected: dict[str, str | None] | None,
) -> None:
    if expected is None:
        return

    for dataset in datasets:
        if dataset.time_varying:
            current = dataset.local_revision(scene_plan.layers[dataset.id].steps)
            if current != expected.get(dataset.id):
                raise SourceChanged(f"{dataset.title} data changed after the scene was prepared")


@contextmanager
def _temporary_scene_directory(scenes_dir: Path | str, scene_id: str) -> Iterator[Path]:
    temp_dir = Path(scenes_dir) / ".tmp" / scene_id

    shutil.rmtree(temp_dir, ignore_errors=True)
    temp_dir.mkdir(parents=True)

    try:
        yield temp_dir
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _finalize_scene(
    root: zarr.Group,
    temp_dir: Path,
    scene_document: JsonObject,
    title: str,
    area: Area,
    scene_plan: Plan,
) -> None:
    problems = validate(scene_document, VERSION)
    if problems:
        raise RuntimeError("Invalid scene.json: " + "; ".join(problems))

    root.attrs.update(
        {
            "title": title,
            "conventions": "CF-1.8",
            "generator": f"soe {__version__}",
            "credits": scene_document["credits"],
        },
    )

    _consolidate_metadata(temp_dir)
    _write_scene_documents(temp_dir, scene_document, title, area, scene_plan)


def _consolidate_metadata(temp_dir: Path) -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Consolidated metadata is currently not part",
        )
        zarr.consolidate_metadata(str(temp_dir / "data.zarr"))


def _write_scene_documents(
    temp_dir: Path,
    scene_document: JsonObject,
    title: str,
    area: Area,
    scene_plan: Plan,
) -> None:
    area_name = (area.boundary or {}).get("name", title)
    area_feature = {
        "type": "Feature",
        "properties": {"name": area_name},
        "geometry": mapping(_display_geometry(scene_plan)),
    }

    (temp_dir / "area.geojson").write_text(
        json.dumps(area_feature),
        encoding="utf-8",
    )
    (temp_dir / "scene.json").write_text(
        json.dumps(scene_document, indent=1),
        encoding="utf-8",
    )


def _display_geometry(scene_plan: Plan) -> BaseGeometry:
    """Return the plan outline simplified with the display tolerance."""
    finest_cell_deg = min(layer.res for layer in scene_plan.layers.values())
    tolerance_deg = max(MIN_DISPLAY_TOLERANCE_DEG, finest_cell_deg / DISPLAY_SIMPLIFY_DIVISOR)
    return simplify_for_display(scene_plan.geometry, tolerance_deg)


def _publish_scene(temp_dir: Path, final_dir: Path, built_size: int) -> int:
    if final_dir.is_dir():
        return _directory_size(final_dir)

    try:
        os.replace(temp_dir, final_dir)
    except OSError:
        # Another build may have published the same scene concurrently.
        if final_dir.is_dir():
            return _directory_size(final_dir)
        raise

    return built_size


def _directory_size(directory: Path | str) -> int:
    return sum(
        file_path.stat().st_size
        for file_path in Path(directory).rglob("*")
        if file_path.is_file()
    )
