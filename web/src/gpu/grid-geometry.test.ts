import assert from "node:assert/strict";
import { test } from "node:test";

import type { Bbox } from "../types.ts";
import { localMatrix, quadExtent, rowTable, textureTiles } from "./grid-geometry.ts";

const MAX_TEXTURE_SIZE_PX = 4096;
const HALO_CELLS = 2;

const gridOf = (bbox: Bbox, nx: number, ny: number) => ({ bbox, nx, ny });
const KENYA_LIKE = gridOf([34, -4.7, 41.9, 5.1], 100, 120);

const mercatorY = (latitude: number) =>
  Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
const latitudeOf = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

// An fp64 translation is needed to expose high-zoom cancellation.
function mainMatrix(zoom: number, centre: [number, number], viewPx = 1000) {
  const scale = (512 * 2 ** zoom * 2) / viewPx;
  const matrix = new Float64Array(16);
  matrix[0] = scale;
  matrix[5] = -scale;
  matrix[10] = 1;
  matrix[12] = -centre[0] * scale;
  matrix[13] = centre[1] * scale;
  matrix[15] = 1;
  return matrix;
}

// GPU arithmetic rounds every operation to single precision.
const singlePrecisionClipX = (matrix: ArrayLike<number>, x: number) =>
  Math.fround(Math.fround(Math.fround(matrix[0]) * Math.fround(x)) + Math.fround(matrix[12]));

const cornerOf = (
  { origin, extent }: { origin: number[]; extent: number[] },
  u: number,
  v: number,
): [number, number] => [origin[0] + u * extent[0], origin[1] + v * extent[1]];

const project = (matrix: ArrayLike<number>, [x, y]: [number, number]) => [
  matrix[0] * x + matrix[4] * y + matrix[12],
  matrix[1] * x + matrix[5] * y + matrix[13],
];

test("row table matches cell rows at mercator samples", () => {
  const samples = 257;
  const table = rowTable(KENYA_LIKE, samples);
  const [, south, , north] = KENYA_LIKE.bbox;
  const yTop = mercatorY(north);
  const yBottom = mercatorY(south);

  for (const sample of [0, 40, 128, 200, 256]) {
    const latitude = latitudeOf(yTop + ((yBottom - yTop) * sample) / (samples - 1));
    const expected = ((north - latitude) / (north - south)) * KENYA_LIKE.ny;
    assert.ok(Math.abs(table[sample] - expected) < 1e-3);
  }
});

test("row table is monotonic and spans grid", () => {
  const table = rowTable(KENYA_LIKE, 64);

  assert.equal(table[0], 0);
  assert.equal(table[63], KENYA_LIKE.ny);
  for (let sample = 1; sample < table.length; sample++) {
    assert.ok(table[sample] > table[sample - 1]);
  }
});

test("local matrix maps corners like absolute matrix", () => {
  const grid = KENYA_LIKE;
  const quad = quadExtent(grid, { column: 0, row: 0, width: grid.nx, height: grid.ny }, 0);
  const main = mainMatrix(6, [quad.origin[0] + quad.extent[0] / 2, quad.origin[1]]);
  const local = localMatrix(main, quad, 0);

  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0.3, 0.7]] as [number, number][]) {
    const expected = project(main, cornerOf(quad, u, v));
    const actual = project(local, [u, v]);
    assert.ok(Math.abs(actual[0] - expected[0]) < 1e-5);
    assert.ok(Math.abs(actual[1] - expected[1]) < 1e-5);
  }
});

test("local matrix moves the quad by whole worlds", () => {
  const quad = quadExtent(KENYA_LIKE, { column: 0, row: 0, width: 100, height: 120 }, 0);
  const main = mainMatrix(0, [0.5, 0.5], 512);

  const [shifted] = project(localMatrix(main, quad, 1), [0, 0]);
  const [home] = project(localMatrix(main, quad, 0), [0, 0]);

  assert.ok(Math.abs(shifted - home - 2) < 1e-5);
});

test("local matrix keeps subpixel precision at z18", () => {
  const viewPx = 1000;
  const grid = gridOf([36.8, -1.3, 36.85, -1.25], 50, 50);
  const quad = quadExtent(grid, { column: 0, row: 0, width: 50, height: 50 }, 0);
  const centre = cornerOf(quad, 0.5, 0.5);
  const main = mainMatrix(18, centre, viewPx);
  const local = localMatrix(main, quad, 0);
  const toPx = viewPx / 2;

  const [u, v] = [0.37, 0.61];
  const expected = project(main, cornerOf(quad, u, v));
  const actual = project(local, [u, v]);
  const absoluteSingle = singlePrecisionClipX(main, cornerOf(quad, u, v)[0]);

  assert.ok(Math.abs(actual[0] - expected[0]) * toPx < 0.05);
  assert.ok(Math.abs(actual[1] - expected[1]) * toPx < 0.05);
  assert.ok(Math.abs(absoluteSingle - expected[0]) * toPx > 1);
});

test("quad extent splits the grid height into row spans that add up", () => {
  const upper = quadExtent(KENYA_LIKE, { column: 0, row: 0, width: 100, height: 40 }, 0);
  const lower = quadExtent(KENYA_LIKE, { column: 0, row: 40, width: 100, height: 80 }, 0);

  assert.equal(upper.rowSpan[0], 0);
  assert.ok(Math.abs(upper.rowSpan[0] + upper.rowSpan[1] - lower.rowSpan[0]) < 1e-12);
  assert.ok(Math.abs(lower.rowSpan[0] + lower.rowSpan[1] - 1) < 1e-12);
  assert.ok(Math.abs(upper.origin[1] + upper.extent[1] - lower.origin[1]) < 1e-12);
});

test("grid within texture limit is one tile", () => {
  const tiles = textureTiles(MAX_TEXTURE_SIZE_PX, 3000, MAX_TEXTURE_SIZE_PX);

  assert.equal(tiles.length, 1);
  assert.deepEqual(tiles[0].core, { column: 0, row: 0, width: 4096, height: 3000 });
  assert.deepEqual(tiles[0].window, tiles[0].core);
});

test("split tiles cover every cell once with two cell halo", () => {
  const [nx, ny, maxSize] = [23, 11, 10];
  const tiles = textureTiles(nx, ny, maxSize);
  const covered = new Uint8Array(nx * ny);

  for (const { core, window } of tiles) {
    assert.ok(window.width <= maxSize && window.height <= maxSize);
    assert.ok(core.column - window.column === Math.min(HALO_CELLS, core.column));
    assert.ok(core.row - window.row === Math.min(HALO_CELLS, core.row));
    for (let row = core.row; row < core.row + core.height; row++) {
      for (let column = core.column; column < core.column + core.width; column++) {
        covered[row * nx + column] += 1;
      }
    }
  }
  assert.ok(covered.every((count) => count === 1));
});

test("tile halo is clamped at grid edges", () => {
  const tiles = textureTiles(20, 5, 10);
  const first = tiles[0];
  const last = tiles[tiles.length - 1];

  assert.equal(first.window.column, 0);
  assert.equal(first.window.row, 0);
  assert.equal(last.window.column + last.window.width, 20);
  assert.equal(last.window.row + last.window.height, 5);
  assert.equal(first.window.width, first.core.width + HALO_CELLS);
});
