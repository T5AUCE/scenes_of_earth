import assert from "node:assert/strict";
import { test } from "node:test";
import { imageCorners, mercY, sampleTable } from "./mercator.ts";

const allInside = (n: number) => new Uint8Array(n).fill(1);

test("rows map to source rows in order, never going back up", () => {
  const grid = { bbox: [10, 40, 12, 50] as [number, number, number, number], nx: 4, ny: 10 };
  const table = sampleTable(grid, allInside(40));

  let previousRow = 0;
  for (let j = 0; j < table.height; j++) {
    const row = Math.floor(table.src[j * 4] / 4);
    assert.ok(row >= previousRow);
    previousRow = row;
  }
  assert.equal(table.src[0], 0);
  assert.equal(table.src[table.src.length - 1], 39);
  assert.ok(table.height >= 10);
});

test("near the equator the table is the grid itself", () => {
  const grid = { bbox: [0, -0.05, 0.1, 0.05] as [number, number, number, number], nx: 2, ny: 2 };
  const table = sampleTable(grid, allInside(4));

  assert.equal(table.height, 2);
  assert.deepEqual([...table.src], [0, 1, 2, 3]);
});

test("cells outside the mask become -1", () => {
  const grid = { bbox: [0, 0, 2, 1] as [number, number, number, number], nx: 2, ny: 1 };
  const table = sampleTable(grid, Uint8Array.of(1, 0));

  assert.deepEqual([...table.src.slice(0, 2)], [0, -1]);
});

test("the height is capped", () => {
  const grid = { bbox: [0, 0, 1, 1] as [number, number, number, number], nx: 1, ny: 100 };

  assert.equal(sampleTable(grid, allInside(100), 30).height, 30);
});

test("Mercator y grows faster than latitude away from the equator", () => {
  assert.ok(Math.abs(mercY(0)) < 1e-12);
  assert.ok(mercY(60) - mercY(50) > mercY(10) - mercY(0));
});

test("corners shift one world west only when the centre is above 180", () => {
  assert.deepEqual(imageCorners([177, -20, 180, -15])[0], [177, -15]);
  assert.deepEqual(imageCorners([170, -20, 190, -15])[1], [190, -15]);
  assert.deepEqual(imageCorners([175, -20, 195, -15])[0], [-185, -15]);
});
