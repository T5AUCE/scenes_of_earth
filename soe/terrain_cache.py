"""Disk cache for static dataset reads, so a full-resolution terrain read costs once per area."""
import hashlib
import json
import os
import tempfile
from collections.abc import Callable
from pathlib import Path

import numpy as np
from rasterio.transform import Affine
from shapely.geometry.base import BaseGeometry

from . import __version__
from .sources import Bbox, StaticDataset

KEY_HEX_CHARS = 32
OUTLINE_KEY_VERSION = 2  # 1 read terrain on a canvas that depended on the outline


def read_cached(
    dataset: StaticDataset,
    bbox: Bbox,
    res: float,
    cache_dir: Path,
    on_block: Callable[[], None] | None = None,
    geometry: BaseGeometry | None = None,
) -> tuple[dict[str, np.ndarray], Affine]:
    """dataset.read(bbox, res, on_block, geometry), from cache_dir when read before.

    The arrays are loaded fresh from disk each time, so callers never share memory. A cache hit
    calls on_block never. A geometry leaves cells far from the outline missing, so it is part of
    the key.
    """
    path = _cache_path(dataset, bbox, res, cache_dir, geometry)
    if path.is_file():
        with np.load(path) as stored:
            arrays = {name: stored[name] for name in stored.files if name != "transform"}
            return arrays, Affine(*stored["transform"].tolist())

    if geometry is None:
        arrays, transform = dataset.read(bbox, res, on_block)
    else:
        arrays, transform = dataset.read(bbox, res, on_block, geometry)
    _store(path, arrays, transform)
    return arrays, transform


def is_cached(
    dataset: StaticDataset,
    bbox: Bbox,
    res: float,
    cache_dir: Path,
    geometry: BaseGeometry | None = None,
) -> bool:
    """Whether read_cached would find this raster on disk."""
    return _cache_path(dataset, bbox, res, cache_dir, geometry).is_file()


def _cache_path(
    dataset: StaticDataset,
    bbox: Bbox,
    res: float,
    cache_dir: Path,
    geometry: BaseGeometry | None,
) -> Path:
    return cache_dir / f"{_cache_key(dataset, bbox, res, geometry)}.npz"


def _cache_key(
    dataset: StaticDataset,
    bbox: Bbox,
    res: float,
    geometry: BaseGeometry | None = None,
) -> str:
    """Hash of everything that determines the raster.

    Without a geometry the key is the one used before geometry reads existed, so those rasters stay
    valid.
    """
    request = {
        "dataset": dataset.id,
        "style": dataset.style,
        "roles": list(dataset.roles),
        "sources": [source.get("version") for source in dataset.sources_for(bbox)],
        "synthetic": dataset.synthetic,
        "bbox": list(bbox),
        "res": res,
        "soe": __version__,
    }
    if geometry is not None:
        request["outline"] = hashlib.sha256(geometry.wkb).hexdigest()
        request["outline_version"] = OUTLINE_KEY_VERSION
    encoded = json.dumps(request, sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()[:KEY_HEX_CHARS]


def _store(path: Path, arrays: dict[str, np.ndarray], transform: Affine) -> None:
    """Write through a temporary file, so a reader never sees a partial one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as temp_file:
            np.savez(temp_file, transform=np.array(transform[:6]), **arrays)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise
