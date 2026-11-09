"""Test the regional geology patchwork: name tables, compositing, provenance and notices."""
import json
import logging
import struct
from pathlib import Path

import numpy as np
import pytest
import rasterio
import zarr
from rasterio.transform import from_origin
import shapely
from shapely.geometry import box

from soe.areas import Area
from soe.build import build_scene
from soe.bundle import validate
from soe.geology_age import AGE_VALUES
from soe.geology_type import GLIM_VALUES, LITHOLOGY_SOURCE_TAG, OPENLANDMAP_SOURCE
from soe.geology_regional import (
    BASE_CODE,
    CANADA_AGE_FILE,
    CANADA_CODE,
    CANADA_TYPE_FILE,
    CODE_MEANINGS,
    CODE_VALUES,
    ALASKA_AGE_FILE,
    ALASKA_TYPE_FILE,
    GMNA_AGE_FILE,
    GMNA_TYPE_FILE,
    IGME_CODE,
    SGMC_AGE_FILE,
    SGMC_CODE,
    SGMC_TYPE_FILE,
    candidates_for,
    composite_values,
    read_composited,
    regional_notices,
    sources_for_kind,
    used_in,
)
from soe.ingest.geology_classification import (
    canada_age_batch,
    canada_type_batch,
    class_value,
    egdi_type_batch,
    family_value,
    gmna_age_batch,
    gmna_type_batch,
    igme_age_batch,
    igme_type_batch,
    sgmc_age_batch,
    sgmc_type_batch,
    sim3340_age_batch,
    sim3340_type_batch,
)
from soe.ingest.geology_names import EGDI_TYPE_NAMES
from soe.ingest.geology_regional import (
    GMNA_SHAPE,
    SIM3340_DIR,
    SIM3340_GDB,
    _close_wkb_rings,
    _gmna_geometry,
    _reproject_egdi_tile,
    _split_at_antimeridian,
    _write_egdi_classes,
    ingest_egdi,
    ingest_geology_regional,
    ingest_gmna,
    ingest_sim3340,
)
from soe.scene_request import compute_scene_id
from soe.sources import RealSource, SyntheticSource, make_registry
from soe.sources.licences import SOURCES
from tests.helpers import BOUNDARY, HASH_A, NAIROBI

SWITZERLAND = (5.9, 45.8, 10.5, 47.8)  # in the IGME5000 and EGDI footprints
KENYA = (33.9, -4.7, 41.9, 5.0)  # outside every regional footprint
USA_BBOX_DEG = (-110.0, 35.0, -100.0, 42.0)
TORONTO_BBOX_DEG = (-80.0, 43.0, -79.0, 44.0)


def write_cog(
    path: Path,
    values: np.ndarray,
    west: float = 0.0,
    north: float = 5.0,
    res: float = 1.0,
    tag: str = "test",
) -> None:
    """Write a tiny tagged uint8 COG of `values`."""
    height, width = values.shape
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        dtype="uint8",
        count=1,
        width=width,
        height=height,
        crs="EPSG:4326",
        transform=from_origin(west, north, res, res),
        nodata=0,
        tiled=True,
    ) as raster:
        raster.write(values.astype("uint8"), 1)
        raster.update_tags(**{LITHOLOGY_SOURCE_TAG: tag})


@pytest.fixture
def patchwork_cubes(tmp_path):
    """Cubes with a base age map and one regional age patch over its middle cell."""
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    base = np.array([[AGE_VALUES["Cambrian"], 0], [AGE_VALUES["Jurassic"], 0]], "uint8")
    write_cog(cubes / "geology_age.tif", base, west=-100.0, north=42.0, tag="gsc-of5529")
    patch = np.array([[0, 0], [AGE_VALUES["Cretaceous"], 0]], "uint8")
    write_cog(cubes / "geology_age_canada.tif", patch, west=-100.0, north=42.0, tag="canada-5m")
    return cubes


@pytest.fixture
def id_cubes(tmp_path):
    """Cubes with base and regional (Canada and SGMC) rock-age and rock-type COGs."""
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    ones = np.ones((2, 2), "uint8")
    write_cog(cubes / "geology_age.tif", ones, tag="gsc-of5529")
    write_cog(cubes / "lithology.tif", ones, tag="glim")
    for file in (CANADA_AGE_FILE, CANADA_TYPE_FILE, SGMC_AGE_FILE, SGMC_TYPE_FILE):
        write_cog(cubes / file, ones)
    return cubes


@pytest.fixture
def toronto_cubes(tmp_path):
    """Cubes covering Toronto with a Canada patch over two of its cells."""
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    base = np.full((4, 4), AGE_VALUES["Cambrian"], "uint8")
    write_cog(cubes / "geology_age.tif", base, west=-80.0, north=44.0, res=0.5)
    patch = np.zeros((4, 4), "uint8")
    patch[0, 0] = AGE_VALUES["Cretaceous"]
    patch[1, 1] = AGE_VALUES["Jurassic"]
    write_cog(cubes / "geology_age_canada.tif", patch, west=-80.0, north=44.0, res=0.5)
    return cubes


def test_sources_for_kind_lists_only_suppliers_in_priority_order():
    assert [source["id"] for source in sources_for_kind("age")] == [
        "north_america_gmna",
        "alaska_sim3340",
        "europe_igme5000",
        "canada_5m",
        "us_sgmc",
    ]
    assert [source["id"] for source in sources_for_kind("type")] == [
        "north_america_gmna",
        "alaska_sim3340",
        "europe_igme5000",
        "canada_5m",
        "europe_egdi",
        "us_sgmc",
    ]


def test_candidates_need_a_footprint_hit_and_a_file_on_disk(tmp_path):
    present = {"geology_age_canada.tif"}
    canada = [source for source in sources_for_kind("age") if source["id"] == "canada_5m"][0]

    assert candidates_for("age", (36.5, -1.5, 37.5, -0.5), present.__contains__) == []
    assert candidates_for("age", (-100.0, 40.0, -99.0, 41.0), present.__contains__) == [canada]
    assert candidates_for("type", (-100.0, 40.0, -99.0, 41.0), set().__contains__) == []


def test_candidates_find_regional_sources_for_a_zero_to_360_bbox():
    present = {"geology_age_canada.tif", "geology_age_sgmc.tif"}
    found = candidates_for("age", (235.0, 24.0, 294.0, 50.0), present.__contains__)

    assert [source["id"] for source in found] == ["canada_5m", "us_sgmc"]


@pytest.mark.parametrize("bbox", [(144.0, 40.0, 146.0, 41.0), (140.0, -40.0, 145.0, -39.0)])
def test_candidates_ignore_a_bbox_outside_every_footprint(bbox):
    found = candidates_for("type", bbox, lambda file: True)

    assert found == []


