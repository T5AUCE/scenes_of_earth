import assert from "node:assert/strict";
import { test } from "node:test";

import { RELIEF_LIGHTS } from "../layers/relief.ts";
import {
  demSlopeScale,
  LIGHT_TERMS,
  RELIEF_FRAGMENT_SHADER,
  reliefShade,
  type ReliefTaps,
} from "./relief-shaders.ts";

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
