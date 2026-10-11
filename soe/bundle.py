"""scene.json: build it from a plan and validate it (including attribution rules)."""
from datetime import datetime, timezone

from . import __version__
from .sources import SOURCES

VERSION = "0.2"


def credits(doc_layers, boundary_source):
    """Attribution block, generated from the sources actually used."""
    srcs = [layer["source"] for layer in doc_layers]
    if boundary_source:
        srcs.append(boundary_source)
    return {
        "lines": [s["attribution"] for s in srcs],
        "disclaimers": [s["disclaimer"] for s in srcs if s.get("disclaimer")],
        "endorsement": "Scenes of Earth is not endorsed by the data providers.",
        "terms_passthrough": "Reuse of this bundle's data is subject to each source's licence "
                             "listed in layers[].source and area.boundary.",
    }


def _layer_block(ds, lp, r):
    """One layer of scene.json, from the dataset metadata, its plan and its build result `r`."""
    grid = {"crs": "EPSG:4326", "bbox": lp.bbox, "res": round(lp.res, 8),
            "nx": lp.shape[1], "ny": lp.shape[0]}
    arrays = {}
    for role, name in ds.arrays.items():
        dtype, scale_factor, add_offset, fill = ds.encoding[role]
        arrays[role] = {"path": f"{ds.id}/{name}", "dtype": dtype, "scale_factor": scale_factor,
                        "add_offset": add_offset, "fill": fill}
    layer = {"id": ds.id, "title": ds.title, "units": ds.units, "time_varying": ds.time_varying,
             "source": dict(ds.source), "style": dict(ds.style), "coverage": list(ds.coverage),
             "grid": grid,
             "mask": {"path": f"{ds.id}/mask", "rule": "cell centre inside",
                      "cells_inside": lp.cells_inside},
             "time": None, "arrays": arrays}
    if ds.time_varying:
        grid["aggregation"] = lp.factor
        layer["style"]["domain"] = r["domain"]
        layer["time"] = {"step": ds.step, "count": len(lp.steps), "path": f"{ds.id}/time",
                         "values": lp.steps}
        layer["stats"] = r["stats"]
    return layer


def make(scene_id, title, area, plan, datasets, info):
    """Assemble scene.json. Layer blocks come from the dataset registry metadata.

    `info[ds.id]` holds build results: {"domain", "stats"} for time-varying layers.
    """
    boundary = None
    if area.named:
        b = area.boundary
        boundary = {"id": b["id"], "name": b["name"], "level": b["level"], "iso3": b["iso3"],
                    "source": b["source"], "licence": b["licence"]}
        boundary.update({k: v for k, v in SOURCES[b["source"]].items() if k in
                         ("licence_url", "attribution", "citation", "modified")})
    doc_layers = [_layer_block(ds, plan.layers[ds.id], info[ds.id])
                  for ds in sorted(datasets, key=lambda d: d.time_varying)]
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
        "layers": doc_layers,
        "data": {"href": "data.zarr",
                 "format": "zarr v3, gzip, sharded series, consolidated metadata"},
        "notices": {"limits": plan.notices
                    + [n for lp in plan.layers.values() for n in lp.notices]},
        "credits": credits(doc_layers, boundary and SOURCES[area.boundary["source"]]),
    }


def validate(doc):
    """Return a list of problems (empty when the bundle is fine)."""
    required = ("version", "id", "area", "layers", "data", "credits", "notices")
    bad = [f"missing {k}" for k in required if k not in doc]
    if bad:
        return bad
    if not doc["layers"]:
        bad.append("no layers")
    area = doc["area"]
    w, s, e, n = area["bbox"]
    if not (w < e and s < n):
        bad.append("bbox is not W < E and S < N")
    lines = doc["credits"].get("lines", [])
    sources = [layer["source"] for layer in doc["layers"]]
    if area["type"] == "boundary":
        if not area.get("boundary"):
            bad.append("boundary area without boundary block")
        else:
            sources.append(area["boundary"])
    for src in sources:
        name = src.get("name") or src.get("source", "?")
        for k in ("licence", "attribution"):
            if not src.get(k):
                bad.append(f"{name}: missing {k}")
        if src.get("attribution") and src["attribution"] not in lines:
            bad.append(f"{name}: attribution not in credits.lines")
        if src.get("disclaimer") and src["disclaimer"] not in doc["credits"].get("disclaimers", []):
            bad.append(f"{name}: disclaimer not in credits.disclaimers")
    for layer in doc["layers"]:
        for k in ("grid", "mask", "arrays"):
            if not layer.get(k):
                bad.append(f"{layer['id']}: missing {k}")
        if layer.get("mask") and layer["mask"]["cells_inside"] < 1:
            bad.append(f"{layer['id']}: mask has no cells")
        time = layer.get("time")
        if layer["time_varying"] and not (time and time["count"] == len(time["values"])):
            bad.append(f"{layer['id']}: time axis missing or count does not match values")
        if not layer["time_varying"] and time is not None:
            bad.append(f"{layer['id']}: static layer has a time axis")
        if layer["id"] == "glo90_terrain" and not layer["source"].get("disclaimer"):
            bad.append("glo90_terrain: missing disclaimer")
    return bad
