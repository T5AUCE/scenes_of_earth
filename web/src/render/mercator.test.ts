import assert from "node:assert/strict";
import { test } from "node:test";

import { imageCorners, mercY, sampleTable, shiftLongitudes, worldShift } from "./mercator.ts";

const FLOAT_TOLERANCE = 1e-12;

const gridOf = (bbox: number[], nx: number, ny: number) => ({
  bbox: bbox as [number, number, number, number],
  nx,
  ny,
});

test("rows map to source rows in order, never going back up", () => {
  const width = 4;
  const grid = gridOf([10, 40, 12, 50], width, 10);
  const table = sampleTable(grid);

  let previousRow = 0;
  for (let pixelRow = 0; pixelRow < table.height; pixelRow++) {
    const row = Math.floor(table.src[pixelRow * width] / width);
    assert.ok(row >= previousRow);
    previousRow = row;
  }

  assert.equal(table.src[0], 0);
  assert.equal(table.src[table.src.length - 1], 39);
  assert.ok(table.height >= 10);
});

test("near the equator the table is the grid itself", () => {
  const grid = gridOf([0, -0.05, 0.1, 0.05], 2, 2);
  const table = sampleTable(grid);

  assert.equal(table.height, 2);
  assert.deepEqual([...table.src], [0, 1, 2, 3]);
});

test("every cell of the grid is drawn", () => {
  const grid = gridOf([0, 0, 3, 1], 3, 1);
  const table = sampleTable(grid);

  assert.deepEqual([...table.src.slice(0, 3)], [0, 1, 2]);
});

test("the height is capped", () => {
  const grid = gridOf([0, 0, 1, 1], 1, 100);
  const cappedHeight = 30;

  assert.equal(sampleTable(grid, cappedHeight).height, cappedHeight);
});

test("Mercator y grows faster than latitude away from the equator", () => {
  assert.ok(Math.abs(mercY(0)) < FLOAT_TOLERANCE);
  assert.ok(mercY(60) - mercY(50) > mercY(10) - mercY(0));
});

test("corners shift one world west only when the centre is above 180", () => {
  assert.deepEqual(imageCorners([177, -20, 180, -15])[0], [177, -15]);
  assert.deepEqual(imageCorners([170, -20, 190, -15])[1], [190, -15]);
  assert.deepEqual(imageCorners([175, -20, 195, -15])[0], [-185, -15]);
});

test("the table is narrower than the grid when the texture limit is smaller", () => {
  const grid = gridOf([0, 0, 10, 1], 100, 1);
  const table = sampleTable(grid, 40);

  assert.equal(table.width, 40);
  assert.equal(table.src.length, table.width * table.height);
  assert.equal(table.src[0], 1);
  assert.equal(table.src[39], 98);
});

test("the outline shifts by the same amount as the image corners", () => {
  const eastern: [number, number, number, number] = [175, -20, 195, -15];

  assert.equal(worldShift(eastern), -360);
  assert.equal(worldShift([170, -20, 190, -15]), 0);
  assert.equal(imageCorners(eastern)[0][0], eastern[0] + worldShift(eastern));
});

test("shifting longitudes keeps latitudes and nesting", () => {
  const polygon = [[[179, 1], [181, 1], [181, 2], [179, 1]]];

  assert.deepEqual(shiftLongitudes(polygon, -360), [[[-181, 1], [-179, 1], [-179, 2], [-181, 1]]]);
});
