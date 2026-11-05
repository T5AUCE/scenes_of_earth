import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness } from "./class-field-harness.test.ts";
import { createFieldMarksLayer } from "./field-marks-layer.ts";
import { FIELD_MARKS_FRAGMENT } from "./field-marks-shaders.ts";

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

function mountMarks() {
  const harness = createHarness();
  Object.assign(harness.gl, { uniform2f: () => {}, uniform3f: () => {} });
  Object.assign(harness.map, { getZoom: () => 3, getPixelRatio: () => 1 });
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
