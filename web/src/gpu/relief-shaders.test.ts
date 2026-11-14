import assert from "node:assert/strict";
import { test } from "node:test";

import { reliefExaggeration, RELIEF_LIGHTS, RELIEF_STRENGTH } from "../layers/relief.ts";
import { shadeTile } from "../workers/shade-tile.ts";
import {
  demSlopeScale,
  LIGHT_TERMS,
  RELIEF_FRAGMENT_SHADER,
  reliefShade,
  type ReliefTaps,
} from "./relief-shaders.ts";

const TILE = { z: 10, x: 612, y: 513 };
const SIZE_PX = 16;
const BYTE = 255;
// The raster path rounds each slope to a byte; planes on the byte grid take that rounding out.
const MAX_BYTES = 1;
const STORED_SLOPE_STEP = 8 / 255;

/** The metres a plane rises per pixel for a stored slope that is a whole number of byte steps. */
function gradientFor(levels: number, tileZoom: number): number {
  return levels * STORED_SLOPE_STEP / (8 * demSlopeScale(tileZoom, SIZE_PX));
}

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

const SECANT_AT_40_DEG = 1 / Math.cos(40 * Math.PI / 180);

function secantOf(fraction: number): number {
  return Math.cosh(Math.PI * (1 - 2 * fraction));
}

// The vertex stage interpolates the secant, where the raster path takes it from the exact latitude.
function rowSecant(tile: typeof TILE, row: number): number {
  const count = 2 ** tile.z;
  const north = secantOf(tile.y / count);
  const south = secantOf((tile.y + 1) / count);
  return (north - south) * (1 - (row + 0.5) / SIZE_PX) + south;
}

/** Shade a plane with the raster path and the reference, and compare every sampled pixel. */
async function assertMatchesRasterPath(
  tile: typeof TILE,
  strength: number,
  levels: { x: number; y: number },
) {
  const height = planeAt({
    x: gradientFor(levels.x, tile.z),
    y: gradientFor(levels.y, tile.z),
  });
  const loadHeights = async (neighbour: typeof TILE) => {
    const heights = new Float32Array(SIZE_PX * SIZE_PX);
    for (let index = 0; index < heights.length; index++) {
      heights[index] = height(
        (neighbour.x - tile.x) * SIZE_PX + (index % SIZE_PX),
        (neighbour.y - tile.y) * SIZE_PX + Math.floor(index / SIZE_PX),
      );
    }
    return heights;
  };
  const pixels = await shadeTile(tile, strength, loadHeights);
  const exaggeration = reliefExaggeration(tile.z, strength);
  const slopeScale = demSlopeScale(tile.z, SIZE_PX);
  for (let row = 0; row < SIZE_PX; row += 5) {
    for (let column = 0; column < SIZE_PX; column += 5) {
      const shade = reliefShade(
        tapsOf(height, column, row),
        { slopeScale, exaggeration, latitudeSecant: rowSecant(tile, row) },
      );
      const offset = (row * SIZE_PX + column) * 4;
      const alphaByte = pixels[offset + 3];
      const whiteByte = pixels[offset] * alphaByte / BYTE;
      const where = `${column},${row} at levels ${levels.x},${levels.y}`;
      assert.ok(Math.abs(shade.alpha * BYTE - alphaByte) <= MAX_BYTES, `alpha ${where}`);
      assert.ok(Math.abs(shade.white * BYTE - whiteByte) <= MAX_BYTES, `white ${where}`);
    }
  }
}

const SLOPE_LEVELS = [
  { x: 0, y: 0 },
  { x: 12, y: 0 },
  { x: 0, y: -9 },
  { x: -20, y: 7 },
  { x: 40, y: 33 },
  { x: -15, y: -60 },
];

test("the scalar shade matches the raster path at the default strength", async () => {
  for (const levels of SLOPE_LEVELS) {
    await assertMatchesRasterPath(TILE, RELIEF_STRENGTH.initial, levels);
  }
});

test("the scalar shade matches the raster path at a high strength and zoom", async () => {
  for (const levels of SLOPE_LEVELS) {
    await assertMatchesRasterPath({ z: 12, x: 2448, y: 2052 }, 4, levels);
  }
});

test("the scalar shade matches the raster path at a weak strength and high latitude", async () => {
  for (const levels of SLOPE_LEVELS) {
    await assertMatchesRasterPath({ z: 7, x: 70, y: 20 }, 0.5, levels);
  }
});

test("the scalar shade matches the raster path with colour-under easing", async () => {
  for (const levels of SLOPE_LEVELS) {
    await assertMatchesRasterPath(TILE, RELIEF_STRENGTH.initial * 0.75, levels);
  }
});

test("the scalar shade matches the raster path on slopes beyond the stored range", async () => {
  await assertMatchesRasterPath(TILE, RELIEF_STRENGTH.initial, { x: 400, y: -300 });
  await assertMatchesRasterPath(TILE, RELIEF_STRENGTH.initial, { x: -500, y: 250 });
});

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
