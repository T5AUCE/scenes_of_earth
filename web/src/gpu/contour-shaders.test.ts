import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contourLadder,
  FADE_SPAN_ZOOM,
  INTERVAL_CHAIN_FT,
  INTERVAL_CHAIN_M,
} from "../contour-ladder.ts";
import type { TerrainStats } from "../types.ts";
import {
  BOLD_LINE_WIDTH_PX,
  CONTOUR_FRAGMENT_SHADER,
  CONTOUR_OPACITY,
  contourCoverage,
  fillTierAlphas,
  MAX_TIERS,
  MINOR_LINE_WIDTH_PX,
  smoothSurfaceOf,
  tierUniformsOf,
  TIE_BIAS_M,
  type ContourTier,
} from "./contour-shaders.ts";

const STATS: TerrainStats = {
  min: 1,
  max: 820,
  mean: 100,
  p2: 6,
  p98: 700,
  slope_p50_deg: 5,
  slope_p90_deg: 10,
  cell_m: 500,
};
const METRES_PER_FOOT = 0.3048;
const STEEP_M_PER_PX = 1;
const CLOSE = 1e-6;
// Where the 100 m line sits, which is just above its height.
const LINE_HEIGHT_M = 100 + TIE_BIAS_M;

test("the metres ladder fills the arrays coarsest first with bold and minor widths", () => {
  const ladder = contourLadder(STATS);

  const uniforms = tierUniformsOf(ladder, "m");

  assert.deepEqual([...uniforms.intervalsM], [2000, 1000, 500, 100, 50, 10]);
  assert.deepEqual([...uniforms.widthsPx], [
    ...Array<number>(4).fill(BOLD_LINE_WIDTH_PX),
    ...Array<number>(2).fill(MINOR_LINE_WIDTH_PX),
  ].map(Math.fround));
  assert.deepEqual(uniforms.entryZooms, [5, 6, 7, 9, 10, 12]);
  assert.equal(uniforms.intervalsM.length, MAX_TIERS);
  assert.equal(MAX_TIERS, INTERVAL_CHAIN_M.length);
});

test("the feet ladder gives its steps in metres and keeps unused slots harmless", () => {
  const ladder = contourLadder(STATS, { elevationUnit: "ft" });

  const uniforms = tierUniformsOf(ladder, "ft");

  assert.equal(ladder.tiers.length, INTERVAL_CHAIN_FT.length - 1);
  assert.ok(Math.abs(uniforms.intervalsM[0] - 5000 * METRES_PER_FOOT) < 1e-3);
  assert.equal(uniforms.intervalsM[MAX_TIERS - 1], 1);
  assert.equal(uniforms.widthsPx[MAX_TIERS - 1], 0);
});

test("a tier fades in over the fade span from its entry zoom to the full opacity", () => {
  const alphas = new Float32Array(MAX_TIERS);
  const entryZooms = [5, 9];

  assert.equal(fillTierAlphas(alphas, entryZooms, 4.9), false);
  assert.equal(fillTierAlphas(alphas, entryZooms, 5 + FADE_SPAN_ZOOM / 2), true);
  assertClose(alphas[0], CONTOUR_OPACITY / 2, "halfway");
  assert.equal(alphas[1], 0);
  fillTierAlphas(alphas, entryZooms, 9 + FADE_SPAN_ZOOM);
  assertClose(alphas[0], CONTOUR_OPACITY, "first tier stays full");
  assertClose(alphas[1], CONTOUR_OPACITY, "second tier is full");
  assert.equal(alphas[2], 0);
});

test("a line on a contour height covers the pixel and one a pixel away does not", () => {
  const onLine = contourCoverage(LINE_HEIGHT_M, STEEP_M_PER_PX, [tier(100)], 1);
  const clear = contourCoverage(LINE_HEIGHT_M + 2 * STEEP_M_PER_PX, STEEP_M_PER_PX, [tier(100)], 1);

  assertClose(onLine, CONTOUR_OPACITY * (MINOR_LINE_WIDTH_PX / 2 + 0.5), "centre");
  assert.equal(clear, 0);
});

test("the line keeps its width in pixels at any slope", () => {
  const offsetPx = 0.3;
  const at = (metresPerPixel: number) => contourCoverage(
    LINE_HEIGHT_M + offsetPx * metresPerPixel,
    metresPerPixel,
    [tier(100)],
    1,
  );

  assertClose(at(0.5), at(2), "gentle against steep");
  assertClose(at(2), at(10), "steep against cliff");
});