def test_later_sources_win_and_missing_cells_keep_the_earlier_value():
    base = np.array([[1, 0], [1, 1]], "uint8")
    low = np.array([[0, 0], [2, 0]], "uint8")
    high = np.array([[0, 0], [3, 3]], "uint8")

    value, codes = composite_values(base, [(IGME_CODE, low), (CANADA_CODE, high)])

    assert value.tolist() == [[1, 0], [3, 3]]
    assert codes.tolist() == [[BASE_CODE, 0], [CANADA_CODE, CANADA_CODE]]


def test_used_in_lists_the_base_first_then_priority_order():
    codes = np.array([[1, 5, 3], [0, 2, 4]], "uint8")

    assert used_in(codes) == (
        "global_base",
        "europe_igme5000",
        "canada_5m",
        "europe_egdi",
        "us_sgmc",
    )
    assert used_in(np.zeros((2, 3), "uint8")) == ()


def test_regional_notices_name_scale_and_representation():
    notices = regional_notices(("canada_5m", "europe_igme5000"), "age")

    assert len(notices) == 2
    assert "1:5,000,000" in notices[0] and "bedrock" in notices[0]
    assert "bedrock geology" in notices[1]


def test_sgmc_notice_says_its_representation_varies_by_state():
    (notice,) = regional_notices(("us_sgmc",), "type")

    assert "depending on the state" in notice


def test_canada_ranges_take_the_smallest_containing_class():
    values = canada_age_batch(
        [
            ("Paleozoic", "Carboniferous-Permian", "undivided Carboniferous-Permian"),
            ("Cenozoic", "Tertiary", "Miocene"),
            ("Precambrian", "Archean-Proterozoic", " "),
        ],
    )

    assert values == [
        AGE_VALUES["Paleozoic undivided"],
        AGE_VALUES["Neogene"],
        AGE_VALUES["Precambrian undivided"],
    ]


def test_canada_triassic_jurassic_epoch_keeps_the_whole_period_range():
    values = canada_age_batch([("Mesozoic", "Triassic-Jurassic", "undivided Triassic-Jurassic")])

    assert values == [AGE_VALUES["Mesozoic undivided"]]


def test_canada_blank_names_fall_back_or_stay_no_data():
    assert canada_age_batch([("Cenozoic", " ", " ")]) == [AGE_VALUES["Cenozoic undivided"]]
    assert canada_age_batch([("unknown", "unknown", "unknown")]) == [None]
    assert canada_type_batch([("sedimentary rocks", " ")]) == [class_value("smmx")]
    assert canada_type_batch([("intrusive rocks", " ")]) == [None]


def test_canada_grain_names_map_to_level2_classes():
    assert canada_type_batch([("sedimentary rocks", "conglomerate and sandstone")]) == [
        class_value("ssss"),
    ]
    assert canada_type_batch([("sedimentary rocks", "carbonate")]) == [class_value("scmx")]


def test_canada_marble_maps_to_the_pure_metamorphic_class():
    assert canada_type_batch([("metamorphic rocks", "marble")]) == [class_value("mtpu")]


def test_canada_unknown_names_fail_with_the_full_list():
    with pytest.raises(ValueError, match="BOGUS.*WEIRD|WEIRD.*BOGUS"):
        canada_age_batch([("Cenozoic", "BOGUS", " "), ("WEIRD", "Cambrian", " ")])


def test_igme_ranges_span_eras_and_orogenies_are_judged_wide():
    values = igme_age_batch(
        ["Cambrian - Ordovician", "Late Cretaceous", "Neogene", "Variscan"],
    )

    assert values[0] == AGE_VALUES["Paleozoic undivided"]
    assert values[1] == AGE_VALUES["Cretaceous"]
    assert values[2] == AGE_VALUES["Neogene"]
    assert values[3] == AGE_VALUES["Paleozoic undivided"]


def test_igme_unknown_sides_fail_with_the_full_list():
    with pytest.raises(ValueError, match="BOGUS"):
        igme_age_batch(["Cambrian", "BOGUS - Ordovician"])


def test_igme_types_map_classes_and_blanks_fall_back():
    values = igme_type_batch(
        [
            ("granite", None, None, None),
            ("basalt", None, None, None),
            ("gneiss", None, None, None),
            (None, None, "volcanite Precambrian", None),
            (None, "basalt", None, None),
            (None, None, None, None),
        ],
    )

    assert values == [
        class_value("pa__"),
        class_value("vb__"),
        class_value("mt__"),
        class_value("vb__"),
        class_value("vb__"),
        None,
    ]


def test_igme_loose_and_lithified_names_split_grain():
    assert igme_type_batch([("sandstone", None, None, None)]) == [class_value("ssss")]
    assert igme_type_batch([("sand", None, None, None)]) == [class_value("suss")]
    assert igme_type_batch([("claystone", None, None, None)]) == [class_value("sssh")]
    assert igme_type_batch([("clay", None, None, None)]) == [class_value("sush")]
    assert igme_type_batch([("limestone", None, None, None)]) == [class_value("scpu")]
    assert igme_type_batch([("marl", None, None, None)]) == [class_value("smsh")]
    assert igme_type_batch([("coal", None, None, None)]) == [class_value("smor")]
    assert igme_type_batch([("gravel", None, None, None)]) == [class_value("suss")]


def test_igme_siliceous_ooze_is_loose_fine_sediment_unlike_chert():
    assert igme_type_batch([("siliceous ooze", None, None, None)]) == [class_value("sush")]
    assert igme_type_batch([("chert", None, None, None)]) == [class_value("sssh")]


def test_sgmc_leaf_names_class_by_period_not_ma():
    values = sgmc_age_batch(
        [
            (
                "Phanerozoic - Paleozoic - Cambrian - Furongian",
                "Phanerozoic - Paleozoic - Cambrian",
            ),
            (
                "Phanerozoic - Cenozoic - Tertiary-Neogene - Miocene",
                "Phanerozoic - Cenozoic - Quaternary",
            ),
            ("", ""),
        ],
    )

    assert values == [AGE_VALUES["Cambrian"], AGE_VALUES["Cenozoic undivided"], None]


def test_sgmc_unknown_leaves_fail_with_the_full_list():
    with pytest.raises(ValueError, match="BOGUS"):
        sgmc_age_batch([("Phanerozoic - BOGUS", "Phanerozoic - Cambrian")])


@pytest.mark.parametrize("level", [1, 2, 3, 4])
@pytest.mark.parametrize("lith1", ["Igneous", "Sedimentary"])
def test_sgmc_unknown_names_fail_at_every_hierarchy_level(lith1, level):
    record = [lith1, "", "", "", ""]
    record[level] = "BOGUS"

    with pytest.raises(ValueError, match="BOGUS"):
        sgmc_type_batch([tuple(record)])


def test_sgmc_batch_lists_every_unknown_name_at_once():
    records = [
        ("Igneous", "BOGUS", "WEIRD", "", ""),
        ("Sedimentary", "Clastic", "ODD", "", ""),
        ("Atlantis", "", "", "", ""),
    ]

    with pytest.raises(ValueError) as error:
        sgmc_type_batch(records)

    assert all(name in str(error.value) for name in ("BOGUS", "WEIRD", "ODD", "Atlantis"))


