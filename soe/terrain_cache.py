"""Disk cache for static dataset reads, so a full-resolution terrain read costs once per area."""
import hashlib
import json
import os
import tempfile
from pathlib import Path

import numpy as np
from rasterio.transform import Affine

from . import __version__
from .sources import Bbox, StaticDataset, SyntheticSource

KEY_HEX_CHARS = 32


def read_cached(
    dataset: StaticDataset,
    bbox: Bbox,
    res: float,
    cache_dir: Path,
) -> tuple[np.ndarray, Affine]:
    """dataset.read(bbox, res), from cache_dir when the same raster was read before.

    The array is loaded fresh from disk each time, so callers never share memory.
    """
    path = cache_dir / f"{_cache_key(dataset, bbox, res)}.npz"
    if path.is_file():
        with np.load(path) as stored:
            return stored["values"], Affine(*stored["transform"].tolist())

    values, transform = dataset.read(bbox, res)
    _store(path, values, transform)
    return values, transform


def _cache_key(dataset: StaticDataset, bbox: Bbox, res: float) -> str:
    """Hash of everything that determines the raster."""
    request = {
        "dataset": dataset.id,
        "sources": [source.get("version") for source in dataset.sources_for(bbox)],
        "synthetic": isinstance(dataset.backend, SyntheticSource),
        "bbox": list(bbox),
        "res": res,
        "soe": __version__,
    }
    encoded = json.dumps(request, sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()[:KEY_HEX_CHARS]


def _store(path: Path, values: np.ndarray, transform: Affine) -> None:
    """Write through a temporary file, so a reader never sees a partial one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as temp_file:
            np.savez(temp_file, values=values, transform=np.array(transform[:6]))
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise
