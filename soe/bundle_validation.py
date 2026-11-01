"""Validate scene.json's layer contract and attribution requirements."""
import math
import re
from typing import Any

from . import __version__
from .sources import SOURCE_ROLE, STOP_COUNT

JsonObject = dict[str, Any]  # a decoded JSON object, such as scene.json or one of its blocks

MIN_STOPS = 2
STYLE_KINDS = ("field", "categorical", "terrain")
COLOUR_PATTERN = re.compile(r"#[0-9a-fA-F]{6}")

MASK_RULE = "1 = area cell, 2 = one-cell ring of real values"

# The web duplicates these names in render/colormap.ts CLASS_PALETTES.
CLASS_PALETTES = ("painted",)

TILE_URL_PARTS = ("{z}", "{x}", "{y}")
TILE_ENCODINGS = ("terrarium",)
TERRAIN_STATS = (
    "min",
    "max",
    "mean",
    "p2",
    "p98",
    "slope_p50_deg",
    "slope_p90_deg",
    "cell_m",
)

AREA_SERIES_STATISTIC = "mean"
AREA_WEIGHTS_NAME = "cell_area_inside_outline"

DISTRIBUTION_STATISTIC = "quantiles"
DISTRIBUTION_PERCENT = 1
DISTRIBUTION_VALUE_COUNT = 101

FRACTION_TOLERANCE = 1e-12  # summation order may nudge an exact share slightly above one


def validate(doc: JsonObject, expected_version: str = "0.7") -> list[str]:
    """Return a list of problems (empty when the bundle is fine)."""
    if not isinstance(doc, dict):
        return ["scene must be an object"]
    required = ("version", "id", "area", "period", "layers", "data", "credits", "notices")
    missing = [f"missing {key}" for key in required if key not in doc]
    if missing:
        return missing

    problems = []
    if doc["version"] != expected_version:
        problems.append(f"version must be {expected_version}")
    layers = doc.get("layers")
    if not isinstance(layers, list):
        return [*problems, "layers must be a list"]
    if not layers:
        problems.append("no layers")

    problems += _generator_problems(doc.get("generator"))
    problems += _area_problems(doc.get("area"))
    problems += _period_problems(doc)
    problems += _attribution_problems(doc)
    for layer in layers:
        problems += _layer_problems(layer)
    return problems


def _generator_problems(generator: object) -> list[str]:
    """Return problems with the generator block, which must name the current build."""
    if not isinstance(generator, dict):
        return ["generator must be an object"]
    problems = []
    if generator.get("name") != "soe":
        problems.append("generator name must be soe")
    if generator.get("version") != __version__:
        problems.append(f"generator version must be {__version__}")
    return problems


def _area_problems(area: object) -> list[str]:
    """Return problems with the scene area block without raising on malformed types."""
    if not isinstance(area, dict):
        return ["area must be an object"]
    bbox = area.get("bbox")
    if (
        not isinstance(bbox, list)
        or len(bbox) != 4
        or not all(_is_finite_number(value) for value in bbox)
    ):
        return ["bbox must be four finite numbers"]
    west, south, east, north = bbox
    if not (west < east and south < north):
        return ["bbox is not W < E and S < N"]
    return []


def _period_problems(doc: JsonObject) -> list[str]:
    period = doc.get("period")
    layers = doc.get("layers")
    if not isinstance(layers, list):
        return []
    has_series = any(
        isinstance(layer, dict) and layer.get("time_varying") is True for layer in layers
    )
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
    area = doc.get("area")
    layers = doc.get("layers")
    credits = doc.get("credits")
    if not isinstance(credits, dict):
        return ["credits must be an object"]
    if isinstance(area, dict) and isinstance(layers, list):
        valid_layers = [layer for layer in layers if isinstance(layer, dict)]
        sources = _layer_sources(valid_layers)
        if area.get("type") == "boundary":
            if area.get("boundary"):
                sources.append(area["boundary"])
            else:
                problems.append("boundary area without boundary block")

        lines = credits.get("lines", [])
        disclaimers = credits.get("disclaimers", [])
        if not isinstance(lines, list) or not isinstance(disclaimers, list):
            problems.append("credits.lines and credits.disclaimers must be lists")
        else:
            for source in sources:
                if not isinstance(source, dict):
                    problems.append("a layer source must be an object")
                    continue
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

    terms = credits.get("terms_passthrough")
    if not isinstance(terms, str) or not terms:
        problems.append("credits.terms_passthrough must be a non-empty string")
    endorsement = credits.get("endorsement")
    if not isinstance(endorsement, str) or not endorsement:
        problems.append("credits.endorsement must be a non-empty string")
    return problems


def _layer_problems(layer: object) -> list[str]:
    if not isinstance(layer, dict):
        return ["layer must be an object"]
    raw_id = layer.get("id")
    layer_id = raw_id if isinstance(raw_id, str) and raw_id else "?"
    problems = []
    if not isinstance(raw_id, str) or not raw_id:
        problems.append("layer id must be a non-empty string")
    if not isinstance(layer.get("time_varying"), bool):
        problems.append(f"{layer_id}: time_varying must be a boolean")
    if not isinstance(layer.get("style"), dict):
        problems.append(f"{layer_id}: style must be an object")
    if not isinstance(layer.get("source"), dict):
        problems.append(f"{layer_id}: source must be an object")
    for key in ("grid", "mask"):
        if not layer.get(key):
            problems.append(f"{layer_id}: missing {key}")
    if not isinstance(layer.get("arrays"), dict):
        problems.append(f"{layer_id}: arrays must be an object")
    elif not layer["arrays"] and not layer.get("tiles"):
        problems.append(f"{layer_id}: missing arrays")

    problems += _grid_problems(layer_id, layer.get("grid"))
    problems += _reserved_problems(layer_id, layer)
    problems += _mask_problems(layer_id, layer.get("mask"))
    problems += _time_problems(layer_id, layer)
    problems += _source_array_problems(layer)
    style = layer.get("style")
    if isinstance(style, dict):
        problems += _style_problems(layer_id, style)
    problems += _terrain_problems(layer)
    problems += _tiles_problems(layer_id, layer.get("tiles"))
    problems += _fallback_sources_problems(layer_id, layer)
    problems += _area_series_problems(layer_id, layer)
    problems += _distribution_problems(layer_id, layer)
    return problems


def _grid_problems(layer_id: str, grid: object) -> list[str]:
    """Return problems with the stored analysis grid, whose resolution stays unrounded."""
    if not grid:
        return []
    if not isinstance(grid, dict):
        return [f"{layer_id}: grid must be an object"]
    resolution = grid.get("res")
    if not _is_finite_number(resolution) or resolution <= 0:
        return [f"{layer_id}: grid.res must be a positive finite number"]
    return []


def _reserved_problems(layer_id: str, layer: JsonObject) -> list[str]:
    """Return problems with blocks that v1 reserves for later, never accepts."""
    if "categorical_shares" in layer:
        return [f"{layer_id}: categorical_shares is reserved and must be omitted"]
    return []


def _mask_problems(layer_id: str, mask: object) -> list[str]:
    if not isinstance(mask, dict):
        return [f"{layer_id}: mask must be an object"]

    problems = []
    for key, expected in (("path", f"{layer_id}/mask"), ("rule", MASK_RULE)):
        if mask.get(key) != expected:
            problems.append(f"{layer_id}: mask.{key} must be {expected!r}")
    cells_inside = mask.get("cells_inside")
    if not _is_int(cells_inside) or cells_inside < 1:
        problems.append(f"{layer_id}: mask.cells_inside must be an integer >= 1")
    return problems


