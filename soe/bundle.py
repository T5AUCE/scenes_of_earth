"""Assemble scene.json from a plan and expose its contract validator."""
from datetime import datetime, timezone

from . import __version__
from .areas import Area
# Existing importers must keep using bundle.validate and its contract names.
from .bundle_validation import (
    COLOUR_PATTERN,
    MIN_STOPS,
    STYLE_KINDS,
    JsonObject,
    _layer_sources,
    validate,
)
from .plan import LayerPlan, Plan
from .sources import REQUEST_STEP, SOURCE_ROLE, SOURCES, STOP_COUNT, Dataset

VERSION = "0.5"

BOUNDARY_SOURCE_FIELDS = ("licence_url", "attribution", "citation", "modified")
SYNTHETIC_DATA_CREDIT = "Data: synthetically generated, not real measurements"


def make(
    scene_id: str,
    title: str,
    area: Area,
    plan: Plan,
    datasets: list[Dataset],
    info: dict[str, JsonObject],
) -> JsonObject:
    """Assemble scene.json from the plan, dataset metadata and per-layer build results."""
    boundary = _boundary_block(area) if area.named else None
    static_layers_first = sorted(datasets, key=lambda dataset: dataset.time_varying)
    
    layer_blocks = [
        _layer_block(dataset, plan.layers[dataset.id], info[dataset.id])
        for dataset in static_layers_first
    ]

    boundary_source = SOURCES[area.boundary["source"]] if area.named else None
    synthetic = any(dataset.synthetic for dataset in datasets)
    layer_notices = [
        note
        for dataset in datasets
        for note in plan.layers[dataset.id].notices + info[dataset.id].get("notices", [])
    ]

    return {
        "version": VERSION,
        "id": scene_id,
        "title": title,
        "generator": {"name": "soe", "version": __version__},
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "area": {
            "type": "boundary" if area.named else "polygon",
            "boundary": boundary,
            "crs": "EPSG:4326",
            "bbox": plan.bbox,
            "geometry_href": "area.geojson",
            "clipped_to_coverage": plan.clipped,
        },
        "period": _period_block(plan),
        "layers": layer_blocks,
        "data": {
            "href": "data.zarr",
            "format": "zarr v3, gzip, sharded series, consolidated metadata",
        },
        "notices": {"limits": plan.notices + layer_notices},
        "credits": credits(layer_blocks, boundary_source, synthetic),
    }


def _period_block(plan: Plan) -> JsonObject | None:
    """Return the requested period as ISO dates with an exclusive end, or None without series."""
    if plan.period is None:
        return None

    start, end = plan.period
    return {"start": start, "end": end, "step": REQUEST_STEP}


def _boundary_block(area: Area) -> JsonObject:
    row = area.boundary
    block = {
        "id": row["id"],
        "name": row["name"],
        "level": row["level"],
        "iso3": row["iso3"],
        "source": row["source"],
        "licence": row["licence"],
    }
    source = SOURCES[row["source"]]
    block.update({key: source[key] for key in BOUNDARY_SOURCE_FIELDS if key in source})
    return block


def _layer_block(dataset: Dataset, layer_plan: LayerPlan, result: JsonObject) -> JsonObject:
    """One layer of scene.json, from the dataset metadata, its plan and its build result."""
    grid = {
        "crs": "EPSG:4326",
        "bbox": layer_plan.bbox,
        "res": round(layer_plan.res, 8),
        "nx": layer_plan.shape[1],
        "ny": layer_plan.shape[0],
    }
    layer = {
        "id": dataset.id,
        "title": dataset.title,
        "units": dataset.units,
        "time_varying": dataset.time_varying,
        "source": dict(layer_plan.sources[0]),
        "style": dict(dataset.style),
        "coverage": list(dataset.coverage),
        "grid": grid,
        "mask": {
            "path": f"{dataset.id}/mask",
            "rule": "touched by the area",
            "cells_inside": layer_plan.cells_inside,
        },
        "time": None,
        "arrays": _array_blocks(dataset, result),
    }

    fallback_sources = layer_plan.sources[1:]
    if result.get("fallback_used"):
        fallback_sources = [*fallback_sources, dataset.fallback.source]
    if fallback_sources:
        layer["fallback_sources"] = [dict(source) for source in fallback_sources]

    if dataset.time_varying:
        grid["aggregation"] = layer_plan.factor
        layer["style"]["stops"] = result["stops"]
        layer["time"] = {
            "step": dataset.step,
            "end": dataset.period_end(layer_plan.steps[-1]),
            "method": dataset.cell_method,
            "count": len(layer_plan.steps),
            "path": f"{dataset.id}/time",
            "values": layer_plan.steps,
        }

    if "stats" in result:
        layer["stats"] = result["stats"]
    if dataset.tiles:
        layer["tiles"] = dict(dataset.tiles)
    return layer


def _array_blocks(dataset: Dataset, result: JsonObject) -> dict[str, JsonObject]:
    roles = dict(dataset.roles)
    if result.get("fallback_used"):
        roles[SOURCE_ROLE.name] = SOURCE_ROLE

    return {
        role: {
            "path": f"{dataset.id}/{spec.name}",
            "dtype": spec.dtype,
            "scale_factor": spec.scale,
            "add_offset": spec.offset,
            "fill": spec.fill,
        }
        for role, spec in roles.items()
    }


def credits(
    layer_blocks: list[JsonObject],
    boundary_source: dict[str, str] | None,
    synthetic: bool = False,
) -> JsonObject:
    """Generate attribution for the sources actually used and any synthetic data."""
    sources = _layer_sources(layer_blocks)
    if boundary_source:
        sources.append(boundary_source)

    lines = list(dict.fromkeys(source["attribution"] for source in sources))
    if synthetic:
        lines.append(SYNTHETIC_DATA_CREDIT)

    disclaimers = (source["disclaimer"] for source in sources if source.get("disclaimer"))
    return {
        "lines": lines,
        "disclaimers": list(dict.fromkeys(disclaimers)),
        "endorsement": "Scenes of Earth is not endorsed by the data providers.",
        "terms_passthrough": (
            "Reuse of this bundle's data is subject to each source's licence "
            "listed in layers[].source, layers[].fallback_sources, layers[].tiles.source "
            "and area.boundary."
        ),
    }
