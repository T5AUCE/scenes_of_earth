import assert from "node:assert/strict";
import { test } from "node:test";

import { RELIEF_LIGHTS, reliefExaggeration } from "./relief.ts";

const STRENGTHS = [0, 0.5, 1, 1.5, 2];

test("the relief keeps three lights that stay transparent on flat ground", () => {
  assert.equal(RELIEF_LIGHTS.length, 3);
  assert.deepEqual(
    RELIEF_LIGHTS.map((light) => light.azimuthDeg),
    [315, 255, 15],
  );

  for (const light of RELIEF_LIGHTS) {
    const flatBrightness = Math.sin((light.altitudeDeg * Math.PI) / 180);
    assert.ok(Math.abs(2 * flatBrightness - 1) < 1e-12);
  }
});

test("the lights keep their shadow and highlight alphas", () => {
  assert.deepEqual(
    RELIEF_LIGHTS.map((light) => light.shadowAlpha),
    [0.55, 0.22, 0.22],
  );
  assert.deepEqual(
    RELIEF_LIGHTS.map((light) => light.highlightAlpha),
    [0.35, 0.08, 0.08],
  );
});

test("exaggeration stays within 0 to 3.5 over the whole slider range", () => {
  for (const strength of STRENGTHS) {
    for (const zoom of [0, 4, 8, 12, 20]) {
      const value = reliefExaggeration(zoom, strength);
      assert.ok(value >= 0 && value <= 3.5, `strength ${strength} gave ${value}`);
    }
  }
});

test("strength 0 gives zero exaggeration at every zoom", () => {
  assert.deepEqual([reliefExaggeration(4, 0), reliefExaggeration(12, 0)], [0, 0]);
});

test("a higher strength never lowers the exaggeration", () => {
  for (const [weaker, stronger] of [
    [0.5, 1],
    [1, 2],
  ]) {
    for (const zoom of [0, 4, 8, 12, 20]) {
      assert.ok(reliefExaggeration(zoom, weaker) <= reliefExaggeration(zoom, stronger));
    }
  }
});

test("exaggeration ramps linearly between the low and high detail zooms", () => {
  assert.equal(reliefExaggeration(4, 2), 0.8);
  assert.equal(reliefExaggeration(12, 2), 1.4);
  assert.equal(reliefExaggeration(0, 2), 0.8);
  assert.equal(reliefExaggeration(20, 2), 1.4);
  assert.ok(Math.abs(reliefExaggeration(8, 2) - (0.8 + 1.4) / 2) < 1e-12);
  assert.equal(reliefExaggeration(12, 5), 3.5);
  assert.equal(reliefExaggeration(8, 0), 0);
});
