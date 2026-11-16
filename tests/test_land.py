"""Test cutting areas to the land polygons with a small hand-made store and no network."""

import json
import zipfile
from pathlib import Path

import pytest
import shapely
from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiPolygon,
    Point,
    Polygon,
    box,
    mapping,
)

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

    rounded = shapely.set_precision(clip.display, land.OUTLINE_PRECISION_DEG)
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

    rounded = shapely.set_precision(clip.display, land.OUTLINE_PRECISION_DEG)
    assert clip.geom.intersection(neighbour).area < 1e-12
    assert clip.display.intersection(neighbour).area < 1e-12
    assert rounded.intersection(neighbour).area < 1e-12


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

    rounded = shapely.set_precision(clip.display, land.OUTLINE_PRECISION_DEG)
    assert clip.display.intersection(neighbour).area < 1e-12
    assert rounded.intersection(neighbour).area < 1e-12


def test_outline_is_coarsened_until_it_has_few_enough_vertices(tmp_path, monkeypatch):
    store = store_of(tmp_path, harmonic_island(2000, west=0, south=0))
    frame = box(-1, -1, 4, 4)
    detailed = clip_to_land(store, frame, [])

    monkeypatch.setattr(land, "MAX_DISPLAY_VERTICES", 60)
    coarse = clip_to_land(store, frame, [])

    assert shapely.get_num_coordinates(detailed.display) > 60
    assert shapely.get_num_coordinates(coarse.display) <= 60


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
            f"cgaz:ADM1:{name}", "state", name, bbox=part.bounds, geometry=json.dumps(mapping(part))
        )
        for name, part in (("WEST", west), ("EAST", east))
    ]
    db.add_boundaries(db_path, "geoBoundaries CGAZ", rows)
    store = store_of(tmp_path, box(0, 0, 2, 1))

    clipped = clip_area_to_land(
        db_path, store, Area(west, db.get_boundary(db_path, "cgaz:ADM1:WEST"))
    )

    assert clipped.geom.area == pytest.approx(NEIGHBOUR_EDGE_DEG)


def add_boundaries(db_path, parts):
    rows = [
        boundary_row(
            f"cgaz:ADM1:{name}", "state", name, bbox=part.bounds, geometry=json.dumps(mapping(part))
        )
        for name, part in parts.items()
    ]
    db.add_boundaries(db_path, "geoBoundaries CGAZ", rows)


def named_area(db_path, name):
    boundary = db.get_boundary(db_path, f"cgaz:ADM1:{name}")
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
    shapes = {"ADM0:AAA": ("country", box(0, 0, 1, 1)), "ADM1:BBB": ("state", box(2, 2, 3, 3))}
    rows = [
        boundary_row(
            f"cgaz:{name}", level, name, bbox=part.bounds, geometry=json.dumps(mapping(part))
        )
        for name, (level, part) in shapes.items()
    ]
    rows.append(
        boundary_row(
            "cgaz:ADM2:CCC",
            "county",
            "CCC",
            bbox=(4, 4, 5, 5),
            geometry=json.dumps(mapping(box(4, 4, 5, 5))),
        )
    )
    db.add_boundaries(db_path, "geoBoundaries CGAZ", rows)
    store = store_of(tmp_path, box(0, 0, 1, 1), box(2, 2, 3, 3), box(4, 4, 5, 5))

    assert store_clips(db_path, store) == 2
    assert store_clips(db_path, store) == 0


def test_land_version_is_the_stored_date(tmp_path):
    assert land_version(store_of(tmp_path, box(0, 0, 1, 1))) == VERSION


def test_land_clips_of_older_versions_are_deleted(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    wkbs = (b"a", b"b", b"c")
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
