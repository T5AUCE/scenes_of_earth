"""Build a scene bundle: plan, read month by month, aggregate, hillshade, write Zarr + scene.json."""
import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import zarr
from shapely.geometry import mapping
from zarr.codecs import GzipCodec

from . import __version__
from .areas import AreaError, plan as make_plan
from .bundle import make, validate
from .sources import month_list

THREADS = 8
MEM_BUDGET = 500_000_000  # bytes for concurrent month reads; fewer threads are used for large windows
BYTES_PER_CELL = 13  # float32 read + block-mean intermediates per native cell (estimate)
BATCH = 12  # months buffered for one chunk-aligned write (<= 12 x 4 B x aggregated cells, <= 100 MB at the cap)
GZIP = GzipCodec(level=5)  # zarr-python defaults to zstd, which zarrita does not read by default


def hillshade(z, res_deg, lat_top, azimuth=315, altitude=45):
    """Horn hillshade of a north-up grid with geographic cell sizes; uint8."""
    z = np.pad(z.astype("float64"), 1, mode="edge")
    lat = lat_top - (np.arange(z.shape[0] - 2) + 0.5) * res_deg
    dx = (res_deg * 111320 * np.cos(np.radians(lat)))[:, None].clip(min=1)
    dy = res_deg * 110574
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    ge = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx)  # rise per metre eastwards
    gn = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * dy)  # rise per metre northwards
    az, alt = np.radians(azimuth), np.radians(altitude)
    light = (np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt))
    shade = (-ge * light[0] - gn * light[1] + light[2]) / np.sqrt(ge ** 2 + gn ** 2 + 1)
    return np.rint(shade.clip(0, 1) * 255).astype("uint8")


def _coords(t, ny, nx):
    """Cell-centre longitudes and latitudes from the affine transform."""
    return (t.c + (np.arange(nx) + 0.5) * t.a), (t.f + (np.arange(ny) + 0.5) * t.e)


def _put(grp, name, data, dims, attrs=None, chunks=None):
    arr = grp.create_array(name, shape=data.shape, chunks=chunks or data.shape, dtype=data.dtype,
                           compressors=GZIP, dimension_names=dims, attributes=attrs or {})
    arr[...] = data
    return arr


def _dir_bytes(path):
    return sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())


def build_scene(scene_id, area, start, end, datasets, title, scenes_dir, progress=lambda p: None):
    """Build a bundle in SCENES_DIR/.tmp/{id}, then move it to SCENES_DIR/{id}. Returns bytes written.

    `scene_id` is the content hash, so a finished bundle at SCENES_DIR/{id} never changes.
    """
    months = month_list(start, end)
    plan = make_plan(area, len(months), datasets)
    scenes_dir = Path(scenes_dir)
    tmp, final = scenes_dir / ".tmp" / scene_id, scenes_dir / scene_id
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        root = zarr.open_group(str(tmp / "data.zarr"), mode="w", zarr_format=3)
        info = {}
        ny, nx = plan.shape
        lon, lat = _coords(plan.transform, ny, nx)
        progress(0.05)
        for ds in sorted(datasets, key=lambda d: d.time_varying):  # static layers first
            grp = root.create_group(ds.id)
            if ds.time_varying:
                info[ds.id] = _write_series(grp, ds, plan, months, lon, lat, progress)
            else:
                info[ds.id] = _write_static(grp, ds, plan.bbox)
        doc = make(scene_id, title, area, plan, months, datasets, info)
        root.attrs.update({"title": title, "conventions": "CF-1.8", "generator": f"soe {__version__}",
                           "credits": doc["credits"]})
        problems = validate(doc)
        if problems:
            raise RuntimeError("invalid scene.json: " + "; ".join(problems))
        feature = {"type": "Feature", "properties": {"name": (area.boundary or {}).get("name", title)},
                   "geometry": mapping(plan.geometry)}
        (tmp / "area.geojson").write_text(json.dumps(feature), encoding="utf-8")
        (tmp / "scene.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
        size = _dir_bytes(tmp)
        shutil.rmtree(final, ignore_errors=True)
        os.replace(tmp, final)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    progress(1.0)
    return size


def _write_static(grp, ds, bbox):
    """Static terrain-like dataset: elevation plus a derived hillshade."""
    z, t = ds.read(bbox)
    ny, nx = z.shape
    lon, lat = _coords(t, ny, nx)
    dims = ["lat", "lon"]
    _put(grp, "lon", lon, ["lon"], {"units": "degrees_east"})
    _put(grp, "lat", lat, ["lat"], {"units": "degrees_north"})
    ch = (min(ny, 512), min(nx, 512))
    _put(grp, ds.arrays[0], z, dims, {"units": ds.units, "long_name": "Elevation (resampled)"}, ch)
    hs = ds.style["hillshade"]
    _put(grp, ds.arrays[1], hillshade(z, abs(t.a), t.f, hs["azimuth"], hs["altitude"]), dims,
         {"long_name": f"Hillshade, azimuth {hs['azimuth']}, altitude {hs['altitude']} (0-255)"}, ch)
    return {"res": round(abs(t.a), 8), "shape": (ny, nx)}


def _write_series(grp, ds, plan, months, lon, lat, progress):
    T, (ny, nx) = len(months), plan.shape
    f = plan.factor
    inside = plan.mask.astype(bool)
    t_days = np.array([(date(int(m[:4]), int(m[5:7]), 1) - date(1970, 1, 1)).days for m in months], "int32")
    _put(grp, "time", t_days, ["time"], {"units": "days since 1970-01-01", "calendar": "standard"})
    _put(grp, "lon", lon, ["lon"], {"units": "degrees_east"})
    _put(grp, "lat", lat, ["lat"], {"units": "degrees_north"})
    _put(grp, "mask", plan.mask, ["lat", "lon"], {"long_name": "1 = cell centre inside the area"})
    arr = grp.create_array(
        ds.arrays[0], shape=(T, ny, nx), chunks=(min(T, BATCH), min(ny, 256), min(nx, 256)), dtype="float32",
        fill_value=float("nan"), compressors=GZIP, dimension_names=["time", "lat", "lon"],
        attributes={"units": ds.units, "long_name": "Monthly precipitation"})
    rng = np.random.default_rng(0)
    # p98 comes from a per-batch random sample (<= 100k values each); a short last batch is slightly
    # over-weighted, which is an acceptable bias for a legend domain.
    threads = max(1, min(THREADS, MEM_BUDGET // (plan.window[2] * plan.window[3] * BYTES_PER_CELL)))
    sample, lo, hi, tot, cnt = [], np.inf, -np.inf, 0.0, 0
    with ThreadPoolExecutor(threads) as ex:
        for b in range(0, T, BATCH):
            batch = months[b:b + BATCH]
            block = np.stack(list(ex.map(lambda ym: ds.read_month(ym, plan.bbox, f), batch)))
            arr[b:b + len(batch)] = block
            v = block[:, inside]
            v = v[np.isfinite(v)]
            if v.size:
                lo, hi, tot, cnt = min(lo, v.min()), max(hi, v.max()), tot + v.sum(dtype="float64"), cnt + v.size
                sample.append(rng.choice(v, min(v.size, 100_000), replace=False))
            progress(0.05 + 0.9 * (b + len(batch)) / T)
    if not cnt:
        raise AreaError("no rain data inside the area")
    p98 = float(np.percentile(np.concatenate(sample), 98))
    return {"domain": [0, round(p98, 2)],
            "stats": {"min": round(float(lo), 2), "max": round(float(hi), 2), "mean": round(tot / cnt, 2),
                      "p98": round(p98, 2)}}
