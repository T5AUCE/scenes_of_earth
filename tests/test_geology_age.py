"""Test the rock-age classes, the GSC ingest and the Geology age layer."""
import io
import json
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import pytest
import rasterio
import zarr
from shapely.geometry import box

from soe.areas import Area
from soe.build import build_scene
from soe.bundle import JsonObject, validate
from soe.geology_age import (
    AGE_CLASSES,
    AGE_VALUES,
    GEOLOGY_AGE_FILE,
    GEOLOGY_AGE_RES_DEG,
    GSC_AGE_NAMES,
    GSC_SOURCE,
    TIMELINE,
    classify_age_ranges,
    smallest_containing_class,
)
from soe.ingest import geology_age as ingest
from soe.ingest.cubes import DOWNLOADS_DIR
from soe.ingest.geology_age import (
    AGES_FILE,
    GSC_DIR,
    GSC_MEMBERS,
    POLYGONS_FILE,
    build_geology_age_cog,
    ingest_geology_age,
)
from soe.scene_request import compute_scene_id
from soe.sources import RealSource, SyntheticSource, make_registry
from soe.sources.licences import SOURCES
from soe.sources.lithology import LITHOLOGY_SOURCE_TAG
from tests.helpers import BOUNDARY, HASH_A, NAIROBI

SOURCE_RES_DEG = 0.5
ROOT = Path(__file__).resolve().parent.parent  # repo root for the CLI subprocess
UNUSED_MEMBER_BYTES = 200_000  # the real archive is mostly installers that the ingest skips
SMALL_READ_BYTES = 4096
AGE_SHAPES = [
    (1, box(0, 0, 5, 5)),
    (2, box(5, 0, 10, 5)),
    (3, box(10, 0, 15, 5)),
    (4, box(15, 0, 20, 5)),
]
AGE_ROWS = [
    (1, "CAMBRIAN", "CAMBRIAN"),
    (2, "CARBONIFEROUS", "TRIASSIC"),
    (3, "TERTIARY", None),
    # Unit 4 has no age row.
]


@pytest.fixture(autouse=True)
def coarse_source(monkeypatch):
    """Make the ingest write 0.5 degree cells, so that a test world is small."""
    monkeypatch.setattr(ingest, "GEOLOGY_AGE_RES_DEG", SOURCE_RES_DEG)


def write_gsc_files(folder: Path, rows: list[tuple[int, str, str | None]] = AGE_ROWS) -> None:
    """Write map units and an age table in the files and fields of GSC Open File 5529."""
    folder.mkdir(exist_ok=True)
    units = gpd.GeoDataFrame(
        {"RUNO_ID2": [key for key, _ in AGE_SHAPES]},
        geometry=[shape for _, shape in AGE_SHAPES],
        crs="EPSG:4326",
    )
    units.to_file(folder / POLYGONS_FILE)
    ages = pd.DataFrame(rows, columns=["RUNO_ID2", "STARTCAT", "ENDCAT"])
    gpd.GeoDataFrame(ages).to_file(folder / AGES_FILE, driver="ESRI Shapefile")


