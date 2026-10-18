"""Offline tests: dataset kinds and steps, tiles, terrain resolution, block mean, source probes."""
import functools
import http.server
import threading
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import Affine

from soe.sources import chirps, terrain
from soe.sources import (
    CHIRPS_GRID,
    SOURCES,
    Bbox,
    Dataset,
    Grid,
    RealSource,
    Role,
    SeriesDataset,
    SourceUnavailable,
    StaticDataset,
    SyntheticSource,
    hillshade,
    make_registry,
    read_wrapped,
    terrain_tiles,
)
from soe.sources.grid import block_mean
from soe.sources.periods import add_duration, previous_month
from soe.sources.terrain import (
    TerrainProduct,
    _tile_index,
    _tile_name,
    _warp_block,
    placed_terrain_tiles,
    terrain_by_blocks,
    terrain_product,
    terrain_res,
)
from tests.helpers import NAIROBI, RAIN, TERRAIN


TILE_PX = 60  # the fake terrain tiles are small, 1 / 60 degree per pixel
NARROW_TILE_PX = 40  # tiles from 50 degrees poleward have 2/3 of the pixels in x
CELL_DEG = 0.05


def vars_of(dataset: Dataset) -> dict:
    return {name: getattr(dataset, name) for name in dataset.__dataclass_fields__}


def test_monthly_steps_cover_each_requested_month():
    steps = RAIN.steps("2015-11-01", "2016-03-01")

    assert steps == ["2015-11-01", "2015-12-01", "2016-01-01", "2016-02-01"]


def test_five_year_steps_include_the_period_holding_the_start():
    class Population(SeriesDataset):
        def first(self) -> str:
            return "2000-01-01"

        def latest(self) -> str:
            return "2020-01-01"

        def read_step(self, step: str, bbox: Bbox, factor: int = 1) -> np.ndarray:
            raise NotImplementedError

    population = Population(**{**vars(RAIN), "id": "population", "step": "P5Y"})

    steps = population.steps("2007-03-01", "2016-01-01")

    assert steps == ["2005-01-01", "2010-01-01", "2015-01-01"]


def test_steps_stop_at_the_latest_available_period():
    assert RAIN.steps("2026-07-01", "2027-01-01") == ["2026-07-01", "2026-08-01"]


def test_period_end_of_a_month_is_the_next_month_start():
    assert RAIN.period_end("2015-12-01") == "2016-01-01"
    assert add_duration("2016-03-01", "P1M", sign=-1) == "2016-02-01"
    assert add_duration("2020-01-01", "P16D") == "2020-01-17"


def test_unsupported_duration_is_refused():
    with pytest.raises(ValueError, match="unsupported duration"):
        add_duration("2015-01-01", "PT6H")


def test_block_mean_is_nan_aware():
    values = np.array([[1, 3, np.nan, np.nan], [5, np.nan, np.nan, np.nan]], "float32")
    means = block_mean(values, 2)

    assert means[0, 0] == 3 and np.isnan(means[0, 1])


def test_chirps_grid_window_and_bbox_round_trip():
    bbox = [36.5, -1.5, 37.5, -0.5]
    span = CHIRPS_GRID.span(bbox)

    assert CHIRPS_GRID.bbox(span) == bbox
    assert CHIRPS_GRID.window(bbox) == (4330, 1210, 20, 20)


def test_cell_centred_grid_has_its_cell_edges_half_a_cell_off_the_chirps_grid():
    cell_centred = Grid(-0.05, 90.05, 0.1, 3600, 1801)

    assert cell_centred.span((10.05, 20.05, 10.15, 20.15)) == (101, 102, 699, 700)
    assert cell_centred.bbox((101, 102, 699, 700)) == [10.05, 20.05, 10.15, 20.15]


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
            bounds,
            res,
            lambda block, block_res: synthetic.terrain(block, block_res)[0],
        )

        assert np.abs(whole.astype(int) - blocks).max() <= 1  # float rounding at block edges only
        assert transform.c == bounds[0] and transform.f == bounds[3]


def test_latest_month_probe_picks_the_newest_existing_month(monkeypatch):
    now = datetime.now(timezone.utc)
    newest_existing = previous_month(*previous_month(now.year, now.month))
    existing_urls = set()
    year, month = newest_existing
    for _ in range(3):
        existing_urls.add(chirps._chirps_url(f"{year:04d}-{month:02d}"))
        year, month = previous_month(year, month)

    monkeypatch.setattr(chirps, "_head", lambda url: (url in existing_urls, None))

    latest = RealSource().latest_month()

    assert latest == f"{newest_existing[0]:04d}-{newest_existing[1]:02d}"


