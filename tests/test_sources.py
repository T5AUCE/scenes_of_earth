"""Test offline dataset steps, tiles, terrain resolution, block means and source probes."""
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
import zarr
from rasterio.transform import Affine, from_origin

from soe.sources import (
    CHIRPS_GRID,
    ERA5_GRID,
    ERA5_LAND_TEMPERATURE_CUBE,
    ERA5_LAND_TEMPERATURE_GRID,
    ERA5_TEMPERATURE_CUBE,
    SOURCES,
    Bbox,
    CubeSpec,
    Dataset,
    Era5LandTemperatureDataset,
    Grid,
    MonthlyCube,
    RealSource,
    Role,
    SeriesDataset,
    SourceUnavailable,
    StaticDataset,
    SyntheticSource,
    chirps,
    make_registry,
    read_wrapped,
    terrain,
    terrain_tiles,
)
from soe.sources import remote, worldcover
from soe.sources.chirps import previous_month
from soe.sources.fallback import read_bilinear
from soe.sources.grid import block_mean
from soe.sources.periods import add_duration
from soe.sources.terrain import (
    LATITUDE_DEGREE_M,
    TerrainProduct,
    _tile_index,
    _tile_name,
    _warp_block,
    placed_terrain_tiles,
    slope_degrees,
    terrain_by_blocks,
    terrain_product,
    terrain_res,
)
from soe.sources.worldcover import (
    PlacedTile,
    _read_tile,
    overview_factor,
    worldcover_tiles,
)
from tests.helpers import NAIROBI, RAIN, TERRAIN, write_cube

TILE_PX = 60  # the fake terrain tiles are small, 1 / 60 degree per pixel
NARROW_TILE_PX = 40  # tiles from 50 degrees poleward have 2/3 of the pixels in x
CELL_DEG = 0.05
CUBE_SHAPE = (ERA5_LAND_TEMPERATURE_GRID.rows, ERA5_LAND_TEMPERATURE_GRID.columns)


def vars_of(dataset: Dataset) -> dict:
    """Return all declared dataclass fields, including inherited fields."""
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


def test_temperature_grid_has_cell_centres_on_tenth_degrees():
    grid = ERA5_LAND_TEMPERATURE_GRID
    columns = np.arange(grid.columns)
    rows = np.arange(grid.rows)
    longitudes = grid.west_deg + (columns + 0.5) * grid.res
    latitudes = grid.north_deg - (rows + 0.5) * grid.res
    _, _, _, last_row = grid.span((0, -60, 1, 60))

    assert np.allclose(longitudes * 10, np.round(longitudes * 10))
    assert np.allclose(latitudes * 10, np.round(latitudes * 10))
    assert (longitudes[0], latitudes[0], latitudes[-1]) == pytest.approx((-180, 60, -60))
    assert last_row == grid.rows


class FakeCubes:
    """Provide fixed month markers for each cube."""

    def __init__(self, markers: dict[str, dict[str, str]]) -> None:
        self.markers = markers

    def cube_months(self, spec: CubeSpec) -> dict[str, str]:
        return self.markers[spec.name]


def temperature_over(
    land: dict[str, str],
    era5: dict[str, str] | None = None,
) -> Era5LandTemperatureDataset:
    """Return a temperature dataset using the supplied cube markers; default ERA5 markers to final.
    """
    era5 = era5 or {month: "0001:era5" for month in land}
    cubes = FakeCubes({"era5land_temperature": land, "era5_temperature": era5})
    synthetic = make_registry(SyntheticSource())["era5land_temperature"]
    return replace(synthetic, backend=cubes)


def land_cube(cubes_dir: Path) -> MonthlyCube:
    return MonthlyCube(ERA5_LAND_TEMPERATURE_CUBE, cubes_dir)


def test_temperature_revision_changes_only_for_requested_months_that_turn_final():
    preliminary = temperature_over({"2026-07": "0001:aaaa", "2026-08": "0005:bbbb"})
    final = temperature_over({"2026-07": "0001:aaaa", "2026-08": "0001:cccc"})
    steps = ["2026-07-01", "2026-08-01"]

    assert preliminary.local_revision(steps) != final.local_revision(steps)
    assert preliminary.local_revision(steps[:1]) == final.local_revision(steps[:1])


