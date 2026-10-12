import { contours } from "d3-contour";
import {
  clipRings,
  downsample,
  maskedValues,
  pickInterval,
  thresholds,
  toLonLat,
  type ContourGrid,
  type Downsampled,
} from "./contours";

export interface ContourRequest {
  elevation: Float32Array;
  mask: ArrayLike<number>;
  grid: ContourGrid;
}

export interface ContourResult {
  interval: number;
  collection: ReturnType<typeof toLonLat>;
}

self.onmessage = (event: MessageEvent<ContourRequest>) => {
  const started = performance.now();
  const { elevation, mask, grid } = event.data;

  const sampled = downsample(elevation, mask, grid);
  const inside = maskedValues(sampled);
  const interval = pickInterval(inside);
  const maxElevation = inside.reduce((top, value) => Math.max(top, value), 0);
  const levelRuns = contourRuns(sampled, thresholds(maxElevation, interval));

  const result: ContourResult = {
    interval,
    collection: toLonLat(levelRuns, grid, sampled, interval),
  };

  console.info(`contours: ${Math.round(performance.now() - started)} ms`);
  self.postMessage(result);
};

// The unmasked grid is contoured: d3 treats NaN as -Infinity, which would ring the mask edge.
function contourRuns({ values, mask, nx, ny }: Downsampled, levels: number[]) {
  const multiPolygons = contours()
    .size([nx, ny])
    .smooth(true)
    .thresholds(levels)(values as unknown as number[]);

  return multiPolygons.map(({ value, coordinates }) => ({
    elevation: value,
    runs: coordinates.flatMap((polygon) => clipRings(polygon, mask, nx, ny)),
  }));
}
