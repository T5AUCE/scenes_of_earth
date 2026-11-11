import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness } from "./class-field-harness.test.ts";
import { createFieldMarksLayer } from "./field-marks-layer.ts";
import { FIELD_MARKS_FRAGMENT } from "./field-marks-shaders.ts";
import {
  CLOSE_RADIUS_CAP_PX,
  aimedSpacingPx,
  cellSidesPx,
  highZoomDotOpacity,
  highZoomDotSizeScale,
  levelFor,
  limitCloseRadiusPx,
  maxDotRadiusPx,
} from "../render/lattice.ts";

const INK = { ink: [0, 0, 0], halo: [255, 255, 255] };
const STEPS = {
  leaving: Uint8Array.from({ length: 12 }, (_, cell) => cell * 10),
  entering: Uint8Array.from({ length: 12 }, (_, cell) => 250 - cell * 10),
};
const TEXTURES_PER_SET = 2;
const ROWS_TEXTURES = 1;

test("a fade uploads the entering step once and drives the ease by the mix uniform", () => {
  const { marks, harness, render } = mountMarks();
  const { leaving, entering } = STEPS;
  marks.setFade(leaving, entering, 0);

  render();
  const uploads = harness.uploads.length;
  assert.equal(uploads, ROWS_TEXTURES + 2 * TEXTURES_PER_SET);
  assert.ok(harness.draws.length > 0);
  assert.equal(harness.uniforms.get("uHasFrom"), 1);
  assert.equal(harness.uniforms.get("uHasTo"), 1);

  for (const mix of [0, 0.5, 1]) {
    marks.setFade(leaving, entering, mix);
    render();
    assert.equal(harness.uniforms.get("uStepMix"), mix);
  }

  assert.equal(harness.uploads.length, uploads);
});

test("dot area eases between the radii as the shader text defines it", () => {
  const areaMix = areaMixFromShader();

  assert.equal(areaMix(2, 6, 0), 2);
  assert.equal(areaMix(2, 6, 1), 6);
  assert.equal(areaMix(2, 6, 0.5), Math.sqrt((4 + 36) / 2));
  assert.equal(areaMix(4, 0, 0.5), Math.sqrt(8));
});

test("a step shown alone uploads no second texture set", () => {
  const { marks, harness, render } = mountMarks();

  marks.setFade(STEPS.leaving, null, 0);
  render();

  assert.equal(harness.uploads.length, ROWS_TEXTURES + TEXTURES_PER_SET);
  assert.equal(harness.uniforms.get("uHasFrom"), 1);
  assert.equal(harness.uniforms.get("uHasTo"), 0);
});

test("a fade from or to a step outside the axis uploads one set and flags the missing end", () => {
  const { marks, harness, render } = mountMarks();

  marks.setFade(null, STEPS.entering, 0.5);
  render();
  assert.equal(harness.uniforms.get("uHasFrom"), 0);
  assert.equal(harness.uniforms.get("uHasTo"), 1);
  assert.equal(harness.uploads.length, ROWS_TEXTURES + TEXTURES_PER_SET);

  marks.setFade(STEPS.leaving, null, 0.5);
  render();
  assert.equal(harness.uniforms.get("uHasFrom"), 1);
  assert.equal(harness.uniforms.get("uHasTo"), 0);
});

test("equal steps draw as one step with no second set", () => {
  const { marks, harness, render } = mountMarks();

  marks.setFade(STEPS.leaving, STEPS.leaving, 0.5);
  render();

  assert.equal(harness.uploads.length, ROWS_TEXTURES + TEXTURES_PER_SET);
  assert.equal(harness.uniforms.get("uHasTo"), 0);
});

test("a step counts as ready once a draw has uploaded it", () => {
  const { marks, render } = mountMarks();
  const { leaving, entering } = STEPS;
  marks.setFade(leaving, entering, 0);
  assert.equal(marks.isReady(entering), false);

  render();

  assert.equal(marks.isReady(entering), true);
  assert.equal(marks.isReady(leaving), true);
  assert.equal(marks.isReady(Uint8Array.of(1)), false);
});

test("a step boundary uploads the entering step once and the next step once", () => {
  const { marks, harness, render } = mountMarks();
  const next = Uint8Array.from({ length: 12 }, (_, cell) => cell);
  marks.setFade(STEPS.leaving, STEPS.entering, 1);
  render();
  const uploads = harness.uploads.length;

  marks.setFade(STEPS.entering, null, 0);
  render();
  marks.setFade(STEPS.entering, next, 0);
  render();

  assert.equal(harness.uploads.length - uploads, TEXTURES_PER_SET);
  assert.equal(marks.isReady(next), true);
});

