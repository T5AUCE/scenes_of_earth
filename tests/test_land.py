"""Test cutting areas to the land polygons with a small hand-made store and no network."""

import json
import zipfile
from itertools import pairwise
from pathlib import Path

import numpy as np
import pytest
import shapely
from shapely.errors import ShapelyError
from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    box,
    mapping,
)
from shapely.geometry.base import BaseGeometry

from soe import db, land
from soe.areas import Area, AreaError
from soe.land import (
    clip_area_to_land,
    clip_to_land,
    land_in,
    land_version,
    store_clips,
    write_land_store,
)
from soe.sources import SourceUnavailable
from tests.helpers import boundary_row, harmonic_island

VERSION = "2026-11-14"
OVERTURE = "Overture Maps divisions"
SQUARE_DEG2 = 1.0
NEIGHBOUR_EDGE_DEG = 0.99


def store_of(tmp_path: Path, *polygons: Polygon, version: str = VERSION) -> Path:
    store = tmp_path / "land.sqlite"
    write_land_store(store, version, polygons)

    return store


def test_sea_is_dropped_from_the_area(tmp_path):
    store = store_of(tmp_path, box(0, 0, 1, 1))

    clip = clip_to_land(store, box(-1, -1, 2, 2), [])

    assert clip.geom.area == pytest.approx(SQUARE_DEG2)
    assert clip.geom.equals(box(0, 0, 1, 1))


def test_land_just_outside_the_boundary_is_recovered(tmp_path):
    store = store_of(tmp_path, box(0, 0, 1, 1))

    clip = clip_to_land(store, box(0, 0, 0.99, 1), [])

    assert clip.geom.area == pytest.approx(SQUARE_DEG2)


def test_land_a_neighbour_holds_is_not_recovered(tmp_path):
    store = store_of(tmp_path, box(0, 0, 1, 1))
    neighbour = box(NEIGHBOUR_EDGE_DEG, 0, 1.5, 1)

    clip = clip_to_land(store, box(0, 0, NEIGHBOUR_EDGE_DEG, 1), [neighbour])

    assert clip.geom.area == pytest.approx(NEIGHBOUR_EDGE_DEG)


def test_land_the_area_contains_is_kept_as_it_is(tmp_path):
    island = Polygon([(0, 0), (1, 0.1), (1.2, 1), (0.3, 0.8)])
    store = store_of(tmp_path, island)

    clip = clip_to_land(store, box(-1, -1, 3, 3), [])

    assert shapely.equals_exact(clip.geom, MultiPolygon([shapely.normalize(island)]), 0)


def test_detail_far_below_the_finest_cell_is_removed_from_the_clip(tmp_path):
    edge = [(index / 1000, 0) for index in range(1000)]
    dense = Polygon([*edge, (1, 0), (1, 1), (0, 1)])
    store = store_of(tmp_path, dense)

    clip = clip_to_land(store, box(-1, -1, 2, 2), [])

    assert len(dense.exterior.coords) > 1000
    assert shapely.get_num_coordinates(clip.geom) == len(box(0, 0, 1, 1).exterior.coords)
    assert clip.geom.equals(box(0, 0, 1, 1))


def test_parts_under_one_hectare_are_dropped_but_the_largest_stays(tmp_path):
    islet = box(5, 5, 5.0005, 5.0005)
    store = store_of(tmp_path, box(0, 0, 1, 1), islet)

    with_islet = clip_to_land(store, box(-1, -1, 6, 6), [])
    only_islet = clip_to_land(store, box(4, 4, 6, 6), [])

    assert len(with_islet.geom.geoms) == 1
    assert only_islet.geom.equals(islet)


def test_area_without_land_is_refused(tmp_path):
    store = store_of(tmp_path, box(0, 0, 1, 1))

    with pytest.raises(AreaError, match="no land"):
        clip_to_land(store, box(10, 10, 11, 11), [])


def test_area_across_180_is_cut_in_one_longitude_frame(tmp_path):
    store = store_of(tmp_path, box(178, -19, 180, -17), box(-180, -19, -178, -17))

    clip = clip_to_land(store, box(178, -19, 182, -17), [])

    assert clip.geom.bounds == (178, -19, 182, -17)
    assert len(clip.geom.geoms) == 1


def test_land_in_reads_both_sides_of_180_and_shifts_the_far_side(tmp_path):
    store = store_of(tmp_path, box(178, -19, 180, -17), box(-180, -19, -178, -17))

    polygons = land_in(store, (178, -19, 182, -17))

    assert sorted(polygon.bounds for polygon in polygons) == [
        (178, -19, 180, -17),
        (180, -19, 182, -17),
    ]


def test_borders_hold_only_the_edges_that_run_over_land(tmp_path):
    store = store_of(tmp_path, box(0, 0, 2, 1))
    neighbour = box(1, -1, 2, 2)

    clip = clip_to_land(store, box(-1, -1, 1, 2), [neighbour])

    assert clip.borders.length == pytest.approx(1)
    assert clip.borders.bounds == pytest.approx((1, 0, 1, 1))


def test_land_cut_by_the_margin_where_no_neighbour_holds_it_is_not_a_border(tmp_path):
    store = store_of(tmp_path, box(0, 0, 0.5, 1))

    clip = clip_to_land(store, box(-1, -1, 0.1, 2), [])

    assert clip.borders.is_empty


def test_edges_of_a_drawn_shape_over_land_are_borders(tmp_path):
    store = store_of(tmp_path, box(0, 0, 2, 1))

    clip = clip_to_land(store, box(-1, -1, 1, 2), [], grow_deg=0)

    assert clip.borders.length == pytest.approx(1)


def test_an_island_has_no_borders(tmp_path):
    store = store_of(tmp_path, box(0, 0, 1, 1))

    clip = clip_to_land(store, box(-1, -1, 2, 2), [])

    assert clip.borders.is_empty


def test_outline_covers_the_coast_and_stays_off_the_neighbours_land(tmp_path):
    store = store_of(tmp_path, box(0, 0, 10, 10))
    neighbour = box(5, -5, 15, 15)

    clip = clip_to_land(store, box(-5, -5, 5, 15), [neighbour])

    border_length_deg = 10
    rounding_strip_deg2 = land.OUTLINE_PRECISION_DEG * border_length_deg
    assert clip.geom.difference(clip.display).area <= rounding_strip_deg2 + 1e-9
    assert clip.display.area > clip.geom.area
    assert clip.display.intersection(neighbour).area < 1e-9