def test_latest_month_is_rechecked_soon_when_a_newer_month_was_unreachable(monkeypatch):
    now = datetime.now(timezone.utc)
    this_month = chirps._chirps_url(f"{now.year:04d}-{now.month:02d}")
    monkeypatch.setattr(
        chirps,
        "_head",
        lambda url: (None, None) if url == this_month else (True, None),
    )
    source = RealSource()

    source.latest_month()

    ttl = source._probed[1] - time.time()
    assert ttl <= chirps.OFFLINE_LATEST_TTL_SECS


def test_read_month_wraps_at_180():
    source = SyntheticSource()
    rain = make_registry(source)["chirps_monthly"]
    bbox = [179, -1, 181, 1]
    rain_month = rain.read_month("2015-01", bbox, 2)
    left = source.read_rain("2015-01", (7180, 1180, 20, 40))
    right = source.read_rain("2015-01", (0, 1180, 20, 40))

    assert source.reads == 4 and rain_month.shape == (20, 20)
    assert np.array_equal(rain_month, block_mean(np.hstack([left, right]), 2), equal_nan=True)


def test_wrapped_read_joins_both_edges_on_a_tenth_degree_grid():
    grid = Grid(-180.05, 60.05, 0.1, 3600, 1200)
    reads = []

    def read_window(window: tuple[int, int, int, int]) -> np.ndarray:
        reads.append(window)
        col, row, width, height = window
        return np.tile(np.arange(col, col + width), (height, 1)).astype("float32")

    cells = read_wrapped(grid, [179.45, -1.05, 180.65, 0.05], read_window)

    assert reads == [(3595, 600, 5, 11), (0, 600, 7, 11)]
    assert cells.shape == (11, 12)
    assert cells[0].tolist() == [3595, 3596, 3597, 3598, 3599, 0, 1, 2, 3, 4, 5, 6]


def test_series_dataset_without_read_step_cannot_be_created():
    class HalfSeries(SeriesDataset):
        def first(self) -> str:
            return "1990-01-01"

        def latest(self) -> str:
            return "1990-12-01"

    with pytest.raises(TypeError, match="read_step"):
        HalfSeries(**vars_of(RAIN))


def test_role_with_fill_inside_the_value_range_is_refused():
    roles = {"value": Role("precip", "uint16", scale=0.1, fill=7)}

    with pytest.raises(ValueError, match="fill at the end of its dtype range"):
        replace(RAIN, roles=roles)


def test_static_dataset_without_read_cannot_be_created():
    class NoRead(StaticDataset):
        pass

    with pytest.raises(TypeError, match="read"):
        NoRead(**vars_of(TERRAIN))


def test_terrain_read_returns_elevation_and_the_hillshade_derived_from_it():
    arrays, transform = TERRAIN.read(NAIROBI.bounds, 0.01)

    assert arrays.keys() == TERRAIN.roles.keys()
    assert arrays["elevation"].dtype == np.int16 and arrays["hillshade"].dtype == np.uint8
    assert np.array_equal(
        arrays["hillshade"],
        hillshade(arrays["elevation"], 0.01, transform.f, 315, 45),
    )


def test_every_terrain_source_has_a_disclaimer():
    assert all(SOURCES[product].get("disclaimer") for product in ("glo30", "glo90"))


def test_time_varying_follows_the_dataset_kind():
    assert (RAIN.time_varying, TERRAIN.time_varying) == (True, False)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


