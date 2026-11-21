"""Build immutable scene bundles containing raster data and metadata."""

import json
import os
import shutil
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from itertools import groupby, pairwise
from operator import itemgetter
from pathlib import Path

import shapely
import zarr
from shapely.geometry import MultiLineString, MultiPolygon, mapping
from shapely.geometry.base import BaseGeometry

from . import __version__
from .areas import Area, simplify_for_display
from .bundle import VERSION, JsonObject, make, validate
from .land import OUTLINE_PRECISION_DEG
from .layer_writer import ProgressCallback, _write_layers
from .plan import Plan, scene_datasets
from .plan import plan as make_plan
from .sources import Dataset
from .zarr_encoding import COMPRESSION, DeterministicGzipCodec, encode_values

# Tests read the encoding helpers from build, so they stay re-exported here.
__all__ = ["COMPRESSION", "DeterministicGzipCodec", "encode_values"]

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
            temp_dir, scene_plan, datasets, scenes_dir / CACHE_DIR_NAME, progress
        )

        scene_document = make(scene_id, title, area, scene_plan, datasets, layer_metadata)

        _finalize_scene(root, temp_dir, scene_document, title, area, scene_plan)

        _check_local_revisions(datasets, scene_plan, local_revisions)
        built_size = _directory_size(temp_dir)
        # If another build published this scene first, keep the existing bundle.
        bundle_size = _publish_scene(temp_dir, final_dir, built_size)

    progress(1.0, None)
    return bundle_size


def _check_local_revisions(
    datasets: list[Dataset], scene_plan: Plan, expected: dict[str, str | None] | None
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
        }
    )

    _consolidate_metadata(temp_dir)
    _write_scene_documents(temp_dir, scene_document, title, area, scene_plan)


def _consolidate_metadata(temp_dir: Path) -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Consolidated metadata is currently not part")
        zarr.consolidate_metadata(str(temp_dir / "data.zarr"))


def _write_scene_documents(
    temp_dir: Path, scene_document: JsonObject, title: str, area: Area, scene_plan: Plan
) -> None:
    area_name = (area.boundary or {}).get("name", title)
    outline = (
        _land_outline(area, scene_plan) if area.land_version else _display_geometry(scene_plan)
    )
    properties: JsonObject = {"name": area_name}
    if area.borders is not None:
        disputed = area.disputed if area.disputed is not None else MultiLineString()
        properties["border_runs"] = _border_runs(outline, area.borders, disputed)

    _write_feature(temp_dir / "area.geojson", properties, outline)

    (temp_dir / "scene.json").write_text(json.dumps(scene_document, indent=1), encoding="utf-8")


def _write_feature(path: Path, properties: JsonObject, geometry: BaseGeometry) -> None:
    feature = {"type": "Feature", "properties": properties, "geometry": mapping(geometry)}
    path.write_text(json.dumps(feature), encoding="utf-8")


def _border_runs(
    outline: BaseGeometry, solid: BaseGeometry, disputed: BaseGeometry
) -> list[list[int]]:
    """The stretches of the written outline on land borders, as `[ring, first, last, disputed]`.

    Rings are counted in the order `area.geojson` lists them, over its polygons in order and
    within each polygon the exterior ring first and then its holes. `first` and `last` are
    vertex indexes into that ring's coordinate array, `last` included and never below `first`, so
    the run is `coordinates[first : last + 1]`. A run never passes the end of its ring, so a
    border that crosses the ring's start becomes two runs. `disputed` is 1 for a border along a
    disputed line and 0 otherwise. The coordinates are the ones written, so the run is found by
    a segment between two outline vertices that the border lines also hold, after the same
    rounding.
    """
    kinds = _border_segment_kinds(solid, disputed)
    polygons = shapely.get_parts(outline)
    rings = [ring for polygon in polygons for ring in (polygon.exterior, *polygon.interiors)]

    runs = []
    for ring_index, ring in enumerate(rings):
        segments = pairwise(tuple(vertex) for vertex in ring.coords)
        segment_kinds = [kinds.get(_segment_key(start, end)) for start, end in segments]
        for kind, group in groupby(enumerate(segment_kinds), key=itemgetter(1)):
            if kind is not None:
                indexes = [index for index, _ in group]
                runs.append([ring_index, indexes[0], indexes[-1] + 1, kind])

    return runs


def _border_segment_kinds(
    solid: BaseGeometry, disputed: BaseGeometry
) -> dict[tuple[tuple[float, ...], ...], int]:
    """Each rounded border segment, keyed by its two vertices, with 1 when it is disputed."""
    kinds = {}
    for lines, kind in ((solid, 0), (disputed, 1)):
        for line in shapely.get_parts(shapely.set_precision(lines, OUTLINE_PRECISION_DEG)):
            for start, end in pairwise(tuple(vertex) for vertex in line.coords):
                kinds[_segment_key(start, end)] = kind

    return kinds


def _segment_key(start: tuple[float, ...], end: tuple[float, ...]) -> tuple[tuple[float, ...], ...]:
    """The segment's vertices in a fixed order, so either direction finds it."""
    return tuple(sorted((start, end)))


def _display_geometry(scene_plan: Plan) -> BaseGeometry:
    """Return the plan outline simplified with the display tolerance."""
    return simplify_for_display(scene_plan.geometry, _display_tolerance(scene_plan))


def _land_outline(area: Area, scene_plan: Plan) -> BaseGeometry:
    """Return the outline of an area cut to land without parts smaller than the finest cell.

    The largest part stays, so an area of islets keeps an outline.
    """
    finest_cell_deg = _finest_cell(scene_plan)
    parts = sorted(shapely.get_parts(area.display), key=lambda part: part.area, reverse=True)
    kept = [part for part in parts if part.area >= finest_cell_deg**2] or parts[:1]

    return shapely.set_precision(MultiPolygon(kept), OUTLINE_PRECISION_DEG)


def _display_tolerance(scene_plan: Plan) -> float:
    return max(MIN_DISPLAY_TOLERANCE_DEG, _finest_cell(scene_plan) / DISPLAY_SIMPLIFY_DIVISOR)


def _finest_cell(scene_plan: Plan) -> float:
    return min(layer.res for layer in scene_plan.layers.values())


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
        file_path.stat().st_size for file_path in Path(directory).rglob("*") if file_path.is_file()
    )