def write_archive(path: Path, folder: Path) -> None:
    """Zip the GSC files of folder under the member paths of the real archive."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("installer.exe", np.random.default_rng(0).bytes(UNUSED_MEMBER_BYTES))
        for member, name in GSC_MEMBERS.items():
            archive.write(folder / name, member)


@pytest.fixture
def age_cubes_dir(tmp_path):
    source = tmp_path / "gsc"
    write_gsc_files(source)
    cubes = tmp_path / "cubes"
    cubes.mkdir()
    build_geology_age_cog(source / POLYGONS_FILE, source / AGES_FILE, cubes / GEOLOGY_AGE_FILE)
    return cubes


def test_a_range_inside_one_period_takes_that_period():
    assert classify_age_ranges([("LATE JURASSIC", "JURASSIC")], GSC_AGE_NAMES) == {
        ("LATE JURASSIC", "JURASSIC"): AGE_VALUES["Jurassic"],
    }


def test_a_range_over_several_periods_of_one_era_is_that_era_undivided():
    assert smallest_containing_class("Devonian", "Permian") == AGE_VALUES["Paleozoic undivided"]
    assert smallest_containing_class("Paleogene", "Neogene") == AGE_VALUES["Cenozoic undivided"]
    assert smallest_containing_class("Triassic", "Cretaceous") == AGE_VALUES["Mesozoic undivided"]


def test_ranges_over_several_eras_take_the_smallest_wider_class():
    assert smallest_containing_class("Permian", "Triassic") == AGE_VALUES["Phanerozoic undivided"]
    assert smallest_containing_class("Mesoproterozoic", "Neoproterozoic") \
        == AGE_VALUES["Proterozoic undivided"]
    assert smallest_containing_class("Archean", "Mesoproterozoic") \
        == AGE_VALUES["Precambrian undivided"]
    assert smallest_containing_class("Neoproterozoic", "Cambrian") \
        == AGE_VALUES["Precambrian to Phanerozoic"]


def test_cambrian_stays_cambrian_and_vendian_stays_below_it():
    classes = classify_age_ranges(
        [("CAMBRIAN", "CAMBRIAN"), ("VENDIAN", "VENDIAN"), ("VENDIAN", "EARLY CAMBRIAN")],
        GSC_AGE_NAMES,
    )

    assert classes[("CAMBRIAN", "CAMBRIAN")] == AGE_VALUES["Cambrian"]
    assert classes[("VENDIAN", "VENDIAN")] == AGE_VALUES["Neoproterozoic"]
    assert classes[("VENDIAN", "EARLY CAMBRIAN")] == AGE_VALUES["Precambrian to Phanerozoic"]


def test_the_start_and_end_names_may_come_in_either_order():
    forward = classify_age_ranges([("CARBONIFEROUS", "PERMIAN")], GSC_AGE_NAMES)
    backward = classify_age_ranges([("PERMIAN", "CARBONIFEROUS")], GSC_AGE_NAMES)

    assert list(forward.values()) == list(backward.values())


def test_tertiary_is_cenozoic_undivided_and_its_halves_are_periods():
    classes = classify_age_ranges(
        [("TERTIARY", "TERTIARY"), ("EARLY TERTIARY", "EARLY TERTIARY")],
        GSC_AGE_NAMES,
    )

    assert classes[("TERTIARY", "TERTIARY")] == AGE_VALUES["Cenozoic undivided"]
    assert classes[("EARLY TERTIARY", "EARLY TERTIARY")] == AGE_VALUES["Paleogene"]


def test_riphean_and_middle_proterozoic_aliases_span_eras():
    assert GSC_AGE_NAMES["EARLY RIPHEAN"] == ("Paleoproterozoic", "Mesoproterozoic")
    assert GSC_AGE_NAMES["LATE RIPHEAN"] == ("Mesoproterozoic", "Neoproterozoic")
    assert GSC_AGE_NAMES["MIDDLE PROTEROZOIC"] == ("Mesoproterozoic", "Neoproterozoic")
    classes = classify_age_ranges(
        [
            ("EARLY RIPHEAN", "EARLY RIPHEAN"),
            ("LATE RIPHEAN", "LATE RIPHEAN"),
            ("MIDDLE PROTEROZOIC", "MIDDLE PROTEROZOIC"),
            ("EARLY RIPHEAN", "LATE RIPHEAN"),
        ],
        GSC_AGE_NAMES,
    )

    assert set(classes.values()) == {AGE_VALUES["Proterozoic undivided"]}


def test_unknown_age_names_fail_together_instead_of_becoming_no_data():
    with pytest.raises(ValueError, match="BOGUS.*WEIRD|WEIRD.*BOGUS"):
        classify_age_ranges([("BOGUS", "CAMBRIAN"), ("CAMBRIAN", "WEIRD")], GSC_AGE_NAMES)


def test_class_values_are_unique_and_every_class_has_a_colour_and_an_era_group():
    values = [entry["value"] for entry in AGE_CLASSES]

    assert values == list(range(1, len(AGE_CLASSES) + 1))
    assert all(entry["group"] for entry in AGE_CLASSES)
    assert all(len(entry["color"]) == 7 and entry["color"][0] == "#" for entry in AGE_CLASSES)
    assert len({entry["label"] for entry in AGE_CLASSES}) == len(AGE_CLASSES)


def test_key_precambrian_colours_match_macrostrat_with_a_visible_cross_eon_grey():
    colours = {entry["label"]: entry["color"] for entry in AGE_CLASSES}

    assert colours["Proterozoic undivided"] == "#FF70B8"
    assert colours["Archean"] == "#FF3399"
    assert colours["Precambrian to Phanerozoic"] == "#b8b8b8"


def test_every_gsc_name_reaches_units_of_the_timeline_in_order():
    for name, (oldest, newest) in GSC_AGE_NAMES.items():
        assert TIMELINE.index(oldest) <= TIMELINE.index(newest), name


def test_cog_holds_the_class_of_each_unit_and_zero_where_no_unit_has_an_age(tmp_path):
    source = tmp_path / "gsc"
    write_gsc_files(source)
    cog = tmp_path / GEOLOGY_AGE_FILE

    build_geology_age_cog(source / POLYGONS_FILE, source / AGES_FILE, cog)

    with rasterio.open(cog) as raster:
        row, _ = raster.index(0, 2.5)
        values = [raster.read(1)[row, raster.index(x, 2.5)[1]] for x in (2, 7, 12, 17, 30)]
        assert raster.tags()[LITHOLOGY_SOURCE_TAG] == GSC_SOURCE
        assert raster.bounds.bottom == -60 and raster.bounds.top == 60
    assert values == [
        AGE_VALUES["Cambrian"],
        AGE_VALUES["Phanerozoic undivided"],
        AGE_VALUES["Cenozoic undivided"],
        0,
        0,
    ]


def test_a_name_without_a_class_fails_the_build_and_publishes_nothing(tmp_path):
    source = tmp_path / "gsc"
    write_gsc_files(source, [(1, "CAMBRIAN", "SHIELD")])
    cog = tmp_path / GEOLOGY_AGE_FILE

    with pytest.raises(ValueError, match="SHIELD"):
        build_geology_age_cog(source / POLYGONS_FILE, source / AGES_FILE, cog)

    assert list(tmp_path.glob("*.tif")) == []


def test_ingest_extracts_only_the_needed_members_from_a_local_archive(tmp_path):
    source = tmp_path / "gsc"
    write_gsc_files(source)
    archive = tmp_path / "of_5529.zip"
    write_archive(archive, source)
    cubes = tmp_path / "cubes"

    published = ingest_geology_age(cubes, archive)

    assert published == cubes / GEOLOGY_AGE_FILE and published.exists()
    extracted = sorted(path.name for path in (cubes / ".downloads" / "gsc-of5529").iterdir())
    assert extracted == sorted(GSC_MEMBERS.values())


def test_ingest_reuses_the_extracted_members_without_the_archive(tmp_path):
    source = tmp_path / "gsc"
    write_gsc_files(source)
    archive = tmp_path / "of_5529.zip"
    write_archive(archive, source)
    cubes = tmp_path / "cubes"
    ingest_geology_age(cubes, archive)
    archive.unlink()

    assert ingest_geology_age(cubes, archive).exists()


class FakeResponse(io.BytesIO):
    def __init__(self, data: bytes, size: int, first: int = 0) -> None:
        super().__init__(data)
        self.status = 206
        self.headers = {
            "Content-Length": str(size),
            "Content-Range": f"bytes {first}-{first + len(data) - 1}/{size}",
        }


def test_cli_help_works_without_the_pyogrio_extra():
    script = (
        "import sys; sys.modules['pyogrio'] = None;"
        " from soe.cli import main; main(['--help'])"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=False,
    )

    assert completed.returncode == 0
    assert "ingest-geology-age" in completed.stdout


def test_ingest_fetches_the_members_by_range_reads_and_not_the_whole_file(tmp_path, monkeypatch):
    source = tmp_path / "gsc"
    write_gsc_files(source)
    archive = tmp_path / "of_5529.zip"
    write_archive(archive, source)
    content = archive.read_bytes()
    fetched = []

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        if request.get_method() == "HEAD":
            return FakeResponse(b"", len(content))

        first, last = request.get_header("Range").removeprefix("bytes=").split("-")
        fetched.append(int(last) - int(first) + 1)
        return FakeResponse(content[int(first):int(last) + 1], len(content), int(first))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(ingest, "READ_BUFFER_BYTES", SMALL_READ_BYTES)
    cubes = tmp_path / "cubes"

    assert ingest_geology_age(cubes).exists()
    assert sum(fetched) < len(content)


def test_range_reader_rejects_a_server_that_ignores_range_requests(monkeypatch):
    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        if request.get_method() == "HEAD":
            return FakeResponse(b"", 100)

        response = FakeResponse(bytes(100), 100)
        response.status = 200
        del response.headers["Content-Range"]
        return response

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    reader = ingest._RangeReader("https://example.test/of_5529.zip")

    with pytest.raises(OSError, match="status 200"):
        reader.read(10)


def test_range_reader_rejects_a_reply_with_a_bad_content_range(monkeypatch):
    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        if request.get_method() == "HEAD":
            return FakeResponse(b"", 100)

        response = FakeResponse(bytes(10), 100)
        response.headers["Content-Range"] = "bytes 0-99"
        return response

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    reader = ingest._RangeReader("https://example.test/of_5529.zip")

    with pytest.raises(OSError, match="Content-Range"):
        reader.read(10)


def test_range_reader_fetches_only_the_requested_bytes(monkeypatch):
    wanted = []

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        if request.get_method() == "HEAD":
            return FakeResponse(b"", 100)

        first, last = request.get_header("Range").removeprefix("bytes=").split("-")
        wanted.append((int(first), int(last)))
        return FakeResponse(bytes(int(last) - int(first) + 1), 100, int(first))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    reader = ingest._RangeReader("https://example.test/of_5529.zip")

    assert reader.read(10) == bytes(10)
    assert wanted == [(0, 9)]


def test_ingest_publishes_nothing_when_the_server_ignores_range_requests(
    tmp_path,
    monkeypatch,
):
    source = tmp_path / "gsc"
    write_gsc_files(source)
    archive = tmp_path / "of_5529.zip"
    write_archive(archive, source)
    content = archive.read_bytes()

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        if request.get_method() == "HEAD":
            return FakeResponse(b"", len(content))

        response = FakeResponse(content, len(content))
        response.status = 200
        del response.headers["Content-Range"]
        return response

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cubes = tmp_path / "cubes"

    # The reader's OSError surfaces as BadZipFile while the archive opens.
    with pytest.raises((OSError, zipfile.BadZipFile)):
        ingest_geology_age(cubes)

    assert not (cubes / GEOLOGY_AGE_FILE).exists()
    assert not (cubes / DOWNLOADS_DIR / GSC_DIR / POLYGONS_FILE).exists()


def test_ingest_publishes_nothing_for_a_bad_content_range(tmp_path, monkeypatch):
    source = tmp_path / "gsc"
    write_gsc_files(source)
    archive = tmp_path / "of_5529.zip"
    write_archive(archive, source)
    content = archive.read_bytes()

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        if request.get_method() == "HEAD":
            return FakeResponse(b"", len(content))

        response = FakeResponse(content[:SMALL_READ_BYTES], len(content))
        response.headers["Content-Range"] = "bytes 0-99"
        return response

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cubes = tmp_path / "cubes"

    # The reader's OSError surfaces as BadZipFile while the archive opens.
    with pytest.raises((OSError, zipfile.BadZipFile)):
        ingest_geology_age(cubes)

    assert not (cubes / GEOLOGY_AGE_FILE).exists()
    assert not (cubes / DOWNLOADS_DIR / GSC_DIR / POLYGONS_FILE).exists()


def test_failed_fetch_leaves_no_members_or_cog(tmp_path, monkeypatch):
    def refuse(request: urllib.request.Request, timeout: float) -> None:
        raise OSError("network down")

    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    cubes = tmp_path / "cubes"

    with pytest.raises(OSError):
        ingest_geology_age(cubes)

    assert not (cubes / GEOLOGY_AGE_FILE).exists()


def test_geology_age_is_registered_only_when_its_map_exists(tmp_path, age_cubes_dir):
    assert "geology_age" not in make_registry(RealSource(cubes_dir=tmp_path))
    assert "geology_age" in make_registry(RealSource(cubes_dir=age_cubes_dir))
    assert "geology_age" not in make_registry(SyntheticSource())
    assert "geology_age" not in make_registry(SyntheticSource(lithology=True))
    assert "geology_age" in make_registry(SyntheticSource(geology_age=True))


def test_the_age_map_alone_does_not_add_the_rock_type_layer(age_cubes_dir):
    assert "geology" not in make_registry(RealSource(cubes_dir=age_cubes_dir))


def test_scene_ids_of_other_layers_do_not_change_when_the_age_map_is_added(tmp_path, age_cubes_dir):
    def scene_id(folder: Path) -> str:
        registry = make_registry(RealSource(cubes_dir=folder))
        datasets = [registry["terrain"], registry["esa_worldcover"]]
        return compute_scene_id("poly:abc", ["terrain", "esa_worldcover"], None, datasets, {})

    assert scene_id(age_cubes_dir) == scene_id(tmp_path)


def test_geology_age_layer_reads_the_class_of_each_cell(age_cubes_dir):
    layer = make_registry(RealSource(cubes_dir=age_cubes_dir))["geology_age"]

    arrays, _ = layer.read((0.0, 0.0, 15.0, 5.0), 5.0)

    assert arrays["value"][0].tolist() == [
        AGE_VALUES["Cambrian"],
        AGE_VALUES["Phanerozoic undivided"],
        AGE_VALUES["Cenozoic undivided"],
    ]


def test_geology_age_res_for_never_finer_than_the_native_cog(age_cubes_dir):
    layer = make_registry(RealSource(cubes_dir=age_cubes_dir))["geology_age"]

    assert layer.res_for((0.0, 0.0, 0.01, 0.01)) == GEOLOGY_AGE_RES_DEG
    assert layer.res_for((36.5, -1.5, 37.5, -0.5)) >= GEOLOGY_AGE_RES_DEG


def build_age_layer(tmp_path: Path, area: Area) -> JsonObject:
    registry = make_registry(SyntheticSource(geology_age=True))
    build_scene(HASH_A, area, None, None, [registry["geology_age"]], "Test", tmp_path)
    return json.loads((tmp_path / HASH_A / "scene.json").read_text(encoding="utf-8"))


def test_geology_age_layer_is_valid_and_credits_the_survey_and_the_colours(tmp_path):
    doc = build_age_layer(tmp_path, Area(NAIROBI, BOUNDARY))
    layer = doc["layers"][0]
    credits = " ".join(doc["credits"]["lines"])

    assert validate(doc) == []
    assert layer["id"] == "geology_age" and layer["title"] == "Geological Age"
    assert layer["style"]["kind"] == "categorical" and "palette" not in layer["style"]
    assert layer["style"]["classes"] == AGE_CLASSES
    assert "Open Government Licence – Canada" in credits
    assert "Macrostrat" in credits
    assert layer["source"]["licence"] == SOURCES["gsc_world"]["licence"]


def test_geology_age_notice_states_scale_accuracy_dating_and_generalisation(tmp_path):
    doc = build_age_layer(tmp_path, Area(NAIROBI, BOUNDARY))
    limits = " ".join(doc["notices"]["limits"])

    assert "worldwide fallback" in limits and "1:35 million" in limits
    assert "tens of kilometres" in limits
    assert "only to an era or wider" in limits
    assert "generalised to ICS periods" in limits


def test_geology_age_keeps_only_known_classes_and_zero_outside_the_area(tmp_path):
    build_age_layer(tmp_path, Area(NAIROBI, BOUNDARY))
    root = zarr.open_group(str(tmp_path / HASH_A / "data.zarr"), mode="r")
    classes = root["geology_age/class"][...]
    mask = root["geology_age/mask"][...]
    valid = {0, *(entry["value"] for entry in AGE_CLASSES)}

    assert (classes[mask == 0] == 0).all()
    assert set(np.unique(classes)) <= valid