def as_served(geometry):
    """The geometry on the build's rounding grid, then without the grid's precision model.

    Intersecting a fixed-precision geometry snaps to its grid and can hide an overlap.
    """
    return shapely.set_precision(shapely.set_precision(geometry, land.OUTLINE_PRECISION_DEG), 0)


def zigzag_edge(x_deg, amplitude_deg, count=200):
    """Points of a vertical edge at `x_deg` from south to north, bending in and out."""
    return [(x_deg - (index % 2) * amplitude_deg, index / count) for index in range(count + 1)]


@pytest.mark.parametrize("amplitude_deg", [5e-6, 6e-4])
def test_simplified_geometry_never_reaches_a_neighbour_across_a_bent_border(
    tmp_path, amplitude_deg
):
    edge = zigzag_edge(1, amplitude_deg)
    frame = Polygon([(-1, 0), *edge, (1 - amplitude_deg, 1), (-1, 1)])
    neighbour = Polygon([*edge, (3, 1), (3, 0)])
    store = store_of(tmp_path, box(0, 0, 3, 1))

    clip = clip_to_land(store, frame, [neighbour])

    rounded = as_served(clip.display)
    assert clip.geom.intersection(neighbour).area < 1e-12
    assert clip.display.intersection(neighbour).area < 1e-12
    assert rounded.intersection(neighbour).area < 1e-12


def test_simplified_display_never_reaches_a_neighbour_when_tolerance_exceeds_the_margin(tmp_path):
    frame = Polygon(
        [(0, 0), (100, 0), (100, 1), (1.08, 1), (1.08, 0.96), (1, 0.96), (1, 1), (0, 1)]
    )
    neighbour = Polygon(
        [(0, 1), (1, 1), (1, 0.96), (1.08, 0.96), (1.08, 1), (100, 1), (100, 2), (0, 2)]
    )
    store = store_of(tmp_path, box(0, 0, 100, 2))

    clip = clip_to_land(store, frame, [neighbour])

    rounded = as_served(clip.display)
    assert clip.geom.intersection(neighbour).area < 1e-12
    assert clip.display.intersection(neighbour).area < 1e-12
    assert rounded.intersection(neighbour).area < 1e-12


def test_outline_holds_all_land_when_the_tolerance_would_cut_into_the_coast(tmp_path):
    coast = [(index * 0.5, 1 + 0.04 * (index % 2)) for index in range(201)]
    mainland = Polygon([(0, 0), (100, 0), *reversed(coast)])
    islets = [box(10 + index, 3, 10.01 + index, 3.01) for index in range(5)]
    store = store_of(tmp_path, mainland, *islets)

    clip = clip_to_land(store, box(-1, -1, 101, 4), [])

    rounded = as_served(clip.display)
    parts = shapely.union_all([mainland, *islets])
    plain = shapely.simplify(parts, land._display_tolerance(parts.bounds))
    assert parts.difference(plain).area > 0.1
    assert parts.difference(clip.display).area < 1e-12
    assert parts.difference(rounded).area < 1e-12


def test_outline_holds_the_land_up_to_a_neighbour_it_must_not_cover(tmp_path):
    frame = Polygon(
        [(0, 0), (100, 0), (100, 1), (1.08, 1), (1.08, 0.96), (1, 0.96), (1, 1), (0, 1)]
    )
    neighbour = Polygon(
        [(0, 1), (1, 1), (1, 0.96), (1.08, 0.96), (1.08, 1), (100, 1), (100, 2), (0, 2)]
    )
    store = store_of(tmp_path, box(0, 0, 100, 2))

    clip = clip_to_land(store, frame, [neighbour])

    rounded = as_served(clip.display)
    guard_deg = 3 * land.OUTLINE_PRECISION_DEG
    assert clip.geom.difference(rounded).buffer(-guard_deg).is_empty
    assert rounded.intersection(neighbour).area < 1e-12


def test_display_margin_reaches_a_400th_of_the_span(tmp_path):
    store = store_of(tmp_path, box(0, 0, 1, 1))

    clip = clip_to_land(store, box(-1, -1, 2, 2), [])

    west, south, east, north = clip.geom.bounds
    margin_deg = max(east - west, north - south) / land.DISPLAY_SPAN_DIVISOR
    display_west, display_south, display_east, display_north = clip.display.bounds
    assert display_west <= west - margin_deg + 1e-9
    assert display_south <= south - margin_deg + 1e-9
    assert display_east >= east + margin_deg - 1e-9
    assert display_north >= north + margin_deg - 1e-9


def test_display_stops_at_a_coastal_border_on_the_sea_side(tmp_path):
    west, east = box(0, 0, 1, 2), box(1, 0, 2, 2)
    store = store_of(tmp_path, box(0, 0, 2, 2))

    clip = clip_to_land(store, west, [east])

    assert clip.borders.length > 0
    assert clip.display.intersection(box(1, 2, 3, 3)).area < 1e-12
    assert clip.display.intersection(box(1, -1, 3, 0)).area < 1e-12
    assert clip.display.intersection(box(-1, 2, 1, 3)).area > 1e-12


def test_display_contains_all_land_where_a_border_reaches_the_coast(tmp_path):
    west, east = box(0, 0, 1, 2), box(1, 0, 2, 2)
    store = store_of(tmp_path, box(0, 0, 2, 2))

    clip = clip_to_land(store, west, [east])

    rounding_strip_deg2 = land.OUTLINE_PRECISION_DEG * clip.borders.length
    assert clip.geom.difference(clip.display).area <= rounding_strip_deg2 + 1e-9
    assert clip.display.area > clip.geom.area
    assert clip.display.intersection(east).area < 1e-9


