import type { Bbox } from "./types";

export interface ContourGrid {
  bbox: Bbox;
  nx: number;
  ny: number;
}

export interface Downsampled {
  values: Float32Array;
  mask: Uint8Array;
  nx: number;
  ny: number;
  factor: number; // source cells per side of one downsampled cell
}

// Grid coordinates: sample i sits at i + 0.5, so x spans [0, nx] and y spans [0, ny].
export type Run = [number, number][];

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

export const MAX_SIDE_CELLS = 1024;
export const MAJOR_EVERY = 5;

const INTERVALS_M = [10, 20, 50, 100, 200, 250, 500, 1000];
const TARGET_LINE_COUNT = 12;
const LOW_PERCENTILE = 0.02;
const HIGH_PERCENTILE = 0.98;
const MAX_PERCENTILE_SAMPLES = 65536;

// Block means keep the shape of the relief; a block counts as inside if any cell in it is.
export function downsample(
  elevation: ArrayLike<number>,
  mask: ArrayLike<number>,
  { nx, ny }: ContourGrid,
  maxSide = MAX_SIDE_CELLS,
): Downsampled {
  const factor = Math.ceil(Math.max(nx, ny) / maxSide);
  const width = Math.ceil(nx / factor);
  const height = Math.ceil(ny / factor);
  const values = new Float32Array(width * height);
  const insideMask = new Uint8Array(width * height);

  for (let row = 0; row < height; row++) {
    const yEnd = Math.min(ny, (row + 1) * factor);

    for (let column = 0; column < width; column++) {
      const xEnd = Math.min(nx, (column + 1) * factor);
      let sum = 0;
      let count = 0;
      let isInside = false;

      for (let y = row * factor; y < yEnd; y++) {
        for (let x = column * factor; x < xEnd; x++) {
          const cell = y * nx + x;
          if (mask[cell]) isInside = true;
          if (Number.isFinite(elevation[cell])) {
            sum += elevation[cell];
            count++;
          }
        }
      }

      const target = row * width + column;
      values[target] = count ? sum / count : 0;
      insideMask[target] = isInside ? 1 : 0;
    }
  }

  return { values, mask: insideMask, nx: width, ny: height, factor };
}

export function maskedValues({ values, mask }: Downsampled) {
  return values.filter((_, index) => mask[index]);
}

// The smallest interval that gives about TARGET_LINE_COUNT lines across the typical relief.
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

// Multiples of the interval above zero, so the coastline is not drawn as a contour.
export function thresholds(maxElevation: number, interval: number) {
  const levels: number[] = [];

  for (let level = interval; level <= maxElevation; level += interval) levels.push(level);

  return levels;
}

// d3 gives closed rings along the grid frame and across masked-out cells; those parts are dropped.
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

export function toLonLat(
  levels: ContourLevel[],
  grid: ContourGrid,
  blocks: Pick<Downsampled, "nx" | "ny" | "factor">,
  interval: number,
): ContourFeatureCollection {
  const [west, south, east, north] = grid.bbox;
  const degreesPerColumn = (east - west) / grid.nx;
  const degreesPerRow = (north - south) / grid.ny;
  const majorInterval = MAJOR_EVERY * interval;

  const toPosition = ([x, y]: number[]) => [
    west + sourceCells(x, blocks.nx, grid.nx, blocks.factor) * degreesPerColumn,
    north - sourceCells(y, blocks.ny, grid.ny, blocks.factor) * degreesPerRow,
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