test("bold lines are wider than minor ones at the same distance", () => {
  const height = LINE_HEIGHT_M + 0.6 * STEEP_M_PER_PX;

  const minor = contourCoverage(height, STEEP_M_PER_PX, [tier(100)], 1);
  const bold = contourCoverage(
    height,
    STEEP_M_PER_PX,
    [tier(100, { widthPx: BOLD_LINE_WIDTH_PX })],
    1,
  );

  assert.ok(bold > minor);
});

test("the pixel ratio scales the width in device pixels", () => {
  const height = LINE_HEIGHT_M + 0.9 * STEEP_M_PER_PX;

  const normal = contourCoverage(height, STEEP_M_PER_PX, [tier(100)], 1);
  const dense = contourCoverage(height, STEEP_M_PER_PX, [tier(100)], 2);

  assert.ok(dense > normal);
});

test("flat ground at a contour height draws nothing", () => {
  assert.equal(contourCoverage(0, 0, [tier(100)], 1), 0);
  assert.equal(contourCoverage(0, 0.0005, [tier(100)], 1), 0);
  assert.ok(contourCoverage(TIE_BIAS_M, 0.0025, [tier(100)], 1) > 0);
  assertClose(
    contourCoverage(TIE_BIAS_M, 0.01, [tier(100)], 1),
    CONTOUR_OPACITY * (MINOR_LINE_WIDTH_PX / 2 + 0.5),
    "gentle slope",
  );
});

test("lines fade out as their spacing falls below about five pixels", () => {
  const coverageFor = (spacingPx: number) => contourCoverage(
    LINE_HEIGHT_M,
    100 / spacingPx,
    [tier(100)],
    1,
  );

  assertClose(coverageFor(6), CONTOUR_OPACITY * 0.75, "six pixels apart");
  assert.ok(coverageFor(3) > 0 && coverageFor(3) < coverageFor(6));
  assert.ok(coverageFor(2.5) < coverageFor(3));
  assert.equal(coverageFor(1.5), 0);
  assert.equal(coverageFor(1), 0);
});

test("the crowding fade measures spacing in CSS pixels", () => {
  const metresPerPixel = 100 / 4;

  const normal = contourCoverage(LINE_HEIGHT_M, metresPerPixel, [tier(100)], 1);
  const dense = contourCoverage(LINE_HEIGHT_M, metresPerPixel, [tier(100)], 2);

  assert.ok(dense < normal);
});

test("the strongest tier at a pixel wins instead of adding up", () => {
  const tiers = [
    tier(500, { alpha: CONTOUR_OPACITY, widthPx: BOLD_LINE_WIDTH_PX }),
    tier(100, { alpha: CONTOUR_OPACITY / 2 }),
  ];

  const coverage = contourCoverage(500 + TIE_BIAS_M, STEEP_M_PER_PX, tiers, 1);

  // The bold line is wider than a pixel, so its centre covers the pixel fully.
  assertClose(coverage, CONTOUR_OPACITY, "bold tier");
});

test("a tier that has not entered draws nothing", () => {
  assert.equal(contourCoverage(LINE_HEIGHT_M, STEEP_M_PER_PX, [tier(100, { alpha: 0 })], 1), 0);
});

test("the shader loops over the ladder arrays with the gradient length and no fwidth", () => {
  assert.ok(CONTOUR_FRAGMENT_SHADER.startsWith("#version 300 es\n"));
  assert.ok(!CONTOUR_FRAGMENT_SHADER.includes("undefined"));
  assert.ok(!CONTOUR_FRAGMENT_SHADER.includes("NaN"));
  assert.ok(!CONTOUR_FRAGMENT_SHADER.includes("${"));
  assert.ok(!CONTOUR_FRAGMENT_SHADER.includes("fwidth("));
  assert.ok(CONTOUR_FRAGMENT_SHADER.includes("length(vec2(dot(slope, texelsPerPixelX)"));
  assert.ok(!CONTOUR_FRAGMENT_SHADER.includes("dFdx(height)"));
  assert.ok(CONTOUR_FRAGMENT_SHADER.includes(`uIntervals[${MAX_TIERS}]`));
  assert.ok(CONTOUR_FRAGMENT_SHADER.includes(`tier < ${MAX_TIERS}`));
});

test("the shader carries the guard and fade constants of the reference", () => {
  for (const constant of ["0.001", "0.004", "0.2", "0.65"]) {
    assert.ok(CONTOUR_FRAGMENT_SHADER.includes(constant), `missing ${constant}`);
  }
});

