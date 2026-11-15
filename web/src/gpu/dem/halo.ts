/** Lay out padded DEM textures using neighbouring edge strips and diagonal corners. */
import { DEM_TILE_SIZE_PX, STRIP_WIDTH_PX, stripOf, type StripSide } from "./decode";
import type { WantedTile } from "./plan";

/** The side length of a tile texture including its halo on every side. */
export const TEXTURE_SIZE_PX = DEM_TILE_SIZE_PX + 2 * STRIP_WIDTH_PX;
/** The bytes of one R32F texture. */
export const TEXTURE_BYTES = TEXTURE_SIZE_PX ** 2 * Float32Array.BYTES_PER_ELEMENT;

const HALO_OFFSET_PX = DEM_TILE_SIZE_PX + STRIP_WIDTH_PX;

interface Offset {
  dx: number;
  dy: number;
}

interface HaloRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Corner extends Offset {
  halo: HaloRect;
}

interface Edge extends Corner {
  neighbourStrip: StripSide;
}

/** Facing pairs keep `index ^ 1` pointing at the opposite edge. */
export const EDGES: Edge[] = (
  [
    { dx: 0, dy: -1, neighbourStrip: "bottom" },
    { dx: 0, dy: 1, neighbourStrip: "top" },
    { dx: -1, dy: 0, neighbourStrip: "right" },
    { dx: 1, dy: 0, neighbourStrip: "left" },
  ] satisfies Omit<Edge, "halo">[]
).map((edge) => ({ ...edge, halo: haloRect(edge.dx, edge.dy) }));

/** Facing pairs keep `index ^ 1` pointing at the opposite corner. */
export const CORNERS: Corner[] = [
  { dx: -1, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 1 },
].map((corner) => ({ ...corner, halo: haloRect(corner.dx, corner.dy) }));

function haloRect(dx: number, dy: number): HaloRect {
  const offset = (direction: number) => {
    return direction < 0 ? 0 : direction > 0 ? HALO_OFFSET_PX : STRIP_WIDTH_PX;
  };

  return {
    x: offset(dx),
    y: offset(dy),
    width: dx === 0 ? DEM_TILE_SIZE_PX : STRIP_WIDTH_PX,
    height: dy === 0 ? DEM_TILE_SIZE_PX : STRIP_WIDTH_PX,
  };
}

/** Fill missing neighbours by repeating the tile's edge pixels so it can draw before they land. */
export function fillPaddedTile(
  padded: Float32Array,
  heights: Float32Array,
  neighbourStrips: (Float32Array | null)[],
  cornerData: (Float32Array | null)[],
): void {
  const size = DEM_TILE_SIZE_PX;
  const stride = TEXTURE_SIZE_PX;
  const [northStrip, southStrip, westStrip, eastStrip] = neighbourStrips;
  const last = size - 1;

  for (let row = 0; row < size; row++) {
    const start = (row + STRIP_WIDTH_PX) * stride;
    padded.set(heights.subarray(row * size, (row + 1) * size), start + STRIP_WIDTH_PX);

    for (let column = 0; column < STRIP_WIDTH_PX; column++) {
      const west = westStrip?.[row * STRIP_WIDTH_PX + column] ?? heights[row * size];
      const east = eastStrip?.[row * STRIP_WIDTH_PX + column] ?? heights[row * size + last];
      padded[start + column] = west;
      padded[start + HALO_OFFSET_PX + column] = east;
    }
  }

  for (let line = 0; line < STRIP_WIDTH_PX; line++) {
    const north = northStrip?.subarray(line * size, (line + 1) * size) ?? heights.subarray(0, size);
    const south =
      southStrip?.subarray(line * size, (line + 1) * size) ?? heights.subarray(last * size);
    padded.set(north, line * stride + STRIP_WIDTH_PX);
    padded.set(south, (HALO_OFFSET_PX + line) * stride + STRIP_WIDTH_PX);
  }

  fillCorners(padded, heights, cornerData);
}

function fillCorners(
  padded: Float32Array,
  heights: Float32Array,
  cornerData: (Float32Array | null)[],
): void {
  const size = DEM_TILE_SIZE_PX;
  CORNERS.forEach((corner, index) => {
    const data = cornerData[index];
    const row = corner.dy < 0 ? 0 : size - 1;
    const column = corner.dx < 0 ? 0 : size - 1;
    const fallback = heights[row * size + column];

    for (let line = 0; line < STRIP_WIDTH_PX; line++) {
      for (let column = 0; column < STRIP_WIDTH_PX; column++) {
        padded[(corner.halo.y + line) * TEXTURE_SIZE_PX + corner.halo.x + column] = data
          ? data[line * STRIP_WIDTH_PX + column]
          : fallback;
      }
    }
  });
}

/** Read the corner pixels from the top or bottom strip that holds them. */
export function diagonalCorner(strips: Float32Array, corner: Offset): Float32Array {
  const side = stripOf(strips, corner.dy < 0 ? "top" : "bottom");
  const first = corner.dx < 0 ? 0 : DEM_TILE_SIZE_PX - STRIP_WIDTH_PX;

  return Float32Array.of(
    side[first],
    side[first + 1],
    side[DEM_TILE_SIZE_PX + first],
    side[DEM_TILE_SIZE_PX + first + 1],
  );
}

/** Find the same-zoom neighbour with x wrapping and -1 for rows past the poles. */
export function neighbourKey(tile: Pick<WantedTile, "z" | "x" | "y">, offset: Offset): number {
  const size = 2 ** tile.z;
  const y = tile.y + offset.dy;
  if (y < 0 || y >= size) return -1;

  return tileKey({ z: tile.z, x: (tile.x + offset.dx + size) % size, y });
}

/** Use a unique numeric tile key so a frame's lookups allocate no strings. */
export function tileKey(tile: Pick<WantedTile, "z" | "x" | "y">): number {
  const size = 2 ** tile.z;
  return (size * size - 1) / 3 + tile.y * size + tile.x;
}
