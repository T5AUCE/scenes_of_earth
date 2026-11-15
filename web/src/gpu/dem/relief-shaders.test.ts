import assert from "node:assert/strict";
import { test } from "node:test";

import {
  demSlopeScale,
  LIGHT_TERMS,
  RELIEF_LIGHTS,
  reliefExaggeration,
  RELIEF_FRAGMENT_SHADER,
  reliefShade,
  type ReliefTaps,
} from "./relief-shaders.ts";

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

function planeAt(gradient: { x: number; y: number }) {
  return (column: number, row: number) => 5000 + gradient.x * column + gradient.y * row;
}

function tapsOf(height: (column: number, row: number) => number, column: number, row: number) {
  const at = (dx: number, dy: number) => height(column + dx, row + dy);

  return {
    a: at(-1, -1),
    b: at(0, -1),
    c: at(1, -1),
    d: at(-1, 0),
    f: at(1, 0),
    g: at(-1, 1),
    h: at(0, 1),
    i: at(1, 1),
  };
}

const SECANT_AT_40_DEG = 1 / Math.cos((40 * Math.PI) / 180);

test("flat ground shades to nothing", () => {
  const flat = { a: 5, b: 5, c: 5, d: 5, f: 5, g: 5, h: 5, i: 5 };

  const shade = reliefShade(flat, {
    slopeScale: 1e-4,
    exaggeration: 1,
    latitudeSecant: SECANT_AT_40_DEG,
  });

  assert.ok(Math.abs(shade.alpha) < 1e-9);
  assert.ok(Math.abs(shade.white) < 1e-9);
});

test("no exaggeration shades everything as flat", () => {
  const taps = tapsOf(planeAt({ x: 90, y: -40 }), 4, 4);

  const shade = reliefShade(taps, {
    slopeScale: 1e-4,
    exaggeration: 0,
    latitudeSecant: SECANT_AT_40_DEG,
  });

  assert.ok(Math.abs(shade.alpha) < 1e-9);
});

test("a slope facing away from the light shades darker than one facing it", () => {
  const input = { slopeScale: 1e-4, exaggeration: 1, latitudeSecant: 1 };
  const ramp = (toward: number): ReliefTaps => {
    // Rises towards the north-west light (negative column and row direction) when toward is 1.
    const at = (dx: number, dy: number) => -toward * 3000 * (dx + dy);

    return {
      a: at(-1, -1),
      b: at(0, -1),
      c: at(1, -1),
      d: at(-1, 0),
      f: at(1, 0),
      g: at(-1, 1),
      h: at(0, 1),
      i: at(1, 1),
    };
  };

  const lit = reliefShade(ramp(-1), input);
  const shadowed = reliefShade(ramp(1), input);

  assert.ok(lit.white > shadowed.white);
  assert.ok(shadowed.alpha > lit.alpha - lit.white);
});

test("the slope scale grows with zoom and halves per level beyond the prepare pass", () => {
  assert.ok(demSlopeScale(10) > demSlopeScale(9));
  assert.ok(Math.abs(demSlopeScale(16) / demSlopeScale(15) - 2) < 1e-9);
});

test("the shader carries the constants of every light and no unresolved text", () => {
  assert.ok(RELIEF_FRAGMENT_SHADER.startsWith("#version 300 es\n"));
  assert.ok(!RELIEF_FRAGMENT_SHADER.includes("undefined"));
  assert.ok(!RELIEF_FRAGMENT_SHADER.includes("NaN"));
  assert.ok(!RELIEF_FRAGMENT_SHADER.includes("${"));
  assert.equal(LIGHT_TERMS.length, RELIEF_LIGHTS.length);

  for (const light of LIGHT_TERMS) {
    for (const value of [light.sinAltitude, light.slopeXTerm, light.slopeYTerm]) {
      assert.ok(RELIEF_FRAGMENT_SHADER.includes(value.toPrecision(9)), `missing ${value}`);
    }
  }

  assert.ok(RELIEF_FRAGMENT_SHADER.includes(`light < ${RELIEF_LIGHTS.length}`));
});

test("the shader takes the latitude factor from the vertex stage", () => {
  assert.ok(RELIEF_FRAGMENT_SHADER.includes("vLatitudeSecant"));
  assert.ok(!RELIEF_FRAGMENT_SHADER.includes("cos("));
});

test("the shader skips the second sampler unless its weight is positive", () => {
  assert.ok(RELIEF_FRAGMENT_SHADER.includes("if (uWeights.y > 0.0)"));
});
