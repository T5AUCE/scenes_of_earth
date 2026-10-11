import type { Bbox } from "../types";

export interface SampleTable {
  width: number;
  height: number;
  src: Int32Array; // per output pixel: source cell index, or -1 when the cell is outside the mask
}

interface Grid {
  bbox: Bbox;
  nx: number;
  ny: number;
}

// Nested arrays of [longitude, latitude] positions, as in GeoJSON.
export type Coordinates = number[] | Coordinates[];

type Corners = [[number, number], [number, number], [number, number], [number, number]];

const MAX_TEXTURE_SIZE_PX = 4096;
// Keeps rounding noise from adding a row to an already exact fit.
const ROW_COUNT_TOLERANCE = 1e-9;
const WORLD_WIDTH_DEGREES = 360;
const ANTIMERIDIAN_DEGREES = 180;

export function mercY(lat: number) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

// MapLibre stretches an image linearly in Web Mercator, but grid rows are equally spaced in
// latitude. Output rows are equally spaced in Mercator y so the two agree.
// Width and height never exceed maxTextureSize, so the image fits the GPU; wider grids are
// sampled with the nearest column.
export function sampleTable(
  grid: Grid,
  mask: ArrayLike<number>,
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
      const cell = gridRow * nx + gridColumn;
      src[pixelRow * width + pixelColumn] = mask[cell] ? cell : -1;
    }
  }

  return { width, height, src };
}

// A centre above 180 would give MapLibre an out-of-range tile, so the image is drawn one
// world to the west instead.
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

// The longitude offset that moves an image, and anything drawn with it, into the visible world.
export function worldShift([west, , east]: Bbox) {
  const isEastOfAntimeridian = (west + east) / 2 > ANTIMERIDIAN_DEGREES;

  return isEastOfAntimeridian ? -WORLD_WIDTH_DEGREES : 0;
}

export function shiftLongitudes(coordinates: Coordinates, degrees: number): Coordinates {
  if (typeof coordinates[0] === "number") {
    const [longitude, ...rest] = coordinates as number[];

    return [longitude + degrees, ...rest];
  }

  return (coordinates as Coordinates[]).map((inner) => shiftLongitudes(inner, degrees));
}

function latFromMercY(y: number) {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

// In Mercator y, the height of the shortest grid row.
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
