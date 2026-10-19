"""Validate scene.json's layer contract and attribution requirements."""
import math
import re
from typing import Any

from .sources import SOURCE_ROLE, STOP_COUNT

JsonObject = dict[str, Any]  # a decoded JSON object, such as scene.json or one of its blocks

MIN_STOPS = 2
STYLE_KINDS = ("field", "categorical", "terrain")
COLOUR_PATTERN = re.compile(r"#[0-9a-fA-F]{6}")


def validate(doc: JsonObject) -> list[str]:
    """Return a list of problems (empty when the bundle is fine)."""
    required = ("version", "id", "area", "period", "layers", "data", "credits", "notices")
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

    problems += _period_problems(doc)
    problems += _attribution_problems(doc)
    for layer in doc["layers"]:
        problems += _layer_problems(layer)
    return problems


def _period_problems(doc: JsonObject) -> list[str]:
    period = doc["period"]
    has_series = any(layer["time_varying"] for layer in doc["layers"])
    if not has_series:
        return [] if period is None else ["period must be null without time-varying layers"]

    if not isinstance(period, dict):
        return ["period must have start before end when a layer is time-varying"]

    start = period.get("start")
    end = period.get("end")
    if not (isinstance(start, str) and isinstance(end, str) and start and start < end):
        return ["period must have start before end when a layer is time-varying"]

    return []


def _attribution_problems(doc: JsonObject) -> list[str]:
    problems = []
    area = doc["area"]
    sources = _layer_sources(doc["layers"])

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
        if source.get("disclaimer_required") and not source.get("disclaimer"):
            problems.append(f"{name}: missing disclaimer")
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
    time_axis_is_consistent = (
        bool(time_axis)
        and bool(time_axis["values"])
        and time_axis["count"] == len(time_axis["values"])
    )

    if layer["time_varying"] and not time_axis_is_consistent:
        problems.append(f"{layer_id}: time axis missing or count does not match values")
    elif layer["time_varying"] and not time_axis["values"][-1] < time_axis.get("end", ""):
        problems.append(f"{layer_id}: time.end must be after the last time value")

    if not layer["time_varying"] and time_axis is not None:
        problems.append(f"{layer_id}: static layer has a time axis")

    return problems + _source_array_problems(layer) + _style_problems(layer_id, layer["style"])


def _source_array_problems(layer: JsonObject) -> list[str]:
    """Return problems with the optional provenance array, which only a layer with a fallback has."""
    block = layer.get("arrays", {}).get(SOURCE_ROLE.name)
    if block is None:
        return []

    layer_id = layer["id"]
    problems = []
    encoding = {
        "path": f"{layer_id}/{SOURCE_ROLE.name}",
        "dtype": SOURCE_ROLE.dtype,
        "scale_factor": SOURCE_ROLE.scale,
        "add_offset": SOURCE_ROLE.offset,
        "fill": SOURCE_ROLE.fill,
    }
    for key, expected in encoding.items():
        if block.get(key) != expected:
            problems.append(f"{layer_id}: arrays.{SOURCE_ROLE.name}.{key} must be {expected!r}")

    if not layer["time_varying"]:
        problems.append(f"{layer_id}: a static layer cannot have a {SOURCE_ROLE.name} array")

    if not layer.get("fallback_sources"):
        problems.append(f"{layer_id}: {SOURCE_ROLE.name} array without fallback_sources")
    return problems


def _style_problems(layer_id: str, style: JsonObject) -> list[str]:
    kind = style.get("kind")
    problems = []
    if kind not in STYLE_KINDS:
        problems.append(f"{layer_id}: style.kind must be one of: " + ", ".join(STYLE_KINDS))

    if not _is_name_list(style.get("encodings"), required=True):
        problems.append(f"{layer_id}: style.encodings must be a non-empty list of names")

    if not _is_name_list(style.get("parts", []), required=False):
        problems.append(f"{layer_id}: style.parts must be a list of names")

    if kind == "field":
        if not isinstance(style.get("palette"), str):
            problems.append(f"{layer_id}: style.palette must be a name")

        problems += _stops_problems(layer_id, style.get("stops"))

    if kind == "categorical":
        problems += _classes_problems(layer_id, style.get("classes"))
    return problems


def _is_name_list(names: object, required: bool) -> bool:
    if not isinstance(names, list) or (required and not names):
        return False

    return all(isinstance(name, str) for name in names)


def _stops_problems(layer_id: str, stops: object) -> list[str]:
    if not isinstance(stops, list) or not MIN_STOPS <= len(stops) <= STOP_COUNT:
        return [f"{layer_id}: style.stops must have {MIN_STOPS}-{STOP_COUNT} values"]

    if not all(_is_finite_number(stop) for stop in stops):
        return [f"{layer_id}: style.stops must be finite numbers"]

    if any(high < low for low, high in zip(stops, stops[1:])):
        return [f"{layer_id}: style.stops must not decrease"]

    return []


def _is_finite_number(value: object) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _classes_problems(layer_id: str, classes: object) -> list[str]:
    if not isinstance(classes, list) or not classes:
        return [f"{layer_id}: style.classes must be a non-empty list"]

    values = [entry.get("value") for entry in classes if isinstance(entry, dict)]
    if len(values) != len(classes) or not all(_is_int(value) for value in values):
        return [f"{layer_id}: style.classes need an integer value each"]

    if len(set(values)) != len(values):
        return [f"{layer_id}: style.classes values must be unique"]

    if not all(entry.get("label") and _is_colour(entry.get("color")) for entry in classes):
        return [f"{layer_id}: style.classes need a label and a #rrggbb color each"]

    return []


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_colour(value: object) -> bool:
    return isinstance(value, str) and COLOUR_PATTERN.fullmatch(value) is not None


def _layer_sources(layer_blocks: list[JsonObject]) -> list[JsonObject]:
    """Every layer's main source, each followed by its fallback sources."""
    return [
        source
        for layer in layer_blocks
        for source in [layer["source"], *layer.get("fallback_sources", [])]
    ]