@pytest.fixture
def fake_terrain(tmp_path, monkeypatch):
    """Serve small GLO-90-shaped tiles from localhost; add_tile(lon, lat) creates each existing one.

    Returns (add_tile, tiles) where tiles maps (lon, lat) to its pixel values. The tile index lists
    exactly the added tiles.
    """
    handler = functools.partial(QuietHandler, directory=str(tmp_path))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    product = TerrainProduct(
        f"http://127.0.0.1:{server.server_port}/{{n}}.tif",
        Path("unused"),
        "30",
        1 / TILE_PX,
        TILE_PX,
        90,
    )
    monkeypatch.setitem(terrain.TERRAIN_PRODUCTS, "glo90", product)
    index = np.zeros(terrain.TILE_GRID_SHAPE, bool)
    monkeypatch.setattr(terrain, "_tile_index", lambda product_name: index)
    tiles = {}
    random = np.random.default_rng(1)

    def add_tile(lon: int, lat: int) -> None:
        width = NARROW_TILE_PX if abs(lat + 0.5) >= 50 else TILE_PX
        values = random.integers(0, 3000, (TILE_PX, width)).astype("float32")
        if width == NARROW_TILE_PX:  # a ramp: random pixels would exaggerate the stretch below
            ramp = np.add.outer(np.arange(TILE_PX) * 5.0, np.arange(width) * 7.0)
            values = ramp.astype("float32")
        wrapped_lon = (lon + 180) % 360 - 180
        profile = {
            "driver": "GTiff",
            "width": width,
            "height": TILE_PX,
            "count": 1,
            "dtype": "float32",
            "crs": "EPSG:4326",
            # Copernicus tiles: pixel centres on whole degrees, so the edge is half a pixel out.
            "transform": Affine(
                1 / width,
                0,
                wrapped_lon - 0.5 / width,
                0,
                -1 / TILE_PX,
                lat + 1 + 0.5 / TILE_PX,
            ),
        }
        path = tmp_path / f"{_tile_name('glo90', lat, wrapped_lon)}.tif"
        with rasterio.open(path, "w", **profile) as tile:
            tile.write(values, 1)
        index[lat + 90, wrapped_lon + 180] = True
        tiles[(lon, lat)] = values

    yield add_tile, tiles
    server.shutdown()


def area_mean(
    tiles: dict[tuple[int, int], np.ndarray],
    bounds: tuple[float, float, float, float],
) -> np.ndarray:
    """Exact area-weighted mean of the tile pixels in every cell of bounds; no tile counts as 0."""
    west, south, east, north = bounds
    x_out = west + np.arange(round((east - west) / CELL_DEG) + 1) * CELL_DEG
    y_out = north - np.arange(round((north - south) / CELL_DEG) + 1) * CELL_DEG
    total = np.zeros((len(y_out) - 1, len(x_out) - 1))
    for (lon, lat), values in tiles.items():
        height, width = values.shape
        x_in = lon - 0.5 / width + np.arange(width + 1) / width
        y_in = lat + 1 + 0.5 / height - np.arange(height + 1) / height
        weights_x = overlap_lengths(x_out, x_in)
        weights_y = overlap_lengths(-y_out, -y_in)
        total += weights_y @ values @ weights_x.T
    return total / CELL_DEG**2


def overlap_lengths(out_edges: np.ndarray, in_edges: np.ndarray) -> np.ndarray:
    """Length of the overlap of every output interval with every input interval."""
    low = np.maximum(out_edges[:-1, None], in_edges[None, :-1])
    high = np.minimum(out_edges[1:, None], in_edges[None, 1:])
    return np.clip(high - low, 0, None)


def test_terrain_across_180_with_a_missing_tile_equals_the_area_mean(fake_terrain):
    add_tile, tiles = fake_terrain
    for lon, lat in ((179, -18), (180, -18), (180, -19)):  # (179, -19) is missing
        add_tile(lon, lat)
    bounds = (179.0, -19.0, 181.0, -17.0)

    elevation, transform = RealSource().terrain(bounds, CELL_DEG)

    assert np.abs(elevation - area_mean(tiles, bounds)).max() <= 0.51  # int16 rounding
    assert (transform.c, transform.f) == (179.0, -17.0)
    assert (elevation[20:, :19] == 0).all()  # the lower-left tile is missing


def test_two_blocks_equal_one_block_exactly(fake_terrain):
    add_tile, _ = fake_terrain
    for lon, lat in ((179, -18), (180, -18), (179, -19), (180, -19)):
        add_tile(lon, lat)
    bounds = (179.0, -19.0, 181.0, -17.0)  # BLOCK_DEG = 2 splits it at 180

    two_blocks, _ = RealSource().terrain(bounds, CELL_DEG)
    one_block = _warp_block(bounds, CELL_DEG)

    assert terrain._block_edges(179.0, 181.0) == [179.0, 180, 181.0]
    assert np.array_equal(two_blocks, one_block)