test("a context loss keeps both steps and uploads them again", () => {
  const { marks, harness, render } = mountMarks();
  marks.setFade(STEPS.leaving, STEPS.entering, 0.5);
  render();
  const uploads = harness.uploads.length;

  harness.listeners.get("webglcontextlost")!({ preventDefault: () => {} });
  harness.listeners.get("webglcontextrestored")!({});
  render();

  assert.equal(harness.uploads.length, 2 * uploads);
  assert.equal(harness.uniforms.get("uHasTo"), 1);
  assert.equal(harness.uniforms.get("uStepMix"), 0.5);
  assert.equal(marks.isReady(STEPS.entering), true);
});

test("removing the layer frees both texture sets", () => {
  const { marks, harness, render } = mountMarks();
  marks.setFade(STEPS.leaving, STEPS.entering, 0);
  render();

  marks.layer.onRemove!(harness.map, harness.gl);

  assert.equal(harness.deleted.textures.length, ROWS_TEXTURES + 2 * TEXTURES_PER_SET);
});

test("a step that becomes the first one after a fade draws without a second set", () => {
  const { marks, harness, render } = mountMarks();
  const { leaving, entering } = STEPS;
  marks.setFade(leaving, entering, 1);
  render();

  marks.setFade(entering, null, 0);
  render();

  assert.equal(harness.uniforms.get("uHasTo"), 0);
  assert.equal(marks.isReady(entering), true);
  assert.equal(marks.isReady(leaving), false);
  assert.equal(harness.failures.length, 0);
});

test("a camera gesture hides the hatch without re-uploading and restores it", () => {
  withSearch("?fastHatch=1", () => {
    const { marks, harness, render } = mountMarks();
    marks.setHatch(true);
    marks.setFade(STEPS.leaving, null, 0);
    render();
    const uploads = harness.uploads.length;
    assert.equal(harness.uniforms.get("uHatch"), 1);

    harness.emitMapEvent("movestart");
    render();

    assert.equal(harness.uniforms.get("uHatch"), 0);
    assert.equal(harness.uploads.length, uploads);

    harness.emitMapEvent("moveend");
    render();

    assert.equal(harness.uniforms.get("uHatch"), 1);
    assert.equal(harness.uploads.length, uploads);
  });
});

test("without the opt-in a camera gesture leaves the hatch alone", () => {
  withSearch("", () => {
    const { marks, harness, render } = mountMarks();
    marks.setHatch(true);
    marks.setFade(STEPS.leaving, null, 0);
    render();
    assert.equal(harness.uniforms.get("uHatch"), 1);

    harness.emitMapEvent("movestart");
    render();

    assert.equal(harness.uniforms.get("uHatch"), 1);

    harness.emitMapEvent("moveend");
    render();

    assert.equal(harness.uniforms.get("uHatch"), 1);
  });
});

function withSearch(search: string, run: () => void): void {
  const previous = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = { search };
  try {
    run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "location");
    else (globalThis as Record<string, unknown>).location = previous;
  }
}

test("a density change eases toward its target on the controlled clock", () => {
  const pinned = { now: 1000 };
  const originalNow = performance.now.bind(performance);
  performance.now = () => pinned.now;
  try {
    const { marks, render } = mountMarks();
    marks.setFade(STEPS.leaving, null, 0);
    render();
    assert.equal(marks.renderedDensity(), 1);

    marks.setDensity(Math.SQRT2);
    pinned.now += 45;
    render();
    const early = marks.renderedDensity();
    assert.ok(early > 1 && early < Math.SQRT2);

    marks.setDensity(Math.SQRT2);
    pinned.now += 45;
    render();
    const middle = marks.renderedDensity();
    assert.ok(middle > early && middle <= Math.SQRT2);

    pinned.now += 180;
    render();
    const settled = marks.renderedDensity();
    assert.ok(settled >= middle && settled <= Math.SQRT2);

    pinned.now += 60;
    render();
    assert.equal(marks.renderedDensity(), settled);
  } finally {
    performance.now = originalNow;
  }
});

test("a density reversal retargets from the displayed value and hiding snaps", () => {
  const pinned = { now: 2000 };
  const originalNow = performance.now.bind(performance);
  performance.now = () => pinned.now;
  try {
    const { marks, render } = mountMarks();
    marks.setFade(STEPS.leaving, null, 0);
    render();

    marks.setDensity(Math.SQRT2);
    pinned.now += 45;
    render();
    const mid = marks.renderedDensity();

    marks.setDensity(0.5);
    pinned.now += 45;
    render();
    const retargeted = marks.renderedDensity();
    assert.ok(retargeted < mid && retargeted > 0.5);

    marks.setDots(false);
    assert.equal(marks.renderedDensity(), 0.5);

    marks.setDots(true);
    assert.equal(marks.renderedDensity(), 0.5);
  } finally {
    performance.now = originalNow;
  }
});

