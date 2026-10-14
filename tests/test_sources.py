"""Offline tests: dataset kinds and steps, tiles, terrain resolution, block mean, source probes."""
import time
from datetime import datetime, timezone

import numpy as np
import pytest

from soe import sources
from soe.sources import (
    SOURCES,
    Dataset,
    RealSource,
    SeriesDataset,
    StaticDataset,
    SyntheticSource,
    _tile_index,
    block_mean,
    make_registry,
    month_list,
    terrain_by_blocks,
    terrain_product,
    terrain_res,
    terrain_tiles,
)
from tests.helpers import RAIN, TERRAIN


def vars_of(dataset: Dataset) -> dict:
    return {name: getattr(dataset, name) for name in dataset.__dataclass_fields__}


def test_months():
    assert month_list("2015-11", "2016-02") == ["2015-11", "2015-12", "2016-01", "2016-02"]


def test_block_mean_is_nan_aware():
    values = np.array([[1, 3, np.nan, np.nan], [5, np.nan, np.nan, np.nan]], "float32")
    means = block_mean(values, 2)

    assert means[0, 0] == 3 and np.isnan(means[0, 1])


def test_terrain_res_budget():
    assert terrain_res((36.5, -1.5, 37.5, -0.5)) == pytest.approx(0.05 / 102)
    assert terrain_res((36.5, -1.5, 36.8, -1.2)) == pytest.approx(1 / 3600)
    assert terrain_res((33, -4, 42, 6)) == pytest.approx(0.005)
    assert terrain_res((-70, -30, -30, 10)) == pytest.approx(0.025)
    assert terrain_res((19, 41, 191, 60)) == pytest.approx(0.05)

    boxes = ((33, -4, 42, 6), (-70, -30, -30, 10), (19, 41, 191, 60), (0, 0, 2, 2), (0, 0, 0.5, 40))

    for bounds in boxes:
        res = terrain_res(bounds)
        width, height = (bounds[2] - bounds[0]) / res, (bounds[3] - bounds[1]) / res

        assert width == pytest.approx(round(width)) and height == pytest.approx(round(height))
        assert width * height <= 2048 * 2048 and max(width, height) <= 4096


def test_tile_index():
    assert _tile_index("glo90").sum() == 26475
    assert _tile_index("glo30").sum() == 26450
    assert terrain_tiles((6, 0, 7, 1), "glo30") == [
        ("glo30", "Copernicus_DSM_COG_10_N00_00_E006_00_DEM"),
    ]
    assert terrain_tiles((6, 0, 7, 1), "glo90") == [
        ("glo90", "Copernicus_DSM_COG_30_N00_00_E006_00_DEM"),
    ]
    assert terrain_tiles((-130, -10, -120, 0), "glo30") == []  # mid-Pacific
    assert TERRAIN.tile_count([-130, -10, -120, 0]) == 0
    assert terrain_tiles((179, -18, 181, -17), "glo30") == [
        ("glo30", "Copernicus_DSM_COG_10_S18_00_E179_00_DEM"),
        ("glo30", "Copernicus_DSM_COG_10_S18_00_W180_00_DEM"),
    ]


def test_terrain_product_is_glo30_only_for_cells_finer_than_90_m():
    assert terrain_product(1 / 1200) == "glo90"
    assert terrain_product(0.05 / 61) == "glo30"
    assert terrain_product(1 / 3600) == "glo30"


def test_glo30_gap_in_the_caucasus_falls_back_to_glo90():
    assert terrain_tiles((44, 40, 45, 41), "glo30") == [
        ("glo90", "Copernicus_DSM_COG_30_N40_00_E044_00_DEM"),
    ]


def test_terrain_sources_name_the_products_a_read_uses():
    kenya = [36.5, -1.5, 36.8, -1.2]
    gap_edge = [42.8, 40.0, 43.2, 40.3]
    wide = [43, 38, 46, 41]

    assert TERRAIN.sources_for(kenya) == [SOURCES["glo30"]]
    assert TERRAIN.sources_for(gap_edge) == [SOURCES["glo30"], SOURCES["glo90"]]
    assert TERRAIN.sources_for(wide) == [SOURCES["glo90"]]


