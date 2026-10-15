import type { Bbox } from "./types";

export interface ContourGrid {
  bbox: Bbox;
  nx: number;
  ny: number;
}

/** A rectangle of source cells; y counts down from the north edge. */
export interface GridWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Block means of a grid window, flagging blocks that have data or lie inside the area. */
export interface Downsampled {
  values: Float32Array;
  hasData: Uint8Array; // 1 where any source cell of the block has an elevation
  inside: Uint8Array; // 1 where any source cell of the block is inside the area
  nx: number;
  ny: number;
  factor: number; // source cells per side of one downsampled cell
  sourceWindow: GridWindow;
}

/** One contour polyline in grid coordinates: sample i sits at i + 0.5, so x spans [0, nx]. */
export type Run = [number, number][];

/** The contour runs at one elevation. */
export interface ContourLevel {
  elevation: number;
  runs: Run[];
}

export interface ContourFeatureCollection {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { elev: number; major: boolean };
    geometry: { type: "MultiLineString"; coordinates: number[][][] };
  }[];
}

/** Most blocks per side that contours are traced on; larger windows are averaged into blocks. */
export const MAX_SIDE_CELLS = 1024;
/** Job number of the whole-area contours; detail windows count up from it. */
export const COARSE_JOB = 0;

/** Every this-many-th contour interval is drawn bold. */
export const MAJOR_EVERY = 5;
const INTERVALS_M = [10, 20, 50, 100, 200, 250, 500, 1000];
const TARGET_LINE_COUNT = 18;
const LOW_PERCENTILE = 0.02;
const HIGH_PERCENTILE = 0.98;
const MAX_PERCENTILE_SAMPLES = 65536;

const MIN_BLUR_SIGMA_BLOCKS = 1;
const MAX_BLUR_SIGMA_BLOCKS = 1.5;
const BLUR_SIGMA_PER_FACTOR = 0.25;
const KERNEL_RADIUS_SIGMAS = 3;

const WORLD_WIDTH_DEG = 360;
const BOUNDS_TOLERANCE_DEG = 1e-9;

/** A window covering the whole grid. */
export const wholeGrid = ({ nx, ny }: { nx: number; ny: number }): GridWindow => ({
  x: 0,
  y: 0,
  width: nx,
  height: ny,
});

/** Source cells per block side, so neither side exceeds maxSide blocks. */
export const factorFor = (width: number, height: number, maxSide = MAX_SIDE_CELLS) =>
  Math.ceil(Math.max(width, height) / maxSide);

/**
 * Averages a window into blocks; block means keep the relief's shape, and a block counts if any
 * cell does.
 */
export function downsample(
  elevation: ArrayLike<number>,
  mask: ArrayLike<number>,
  grid: ContourGrid,
  maxSide = MAX_SIDE_CELLS,
  sourceWindow = wholeGrid(grid),
): Downsampled {
  const factor = factorFor(sourceWindow.width, sourceWindow.height, maxSide);
  const width = Math.ceil(sourceWindow.width / factor);
  const height = Math.ceil(sourceWindow.height / factor);
  const values = new Float32Array(width * height);
  const hasData = new Uint8Array(width * height);
  const inside = new Uint8Array(width * height);

  for (let row = 0; row < height; row++) {
    const yStart = sourceWindow.y + row * factor;
    const yEnd = Math.min(sourceWindow.y + sourceWindow.height, yStart + factor);

    for (let column = 0; column < width; column++) {
      const xStart = sourceWindow.x + column * factor;
      const xEnd = Math.min(sourceWindow.x + sourceWindow.width, xStart + factor);
      let sum = 0;
      let count = 0;
      let isInside = false;

      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          const cell = y * grid.nx + x;
          if (mask[cell]) isInside = true;
          if (Number.isFinite(elevation[cell])) {
            sum += elevation[cell];
            count++;
          }
        }
      }

      const target = row * width + column;
      values[target] = count ? sum / count : 0;
      hasData[target] = count ? 1 : 0;
      inside[target] = isInside ? 1 : 0;
    }
  }
  return { values, hasData, inside, nx: width, ny: height, factor, sourceWindow };
}

/**
 * Blurs the block means with a Gaussian that skips blocks without data, so the area edge and
 * missing cells do not bleed in; blocks without data keep 0.
 */
export function smoothed(sampled: Downsampled): Downsampled {
  const { values, hasData, nx, ny, factor } = sampled;
  const kernel = gaussianKernel(blurSigma(factor));
  const weights = Float32Array.from(hasData);
  const weighted = values.map((value, index) => value * weights[index]);

  const blurredWeighted = blur(weighted, nx, ny, kernel);
  const blurredWeights = blur(weights, nx, ny, kernel);
  const blurred = values.map((_, index) =>
    hasData[index] ? blurredWeighted[index] / blurredWeights[index] : 0,
  );
  return { ...sampled, values: blurred };
}

