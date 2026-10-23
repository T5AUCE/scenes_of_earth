"""Fractional area weights of a layer grid inside an outline, with cosine latitude scaling.

Each weight pairs the share of a cell covered by the outline with the cosine of its row
centre latitude, so later statistics describe outlined physical area on that grid.
"""
import numpy as np
import shapely
from rasterio.features import geometry_mask, rasterize
from rasterio.transform import Affine
from shapely.geometry import Polygon, mapping
from shapely.geometry.base import BaseGeometry

_MASK_INSIDE = 1  # mask value of cells inside the outline

_CHUNK_CELLS = 10_000  # candidate cells intersected in one vectorized batch


def area_weights(
    geometry: BaseGeometry,
    transform: Affine,
    shape: tuple[int, int],
    mask: np.ndarray,
) -> np.ndarray:
    """Return float64 weights of shape `shape` for `geometry` on the layer grid.

    Each weight is the covered fraction of its cell times the cosine of the row centre
    latitude. Cells outside the inside mask always weigh zero.
    """
    fractions = _coverage_fractions(geometry, transform, shape, mask)
    latitudes = _row_centre_latitudes(transform, shape)
    weights = fractions * latitudes
    # Mask wins over geometry, so the rendering ring never gains weight.
    weights[mask != _MASK_INSIDE] = 0.0
    return weights


def _coverage_fractions(
    geometry: BaseGeometry,
    transform: Affine,
    shape: tuple[int, int],
    mask: np.ndarray,
) -> np.ndarray:
    """Return the covered share of each cell, clipped to [0, 1], as float64."""
    fractions = np.zeros(shape, dtype="float64")
    inside = mask == _MASK_INSIDE
    if not inside.any():
        return fractions
    if geometry.is_empty:
        return fractions
    edge_cells = _boundary_cells(geometry, transform, shape)
    centre_inside = _centre_inside(geometry, transform, shape)
    # A cell the boundary never grazes is either fully inside or fully outside.
    fractions[inside & ~edge_cells & centre_inside] = 1.0
    rows, columns = np.nonzero(inside & edge_cells)
    if rows.size == 0:
        return fractions
    cell_area = abs(transform.a * transform.e - transform.b * transform.d)
    for start in range(0, rows.size, _CHUNK_CELLS):
        stop = start + _CHUNK_CELLS
        boxes = _cell_boxes(transform, rows[start:stop], columns[start:stop])
        areas = shapely.area(shapely.intersection(boxes, geometry))
        # Clipping absorbs floating point noise at shared edges.
        fractions[rows[start:stop], columns[start:stop]] = np.clip(
            areas / cell_area,
            0.0,
            1.0,
        )
    return fractions


def _boundary_cells(
    geometry: BaseGeometry,
    transform: Affine,
    shape: tuple[int, int],
) -> np.ndarray:
    """Return True for cells grazed by the outline boundary, including holes."""
    boundaries = _polygonal_boundaries(geometry)
    if not boundaries:
        return np.zeros(shape, dtype=bool)
    # all_touched catches every grazed cell, so the rest need no exact test.
    burned = rasterize(
        [(mapping(boundary), 1) for boundary in boundaries],
        out_shape=shape,
        transform=transform,
        fill=0,
        all_touched=True,
        dtype="uint8",
    )
    return burned.astype(bool)


def _polygonal_boundaries(geometry: BaseGeometry) -> list[BaseGeometry]:
    """Return boundaries of the polygonal members, so edge-only contact never crashes."""
    return [
        member.boundary for member in _polygonal_parts(geometry) if not member.boundary.is_empty
    ]


def _centre_inside(
    geometry: BaseGeometry,
    transform: Affine,
    shape: tuple[int, int],
) -> np.ndarray:
    """Return True for cells whose centre lies inside the polygonal members."""
    members = _polygonal_parts(geometry)
    if not members:
        return np.zeros(shape, dtype=bool)
    return geometry_mask(
        [mapping(member) for member in members],
        shape,
        transform,
        invert=True,
        all_touched=False,
    )


def _polygonal_parts(geometry: BaseGeometry) -> list[Polygon]:
    """Return the polygonal members, so zero-area lines and points never gain weight."""
    members: list[Polygon] = []
    stack: list[BaseGeometry] = [geometry]
    while stack:
        part = stack.pop()
        if isinstance(part, Polygon):
            members.append(part)
        elif hasattr(part, "geoms"):
            stack.extend(part.geoms)
        # Lines and points carry no area, so they fall through without a branch.
    return members


def _cell_boxes(
    transform: Affine,
    rows: np.ndarray,
    columns: np.ndarray,
) -> np.ndarray:
    """Return one shapely box per (row, column) cell in the unwrapped frame."""
    # Cells and geometry share the unwrapped frame, so corners need no wrapping.
    north_west_x = transform.c + columns * transform.a + rows * transform.b
    north_west_y = transform.f + columns * transform.d + rows * transform.e
    south_east_x = transform.c + (columns + 1) * transform.a + (rows + 1) * transform.b
    south_east_y = transform.f + (columns + 1) * transform.d + (rows + 1) * transform.e
    return shapely.box(
        np.minimum(north_west_x, south_east_x),
        np.minimum(north_west_y, south_east_y),
        np.maximum(north_west_x, south_east_x),
        np.maximum(north_west_y, south_east_y),
    )


def _row_centre_latitudes(transform: Affine, shape: tuple[int, int]) -> np.ndarray:
    """Return cosine weights of shape (height, 1) for the row centre latitudes."""
    height = shape[0]
    centres = transform.f + (np.arange(height) + 0.5) * transform.e
    return np.cos(np.radians(centres))[:, None]
