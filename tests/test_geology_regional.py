"""Test the regional geology patchwork: name tables, compositing, provenance and notices."""
import json

import numpy as np
import pytest
import rasterio
import zarr
from rasterio.transform import from_origin
from shapely.geometry import box

from soe.areas import Area
from soe.build import build_scene
from soe.bundle import validate
from soe.geology_age import AGE_VALUES
from soe.geology_regional import (
    BASE_CODE,
    CANADA_CODE,
    CODE_MEANINGS,
    CODE_VALUES,
    IGME_CODE,
    SGMC_CODE,
    canada_age_batch,
    canada_type_batch,
    candidates_for,
    composite_values,
    egdi_type_batch,
    family_value,
    igme_age_batch,
    igme_type_batch,
    read_composited,
    regional_notices,
    sgmc_age_batch,
    sgmc_family,
    sgmc_type_batch,
    sources_for_kind,
    used_in,
)
from soe.ingest.geology_regional import ingest_geology_regional
from soe.scene_request import compute_scene_id
from soe.sources import RealSource, SyntheticSource, make_registry
from soe.sources.licences import SOURCES
from soe.sources.lithology import GLIM_VALUES, LITHOLOGY_SOURCE_TAG
from tests.helpers import BOUNDARY, HASH_A, NAIROBI

SWITZERLAND = (5.9, 45.8, 10.5, 47.8)  # in the IGME5000 and EGDI footprints
KENYA = (33.9, -4.7, 41.9, 5.0)  # outside every regional footprint