def test_segmented_border_grows_rays_only_from_its_merged_ends(monkeypatch):
    border = MultiLineString(
        [LineString([(1, index / 10), (1, (index + 1) / 10)]) for index in range(20)]
    )
    grown = box(-0.05, -0.05, 1.05, 2.05)
    mainland = box(0, 0, 1, 2)
    neighbour = box(1, 0, 2, 2)
    coast = land._coast_lines(mainland, border)
    seen = {}
    seaward_rays = land._seaward_border_rays

    def spy(borders: BaseGeometry, growth_deg: float, covered: BaseGeometry) -> list[LineString]:
        rays = seaward_rays(borders, growth_deg, covered)
        seen["rays"] = len(rays)
        return rays

    monkeypatch.setattr(land, "_seaward_border_rays", spy)
    outline = land._cut_sea_at_borders(grown, mainland, border, coast, 0.01, neighbour)

    assert seen["rays"] == 2
    merged = land._cut_sea_at_borders(
        grown, mainland, shapely.line_merge(border), coast, 0.01, neighbour
    )
    assert outline.equals(merged)

    def unmerged_border_rays(
        borders: BaseGeometry, growth_deg: float, covered: BaseGeometry
    ) -> list[LineString]:
        # The original segments bypass merging to preserve the previous outline as a reference.
        return seaward_rays(border, growth_deg, covered)

    monkeypatch.setattr(land, "_seaward_border_rays", unmerged_border_rays)
    previous_outline = land._cut_sea_at_borders(grown, mainland, border, coast, 0.01, neighbour)

    assert outline.equals(previous_outline)


def test_shallow_border_ray_leaves_no_tail_on_the_neighbour_sea_side():
    selected = Polygon([(0, 0), (0, 1), (5.67, 1)])
    neighbour = Polygon([(0, 0), (5.67, 0), (5.67, 1)])

    for shift_deg in (0, 360):
        parts = [Polygon([(x + shift_deg, y) for x, y in selected.exterior.coords])]
        shifted_neighbour = Polygon([(x + shift_deg, y) for x, y in neighbour.exterior.coords])
        frame_bounds = shapely.total_bounds(parts)
        tolerance_deg = land._display_tolerance(frame_bounds)
        limit_deg = land._conservative_reach_deg(frame_bounds)

        outline = land._display_outline(
            parts, [shifted_neighbour], tolerance_deg, keep_in_reach=True, limit_deg=limit_deg
        )

        assert not shapely.covers(outline, Point(5.68 + shift_deg, 1.001))
        assert shapely.covers(outline, Point(2 + shift_deg, 0.9))


def test_neighbour_side_sea_joined_by_an_island_margin_is_dropped(tmp_path):
    west, east = box(0, 0, 1, 2), box(1, 0, 2, 2)
    island = box(1.002, 2.007, 1.004, 2.009)
    store = store_of(tmp_path, box(0, 0, 2, 2), island)

    clip = clip_to_land(store, west, [east])

    assert not shapely.covers(clip.display, Point(1.003, 2.0001))
    assert shapely.covers(clip.display, Point(0.5, 2.001))
    assert shapely.covers(clip.display, island)


def test_neighbour_just_outside_the_old_window_is_found(tmp_path, monkeypatch):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    frame, neighbour = box(0, 0, 1, 1), box(1.02255, 0.2, 2, 0.8)
    add_boundaries(db_path, {"WEST": frame, "EAST": neighbour})
    store = store_of(tmp_path, box(-0.02, 0.1, 1.02, 0.9))
    area = named_area(db_path, "WEST")

    assert "ovt:EAST" in [item.id for item in land._neighbours(db_path, area, area.geom)]

    # A tiny vertex cap forces the coarsening branch while recovered land is present.
    monkeypatch.setattr(land, "MAX_DISPLAY_VERTICES", 4)
    clip = clip_area_to_land(db_path, store, area)

    assert clip.display.intersection(neighbour).area < 1e-12
    assert clip.display.intersection(box(1.03, 0.2, 2, 0.8)).area < 1e-12


def test_neighbour_touching_the_reach_only_along_an_edge_keeps_the_clip(tmp_path):
    store = store_of(tmp_path, box(0, 0, 2, 1))
    overlap = box(0.9, -1, 1.5, 2)
    touch = box(1, 0, 2, 1)

    # Without growth the reach is the frame, so the touch stays exactly on its edge.
    clip = clip_to_land(store, box(0, 0, 1, 1), [overlap, touch], grow_deg=0)

    assert clip.geom.area == pytest.approx(1)
    assert clip.display.intersection(overlap).area < 1e-12


def test_lines_and_points_in_the_reach_are_dropped_from_the_exclusion():
    neighbour = box(0.9, -1, 1.5, 2)
    reach = GeometryCollection([box(0, 0, 1, 1), LineString([(0.4, 0.4), (0.6, 0.6)]), Point(2, 2)])

    # Overlay unions keep lines and points where shapes only touch, which the outline cannot use.
    exclusion = land._display_exclusion([neighbour], reach)

    assert exclusion.geom_type in ("Polygon", "MultiPolygon")
    assert exclusion.area == pytest.approx(0.1, abs=1e-3)
    assert exclusion.bounds[2] == pytest.approx(1, abs=1e-4)


def test_outline_stays_off_a_neighbour_narrower_than_the_grid(tmp_path):
    land_box = box(0, 0, 100, 2)
    neighbour = box(1.000001, 0.5, 1.000004, 1.5)
    store = store_of(tmp_path, land_box)

    clip = clip_to_land(store, land_box.difference(neighbour), [neighbour])

    rounded = as_served(clip.display)
    assert clip.display.intersection(neighbour).area < 1e-12
    assert rounded.intersection(neighbour).area < 1e-12


def test_outline_stays_off_a_neighbour_just_past_its_unrounded_edge(tmp_path):
    land_box = box(0, 0, 1.000006, 1)
    neighbour = box(1.001108, 0, 2, 1)
    store = store_of(tmp_path, land_box)

    clip = clip_to_land(store, land_box, [neighbour])

    assert as_served(clip.display).intersection(neighbour).area < 1e-12


def test_coarsening_never_reaches_a_neighbour_outside_the_lookup_window(tmp_path, monkeypatch):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    islands = [
        box(column * 0.1, row * 0.1, column * 0.1 + 0.002, row * 0.1 + 0.002)
        for column in range(30)
        for row in range(20)
    ]
    store = store_of(tmp_path, *islands)
    neighbour = box(2.94, -1, 4, 3)
    add_boundaries(db_path, {"WEST": box(-0.01, -0.01, 2.91, 1.91), "EAST": neighbour})
    area = named_area(db_path, "WEST")
    assert land._neighbours(db_path, area, area.geom) == []
    monkeypatch.setattr(land, "MAX_DISPLAY_VERTICES", 100)

    clip = clip_area_to_land(db_path, store, area)

    assert as_served(clip.display).intersection(neighbour).area < 1e-12


