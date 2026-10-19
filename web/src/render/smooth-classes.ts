import type { Bbox } from "../types";

interface Grid {
  bbox: Bbox;
  nx: number;
  ny: number;
}

/** A picture of class indexes, where 0 is transparent. */
export interface ClassRaster {
  width: number;
  height: number;
  ids: Uint8Array;
}

/** Most output pixels per grid cell along each axis. */
const MAX_SMOOTH_SCALE = 4;
// About 14 ns per pixel on a desktop core, which keeps the first smoothed paint near 100 ms.
const MAX_SMOOTH_PIXELS = 8_000_000;
const CORNER_COUNT = 4;
const OPAQUE = 255;
// Weights of different classes that differ by less than this are treated as a tie.
const TIE_TOLERANCE = 1e-6;

/** The index from 1 of each cell's class in classValues, or 0 for fill, no data or unknown. */
export function cellClassIds(values: Float32Array, classValues: number[]) {
  const indexByValue = new Uint8Array(Math.max(...classValues) + 1);
  classValues.forEach((value, index) => {
    indexByValue[value] = index + 1;
  });

  const ids = new Uint8Array(values.length);
  // Indexing by NaN or a fractional value gives undefined, which `| 0` turns into 0.
  for (let cell = 0; cell < values.length; cell++) ids[cell] = indexByValue[values[cell]] | 0;
  return ids;
}

/**
 * Rounds the borders between classes without mixing colours. Each class is a 0/1 field over the
 * cells, sampled bilinearly at every output pixel, and the pixel takes the class with the highest
 * value. Cells without a class never compete, so the painted area keeps its nearest-cell outline.
 * Ties go to the class of the nearest cell. Rows are even in Web Mercator y, as in sampleTable.
 * Large areas get fewer pixels per cell so that the paint stays quick.
 */
export function smoothClassIds(
  cellIds: Uint8Array,
  grid: Grid,
  baseSize: { width: number; height: number },
  maxTextureSize: number,
): ClassRaster {
  const affordableScale = Math.sqrt(MAX_SMOOTH_PIXELS / (baseSize.width * baseSize.height));
  const scale = Math.max(1, Math.min(MAX_SMOOTH_SCALE, affordableScale));
  const width = Math.min(maxTextureSize, Math.round(baseSize.width * scale));
  const height = Math.min(maxTextureSize, Math.round(baseSize.height * scale));
  const columns = columnSamples(grid.nx, width);
  const rows = rowSamples(grid, height);

  const ids = new Uint8Array(width * height);
  const corner = new Uint8Array(CORNER_COUNT);
  const weight = new Float64Array(CORNER_COUNT);
  for (let row = 0; row < height; row++) {
    const upper = rows.first[row] * grid.nx;
    const lower = rows.second[row] * grid.nx;
    const rowWeight = rows.weight[row];

    for (let column = 0; column < width; column++) {
      const left = columns.first[column];
      const right = columns.second[column];
      const columnWeight = columns.weight[column];
      corner[0] = cellIds[upper + left];
      corner[1] = cellIds[upper + right];
      corner[2] = cellIds[lower + left];
      corner[3] = cellIds[lower + right];
      if (corner[0] === corner[1] && corner[0] === corner[2] && corner[0] === corner[3]) {
        ids[row * width + column] = corner[0];
        continue;
      }

      weight[0] = (1 - columnWeight) * (1 - rowWeight);
      weight[1] = columnWeight * (1 - rowWeight);
      weight[2] = (1 - columnWeight) * rowWeight;
      weight[3] = columnWeight * rowWeight;

      const nearest = (rowWeight < 0.5 ? 0 : 2) + (columnWeight < 0.5 ? 0 : 1);
      ids[row * width + column] = strongestClass(corner, weight, nearest);
    }
  }
  return { width, height, ids };
}

function strongestClass(corner: Uint8Array, weight: Float64Array, nearest: number) {
  if (corner[nearest] === 0) return 0;

  let best = corner[nearest];
  let bestWeight = classWeight(corner, weight, best);
  for (const id of corner) {
    if (id === 0 || id === best) continue;

    const candidateWeight = classWeight(corner, weight, id);
    if (candidateWeight > bestWeight + TIE_TOLERANCE) {
      best = id;
      bestWeight = candidateWeight;
    }
  }
  return best;
}

function classWeight(corner: Uint8Array, weight: Float64Array, id: number) {
  let total = 0;
  for (let index = 0; index < CORNER_COUNT; index++) {
    if (corner[index] === id) total += weight[index];
  }
  return total;
}

/** The two cells either side of each output pixel centre, and the share of the second. */
interface AxisSamples {
  first: Int32Array;
  second: Int32Array;
  weight: Float64Array;
}

function columnSamples(nx: number, width: number) {
  return axisSamples(nx, width, (pixel) => ((pixel + 0.5) * nx) / width);
}

function rowSamples({ bbox, ny }: Grid, height: number) {
  const [, south, , north] = bbox;
  const rowDegrees = (north - south) / ny;
  const yTop = mercatorY(north);
  const pixelHeight = (yTop - mercatorY(south)) / height;

  return axisSamples(ny, height, (pixel) => {
    const latitude = (Math.atan(Math.sinh(yTop - (pixel + 0.5) * pixelHeight)) * 180) / Math.PI;
    return (north - latitude) / rowDegrees;
  });
}

// Cell centres sit half a cell inside the cell edges, so the position moves by half a cell.
function axisSamples(
  cellCount: number,
  pixelCount: number,
  cellPosition: (pixel: number) => number,
) {
  const samples: AxisSamples = {
    first: new Int32Array(pixelCount),
    second: new Int32Array(pixelCount),
    weight: new Float64Array(pixelCount),
  };
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const position = Math.min(cellCount - 1, Math.max(0, cellPosition(pixel) - 0.5));
    const first = Math.min(cellCount - 2, Math.floor(position));
    samples.first[pixel] = Math.max(0, first);
    samples.second[pixel] = Math.min(cellCount - 1, first + 1);
    samples.weight[pixel] = position - samples.first[pixel];
  }
  return samples;
}

// Imported modules would need an extension for the node tests, so the one-line formula is repeated.
function mercatorY(latitude: number) {
  return Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
}