def write_cog(path, values, west=0.0, north=5.0, res=1.0, tag="test") -> None:
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
        "europe_igme5000",
        "canada_5m",
        "us_sgmc",
    ]
    assert [source["id"] for source in sources_for_kind("type")] == [
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


def test_later_sources_win_and_missing_cells_keep_the_earlier_value():
    base = np.array([[1, 0], [1, 1]], "uint8")
    low = np.array([[0, 0], [2, 0]], "uint8")
    high = np.array([[0, 0], [3, 3]], "uint8")

    value, codes = composite_values(base, [(IGME_CODE, low), (CANADA_CODE, high)])

    assert value.tolist() == [[1, 0], [3, 3]]
    assert codes.tolist() == [[BASE_CODE, 0], [CANADA_CODE, CANADA_CODE]]


def test_used_in_lists_the_base_first_then_priority_order():
    codes = np.array([[1, 5, 3], [0, 2, 4]], "uint8")
    weights = np.ones((2, 3))

    assert used_in(codes, weights) == ("global_base", "europe_igme5000", "canada_5m", "europe_egdi", "us_sgmc")
    assert used_in(codes, np.zeros((2, 3))) == ()


def test_regional_notices_name_scale_and_representation():
    notices = regional_notices(("canada_5m", "europe_igme5000"), "age")

    assert len(notices) == 2
    assert "1:5,000,000" in notices[0] and "bedrock" in notices[0]
    assert "surface geology" in notices[1]


def test_canada_ranges_take_the_smallest_containing_class():
    values = canada_age_batch(
        [("Paleozoic", "Carboniferous-Permian", "undivided Carboniferous-Permian"),
         ("Cenozoic", "Tertiary", "Miocene"),
         ("Precambrian", "Archean-Proterozoic", " ")],
    )

    assert values == [
        AGE_VALUES["Paleozoic undivided"],
        AGE_VALUES["Neogene"],
        AGE_VALUES["Precambrian undivided"],
    ]


def test_canada_blank_names_fall_back_or_stay_no_data():
    assert canada_age_batch([("Cenozoic", " ", " ")]) == [AGE_VALUES["Cenozoic undivided"]]
    assert canada_age_batch([("unknown", "unknown", "unknown")]) == [None]
    assert canada_type_batch([("sedimentary rocks", " ")]) == [family_value("sm")]
    assert canada_type_batch([("intrusive rocks", " ")]) == [None]


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


def test_igme_types_map_families_and_blanks_fall_back():
    values = igme_type_batch(
        [("granite", None, None), ("basalt", None, None), ("gneiss", None, None),
         (None, "volcanite Precambrian", None), (None, None, None)],
    )

    assert values == [
        family_value("pa"),
        family_value("vb"),
        family_value("mt"),
        family_value("vb"),
        None,
    ]


def test_sgmc_leaf_names_class_by_period_not_ma():
    values = sgmc_age_batch(
        [("Phanerozoic - Paleozoic - Cambrian - Furongian", "Phanerozoic - Paleozoic - Cambrian"),
         ("Phanerozoic - Cenozoic - Tertiary-Neogene - Miocene", "Phanerozoic - Cenozoic - Quaternary"),
         ("", "")],
    )

    assert values == [AGE_VALUES["Cambrian"], AGE_VALUES["Cenozoic undivided"], None]


def test_sgmc_unknown_leaves_fail_with_the_full_list():
    with pytest.raises(ValueError, match="BOGUS"):
        sgmc_age_batch([("Phanerozoic - BOGUS", "Phanerozoic - Cambrian")])


def test_sgmc_hierarchies_map_composition_to_families():
    records = [
        ("Sedimentary", "Clastic", "Sandstone", "", ""),
        ("Sedimentary", "Carbonate", "Limestone", "", ""),
        ("Igneous", "Volcanic", "Basalt", "", ""),
        ("Igneous", "Plutonic", "Granite", "", ""),
        ("Metamorphic", "Schist", "", "", ""),
        ("Unconsolidated", "", "", "", ""),
    ]

    assert sgmc_type_batch(records) == [
        family_value("ss"),
        family_value("sc"),
        family_value("vb"),
        family_value("pa"),
        family_value("mt"),
        family_value("su"),
    ]
    assert sgmc_family("Sedimentary", "Chemical", "Evaporite", "", "") == "ev"
    with pytest.raises(ValueError, match="BOGUS"):
        sgmc_type_batch([("BOGUS", "", "", "", "")])


def test_egdi_unknown_values_fail_and_zero_is_no_data():
    with pytest.raises(ValueError, match="7"):
        egdi_type_batch([7])


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

    value, codes, _ = read_composited(backend, "age", "geology_age.tif", (-100.0, 40.0, -98.0, 42.0), 1.0)

    assert value.tolist() == [[AGE_VALUES["Cambrian"], 0], [AGE_VALUES["Cretaceous"], 0]]
    assert codes.tolist() == [[BASE_CODE, 0], [CANADA_CODE, 0]]


def test_missing_regional_files_are_skipped_silently(patchwork_cubes):
    backend = RealSource(cubes_dir=patchwork_cubes)
    (patchwork_cubes / "geology_age_canada.tif").unlink()

    value, codes, _ = read_composited(backend, "age", "geology_age.tif", (-100.0, 40.0, -98.0, 42.0), 1.0)

    assert value.tolist() == [[AGE_VALUES["Cambrian"], 0], [AGE_VALUES["Jurassic"], 0]]
    assert codes.tolist() == [[BASE_CODE, 0], [BASE_CODE, 0]]


def test_regional_sources_are_absent_offline():
    assert make_registry(SyntheticSource(geology_age=True, lithology=True))["geology_age"].sources_for(
        (0.0, 0.0, 1.0, 1.0)
    )[1:] == []


def test_geology_scene_ids_change_only_for_geology_layers(patchwork_cubes, tmp_path, monkeypatch):
    def scene_id(folder, layers):
        registry = make_registry(RealSource(cubes_dir=folder))
        datasets = [registry[layer_id] for layer_id in layers]
        return compute_scene_id("poly:abc", layers, None, datasets, {})

    plain = ["terrain", "esa_worldcover"]
    assert scene_id(patchwork_cubes, plain) == scene_id(tmp_path, plain)
    assert "geology_age" in make_registry(RealSource(cubes_dir=patchwork_cubes))

    before = scene_id(patchwork_cubes, ["geology_age"])
    monkeypatch.setitem(SOURCES["gsc_world"], "version", SOURCES["gsc_world"]["version"] + "-x")
    after = make_registry(RealSource(cubes_dir=patchwork_cubes))
    datasets = [after["geology_age"]]
    assert compute_scene_id("poly:abc", ["geology_age"], None, datasets, {}) != before
    assert scene_id(patchwork_cubes, plain) == scene_id(tmp_path, plain)


def test_unknown_regional_source_is_refused(tmp_path):
    with pytest.raises(ValueError, match="unknown regional source"):
        ingest_geology_regional(tmp_path, "atlantis")


def test_only_used_sources_are_credited(patchwork_cubes, tmp_path):
    registry = make_registry(RealSource(cubes_dir=patchwork_cubes))
    build_scene(HASH_A, Area(NAIROBI, BOUNDARY), None, None, [registry["geology_age"]], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    layer = doc["layers"][0]

    assert validate(doc) == []
    assert layer.get("fallback_sources", []) == []
    assert "source" not in layer["arrays"]
    assert SOURCES["canada_5m"]["attribution"] not in doc["credits"]["lines"]
    assert SOURCES["gsc_world"]["attribution"] in doc["credits"]["lines"]


def test_a_used_regional_source_is_credited_noticed_and_coded(toronto_cubes, tmp_path):
    registry = make_registry(RealSource(cubes_dir=toronto_cubes))
    build_scene(HASH_A, Area(box(-80.0, 43.0, -79.0, 44.0)), None, None, [registry["geology_age"]], "T", tmp_path)
    doc = json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))
    layer = doc["layers"][0]
    root = zarr.open_group(str(tmp_path / HASH_A / "data.zarr"), mode="r")
    codes = root["geology_age/source"][...]
    mask = root["geology_age/mask"][...]

    assert validate(doc) == []
    assert layer["fallback_sources"] == [SOURCES["canada_5m"]]
    assert SOURCES["canada_5m"]["attribution"] in doc["credits"]["lines"]
    assert any("Canada" in notice for notice in doc["notices"]["limits"])
    assert layer["arrays"]["source"]["dtype"] == "uint8"
    assert root["geology_age/source"].attrs["flag_meanings"] == list(CODE_MEANINGS)
    assert root["geology_age/source"].attrs["flag_values"] == list(CODE_VALUES)
    assert set(np.unique(codes[mask == 1])) == {BASE_CODE, CANADA_CODE}
    assert (codes[mask != 1] == 0).all()


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

    _, codes, _ = read_composited(backend, "age", "geology_age.tif", (-100.0, 40.0, -98.0, 42.0), 1.0)

    assert codes.tolist() == [[SGMC_CODE, CANADA_CODE], [CANADA_CODE, CANADA_CODE]]
