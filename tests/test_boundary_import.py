"""Offline tests: boundary storage and the CGAZ / UCDB boundary import."""
import pytest
from shapely.geometry import box

from soe import db


def test_add_boundaries_replaces_duplicate_ids(tmp_path):
    path = str(tmp_path / "soe.db")
    db.init(path)
    row = (
        "x:1",
        "state",
        "Dup",
        "",
        "TST",
        0,
        0,
        1,
        1,
        400,
        "{}",
        "geoBoundaries CGAZ",
        "CC BY 4.0",
    )

    assert db.add_boundaries(path, "geoBoundaries CGAZ", [row, row, ("x:2",) + row[1:]]) == 1
    assert len(db.search(path, "Dup")) == 2


def test_import_boundaries_tiny_geopackage(tmp_path):
    gpd = pytest.importorskip("geopandas")
    from soe.boundary_import import import_cgaz, import_ucdb

    country, state, county = box(36, -2, 38, 0), box(36, -2, 37, 0), box(36, -1, 36.5, 0)
    levels = ((0, country, "Testland"), (1, state, "West State"), (2, county, "Small County"))
    for level, geometry, name in levels:
        gpd.GeoDataFrame(
            {"shapeName": [name], "shapeGroup": ["TST"], "shapeID": [f"id{level}"]},
            geometry=[geometry],
            crs=4326,
        ).to_file(tmp_path / f"geoBoundariesCGAZ_ADM{level}.gpkg")

    cities = gpd.GeoDataFrame(
        {
            "GC_UCN_MAI_2025": ["Big City", "Small Town"],
            "GC_POP_TOT_2025": [2e6, 5e4],
            "GC_CNT_GAD_2025": ["Testland", "Testland"],
        },
        geometry=[box(36.5, -1.5, 36.9, -1.1), box(37, -1, 37.1, -0.9)],
        crs=4326,
    )
    cities.to_file(tmp_path / "ucdb.gpkg", layer="GHS_UCDB_THEME_GENERAL_CHARACTERISTICS")

    path = str(tmp_path / "soe.db")
    db.init(path)

    assert import_cgaz(path, tmp_path) == 3
    assert import_ucdb(path, tmp_path / "ucdb.gpkg") == 1

    county_row = db.search(path, "small", "county")[0]
    assert county_row["parent_name"] == "West State" and county_row["iso3"] == "TST"

    assert db.search(path, "t")[0]["level"] == "country"
    assert db.search(path, "big")[0]["level"] == "city"
    assert db.get_boundary(path, "ucdb:0")["licence"] == "CC BY 4.0"