def test_preliminary_steps_get_one_notice_per_run():
    temperature = temperature_over(
        {
            "2026-01": "0005:a",
            "2026-02": "0005:a",
            "2026-03": "0001:a",
            "2026-04": "0005:a",
        },
    )
    steps = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]

    notices = temperature.notices([0, 0, 1, 1], steps)

    assert len(notices) == 2
    assert notices[0].startswith("Temperature 2026-01 to 2026-02 is preliminary")
    assert notices[1].startswith("Temperature 2026-04 is preliminary")


def test_final_steps_get_no_notice():
    temperature = temperature_over({"2026-01": "0001:a", "2026-02": "0001:b"})

    assert temperature.notices([0, 0, 1, 1], ["2026-01-01", "2026-02-01"]) == []


def test_temperature_revision_changes_when_only_the_era5_marker_changes():
    land = {"2026-07": "0001:aaaa", "2026-08": "0001:bbbb"}
    before = temperature_over(land, {"2026-07": "0001:x", "2026-08": "0005:y"})
    after = temperature_over(land, {"2026-07": "0001:x", "2026-08": "0001:z"})
    steps = ["2026-07-01", "2026-08-01"]

    assert before.local_revision(steps) != after.local_revision(steps)


def test_temperature_months_are_those_both_cubes_hold():
    land = {"2016-01": "0001:a", "2016-02": "0001:a", "2016-03": "0001:a"}
    era5 = {"2016-02": "0001:b", "2016-03": "0001:b", "2016-04": "0001:b"}

    temperature = temperature_over(land, era5)

    assert (temperature.first(), temperature.latest()) == ("2016-02-01", "2016-03-01")


def test_era5_preliminary_month_gets_the_preliminary_notice():
    temperature = temperature_over(
        {"2026-01": "0001:a", "2026-02": "0001:a"},
        {"2026-01": "0001:b", "2026-02": "0005:b"},
    )

    notices = temperature.notices([0, 0, 1, 1], ["2026-01-01", "2026-02-01"])

    assert len(notices) == 1 and notices[0].startswith("Temperature 2026-02 is preliminary")


class FakeRainBackend(FakeCubes):
    """Provide fixed CHIRPS revisions and fallback-cube month markers."""

    def __init__(self, fallback: dict[str, str], chirps_revision: str = "chirps") -> None:
        super().__init__({"era5_precipitation": fallback})
        self.chirps_revision = chirps_revision

    def latest_month(self) -> str:
        return "2026-08"

    def current_revision(self, month: str) -> str:
        return self.chirps_revision


def test_rain_remote_revision_follows_the_chirps_file_and_local_one_the_fallback_marker():
    steps = ["2026-06-01", "2026-07-01"]
    markers = {"2026-06": "0001:a", "2026-07": "0005:b"}
    base = replace(RAIN, backend=FakeRainBackend(markers))
    revised_chirps = replace(RAIN, backend=FakeRainBackend(markers, "chirps again"))
    final_fallback = replace(
        RAIN,
        backend=FakeRainBackend({"2026-06": "0001:a", "2026-07": "0001:c"}),
    )

    assert base.remote_revision(steps) != revised_chirps.remote_revision(steps)
    assert base.local_revision(steps) == revised_chirps.local_revision(steps)
    assert base.remote_revision(steps) == final_fallback.remote_revision(steps)
    assert base.local_revision(steps) != final_fallback.local_revision(steps)
    assert base.local_revision(steps[:1]) == final_fallback.local_revision(steps[:1])


def test_revision_of_a_month_the_cube_lost_is_unavailable():
    rain = replace(RAIN, backend=FakeRainBackend({"2026-06": "0001:a"}))

    with pytest.raises(SourceUnavailable):
        rain.local_revision(["2026-06-01", "2026-07-01"])