def test_sgmc_hierarchies_map_composition_to_level2_classes():
    records = [
        ("Sedimentary", "Chemical", "Evaporite", "Gypsum", ""),
        ("Sedimentary", "Chemical", "Chert", "", ""),
        ("Sedimentary", "Carbonate", "Limestone", "Chalk", ""),
        ("Sedimentary", "Carbonate", "Marlstone", "", ""),
        ("Sedimentary", "Clastic", "Sandstone", "", ""),
        ("Sedimentary", "Clastic", "Shale", "", ""),
        ("Sedimentary", "Clastic", "Sandstone-mudstone", "", ""),
        ("Sedimentary", "Coal", "Lignite", "", ""),
        ("Igneous", "Volcanic", "Mafic-volcanic", "Basalt", ""),
        ("Igneous", "Volcanic", "Alkalic-volcanic", "Basanite", ""),
        ("Igneous", "Volcanic", "Alkalic-volcanic", "Phonolite", ""),
        ("Igneous", "Volcanic", "Alkalic-volcanic", "Trachyte", ""),
        ("Igneous", "Plutonic", "Granitic", "Granite", ""),
        ("Igneous", "Plutonic", "Charnockite", "", ""),
        ("Igneous", "Plutonic", "Syenitic", "Quartz-monzonite", ""),
        ("Igneous", "Hypabyssal", "Lamprophyre", "", ""),
        ("Metamorphic", "Schist", "", "", ""),
        ("Metamorphic", "Slate", "", "", ""),
        ("Unconsolidated", "Coarse-detrital", "Sand", "", ""),
        ("Unconsolidated", "Fine-detrital", "Silt", "", ""),
        ("Unconsolidated", "Peat", "", "", ""),
    ]

    assert sgmc_type_batch(records) == [
        class_value("evpu"),
        class_value("sssh"),
        class_value("scpu"),
        class_value("smsh"),
        class_value("ssss"),
        class_value("sssh"),
        class_value("ssmx"),
        class_value("smor"),
        class_value("vb__"),
        class_value("vb__"),
        class_value("va__"),
        class_value("vi__"),
        class_value("pa__"),
        class_value("pa__"),
        class_value("pi__"),
        class_value("pb__"),
        class_value("mt__"),
        class_value("mtsh"),
        class_value("suss"),
        class_value("sush"),
        class_value("suor"),
    ]
    with pytest.raises(ValueError, match="BOGUS"):
        sgmc_type_batch([("BOGUS", "", "", "", "")])


@pytest.mark.parametrize(
    ("hierarchy", "code"),
    [
        (("Sedimentary", "Carbonate", "Limestone", "Coquina", ""), "scss"),
        (("Sedimentary", "Carbonate", "Limestone", "Calcarenite", ""), "scss"),
        (("Sedimentary", "Carbonate", "Limestone", "", ""), "scpu"),
        (("Sedimentary", "Carbonate", "Limestone", "Chalk", ""), "scpu"),
        (("Sedimentary", "Carbonate", "", "", ""), "scmx"),
        (("Sedimentary", "Carbonate", "Marlstone", "", ""), "smsh"),
    ],
)
def test_sgmc_carbonates_take_the_deepest_applicable_name(hierarchy, code):
    assert sgmc_type_batch([hierarchy]) == [class_value(code)]


def test_metamorphic_names_agree_across_sources():
    assert sgmc_type_batch([("Metamorphic", "Marble", "", "", "")]) == [class_value("mtpu")]
    assert sgmc_type_batch([("Metamorphic", "Metasedimentary", "Quartzite", "", "")]) == [
        class_value("mtpu"),
    ]
    assert sgmc_type_batch([("Metamorphic", "Amphibolite", "", "", "")]) == [class_value("mtam")]
    assert igme_type_batch([("marble", None, None, None)]) == [class_value("mtpu")]
    assert igme_type_batch([("amphibolite", None, None, None)]) == [class_value("mtam")]
    assert egdi_type_batch([2]) == [class_value("mtam")]


def test_sgmc_names_with_known_substrings_still_fail():
    records = [
        ("Igneous", "Volcanic", "BOGUS volcanic", "", ""),
        ("Sedimentary", "Clastic", "WEIRD basalt", "", ""),
    ]

    with pytest.raises(ValueError) as error:
        sgmc_type_batch(records)

    assert all(name in str(error.value) for name in ("BOGUS volcanic", "WEIRD basalt"))


def test_sim3340_ages_take_the_finest_name_of_each_path_and_alias_odd_spellings():
    values = sim3340_age_batch(
        [
            ("Phanerozoic;Cenozoic;Quaternary;Holocene", "Phanerozoic;Cenozoic;Quaternary"),
            ("Phanerozoic;Paleozoic;Cambrian;Series 2", "Proterozoic;Neoproterozoic;Ediacarian"),
            ("Phanerozoic;Mesozoic;Cretaceous;Valanginian", "Phanerozoic;Mesozoic"),
        ],
    )

    assert values == [
        AGE_VALUES["Quaternary"],
        AGE_VALUES["Precambrian to Phanerozoic"],
        AGE_VALUES["Mesozoic undivided"],
    ]


def test_sim3340_unknown_age_names_fail_with_the_full_list():
    with pytest.raises(ValueError, match="BOGUS.*ODD"):
        sim3340_age_batch([("Phanerozoic;BOGUS", "Phanerozoic;ODD")])


def test_sim3340_types_alias_spellings_and_leave_water_to_the_base_map():
    values = sim3340_type_batch(
        [
            ("Sedimentary", "Clastic", "Quartzose-sandstone", "", ""),
            ("Water", "", "", "", ""),
            ("Igneous", "Plutonic", "Gabbronorite", "", ""),
        ],
    )

    assert values == [class_value("ssss"), None, class_value("pb__")]


def test_sim3340_unknown_names_fail_with_the_full_list():
    records = [("Igneous", "BOGUS", "", "", ""), ("Water", "ODD", "", "", "")]
    with pytest.raises(ValueError, match="BOGUS"):
        sim3340_type_batch(records)


def test_gmna_ages_take_the_whole_range_of_each_side():
    values = gmna_age_batch(
        [
            ("Quaternary", "Tertiary"),
            ("Precambrian", "Precambrian"),
            ("Middle Devonian", "Middle Devonian"),
            ("Maastrichtian", "Campanian"),
            ("Age unknown", "Age unknown"),
        ],
    )

    assert values == [
        AGE_VALUES["Cenozoic undivided"],
        AGE_VALUES["Precambrian undivided"],
        AGE_VALUES["Devonian"],
        AGE_VALUES["Cretaceous"],
        None,
    ]


def test_gmna_pre_ranges_span_their_whole_allowance():
    values = gmna_age_batch(
        [("Pre-Cenozoic", "Pre-Cenozoic"), ("Pre-Mesozoic", "Pre-Mesozoic")],
    )

    assert values == [
        AGE_VALUES["Precambrian to Phanerozoic"],
        AGE_VALUES["Precambrian to Phanerozoic"],
    ]


