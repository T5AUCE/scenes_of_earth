"""Scene preparation: validate a scene request and give it its content-addressed id.

A revision is a marker that changes whenever the provider republishes a month's data (CHIRPS:
the file's Last-Modified date). It is part of the scene id, so revised data gets a new scene.
"""
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from shapely.geometry import mapping, shape

from . import __version__, db
from .areas import Area, AreaError, clean_polygon
from .bundle import JsonObject
from .plan import plan
from .sources import (
    FIRST_MONTH,
    Dataset,
    Registry,
    SeriesDataset,
    SourceUnavailable,
    SyntheticSource,
)

ID_CHARS = 20  # hex characters of the sha256 kept as the id (80 bits; short Windows paths)

DRAWN_AREA_TITLE = "Drawn area"
MAX_TITLE_CHARS = 120
MONTH_PATTERN = re.compile(r"[0-9]{4}-(0[1-9]|1[0-2])")  # 'YYYY-MM'; ASCII digits only

# A stored source revision is reused this long without asking the source again.
REVISION_FRESH_SECS = 6 * 60 * 60

log = logging.getLogger("soe")


@dataclass
class PreparedScene:
    """A validated request: the scene id and the request JSON stored with the build job."""

    scene_id: str
    request_json: str


def prepare_scene(db_path: Path | str, registry: Registry, body: bytes | str) -> PreparedScene:
    """Validate a request body and name its scene. Raises AreaError or SourceUnavailable."""
    data = _parse_body(body)
    layers = _requested_layers(data, registry)
    datasets = [registry[layer_id] for layer_id in layers]
    title = _requested_title(data)
    area = resolve_area(db_path, data.get("area"))
    start, end = _requested_period(data, datasets)
    # Planning refuses a bad request before any data is read.
    plan(area, datasets, start, end)

    geometry_id, area_spec = _area_identity(area)
    revisions = _current_revisions(db_path, datasets, end)
    scene_id = compute_scene_id(geometry_id, layers, start, end, datasets, revisions)
    request = {
        "area": area_spec,
        "layers": layers,
        "start": start,
        "end": end,
        "title": title or (area.boundary["name"] if area.named else DRAWN_AREA_TITLE),
    }
    return PreparedScene(scene_id, json.dumps(request))


def _parse_body(body: bytes | str) -> JsonObject:
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        raise AreaError("body must be JSON")
    if not isinstance(data, dict):
        raise AreaError("body must be a JSON object")

    return data


def _requested_layers(data: JsonObject, registry: Registry) -> list[str]:
    layers = data.get("layers", list(registry))
    valid = (
        isinstance(layers, list)
        and layers
        and all(isinstance(layer_id, str) and layer_id in registry for layer_id in layers)
    )
    if not valid:
        raise AreaError("layers must be a non-empty list of: " + ", ".join(registry))

    return sorted(set(layers))


def _requested_title(data: JsonObject) -> str | None:
    title = data.get("title")
    if title is not None and not (isinstance(title, str) and len(title) <= MAX_TITLE_CHARS):
        raise AreaError(f"title must be a string of at most {MAX_TITLE_CHARS} characters")

    return title


def resolve_area(db_path: Path | str, spec: object) -> Area:
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


def _requested_period(data: JsonObject, datasets: list[Dataset]) -> tuple[str, str]:
    series = [dataset for dataset in datasets if isinstance(dataset, SeriesDataset)]
    if not series:
        # Months are irrelevant here, so every terrain-only request is one scene.
        return FIRST_MONTH, FIRST_MONTH

    start, end = data.get("start"), data.get("end")
    for dataset in series:
        check_months(start, end, dataset.first(), dataset.latest(), f"{dataset.title}: ")
    return start, end


def check_months(start: object, end: object, first: str, latest: str, who: str = "") -> None:
    """Validate 'YYYY-MM' start/end: first <= start <= end <= latest; `who` prefixes messages."""
    for month in (start, end):
        if not _is_month(month):
            raise AreaError("start and end must be 'YYYY-MM'")

    if start < first:
        raise AreaError(f"{who}start must be {first} or later")
    if end < start:
        raise AreaError("end must not be before start")
    if end > latest:
        raise AreaError(f"{who}end must be {latest} or earlier")


def _is_month(value: object) -> bool:
    return isinstance(value, str) and MONTH_PATTERN.fullmatch(value) is not None


def _area_identity(area: Area) -> tuple[str, JsonObject]:
    """(id that changes when the geometry does, area spec stored in the job's request)."""
    if area.named:
        boundary = area.boundary
        geometry_hash = hashlib.sha256(boundary["geom_geojson"].encode()).hexdigest()
        return boundary["id"] + ":" + geometry_hash, {"type": "boundary", "id": boundary["id"]}

    geometry_hash = hashlib.sha256(area.geom.wkb).hexdigest()
    return "poly:" + geometry_hash, {"type": "polygon", "geometry": mapping(area.geom)}


def _current_revisions(
    db_path: Path | str,
    datasets: list[Dataset],
    month: str,
) -> dict[str, str | None]:
    """Revision of `month` for each time-varying dataset."""
    return {
        dataset.id: _current_revision(db_path, dataset, month)
        for dataset in datasets
        if dataset.time_varying
    }


def _current_revision(db_path: Path | str, dataset: Dataset, month: str) -> str | None:
    """Stored revision while fresh; if the source is down, a stale stored one."""
    # Offline answers must not reach the stored real ones.
    if isinstance(dataset.backend, SyntheticSource):
        return dataset.current_revision(month)

    stored_revision, age_secs = db.get_revision(db_path, dataset.id, month) or (None, None)
    if stored_revision is not None and age_secs < REVISION_FRESH_SECS:
        return stored_revision

    try:
        revision = dataset.current_revision(month)
    except SourceUnavailable:
        if stored_revision is None:
            raise

        log.warning("%s revision of %s: source down, using stored one", dataset.id, month)
        return stored_revision

    if revision is not None:
        db.set_revision(db_path, dataset.id, month, revision)
    return revision


def compute_scene_id(
    geometry_id: str,
    layers: list[str],
    start: str,
    end: str,
    datasets: list[Dataset],
    revisions: dict[str, str | None],
) -> str:
    """Content hash of the canonical request, dataset versions, revisions and generator.

    The terrain product (GLO-30 or GLO-90) follows from the area's size, so the geometry covers it.
    """
    versions = {dataset.id: dataset.source.get("version") for dataset in datasets}
    synthetic = {dataset.id: isinstance(dataset.backend, SyntheticSource) for dataset in datasets}
    content = [geometry_id, layers, start, end, versions, revisions, synthetic, __version__]
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()[:ID_CHARS]
