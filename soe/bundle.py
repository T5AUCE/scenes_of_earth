"""Assemble scene.json from a plan and expose its contract validator."""

from . import __version__
from .areas import Area

# Existing importers must keep using bundle.validate and its contract names.
from .bundle_validation import (
    COLOUR_PATTERN,
    MASK_RULE,
    MIN_STOPS,
    STYLE_KINDS,
    JsonObject,
    _layer_sources,
    validate,
)
from .land import border_min_zoom
from .plan import LayerPlan, Plan
from .sources import REQUEST_STEP, SOURCE_ROLE, SOURCES, STOP_COUNT, Dataset

__all__ = ["COLOUR_PATTERN", "MIN_STOPS", "STOP_COUNT", "STYLE_KINDS", "validate"]

VERSION = "0.8"

BOUNDARY_SOURCE_FIELDS = ("licence_url", "attribution", "citation", "modified")
LAND_SOURCE = "osm_land"  # key in SOURCES of the land polygons that cut areas are made from
LAND_LICENCE = "ODbL 1.0"
LAND_CUT_NOTE = "intersected with OpenStreetMap land polygons"
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
    land_source = _land_block(area) if area.land_version else None
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
        "area": {
            "type": "boundary" if area.named else "polygon",
            "boundary": boundary,
            "crs": "EPSG:4326",
            "bbox": plan.bbox,
            "geometry_href": "area.geojson",
            "clipped_to_coverage": plan.clipped,
            **_land_fields(area, land_source),
        },
        "period": _period_block(plan),
        "layers": layer_blocks,
        "data": {
            "href": "data.zarr",
            "format": "zarr v3, gzip, sharded series, consolidated metadata",
        },
        "notices": {"limits": plan.notices + layer_notices},
        "credits": credits(layer_blocks, boundary_source, synthetic, land_source),
    }


def _period_block(plan: Plan) -> JsonObject | None:
    """Return the requested period as ISO dates with an exclusive end, or None without series."""
    if plan.period is None:
        return None

    start, end = plan.period
    return {"start": start, "end": end, "step": REQUEST_STEP}


def _land_block(area: Area) -> JsonObject:
    """The land polygon source with the version that the area was cut to."""
    return {**SOURCES[LAND_SOURCE], "version": area.land_version}


def _land_fields(area: Area, land_source: JsonObject | None) -> JsonObject:
    """The area fields of a scene cut to land, with the borders and their basemap switch zoom."""
    if land_source is None:
        return {}

    level = area.boundary.get("border_level") if area.named else None
    return {
        "borders_href": "borders.geojson",
        "border_level": level,
        "border_min_zoom": border_min_zoom(level),
        "land": land_source,
    }


def _boundary_block(area: Area) -> JsonObject:
    row = area.boundary
    source = SOURCES[row["source"]]
    block = {
        "id": row["id"],
        "name": row["name"],
        "name_local": row.get("name_local"),
        "parent_name_local": row.get("parent_name_local"),
        "level": row["level"],
        "iso3": row["iso3"],
        "source": row["source"],
        "version": source.get("version"),
        "licence": row["licence"],
    }
    block.update({key: source[key] for key in BOUNDARY_SOURCE_FIELDS if key in source})
    if area.land_version:
        if LAND_LICENCE not in row["licence"]:
            block["licence"] = f"{row['licence']} + {LAND_LICENCE}"
        if "modified" in block:
            block["modified"] += f"; {LAND_CUT_NOTE}"

    return block


def _layer_block(dataset: Dataset, layer_plan: LayerPlan, result: JsonObject) -> JsonObject:
    """One layer of scene.json, from the dataset metadata, its plan and its build result."""
    grid = {
        "crs": "EPSG:4326",
        "bbox": layer_plan.bbox,
        "res": layer_plan.res,
        "nx": layer_plan.shape[1],
        "ny": layer_plan.shape[0],
    }
    sources = layer_plan.sources
    if "used_sources" in result:
        sources = result["used_sources"] or layer_plan.sources[:1]

    layer = {
        "id": dataset.id,
        "title": dataset.title,
        "units": dataset.units,
        "time_varying": dataset.time_varying,
        "source": dict(sources[0]),
        "style": dict(dataset.style),
        "coverage": list(layer_plan.coverage),
        "grid": grid,
        "mask": {
            "path": f"{dataset.id}/mask",
            "rule": MASK_RULE,
            "cells_inside": layer_plan.cells_inside,
        },
        "time": None,
        "arrays": _array_blocks(dataset, result),
    }

    fallback_sources = sources[1:]
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

    if "area_series" in result:
        layer["area_series"] = result["area_series"]

    if "distribution" in result:
        layer["distribution"] = result["distribution"]

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
    land_source: JsonObject | None = None,
) -> JsonObject:
    """Generate attribution for the sources actually used and any synthetic data."""
    sources = _layer_sources(layer_blocks)
    if boundary_source:
        sources.append(boundary_source)
    if land_source:
        sources.append(land_source)

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
