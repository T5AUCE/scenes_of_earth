import type { Bbox } from "../types";

interface Grid {
  bbox: Bbox;
  nx: number;
  ny: number;
}

/** Store class indexes as a raster with zero representing transparency. */
export interface ClassRaster {
  width: number;
  height: number;
  ids: Uint8Array;
}

const MAX_SMOOTH_SCALE = 4;
// At about 14 ns per pixel on a desktop core, this keeps the first paint near 100 ms.
const MAX_SMOOTH_PIXELS_PX = 8_000_000;
const CORNER_COUNT = 4;
const KERNEL_SIZE = 4;
// Weights of different classes that differ by less than this are treated as a tie.
const TIE_TOLERANCE = 1e-6;

/** Map cell values to one-based class IDs and reserve zero for missing or unknown values. */
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
 * Round class borders without mixing colours. Bilinearly sample each class's presence and select
 * the class with the highest weight. Cells without a class never compete, so the painted area
 * keeps its nearest-cell outline.
 * Ties go to the class of the nearest cell. Rows are even in Web Mercator y, as in sampleTable.
 * Large areas get fewer pixels per cell so that the paint stays quick.
 */
export function smoothClassIds(
  cellIds: Uint8Array,
  grid: Grid,
  baseSize: { width: number; height: number },
  maxTextureSize: number,
): ClassRaster {
  const affordableScale = Math.sqrt(MAX_SMOOTH_PIXELS_PX / (baseSize.width * baseSize.height));
  const scale = Math.min(MAX_SMOOTH_SCALE, affordableScale);
  const width = Math.min(
    maxTextureSize,
    MAX_SMOOTH_PIXELS_PX,
    Math.max(1, Math.floor(baseSize.width * scale)),
  );
  const height = Math.min(
    maxTextureSize,
    Math.floor(MAX_SMOOTH_PIXELS_PX / width),
    Math.max(1, Math.floor(baseSize.height * scale)),
  );
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

/**
 * Find the displayed GPU class at a point in cell units from the grid's north-west corner.
 * Cell i spans i to i + 1. Bilinear weights blend towards a cubic B-spline by `rounding`
 * over the surrounding 4 x 4 cells, matching the fragment shader. Outside samples repeat edge cells.
 */
export function classAt(
  cellIds: Uint8Array,
  nx: number,
  ny: number,
  column: number,
  row: number,
  rounding: number,
) {
  const [cellColumn, cellRow] = [column - 0.5, row - 0.5];
  const [baseColumn, baseRow] = [Math.floor(cellColumn), Math.floor(cellRow)];
  const [columnFraction, rowFraction] = [cellColumn - baseColumn, cellRow - baseRow];
  const idAt = (columnIndex: number, rowIndex: number) => {
    const clampedColumn = Math.min(nx - 1, Math.max(0, columnIndex));
    const clampedRow = Math.min(ny - 1, Math.max(0, rowIndex));
    return cellIds[clampedRow * nx + clampedColumn];
  };

  const nearest = idAt(
    baseColumn + (columnFraction >= 0.5 ? 1 : 0),
    baseRow + (rowFraction >= 0.5 ? 1 : 0),
  );
  if (nearest === 0) return 0;

  const columnWeights = kernelWeights(columnFraction, rounding);
  const rowWeights = kernelWeights(rowFraction, rounding);
  const weightByClass = new Map<number, number>();
  for (let offsetRow = 0; offsetRow < KERNEL_SIZE; offsetRow++) {
    for (let offsetColumn = 0; offsetColumn < KERNEL_SIZE; offsetColumn++) {
      const id = idAt(baseColumn + offsetColumn - 1, baseRow + offsetRow - 1);
      const weight = columnWeights[offsetColumn] * rowWeights[offsetRow];
      weightByClass.set(id, (weightByClass.get(id) ?? 0) + weight);
    }
  }

  let best = nearest;
  let bestWeight = weightByClass.get(nearest)!;
  for (const [id, weight] of weightByClass) {
    if (id === 0 || id === best) continue;

    if (weight > bestWeight + TIE_TOLERANCE) {
      best = id;
      bestWeight = weight;
    }
  }
  return best;
}

function kernelWeights(fraction: number, rounding: number) {
  const cube = fraction ** 3;
  const square = fraction ** 2;
  const bilinear = [0, 1 - fraction, fraction, 0];
  const bSpline = [
    (1 - fraction) ** 3 / 6,
    (3 * cube - 6 * square + 4) / 6,
    (-3 * cube + 3 * square + 3 * fraction + 1) / 6,
    cube / 6,
  ];
  return bilinear.map((weight, index) => weight + rounding * (bSpline[index] - weight));
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

/** Store the cells bracketing each pixel centre together with the second cell's weight. */
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