def test_gmna_unknown_age_names_fail_with_the_full_list():
    with pytest.raises(ValueError, match="BOGUS"):
        gmna_age_batch([("Cretaceous", "BOGUS")])
    with pytest.raises(ValueError, match="Pre-Cenozoic"):
        gmna_age_batch([("Pre-Cenozoic", "Cretaceous")])


def test_gmna_types_map_rock_groups_and_lithologies_to_level2_classes():
    values = gmna_type_batch(
        [
            ("Sedimentary", ""),
            ("Sedimentary", "carbonate"),
            ("Sedimentary", "evaporite"),
            ("Volcanic", "mafic rocks"),
            ("Volcanic", "felsic rocks"),
            ("Volcanic", "intermediate rocks"),
            ("Volcanic", "alkaline mafic rocks"),
            ("Volcanic", "undivided volcanic rocks"),
            ("Volcanic", "interlayered sedimentary and volcanic rocks"),
            ("Plutonic", "granite"),
            ("Plutonic", "mafic rocks"),
            ("Plutonic", "intermediate rocks"),
            ("Plutonic", "tonalite"),
            ("Plutonic", "felsite"),
            ("Plutonic", "diabase"),
            ("Plutonic", "undivided granitic rocks"),
            ("Metamorphic and undivided crystalline", "marble"),
            ("Metamorphic and undivided crystalline", "orthogneiss"),
            ("Metamorphic and undivided crystalline", "volcanic gneiss"),
            ("Metamorphic and undivided crystalline", "impact breccia"),
            (
                "Metamorphic and undivided crystalline",
                "undivided crystalline rocks (seafloor units may include "
                "a variety of metamorphosed rock)",
            ),
            ("Ice", ""),
        ],
    )

    assert values == [
        class_value("smmx"),
        class_value("scmx"),
        class_value("ev__"),
        class_value("vb__"),
        class_value("va__"),
        class_value("vi__"),
        class_value("vb__"),
        class_value("vi__"),
        class_value("smmx"),
        class_value("pa__"),
        class_value("pb__"),
        class_value("pi__"),
        class_value("pa__"),
        class_value("pa__"),
        class_value("pb__"),
        class_value("pa__"),
        class_value("mtpu"),
        class_value("mt__"),
        class_value("mt__"),
        class_value("mt__"),
        class_value("mt__"),
        class_value("ig__"),
    ]


def test_gmna_unknown_rock_names_fail_with_the_full_list():
    with pytest.raises(ValueError, match="BOGUS"):
        gmna_type_batch([("Sedimentary", "BOGUS"), ("Atlantis", "")])


def test_a_polygon_over_the_antimeridian_is_split_into_its_two_sides():
    wrapped = box(-179.5, 52.0, 179.5, 53.0)

    parts = _split_at_antimeridian(wrapped)

    assert parts.bounds == pytest.approx((-180.0, 52.0, 180.0, 53.0))
    assert parts.area == pytest.approx(1.0)
    assert not parts.intersects(box(-100.0, 52.0, 100.0, 53.0))


@pytest.mark.parametrize(
    "bbox",
    [(172.0, 52.0, 176.0, 53.0), (-160.0, 60.0, -150.0, 65.0), (170.0, 50.0, 220.0, 70.0)],
)
def test_alaska_footprint_covers_attu_the_mainland_and_scenes_across_180(bbox):
    found = candidates_for("age", bbox, lambda _: True)

    assert "alaska_sim3340" in [source["id"] for source in found]


@pytest.mark.parametrize(
    "bbox",
    [
        (-99.3, 19.2, -99.0, 19.5),
        (-55.0, 64.0, -50.0, 65.0),
        (-24.0, 63.5, -14.0, 66.0),
        (190.0, 55.0, 210.0, 65.0),
    ],
)
def test_gmna_footprint_covers_mexico_greenland_iceland_and_zero_to_360_scenes(bbox):
    present = {"geology_age_gmna.tif", "geology_type_gmna.tif"}
    found = candidates_for("age", bbox, present.__contains__)

    assert [source["id"] for source in found] == ["north_america_gmna"]


def test_gmna_is_lowest_priority_where_alaska_and_canada_overlap():
    present = {
        "geology_age_gmna.tif",
        "geology_age_alaska.tif",
        "geology_age_canada.tif",
        "geology_age_sgmc.tif",
    }
    found = candidates_for("age", (-152.0, 60.0, -150.0, 61.0), present.__contains__)

    assert [source["id"] for source in found] == [
        "north_america_gmna",
        "alaska_sim3340",
        "canada_5m",
    ]


def test_egdi_unknown_values_fail_and_generic_values_are_no_data():
    with pytest.raises(ValueError, match="999"):
        egdi_type_batch([999])
    assert egdi_type_batch([8, 93, 121, 122, 123]) == [class_value("vb__"), None, None, None, None]


def test_egdi_loose_and_lithified_names_split_grain():
    assert egdi_type_batch([95]) == [class_value("ssss")]
    assert egdi_type_batch([94]) == [class_value("suss")]
    assert egdi_type_batch([24]) == [class_value("sssh")]
    assert egdi_type_batch([23]) == [class_value("sush")]
    assert egdi_type_batch([50]) == [class_value("suss")]
    assert egdi_type_batch([78]) == [class_value("suor")]
    assert egdi_type_batch([61]) == [class_value("scpu")]
    assert egdi_type_batch([51]) == [class_value("evpu")]


def test_egdi_combined_ash_and_lapilli_tuff_is_mixed_grain_pyroclastic():
    assert egdi_type_batch([7]) == [class_value("pymx")]


def test_egdi_table_covers_the_whole_legend_with_known_classes():
    assert sorted(EGDI_TYPE_NAMES) == list(range(1, 124))
    assert all(code in GLIM_VALUES for code in EGDI_TYPE_NAMES.values() if code)
    assert {code[:2] for code in EGDI_TYPE_NAMES.values() if code} <= {
        "ev",
        "ig",
        "mt",
        "pa",
        "pb",
        "pi",
        "py",
        "sc",
        "sm",
        "ss",
        "su",
        "va",
        "vb",
        "vi",
    }


def test_family_values_are_glim_undivided_variants():
    assert GLIM_VALUES["pa__"] == family_value("pa")
    assert family_value("su") == GLIM_VALUES["sumx"]
    assert family_value("ss") == GLIM_VALUES["ssmx"]
    assert family_value("sm") == GLIM_VALUES["smmx"]
    assert family_value("sc") == GLIM_VALUES["scmx"]
    assert all(
        family_value(family) == GLIM_VALUES[family + "__"]
        for family in ("ev", "py", "va", "vi", "vb", "pa", "pi", "pb", "mt", "ig")
    )