def _time_problems(layer_id: str, layer: JsonObject) -> list[str]:
    """Return problems with the time axis, checking its shape before indexing it."""
    time_varying = layer.get("time_varying")
    time_axis = layer.get("time")
    if time_axis is None:
        if time_varying is True:
            return [f"{layer_id}: time axis missing or count does not match values"]
        return []
    if not isinstance(time_axis, dict):
        return [f"{layer_id}: time axis missing or count does not match values"]
    values = time_axis.get("values")
    count = time_axis.get("count")
    end = time_axis.get("end")
    consistent = (
        isinstance(values, list)
        and values
        and _is_int(count)
        and count == len(values)
        and all(isinstance(value, str) for value in values)
    )
    if time_varying is True and not consistent:
        return [f"{layer_id}: time axis missing or count does not match values"]
    if time_varying is True and consistent:
        if not isinstance(end, str) or not values[-1] < end:
            return [f"{layer_id}: time.end must be after the last time value"]
    if time_varying is False:
        return [f"{layer_id}: static layer has a time axis"]
    return []


def _source_array_problems(layer: JsonObject) -> list[str]:
    """Return problems with the optional provenance array of a layer with a fallback."""
    arrays = layer.get("arrays")
    if not isinstance(arrays, dict):
        return []

    block = arrays.get(SOURCE_ROLE.name)
    if block is None:
        return []

    layer_id = layer.get("id") if isinstance(layer.get("id"), str) else "?"
    problems = []
    encoding = {
        "path": f"{layer_id}/{SOURCE_ROLE.name}",
        "dtype": SOURCE_ROLE.dtype,
        "scale_factor": SOURCE_ROLE.scale,
        "add_offset": SOURCE_ROLE.offset,
        "fill": SOURCE_ROLE.fill,
    }
    if not isinstance(block, dict):
        return [f"{layer_id}: arrays.{SOURCE_ROLE.name} must be an object"]
    for key, expected in encoding.items():
        if block.get(key) != expected:
            problems.append(f"{layer_id}: arrays.{SOURCE_ROLE.name}.{key} must be {expected!r}")

    if not layer.get("time_varying"):
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
        if "palette" in style and style["palette"] not in CLASS_PALETTES:
            problems.append(
                f"{layer_id}: style.palette must be omitted or one of: "
                + ", ".join(CLASS_PALETTES),
            )
        problems += _classes_problems(layer_id, style.get("classes"))
    return problems


def _terrain_problems(layer: JsonObject) -> list[str]:
    """Check the metadata the viewer needs to draw terrain without bundled arrays."""
    style = layer.get("style")
    if not isinstance(style, dict) or style.get("kind") != "terrain":
        return []

    layer_id = layer.get("id") if isinstance(layer.get("id"), str) else "?"
    problems = []
    if layer.get("time_varying") is True:
        problems.append(f"{layer_id}: terrain layer must be static")
    if not layer.get("tiles"):
        problems.append(f"{layer_id}: a terrain layer needs tiles")

    stats = layer.get("stats") or {}
    if not isinstance(stats, dict):
        return [*problems, f"{layer_id}: stats must be an object"]

    missing = [key for key in TERRAIN_STATS if not _is_finite_number(stats.get(key))]
    if missing:
        problems.append(f"{layer_id}: stats need numbers for " + ", ".join(missing))
    distribution = layer.get("distribution")
    if (
        isinstance(distribution, dict)
        and not missing
        and isinstance(distribution.get("values"), list)
        and len(distribution["values"]) == DISTRIBUTION_VALUE_COUNT
        and all(_is_finite_number(value) for value in distribution["values"])
        and _is_finite_number(distribution.get("min"))
        and _is_finite_number(distribution.get("max"))
        and _is_finite_number(distribution.get("mean"))
    ):
        problems += _mirrored_stats_problems(layer_id, stats, distribution)
    return problems


def _mirrored_stats_problems(
    layer_id: str,
    stats: JsonObject,
    distribution: JsonObject,
) -> list[str]:
    """Return problems when terrain stats do not reuse the distribution result."""
    values = distribution["values"]
    pairs = [
        ("min", distribution["min"]),
        ("max", distribution["max"]),
        ("mean", distribution["mean"]),
        ("p2", values[2]),
        ("p98", values[98]),
    ]
    return [
        f"{layer_id}: stats.{key} must equal the distribution result"
        for key, expected in pairs
        if stats.get(key) != expected
    ]


def _tiles_problems(layer_id: str, tiles: object) -> list[str]:
    if tiles is None:
        return []

    if not isinstance(tiles, dict):
        return [f"{layer_id}: tiles must be an object"]

    problems = []
    url = tiles.get("url")
    if not isinstance(url, str) or not all(part in url for part in TILE_URL_PARTS):
        problems.append(f"{layer_id}: tiles.url must contain " + ", ".join(TILE_URL_PARTS))

    if tiles.get("encoding") not in TILE_ENCODINGS:
        problems.append(f"{layer_id}: tiles.encoding must be one of: " + ", ".join(TILE_ENCODINGS))

    for key in ("tile_size", "maxzoom"):
        if not _is_int(tiles.get(key)):
            problems.append(f"{layer_id}: tiles.{key} must be an integer")
        elif tiles[key] < (1 if key == "tile_size" else 0):
            problems.append(f"{layer_id}: tiles.{key} is out of range")

    source = tiles.get("source")
    if not isinstance(source, dict) or not source.get("licence") or not source.get("attribution"):
        problems.append(f"{layer_id}: tiles.source needs a licence and an attribution")
    return problems


def _fallback_sources_problems(layer_id: str, layer: JsonObject) -> list[str]:
    """Return problems when a present fallback container is not a list."""
    if "fallback_sources" in layer and not isinstance(layer.get("fallback_sources"), list):
        return [f"{layer_id}: fallback_sources must be a list"]
    return []


def _area_series_problems(layer_id: str, layer: JsonObject) -> list[str]:
    """Return problems with the per-step area means, enforcing v1 applicability."""
    has_series = "area_series" in layer
    block = layer.get("area_series")
    time_varying = layer.get("time_varying")
    style = layer.get("style")
    kind = style.get("kind") if isinstance(style, dict) else None
    if kind == "terrain" and time_varying is True:
        return [f"{layer_id}: terrain layer must be static"]
    if time_varying is not True:
        if not has_series:
            return []
        return [f"{layer_id}: static layer must not have area_series"]
    if kind == "categorical":
        if not has_series:
            return []
        return [f"{layer_id}: categorical layer must not have area_series"]
    if kind != "field":
        if not has_series:
            return []
        return [f"{layer_id}: only continuous time-varying layers have area_series"]
    if not has_series:
        return [f"{layer_id}: time-varying field layer needs area_series"]
    if not isinstance(block, dict):
        return [f"{layer_id}: area_series must be an object"]
    if "path" in block:
        return [f"{layer_id}: area_series.path is reserved and must be omitted"]
    if "categorical_shares" in block:
        return [f"{layer_id}: categorical_shares is reserved and must be omitted"]

    problems = []
    if block.get("statistic") != AREA_SERIES_STATISTIC:
        problems.append(
            f"{layer_id}: area_series.statistic must be {AREA_SERIES_STATISTIC}",
        )
    if block.get("weights") != AREA_WEIGHTS_NAME:
        problems.append(
            f"{layer_id}: area_series.weights must be {AREA_WEIGHTS_NAME}",
        )
    values = block.get("values")
    valid = block.get("valid_fraction")
    has_fallback = "fallback_fraction" in block
    fallback = block.get("fallback_fraction")
    if not isinstance(values, list) or not isinstance(valid, list):
        return [*problems, f"{layer_id}: area_series.values and valid_fraction must be lists"]
    if has_fallback and not isinstance(fallback, list):
        return [*problems, f"{layer_id}: area_series.fallback_fraction must be a list"]

    count = _series_length(layer)
    if count is not None:
        for key, series in (("values", values), ("valid_fraction", valid)):
            if len(series) != count:
                problems.append(
                    f"{layer_id}: area_series.{key} must have time.count entries",
                )
        if has_fallback and isinstance(fallback, list) and len(fallback) != count:
            problems.append(
                f"{layer_id}: area_series.fallback_fraction must have time.count entries",
            )
    problems += _series_value_problems(layer_id, values, valid, fallback)
    problems += _fallback_credit_problems(layer_id, layer, fallback)
    return problems


