"""Sample-area tests: the bundled geometries and how seeding treats real boundaries."""
import json

from shapely.geometry import shape

from soe import db
from soe.areas import unwrap
from soe.sample_areas import SAMPLE_AREAS, seed_sample_areas
from tests.helpers import boundary_row


def test_sample_area_geometries_are_valid_raw_and_unwrapped():
    features = json.loads(SAMPLE_AREAS.read_text())["features"]

    for feature in features:
        geometry = shape(feature["geometry"])

        assert geometry.is_valid, feature["properties"]["id"]
        assert unwrap(geometry).is_valid, feature["properties"]["id"]


def test_sample_areas_reload_on_startup_and_real_boundaries_suppress_them(tmp_path):
    db_path = tmp_path / "soe.db"
    db.init(db_path)
    stale_sample = boundary_row(
        "sample:old",
        "state",
        "Sample: Old strip",
        cells=1,
        source="synthetic",
        licence="none (hand-drawn sample)",
    )
    db.add_boundaries(db_path, "synthetic", [stale_sample])

    seed_sample_areas(db_path)

    assert db.get_boundary(db_path, "sample:old") is None
    assert db.get_boundary(db_path, "sample:kenya")["licence"].startswith("Public Domain")

    real_boundary = boundary_row("x", "state", "Other")
    db.add_boundaries(db_path, "geoBoundaries CGAZ", [real_boundary])
    db.add_boundaries(db_path, "synthetic", [stale_sample])

    seed_sample_areas(db_path)

    assert db.get_boundary(db_path, "sample:old") is not None
