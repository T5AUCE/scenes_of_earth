import assert from "node:assert/strict";
import { test } from "node:test";
import { contours } from "d3-contour";
import {
  clipRings,
  downsample,
  maskedValues,
  pickInterval,
  thresholds,
  toLonLat,
} from "./contours.ts";
import type { Bbox } from "./types.ts";

const ramp = (count: number, top: number) =>
  Float32Array.from({ length: count }, (_, index) => (index / (count - 1)) * top);

test("interval is the smallest standard step giving about twelve lines", () => {
  assert.equal(pickInterval(ramp(1000, 2400)), 200);
  assert.equal(pickInterval(ramp(1000, 400)), 50);
  assert.equal(pickInterval(ramp(1000, 20)), 10);
  assert.equal(pickInterval(ramp(1000, 50000)), 1000);
});

test("a single high peak does not set the interval", () => {
  const values = ramp(1000, 240);
  values[999] = 8000;

  assert.equal(pickInterval(values), 20);
});

test("thresholds are multiples of the interval above zero", () => {
  assert.deepEqual(thresholds(430, 100), [100, 200, 300, 400]);
  assert.deepEqual(thresholds(5, 100), []);
});

test("downsampling averages blocks and keeps a block inside if any cell is", () => {
  const elevation = [0, 10, 20, 30, 40, 50, 60, 70];
  const mask = [0, 0, 0, 1, 0, 0, 0, 0];

  const small = downsample(elevation, mask, { bbox: [0, 0, 4, 2], nx: 4, ny: 2 }, 2);

  assert.equal(small.factor, 2);
  assert.deepEqual([small.nx, small.ny], [2, 1]);
  assert.deepEqual(Array.from(small.values), [25, 45]);
  assert.deepEqual(Array.from(small.mask), [0, 1]);
  assert.deepEqual(Array.from(maskedValues(small)), [45]);
});

test("a ring that leaves the mask is cut into runs at the mask edge", () => {
  const nx = 6;
  const ny = 4;
  const mask = new Uint8Array(nx * ny).fill(1);
  mask[1 * nx + 3] = 0;
  const ring = [[1.5, 1.5], [2.5, 1.5], [3.5, 1.5], [4.5, 1.5], [4.5, 2.5], [1.5, 2.5], [1.5, 1.5]];

  const runs = clipRings([ring], mask, nx, ny);

  assert.deepEqual(runs, [[[4.5, 1.5], [4.5, 2.5], [1.5, 2.5], [1.5, 1.5], [2.5, 1.5]]]);
});

test("vertices on the grid frame are dropped", () => {
  const nx = 4;
  const ny = 4;
  const mask = new Uint8Array(nx * ny).fill(1);
  const ring = [[0, 1.5], [1.5, 1.5], [2.5, 1.5], [4, 1.5], [2.5, 0], [0, 1.5]];

  const runs = clipRings([ring], mask, nx, ny);

  assert.deepEqual(runs, [[[1.5, 1.5], [2.5, 1.5]]]);
});

test("a ring wholly inside the mask stays closed", () => {
  const mask = new Uint8Array(16).fill(1);
  const ring = [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 1.5]];

  assert.deepEqual(clipRings([ring], mask, 4, 4), [ring]);
});

test("grid corners map to the bbox corners and rows run north to south", () => {
  const grid = { bbox: [10, -4, 20, 6] as Bbox, nx: 100, ny: 50 };
  const run: [number, number][] = [[0, 0], [100, 50]];

  const levels = [{ elevation: 500, runs: [run] }];
  const blocks = { nx: grid.nx, ny: grid.ny, factor: 1 };

  const { features } = toLonLat(levels, grid, blocks, 100);

  assert.deepEqual(features[0].geometry.coordinates, [[[10, 6], [20, -4]]]);
});

test("a downsampled grid keeps the same extent", () => {
  const grid = { bbox: [0, 0, 8, 4] as Bbox, nx: 8, ny: 4 };
  const run: [number, number][] = [[4, 2]];

  const levels = [{ elevation: 100, runs: [run] }];
  const blocks = { nx: 4, ny: 2, factor: 2 };

  const { features } = toLonLat(levels, grid, blocks, 100);

  assert.deepEqual(features[0].geometry.coordinates, [[[8, 0]]]);
});

test("a narrower last block maps its far edge to the bbox edge", () => {
  const grid = { bbox: [0, 0, 5, 5] as Bbox, nx: 5, ny: 5 };
  const blocks = { nx: 3, ny: 3, factor: 2 };
  const run: [number, number][] = [[2, 2], [3, 3]];

  const { features } = toLonLat([{ elevation: 100, runs: [run] }], grid, blocks, 100);

  assert.deepEqual(features[0].geometry.coordinates, [[[4, 1], [5, 0]]]);
});

test("every fifth line is major", () => {
  const grid = { bbox: [0, 0, 1, 1] as Bbox, nx: 1, ny: 1 };
  const run: [number, number][] = [[0, 0], [1, 1]];
  const levels = [100, 200, 500, 600].map((elevation) => ({ elevation, runs: [run] }));

  const { features } = toLonLat(levels, grid, { nx: grid.nx, ny: grid.ny, factor: 1 }, 100);

  const majors = features.map((feature) => feature.properties.major);

  assert.deepEqual(majors, [false, false, true, false]);
});

test("a grid east of 180 keeps its longitudes unwrapped", () => {
  const bbox: Bbox = [177.2, -19, 182.8, -16];
  const grid = { bbox, nx: 56, ny: 30 };
  const run: [number, number][] = [[56, 0], [56, 30]];

  const levels = [{ elevation: 100, runs: [run] }];
  const blocks = { nx: grid.nx, ny: grid.ny, factor: 1 };

  const { features } = toLonLat(levels, grid, blocks, 100);

  assert.deepEqual(features[0].geometry.coordinates[0].map(([lon]) => lon), [182.8, 182.8]);
});

test("contours of a hill inside a mask stay clear of the mask edge and the frame", () => {
  const nx = 40;
  const ny = 40;
  const elevation = new Float32Array(nx * ny);
  const mask = new Uint8Array(nx * ny);

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const distance = Math.hypot(x - 20, y - 20);
      elevation[y * nx + x] = 1000 - 50 * distance;
      mask[y * nx + x] = distance < 12 ? 1 : 0;
    }
  }

  const sampled = downsample(elevation, mask, { bbox: [0, 0, nx, ny], nx, ny });
  const multiPolygons = contours()
    .size([nx, ny])
    .smooth(true)
    .thresholds([400, 800])(sampled.values as unknown as number[]);
  const runs = multiPolygons.flatMap(({ coordinates }) => {
    return coordinates.flatMap((polygon) => clipRings(polygon, sampled.mask, nx, ny));
  });

  const points = runs.flat();

  assert.ok(points.length > 0);
  assert.ok(points.every(([x, y]) => Math.hypot(x - 20, y - 20) < 12.8));
  assert.ok(points.every(([x, y]) => x > 0 && x < nx && y > 0 && y < ny));
});
