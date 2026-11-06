"""Offline tests: boundary storage and the CGAZ / UCDB boundary import."""
import json

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
    # ADM0 has no shapeID and its id column is empty, so the ISO3 group names a country.
    countries = gpd.GeoDataFrame(
        {"shapeName": ["Testland", "Examplia"], "shapeGroup": ["TST", "EXM"], "id": ["", ""]},
        geometry=[country, box(40, -2, 42, 0)],
        crs=4326,
    )
    countries.to_file(tmp_path / "geoBoundariesCGAZ_ADM0.gpkg")
    for level, geometry, name in ((1, state, "West State"), (2, county, "Small County")):
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

    assert import_cgaz(path, tmp_path) == 4
    assert import_ucdb(path, tmp_path / "ucdb.gpkg") == 1

    county_row = db.search(path, "small", "county")[0]
    assert county_row["parent_name"] == "West State" and county_row["iso3"] == "TST"

    assert db.search(path, "t")[0]["level"] == "country"
    assert db.search(path, "big")[0]["level"] == "city"
    assert db.get_boundary(path, "ucdb:0")["licence"] == "CC BY 4.0"

    assert db.get_boundary(path, "cgaz:ADM0:TST")["name"] == "Testland"
    assert db.get_boundary(path, "cgaz:ADM0:EXM")["name"] == "Examplia"

    # Country ids come from the ISO3 group, so reversing the input order keeps both rows.
    (tmp_path / "geoBoundariesCGAZ_ADM0.gpkg").unlink()
    countries.iloc[::-1].to_file(tmp_path / "geoBoundariesCGAZ_ADM0.gpkg")
    assert import_cgaz(path, tmp_path) == 4
    assert db.get_boundary(path, "cgaz:ADM0:TST")["name"] == "Testland"
    assert db.get_boundary(path, "cgaz:ADM0:EXM")["name"] == "Examplia"


def test_self_intersecting_shape_is_repaired_into_a_row():
    from shapely.geometry import Polygon

    from soe.boundary_import import CGAZ_SOURCE, _row

    bowtie = Polygon([(36, 4), (38, 6), (38, 4), (36, 6), (36, 4)])
    row = _row(
        "cgaz:ADM0:TST",
        "country",
        "Testland",
        "",
        "TST",
        bowtie,
        CGAZ_SOURCE,
    )

    assert row is not None
    assert row[1] == "country"
    assert tuple(row[5:9]) == pytest.approx((36.0, 4.0, 38.0, 6.0))


def test_shape_without_polygons_is_skipped_with_a_reason(capsys):
    from shapely.geometry import LineString

    from soe.boundary_import import CGAZ_SOURCE, _row

    row = _row(
        "cgaz:ADM0:OLD",
        "country",
        "Nowhere",
        "",
        "OLD",
        LineString([(36, 4), (38, 6)]),
        CGAZ_SOURCE,
    )

    assert row is None
    assert "skipping cgaz:ADM0:OLD" in capsys.readouterr().out


def test_overlapping_shape_parts_are_repaired_into_a_row():
    from shapely.geometry import MultiPolygon, box

    from soe.boundary_import import CGAZ_SOURCE, _row

    overlap = MultiPolygon([box(36, 4, 38, 6), box(37, 5, 39, 7)])
    row = _row(
        "cgaz:ADM2:TST",
        "county",
        "Twin County",
        "Testland",
        "TST",
        overlap,
        CGAZ_SOURCE,
    )

    assert row is not None
    assert tuple(row[5:9]) == pytest.approx((36.0, 4.0, 39.0, 7.0))