test("close zoom caps the uploaded radii while the size scale rests at one", () => {
  const { marks, harness, render } = mountMarks(16, 1);
  marks.setFade(STEPS.leaving, null, 0);
  render();

  assert.equal(harness.uniforms.get("uDots"), 1);
  assert.equal(harness.uniforms.get("uSizeScale"), 1);
  assert.ok(Math.abs(harness.uniforms.get("uRadiusPx") - expectedRadiusUniform(16, 1)) < 1e-9);
  assert.ok(
    Math.abs(harness.uniforms.get("uParentRadiusPx") - expectedRadiusUniform(16, 1)) < 1e-9,
  );
  assert.ok(harness.uniforms.get("uRadiusPx") <= CLOSE_RADIUS_CAP_PX + 1e-9);
});

test("ordinary zoom uploads the uncapped radius with the size scale at one", () => {
  const { marks, harness, render } = mountMarks(13, 1);
  marks.setFade(STEPS.leaving, null, 0);
  render();

  assert.equal(harness.uniforms.get("uSizeScale"), 1);
  assert.ok(Math.abs(harness.uniforms.get("uRadiusPx") - expectedRadiusUniform(13, 1)) < 1e-9);
  assert.ok(harness.uniforms.get("uRadiusPx") < CLOSE_RADIUS_CAP_PX);
});

test("the fade midpoint keeps the capped radius and shrinks the size scale", () => {
  const { marks, harness, render } = mountMarks(17.75, 1);
  marks.setFade(STEPS.leaving, null, 0);
  render();

  assert.ok(
    Math.abs(harness.uniforms.get("uDotOpacity") - highZoomDotOpacity(17.75, 1)) < 1e-9,
  );
  assert.ok(
    Math.abs(harness.uniforms.get("uSizeScale") - highZoomDotSizeScale(17.75, 1)) < 1e-9,
  );
  assert.ok(Math.abs(harness.uniforms.get("uSizeScale") - 0.594604) < 1e-5);
  assert.ok(Math.abs(harness.uniforms.get("uRadiusPx") - expectedRadiusUniform(17.75, 1)) < 1e-9);
  assert.ok(harness.uniforms.get("uRadiusPx") <= CLOSE_RADIUS_CAP_PX + 1e-9);
});

test("a doubled pixel ratio moves the fade and its size scale one zoom earlier", () => {
  const { marks, harness, render } = mountMarks(16.75, 2);
  marks.setFade(STEPS.leaving, null, 0);
  render();

  assert.ok(
    Math.abs(harness.uniforms.get("uDotOpacity") - highZoomDotOpacity(16.75, 2)) < 1e-9,
  );
  assert.ok(
    Math.abs(harness.uniforms.get("uSizeScale") - highZoomDotSizeScale(16.75, 2)) < 1e-9,
  );
  assert.ok(Math.abs(harness.uniforms.get("uSizeScale") - 0.594604) < 1e-5);
});

test("both dot paths shrink radius and halo through the size scale", () => {
  assert.ok(FIELD_MARKS_FRAGMENT.includes("uniform float uSizeScale;"));
  assert.ok(FIELD_MARKS_FRAGMENT.includes("float scaledPx = radiusPx * uSizeScale;"));
  assert.ok(FIELD_MARKS_FRAGMENT.includes("pow(scaledPx / minRadiusPx, 2.0)"));
  assert.ok(FIELD_MARKS_FRAGMENT.includes("float drawnPx = max(scaledPx, minRadiusPx);"));
  assert.ok(
    FIELD_MARKS_FRAGMENT.includes("coverage(distancePx, drawnPx + HALO_WIDTH_PX * uSizeScale)"),
  );
  assert.ok(
    FIELD_MARKS_FRAGMENT.includes("mark = markAt(distancePx, radiusPx, uFading ? uFade : 1.0);"),
  );
  assert.ok(
    FIELD_MARKS_FRAGMENT.includes(
      "mark = overlay(mark, markAt(distancePx, areaMix(fromPx, toPx, uStepMix), 1.0));",
    ),
  );
});

