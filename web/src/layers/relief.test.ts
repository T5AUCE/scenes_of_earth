import assert from "node:assert/strict";
import { test } from "node:test";

import { backdropMaxZoom, RELIEF_STRENGTH, reliefPaint } from "./relief.ts";

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

test("the backdrop is the fitted zoom rounded up", () => {
  // 1000 px across 10 degrees of 512 px tiles fits at zoom 6.1.
  assert.equal(backdropMaxZoom(10, 1000, 512, 11), 7);
});

test("the backdrop never exceeds the tile maxzoom or goes below zero", () => {
  assert.equal(backdropMaxZoom(0.1, 1000, 512, 11), 11);
  assert.equal(backdropMaxZoom(360, 100, 512, 11), 0);
});