def test_rain_preliminary_months_filled_by_the_fallback_get_one_notice_per_run():
    markers = {"2026-04": "0001:a", "2026-05": "0005:a", "2026-06": "0005:a", "2026-07": "0001:a"}
    rain = replace(RAIN, backend=FakeRainBackend(markers))
    steps = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"]

    notices = rain.fallback_notices(steps, [True, True, True, True])

    assert len(notices) == 1
    assert "Rainfall 2026-05 to 2026-06" in notices[0] and "preliminary" in notices[0]


def test_rain_preliminary_months_the_fallback_did_not_fill_get_no_notice():
    markers = {"2026-05": "0005:a", "2026-06": "0005:a", "2026-07": "0005:a"}
    rain = replace(RAIN, backend=FakeRainBackend(markers))
    steps = ["2026-05-01", "2026-06-01", "2026-07-01"]

    notices = rain.fallback_notices(steps, [True, False, True])

    assert len(notices) == 2
    assert "Rainfall 2026-05 is" in notices[0] and "Rainfall 2026-07 is" in notices[1]
    assert rain.fallback_notices(steps, [False, False, False]) == []


def test_rain_final_fallback_months_get_no_notice():
    rain = replace(RAIN, backend=FakeRainBackend({"2026-06": "0001:a", "2026-07": "0001:b"}))

    assert rain.fallback_notices(["2026-06-01", "2026-07-01"], [True, True]) == []


def test_rain_has_no_notice_before_the_build_shows_the_fallback_was_used():
    rain = replace(RAIN, backend=FakeRainBackend({"2026-05": "0005:a"}))

    assert rain.notices([0, 0, 1, 1], ["2026-05-01"]) == []


def test_rain_months_are_those_chirps_and_the_fallback_cube_hold():
    fallback = {"2016-03": "0001:a", "2026-05": "0001:a"}

    rain = replace(RAIN, backend=FakeRainBackend(fallback))

    assert (rain.first(), rain.latest()) == ("2016-03-01", "2026-05-01")


def test_era5_grid_has_cell_centres_on_quarter_degrees():
    longitudes = ERA5_GRID.west_deg + (np.arange(ERA5_GRID.columns) + 0.5) * ERA5_GRID.res
    latitudes = ERA5_GRID.north_deg - (np.arange(ERA5_GRID.rows) + 0.5) * ERA5_GRID.res

    assert np.allclose(longitudes * 4, np.round(longitudes * 4))
    assert (longitudes[0], latitudes[0], latitudes[-1]) == pytest.approx((-180, 60, -60))
    assert longitudes[-1] == pytest.approx(179.75)


def cell_ids(window: tuple[int, int, int, int]) -> np.ndarray:
    """Return coarse-cell identifiers computed as row * 10000 + column."""
    col, row, width, height = window
    rows, columns = np.meshgrid(
        np.arange(row, row + height),
        np.arange(col, col + width),
        indexing="ij",
    )
    return (rows * 10000 + columns).astype("float32")


@pytest.mark.parametrize(
    "bbox",
    [[179.65, 0.05, 179.95, 0.35], [-180.35, 0.05, -180.05, 0.35]],
)
def test_temperature_fill_is_seamless_across_180_degrees(tmp_path, bbox):
    no_land_value = np.full(CUBE_SHAPE, np.nan, "float32")
    columns = np.arange(ERA5_GRID.columns, dtype="float32") / 100
    write_cube(tmp_path, "era5land_temperature", no_land_value)
    write_cube(tmp_path, "era5_temperature", np.tile(columns, (ERA5_GRID.rows, 1)))
    temperature = make_registry(RealSource(cubes_dir=tmp_path))["era5land_temperature"]

    read = temperature.read_step_filled("2016-01-01", bbox)

    assert read.filled.all()
    assert read.values[0] == pytest.approx([14.388, 11.512, 5.756])


def test_bilinear_sample_matches_a_hand_computed_point_and_lies_between_its_neighbours():
    sampled = read_bilinear(CHIRPS_GRID, ERA5_GRID, (2, 2, 1, 1), cell_ids)
    neighbours = np.array([0, 1, 10000, 10001])

    assert sampled[0, 0] == pytest.approx(5000.5)
    assert neighbours.min() <= sampled[0, 0] <= neighbours.max()


@pytest.mark.parametrize("first_column", [3598, -2])
def test_bilinear_sampling_wraps_across_180_and_across_minus_180(first_column):
    sampled = read_bilinear(
        ERA5_LAND_TEMPERATURE_GRID,
        ERA5_GRID,
        (first_column, 0, 4, 1),
        cell_ids,
    )

    assert sampled[0] == pytest.approx([1151.2, 575.6, 0, 0.4])


def test_a_nan_coarse_neighbour_gives_way_to_the_nearest_finite_one():
    def gappy_cell_ids(window: tuple[int, int, int, int]) -> np.ndarray:
        values = cell_ids(window)
        values[0, 0] = np.nan
        return values

    sampled = read_bilinear(CHIRPS_GRID, ERA5_GRID, (1, 0, 1, 1), gappy_cell_ids)

    assert sampled[0, 0] == 1


def test_sampling_past_60_south_keeps_the_last_finite_coarse_row(tmp_path):
    write_cube(tmp_path, "era5_temperature", 7)
    cube = MonthlyCube(ERA5_TEMPERATURE_CUBE, tmp_path)

    sampled = read_bilinear(
        ERA5_LAND_TEMPERATURE_GRID,
        ERA5_GRID,
        (0, 1198, 2, 6),
        lambda window: cube.read("2016-01", window),
    )

    assert sampled[:5] == pytest.approx(7) and np.isnan(sampled[5:]).all()


class GappySource(SyntheticSource):
    """Return 10 mm rainfall with gaps in the leading rows and columns of each window."""

    def __init__(self, gap: int) -> None:
        super().__init__()
        self.gap = gap

    def read_rain(self, month: str, window: tuple[int, int, int, int]) -> np.ndarray:
        raster = np.full((window[3], window[2]), 10, "float32")
        raster[:self.gap, :self.gap] = np.nan
        raster[0, self.gap] = np.nan
        return raster


class CompleteSource(SyntheticSource):
    """Return 10 mm rainfall in every cell."""

    def read_rain(self, month: str, window: tuple[int, int, int, int]) -> np.ndarray:
        return np.full((window[3], window[2]), 10, "float32")


@pytest.mark.parametrize("factor", [2, 4])
def test_fallback_fills_only_blocks_that_have_no_main_value(factor):
    rain = make_registry(GappySource(factor))["chirps_monthly"]

    read = rain.read_step_filled("2015-01-01", [36.5, -1.5, 37.5, -0.5], factor)

    assert read.filled.sum() == 1 and read.filled[0, 0]
    assert read.values[0, 0] != 10 and read.values[0, 1] == 10


def test_fallback_is_not_read_when_the_main_source_has_no_gap():
    source = CompleteSource()
    rain = make_registry(source)["chirps_monthly"]

    read = rain.read_step_filled("2015-01-01", [36.5, -1.5, 37.5, -0.5])

    assert not read.filled.any() and source.reads == 0


def test_temperature_needs_both_cubes_to_be_listed(tmp_path):
    write_cube(tmp_path, "era5land_temperature", 0)
    assert "era5land_temperature" not in make_registry(RealSource(cubes_dir=tmp_path))

    write_cube(tmp_path, "era5_temperature", 0)

    assert "era5land_temperature" in make_registry(RealSource(cubes_dir=tmp_path))


def test_rain_needs_its_fallback_cube_to_be_listed(tmp_path):
    assert "chirps_monthly" not in make_registry(RealSource(cubes_dir=tmp_path))

    write_cube(tmp_path, "era5_precipitation", 0)

    assert "chirps_monthly" in make_registry(RealSource(cubes_dir=tmp_path))


def test_every_source_with_a_disclaimer_requires_it():
    with_disclaimer = [source for source in SOURCES.values() if "disclaimer" in source]

    assert len(with_disclaimer) >= 3
    assert all(source["disclaimer_required"] for source in with_disclaimer)


