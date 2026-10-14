"""Area handling: validate drawn GeoJSON and bring shapes that cross 180 into one frame."""
from collections.abc import Sequence
from dataclasses import dataclass

import shapely
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.geometry.base import BaseGeometry

MAX_VERTICES = 5000
MAX_NESTING_DEPTH = 5
DRAWN_PRECISION_DEG = 1e-4

MAX_LONGITUDE_DEG = 180
MAX_LATITUDE_DEG = 90
WORLD_WIDTH_DEG = 360


class AreaError(ValueError):
    """A request the backend refuses; the API turns this into a 422."""


@dataclass
class Area:
    """The requested area: a shape, plus its boundary row when it was picked by name."""

    geom: object  # shapely (Multi)Polygon, EPSG:4326
    boundary: dict | None = None  # boundary row for named areas, None for drawn ones

    @property
    def named(self) -> bool:
        return self.boundary is not None


def clean_polygon(obj: object) -> Polygon | MultiPolygon:
    """Validate drawn GeoJSON; return a repaired, rounded (1e-4 degrees), normalised polygon."""
    if isinstance(obj, dict) and obj.get("type") == "Feature":
        obj = obj.get("geometry")
    if not isinstance(obj, dict) or obj.get("type") not in ("Polygon", "MultiPolygon"):
        raise AreaError("geometry must be a Polygon or MultiPolygon")

    positions = _positions(obj.get("coordinates"))
    if len(positions) > MAX_VERTICES:
        raise AreaError(f"too many vertices (max {MAX_VERTICES})")
    if not _within_world(positions):
        raise AreaError(
            "coordinates must be finite numbers within +-180 longitude and +-90 latitude"
        )

    try:
        geometry = shape(obj)
    except Exception as error:
        raise AreaError(f"invalid geometry: {error}") from error

    polygons = _polygonal_parts(geometry)
    if not polygons:
        raise AreaError("geometry is empty")

    merged = MultiPolygon(polygons) if len(polygons) > 1 else polygons[0]
    geometry = shapely.set_precision(merged, DRAWN_PRECISION_DEG)
    if geometry.is_empty or geometry.area == 0:
        raise AreaError("geometry is empty")

    return shapely.normalize(geometry)


def _positions(coordinates: object) -> list[Sequence[float]]:
    """Every [x, y, ...] position of a GeoJSON coordinates array, with the nesting depth capped."""
    positions, stack = [], [(coordinates, 0)]
    while stack:
        node, depth = stack.pop()
        if not isinstance(node, (list, tuple)) or depth > MAX_NESTING_DEPTH:
            raise AreaError("invalid coordinates")

        if node and all(_is_number(value) for value in node):
            positions.append(node)
        else:
            stack.extend((child, depth + 1) for child in node)
    return positions


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _within_world(positions: list[Sequence[float]]) -> bool:
    try:
        # Written so NaN, infinity and huge integers all fail the comparison (no float conversion).
        return all(
            len(position) >= 2
            and abs(position[0]) <= MAX_LONGITUDE_DEG
            and abs(position[1]) <= MAX_LATITUDE_DEG
            for position in positions
        )
    except OverflowError:
        return False


def _polygonal_parts(geometry: BaseGeometry) -> list[Polygon]:
    """Non-empty polygons of a repaired shape; stray lines and points are dropped."""
    collection = shapely.make_valid(geometry)
    # make_valid can nest a MultiPolygon in a GeometryCollection, so flatten twice.
    parts = shapely.get_parts(shapely.get_parts(collection))
    return [part for part in parts if isinstance(part, Polygon) and not part.is_empty]


def unwrap(geom: BaseGeometry) -> BaseGeometry:
    """Put a shape that crosses 180 into one longitude frame.

    Parts west of 0 move east by 360, so longitudes go up to 360;
    parts that meet at 180 merge.
    """
    west, _, east, _ = geom.bounds
    if east - west <= MAX_LONGITUDE_DEG:
        return geom

    polygons = _polygonal_parts(geom)
    if not polygons:
        raise AreaError("geometry is empty")

    parts = [
        translate(part, xoff=WORLD_WIDTH_DEG) if sum(part.bounds[::2]) < 0 else part
        for part in polygons
    ]
    return shapely.unary_union(parts)