// Finer blocks get a lighter blur so zoomed-in views stay sharp.
function blurSigma(factor: number) {
  const sigma = MIN_BLUR_SIGMA_BLOCKS + BLUR_SIGMA_PER_FACTOR * (factor - 1);
  return Math.min(MAX_BLUR_SIGMA_BLOCKS, sigma);
}

function gaussianKernel(sigma: number) {
  const radius = Math.ceil(KERNEL_RADIUS_SIGMAS * sigma);
  return Float32Array.from({ length: 2 * radius + 1 }, (_, index) => {
    const offset = index - radius;
    return Math.exp(-(offset * offset) / (2 * sigma * sigma));
  });
}

function blur(values: Float32Array, nx: number, ny: number, kernel: Float32Array) {
  return convolve(convolve(values, nx, ny, kernel, true), nx, ny, kernel, false);
}

// Samples beyond the grid edge count as zero, which the caller's weights cancel out.
function convolve(
  values: Float32Array,
  nx: number,
  ny: number,
  kernel: Float32Array,
  isAlongRows: boolean,
) {
  const radius = (kernel.length - 1) / 2;
  const lineLength = isAlongRows ? nx : ny;
  const lineCount = isAlongRows ? ny : nx;
  const step = isAlongRows ? 1 : nx;
  const lineStep = isAlongRows ? nx : 1;
  const result = new Float32Array(values.length);

  for (let line = 0; line < lineCount; line++) {
    const lineStart = line * lineStep;

    for (let position = 0; position < lineLength; position++) {
      let sum = 0;
      const first = Math.max(0, position - radius);
      const last = Math.min(lineLength - 1, position + radius);

      for (let neighbour = first; neighbour <= last; neighbour++) {
        sum += kernel[neighbour - position + radius] * values[lineStart + neighbour * step];
      }
      result[lineStart + position * step] = sum;
    }
  }
  return result;
}

/** The source cells showing a view, padded by a fraction of its size so small pans stay inside. */
export function viewWindow(
  grid: ContourGrid,
  view: Bbox,
  margin: number,
  maxSide = MAX_SIDE_CELLS,
) {
  const [west, south, east, north] = grid.bbox;
  const degreesPerColumn = (east - west) / grid.nx;
  const degreesPerRow = (north - south) / grid.ny;

  const left = (view[0] - west) / degreesPerColumn;
  const right = (view[2] - west) / degreesPerColumn;
  const top = (north - view[3]) / degreesPerRow;
  const bottom = (north - view[1]) / degreesPerRow;
  const paddingX = (right - left) * margin;
  const paddingY = (bottom - top) * margin;

  const x = Math.max(0, Math.floor(left - paddingX));
  const y = Math.max(0, Math.floor(top - paddingY));
  const width = Math.min(grid.nx, Math.ceil(right + paddingX)) - x;
  const height = Math.min(grid.ny, Math.ceil(bottom + paddingY)) - y;
  if (width <= 0 || height <= 0) return null;

  return { sourceWindow: { x, y, width, height }, factor: factorFor(width, height, maxSide) };
}

/** The bbox of a window of source cells. */
export function windowBounds(grid: ContourGrid, { x, y, width, height }: GridWindow): Bbox {
  const [west, south, east, north] = grid.bbox;
  const degreesPerColumn = (east - west) / grid.nx;
  const degreesPerRow = (north - south) / grid.ny;

  return [
    west + x * degreesPerColumn,
    north - (y + height) * degreesPerRow,
    west + (x + width) * degreesPerColumn,
    north - y * degreesPerRow,
  ];
}

/**
 * The view moved into the grid's world copy; MapLibre wraps the centre across 180, the grid may
 * not.
 */
export function viewInGridWorld(view: Bbox, gridBbox: Bbox): Bbox {
  const gridCenter = (gridBbox[0] + gridBbox[2]) / 2;
  const viewCenter = (view[0] + view[2]) / 2;
  const shift = WORLD_WIDTH_DEG * Math.round((gridCenter - viewCenter) / WORLD_WIDTH_DEG);
  return [view[0] + shift, view[1], view[2] + shift, view[3]];
}