def test_missing_cube_is_unavailable_and_not_listed(tmp_path):
    cube = land_cube(tmp_path)

    assert not cube.has_months()
    with pytest.raises(SourceUnavailable, match="not ingested"):
        cube.months()


def test_cube_read_decodes_celsius_and_fill(tmp_path):
    field = np.full(CUBE_SHAPE, -5.5, "float32")
    field[1, 2] = np.nan
    write_cube(tmp_path, "era5land_temperature", field)

    window = land_cube(tmp_path).read("2016-01", (1, 0, 3, 2))

    assert window.dtype == np.float32 and window.shape == (2, 3)
    assert window[0, 0] == pytest.approx(-5.5)
    assert np.isnan(window[1, 1]) and not np.isnan(window[1, 0])


def test_cube_read_wraps_at_180(tmp_path):
    columns = np.arange(ERA5_LAND_TEMPERATURE_GRID.columns, dtype="float32") / 100
    field = np.tile(columns, (ERA5_LAND_TEMPERATURE_GRID.rows, 1))
    write_cube(tmp_path, "era5land_temperature", field)
    write_cube(tmp_path, "era5_temperature", 0)
    temperature = make_registry(RealSource(cubes_dir=tmp_path))["era5land_temperature"]

    values = temperature.read_step("2016-01-01", [179.85, 0.05, 180.15, 0.35])

    assert values.shape == (3, 3)
    assert values[0] == pytest.approx([35.99, 0, 0.01])


@pytest.mark.parametrize("factor", [2, 4])
def test_cube_read_past_60_south_is_padded_to_whole_blocks(tmp_path, factor):
    write_cube(tmp_path, "era5land_temperature", 5)
    write_cube(tmp_path, "era5_temperature", 0)
    temperature = make_registry(RealSource(cubes_dir=tmp_path))["era5land_temperature"]
    two_rows_past_the_last = (1800, 1808, 1190, 1202)

    values = temperature.read_step(
        "2016-01-01",
        ERA5_LAND_TEMPERATURE_GRID.bbox(two_rows_past_the_last),
        factor,
    )

    assert values.shape == (12 // factor, 8 // factor)
    assert values == pytest.approx(5)


def test_empty_or_unreadable_cube_is_unavailable(tmp_path):
    cube_path = tmp_path / "era5land_temperature.zarr"
    zarr.create_group(cube_path, attributes={"months": {}})
    cube = land_cube(tmp_path)

    assert not cube.has_months()
    with pytest.raises(SourceUnavailable, match="not ingested"):
        cube.months()

    (cube_path / "zarr.json").write_text("{not json")
    assert not land_cube(tmp_path).has_months()


def test_cube_months_are_reread_after_an_ingest(tmp_path):
    write_cube(tmp_path, "era5land_temperature", 10)
    cube = land_cube(tmp_path)
    assert list(cube.months()) == ["2016-01"]

    write_cube(tmp_path, "era5land_temperature", 10, "2016-02", "0005")

    assert list(cube.months()) == ["2016-01", "2016-02"]


def test_terrain_res_budget():
    assert terrain_res((36.5, -1.5, 37.5, -0.5)) == pytest.approx(0.05 / 102)
    assert terrain_res((36.5, -1.5, 36.8, -1.2)) == pytest.approx(1 / 3600)
    assert terrain_res((33, -4, 42, 6)) == pytest.approx(0.005)
    assert terrain_res((-70, -30, -30, 10)) == pytest.approx(0.025)
    assert terrain_res((19, 41, 191, 60)) == pytest.approx(0.05)

    boxes = (
        (33, -4, 42, 6),
        (-70, -30, -30, 10),
        (19, 41, 191, 60),
        (0, 0, 2, 2),
        (0, 0, 0.5, 40),
    )

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


@pytest.mark.parametrize(
    ("bbox", "products"),
    [
        ([36.5, -1.5, 36.8, -1.2], ["glo30"]),
        ([42.8, 40.0, 43.2, 40.3], ["glo30", "glo90"]),
        ([43, 38, 46, 41], ["glo90"]),
        ([42.8, 40.0, 43.0, 40.2], ["glo30"]),
    ],
    ids=["fine", "gap-edge", "coarse", "tile-edge-without-fallback"],
)
def test_terrain_credits_only_the_products_a_read_uses(bbox, products):
    assert TERRAIN.sources_for(bbox) == [SOURCES[product] for product in products]


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

    ttl_secs = source._probed[1] - time.time()
    assert ttl_secs <= chirps.OFFLINE_LATEST_TTL_SECS


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


def test_terrain_read_returns_elevation_only():
    arrays, _ = TERRAIN.read(NAIROBI.bounds, 0.01)

    assert arrays.keys() == {"elevation"}
    assert arrays["elevation"].dtype == np.int16


def test_slope_of_a_plane_with_a_ten_percent_grade():
    res_deg = 0.01
    rise_per_row_m = 0.1 * res_deg * LATITUDE_DEGREE_M
    plane = np.tile(np.arange(8)[:, None] * rise_per_row_m, (1, 8))

    slope = slope_degrees(plane, res_deg, 0.0)

    assert slope[4, 4] == pytest.approx(5.71, abs=0.05)


def test_slope_of_flat_ground_is_zero():
    assert (slope_degrees(np.full((6, 6), 120), 0.01, 10.0) == 0).all()


def test_terrain_elevation_statistics_exclude_values_outside_the_mask():
    elevation = np.arange(25, dtype="int16").reshape(5, 5)
    mask = np.zeros((5, 5), dtype="uint8")
    mask[1:-1, 1:-1] = 1
    elevation[mask == 0] = 10_000

    summary = TERRAIN.summary({"elevation": elevation}, mask, from_origin(0, 5, 1, 1))

    assert summary["min"] == 6 and summary["max"] == 18
    assert summary["mean"] == 12
    assert summary["p2"] == 6.16 and summary["p98"] == 17.84
    assert summary["cell_m"] == pytest.approx(111_320 * np.cos(np.radians(2.5)), abs=0.01)


def test_terrain_layer_names_its_tiles_from_the_environment(monkeypatch):
    default = make_registry(SyntheticSource())["terrain"].tiles

    monkeypatch.setenv("SOE_TERRAIN_TILES", "https://example.org/{z}/{x}/{y}.webp")
    changed = make_registry(SyntheticSource())["terrain"].tiles

    assert default["url"] == "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
    assert changed["url"] == "https://example.org/{z}/{x}/{y}.webp"
    assert changed["source"] == SOURCES["mapterhorn"]


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
    )
    monkeypatch.setitem(terrain.TERRAIN_PRODUCTS, "glo90", product)
    index = np.zeros(terrain.TILE_GRID_SHAPE, bool)
    monkeypatch.setattr(terrain, "_tile_index", lambda product_name: index)
    tiles = {}
    random = np.random.default_rng(1)

    def add_tile(lon: int, lat: int) -> None:
        width = NARROW_TILE_PX if abs(lat + 0.5) >= 50 else TILE_PX
        values = random.integers(0, 3000, (TILE_PX, width)).astype("float32")
        # Random pixels would exaggerate the stretch of the narrow tiles.
        if width == NARROW_TILE_PX:
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
            # Copernicus tiles have pixel centres on whole degrees, so the edge is half a pixel out.
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


@pytest.mark.parametrize(
    ("south", "tile_locations", "missing_rows", "narrow_latitude"),
    [
        (49, [(10, 49), (11, 49), (10, 50)], slice(None, 19), 50),
        (-51, [(10, -51), (10, -50), (11, -50)], slice(21, None), -51),
    ],
    ids=["north", "south"],
)
def test_narrow_tiles_at_50_degrees_equal_the_area_mean(
    fake_terrain,
    south,
    tile_locations,
    missing_rows,
    narrow_latitude,
):
    add_tile, tiles = fake_terrain
    for lon, lat in tile_locations:
        add_tile(lon, lat)
    bounds = (10.0, south, 12.0, south + 2)

    elevation, _ = RealSource().terrain(bounds, CELL_DEG)

    assert tiles[(10, narrow_latitude)].shape[1] == NARROW_TILE_PX
    assert np.abs(elevation - area_mean(tiles, bounds)).max() <= 0.51
    assert (elevation[missing_rows, 21:] == 0).all()


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
    monkeypatch.setattr(remote, "BLOCK_RETRY_DELAY_SECS", 0)

    with pytest.raises(SourceUnavailable):
        _warp_block((10.0, 10.0, 11.0, 11.0), CELL_DEG)

    assert len(calls) == remote.BLOCK_READ_ATTEMPTS


