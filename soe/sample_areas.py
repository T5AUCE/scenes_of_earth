"""Sample boundary outlines that seed the database in synthetic (offline) mode."""
import json
from pathlib import Path

from shapely.geometry import shape

from . import db
from .areas import unwrap
from .bundle import JsonObject

SAMPLE_AREAS = Path(__file__).parent / "data" / "sample_areas.geojson"
SAMPLE_CELL_AREA_DEG2 = 0.05**2


def seed_sample_areas(db_path: Path | str) -> None:
    """Synthetic mode only: reload the sample outlines unless real boundaries are loaded."""
    if db.has_boundaries_besides(db_path, "synthetic"):
        return

    features = json.loads(SAMPLE_AREAS.read_text())["features"]
    db.add_boundaries(db_path, "synthetic", [_sample_row(feature) for feature in features])


def _sample_row(feature: JsonObject) -> db.BoundaryValues:
    geometry, properties = shape(feature["geometry"]), feature["properties"]
    west, south, east, north = unwrap(geometry).bounds
    cells = max(1, round(geometry.area / SAMPLE_CELL_AREA_DEG2))

    return (
        properties["id"],
        properties["level"],
        properties["name"],
        properties["parent_name"],
        properties["iso3"],
        west,
        south,
        east,
        north,
        cells,
        json.dumps(feature["geometry"]),
        "synthetic",
        f"{properties['license']} ({properties['source']})",
    )
