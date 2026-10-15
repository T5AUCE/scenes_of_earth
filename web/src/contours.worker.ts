import { contours } from "d3-contour";

import {
  clipRings,
  COARSE_JOB,
  downsample,
  MAX_SIDE_CELLS,
  maskedValues,
  pickInterval,
  smoothed,
  thresholds,
  toLonLat,
  wholeGrid,
  type ContourGrid,
  type Downsampled,
  type GridWindow,
} from "./contours";

/** What the worker keeps from the start message, so later windows need no new read. */
export interface ContourSource {
  elevation: Float32Array;
  mask: ArrayLike<number>;
  grid: ContourGrid;
}

/** Start with the whole elevation grid, or ask for one finer window. */
export type ContourRequest =
  | ({ kind: "start" } & ContourSource)
  | { kind: "detail"; job: number; sourceWindow: GridWindow };

/** Contour lines for one job, with the interval they use. */
export interface ContourResult {
  job: number;
  interval: number;
  collection: ReturnType<typeof toLonLat>;
}

let source: ContourSource | null = null;

self.onmessage = (event: MessageEvent<ContourRequest>) => {
  const request = event.data;

  if (request.kind === "start") {
    source = request;
    const result = contourWindow(source, wholeGrid(source.grid), COARSE_JOB);
    self.postMessage(result);
    return;
  }

  if (!source) throw new Error("Contours were asked for detail before the elevation arrived");

  self.postMessage(contourWindow(source, request.sourceWindow, request.job));
};

function contourWindow(
  { elevation, mask, grid }: ContourSource,
  sourceWindow: GridWindow,
  job: number,
): ContourResult {
  const sampled = smoothed(downsample(elevation, mask, grid, MAX_SIDE_CELLS, sourceWindow));
  const inside = maskedValues(sampled);
  const interval = pickInterval(inside);
  const maxElevation = inside.reduce((top, value) => Math.max(top, value), 0);
  const levelRuns = contourRuns(sampled, thresholds(maxElevation, interval));

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