def test_terrain_notices_name_the_source_cell_size_and_the_fallback():
    kenya = [36.5, -1.5, 37.5, -0.5]
    gap_edge = [42.8, 40.0, 43.2, 40.3]

    assert TERRAIN.notices(kenya) == ["Terrain resampled to 55 m cells (source 30 m)."]
    assert not any("GLO-90" in note for note in TERRAIN.notices(kenya))
    assert any("90 m Copernicus GLO-90" in note for note in TERRAIN.notices(gap_edge))


def test_box_ending_on_a_tile_edge_gets_no_fallback_credit():
    edge = [42.8, 40.0, 43.0, 40.2]

    assert TERRAIN.sources_for(edge) == [SOURCES["glo30"]]
    assert not any("GLO-90" in note for note in TERRAIN.notices(edge))


def test_terrain_blocks_equal_one_read():
    synthetic = SyntheticSource()
    for bounds in ((177.35, -19.1, 181.65, -15.85), (36.5, -1.5, 37.5, -0.5)):
        res = terrain_res(bounds)
        whole, _ = synthetic.terrain(bounds, res)
        blocks, transform = terrain_by_blocks(
            bounds, res, lambda block, block_res: synthetic.terrain(block, block_res)[0]
        )

        assert np.abs(whole.astype(int) - blocks).max() <= 1  # float rounding at block edges only
        assert transform.c == bounds[0] and transform.f == bounds[3]


def test_latest_month_probe_picks_the_newest_existing_month(monkeypatch):
    now = datetime.now(timezone.utc)
    newest_existing = sources._previous_month(*sources._previous_month(now.year, now.month))
    existing_urls = set()
    year, month = newest_existing
    for _ in range(3):
        existing_urls.add(sources._chirps_url(f"{year:04d}-{month:02d}"))
        year, month = sources._previous_month(year, month)

    monkeypatch.setattr(sources, "_head", lambda url: (url in existing_urls, None))

    latest = RealSource().latest_month()

    assert latest == f"{newest_existing[0]:04d}-{newest_existing[1]:02d}"


def test_latest_month_is_rechecked_soon_when_a_newer_month_was_unreachable(monkeypatch):
    now = datetime.now(timezone.utc)
    this_month = sources._chirps_url(f"{now.year:04d}-{now.month:02d}")
    monkeypatch.setattr(
        sources, "_head", lambda url: (None, None) if url == this_month else (True, None)
    )
    source = RealSource()

    source.latest_month()

    ttl = source._probed[1] - time.time()
    assert ttl <= sources.OFFLINE_LATEST_TTL_SECS


def test_read_month_wraps_at_180():
    source = SyntheticSource()
    rain = make_registry(source)["chirps_monthly"]
    bbox = [179, -1, 181, 1]
    rain_month = rain.read_month("2015-01", bbox, 2)
    left = source.read_rain("2015-01", (7180, 1180, 20, 40))
    right = source.read_rain("2015-01", (0, 1180, 20, 40))

    assert source.reads == 4 and rain_month.shape == (20, 20)
    assert np.array_equal(rain_month, block_mean(np.hstack([left, right]), 2), equal_nan=True)


def test_series_dataset_without_read_step_cannot_be_created():
    class HalfSeries(SeriesDataset):
        def first(self) -> str:
            return "1990-01"

        def latest(self) -> str:
            return "1990-12"

        def steps(self, start: str, end: str) -> list[str]:
            return []

    with pytest.raises(TypeError, match="read_step"):
        HalfSeries(**vars_of(RAIN))


def test_static_dataset_without_read_cannot_be_created():
    class NoRead(StaticDataset):
        pass

    with pytest.raises(TypeError, match="read"):
        NoRead(**vars_of(TERRAIN))


def test_time_varying_follows_the_dataset_kind():
    assert (RAIN.time_varying, TERRAIN.time_varying) == (True, False)