def _series_length(layer: JsonObject) -> int | None:
    """Return the time count the series arrays must match, or None without a valid axis."""
    time_axis = layer.get("time")
    if not isinstance(time_axis, dict):
        return None
    values = time_axis.get("values")
    count = time_axis.get("count")
    if not isinstance(values, list) or not _is_int(count) or count != len(values):
        return None
    return count


def _series_value_problems(
    layer_id: str,
    values: list[object],
    valid: list[object],
    fallback: list[object] | None,
) -> list[str]:
    """Return problems with one step's mean, shares and their null consistency."""
    problems = []
    for index, (value, share) in enumerate(zip(values, valid)):
        if not _is_share(share):
            problems.append(
                f"{layer_id}: area_series.valid_fraction[{index}] must be between 0 and 1",
            )
            continue
        if value is None:
            if share != 0:
                problems.append(
                    f"{layer_id}: area_series null must match zero valid share",
                )
        elif not _is_finite_number(value):
            problems.append(
                f"{layer_id}: area_series.values[{index}] must be a finite number or null",
            )
        elif share == 0:
            problems.append(
                f"{layer_id}: area_series null must match zero valid share",
            )
        if fallback is not None and index < len(fallback):
            share_fallback = fallback[index]
            if not _is_share(share_fallback):
                problems.append(
                    f"{layer_id}: area_series.fallback_fraction[{index}] "
                    "must be between 0 and 1",
                )
            elif share == 0 and share_fallback != 0:
                problems.append(
                    f"{layer_id}: area_series.fallback_fraction must not exceed valid_fraction",
                )
            elif share_fallback > share + FRACTION_TOLERANCE:
                problems.append(
                    f"{layer_id}: area_series.fallback_fraction must not exceed valid_fraction",
                )
    return problems


def _is_share(value: object) -> bool:
    """Return whether a fraction is finite and between zero and just above one."""
    return (
        _is_finite_number(value)
        and 0 <= value <= 1 + FRACTION_TOLERANCE
    )


def _fallback_credit_problems(
    layer_id: str,
    layer: JsonObject,
    fallback: list[object] | None,
) -> list[str]:
    """Return problems when fallback shares and their credited sources disagree."""
    sources = layer.get("fallback_sources")
    credited = isinstance(sources, list) and any(isinstance(entry, dict) for entry in sources)
    if fallback is None:
        if credited:
            return [f"{layer_id}: fallback_sources without fallback_fraction"]
        return []
    if not any(_is_finite_number(share) and share > 0 for share in fallback):
        return []
    if not credited:
        return [f"{layer_id}: positive fallback_fraction without fallback_sources"]
    return []