def test_read_composited_overlays_the_regional_patch(patchwork_cubes):
    backend = RealSource(cubes_dir=patchwork_cubes)

    value, codes, _ = read_composited(
        backend,
        "age",
        "geology_age.tif",
        (-100.0, 40.0, -98.0, 42.0),
        1.0,
    )

    assert value.tolist() == [[AGE_VALUES["Cambrian"], 0], [AGE_VALUES["Cretaceous"], 0]]
    assert codes.tolist() == [[BASE_CODE, 0], [CANADA_CODE, 0]]


def test_read_composited_applies_the_patch_past_the_antimeridian(patchwork_cubes):
    backend = RealSource(cubes_dir=patchwork_cubes)
    west, east, resolution = 170.0, 262.0, 1.0
    patch_west = -100.0 + 360.0
    antimeridian_column = round((180.0 - west) / resolution)
    patch_column = round((patch_west - west) / resolution)

    value, codes, _ = read_composited(
        backend,
        "age",
        "geology_age.tif",
        (west, 40.0, east, 42.0),
        resolution,
    )

    assert value.shape == (2, 92)
    assert value[:, patch_column:patch_column + 2].tolist() == [
        [AGE_VALUES["Cambrian"], 0],
        [AGE_VALUES["Cretaceous"], 0],
    ]
    assert codes[:, patch_column:patch_column + 2].tolist() == [
        [BASE_CODE, 0],
        [CANADA_CODE, 0],
    ]
    # Mode resampling copies edge cells outward, so only the far part is asserted zero.
    assert (value[:, :antimeridian_column] == 0).all()
    assert (codes[:, :antimeridian_column] == 0).all()
    assert set(np.unique(value)) <= {0, AGE_VALUES["Cambrian"], AGE_VALUES["Cretaceous"]}
    assert set(np.unique(codes)) <= {0, BASE_CODE, CANADA_CODE}


def test_missing_regional_files_are_skipped_silently(patchwork_cubes):
    backend = RealSource(cubes_dir=patchwork_cubes)
    (patchwork_cubes / "geology_age_canada.tif").unlink()

    value, codes, _ = read_composited(
        backend,
        "age",
        "geology_age.tif",
        (-100.0, 40.0, -98.0, 42.0),
        1.0,
    )

    assert value.tolist() == [[AGE_VALUES["Cambrian"], 0], [AGE_VALUES["Jurassic"], 0]]
    assert codes.tolist() == [[BASE_CODE, 0], [BASE_CODE, 0]]


def test_regional_sources_are_absent_offline():
    backend = SyntheticSource(geology_age=True, lithology=True)
    assert make_registry(backend)["geology_age"].sources_for((0.0, 0.0, 1.0, 1.0))[1:] == []


def scene_id(folder: Path, layers: list[str], bbox: tuple[float, ...] | None = None) -> str:
    registry = make_registry(RealSource(cubes_dir=folder))
    datasets = [registry[layer_id] for layer_id in layers]
    bboxes = {layer_id: bbox for layer_id in layers} if bbox else None
    return compute_scene_id("poly:abc", layers, None, datasets, {}, bboxes)


def test_non_geology_scene_ids_ignore_installed_regional_sources(patchwork_cubes, tmp_path):
    plain = ["terrain", "esa_worldcover"]

    assert scene_id(patchwork_cubes, plain) == scene_id(tmp_path, plain)


def test_geology_scene_ids_change_with_the_global_base_version(
    patchwork_cubes,
    monkeypatch,
):
    before = scene_id(patchwork_cubes, ["geology_age"])
    monkeypatch.setitem(SOURCES["gsc_world"], "version", SOURCES["gsc_world"]["version"] + "-x")

    assert scene_id(patchwork_cubes, ["geology_age"]) != before


def test_geology_scene_ids_change_when_a_regional_source_is_installed_or_removed(
    patchwork_cubes,
):
    with_canada = scene_id(patchwork_cubes, ["geology_age"])
    (patchwork_cubes / "geology_age_canada.tif").unlink()
    without = scene_id(patchwork_cubes, ["geology_age"])
    write_cog(
        patchwork_cubes / "geology_age_sgmc.tif",
        np.zeros((2, 2), "uint8"),
        west=-100.0,
        north=42.0,
    )

    assert with_canada != without
    assert scene_id(patchwork_cubes, ["geology_age"]) != without


def test_geology_scene_ids_change_with_a_regional_source_version_over_its_footprint(
    id_cubes,
    monkeypatch,
):
    before = scene_id(id_cubes, ["geology"], USA_BBOX_DEG)
    monkeypatch.setitem(SOURCES["us_sgmc"], "version", "sgmc-next")

    assert scene_id(id_cubes, ["geology"], USA_BBOX_DEG) != before


def test_geology_scene_ids_ignore_regional_versions_outside_the_footprint(
    id_cubes,
    monkeypatch,
):
    before = scene_id(id_cubes, ["geology"], KENYA)
    monkeypatch.setitem(SOURCES["us_sgmc"], "version", "sgmc-next")
    monkeypatch.setitem(SOURCES["canada_5m"], "version", "canada-5m-next")

    assert scene_id(id_cubes, ["geology"], KENYA) == before


def test_age_scene_ids_ignore_a_rock_type_only_version_bump(id_cubes, monkeypatch):
    before = scene_id(id_cubes, ["geology_age"], TORONTO_BBOX_DEG)
    monkeypatch.setitem(SOURCES["canada_5m"], "version", "canada-5m-next")

    assert scene_id(id_cubes, ["geology_age"], TORONTO_BBOX_DEG) == before


def test_age_scene_ids_change_with_a_regional_age_version(id_cubes, monkeypatch):
    before = scene_id(id_cubes, ["geology_age"], TORONTO_BBOX_DEG)
    monkeypatch.setitem(SOURCES["canada_5m"], "age_version", "canada-5m-next")

    assert scene_id(id_cubes, ["geology_age"], TORONTO_BBOX_DEG) != before


def test_geology_scene_ids_without_regional_sources_are_unchanged(tmp_path):
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    write_cog(cubes / "geology_age.tif", np.ones((2, 2), "uint8"), tag="gsc-of5529")
    registry = make_registry(RealSource(cubes_dir=cubes))

    assert registry["geology_age"].regional_versions((-180.0, -90.0, 180.0, 90.0)) == []


def test_unknown_regional_source_is_refused(tmp_path):
    with pytest.raises(ValueError, match="unknown regional source"):
        ingest_geology_regional(tmp_path, "atlantis")


def build_age_scene(cubes: Path, area: Area, scenes: Path) -> tuple[dict, zarr.Group]:
    """Build the age layer over area and return its scene.json and Zarr root."""
    registry = make_registry(RealSource(cubes_dir=cubes))
    build_scene(HASH_A, area, None, None, [registry["geology_age"]], "T", scenes)
    doc = json.loads((scenes / HASH_A / "scene.json").read_text(encoding="utf-8"))
    return doc, zarr.open_group(str(scenes / HASH_A / "data.zarr"), mode="r")


