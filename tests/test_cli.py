"""Test the CLI command that removes leftover CGAZ rows."""

import json

from shapely.geometry import box, mapping

from soe import cli, db
from soe.areas import Area
from soe.land import clip_area_to_land, write_land_store
from tests.helpers import boundary_row


def test_delete_cgaz_command_removes_legacy_rows_and_prints_counts(tmp_path, capsys):
    path = str(tmp_path / "soe.db")
    db.init(path)
    legacy = "geoBoundaries CGAZ"
    home = box(0, 0, 1, 1)
    db.add_boundaries(
        path,
        legacy,
        [
            boundary_row(
                "legacy:KE",
                "country",
                "Kenya",
                iso3="KEN",
                bbox=home.bounds,
                geometry=json.dumps(mapping(home)),
                source=legacy,
            )
        ],
    )
    store = tmp_path / "land.sqlite"
    write_land_store(store, "v1", [home])
    clip_area_to_land(path, store, Area(home, db.get_boundary(path, "legacy:KE")))

    cli.main(["delete-cgaz", "--db", path])

    assert db.get_boundary(path, "legacy:KE") is None
    with db.connect(path) as connection:
        remaining = [row[0] for row in connection.execute("SELECT geom_digest FROM land_clips")]

    assert remaining == []
    db.require_search_names(path)
    out = capsys.readouterr().out

    assert "CGAZ rows: 1 boundaries" in out
    assert "land clips" in out
