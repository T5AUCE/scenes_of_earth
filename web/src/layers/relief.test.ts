import assert from "node:assert/strict";
import { test } from "node:test";

import { RELIEF_STRENGTH, reliefExaggeration, reliefPaint } from "./relief.ts";

const COLOR_PROPERTIES = [
  "hillshade-shadow-color",
  "hillshade-highlight-color",
  "hillshade-accent-color",
] as const;
const COLOR_PATTERN = /^rgba\((\d+),(\d+),(\d+),[\d.]+\)$/;
const STRENGTHS = [0, 0.5, 1, 1.5, 2];

test("every relief colour is neutral grey", () => {
  const paint = reliefPaint(RELIEF_STRENGTH.initial);

  for (const property of COLOR_PROPERTIES) {
    for (const color of [paint[property]].flat()) {
      const match = COLOR_PATTERN.exec(color as string);

      assert.ok(match, `${property} has an unexpected format`);
      assert.equal(match[1], match[2]);
      assert.equal(match[2], match[3]);
    }
  }
});

test("multidirectional lighting is transparent on flat ground even at zero strength", () => {
  for (const strength of STRENGTHS) {
    const paint = reliefPaint(strength);
    const altitudes = paint["hillshade-illumination-altitude"] as number[];

    assert.equal(paint["hillshade-method"], "multidirectional");
    for (const altitude of altitudes) {
      // MapLibre centres each light's shadow/highlight blend at a brightness of 0.5.
      const flatBrightness = Math.sin(altitude * Math.PI / 180);
      assert.ok(Math.abs(2 * flatBrightness - 1) < 1e-12);
    }
  }
});

test("exaggeration stays within 0 to 3.5 over the whole slider range", () => {
  for (const strength of STRENGTHS) {
    for (const value of exaggerations(strength)) {
      assert.ok(value >= 0 && value <= 3.5, `strength ${strength} gave ${value}`);
    }
  }
});

test("strength 0 gives zero exaggeration at every zoom", () => {
  assert.deepEqual(exaggerations(0), [0, 0]);
});

test("a higher strength never lowers the exaggeration", () => {
  for (const [weaker, stronger] of [[0.5, 1], [1, 2]]) {
    exaggerations(weaker).forEach((value, index) => {
      assert.ok(value <= exaggerations(stronger)[index]);
    });
  }
});

test("the paint depends only on the strength", () => {
  assert.deepEqual(reliefPaint(1.3), reliefPaint(1.3));
});

function exaggerations(strength: number) {
  const expression = reliefPaint(strength)["hillshade-exaggeration"] as unknown[];
  return expression.slice(3).filter((_, index) => index % 2 === 1) as number[];
}

test("exaggeration ramps linearly between the low and high detail zooms", () => {
  const expression = reliefPaint(RELIEF_STRENGTH.initial)["hillshade-exaggeration"] as unknown[];

  assert.equal(expression[0], "interpolate");
  assert.deepEqual(expression[1], ["linear"]);
  assert.deepEqual(expression[2], ["zoom"]);
  assert.deepEqual(
    expression.slice(3).filter((_, index) => index % 2 === 0),
    [4, 12],
  );
  assert.equal(expression.length, 7);
});

test("the paint keeps the same lights and colours as the shared light table", () => {
  const paint = reliefPaint(RELIEF_STRENGTH.initial);

  assert.deepEqual(paint["hillshade-illumination-direction"], [315, 255, 15]);
  assert.deepEqual(paint["hillshade-illumination-altitude"], [30, 30, 30]);
  assert.deepEqual(paint["hillshade-shadow-color"], [
    "rgba(0,0,0,0.55)",
    "rgba(0,0,0,0.22)",
    "rgba(0,0,0,0.22)",
  ]);
  assert.deepEqual(paint["hillshade-highlight-color"], [
    "rgba(255,255,255,0.35)",
    "rgba(255,255,255,0.08)",
    "rgba(255,255,255,0.08)",
  ]);
});

test("baked exaggeration follows the paint's zoom ramp and caps like it", () => {
  const ramp = reliefPaint(2)["hillshade-exaggeration"] as unknown[];

  assert.equal(reliefExaggeration(4, 2), ramp[4]);
  assert.equal(reliefExaggeration(12, 2), ramp[6]);
  assert.equal(reliefExaggeration(0, 2), ramp[4]);
  assert.equal(reliefExaggeration(20, 2), ramp[6]);
  assert.ok(Math.abs(reliefExaggeration(8, 2) - (0.8 + 1.4) / 2) < 1e-12);
  assert.equal(reliefExaggeration(12, 5), 3.5);
  assert.equal(reliefExaggeration(8, 0), 0);
});
