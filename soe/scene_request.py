"""Validate scene requests and assign content-addressed scene IDs.

A revision is a marker that changes whenever the provider republishes data of the requested
periods. For CHIRPS, the remote component is the Last-Modified date of the last requested month
and is cached. The local component uses the on-disk monthly markers and is read fresh for each
preparation. Both components contribute to scene identity so revised data gets a new scene.
"""
import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path

from shapely.geometry import mapping, shape

from . import __version__, db
from .areas import Area, AreaError, clean_polygon
from .bundle import VERSION, JsonObject
from .plan import Plan, plan
from .sources import (
    REQUEST_FORMATS,
    REQUEST_STEP,
    Dataset,
    Registry,
    SeriesDataset,
    SourceUnavailable,
    add_duration,
    is_request_label,
    request_label,
)

DEFAULT_LAYERS = ["chirps_monthly", "terrain"]  # what a request without layers builds
ID_CHARS = 20  # hex characters of the sha256 kept as the id (80 bits; short Windows paths)

DRAWN_AREA_TITLE = "Drawn area"
MAX_TITLE_CHARS = 120

REVISION_FRESH_SECS = 6 * 60 * 60  # reuse a revision without another source probe

log = logging.getLogger("soe")


@dataclass
class PreparedScene:
    """A validated request with its scene id and the request JSON stored with the build job."""

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
    scene_plan = plan(area, datasets, start, end)

    geometry_id, area_spec = _area_identity(area)
    revisions = _current_revisions(db_path, datasets, scene_plan)
    scene_id = compute_scene_id(
        geometry_id,
        layers,
        scene_plan.period,
        datasets,
        revisions,
    )
    request = {
        "area": area_spec,
        "layers": layers,
        "start": start,
        "end": end,
        "local_revisions": {layer_id: local for layer_id, (_, local) in revisions.items()},
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
    layers = data.get("layers", default_layers(registry))
    valid = (
        isinstance(layers, list)
        and layers
        and all(isinstance(layer_id, str) and layer_id in registry for layer_id in layers)
    )
    if not valid:
        raise AreaError("layers must be a non-empty list of: " + ", ".join(registry))

    return sorted(set(layers))


def default_layers(registry: Registry) -> list[str]:
    """The layers of DEFAULT_LAYERS that the registry has."""
    return [layer_id for layer_id in DEFAULT_LAYERS if layer_id in registry]


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


def _requested_period(data: JsonObject, datasets: list[Dataset]) -> tuple[str | None, str | None]:
    series = [dataset for dataset in datasets if isinstance(dataset, SeriesDataset)]
    if not series:
        # Periods are irrelevant here, so every terrain-only request is one scene.
        return None, None

    start, end = data.get("start"), data.get("end")
    for dataset in series:
        check_period(start, end, dataset, f"{dataset.title}: ")
    return start, end


def check_period(start: object, end: object, dataset: SeriesDataset, who: str = "") -> None:
    """Validate that the request's first and last months are ordered and available.

    `who` prefixes the messages.
    """
    for label in (start, end):
        if not is_request_label(label, REQUEST_STEP):
            raise AreaError(f"start and end must be '{REQUEST_FORMATS[REQUEST_STEP]}'")

    first, last = request_bounds(dataset)
    if start < first:
        raise AreaError(f"{who}start must be {first} or later")
    if end < start:
        raise AreaError("end must not be before start")
    if end > last:
        raise AreaError(f"{who}end must be {last} or earlier")


def request_bounds(dataset: SeriesDataset) -> tuple[str, str]:
    """First and last request period ('YYYY-MM') a request may name for the dataset."""
    first = request_label(dataset.first(), REQUEST_STEP)
    last_start = add_duration(dataset.period_end(dataset.latest()), REQUEST_STEP, -1)
    return first, request_label(last_start, REQUEST_STEP)


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
    scene_plan: Plan,
) -> dict[str, tuple[str | None, str | None]]:
    """Return the (remote, local) revision of the planned periods of each time-varying dataset."""
    revisions = {}
    for dataset in datasets:
        if dataset.time_varying:
            steps = scene_plan.layers[dataset.id].steps
            revisions[dataset.id] = (
                _remote_revision(db_path, dataset, steps),
                dataset.local_revision(steps),
            )
    return revisions


def _remote_revision(db_path: Path | str, dataset: Dataset, steps: list[str]) -> str | None:
    """Return the stored remote revision while it is fresh, or a stale one if the source is down."""
    # Offline answers must not reach the stored real ones; a dataset without a remote part is cheap.
    if dataset.synthetic or not dataset.remote:
        return dataset.remote_revision(steps)

    # The suffix keeps this apart from the combined digests that older versions stored here.
    cache_key = f"{dataset.id}:remote"
    period = f"{steps[0]}/{steps[-1]}"
    stored_revision, age_secs = db.get_revision(db_path, cache_key, period) or (None, None)
    if stored_revision is not None and age_secs < REVISION_FRESH_SECS:
        return stored_revision

    try:
        revision = dataset.remote_revision(steps)
    except SourceUnavailable:
        if stored_revision is None:
            raise

        log.warning("%s revision of %s: source down, using stored one", dataset.id, period)
        return stored_revision

    if revision is not None:
        db.set_revision(db_path, cache_key, period, revision)
    return revision


def compute_scene_id(
    geometry_id: str,
    layers: list[str],
    period: tuple[str, str] | None,
    datasets: list[Dataset],
    revisions: dict[str, tuple[str | None, str | None]],
) -> str:
    """Hash the canonical request with source identities and generator and bundle versions.

    The versions are those of each dataset's main source and its fallback source.

    The terrain product (GLO-30 or GLO-90) follows from the area's size, so the geometry covers it.
    A layer drawn from tiles hashes the tile URL, so switching to another copy renames its scenes.
    `period` is the ISO date range [first day, day after the last), or None without series, so
    the id does not depend on how the request spelled its start and end.
    """
    versions = {dataset.id: _source_versions(dataset) for dataset in datasets}
    synthetic = {dataset.id: dataset.synthetic for dataset in datasets}
    dated_period = [*period, REQUEST_STEP] if period else None
    tile_urls = {dataset.id: dataset.tiles["url"] for dataset in datasets if dataset.tiles}
    content = [
        geometry_id,
        layers,
        dated_period,
        versions,
        revisions,
        synthetic,
        tile_urls,
        __version__,
        VERSION,
    ]
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()[:ID_CHARS]


def _source_versions(dataset: Dataset) -> list[str | None]:
    """Return the main and fallback versions, using None for an unconfigured fallback."""
    fallback_version = dataset.fallback.source.get("version") if dataset.fallback else None
    return [dataset.source.get("version"), fallback_version]
