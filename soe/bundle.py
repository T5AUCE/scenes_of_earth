"""scene.json: build it from a plan and validate it (including attribution rules)."""
from datetime import datetime, timezone
from typing import Any

from . import __version__
from .areas import Area, LayerPlan, Plan
from .sources import SOURCES, Dataset, SyntheticSource

JsonObject = dict[str, Any]  # a decoded JSON object, such as scene.json or one of its blocks

VERSION = "0.2"
TERRAIN_LAYER_ID = "glo90_terrain"

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
    """Assemble scene.json. Layer blocks come from the dataset registry metadata."""
    boundary = _boundary_block(area) if area.named else None
    static_layers_first = sorted(datasets, key=lambda dataset: dataset.time_varying)
    
    layer_blocks = [
        _layer_block(dataset, plan.layers[dataset.id], info[dataset.id])
        for dataset in static_layers_first
    ]

    boundary_source = SOURCES[area.boundary["source"]] if area.named else None
    synthetic = any(isinstance(dataset.backend, SyntheticSource) for dataset in datasets)
    layer_notices = [note for layer in plan.layers.values() for note in layer.notices]

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
        "layers": layer_blocks,
        "data": {
            "href": "data.zarr",
            "format": "zarr v3, gzip, sharded series, consolidated metadata",
        },
        "notices": {"limits": plan.notices + layer_notices},
        "credits": credits(layer_blocks, boundary_source, synthetic),
    }


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
        "source": dict(dataset.source),
        "style": dict(dataset.style),
        "coverage": list(dataset.coverage),
        "grid": grid,
        "mask": {
            "path": f"{dataset.id}/mask",
            "rule": "cell centre inside",
            "cells_inside": layer_plan.cells_inside,
        },
        "time": None,
        "arrays": _array_blocks(dataset),
    }

    if dataset.time_varying:
        grid["aggregation"] = layer_plan.factor
        layer["style"]["domain"] = result["domain"]
        layer["time"] = {
            "step": dataset.step,
            "count": len(layer_plan.steps),
            "path": f"{dataset.id}/time",
            "values": layer_plan.steps,
        }
        layer["stats"] = result["stats"]
    return layer


def _array_blocks(dataset: Dataset) -> dict[str, JsonObject]:
    blocks = {}
    for role, name in dataset.arrays.items():
        dtype, scale_factor, add_offset, fill = dataset.encoding[role]
        blocks[role] = {
            "path": f"{dataset.id}/{name}",
            "dtype": dtype,
            "scale_factor": scale_factor,
            "add_offset": add_offset,
            "fill": fill,
        }
    return blocks


def credits(
    layer_blocks: list[JsonObject],
    boundary_source: dict[str, str] | None,
    synthetic: bool = False,
) -> JsonObject:
    """Attribution block, generated from the sources actually used."""
    sources = [layer["source"] for layer in layer_blocks]
    if boundary_source:
        sources.append(boundary_source)

    lines = [source["attribution"] for source in sources]
    if synthetic:
        lines.append(SYNTHETIC_DATA_CREDIT)

    return {
        "lines": lines,
        "disclaimers": [source["disclaimer"] for source in sources if source.get("disclaimer")],
        "endorsement": "Scenes of Earth is not endorsed by the data providers.",
        "terms_passthrough": (
            "Reuse of this bundle's data is subject to each source's licence "
            "listed in layers[].source and area.boundary."
        ),
    }


def validate(doc: JsonObject) -> list[str]:
    """Return a list of problems (empty when the bundle is fine)."""
    required = ("version", "id", "area", "layers", "data", "credits", "notices")
    missing = [f"missing {key}" for key in required if key not in doc]
    if missing:
        return missing

    problems = []
    if not doc["layers"]:
        problems.append("no layers")

    area = doc["area"]
    west, south, east, north = area["bbox"]
    if not (west < east and south < north):
        problems.append("bbox is not W < E and S < N")

    problems += _attribution_problems(doc)
    for layer in doc["layers"]:
        problems += _layer_problems(layer)
    return problems


def _attribution_problems(doc: JsonObject) -> list[str]:
    problems = []
    area = doc["area"]
    sources = [layer["source"] for layer in doc["layers"]]

    if area["type"] == "boundary":
        if area.get("boundary"):
            sources.append(area["boundary"])
        else:
            problems.append("boundary area without boundary block")

    lines = doc["credits"].get("lines", [])
    disclaimers = doc["credits"].get("disclaimers", [])

    for source in sources:
        name = source.get("name") or source.get("source", "?")
        for key in ("licence", "attribution"):
            if not source.get(key):
                problems.append(f"{name}: missing {key}")
        if source.get("attribution") and source["attribution"] not in lines:
            problems.append(f"{name}: attribution not in credits.lines")
        if source.get("disclaimer") and source["disclaimer"] not in disclaimers:
            problems.append(f"{name}: disclaimer not in credits.disclaimers")
    return problems


def _layer_problems(layer: JsonObject) -> list[str]:
    layer_id = layer["id"]
    problems = [
        f"{layer_id}: missing {key}"
        for key in ("grid", "mask", "arrays")
        if not layer.get(key)
    ]
    
    if layer.get("mask") and layer["mask"]["cells_inside"] < 1:
        problems.append(f"{layer_id}: mask has no cells")

    time_axis = layer.get("time")
    time_axis_is_consistent = bool(time_axis) and time_axis["count"] == len(time_axis["values"])

    if layer["time_varying"] and not time_axis_is_consistent:
        problems.append(f"{layer_id}: time axis missing or count does not match values")

    if not layer["time_varying"] and time_axis is not None:
        problems.append(f"{layer_id}: static layer has a time axis")

    if layer_id == TERRAIN_LAYER_ID and not layer["source"].get("disclaimer"):
        problems.append(f"{TERRAIN_LAYER_ID}: missing disclaimer")
    return problems