def canada_age_source() -> dict:
    """Return the Canada licence entry as the rock-age layer reports it."""
    return {**SOURCES["canada_5m"], "version": SOURCES["canada_5m"]["age_version"]}


def write_age_patchwork(cubes: Path, patches: dict[str, np.ndarray]) -> None:
    """Write a 4 by 4 base map of Cambrian and one regional age COG per patch."""
    cubes.mkdir()
    base = np.full((4, 4), AGE_VALUES["Cambrian"], "uint8")
    write_cog(cubes / "geology_age.tif", base, west=-100.0, north=42.0, res=0.5)
    for file, patch in patches.items():
        write_cog(cubes / file, patch, west=-100.0, north=42.0, res=0.5)


def test_only_used_sources_are_credited(patchwork_cubes, tmp_path):
    doc, _ = build_age_scene(patchwork_cubes, Area(NAIROBI, BOUNDARY), tmp_path)
    layer = doc["layers"][0]

    assert validate(doc) == []
    assert layer.get("fallback_sources", []) == []
    assert SOURCES["canada_5m"]["attribution"] not in doc["credits"]["lines"]
    assert SOURCES["gsc_world"]["attribution"] in doc["credits"]["lines"]


def test_a_used_regional_source_is_credited_noticed_and_coded(toronto_cubes, tmp_path):
    doc, root = build_age_scene(toronto_cubes, Area(box(-80.0, 43.0, -79.0, 44.0)), tmp_path)
    layer = doc["layers"][0]
    codes = root["geology_age/provenance"][...]
    mask = root["geology_age/mask"][...]

    assert validate(doc) == []
    assert layer["fallback_sources"] == [canada_age_source()]
    assert SOURCES["canada_5m"]["attribution"] in doc["credits"]["lines"]
    assert any("Canada" in notice for notice in doc["notices"]["limits"])
    assert layer["arrays"]["provenance"]["dtype"] == "uint8"
    assert root["geology_age/provenance"].attrs["flag_meanings"] == list(CODE_MEANINGS)
    assert root["geology_age/provenance"].attrs["flag_values"] == list(CODE_VALUES)
    assert set(np.unique(codes[mask == 1])) == {BASE_CODE, CANADA_CODE}
    assert (codes[mask == 0] == 0).all()


def test_an_all_zero_regional_patch_is_not_credited_or_noticed(tmp_path):
    cubes = tmp_path / "cubes"
    write_age_patchwork(cubes, {"geology_age_canada.tif": np.zeros((4, 4), "uint8")})

    doc, _ = build_age_scene(cubes, Area(box(-100.0, 41.0, -99.0, 42.0)), tmp_path / "scenes")

    assert validate(doc) == []
    assert doc["layers"][0].get("fallback_sources", []) == []
    assert SOURCES["canada_5m"]["attribution"] not in doc["credits"]["lines"]
    assert not any("Canada" in notice for notice in doc["notices"]["limits"])


def test_a_fully_superseded_lower_priority_patch_is_not_credited(tmp_path):
    cubes = tmp_path / "cubes"
    write_age_patchwork(
        cubes,
        {
            "geology_age_canada.tif": np.full((4, 4), AGE_VALUES["Jurassic"], "uint8"),
            "geology_age_sgmc.tif": np.full((4, 4), AGE_VALUES["Permian"], "uint8"),
        },
    )

    doc, _ = build_age_scene(cubes, Area(box(-100.0, 41.0, -99.0, 42.0)), tmp_path / "scenes")
    lines = doc["credits"]["lines"]

    assert SOURCES["us_sgmc"]["attribution"] in lines
    assert SOURCES["canada_5m"]["attribution"] not in lines
    assert not any("Canada" in notice for notice in doc["notices"]["limits"])


def test_a_fully_replaced_base_map_is_not_credited(tmp_path):
    cubes = tmp_path / "cubes"
    write_age_patchwork(
        cubes,
        {"geology_age_canada.tif": np.full((4, 4), AGE_VALUES["Jurassic"], "uint8")},
    )

    doc, _ = build_age_scene(cubes, Area(box(-100.0, 41.0, -99.0, 42.0)), tmp_path / "scenes")
    layer = doc["layers"][0]

    assert validate(doc) == []
    assert layer["source"] == canada_age_source()
    assert SOURCES["gsc_world"]["attribution"] not in doc["credits"]["lines"]


def test_a_source_behind_only_the_ring_is_still_credited(tmp_path):
    cubes = tmp_path / "cubes"
    patch = np.zeros((4, 4), "uint8")
    patch[0, 2] = AGE_VALUES["Jurassic"]
    write_age_patchwork(cubes, {"geology_age_canada.tif": patch})

    doc, root = build_age_scene(cubes, Area(box(-100.0, 41.0, -99.0, 42.0)), tmp_path / "scenes")
    codes = root["geology_age/provenance"][...]
    mask = root["geology_age/mask"][...]

    assert (codes[(mask == 2) & (codes == CANADA_CODE)]).size > 0
    assert SOURCES["canada_5m"]["attribution"] in doc["credits"]["lines"]


def test_regional_rock_types_take_the_openlandmap_classes_of_an_openlandmap_base(tmp_path):
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    base = np.full((2, 2), 13, "uint8")
    write_cog(cubes / "lithology.tif", base, west=-100.0, north=42.0, tag=OPENLANDMAP_SOURCE)
    patch = np.array([[class_value("pa__"), 0], [class_value("scmx"), 0]], "uint8")
    write_cog(cubes / "geology_type_canada.tif", patch, west=-100.0, north=42.0)

    value, codes, _ = read_composited(
        RealSource(cubes_dir=cubes),
        "type",
        "lithology.tif",
        (-100.0, 40.0, -98.0, 42.0),
        1.0,
    )

    assert value.tolist() == [[1, 13], [5, 13]]
    assert codes.tolist() == [[CANADA_CODE, BASE_CODE], [CANADA_CODE, BASE_CODE]]


def test_egdi_raster_is_reprojected_with_mode_resampling(tmp_path, monkeypatch):
    from soe.ingest import geology_regional as regional_ingest

    monkeypatch.setitem(EGDI_TYPE_NAMES, 1, "ssss")
    monkeypatch.setitem(EGDI_TYPE_NAMES, 2, "pa__")
    monkeypatch.setattr(regional_ingest, "LITHOLOGY_RES_DEG", 0.05)
    source = tmp_path / "egdi_3035.tif"
    with rasterio.open(
        source,
        "w",
        driver="GTiff",
        dtype="uint8",
        count=1,
        width=40,
        height=40,
        crs="EPSG:3035",
        transform=from_origin(4_000_000, 2_510_000, 250, 250),
        nodata=0,
    ) as raster:
        raster.write(np.array([[1] * 20 + [2] * 20] * 40, "uint8"), 1)
    cubes = tmp_path / "cubes"
    cubes.mkdir()

    (published,) = ingest_egdi(cubes, source)

    with rasterio.open(published) as cog:
        assert cog.tags()[LITHOLOGY_SOURCE_TAG] == "egdi"
        values = cog.read(1)
    assert set(np.unique(values)) == {0, class_value("ssss"), class_value("pa__")}