def test_outline_is_coarsened_until_it_has_few_enough_vertices(tmp_path, monkeypatch):
    store = store_of(tmp_path, harmonic_island(2000, west=0, south=0))
    frame = box(-1, -1, 4, 4)
    detailed = clip_to_land(store, frame, [], grow_deg=0)

    monkeypatch.setattr(land, "MAX_DISPLAY_VERTICES", 60)
    coarse = clip_to_land(store, frame, [], grow_deg=0)

    assert shapely.get_num_coordinates(detailed.display) > 60
    assert shapely.get_num_coordinates(coarse.display) <= 60
    assert coarse.geom.difference(coarse.display).area < 1e-12


def test_coarsening_cuts_the_sea_only_for_the_final_tolerances(monkeypatch):
    island = harmonic_island(2000, west=0, south=0)
    west = shapely.intersection(island, box(-1, -1, 1, 3))
    east = shapely.intersection(island, box(1, -1, 3, 3))
    parts = [west]
    neighbours = [east]
    frame_bounds = shapely.total_bounds(parts)
    tolerance_deg = land._display_tolerance(frame_bounds)
    limit_deg = land._conservative_reach_deg(frame_bounds)
    monkeypatch.setattr(land, "MAX_DISPLAY_VERTICES", 120)

    # Build the reference first so its cuts do not enter the count.
    expected, old_cuts = _outline_with_a_cut_per_round(
        parts, neighbours, tolerance_deg, True, limit_deg
    )

    cuts = []
    cut_once = land._cut_sea_at_borders

    def counting_cut(
        covered: BaseGeometry,
        land_union: BaseGeometry,
        border_lines: BaseGeometry,
        coast_lines: BaseGeometry,
        growth_deg: float,
        exclusion: BaseGeometry,
    ) -> BaseGeometry:
        cuts.append(1)
        return cut_once(covered, land_union, border_lines, coast_lines, growth_deg, exclusion)

    monkeypatch.setattr(land, "_cut_sea_at_borders", counting_cut)
    outline = land._display_outline(
        parts, neighbours, tolerance_deg, keep_in_reach=True, limit_deg=limit_deg
    )

    assert old_cuts > 2
    assert len(cuts) <= 2
    assert shapely.equals_exact(outline, expected, 0)


def _outline_with_a_cut_per_round(
    parts: list[Polygon],
    neighbours: list[BaseGeometry],
    tolerance_deg: float,
    keep_in_reach: bool,
    limit_deg: float,
) -> tuple[BaseGeometry, int]:
    """The outline the previous loop gave, cutting the sea on every tolerance round."""
    west, south, east, north = shapely.total_bounds(parts)
    span_deg = max(east - west, north - south)
    valid_neighbours = [part if part.is_valid else shapely.make_valid(part) for part in neighbours]
    land_union = shapely.union_all(parts)
    border_lines = land._shared_border_lines(land_union, valid_neighbours)
    coast_lines = land._coast_lines(land_union, border_lines)
    previous_vertices = None
    cuts = 0
    while True:
        growth_deg = land._display_growth(tolerance_deg, span_deg)
        shapes = [part if part.area >= tolerance_deg**2 else part.convex_hull for part in parts]
        simplified = shapely.simplify(shapes, tolerance_deg)
        collapsed = shapely.is_empty(simplified)
        simplified[collapsed] = shapely.envelope(np.array(shapes, dtype=object)[collapsed])
        grown = shapely.buffer(
            shapely.make_valid(simplified), growth_deg, quad_segs=land.DISPLAY_CORNER_SEGMENTS
        )
        covered = shapely.union_all(grown)
        exclusion = land._display_exclusion(valid_neighbours, covered)
        outline = land._cut_sea_at_borders(
            covered, land_union, border_lines, coast_lines, growth_deg, exclusion
        )
        cuts += 1
        vertices = shapely.get_num_coordinates(outline)
        stalled = (
            not exclusion.is_empty
            and previous_vertices is not None
            and vertices > previous_vertices * land.STALLED_RATIO
        )
        too_wide = keep_in_reach and land._display_growth(tolerance_deg * 2, span_deg) > limit_deg
        if (
            vertices <= land.MAX_DISPLAY_VERTICES
            or tolerance_deg >= span_deg
            or stalled
            or too_wide
        ):
            return outline, cuts

        previous_vertices = vertices
        tolerance_deg *= 2


def test_irrelevant_neighbour_does_not_change_coarsening(monkeypatch):
    monkeypatch.setattr(land, "MAX_DISPLAY_VERTICES", 8)
    parts = [box(0, 0, 1, 1)]
    frame_bounds = shapely.total_bounds(parts)
    tolerance_deg = land._display_tolerance(frame_bounds)
    limit_deg = land._conservative_reach_deg(frame_bounds)

    plain = land._display_outline(parts, [], tolerance_deg, keep_in_reach=True, limit_deg=limit_deg)
    with_far = land._display_outline(
        parts, [box(10, 10, 11, 11)], tolerance_deg, keep_in_reach=True, limit_deg=limit_deg
    )

    assert shapely.equals_exact(with_far, plain, 0)


def test_missing_store_is_unavailable_before_the_database_is_read(tmp_path):
    area = Area(box(0, 0, 1, 1))

    with pytest.raises(SourceUnavailable):
        clip_area_to_land(tmp_path / "missing.db", tmp_path / "land.sqlite", area)

    assert not (tmp_path / "missing.db").exists()


