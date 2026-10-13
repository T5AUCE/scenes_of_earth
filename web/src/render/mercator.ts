import type { Bbox } from "../types";

/** The source cell for each output pixel of a Web Mercator image. */
export interface SampleTable {
  width: number;
  height: number;
  src: Int32Array; // per output pixel: source cell index
}

interface Grid {
  bbox: Bbox;
  nx: number;
  ny: number;
}

/** Nested arrays of [longitude, latitude] positions, as in GeoJSON. */
export type Coordinates = number[] | Coordinates[];

type Corners = [[number, number], [number, number], [number, number], [number, number]];

const MAX_TEXTURE_SIZE_PX = 4096;
// Keeps rounding noise from adding a row to an already exact fit.
const ROW_COUNT_TOLERANCE = 1e-9;

const WORLD_WIDTH_DEG = 360;
const ANTIMERIDIAN_DEG = 180;

/** Web Mercator y of a latitude in degrees. */
export function mercY(lat: number) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/**
 * The grid cell each output pixel shows. Rows are even in Mercator y because MapLibre stretches
 * images linearly in Web Mercator.
 */
export function sampleTable(
  grid: Grid,
  maxTextureSize = MAX_TEXTURE_SIZE_PX,
): SampleTable {
  const { nx, ny } = grid;
  const [, south, , north] = grid.bbox;
  const rowDegrees = (north - south) / ny;
  const yTop = mercY(north);
  const yBottom = mercY(south);

  const rowCount = Math.ceil((yTop - yBottom) / finestRowHeight(grid) - ROW_COUNT_TOLERANCE);
  const height = Math.min(maxTextureSize, MAX_TEXTURE_SIZE_PX, rowCount);
  const width = Math.min(maxTextureSize, nx);
  const pixelHeight = (yTop - yBottom) / height;

  const src = new Int32Array(width * height);
  for (let pixelRow = 0; pixelRow < height; pixelRow++) {
    const lat = latFromMercY(yTop - (pixelRow + 0.5) * pixelHeight);
    const gridRow = Math.min(ny - 1, Math.max(0, Math.floor((north - lat) / rowDegrees)));

    for (let pixelColumn = 0; pixelColumn < width; pixelColumn++) {
      const gridColumn = Math.floor(((pixelColumn + 0.5) * nx) / width);
      src[pixelRow * width + pixelColumn] = gridRow * nx + gridColumn;
    }
  }
  return { width, height, src };
}

/** A centre above 180 gives MapLibre an out-of-range tile, so the image moves one world west. */
export function imageCorners(bbox: Bbox): Corners {
  const [west, south, east, north] = bbox;
  const shift = worldShift(bbox);

  return [
    [west + shift, north],
    [east + shift, north],
    [east + shift, south],
    [west + shift, south],
  ];
}

/** The longitude offset that moves an image, and anything drawn with it, into the visible world. */
export function worldShift([west, , east]: Bbox) {
  const isEastOfAntimeridian = (west + east) / 2 > ANTIMERIDIAN_DEG;
  return isEastOfAntimeridian ? -WORLD_WIDTH_DEG : 0;
}

/** Coordinates moved east by degrees, at any nesting depth. */
export function shiftLongitudes(coordinates: Coordinates, degrees: number): Coordinates {
  if (typeof coordinates[0] === "number") {
    const [longitude, ...rest] = coordinates as number[];
    return [longitude + degrees, ...rest];
  }

  return (coordinates as Coordinates[]).map((inner) => shiftLongitudes(inner, degrees));
}

// The shortest row in Mercator y sets the output resolution, so no grid row is skipped.
function finestRowHeight({ bbox, ny }: Grid) {
  const [, south, , north] = bbox;
  const rowDegrees = (north - south) / ny;

  let finest = Infinity;
  for (let row = 0; row < ny; row++) {
    const rowTop = mercY(north - row * rowDegrees);
    const rowBottom = mercY(north - (row + 1) * rowDegrees);
    finest = Math.min(finest, rowTop - rowBottom);
  }
  return finest;
}

function latFromMercY(y: number) {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}