/** Whether outer covers the view; only the part of the view over the grid needs covering. */
export function covers(outer: Bbox, view: Bbox, within: Bbox) {
  const needed = [
    Math.max(view[0], within[0]),
    Math.max(view[1], within[1]),
    Math.min(view[2], within[2]),
    Math.min(view[3], within[3]),
  ];
  return (
    outer[0] <= needed[0] + BOUNDS_TOLERANCE_DEG
    && outer[1] <= needed[1] + BOUNDS_TOLERANCE_DEG
    && outer[2] >= needed[2] - BOUNDS_TOLERANCE_DEG
    && outer[3] >= needed[3] - BOUNDS_TOLERANCE_DEG
  );
}

/** The downsampled values inside the area. */
export function maskedValues({ values, inside }: Downsampled) {
  return values.filter((_, index) => inside[index]);
}

/** The smallest interval that gives about TARGET_LINE_COUNT lines across the typical relief. */
export function pickInterval(values: ArrayLike<number>) {
  if (!values.length) return INTERVALS_M[0];

  const stride = Math.ceil(values.length / MAX_PERCENTILE_SAMPLES);
  const sampleCount = Math.ceil(values.length / stride);
  const sample = Float32Array.from(
    { length: sampleCount },
    (_, index) => values[index * stride],
  ).sort();

  const low = sample[Math.floor(LOW_PERCENTILE * (sample.length - 1))];
  const high = sample[Math.floor(HIGH_PERCENTILE * (sample.length - 1))];
  const wanted = (high - low) / TARGET_LINE_COUNT;
  const largestInterval = INTERVALS_M[INTERVALS_M.length - 1];

  return INTERVALS_M.find((interval) => interval >= wanted) ?? largestInterval;
}

/** Multiples of the interval above zero, so the coastline is not drawn as a contour. */
export function thresholds(maxElevation: number, interval: number) {
  const levels: number[] = [];
  for (let level = interval; level <= maxElevation; level += interval) levels.push(level);
  return levels;
}

/**
 * Contour runs over cells with data; d3 closes rings along the grid frame and across empty cells,
 * so those parts are dropped.
 */
export function clipRings(rings: number[][][], mask: ArrayLike<number>, nx: number, ny: number) {
  const runs: Run[] = [];

  const isKept = ([x, y]: number[]) => {
    const isOnFrame = x <= 0 || x >= nx || y <= 0 || y >= ny;
    return !isOnFrame && mask[Math.floor(y) * nx + Math.floor(x)] > 0;
  };

  for (const ring of rings) {
    const points = ring.slice(0, -1);
    const firstDropped = points.findIndex((point) => !isKept(point));

    if (firstDropped < 0) {
      runs.push(ring.map(([x, y]) => [x, y]));
      continue;
    }

    let run: Run = [];

    for (let offset = 1; offset <= points.length; offset++) {
      const [x, y] = points[(firstDropped + offset) % points.length];

      if (isKept([x, y])) {
        run.push([x, y]);
        continue;
      }

      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  return runs;
}

/** Contour runs in block coordinates as GeoJSON lines in longitude and latitude. */
export function toLonLat(
  levels: ContourLevel[],
  grid: ContourGrid,
  blocks: Pick<Downsampled, "nx" | "ny" | "factor" | "sourceWindow">,
  interval: number,
): ContourFeatureCollection {
  const [west, south, east, north] = grid.bbox;
  const degreesPerColumn = (east - west) / grid.nx;
  const degreesPerRow = (north - south) / grid.ny;
  const majorInterval = MAJOR_EVERY * interval;

  const { sourceWindow, factor } = blocks;

  const sourceColumn = (x: number) =>
    sourceWindow.x + sourceCells(x, blocks.nx, sourceWindow.width, factor);
  const sourceRow = (y: number) =>
    sourceWindow.y + sourceCells(y, blocks.ny, sourceWindow.height, factor);

  const toPosition = ([x, y]: number[]) => [
    west + sourceColumn(x) * degreesPerColumn,
    north - sourceRow(y) * degreesPerRow,
  ];

  const features = levels
    .filter(({ runs }) => runs.length)
    .map(({ elevation, runs }) => ({
      type: "Feature" as const,
      properties: { elev: elevation, major: elevation % majorInterval === 0 },
      geometry: {
        type: "MultiLineString" as const,
        coordinates: runs.map((run) => run.map(toPosition)),
      },
    }));
  return { type: "FeatureCollection", features };
}

// The last block is narrower than the others when the grid is not a multiple of the factor.
function sourceCells(position: number, blockCount: number, sourceCount: number, factor: number) {
  const fullBlocks = blockCount - 1;
  if (position <= fullBlocks) return position * factor;

  return fullBlocks * factor + (position - fullBlocks) * (sourceCount - fullBlocks * factor);
}