def test_all_sea_drawn_area_is_refused(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    store = store_of(tmp_path, box(0, 0, 1, 1))

    with pytest.raises(AreaError, match="no land"):
        clip_area_to_land(db_path, store, Area(box(10, 10, 11, 11)))


def test_clip_is_stored_for_each_land_version(tmp_path, monkeypatch):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    cuts = []
    clip_to_land_once = land.clip_to_land
    monkeypatch.setattr(
        land,
        "clip_to_land",
        lambda *args, **kwargs: cuts.append(1) or clip_to_land_once(*args, **kwargs),
    )
    area = Area(box(-1, -1, 2, 2))

    store = store_of(tmp_path, box(0, 0, 1, 1))
    first = clip_area_to_land(db_path, store, area)
    again = clip_area_to_land(db_path, store, area)
    newer = clip_area_to_land(
        db_path, store_of(tmp_path, box(0, 0, 1, 1), version="2026-12-01"), area
    )

    assert len(cuts) == 2
    assert first.geom.equals(again.geom)
    assert (first.land_version, newer.land_version) == (VERSION, "2026-12-01")


def test_clip_method_change_makes_a_new_clip_despite_a_warm_cache(tmp_path, monkeypatch):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    cuts = []
    clip_to_land_once = land.clip_to_land
    monkeypatch.setattr(
        land,
        "clip_to_land",
        lambda *args, **kwargs: cuts.append(1) or clip_to_land_once(*args, **kwargs),
    )
    area = Area(box(-1, -1, 2, 2))
    store = store_of(tmp_path, box(0, 0, 1, 1))

    first = clip_area_to_land(db_path, store, area)
    monkeypatch.setattr(land, "CLIP_METHOD_VERSION", land.CLIP_METHOD_VERSION + 1)
    second = clip_area_to_land(db_path, store, area)

    assert len(cuts) == 2
    assert second.geom.equals(first.geom)


def test_named_area_leaves_the_land_of_a_same_level_neighbour(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    west, east = box(0, 0, NEIGHBOUR_EDGE_DEG, 1), box(NEIGHBOUR_EDGE_DEG, 0, 2, 1)
    rows = [
        boundary_row(
            f"ovt:{name}", "state", name, bbox=part.bounds, geometry=json.dumps(mapping(part))
        )
        for name, part in (("WEST", west), ("EAST", east))
    ]
    db.add_boundaries(db_path, "Overture Maps divisions", rows)
    store = store_of(tmp_path, box(0, 0, 2, 1))

    clipped = clip_area_to_land(db_path, store, Area(west, db.get_boundary(db_path, "ovt:WEST")))

    assert clipped.geom.area == pytest.approx(NEIGHBOUR_EDGE_DEG)


def test_city_area_keeps_the_land_another_city_holds(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    west, east = box(0, 0, 1, 1), box(0.6, 0, 1.6, 1)
    rows = [
        boundary_row(
            f"ovt:{name}", "city", name, bbox=part.bounds, geometry=json.dumps(mapping(part))
        )
        for name, part in (("WEST", west), ("EAST", east))
    ]
    db.add_boundaries(db_path, "Overture Maps divisions", rows)
    store = store_of(tmp_path, box(0, 0, 1.6, 1))

    clipped = clip_area_to_land(db_path, store, Area(east, db.get_boundary(db_path, "ovt:EAST")))

    assert clipped.geom.area == pytest.approx(1)
    assert clipped.display.intersection(west).area > 0.3


def add_boundaries(db_path, parts):
    rows = [
        boundary_row(
            f"ovt:{name}", "state", name, bbox=part.bounds, geometry=json.dumps(mapping(part))
        )
        for name, part in parts.items()
    ]
    db.add_boundaries(db_path, "Overture Maps divisions", rows)


def named_area(db_path, name):
    boundary = db.get_boundary(db_path, f"ovt:{name}")
    return Area(shapely.from_geojson(boundary["geom_geojson"]), boundary)


def test_neighbour_only_change_makes_a_new_clip_despite_a_warm_cache(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    store = store_of(tmp_path, box(0, 0, 3, 1))
    west = box(0, 0, 1, 1)

    add_boundaries(db_path, {"WEST": west})
    alone = clip_area_to_land(db_path, store, named_area(db_path, "WEST"))
    add_boundaries(db_path, {"WEST": west, "EAST": box(NEIGHBOUR_EDGE_DEG, 0, 3, 1)})
    held = clip_area_to_land(db_path, store, named_area(db_path, "WEST"))
    again = clip_area_to_land(db_path, store, named_area(db_path, "WEST"))

    assert alone.geom.area == pytest.approx(1.02, abs=1e-6)
    assert held.geom.area == pytest.approx(1.0, abs=1e-6)
    assert held.neighbour_revision != alone.neighbour_revision
    assert again.neighbour_revision == held.neighbour_revision
    assert again.geom.equals(held.geom)


def add_overture(
    db_path: Path | str,
    parts: dict[str, BaseGeometry],
    level: str = "state",
    maritime: bool = True,
    border_level: int | None = None,
) -> None:
    """Store boundaries of the Overture source, with the maritime flag the clip reads."""
    rows = [
        boundary_row(
            f"ovt:{name}",
            level,
            name,
            iso3=name,
            bbox=part.bounds,
            geometry=json.dumps(mapping(part)),
            source=OVERTURE,
        )
        for name, part in parts.items()
    ]
    db.add_boundaries(db_path, OVERTURE, rows)
    with db.connect(db_path) as connection:
        connection.execute(
            "UPDATE boundaries SET has_maritime = ?, border_level = ?",
            (int(maritime), border_level),
        )


def overture_area(db_path: Path | str, name: str) -> Area:
    return land._named_area(db_path, f"ovt:{name}")


def test_territorial_area_clips_without_neighbours(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    west, east = box(-1, -1, 1.5, 2), box(1.5, -1, 4, 2)
    add_overture(db_path, {"WEST": west, "EAST": east})
    store = store_of(tmp_path, box(0, 0, 3, 1))

    clipped = clip_area_to_land(db_path, store, overture_area(db_path, "WEST"))

    assert clipped.geom.bounds == (0, 0, 1.5, 1)


def test_coast_following_area_keeps_grow_path(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_overture(db_path, {"WEST": box(0, 0, 1, 1)}, maritime=False)
    store = store_of(tmp_path, box(0, 0, 3, 1))

    clipped = clip_area_to_land(db_path, store, overture_area(db_path, "WEST"))

    assert clipped.geom.area == pytest.approx(1.02, abs=1e-6)


def test_county_with_a_maritime_extent_still_follows_the_coast(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_overture(db_path, {"WEST": box(0, 0, 1, 1)}, level="county")
    store = store_of(tmp_path, box(0, 0, 3, 1))

    clipped = clip_area_to_land(db_path, store, overture_area(db_path, "WEST"))

    assert clipped.geom.area == pytest.approx(1.02, abs=1e-6)


def test_display_stops_at_maritime_limit(tmp_path):
    margin_deg = 0.001
    frame = box(-margin_deg, -margin_deg, 1 + margin_deg, 1 + margin_deg)
    store = store_of(tmp_path, box(0, 0, 1, 1))

    clip = land.clip_territorial(store, frame, [])

    assert clip.display.difference(frame).area < 1e-12
    assert clip.display.bounds == pytest.approx(frame.bounds)


def test_disputed_border_segments_are_tagged(tmp_path):
    store = store_of(tmp_path, box(0, 0, 3, 1))
    disputed_line = LineString([(1.5, 0.4), (1.5, 3)])

    clip = land.clip_territorial(store, box(-1, -1, 1.5, 2), [disputed_line])

    assert clip.disputed.length == pytest.approx(0.6, abs=0.02)
    assert clip.borders.length == pytest.approx(0.4, abs=0.02)


def test_coast_following_borders_split_disputed_lines(tmp_path):
    store = store_of(tmp_path, box(0, 0, 3, 1))
    held = box(1, -1, 2, 2)
    disputed_line = LineString([(1, 0.4), (1, 3)])

    clip = clip_to_land(store, box(-1, -1, 1, 2), [held], disputed_lines=[disputed_line])

    assert clip.disputed.length == pytest.approx(0.6, abs=0.02)
    assert clip.borders.length == pytest.approx(0.4, abs=0.02)


def test_disputed_lines_are_stored_with_the_clip(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_overture(db_path, {"WEST": box(-1, -1, 1.5, 2)})
    with db.connect(db_path) as connection:
        line = shapely.to_wkb(LineString([(1.5, 0), (1.5, 1)]))
        connection.execute(
            "INSERT INTO disputed_lines VALUES ('d', 'state', 1.5, 0, 1.5, 1, ?)", (line,)
        )
    store = store_of(tmp_path, box(0, 0, 3, 1))
    area = overture_area(db_path, "WEST")
    frame = land.unwrap(area.geom)

    first = land._cached_clip(db_path, store, VERSION, area, frame)[0]
    again = land._cached_clip(db_path, store, VERSION, area, frame)[0]

    assert first.disputed.length == pytest.approx(1, abs=0.02)
    assert again.disputed.equals(first.disputed)


def add_disputed_line(db_path: Path | str, line: LineString) -> None:
    with db.connect(db_path) as connection:
        connection.execute("DELETE FROM disputed_lines")
        connection.execute(
            "INSERT INTO disputed_lines VALUES ('d', 'state', ?, ?, ?, ?, ?)",
            (*line.bounds, shapely.to_wkb(line)),
        )


def test_border_level_change_makes_a_new_clip_despite_a_warm_cache(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_overture(db_path, {"WEST": box(-1, -1, 1.5, 2)}, border_level=4)
    store = store_of(tmp_path, box(0, 0, 3, 1))
    first = clip_area_to_land(db_path, store, overture_area(db_path, "WEST"))

    with db.connect(db_path) as connection:
        connection.execute("UPDATE boundaries SET border_level = 8")
    again = clip_area_to_land(db_path, store, overture_area(db_path, "WEST"))

    assert again.neighbour_revision != first.neighbour_revision


def test_disputed_line_change_makes_a_new_clip_despite_a_warm_cache(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_overture(db_path, {"WEST": box(-1, -1, 1.5, 2)})
    store = store_of(tmp_path, box(0, 0, 3, 1))
    add_disputed_line(db_path, LineString([(1.5, 0), (1.5, 0.5)]))
    area = overture_area(db_path, "WEST")
    frame = land.unwrap(area.geom)
    first = land._cached_clip(db_path, store, VERSION, area, frame)[0]

    add_disputed_line(db_path, LineString([(1.5, 0), (1.5, 1)]))
    again = land._cached_clip(db_path, store, VERSION, area, frame)[0]

    assert again.disputed.length == pytest.approx(1, abs=0.02)
    assert first.disputed.length == pytest.approx(0.5, abs=0.02)


def test_territorial_and_coast_following_clips_of_one_frame_have_different_revisions(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_overture(db_path, {"WEST": box(0, 0, 1, 1)})
    store = store_of(tmp_path, box(0, 0, 3, 1))
    first = clip_area_to_land(db_path, store, overture_area(db_path, "WEST"))

    with db.connect(db_path) as connection:
        connection.execute("UPDATE boundaries SET has_maritime = 0")
    again = clip_area_to_land(db_path, store, overture_area(db_path, "WEST"))

    assert again.neighbour_revision != first.neighbour_revision
    assert again.geom.area > first.geom.area


@pytest.mark.parametrize(
    ("border_level", "zoom"), [(2, 5), (4, 5), (5, 9), (6, 9), (7, 11), (8, 11), (9, 12), (10, 12)]
)
def test_border_tolerance_follows_level(border_level, zoom):
    half_pixel_deg = 360 / 512 / 2**zoom / 2

    assert land._border_tolerance_deg(border_level, (0, 0, 1, 1)) == pytest.approx(half_pixel_deg)


def test_border_without_a_level_is_simplified_like_the_outline():
    bounds = (0, 0, 40, 10)

    assert land._border_tolerance_deg(None, bounds) == land._display_tolerance(bounds)


def test_combined_clip_is_union_of_members(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    main, island = box(0, 0, 1, 1), box(3, 0, 4, 1)
    add_overture(db_path, {"AA": main, "BB": island}, level="country")
    combined = boundary_row(
        "ovt:AA+overseas",
        "country",
        "AA with BB",
        bbox=(0, 0, 4, 1),
        geometry=json.dumps(mapping(MultiPolygon([main, island]))),
        source=OVERTURE,
    )
    db.add_boundaries(db_path, "Overture combined", [combined])
    with db.connect(db_path) as connection:
        connection.executemany(
            "INSERT INTO boundary_parts VALUES (?, ?, ?)",
            [("ovt:AA", 0, "ovt:AA"), ("ovt:AA", 1, "ovt:BB")],
        )
    store = store_of(tmp_path, box(0, 0, 1, 1), box(3, 0, 4, 1))

    clipped = clip_area_to_land(db_path, store, overture_area(db_path, "AA+overseas"))

    assert clipped.geom.area == pytest.approx(2)
    assert len(clipped.geom.geoms) == 2


def add_combined(db_path: Path | str, members: dict[str, BaseGeometry]) -> None:
    """Store the members as countries and a combined area of them, named after the first."""
    add_overture(db_path, members, level="country")
    first = next(iter(members))
    merged = MultiPolygon([part for geometry in members.values() for part in polygons_of(geometry)])
    combined = boundary_row(
        f"ovt:{first}+overseas",
        "country",
        "combined",
        bbox=merged.bounds,
        geometry=json.dumps(mapping(merged)),
        source=OVERTURE,
    )
    db.add_boundaries(db_path, "Overture combined", [combined])
    with db.connect(db_path) as connection:
        connection.execute("DELETE FROM boundary_parts")
        connection.executemany(
            "INSERT INTO boundary_parts VALUES (?, ?, ?)",
            [(f"ovt:{first}", position, f"ovt:{name}") for position, name in enumerate(members)],
        )


def polygons_of(geometry: BaseGeometry) -> list[Polygon]:
    return list(getattr(geometry, "geoms", [geometry]))


def test_combined_borders_leave_out_the_edge_that_members_share(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_combined(db_path, {"AA": box(0, 0, 1, 1), "BB": box(1, 0, 2, 1)})
    add_disputed_line(db_path, LineString([(0, -1), (0, 2)]))
    store = store_of(tmp_path, box(-1, -1, 3, 2))

    area = overture_area(db_path, "AA+overseas")
    clipped = land._cached_clip(db_path, store, VERSION, area, land.unwrap(area.geom))[0]
    shared = LineString([(1, 0), (1, 1)])

    assert clipped.borders.intersection(shared).length == pytest.approx(0, abs=1e-9)
    assert clipped.disputed.intersection(shared).length == pytest.approx(0, abs=1e-9)
    # The disputed zone borrows 0.01 degrees off each neighbouring edge.
    assert clipped.borders.length == pytest.approx(4.98, abs=1e-6)
    assert clipped.disputed.length == pytest.approx(1.02, abs=1e-6)
    assert clipped.borders.length + clipped.disputed.length == pytest.approx(6, abs=1e-9)


def test_combined_borders_keep_narrow_touching_members(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_combined(db_path, {"AA": box(-0.005, 0, 0, 1), "BB": box(0, 0, 0.005, 1)})
    store = store_of(tmp_path, box(-0.01, -0.01, 0.01, 1.01))

    area = overture_area(db_path, "AA+overseas")
    clipped = land._cached_clip(db_path, store, VERSION, area, land.unwrap(area.geom))[0]
    shared = LineString([(0, 0), (0, 1)])

    assert clipped.borders.intersection(shared).length == pytest.approx(0, abs=1e-9)
    assert clipped.borders.length == pytest.approx(2.02, abs=1e-6)


def test_combined_borders_leave_out_a_curved_shared_edge_segmented_differently(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    curve = [(1 + 0.1 * float(np.sin(np.pi * step / 8)), step / 8) for step in range(9)]
    midpoints = [((x1 + x2) / 2, (y1 + y2) / 2) for (x1, y1), (x2, y2) in pairwise(curve)]
    finer = sorted([*curve, *midpoints], key=lambda point: point[1])
    add_combined(
        db_path,
        {"AA": Polygon([(0, 0), *curve, (0, 1)]), "BB": Polygon([(2, 0), (2, 1), *finer[::-1]])},
    )
    store = store_of(tmp_path, box(-1, -1, 3, 2))

    area = overture_area(db_path, "AA+overseas")
    clipped = land._cached_clip(db_path, store, VERSION, area, land.unwrap(area.geom))[0]

    interior = LineString(curve[1:-1]).buffer(1e-6)

    assert clipped.borders.intersection(interior).length == 0
    assert clipped.disputed.is_empty
    assert clipped.borders.length == pytest.approx(6, abs=1e-6)


def test_combined_clip_ignores_member_order(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_combined(db_path, {"AA": box(0, 0, 1, 1), "BB": box(3, 0, 4, 1)})
    store = store_of(tmp_path, box(0, 0, 1, 1), box(3, 0, 4, 1))
    area = overture_area(db_path, "AA+overseas")
    frame = land.unwrap(area.geom)
    first_revision = land._clip_revision(db_path, area, frame, [])
    first = clip_area_to_land(db_path, store, area)

    with db.connect(db_path) as connection:
        # Negating reverses the member order without colliding positions.
        connection.execute("UPDATE boundary_parts SET position = -position")
    area = overture_area(db_path, "AA+overseas")
    frame = land.unwrap(area.geom)
    again_revision = land._clip_revision(db_path, area, frame, [])
    again = clip_area_to_land(db_path, store, area)

    assert again_revision == first_revision
    assert again.neighbour_revision == first.neighbour_revision
    assert again.geom.equals(first.geom)


def test_member_change_makes_a_new_combined_clip_despite_a_warm_cache(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_combined(db_path, {"AA": box(0, 0, 1, 1), "BB": box(3, 0, 4, 1)})
    store = store_of(tmp_path, box(0, 0, 1, 1), box(3, 0, 4, 1))
    first = clip_area_to_land(db_path, store, overture_area(db_path, "AA+overseas"))

    add_disputed_line(db_path, LineString([(0, 0.2), (0, 0.4)]))
    again = clip_area_to_land(db_path, store, overture_area(db_path, "AA+overseas"))

    assert again.neighbour_revision != first.neighbour_revision


def test_membership_change_makes_a_new_combined_clip_despite_a_warm_cache(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_combined(db_path, {"AA": box(0, 0, 1, 1), "BB": box(3, 0, 4, 1)})
    store = store_of(tmp_path, box(0, 0, 1, 1), box(3, 0, 4, 1))
    first = clip_area_to_land(db_path, store, overture_area(db_path, "AA+overseas"))

    with db.connect(db_path) as connection:
        connection.execute("DELETE FROM boundary_parts WHERE member_id = 'ovt:BB'")
    again = clip_area_to_land(db_path, store, overture_area(db_path, "AA+overseas"))

    assert again.neighbour_revision != first.neighbour_revision
    assert again.geom.area == pytest.approx(1)


def test_unassigned_land_report_sums_country_land_no_state_holds(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_overture(db_path, {"AAA": box(0, 0, 2, 1)}, level="country", maritime=False)
    rows = [
        boundary_row(
            "ovt:AAA-1",
            "state",
            "One",
            iso3="AAA",
            bbox=(0, 0, 1, 1),
            geometry=json.dumps(mapping(box(0, 0, 1, 1))),
            source=OVERTURE,
        )
    ]
    db.add_boundaries(db_path, "Overture states", rows)
    store = store_of(tmp_path, box(0, 0, 2, 1))

    report = land.unassigned_land_report(db_path, store)

    assert [country_id for country_id, _ in report] == ["ovt:AAA"]
    assert report[0][1] == pytest.approx(0.98 * 111.32**2, rel=0.01)


def test_unassigned_land_report_matches_states_across_180(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    country = box(170, 0, 200, 1)
    add_overture(db_path, {"AAA": country}, level="country", maritime=False)
    rows = [
        boundary_row(
            "ovt:AAA-1",
            "state",
            "One",
            iso3="AAA",
            bbox=(-180, 0, -160, 1),
            geometry=json.dumps(mapping(box(-180, 0, -160, 1))),
            source=OVERTURE,
        ),
        boundary_row(
            "ovt:AAA-2",
            "state",
            "Two",
            iso3="AAA",
            bbox=(170, 0, 180, 1),
            geometry=json.dumps(mapping(box(170, 0, 180, 1))),
            source=OVERTURE,
        ),
    ]
    db.add_boundaries(db_path, "Overture states", rows)
    store = store_of(tmp_path, box(170, 0, 180, 1), box(-180, 0, -160, 1))

    report = land.unassigned_land_report(db_path, store)

    assert report[0][1] == pytest.approx(0, abs=1)


def test_neighbour_across_180_is_found_from_the_western_side(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    store = store_of(tmp_path, box(179, 0, 180, 1), box(-180, 0, -179.4, 1))
    target = box(-179.8, 0, -178.5, 1)
    neighbour = box(179, 0, 180.2, 1)
    add_boundaries(db_path, {"WEST": target, "EAST": neighbour})

    clipped = clip_area_to_land(db_path, store, named_area(db_path, "WEST"))

    assert clipped.geom.bounds[0] == pytest.approx(-179.8)


def test_neighbour_found_only_through_the_grown_bounds_across_180(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    store = store_of(tmp_path, box(179.5, 0, 180, 1), box(-180, 0, -179.5, 1))
    target = box(179.5, 0, 179.99, 1)
    neighbour = box(-180, 0, -179.5, 1)
    add_boundaries(db_path, {"WEST": target, "EAST": neighbour})

    clipped = clip_area_to_land(db_path, store, named_area(db_path, "WEST"))

    assert clipped.geom.area == pytest.approx(0.5, abs=1e-6)


def test_import_stores_the_clip_of_every_country_and_state_once(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    shapes = {"AAA": ("country", box(0, 0, 1, 1)), "BBB": ("state", box(2, 2, 3, 3))}
    rows = [
        boundary_row(
            f"ovt:{name}",
            level,
            name,
            bbox=part.bounds,
            geometry=json.dumps(mapping(part)),
            source=OVERTURE,
        )
        for name, (level, part) in shapes.items()
    ]
    rows.append(
        boundary_row(
            "ovt:CCC",
            "county",
            "CCC",
            bbox=(4, 4, 5, 5),
            geometry=json.dumps(mapping(box(4, 4, 5, 5))),
            source=OVERTURE,
        )
    )
    db.add_boundaries(db_path, OVERTURE, rows)
    store = store_of(tmp_path, box(0, 0, 1, 1), box(2, 2, 3, 3), box(4, 4, 5, 5))

    assert store_clips(db_path, store) == 2
    assert store_clips(db_path, store) == 0


def test_area_that_breaks_the_clip_is_skipped_not_raised(tmp_path, monkeypatch, capsys):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    add_boundaries(db_path, {"WEST": box(0, 0, 1, 1)})
    store = store_of(tmp_path, box(0, 0, 1, 1))

    def broken(db_path: Path | str, store: Path | str, area: Area) -> Area:
        raise ShapelyError("boom")

    monkeypatch.setattr(land, "clip_area_to_land", broken)

    assert land._store_clip(db_path, store, "ovt:WEST") is False
    skipped = capsys.readouterr().out
    assert "ovt:WEST" in skipped
    assert "boom" in skipped


def test_land_version_is_the_stored_date(tmp_path):
    assert land_version(store_of(tmp_path, box(0, 0, 1, 1))) == VERSION


def test_land_clips_of_older_versions_are_deleted(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    wkbs = (b"a", b"b", b"c", b"d")
    method = land.CLIP_METHOD_VERSION
    db.set_land_clip(db_path, "x", "old", method, wkbs)
    db.set_land_clip(db_path, "x", VERSION, method - 1, wkbs)
    db.set_land_clip(db_path, "x", VERSION, method, wkbs)

    assert db.delete_land_clips_except(db_path, VERSION, method) == 2
    assert db.get_land_clip(db_path, "x", "old", method) is None
    assert db.get_land_clip(db_path, "x", VERSION, method - 1) is None
    assert db.get_land_clip(db_path, "x", VERSION, method) == wkbs


def test_clip_of_a_multipolygon_area_keeps_each_island(tmp_path):
    store = store_of(tmp_path, box(0, 0, 1, 1), box(3, 3, 4, 4))
    frame = MultiPolygon([box(-1, -1, 2, 2), box(2, 2, 5, 5)])

    clip = clip_to_land(store, frame, [])

    assert len(clip.geom.geoms) == 2


def test_downloaded_zip_is_stored_and_leaves_no_copy_behind(tmp_path):
    gpd = pytest.importorskip("geopandas")
    source = tmp_path / "source"
    source.mkdir()
    gpd.GeoDataFrame(geometry=[box(0, 0, 1, 1), box(5, 5, 6, 6)], crs="EPSG:4326").to_file(
        source / "land_polygons.shp"
    )
    archive = tmp_path / "land-polygons-split-4326.zip"
    with zipfile.ZipFile(archive, "w") as zipped:
        for member in source.iterdir():
            zipped.write(member, f"land-polygons-split-4326/{member.name}")

    store = tmp_path / "data" / "land.sqlite"
    land._download_land(archive.as_uri(), store, VERSION)

    assert land_version(store) == VERSION
    assert [polygon.bounds for polygon in land_in(store, (4, 4, 7, 7))] == [(5, 5, 6, 6)]
    assert sorted(path.name for path in store.parent.iterdir()) == ["land.sqlite"]