test("dot and halo compose once before the fade scales them together", () => {
  assert.ok(
    FIELD_MARKS_FRAGMENT.includes(
      "float dotsAlpha = mark.dotAlpha + mark.haloAlpha * (1.0 - mark.dotAlpha);",
    ),
  );
  assert.ok(
    FIELD_MARKS_FRAGMENT.includes(
      "vec3 dotsColor = uInk * mark.dotAlpha + uHaloInk * mark.haloAlpha * (1.0 - mark.dotAlpha);",
    ),
  );
  assert.ok(FIELD_MARKS_FRAGMENT.includes("float alpha = dotsAlpha * uDotOpacity;"));
  assert.ok(FIELD_MARKS_FRAGMENT.includes("vec3 color = dotsColor * uDotOpacity;"));
  assert.ok(
    !FIELD_MARKS_FRAGMENT.includes(
      "Mark(mark.dotAlpha * uDotOpacity, mark.haloAlpha * uDotOpacity)",
    ),
  );
  // A fully covered centre with a 0.7 halo fades to 0.5 at half fade, not 0.675.
  const centre = composeDotHalo(1, 0.7, [0, 0, 0], [1, 1, 1], 0.5);
  assert.equal(centre.alpha, 0.5);
  assert.deepEqual(centre.rgb, [0, 0, 0]);
  for (const q of [1, 0.5, 0.104, 0]) {
    const withHalo = composeDotHalo(0.8, 0.35, [0.2, 0.1, 0.05], [1, 1, 1], q);
    assert.equal(withHalo.alpha, (0.8 + 0.35 * 0.2) * q);
    const withoutHalo = composeDotHalo(0.8, 0, [0.2, 0.1, 0.05], [1, 1, 1], q);
    assert.equal(withoutHalo.alpha, 0.8 * q);
    assert.deepEqual(withoutHalo.rgb, [0.2 * 0.8 * q, 0.1 * 0.8 * q, 0.05 * 0.8 * q]);
  }
});

test("hatch composites after the dot fade without sharing it", () => {
  assert.ok(FIELD_MARKS_FRAGMENT.includes("float hatchAlpha = hatchCoverage();"));
  assert.ok(
    FIELD_MARKS_FRAGMENT.includes(
      "color = uInk * hatchAlpha + color * (1.0 - hatchAlpha);",
    ),
  );
  assert.ok(
    FIELD_MARKS_FRAGMENT.includes("alpha = hatchAlpha + alpha * (1.0 - hatchAlpha);"),
  );
  const hatch = hatchCoverageBody();
  assert.ok(!hatch.includes("uSizeScale"));
  assert.ok(!hatch.includes("uDotOpacity"));
});

/** The expected device-px radius uniform from the shared lattice math at a zoom. */
function expectedRadiusUniform(zoom: number, pixelRatio: number) {
  const cellDegrees = { width: 0.25, height: 1 / 3 };
  const sidesPx = cellSidesPx(zoom, cellDegrees, -1.5);
  const cellPx = Math.sqrt(sidesPx.width * sidesPx.height);
  const density = 1;
  const aimedPx = aimedSpacingPx(zoom, density);
  const { level, fade } = levelFor(cellPx, aimedPx);
  const drawnLevel = fade > 0 ? level + 1 : level;
  const basePx = maxDotRadiusPx(cellPx / 2 ** drawnLevel, drawnLevel, aimedPx, density);

  return limitCloseRadiusPx(basePx, zoom) * pixelRatio;
}

/** Compose one dot and halo contribution, then attenuate the composed result by the fade. */
function composeDotHalo(
  dotAlpha: number,
  haloAlpha: number,
  ink: number[],
  haloInk: number[],
  q: number,
) {
  const dotsAlpha = dotAlpha + haloAlpha * (1 - dotAlpha);
  const rgb = ink.map((channel, index) =>
    channel * dotAlpha + haloInk[index] * haloAlpha * (1 - dotAlpha)
  );

  return { alpha: dotsAlpha * q, rgb: rgb.map((channel) => channel * q) };
}

/** The hatch coverage body, which must not shrink or fade with the dots. */
function hatchCoverageBody() {
  return /float hatchCoverage\(\) \{\s*([^}]*)\}/.exec(FIELD_MARKS_FRAGMENT)![1];
}

function mountMarks(zoom = 3, pixelRatio = 1) {
  const harness = createHarness();
  Object.assign(harness.gl, { uniform2f: () => {}, uniform3f: () => {} });
  Object.assign(harness.map, { getZoom: () => zoom, getPixelRatio: () => pixelRatio });
  const marks = createFieldMarksLayer({
    id: "dots",
    grid: { bbox: [36, -2, 37, -1], nx: 4, ny: 3 },
    shift: 0,
    ink: INK,
    onFail: (error) => harness.failures.push(error),
  });
  marks.setMask(new Uint8Array(12).fill(1));
  marks.layer.onAdd!(harness.map, harness.gl);

  return {
    marks,
    harness,
    render: () => marks.layer.render(harness.gl, harness.input),
  };
}

function areaMixFromShader() {
  const body = /float areaMix\(float from, float to, float amount\) \{\s*([^}]*)\}/
    .exec(FIELD_MARKS_FRAGMENT)![1];
  const mix = (first: number, second: number, amount: number) => {
    return first * (1 - amount) + second * amount;
  };
  const evaluate = new Function("sqrt", "mix", "from", "to", "amount", body) as (
    ...args: unknown[]
  ) => number;

  return (from: number, to: number, amount: number) => evaluate(Math.sqrt, mix, from, to, amount);
}