def test_narrow_tiles_at_50_degrees_equal_the_area_mean(fake_terrain):
    add_tile, tiles = fake_terrain
    for lon, lat in ((10, 49), (11, 49), (10, 50)):  # (11, 50) is missing
        add_tile(lon, lat)
    bounds = (10.0, 49.0, 12.0, 51.0)

    elevation, _ = RealSource().terrain(bounds, CELL_DEG)

    assert tiles[(10, 50)].shape[1] == NARROW_TILE_PX
    assert np.abs(elevation - area_mean(tiles, bounds)).max() <= 0.51
    assert (elevation[:19, 21:] == 0).all()  # the upper-right tile is missing


def test_narrow_tiles_at_minus_50_degrees_equal_the_area_mean(fake_terrain):
    add_tile, tiles = fake_terrain
    for lon, lat in ((10, -51), (10, -50), (11, -50)):  # (11, -51) is missing
        add_tile(lon, lat)
    bounds = (10.0, -51.0, 12.0, -49.0)

    elevation, _ = RealSource().terrain(bounds, CELL_DEG)

    assert np.abs(elevation - area_mean(tiles, bounds)).max() <= 0.51
    assert (elevation[21:, 21:] == 0).all()  # the lower-right tile is missing


def test_block_without_tiles_is_none(fake_terrain):
    assert _warp_block((20.0, 20.0, 21.0, 21.0), CELL_DEG) is None


def test_failed_block_read_is_retried_then_raised(fake_terrain, monkeypatch):
    add_tile, _ = fake_terrain
    add_tile(10, 10)
    calls = []

    def always_fails(mosaic: str, bounds: tuple, res: float) -> np.ndarray:
        calls.append(1)
        raise rasterio.errors.RasterioIOError("dropped")

    monkeypatch.setattr(terrain, "_average_onto_grid", always_fails)
    monkeypatch.setattr(terrain, "BLOCK_RETRY_DELAY_SECS", 0)

    with pytest.raises(SourceUnavailable):
        _warp_block((10.0, 10.0, 11.0, 11.0), CELL_DEG)

    assert len(calls) == terrain.BLOCK_READ_ATTEMPTS


def test_placed_tiles_west_of_180_keep_the_unwrapped_longitude():
    placed = placed_terrain_tiles((179.0, -19.0, 181.0, -17.0), "glo30")

    assert {(tile.lon, tile.lat) for tile in placed} == {
        (179, -19),
        (180, -19),
        (179, -18),
        (180, -18),
    }
    assert {tile.name.split("_")[6] for tile in placed if tile.lon == 180} == {"W180"}


def test_stops_blend_an_even_stretch_with_the_quantiles():
    rain = make_registry(SyntheticSource())["chirps_monthly"]
    stats = {"min": 1.0, "max": 400.0, "mean": 50.0, "p98": 160.0}
    quantiles = np.linspace(0, 80, 9).tolist()

    stops = rain.stops(stats, quantiles)

    assert stops == [0, 20, 30, 40, 60, 80, 90, 100, 120]


def test_stops_keep_whole_degrees_on_a_narrow_field_far_from_zero():
    terrain = make_registry(SyntheticSource())["copdem_terrain"]
    stats = {"min": 288.0, "max": 301.0, "mean": 295.0, "p98": 300.0}

    stops = terrain.stops(stats, np.linspace(288, 300, 9).tolist())

    assert stops == [288, 290, 291, 292, 294, 296, 297, 298, 300]


def test_stops_of_a_wide_field_far_from_zero_are_not_coarser_than_its_span():
    terrain = make_registry(SyntheticSource())["copdem_terrain"]
    stats = {"min": 1234.0, "max": 1262.0, "mean": 1250.0, "p98": 1260.0}

    stops = terrain.stops(stats, np.linspace(1234, 1260, 9).tolist())

    assert stops == [1234, 1237, 1240, 1244, 1247, 1250, 1254, 1257, 1260]


def test_stops_round_to_the_span_and_drop_repeats():
    terrain = make_registry(SyntheticSource())["copdem_terrain"]
    stats = {"min": 0.0, "max": 120.0, "mean": 5.0, "p98": 100.0}
    quantiles = [0, 0, 0, 0, 0, 0, 0, 0, 100]

    assert terrain.stops(stats, quantiles) == [0, 10, 20, 30, 40, 100]


def test_stops_of_a_constant_field_are_the_same_value_twice():
    terrain = make_registry(SyntheticSource())["copdem_terrain"]
    stats = {"min": 5.0, "max": 5.0, "mean": 5.0, "p98": 5.0}

    assert terrain.stops(stats, [5.0] * 9) == [5, 5]
