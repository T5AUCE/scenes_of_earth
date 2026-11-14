/** Fetch and decode one terrarium DEM tile into heights and the edge strips neighbours need. */

/** The side length of every DEM tile in pixels. */
export const DEM_TILE_SIZE_PX = 512;
/** How many rows or columns of a tile's edge each neighbour reads. */
export const STRIP_WIDTH_PX = 2;

/** One edge of a tile; the strip of a side holds the tile's own outermost pixels there. */
export type StripSide = "top" | "bottom" | "left" | "right";

/** A decoded tile with heights in metres row by row and the four edge strips. */
export interface DemTileData {
  heights: Float32Array;
  strips: Float32Array;
  decodeMs: number;
}

const MISSING_TILE_STATUS = 404;
const STRIP_SIDES: StripSide[] = ["top", "bottom", "left", "right"];
const STRIP_LENGTH = DEM_TILE_SIZE_PX * STRIP_WIDTH_PX;

// These offsets index a strips buffer, which holds one side per STRIP_SIDES entry in order.
const TOP_STRIP_START = 0;
const BOTTOM_STRIP_START = STRIP_LENGTH;
const LEFT_STRIP_START = BOTTOM_STRIP_START + STRIP_LENGTH;
const RIGHT_STRIP_START = LEFT_STRIP_START + STRIP_LENGTH;

/** Load a tile, or null when the server has none; throws on any other failure. */
export async function loadDemTile(url: string, signal: AbortSignal): Promise<DemTileData | null> {
  const decoded = await fetchHeights(url, signal);
  if (!decoded) return null;

  const { heights, decodeMs } = decoded;
  if (heights.length !== DEM_TILE_SIZE_PX ** 2) {
    throw new Error(`Unexpected tile size ${Math.sqrt(heights.length)} px for ${url}`);
  }
  return { heights, strips: edgeStrips(heights), decodeMs };
}

/** Decode terrarium RGBA pixels to metres. */
export function decodeHeights(rgba: Uint8ClampedArray): Float32Array {
  const heights = new Float32Array(rgba.length / 4);
  for (let index = 0; index < heights.length; index++) {
    const red = rgba[index * 4];
    const green = rgba[index * 4 + 1];
    const blue = rgba[index * 4 + 2];
    heights[index] = red * 256 + green + blue / 256 - 32768;
  }
  return heights;
}

/**
 * Copy the outermost two rows and columns of a tile into one buffer. Top and bottom hold two
 * full rows, left and right hold one pair of pixels per row, which is the shape of the neighbour
 * halo they fill.
 */
export function edgeStrips(heights: Float32Array): Float32Array {
  const size = DEM_TILE_SIZE_PX;
  const strips = new Float32Array(STRIP_SIDES.length * STRIP_LENGTH);
  strips.set(heights.subarray(0, STRIP_LENGTH), TOP_STRIP_START);
  strips.set(heights.subarray(size * (size - STRIP_WIDTH_PX)), BOTTOM_STRIP_START);
  for (let row = 0; row < size; row++) {
    const rowStart = row * size;
    const stripStart = row * STRIP_WIDTH_PX;
    strips.set(
      heights.subarray(rowStart, rowStart + STRIP_WIDTH_PX),
      LEFT_STRIP_START + stripStart,
    );
    strips.set(
      heights.subarray(rowStart + size - STRIP_WIDTH_PX, rowStart + size),
      RIGHT_STRIP_START + stripStart,
    );
  }
  return strips;
}

/** A view of one side inside a buffer made by `edgeStrips`. */
export function stripOf(strips: Float32Array, side: StripSide): Float32Array {
  const start = STRIP_SIDES.indexOf(side) * STRIP_LENGTH;
  return strips.subarray(start, start + STRIP_LENGTH);
}

async function fetchHeights(
  url: string,
  signal: AbortSignal,
): Promise<{ heights: Float32Array; decodeMs: number } | null> {
  const response = await fetch(url, { signal });
  if (response.status === MISSING_TILE_STATUS) return null;
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);

  const start = performance.now();
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { heights: decodeHeights(data), decodeMs: performance.now() - start };
}
