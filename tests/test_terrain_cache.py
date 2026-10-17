"""Offline tests: the terrain cache returns what a read would, and its key tracks every input."""
from dataclasses import replace

import numpy as np
import pytest

from soe import terrain_cache
from soe.sources import RealSource, SyntheticSource, make_registry
from soe.terrain_cache import _cache_key, read_cached
from tests.helpers import NAIROBI, TERRAIN

BBOX = NAIROBI.bounds
RES = 0.01


class CountingSource(SyntheticSource):
    def __init__(self) -> None:
        self.reads = 0

    def terrain(self, bounds: tuple, res: float) -> tuple[np.ndarray, object]:
        self.reads += 1
        return super().terrain(bounds, res)


def test_cache_hit_equals_the_miss_byte_for_byte(tmp_path):
    source = CountingSource()
    dataset = make_registry(source)["copdem_terrain"]

    miss_arrays, miss_transform = read_cached(dataset, BBOX, RES, tmp_path)
    hit_arrays, hit_transform = read_cached(dataset, BBOX, RES, tmp_path)

    assert source.reads == 1
    assert hit_arrays.keys() == miss_arrays.keys() == dataset.roles.keys()
    assert hit_arrays["elevation"].dtype == np.int16 and hit_arrays["hillshade"].dtype == np.uint8
    for role in dataset.roles:
        assert hit_arrays[role].tobytes() == miss_arrays[role].tobytes()
        assert hit_arrays[role] is not miss_arrays[role]
    assert hit_transform == miss_transform


def test_cache_hit_gives_a_fresh_array_the_caller_may_change(tmp_path):
    first, _ = read_cached(TERRAIN, BBOX, RES, tmp_path)
    first["elevation"][:] = 0

    second, _ = read_cached(TERRAIN, BBOX, RES, tmp_path)

    assert second["elevation"].any()


def test_key_changes_with_bbox_res_and_soe_version(monkeypatch):
    base = _cache_key(TERRAIN, BBOX, RES)
    moved = (BBOX[0] + 0.01, *BBOX[1:])

    assert _cache_key(TERRAIN, BBOX, RES) == base
    assert _cache_key(TERRAIN, list(BBOX), RES) == base
    assert _cache_key(TERRAIN, moved, RES) != base
    assert _cache_key(TERRAIN, BBOX, RES / 2) != base

    monkeypatch.setattr(terrain_cache, "__version__", "9.9.9")

    assert _cache_key(TERRAIN, BBOX, RES) != base


def test_version_bump_does_not_reuse_the_old_cache(tmp_path, monkeypatch):
    source = CountingSource()
    dataset = make_registry(source)["copdem_terrain"]
    read_cached(dataset, BBOX, RES, tmp_path)

    monkeypatch.setattr(terrain_cache, "__version__", "9.9.9")
    read_cached(dataset, BBOX, RES, tmp_path)

    assert source.reads == 2


def test_failed_read_leaves_nothing_in_the_cache(tmp_path):
    class Boom(SyntheticSource):
        def terrain(self, bounds: tuple, res: float) -> tuple[np.ndarray, object]:
            raise RuntimeError("boom")

    dataset = make_registry(Boom())["copdem_terrain"]

    with pytest.raises(RuntimeError):
        read_cached(dataset, BBOX, RES, tmp_path)

    assert list(tmp_path.iterdir()) == []


def test_store_leaves_only_the_finished_file(tmp_path):
    read_cached(TERRAIN, BBOX, RES, tmp_path / "cache")

    assert [path.suffix for path in (tmp_path / "cache").iterdir()] == [".npz"]


def test_key_differs_between_the_synthetic_and_the_real_source():
    synthetic = make_registry(SyntheticSource())["copdem_terrain"]
    real = make_registry(RealSource())["copdem_terrain"]

    assert _cache_key(synthetic, BBOX, RES) != _cache_key(real, BBOX, RES)


def test_key_changes_with_the_roles_a_dataset_stores():
    fewer = replace(TERRAIN, roles={"elevation": TERRAIN.roles["elevation"]})

    assert _cache_key(fewer, BBOX, RES) != _cache_key(TERRAIN, BBOX, RES)


def test_key_changes_with_the_hillshade_light():
    moved_light = replace(TERRAIN, style={"kind": "terrain", "hillshade": {"azimuth": 0}})

    assert _cache_key(moved_light, BBOX, RES) != _cache_key(TERRAIN, BBOX, RES)
