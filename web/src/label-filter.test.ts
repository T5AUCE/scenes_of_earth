import assert from "node:assert/strict";
import { test } from "node:test";

import { polygonParts } from "./label-filter.ts";

const square = (west: number, east: number) => [
  [
    [west, 0],
    [east, 0],
    [east, 1],
    [west, 1],
    [west, 0],
  ],
];

test("a Polygon yields its single ring set", () => {
  assert.deepEqual(polygonParts("Polygon", square(10, 20)), [square(10, 20)]);
});

test("a MultiPolygon yields each polygon", () => {
  const coordinates = [square(10, 20), square(30, 40)];

  assert.deepEqual(polygonParts("MultiPolygon", coordinates), coordinates);
});

test("other geometry types yield no polygons", () => {
  assert.deepEqual(polygonParts("Point", square(10, 20)), []);
  assert.deepEqual(polygonParts("LineString", square(10, 20)), []);
});
