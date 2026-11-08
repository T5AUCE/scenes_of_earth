"""Test the regional geology patchwork: name tables, compositing, provenance and notices."""
import json
from pathlib import Path

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
    candidates_for,
    composite_values,
    read_composited,
    regional_notices,
    sources_for_kind,
    used_in,
)
from soe.ingest.geology_classification import (
    EGDI_TYPE_NAMES,
    canada_age_batch,
    canada_type_batch,
    egdi_type_batch,
    family_value,
    igme_age_batch,
    igme_type_batch,
    sgmc_age_batch,
    sgmc_type_batch,
)
from soe.ingest.geology_regional import (
    _reproject_egdi_tile,
    _write_egdi_families,
    ingest_egdi,
    ingest_geology_regional,
)
from soe.scene_request import compute_scene_id
from soe.sources import RealSource, SyntheticSource, make_registry
from soe.sources.licences import SOURCES
from soe.sources.lithology import GLIM_VALUES, LITHOLOGY_SOURCE_TAG, OPENLANDMAP_SOURCE
from tests.helpers import BOUNDARY, HASH_A, NAIROBI

SWITZERLAND = (5.9, 45.8, 10.5, 47.8)  # in the IGME5000 and EGDI footprints
KENYA = (33.9, -4.7, 41.9, 5.0)  # outside every regional footprint


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
    assert "surface geology" in notices[1]


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
        family_value("pa"),
        family_value("vb"),
        family_value("mt"),
        family_value("vb"),
        family_value("vb"),
        None,
    ]


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


def test_sgmc_hierarchies_map_composition_to_families():
    records = [
        ("Sedimentary", "Chemical", "Evaporite", "Gypsum", ""),
        ("Sedimentary", "Chemical", "Chert", "", ""),
        ("Sedimentary", "Carbonate", "Limestone", "Chalk", ""),
        ("Sedimentary", "Carbonate", "Marlstone", "", ""),
        ("Sedimentary", "Clastic", "Sandstone", "", ""),
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
        ("Unconsolidated", "Coarse-detrital", "Sand", "", ""),
    ]

    assert sgmc_type_batch(records) == [
        family_value("ev"),
        family_value("ss"),
        family_value("sc"),
        family_value("sm"),
        family_value("ss"),
        family_value("sm"),
        family_value("vb"),
        family_value("vb"),
        family_value("va"),
        family_value("vi"),
        family_value("pa"),
        family_value("pa"),
        family_value("pi"),
        family_value("pb"),
        family_value("mt"),
        family_value("su"),
    ]
    with pytest.raises(ValueError, match="BOGUS"):
        sgmc_type_batch([("BOGUS", "", "", "", "")])


def test_sgmc_names_with_known_substrings_still_fail():
    records = [
        ("Igneous", "Volcanic", "BOGUS volcanic", "", ""),
        ("Sedimentary", "Clastic", "WEIRD basalt", "", ""),
    ]

    with pytest.raises(ValueError) as error:
        sgmc_type_batch(records)

    assert all(name in str(error.value) for name in ("BOGUS volcanic", "WEIRD basalt"))


def test_egdi_unknown_values_fail_and_generic_values_are_no_data():
    with pytest.raises(ValueError, match="999"):
        egdi_type_batch([999])
    assert egdi_type_batch([8, 93, 121, 122, 123]) == [family_value("vb"), None, None, None, None]


def test_egdi_table_covers_the_whole_legend_with_known_families():
    assert sorted(EGDI_TYPE_NAMES) == list(range(1, 124))
    assert {name for name in EGDI_TYPE_NAMES.values() if name} <= {
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


def scene_id(folder: Path, layers: list[str]) -> str:
    registry = make_registry(RealSource(cubes_dir=folder))
    datasets = [registry[layer_id] for layer_id in layers]
    return compute_scene_id("poly:abc", layers, None, datasets, {})


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


def test_geology_scene_ids_change_with_a_regional_source_version(
    patchwork_cubes,
    monkeypatch,
):
    before = scene_id(patchwork_cubes, ["geology_age"])
    monkeypatch.setitem(SOURCES["canada_5m"], "version", "canada-5m-next")

    assert scene_id(patchwork_cubes, ["geology_age"]) != before


def test_geology_scene_ids_without_regional_sources_are_unchanged(tmp_path):
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    write_cog(cubes / "geology_age.tif", np.ones((2, 2), "uint8"), tag="gsc-of5529")
    registry = make_registry(RealSource(cubes_dir=cubes))

    assert registry["geology_age"].regional_versions() == []


def test_unknown_regional_source_is_refused(tmp_path):
    with pytest.raises(ValueError, match="unknown regional source"):
        ingest_geology_regional(tmp_path, "atlantis")


def build_age_scene(cubes: Path, area: Area, scenes: Path) -> tuple[dict, zarr.Group]:
    """Build the age layer over area and return its scene.json and Zarr root."""
    registry = make_registry(RealSource(cubes_dir=cubes))
    build_scene(HASH_A, area, None, None, [registry["geology_age"]], "T", scenes)
    doc = json.loads((scenes / HASH_A / "scene.json").read_text(encoding="utf-8"))
    return doc, zarr.open_group(str(scenes / HASH_A / "data.zarr"), mode="r")


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
    assert layer["fallback_sources"] == [SOURCES["canada_5m"]]
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
    assert layer["source"] == SOURCES["canada_5m"]
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
    patch = np.array([[family_value("pa"), 0], [family_value("sc"), 0]], "uint8")
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

    monkeypatch.setitem(EGDI_TYPE_NAMES, 1, "ss")
    monkeypatch.setitem(EGDI_TYPE_NAMES, 2, "pa")
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
    assert set(np.unique(values)) == {0, family_value("ss"), family_value("pa")}


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
    families_path = tmp_path / "families.tif"
    with rasterio.open(source) as opened:
        _write_egdi_families(opened, families_path)
    with rasterio.open(families_path) as families:
        assert families.nodata == 0
        assert families.read(1).tolist() == [
            [family_value("vb"), 0],
            [0, 0],
        ]
        mixed = _reproject_egdi_tile(
            families,
            (0.0, 0.0, 2.0, 2.0),
            (0.0, 0.0, 2.0, 2.0),
            from_origin(0.0, 2.0, 2.0, 2.0),
            (1, 1),
        )
    assert mixed.tolist() == [[family_value("vb")]]
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
