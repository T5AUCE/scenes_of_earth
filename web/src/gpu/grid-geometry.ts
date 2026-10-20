import type { Bbox } from "../types";

interface Grid {
  bbox: Bbox;
  nx: number;
  ny: number;
}

/** A block of grid cells, counted from the grid's north-west corner. */
export interface CellWindow {
  column: number;
  row: number;
  width: number;
  height: number;
}

/** The cells a texture holds and the part of them that its quad draws. */
export interface TextureTile {
  core: CellWindow;
  window: CellWindow;
}

/** Where a quad sits in Mercator world units, where the whole world is 1 wide. */
export interface QuadExtent {
  origin: [number, number];
  extent: [number, number];
  /** The quad's vertical start and length as fractions of the whole grid's Mercator height. */
  rowSpan: [number, number];
}

/** A shader samples this many cells beyond a tile's core on every side. */
export const HALO_CELLS = 2;

const MATRIX_SIZE = 4;
const WORLD_WIDTH_DEG = 360;

/**
 * Map evenly spaced Web Mercator heights to fractional rows from the grid's north edge.
 * A shader looks up a pixel's row here because grid rows are even in latitude.
 */
export function rowTable({ bbox, ny }: Grid, samples: number) {
  const [, south, , north] = bbox;
  const rowDegrees = (north - south) / ny;
  const yTop = mercatorY(north);
  const yBottom = mercatorY(south);

  const rows = new Float32Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    const latitude = latitudeOf(yTop + ((yBottom - yTop) * sample) / (samples - 1));
    rows[sample] = (north - latitude) / rowDegrees;
  }
  rows[0] = 0;
  rows[samples - 1] = ny;
  return rows;
}

/**
 * Map a quad's local corners to clip space with main · translate · scale.
 * The product uses double precision because adding the world position to a corner in
 * single precision would shift it by pixels at high zoom.
 */
export function localMatrix(
  main: ArrayLike<number>,
  { origin, extent }: Pick<QuadExtent, "origin" | "extent">,
  worldOffset: number,
) {
  const matrix = new Float32Array(MATRIX_SIZE * MATRIX_SIZE);
  const originX = origin[0] + worldOffset;
  for (let row = 0; row < MATRIX_SIZE; row++) {
    const x = main[row];
    const y = main[MATRIX_SIZE + row];
    matrix[row] = x * extent[0];
    matrix[MATRIX_SIZE + row] = y * extent[1];
    matrix[2 * MATRIX_SIZE + row] = main[2 * MATRIX_SIZE + row];
    matrix[3 * MATRIX_SIZE + row] = x * originX + y * origin[1] + main[3 * MATRIX_SIZE + row];
  }
  return matrix;
}

/**
 * Split a grid into texture tiles no larger than maxSize cells per side.
 * Cores partition the grid while each window adds a halo to keep kernel samples in its texture.
 */
export function textureTiles(nx: number, ny: number, maxSize: number, halo = HALO_CELLS) {
  const columns = axisSpans(nx, maxSize, halo);
  const rows = axisSpans(ny, maxSize, halo);

  const tiles: TextureTile[] = [];
  for (const row of rows) {
    for (const column of columns) {
      tiles.push({
        core: { column: column.start, row: row.start, width: column.size, height: row.size },
        window: {
          column: column.windowStart,
          row: row.windowStart,
          width: column.windowSize,
          height: row.windowSize,
        },
      });
    }
  }
  return tiles;
}

/** The Mercator quad of a block of cells, moved east by `shift` degrees. */
export function quadExtent(grid: Grid, core: CellWindow, shift: number): QuadExtent {
  const [west, south, east, north] = grid.bbox;
  const columnDegrees = (east - west) / grid.nx;
  const rowDegrees = (north - south) / grid.ny;

  const left = west + shift + core.column * columnDegrees;
  const top = mercatorY(north - core.row * rowDegrees);
  const bottom = mercatorY(north - (core.row + core.height) * rowDegrees);
  const gridTop = mercatorY(north);
  const gridHeight = gridTop - mercatorY(south);

  return {
    origin: [(left + WORLD_WIDTH_DEG / 2) / WORLD_WIDTH_DEG, 0.5 - top / (2 * Math.PI)],
    extent: [
      (core.width * columnDegrees) / WORLD_WIDTH_DEG,
      (top - bottom) / (2 * Math.PI),
    ],
    rowSpan: [(gridTop - top) / gridHeight, (top - bottom) / gridHeight],
  };
}

function axisSpans(count: number, maxSize: number, halo: number) {
  const coreSize = count <= maxSize ? count : maxSize - 2 * halo;

  const spans = [];
  for (let start = 0; start < count; start += coreSize) {
    const size = Math.min(coreSize, count - start);
    const windowStart = Math.max(0, start - halo);
    const windowEnd = Math.min(count, start + size + halo);
    spans.push({ start, size, windowStart, windowSize: windowEnd - windowStart });
  }
  return spans;
}

// Imported modules would need an extension for the node tests, so the formulas are repeated.
function mercatorY(latitude: number) {
  return Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
}

function latitudeOf(y: number) {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}