def test_egdi_nodata_never_wins_the_mode_vote(tmp_path):
    source = tmp_path / "egdi_nodata_3035.tif"
    with rasterio.open(
        source,
        "w",
        driver="GTiff",
        dtype="float64",
        count=1,
        width=2,
        height=2,
        crs="EPSG:4326",
        transform=from_origin(0.0, 2.0, 1.0, 1.0),
        nodata=32767,
    ) as raster:
        raster.write(np.array([[8.0, 32767.0], [32767.0, 32767.0]]), 1)
    classes_path = tmp_path / "classes.tif"
    with rasterio.open(source) as opened:
        _write_egdi_classes(opened, classes_path)
    with rasterio.open(classes_path) as classes:
        assert classes.nodata == 0
        assert classes.read(1).tolist() == [
            [class_value("vb__"), 0],
            [0, 0],
        ]
        mixed = _reproject_egdi_tile(
            classes,
            (0.0, 0.0, 2.0, 2.0),
            (0.0, 0.0, 2.0, 2.0),
            from_origin(0.0, 2.0, 2.0, 2.0),
            (1, 1),
        )
    assert mixed.tolist() == [[class_value("vb__")]]
    empty_path = tmp_path / "empty.tif"
    with rasterio.open(
        empty_path,
        "w",
        driver="GTiff",
        dtype="uint8",
        count=1,
        width=2,
        height=2,
        crs="EPSG:4326",
        transform=from_origin(0.0, 2.0, 1.0, 1.0),
        nodata=0,
    ) as raster:
        raster.write(np.zeros((2, 2), "uint8"), 1)
    with rasterio.open(empty_path) as empty:
        assert _reproject_egdi_tile(
            empty,
            (0.0, 0.0, 2.0, 2.0),
            (0.0, 0.0, 2.0, 2.0),
            from_origin(0.0, 2.0, 2.0, 2.0),
            (1, 1),
        ).tolist() == [[0]]
        assert _reproject_egdi_tile(
            empty,
            (0.0, 0.0, 2.0, 2.0),
            (10.0, 10.0, 11.0, 11.0),
            from_origin(10.0, 11.0, 1.0, 1.0),
            (1, 1),
        ).tolist() == [[0]]


def test_provenance_codes_follow_priority_overlaps(tmp_path):
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    write_cog(
        cubes / "geology_age.tif",
        np.full((2, 2), AGE_VALUES["Cambrian"], "uint8"),
        west=-100.0,
        north=42.0,
    )
    write_cog(
        cubes / "geology_age_canada.tif",
        np.full((2, 2), AGE_VALUES["Jurassic"], "uint8"),
        west=-100.0,
        north=42.0,
    )
    write_cog(
        cubes / "geology_age_sgmc.tif",
        np.array([[AGE_VALUES["Permian"], 0], [0, 0]], "uint8"),
        west=-100.0,
        north=42.0,
    )
    backend = RealSource(cubes_dir=cubes)

    _, codes, _ = read_composited(
        backend,
        "age",
        "geology_age.tif",
        (-100.0, 40.0, -98.0, 42.0),
        1.0,
    )

    assert codes.tolist() == [[SGMC_CODE, CANADA_CODE], [CANADA_CODE, CANADA_CODE]]


def write_sim3340_source(path: Path) -> None:
    """Write SIM 3340 tables in a GeoPackage named like the geodatabase, with three polygons.

    Unit 1 is Cretaceous sandstone, unit 2 is water and unit 3 is a Jurassic island over 180°.
    """
    import geopandas as gpd
    import pandas as pd
    import pyogrio

    path.parent.mkdir(parents=True)
    shapes = gpd.GeoDataFrame(
        {"NSACLASS": [1, 2, 3]},
        geometry=[
            box(-150.0, 60.0, -149.0, 61.0),
            box(-148.0, 60.0, -147.0, 61.0),
            box(179.5, 52.0, 180.5, 53.0),
        ],
        crs="EPSG:4326",
    )
    pyogrio.write_dataframe(shapes.to_crs(3338), path, layer="AKStategeol_poly", driver="GPKG")
    ages = pd.DataFrame(
        {
            "NSACLASS": [1, 3],
            "FULL_MIN": ["Phanerozoic;Mesozoic;Cretaceous", "Phanerozoic;Mesozoic;Jurassic"],
            "FULL_MAX": ["Phanerozoic;Mesozoic;Cretaceous", "Phanerozoic;Mesozoic;Jurassic"],
        },
    )
    rocks = pd.DataFrame(
        {
            "NSACLASS": [1, 2, 3],
            "LITH1": ["Sedimentary", "Water", "Igneous"],
            "LITH2": ["Clastic", "", "Volcanic"],
            "LITH3": ["Sandstone", "", "Basalt"],
            "LITH4": ["", "", ""],
            "LITH5": ["", "", ""],
            "RANK": ["Major", "Major", "Major"],
        },
    )
    for layer, table in (("nsaage", ages), ("nsalith", rocks)):
        pyogrio.write_dataframe(
            gpd.GeoDataFrame(table, geometry=[None] * len(table)),
            path,
            layer=layer,
            driver="GPKG",
        )


def sim3340_cell(latitude: float, longitude: float) -> tuple[int, int]:
    """Return the row and column of a point in the 0.25 degree world rasters, 84°N at row 0."""
    return int((84 - latitude) / 0.25), int((longitude + 180) / 0.25)


def test_sim3340_ingest_rasterises_units_and_splits_polygons_over_180(tmp_path, monkeypatch):
    from soe.ingest import geology_regional as regional_ingest

    monkeypatch.setattr(regional_ingest, "LITHOLOGY_RES_DEG", 0.25)
    monkeypatch.setattr(regional_ingest, "GEOLOGY_AGE_RES_DEG", 0.25)
    write_sim3340_source(tmp_path / "cubes" / ".downloads" / SIM3340_DIR / SIM3340_GDB)

    age_cog, type_cog = ingest_sim3340(tmp_path / "cubes")

    assert (age_cog.name, type_cog.name) == (ALASKA_AGE_FILE, ALASKA_TYPE_FILE)
    with rasterio.open(type_cog) as cog, rasterio.open(age_cog) as ages:
        assert cog.tags()[LITHOLOGY_SOURCE_TAG] == "sim3340"
        types = cog.read(1)
        age_values = ages.read(1)

        assert types[sim3340_cell(60.5, -149.5)] == class_value("ssss")
        assert age_values[sim3340_cell(60.5, -149.5)] == AGE_VALUES["Cretaceous"]
        assert types[sim3340_cell(60.5, -147.5)] == 0
        assert types[sim3340_cell(52.5, 179.75)] == class_value("vb__")
        assert types[sim3340_cell(52.5, -179.75)] == class_value("vb__")
        assert types[sim3340_cell(52.5, 0.0)] == 0
        assert age_values[sim3340_cell(52.5, -179.75)] == AGE_VALUES["Jurassic"]


