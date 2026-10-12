import assert from "node:assert/strict";
import { test } from "node:test";
import { clampAround, nearestEquivalent, panLimit } from "./pan-lock.ts";

const FLOAT_TOLERANCE = 1e-12;

test("at or below the fitted zoom the view cannot move", () => {
  assert.equal(panLimit(0.2, 5, 5), 0);
  assert.equal(panLimit(0.2, 5, 4.7), 0);
});

test("one zoom level in leaves a quarter of the fitted span on each side", () => {
  assert.ok(Math.abs(panLimit(0.2, 5, 6) - 0.05) < FLOAT_TOLERANCE);
});

test("a position is held within the limit around the centre", () => {
  assert.equal(clampAround(10, 4, 2), 6);
  assert.equal(clampAround(-1, 4, 2), 2);
  assert.equal(clampAround(5, 4, 2), 5);
});

test("a value is moved by whole periods to lie nearest the reference", () => {
  assert.equal(nearestEquivalent(-178.5, 181.5, 360), 181.5);
  assert.equal(nearestEquivalent(181.5, -178.5, 360), -178.5);
  assert.equal(nearestEquivalent(30, 35, 360), 30);
});