test("the shader carries the tie bias and scales the flat guard by the pixel ratio", () => {
  assert.ok(CONTOUR_FRAGMENT_SHADER.includes("- 0.001;"));
  assert.ok(CONTOUR_FRAGMENT_SHADER.includes("metresPerPixel * uPixelRatio\n  );"));
});

test("a whole-metre plateau at a contour height draws no line inside it", () => {
  const plateau = Array.from({ length: 4 }, () => Array<number>(4).fill(100));

  const surface = smoothSurfaceOf(plateau, 0.3, 0.7);

  assert.equal(surface.height, 100);
  assert.equal(surface.slopeX, 0);
  assert.equal(contourCoverage(surface.height, 0, [tier(100)], 1), 0);
});

test("a terrace at the contour height is below it, whichever side the neighbour is", () => {
  const pixelsPerTexel = 8;
  const strongestAlong = (heights: number[][]) => {
    let strongest = 0;
    for (let fraction = 0; fraction <= 1; fraction += 0.001) {
      const surface = smoothSurfaceOf(heights, fraction, 0.5);
      const slope = Math.abs(surface.slopeX) / pixelsPerTexel;
      strongest = Math.max(strongest, contourCoverage(surface.height, slope, [tier(100)], 1));
    }
    return strongest;
  };

  const lowerNeighbour = Array.from({ length: 4 }, () => [99, 100, 100, 100]);
  const higherNeighbour = Array.from({ length: 4 }, () => [101, 100, 100, 100]);

  assert.equal(strongestAlong(lowerNeighbour), 0);
  assert.ok(strongestAlong(higherNeighbour) > 0);
});

test("the B-spline slope matches a finite difference and is zero at a saddle centre", () => {
  const saddle = [[0, 4, 0, 4], [4, 0, 4, 0], [0, 4, 0, 4], [4, 0, 4, 0]];
  const bumpy = [[0, 1, 3, 2], [2, 5, 4, 1], [1, 7, 6, 3], [0, 2, 2, 1]];
  const step = 1e-5;

  const centre = smoothSurfaceOf(saddle, 0.5, 0.5);
  const sampled = smoothSurfaceOf(bumpy, 0.3, 0.6);
  const ahead = smoothSurfaceOf(bumpy, 0.3 + step, 0.6);
  const behind = smoothSurfaceOf(bumpy, 0.3 - step, 0.6);
  const aside = smoothSurfaceOf(bumpy, 0.3, 0.6 + step);
  const below = smoothSurfaceOf(bumpy, 0.3, 0.6 - step);

  assertClose(centre.slopeX, 0);
  assertClose(centre.slopeY, 0);
  assertClose(sampled.slopeX, (ahead.height - behind.height) / (2 * step));
  assertClose(sampled.slopeY, (aside.height - below.height) / (2 * step));
});

test("a saddle's slope grows off its centre so the lines of its branches stay drawn", () => {
  const saddle = [[0, 4, 0, 4], [4, 0, 4, 0], [0, 4, 0, 4], [4, 0, 4, 0]];

  const centre = smoothSurfaceOf(saddle, 0.5, 0.5);
  const off = smoothSurfaceOf(saddle, 0.8, 0.5);

  assert.ok(Math.hypot(off.slopeX, off.slopeY) > Math.hypot(centre.slopeX, centre.slopeY));
});

test("sea at 0 m stays unfilled with a tier at 0 m", () => {
  assert.equal(contourCoverage(0, 0, [tier(100), tier(10)], 1), 0);
  assert.equal(contourCoverage(0, 0, [tier(100), tier(10)], 2), 0);
});

test("the flat guard passes the same slope per CSS pixel at pixel ratio 1 and 2", () => {
  const metresPerCssPixel = 0.003;
  const lineOf = (pixelRatio: number) => MINOR_LINE_WIDTH_PX * pixelRatio / 2 + 0.5;

  const normal = contourCoverage(TIE_BIAS_M, metresPerCssPixel, [tier(100)], 1);
  const dense = contourCoverage(TIE_BIAS_M, metresPerCssPixel / 2, [tier(100)], 2);

  assert.ok(normal > 0);
  assertClose(normal / lineOf(1), dense / lineOf(2));
});

test("the shader skips the second sampler unless its weight is positive", () => {
  assert.ok(CONTOUR_FRAGMENT_SHADER.includes("if (uWeights.y > 0.0)"));
});

function tier(intervalM: number, options: Partial<ContourTier> = {}): ContourTier {
  return { intervalM, alpha: CONTOUR_OPACITY, widthPx: MINOR_LINE_WIDTH_PX, ...options };
}

function assertClose(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < CLOSE, `${message ?? ""} ${actual} vs ${expected}`);
}