def test_placed_tiles_west_of_180_keep_the_unwrapped_longitude():
    placed = placed_terrain_tiles((179.0, -19.0, 181.0, -17.0), "glo30")

    assert {(tile.lon, tile.lat) for tile in placed} == {
        (179, -19),
        (180, -19),
        (179, -18),
        (180, -18),
    }
    assert {tile.name.split("_")[6] for tile in placed if tile.lon == 180} == {"W180"}


@pytest.mark.parametrize(
    ("dataset", "statistics", "quantiles", "expected"),
    [
        (RAIN, (1, 400, 50, 160), np.linspace(0, 80, 9), [0, 20, 30, 40, 60, 80, 90, 100, 120]),
        (
            TERRAIN,
            (288, 301, 295, 300),
            np.linspace(288, 300, 9),
            [288, 290, 291, 292, 294, 296, 297, 298, 300],
        ),
        (
            TERRAIN,
            (1234, 1262, 1250, 1260),
            np.linspace(1234, 1260, 9),
            [1234, 1237, 1240, 1244, 1247, 1250, 1254, 1257, 1260],
        ),
        (TERRAIN, (0, 120, 5, 100), [0] * 8 + [100], [0, 10, 20, 30, 40, 100]),
        (TERRAIN, (5, 5, 5, 5), [5] * 9, [5, 5]),
    ],
    ids=["rain-blend", "narrow-offset", "wide-offset", "drop-repeats", "constant"],
)
def test_stops_blend_quantiles_and_round_to_field_span(dataset, statistics, quantiles, expected):
    stats = dict(zip(("min", "max", "mean", "p98"), statistics))

    assert dataset.stops(stats, list(quantiles)) == expected


def test_worldcover_tiles_are_named_by_their_south_west_corner():
    nairobi = worldcover_tiles((36.5, -1.5, 37.5, -0.5))
    nebraska = worldcover_tiles((-100.5, 40.5, -99.5, 41.5))

    assert [tile.name for tile in nairobi] == ["S03E036"]
    assert [tile.name for tile in nebraska] == ["N39W102"]


def test_worldcover_tile_edges_floor_to_three_degrees_for_negative_coordinates():
    tiles = worldcover_tiles((-60.5, -3.5, -59.5, -2.5))

    assert {(tile.lon, tile.lat) for tile in tiles} == {(-63, -6), (-63, -3), (-60, -6), (-60, -3)}


def test_worldcover_bounds_on_a_tile_edge_do_not_pull_in_the_next_tile():
    assert [tile.name for tile in worldcover_tiles((36.0, -3.0, 39.0, 0.0))] == ["S03E036"]


def test_worldcover_tiles_wrap_past_180_and_keep_the_unwrapped_longitude():
    tiles = worldcover_tiles((178.0, -19.0, 182.0, -17.0))

    assert {(tile.name, tile.lon, tile.file_lon) for tile in tiles} == {
        ("S21E177", 177, 177),
        ("S21W180", 180, -180),
        ("S18E177", 177, 177),
        ("S18W180", 180, -180),
    }


def test_worldcover_minus_180_is_the_w180_tile():
    tiles = worldcover_tiles((-180.0, -19.0, -179.0, -18.5))

    assert [(tile.name, tile.lon, tile.file_lon) for tile in tiles] == [("S21W180", -180, -180)]


def test_open_sea_has_no_worldcover_tile():
    assert worldcover_tiles((-150.0, 0.0, -149.0, 1.0)) == []


