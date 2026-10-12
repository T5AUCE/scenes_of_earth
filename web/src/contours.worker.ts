import { contours } from "d3-contour";
import {
  clipRings,
  COARSE_JOB,
  downsample,
  MAX_SIDE_CELLS,
  maskedValues,
  pickInterval,
  thresholds,
  toLonLat,
  wholeGrid,
  type ContourGrid,
  type Downsampled,
  type GridWindow,
} from "./contours";

export interface ContourSource {
  elevation: Float32Array;
  mask: ArrayLike<number>;
  grid: ContourGrid;
}

export type ContourRequest =
  | ({ kind: "start" } & ContourSource)
  | { kind: "detail"; job: number; sourceWindow: GridWindow };

export interface ContourResult {
  job: number;
  interval: number;
  collection: ReturnType<typeof toLonLat>;
}

let source: ContourSource | null = null;
let wholeAreaInterval = 0;

self.onmessage = (event: MessageEvent<ContourRequest>) => {
  const request = event.data;

  if (request.kind === "start") {
    source = request;
    const result = contourWindow(source, wholeGrid(source.grid), COARSE_JOB);
    wholeAreaInterval = result.interval;
    self.postMessage(result);

    return;
  }

  if (!source) throw new Error("Contours were asked for detail before the elevation arrived");

  self.postMessage(contourWindow(source, request.sourceWindow, request.job, wholeAreaInterval));
};

// A detail window reuses the whole-area interval so the legend and the bold lines stay the same.
function contourWindow(
  { elevation, mask, grid }: ContourSource,
  sourceWindow: GridWindow,
  job: number,
  fixedInterval?: number,
): ContourResult {
  const started = performance.now();

  const sampled = downsample(elevation, mask, grid, MAX_SIDE_CELLS, sourceWindow);
  const inside = maskedValues(sampled);
  const interval = fixedInterval ?? pickInterval(inside);
  const maxElevation = inside.reduce((top, value) => Math.max(top, value), 0);
  const levelRuns = contourRuns(sampled, thresholds(maxElevation, interval));

  console.info(`contours: ${Math.round(performance.now() - started)} ms (job ${job})`);

  return { job, interval, collection: toLonLat(levelRuns, grid, sampled, interval) };
}

// Cells without data hold 0, since d3 treats NaN as -Infinity, which would ring their edge.
function contourRuns({ values, hasData, nx, ny }: Downsampled, levels: number[]) {
  const multiPolygons = contours()
    .size([nx, ny])
    .smooth(true)
    .thresholds(levels)(values as unknown as number[]);

  return multiPolygons.map(({ value, coordinates }) => ({
    elevation: value,
    runs: coordinates.flatMap((polygon) => clipRings(polygon, hasData, nx, ny)),
  }));
}
