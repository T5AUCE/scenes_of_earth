import assert from "node:assert/strict";
import { test } from "node:test";

import {
  convertRange,
  convertValue,
  displayDecimals,
  displayStops,
  displayUnitFor,
  formatArea,
  formatLength,
  isUnitFor,
  scaleUnitForElevation,
  unitOptions,
  usesImperialDistances,
} from "./units.ts";

test("rainfall, temperature and elevation offer display units", () => {
  assert.deepEqual(unitOptions("mm/month"), ["mm/month", "in/month"]);
  assert.deepEqual(unitOptions("°C"), ["°C", "°F"]);
  assert.deepEqual(unitOptions("m"), ["m", "ft"]);
  assert.equal(unitOptions(""), null);
});

test("a unit belongs only to its own native family", () => {
  assert.equal(isUnitFor("mm/month", "in/month"), true);
  assert.equal(isUnitFor("°C", "°F"), true);
  assert.equal(isUnitFor("m", "ft"), true);
  assert.equal(isUnitFor("mm/month", "°F"), false);
  assert.equal(isUnitFor("°C", "in/month"), false);
  assert.equal(isUnitFor("m", "°F"), false);
});

test("an unknown stored unit falls back to the bundle default", () => {
  assert.equal(displayUnitFor("mm/month", "in/month"), "in/month");
  assert.equal(displayUnitFor("mm/month", "°F"), "mm/month");
  assert.equal(displayUnitFor("°C", undefined), "°C");
  assert.equal(displayUnitFor("°C", null), "°C");
});

test("rainfall scales by the inch while temperature shifts by the freezing point", () => {
  assert.equal(convertValue(25.4, "mm/month", "in/month"), 1);
  assert.equal(convertValue(1, "in/month", "mm/month"), 25.4);
  assert.equal(convertValue(0, "°C", "°F"), 32);
  assert.equal(convertValue(100, "°C", "°F"), 212);
  assert.equal(convertValue(32, "°F", "°C"), 0);
  assert.equal(convertValue(-40, "°C", "°F"), -40);
});

test("converting to the same unit or an unknown pair leaves the value alone", () => {
  assert.equal(convertValue(3, "mm/month", "mm/month"), 3);
  assert.equal(convertValue(3, "m", "°C"), 3);
  assert.deepEqual(convertRange([0, 10], "mm/month", "mm/month"), [0, 10]);
});

test("elevation scales by the foot while unknown pairs stay put", () => {
  assert.equal(convertValue(0.3048, "m", "ft"), 1);
  assert.equal(convertValue(1, "ft", "m"), 0.3048);
  assert.deepEqual(convertRange([0, 100], "m", "ft"), [0, 100 / 0.3048]);
});

test("a converted range keeps its ends in order", () => {
  assert.deepEqual(convertRange([0, 25.4], "mm/month", "in/month"), [0, 1]);
  assert.deepEqual(convertRange([0, 100], "°C", "°F"), [32, 212]);
});

test("inches need two more decimals than millimetres while Fahrenheit keeps one", () => {
  assert.equal(displayDecimals(1, "mm/month", "mm/month"), 1);
  assert.equal(displayDecimals(1, "mm/month", "in/month"), 3);
  assert.equal(displayDecimals(1, "°C", "°F"), 1);
  assert.equal(displayDecimals(0, "°C", "°F"), 0);
});

test("display decimals never exceed three", () => {
  assert.equal(displayDecimals(5, "mm/month", "in/month"), 3);
  assert.equal(displayDecimals(5, "°C", "°F"), 3);
  assert.equal(displayDecimals(4, "m", "ft"), 3);
});

test("display stops are converted and rounded so labels stay short", () => {
  assert.deepEqual(displayStops([0, 10, 30], "mm/month", "mm/month", 1), [0, 10, 30]);
  assert.deepEqual(displayStops([0, 25.4], "mm/month", "in/month", 1), [0, 1]);
  assert.deepEqual(displayStops([30], "mm/month", "in/month", 1), [1.181]);
  assert.deepEqual(displayStops([0, 2.6], "mm/month", "in/month", 1), [0, 0.102]);
  assert.deepEqual(displayStops([0, 100], "°C", "°F", 0), [32, 212]);
});

test("converted legend labels use the layer's display precision", () => {
  assert.deepEqual(displayStops([10.123], "°C", "°C", 1), [10.123]);
  assert.deepEqual(displayStops([10.1], "°C", "°F", 1), [50.2]);
  assert.deepEqual(displayStops([10.15, 10.25], "°C", "°F", 2), [50.27, 50.45]);
});

test("scene lengths and areas follow the elevation choice", () => {
  assert.equal(usesImperialDistances("m"), false);
  assert.equal(usesImperialDistances("ft"), true);
  assert.equal(scaleUnitForElevation("m"), "metric");
  assert.equal(scaleUnitForElevation("ft"), "imperial");
  assert.equal(formatLength(150, "m"), "150 m");
  assert.equal(formatLength(5600, "m"), "5.6 km");
  assert.equal(formatLength(150, "ft"), "490 ft");
  assert.equal(formatLength(5600, "ft"), "3.5 mi");
  assert.equal(formatArea(1234.5, "m"), "1,235 km²");
  assert.equal(formatArea(1234.5, "ft"), "477 mi²");
});