def test_touching_shape_parts_are_repaired_after_simplify():
    import json

    from shapely.geometry import MultiPolygon, Polygon, shape

    from soe.boundary_import import CGAZ_SOURCE, _row

    # Simplify absorbs the shared vertex, so only the second repair keeps the stored row valid.
    main = Polygon(
        [
            (36.0058902, 4.0005864),
            (36.0059937, 4.0003626),
            (36.00734, 4.0017799),
            (36.0075471, 4.0020037),
            (36.0075471, 4.0020783),
            (36.0080649, 4.0026751),
            (36.0080649, 4.0032719),
            (36.0089969, 4.0052861),
            (36.0105502, 4.0066289),
            (36.0114822, 4.0100604),
            (36.0115858, 4.0084192),
            (36.0121036, 4.0105826),
            (36.0128285, 4.0106572),
            (36.012, 4.012),
            (36.014796, 4.0139396),
            (36.0143818, 4.0173711),
            (36.0143818, 4.0175203),
            (36.0171778, 4.0214741),
            (36.0163494, 4.0218471),
            (36.0164529, 4.0221455),
            (36.0173849, 4.0216979),
            (36.0168671, 4.022966),
            (36.0176004, 4.024),
            (36.024, 4.024),
            (36.024, 4.0),
            (36.0051913, 4.0),
            (36.0058902, 4.0005864),
        ]
    )
    sliver = Polygon(
        [
            (36.0115858, 4.0111794),
            (36.012, 4.012),
            (36.0115858, 4.010508),
            (36.0115858, 4.0111794),
        ]
    )
    row = _row(
        "cgaz:ADM2:TOUCH",
        "county",
        "Touch County",
        "Testland",
        "TST",
        MultiPolygon([main, sliver]),
        CGAZ_SOURCE,
    )

    assert row is not None
    stored = shape(json.loads(row[10]))
    assert stored.geom_type in ("Polygon", "MultiPolygon")
    assert stored.is_valid
    assert stored.area == pytest.approx(0.0002920974)


def test_shape_without_a_name_is_skipped_with_a_reason(capsys):
    from shapely.geometry import box

    from soe.boundary_import import CGAZ_SOURCE, _row

    row = _row(
        "cgaz:ADM2:NONAME",
        "county",
        float("nan"),
        "Testland",
        "TST",
        box(36, 4, 38, 6),
        CGAZ_SOURCE,
    )

    assert row is None
    assert "skipping cgaz:ADM2:NONAME" in capsys.readouterr().out


def test_normalise_kind_depluralises_and_title_cases():
    from soe.boundary_import import normalise_kind

    assert normalise_kind("Counties") == "County"
    assert normalise_kind("Sub-Counties") == "Sub-County"
    assert normalise_kind("Parishes") == "Parish"
    assert normalise_kind("Contiguous Regions") == "Contiguous Region"
    assert normalise_kind("Contiguous") == "Contiguous"
    assert normalise_kind("Houses") == "House"
    assert normalise_kind("districts") == "District"
    assert normalise_kind("States and Territories") == "State and Territory"
    assert normalise_kind("State / Union Territory") == "State / Union Territory"
    assert normalise_kind("Bundesländer") == "Bundesländer"
    assert normalise_kind("Canton") == "Canton"


def test_normalise_kind_drops_placeholders_and_long_phrases():
    from soe.boundary_import import normalise_kind

    assert normalise_kind("Unknown") is None
    assert normalise_kind("gbOpen") is None
    assert normalise_kind("  ") is None
    assert normalise_kind("Counties and Unitary Authorities") is None
    assert normalise_kind("Municipalities and Towns") == "Municipality and Town"


def test_normalise_kind_overrides_keep_small_exceptions():
    from soe.boundary_import import normalise_kind

    assert normalise_kind("Okres") == "Okres"
    assert normalise_kind("Regiões") == "Região"
    assert normalise_kind("Croatia") is None


def test_import_admin_kinds_stores_names_per_country_and_level(tmp_path):
    from soe.boundary_import import import_admin_kinds

    folder = tmp_path / "meta"
    folder.mkdir()
    (folder / "gbOpen-ADM1.json").write_text(
        json.dumps(
            [
                {"boundaryISO": "KEN", "boundaryCanonical": "Counties"},
                {"boundaryISO": "JPN", "boundaryCanonical": "Unknown"},
            ],
        ),
        encoding="utf-8",
    )
    (folder / "gbOpen-ADM2.json").write_text(
        json.dumps([{"boundaryISO": "KEN", "boundaryCanonical": "Sub-Counties"}]),
        encoding="utf-8",
    )
    path = str(tmp_path / "soe.db")
    db.init(path)

    assert import_admin_kinds(path, folder) == 2

    with db.connect(path) as connection:
        stored = {
            (row["iso3"], row["level"]): row["kind"]
            for row in connection.execute("SELECT iso3, level, kind FROM admin_kinds")
        }

    assert stored == {("KEN", "state"): "County", ("KEN", "county"): "Sub-County"}


def test_import_admin_kinds_without_metadata_exits(tmp_path):
    from soe.boundary_import import import_admin_kinds

    path = str(tmp_path / "soe.db")
    db.init(path)

    with pytest.raises(SystemExit):
        import_admin_kinds(path, tmp_path)
