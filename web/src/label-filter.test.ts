import assert from "node:assert/strict";
import { test } from "node:test";

import { areaFilter, tileAreaGeometry } from "./label-filter.ts";

const square = (west: number, east: number) => [
  [
    [west, 0],
    [east, 0],
    [east, 1],
    [west, 1],
    [west, 0],
  ],
];

test("an area west of 180 is used as given", () => {
  const area = tileAreaGeometry({ type: "Polygon", coordinates: square(10, 20) });

  assert.equal(area.coordinates.length, 1);
  assert.equal(area.coordinates[0][0][0][0], 10);
});

test("an area past 180 also gets a copy one world west", () => {
  const area = tileAreaGeometry({
    type: "MultiPolygon",
    coordinates: [square(177, 181), square(185, 186)],
  });

  assert.equal(area.coordinates.length, 4);
  assert.deepEqual(area.coordinates[2][0][0], [-183, 0]);
  assert.deepEqual(area.coordinates[3][0][0], [-175, 0]);
});

test("the area filter keeps the layer's own filter", () => {
  const area = tileAreaGeometry({ type: "Polygon", coordinates: square(0, 1) });

  assert.deepEqual(areaFilter(["==", ["get", "class"], "city"], area, false), [
    "all",
    ["==", ["get", "class"], "city"],
    ["<=", ["distance", area], 0],
  ]);

  assert.deepEqual(areaFilter(undefined, area, false), ["<=", ["distance", area], 0]);
});

test("layers with icons need the feature fully inside the area", () => {
  const area = tileAreaGeometry({ type: "Polygon", coordinates: square(0, 1) });

  assert.deepEqual(areaFilter(undefined, area, true), ["within", area]);
});
