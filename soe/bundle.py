"""scene.json: build it from a plan and validate it (including attribution rules)."""
from datetime import datetime, timezone

from . import __version__
from .sources import SOURCES

VERSION = "0.1"


def credits(doc_layers, boundary_source):
    """Attribution block, generated from the sources actually used."""
    srcs = [layer["source"] for layer in doc_layers]
    if boundary_source:
        srcs.append(boundary_source)
    return {
        "lines": [s["attribution"] for s in srcs],
        "disclaimers": [s["disclaimer"] for s in srcs if s.get("disclaimer")],
        "endorsement": "Scenes of Earth is not endorsed by the data providers.",
        "terms_passthrough": "Reuse of this bundle's data is subject to each source's licence listed in "
                             "layers[].source and area.boundary.",
    }


def make(scene_id, title, area, plan, months, datasets, info):
    """Assemble scene.json. Layer blocks come from the dataset registry metadata.

    `info[ds.id]` holds build results: series {"domain", "stats"}, static {"res", "shape"}.
    """
    boundary = None
    if area.named:
        b = area.boundary
        boundary = {"id": b["id"], "name": b["name"], "level": b["level"], "iso3": b["iso3"],
                    "source": b["source"], "licence": b["licence"]}
        boundary.update({k: v for k, v in SOURCES[b["source"]].items() if k in
                         ("licence_url", "attribution", "citation", "modified")})
    ny, nx = plan.shape
    series = next((ds for ds in datasets if ds.time_varying), None)
    doc_layers = []
    for ds in sorted(datasets, key=lambda d: d.time_varying):
        r = info[ds.id]
        layer = {"id": ds.id, "arrays": {n: f"{ds.id}/{n}" for n in ds.arrays}, "units": ds.units,
                 "time_varying": ds.time_varying, "style": ds.style, "source": dict(ds.source)}
        if ds.time_varying:
            layer["resolution"] = {"deg": round(ds.resolution_deg * plan.factor, 6), "nx": nx, "ny": ny,
                                   "aggregation": plan.factor, "method": "block mean"}
            layer["domain"], layer["stats"] = r["domain"], r["stats"]
        else:
            layer["resolution"] = {"deg": r["res"], "nx": r["shape"][1], "ny": r["shape"][0]}
        doc_layers.append(layer)
    return {
        "version": VERSION,
        "id": scene_id,
        "title": title,
        "generator": {"name": "soe", "version": __version__},
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "time": {"start": months[0], "end": months[-1], "count": len(months), "step": "month"} if series else None,
        "area": {
            "type": "boundary" if area.named else "polygon",
            "boundary": boundary,
            "crs": "EPSG:4326",
            "bbox": plan.bbox,
            "geometry_href": "area.geojson",
            "mask": {"array": f"{series.id}/mask" if series else None, "rule": "cell centre inside",
                     "cells_inside": plan.cells_inside},
            "clipped_to_coverage": plan.clipped,
        },
        "layers": doc_layers,
        "data": {"href": "data.zarr", "format": "zarr v3, gzip"},
        "notices": {"limits": list(plan.notices)},
        "credits": credits(doc_layers, boundary and SOURCES[area.boundary["source"]]),
    }


def validate(doc):
    """Return a list of problems (empty when the bundle is fine)."""
    bad = []
    for k in ("version", "id", "area", "layers", "data", "credits", "notices"):
        if k not in doc:
            bad.append(f"missing {k}")
    if bad:
        return bad
    if not doc["layers"]:
        bad.append("no layers")
    area = doc["area"]
    w, s, e, n = area["bbox"]
    if not (w < e and s < n):
        bad.append("bbox is not W < E and S < N")
    if area["mask"]["cells_inside"] < 1:
        bad.append("mask has no cells")
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
        if layer["id"] == "glo90_terrain" and not layer["source"].get("disclaimer"):
            bad.append("glo90_terrain: missing disclaimer")
    return bad