def write_gmna_source(folder: Path) -> None:
    """Write a GMNA-style shapefile with an onshore unit, ice and a seafloor unit.

    The Cretaceous sedimentary unit is onshore Mexico, the ice is Greenland and the starred
    volcanic unit is seafloor, so only the first two reach the COGs.
    """
    import geopandas as gpd

    shapes = gpd.GeoDataFrame(
        {
            "UNIT_ABBRE": ["KT", "Ice", "Kx*"],
            "ROCKTYPE": ["Sedimentary", "Ice", "Volcanic"],
            "LITHOLOGY": ["", "", "mafic rocks"],
            "MIN_AGE": ["Cretaceous", "Holocene", "Cretaceous"],
            "MAX_AGE": ["Cretaceous", "Holocene", "Cretaceous"],
        },
        geometry=[
            box(-100.0, 19.0, -99.0, 20.0),
            box(-42.0, 72.0, -41.0, 73.0),
            box(-60.0, 40.0, -59.0, 41.0),
        ],
        crs="EPSG:4326",
    )
    target = folder / "GMNA_SHAPES"
    target.mkdir(parents=True)
    shapes.to_file(target / "Geologic_units.shp")


def gmna_cell(latitude: float, longitude: float) -> tuple[int, int]:
    """Return the row and column of a point in the 1 degree world rasters, 84°N at row 0."""
    return int(84 - latitude), int(longitude + 180)


def test_gmna_ingest_rasterises_onshore_units_and_omits_seafloor(tmp_path, monkeypatch):
    from soe.ingest import geology_regional as regional_ingest

    monkeypatch.setattr(regional_ingest, "LITHOLOGY_RES_DEG", 1.0)
    monkeypatch.setattr(regional_ingest, "GEOLOGY_AGE_RES_DEG", 1.0)
    source = tmp_path / "source"
    write_gmna_source(source)

    age_cog, type_cog = ingest_gmna(tmp_path / "cubes", source)

    assert (age_cog.name, type_cog.name) == (GMNA_AGE_FILE, GMNA_TYPE_FILE)
    with rasterio.open(type_cog) as cog, rasterio.open(age_cog) as ages:
        assert cog.tags()[LITHOLOGY_SOURCE_TAG] == "gmna"
        types = cog.read(1)
        age_values = ages.read(1)

        assert types[gmna_cell(19.5, -99.5)] == class_value("smmx")
        assert age_values[gmna_cell(19.5, -99.5)] == AGE_VALUES["Cretaceous"]
        assert types[gmna_cell(72.5, -41.5)] == class_value("ig__")
        assert types[gmna_cell(40.5, -59.5)] == 0
        assert age_values[gmna_cell(40.5, -59.5)] == 0


def test_gmna_ingest_splits_a_unit_wrapping_across_the_antimeridian(tmp_path, monkeypatch):
    from soe.ingest import geology_regional as regional_ingest

    monkeypatch.setattr(regional_ingest, "LITHOLOGY_RES_DEG", 1.0)
    monkeypatch.setattr(regional_ingest, "GEOLOGY_AGE_RES_DEG", 1.0)
    source = tmp_path / "source"
    write_gmna_dateline_source(source)

    age_cog, type_cog = ingest_gmna(tmp_path / "cubes", source)

    with rasterio.open(type_cog) as cog, rasterio.open(age_cog) as ages:
        types = cog.read(1)
        age_values = ages.read(1)

        assert types[gmna_cell(52.5, 179.5)] == class_value("smmx")
        assert types[gmna_cell(52.5, -179.5)] == class_value("smmx")
        assert types[gmna_cell(52.5, 0.0)] == 0
        assert age_values[gmna_cell(52.5, 179.5)] == AGE_VALUES["Cretaceous"]
        assert age_values[gmna_cell(52.5, -179.5)] == AGE_VALUES["Cretaceous"]
        assert age_values[gmna_cell(52.5, 0.0)] == 0


def write_gmna_dateline_source(folder: Path) -> None:
    """Write a GMNA-style shapefile with one onshore unit wrapping across the antimeridian.

    In -180 to 180 longitude the unit is a nearly world-wide band, which is how an
    Aleutian polygon comes out of the GMNA reprojection before it is split.
    """
    import geopandas as gpd

    shapes = gpd.GeoDataFrame(
        {
            "UNIT_ABBRE": ["KT"],
            "ROCKTYPE": ["Sedimentary"],
            "LITHOLOGY": [""],
            "MIN_AGE": ["Cretaceous"],
            "MAX_AGE": ["Cretaceous"],
        },
        geometry=[box(-178.0, 52.0, 178.0, 53.0)],
        crs="EPSG:4326",
    )
    target = folder / "GMNA_SHAPES"
    target.mkdir(parents=True)
    shapes.to_file(target / "Geologic_units.shp")


def test_gmna_geometry_closes_rings_the_archive_left_open():
    coords = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]
    ring = struct.pack("<I", len(coords)) + b"".join(
        struct.pack("<2d", x, y) for x, y in coords
    )
    wkb = b"\x01\x03\x00\x00\x00" + struct.pack("<I", 1) + ring

    with pytest.raises(Exception):
        shapely.from_wkb(wkb)
    fixed = _close_wkb_rings(wkb)

    assert fixed != wkb
    geometry = _gmna_geometry(wkb)
    assert geometry is not None
    assert geometry.is_valid
    assert geometry.area == pytest.approx(0.5)


def test_geology_claims_84n_coverage_while_its_cog_reaches_84n(tmp_path):
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    tall = np.ones((2, 2), "uint8")
    write_cog(cubes / "lithology.tif", tall, west=0.0, north=84.0, tag="glim")
    write_cog(cubes / "geology_age.tif", tall, west=0.0, north=84.0, tag="gsc-of5529")
    registry = make_registry(RealSource(cubes_dir=cubes))

    assert registry["geology"].coverage == (-180, -60, 180, 84)
    assert registry["geology_age"].coverage == (-180, -60, 180, 84)


def test_geology_falls_back_to_60n_coverage_when_its_cog_ends_at_60n(tmp_path, caplog):
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    short = np.ones((2, 2), "uint8")
    write_cog(cubes / "lithology.tif", short, west=0.0, north=60.0, tag="glim")
    write_cog(cubes / "geology_age.tif", short, west=0.0, north=60.0, tag="gsc-of5529")

    with caplog.at_level(logging.WARNING, logger="soe.sources.registry"):
        registry = make_registry(RealSource(cubes_dir=cubes))

    assert registry["geology"].coverage == (-180, -60, 180, 60)
    assert registry["geology_age"].coverage == (-180, -60, 180, 60)
    assert "lithology.tif" in caplog.text
    assert "geology_age.tif" in caplog.text
