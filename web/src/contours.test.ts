import assert from "node:assert/strict";
import { test } from "node:test";
import { contours } from "d3-contour";
import {
  clipRings,
  covers,
  downsample,
  factorFor,
  maskedValues,
  pickInterval,
  thresholds,
  toLonLat,
  viewInGridWorld,
  viewWindow,
  wholeGrid,
  windowBounds,
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
  assert.deepEqual(Array.from(small.inside), [0, 1]);
  assert.deepEqual(Array.from(maskedValues(small)), [45]);
});

test("downsampling flags blocks with data apart from blocks inside the area", () => {
  const elevation = [NaN, NaN, 5, NaN];
  const mask = [1, 0, 0, 0];

  const small = downsample(elevation, mask, { bbox: [0, 0, 2, 2], nx: 2, ny: 2 }, 2);

  assert.deepEqual(Array.from(small.hasData), [0, 0, 1, 0]);
  assert.deepEqual(Array.from(small.inside), [1, 0, 0, 0]);
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
  const blocks = { nx: grid.nx, ny: grid.ny, factor: 1, sourceWindow: wholeGrid(grid) };

  const { features } = toLonLat(levels, grid, blocks, 100);

  assert.deepEqual(features[0].geometry.coordinates, [[[10, 6], [20, -4]]]);
});

test("a downsampled grid keeps the same extent", () => {
  const grid = { bbox: [0, 0, 8, 4] as Bbox, nx: 8, ny: 4 };
  const run: [number, number][] = [[4, 2]];

  const levels = [{ elevation: 100, runs: [run] }];
  const blocks = { nx: 4, ny: 2, factor: 2, sourceWindow: wholeGrid(grid) };

  const { features } = toLonLat(levels, grid, blocks, 100);

  assert.deepEqual(features[0].geometry.coordinates, [[[8, 0]]]);
});

test("a narrower last block maps its far edge to the bbox edge", () => {
  const grid = { bbox: [0, 0, 5, 5] as Bbox, nx: 5, ny: 5 };
  const blocks = { nx: 3, ny: 3, factor: 2, sourceWindow: wholeGrid(grid) };
  const run: [number, number][] = [[2, 2], [3, 3]];

  const { features } = toLonLat([{ elevation: 100, runs: [run] }], grid, blocks, 100);

  assert.deepEqual(features[0].geometry.coordinates, [[[4, 1], [5, 0]]]);
});

test("every fifth line is major", () => {
  const grid = { bbox: [0, 0, 1, 1] as Bbox, nx: 1, ny: 1 };
  const run: [number, number][] = [[0, 0], [1, 1]];
  const levels = [100, 200, 500, 600].map((elevation) => ({ elevation, runs: [run] }));

  const blocks = { nx: grid.nx, ny: grid.ny, factor: 1, sourceWindow: wholeGrid(grid) };

  const { features } = toLonLat(levels, grid, blocks, 100);

  const majors = features.map((feature) => feature.properties.major);

  assert.deepEqual(majors, [false, false, true, false]);
});

test("a grid east of 180 keeps its longitudes unwrapped", () => {
  const bbox: Bbox = [177.2, -19, 182.8, -16];
  const grid = { bbox, nx: 56, ny: 30 };
  const run: [number, number][] = [[56, 0], [56, 30]];

  const levels = [{ elevation: 100, runs: [run] }];
  const blocks = { nx: grid.nx, ny: grid.ny, factor: 1, sourceWindow: wholeGrid(grid) };

  const { features } = toLonLat(levels, grid, blocks, 100);

  assert.deepEqual(features[0].geometry.coordinates[0].map(([lon]) => lon), [182.8, 182.8]);
});

test("a source window picks the block factor that fits the side limit", () => {
  assert.equal(factorFor(1771, 2233), 3);
  assert.equal(factorFor(1024, 900), 1);
  assert.equal(factorFor(1025, 10), 2);
});

test("downsampling a window reads only the cells inside it", () => {
  const nx = 6;
  const ny = 4;
  const elevation = Array.from({ length: nx * ny }, (_, cell) => cell);
  const mask = new Array(nx * ny).fill(1);
  const grid = { bbox: [0, 0, nx, ny] as Bbox, nx, ny };

  const sampled = downsample(elevation, mask, grid, 2, { x: 2, y: 1, width: 3, height: 2 });

  assert.equal(sampled.factor, 2);
  assert.deepEqual([sampled.nx, sampled.ny], [2, 1]);
  assert.deepEqual(Array.from(sampled.values), [(8 + 9 + 14 + 15) / 4, (10 + 16) / 2]);
});

test("a view becomes a padded window of source cells", () => {
  const grid = { bbox: [0, 0, 100, 50] as Bbox, nx: 1000, ny: 500 };

  const found = viewWindow(grid, [10, 10, 20, 20], 0.5);

  assert.deepEqual(found?.sourceWindow, { x: 50, y: 250, width: 200, height: 200 });
  assert.equal(found?.factor, 1);
});

test("a view past the grid is clamped, and one beside it has no window", () => {
  const grid = { bbox: [0, 0, 100, 50] as Bbox, nx: 1000, ny: 500 };

  const clamped = viewWindow(grid, [-30, 40, 5, 70], 0);

  assert.deepEqual(clamped?.sourceWindow, { x: 0, y: 0, width: 50, height: 100 });
  assert.equal(viewWindow(grid, [200, 10, 210, 20], 0.5), null);
});

test("a view in another world copy is moved next to the grid", () => {
  const fiji: Bbox = [177, -19, 181.6, -16];
  const draggedEast: Bbox = [-180.655, -18, -178.897, -17];
  const draggedWest: Bbox = [-540, -18, -538, -17];

  assert.deepEqual(viewInGridWorld([178, -18, 180, -17], fiji), [178, -18, 180, -17]);
  assert.deepEqual(viewInGridWorld(draggedEast, fiji), [179.345, -18, 181.103, -17]);
  assert.deepEqual(viewInGridWorld(draggedWest, fiji), [180, -18, 182, -17]);
});

test("a window maps back to the bbox it came from", () => {
  const grid = { bbox: [177.2, -19, 182.8, -16] as Bbox, nx: 56, ny: 30 };

  assert.deepEqual(windowBounds(grid, wholeGrid(grid)), grid.bbox);
  assert.deepEqual(windowBounds(grid, { x: 10, y: 5, width: 20, height: 10 }), [
    178.2,
    -17.5,
    180.2,
    -16.5,
  ]);
});

test("detail lines east of 180 with a narrow last block stay unwrapped", () => {
  const grid = { bbox: [178, -19, 183, -16] as Bbox, nx: 50, ny: 30 };
  const sourceWindow = { x: 41, y: 10, width: 9, height: 20 };
  const cells = new Array(grid.nx * grid.ny).fill(1);
  const sampled = downsample(cells, cells, grid, 4, sourceWindow);
  const run: [number, number][] = [[0, 0], [sampled.nx, sampled.ny]];

  const { features } = toLonLat([{ elevation: 100, runs: [run] }], grid, sampled, 100);

  assert.equal(sampled.factor, 5);
  assert.deepEqual(features[0].geometry.coordinates, [[[182.1, -17], [183, -19]]]);
});

test("a view is covered when the window holds the part of it over the grid", () => {
  const grid: Bbox = [0, 0, 10, 10];
  const outer: Bbox = [0, 0, 6, 10];

  assert.equal(covers(outer, [-5, 2, 4, 8], grid), true);
  assert.equal(covers(outer, [2, 2, 7, 8], grid), false);
  assert.equal(covers(outer, [2, 2, 6 + 1e-12, 12], grid), true);
});

test("contours of a hill stay clear of cells without data and the frame", () => {
  const nx = 40;
  const ny = 40;
  const elevation = new Float32Array(nx * ny);
  const mask = new Uint8Array(nx * ny).fill(1);

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const distance = Math.hypot(x - 20, y - 20);
      elevation[y * nx + x] = distance < 12 ? 1000 - 50 * distance : NaN;
    }
  }

  const sampled = downsample(elevation, mask, { bbox: [0, 0, nx, ny], nx, ny });
  const multiPolygons = contours()
    .size([nx, ny])
    .smooth(true)
    .thresholds([400, 800])(sampled.values as unknown as number[]);
  const runs = multiPolygons.flatMap(({ coordinates }) => {
    return coordinates.flatMap((polygon) => clipRings(polygon, sampled.hasData, nx, ny));
  });

  const points = runs.flat();

  assert.ok(points.length > 0);
  assert.ok(points.every(([x, y]) => Math.hypot(x - 20, y - 20) < 12.8));
  assert.ok(points.every(([x, y]) => x > 0 && x < nx && y > 0 && y < ny));
});
