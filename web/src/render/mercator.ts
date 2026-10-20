import type { Bbox } from "../types";

/** The nearest source cells and optional coverage of a Web Mercator image. */
export interface SampleTable {
  width: number;
  height: number;
  src: Int32Array; // per output pixel: source cell index
  footprint?: {
    sourceWidth: number;
    rowEdges: Float64Array;
    rowCenters: Float64Array;
  };
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
const CELL_EDGE_TOLERANCE_CELLS = 1e-9;

const WORLD_WIDTH_DEG = 360;
const ANTIMERIDIAN_DEG = 180;

/**
 * The grid cell each output pixel shows. Rows are even in Mercator y because MapLibre stretches
 * images linearly in Web Mercator. Fields can opt into footprint coverage for NaN samples.
 */
export function sampleTable(
  grid: Grid,
  maxTextureSize = MAX_TEXTURE_SIZE_PX,
  { preserveCoverage = false }: { preserveCoverage?: boolean } = {},
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
  const table: SampleTable = { width, height, src };
  if (preserveCoverage) {
    table.footprint = pixelFootprints(grid, height, yTop, pixelHeight);
  }
  return table;
}

/**
 * The cell of `otherGrid` under each pixel of a table made for another grid, or -1 where the
 * pixel centre lies outside it. This lets two layers on different grids share one image.
 */
export function crossSampleTable(table: SampleTable, tableGrid: Grid, otherGrid: Grid) {
  const [west, south, east, north] = tableGrid.bbox;
  const [otherWest, otherSouth, otherEast, otherNorth] = otherGrid.bbox;
  const yTop = mercY(north);
  const pixelHeight = (yTop - mercY(south)) / table.height;

  const cells = new Int32Array(table.width * table.height);
  for (let pixelRow = 0; pixelRow < table.height; pixelRow++) {
    const lat = latFromMercY(yTop - (pixelRow + 0.5) * pixelHeight);
    const row = Math.floor(((otherNorth - lat) / (otherNorth - otherSouth)) * otherGrid.ny);
    const isRowInside = row >= 0 && row < otherGrid.ny;

    for (let pixelColumn = 0; pixelColumn < table.width; pixelColumn++) {
      const lon = west + ((pixelColumn + 0.5) / table.width) * (east - west);
      const column = Math.floor(((lon - otherWest) / (otherEast - otherWest)) * otherGrid.nx);
      const isInside = isRowInside && column >= 0 && column < otherGrid.nx;
      cells[pixelRow * table.width + pixelColumn] = isInside ? row * otherGrid.nx + column : -1;
    }
  }
  return cells;
}

function pixelFootprints(grid: Grid, height: number, yTop: number, pixelHeight: number) {
  const [, south, , north] = grid.bbox;
  const rowDegrees = (north - south) / grid.ny;
  const rowEdges = new Float64Array(height + 1);
  const rowCenters = new Float64Array(height);
  for (let row = 0; row <= height; row++) {
    const latitude = latFromMercY(yTop - row * pixelHeight);
    const edge = (north - latitude) / rowDegrees;
    const rounded = Math.round(edge);
    // Exact cell edges must not acquire neighbours through projection rounding.
    rowEdges[row] = Math.abs(edge - rounded) < CELL_EDGE_TOLERANCE_CELLS ? rounded : edge;
    if (row < height) {
      const centerLatitude = latFromMercY(yTop - (row + 0.5) * pixelHeight);
      rowCenters[row] = (north - centerLatitude) / rowDegrees;
    }
  }
  rowEdges[0] = 0;
  rowEdges[height] = grid.ny;
  return { sourceWidth: grid.nx, rowEdges, rowCenters };
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

/** The corners of an image over bbox, moved east by `shift` (see worldShift). */
export function imageCorners(bbox: Bbox, shift: number): Corners {
  const [west, south, east, north] = bbox;

  return [
    [west + shift, north],
    [east + shift, north],
    [east + shift, south],
    [west + shift, south],
  ];
}

/**
 * The longitude offset that moves a scene's images, and anything drawn with them, into the
 * visible world. A centre above 180 gives MapLibre an out-of-range tile, so it moves one world
 * west. Take it from the scene's bbox so that all its layers share one world copy.
 */
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

/** Web Mercator y of a latitude in degrees. */
export function mercY(lat: number) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

function latFromMercY(y: number) {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}