def _distribution_problems(layer_id: str, layer: JsonObject) -> list[str]:
    """Return problems with the terrain quantiles, enforcing v1 applicability."""
    has_block = "distribution" in layer
    block = layer.get("distribution")
    style = layer.get("style")
    kind = style.get("kind") if isinstance(style, dict) else None
    time_varying = layer.get("time_varying")
    if kind == "terrain" and time_varying is True:
        return [f"{layer_id}: terrain layer must be static"]
    if time_varying is True:
        if not has_block:
            return []
        return [f"{layer_id}: time-varying layer must not have distribution"]
    if kind == "terrain":
        if not has_block:
            return [f"{layer_id}: a terrain layer needs distribution"]
    elif kind == "categorical":
        if not has_block:
            return []
        return [f"{layer_id}: categorical layer must not have distribution"]
    elif not has_block:
        return []
    if not isinstance(block, dict):
        return [f"{layer_id}: distribution must be an object"]
    if "path" in block:
        return [f"{layer_id}: distribution.path is reserved and must be omitted"]
    if "categorical_shares" in block:
        return [f"{layer_id}: categorical_shares is reserved and must be omitted"]

    problems = []
    if block.get("statistic") != DISTRIBUTION_STATISTIC:
        problems.append(
            f"{layer_id}: distribution.statistic must be {DISTRIBUTION_STATISTIC}",
        )
    if block.get("weights") != AREA_WEIGHTS_NAME:
        problems.append(
            f"{layer_id}: distribution.weights must be {AREA_WEIGHTS_NAME}",
        )
    percent = block.get("percent")
    if not _is_finite_number(percent) or percent != DISTRIBUTION_PERCENT:
        problems.append(
            f"{layer_id}: distribution.percent must be {DISTRIBUTION_PERCENT}",
        )
    values = block.get("values")
    if not isinstance(values, list) or len(values) != DISTRIBUTION_VALUE_COUNT:
        return [*problems, f"{layer_id}: distribution.values must have 101 numbers"]
    if not all(_is_finite_number(value) for value in values):
        return [*problems, f"{layer_id}: distribution.values must be finite numbers"]
    if any(later < earlier for earlier, later in zip(values, values[1:])):
        problems.append(f"{layer_id}: distribution.values must not decrease")
    for key in ("min", "max", "mean"):
        if not _is_finite_number(block.get(key)):
            problems.append(f"{layer_id}: distribution.{key} must be a finite number")
    valid_share = block.get("valid_fraction")
    if (
        not _is_finite_number(valid_share)
        or not 0 < valid_share <= 1 + FRACTION_TOLERANCE
    ):
        problems.append(
            f"{layer_id}: distribution.valid_fraction must be above 0 and at most 1",
        )
    if (
        _is_finite_number(block.get("min"))
        and _is_finite_number(block.get("max"))
        and _is_finite_number(block.get("mean"))
    ):
        if not block["min"] <= block["mean"] <= block["max"]:
            problems.append(f"{layer_id}: distribution min must not exceed mean or max")
        if values[0] != block["min"] or values[-1] != block["max"]:
            problems.append(
                f"{layer_id}: distribution endpoints must match min and max",
            )
    problems += _reference_problems(layer_id, block.get("reference_values"))
    return problems


def _reference_problems(layer_id: str, references: object) -> list[str]:
    """Return problems with the reference markers, which never enter the samples."""
    if not isinstance(references, list):
        return [f"{layer_id}: distribution.reference_values must be a list"]
    problems = []
    for index, entry in enumerate(references):
        if not isinstance(entry, dict):
            problems.append(
                f"{layer_id}: distribution.reference_values[{index}] must be an object",
            )
            continue
        if not isinstance(entry.get("id"), str) or not entry.get("id"):
            problems.append(
                f"{layer_id}: distribution.reference_values[{index}].id must be text",
            )
        if not _is_finite_number(entry.get("value")):
            problems.append(
                f"{layer_id}: distribution.reference_values[{index}].value "
                "must be a finite number",
            )
        elif entry.get("id") == "sea_level" and entry.get("value") != 0:
            problems.append(
                f"{layer_id}: distribution sea_level reference must be 0",
            )
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
    """Return whether a value is a finite number without ever raising."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


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


def _layer_sources(layer_blocks: list[JsonObject]) -> list[object]:
    """Return each layer's main source with its fallback and tile sources."""
    sources: list[object] = []
    for layer in layer_blocks:
        if not isinstance(layer, dict):
            continue
        main = layer.get("source")
        if isinstance(main, dict):
            sources.append(main)
        fallbacks = layer.get("fallback_sources", [])
        if isinstance(fallbacks, list):
            sources.extend(fallbacks)
        sources.extend(_tile_sources(layer))
    return sources


def _tile_sources(layer: JsonObject) -> list[JsonObject]:
    tiles = layer.get("tiles")
    if isinstance(tiles, dict) and isinstance(tiles.get("source"), dict):
        return [tiles["source"]]

    return []