@pytest.mark.parametrize(
    ("res_in_source_pixels", "factor"),
    [(1, 1), (3.99, 1), (4, 1), (7.99, 1), (8, 2), (15.99, 2), (16, 4), (32, 8), (255, 32)],
)
def test_overview_factor_gives_each_cell_at_least_16_samples(res_in_source_pixels, factor):
    assert overview_factor(res_in_source_pixels * worldcover.WORLDCOVER_RES_DEG) == factor


def test_overview_factor_stops_at_the_coarsest_overview():
    assert overview_factor(0.05) == 64
    assert overview_factor(1.0) == 64


@pytest.mark.parametrize("cell_px", [4, 8])
def test_land_cover_cell_is_the_most_common_class_of_its_samples(tmp_path, monkeypatch, cell_px):
    cells = 120 // cell_px
    classes = _majority_pattern(cells, cell_px)
    _write_class_tile(tmp_path / "S03E036.tif", classes)
    monkeypatch.setattr(worldcover, "WORLDCOVER_URL", str(tmp_path / "{n}.tif"))
    res = cell_px * worldcover.WORLDCOVER_RES_DEG
    part = (36.0, -3.0, 36.0 + cells * res, -3.0 + cells * res)

    read = _read_tile(PlacedTile("S03E036", 36, -3, 36), part, res)

    majority = np.where((np.add.outer(np.arange(cells), np.arange(cells)) % 2) == 0, 10, 20)
    assert read.shape == (cells, cells)
    assert (read == majority).all()


def test_land_cover_ignores_no_data_samples(tmp_path, monkeypatch):
    classes = np.zeros((120, 120), "uint8")
    classes[:4, :4] = 0
    classes[0, 0] = 30
    classes[3, 3] = 30
    _write_class_tile(tmp_path / "S03E036.tif", classes)
    monkeypatch.setattr(worldcover, "WORLDCOVER_URL", str(tmp_path / "{n}.tif"))
    res = 4 * worldcover.WORLDCOVER_RES_DEG
    part = (36.0, -3.0 + 116 * worldcover.WORLDCOVER_RES_DEG, 36.0 + res, -3.0 + 0.01)

    read = _read_tile(PlacedTile("S03E036", 36, -3, 36), part, res)

    assert read.tolist() == [[30]]


def _majority_pattern(cells: int, cell_px: int) -> np.ndarray:
    """Class samples where each cell's majority class alternates 10 and 20 like a chessboard.

    Samples come in 2 x 2 blocks, so that a mode overview of the tile is exact.
    """
    blocks = cell_px // 2
    in_cell = np.arange(blocks * blocks).reshape(blocks, blocks) < round(blocks * blocks * 0.6)
    cell = np.kron(in_cell, np.ones((2, 2), bool))
    classes = np.zeros((cells * cell_px,) * 2, "uint8")
    for row in range(cells):
        for column in range(cells):
            major, minor = (10, 20) if (row + column) % 2 == 0 else (20, 10)
            rows = slice(row * cell_px, (row + 1) * cell_px)
            columns = slice(column * cell_px, (column + 1) * cell_px)
            classes[rows, columns] = np.where(cell, major, minor)
    return classes


def _write_class_tile(path: Path, classes: np.ndarray) -> None:
    """A WorldCover-like GeoTIFF of the south-west corner of tile S03E036, with a mode overview."""
    height, width = classes.shape
    profile = {
        "driver": "GTiff",
        "width": width,
        "height": height,
        "count": 1,
        "dtype": "uint8",
        "nodata": 0,
        "crs": "EPSG:4326",
        "transform": from_origin(
            36.0,
            -3.0 + height * worldcover.WORLDCOVER_RES_DEG,
            worldcover.WORLDCOVER_RES_DEG,
            worldcover.WORLDCOVER_RES_DEG,
        ),
    }
    with rasterio.open(path, "w", **profile) as tile:
        tile.write(classes, 1)
        tile.build_overviews([2], rasterio.enums.Resampling.mode)
