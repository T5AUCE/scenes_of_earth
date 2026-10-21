import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness } from "./class-field-harness.test.ts";
import { FILL_OUTLINE_STRENGTH } from "./class-field-shaders.ts";

test("class fields retain ids across context loss and release resources on removal", () => {
  const harness = createHarness();
  const field = harness.field;
  field.setIds(new Uint8Array(12).fill(1));
  field.setColors([[10, 20, 30]]);
  field.layer.onAdd!(harness.map, harness.gl);
  field.layer.render(harness.gl, harness.input);

  assert.equal(harness.draws.length, 3);
  assert.equal(harness.uploads.length, 3);
  assert.equal(harness.vertexArray(), null);
  let prevented = false;
  harness.listeners.get("webglcontextlost")!({
    preventDefault: () => {
      prevented = true;
    },
  });
  field.layer.render(harness.gl, harness.input);
  assert.equal(harness.draws.length, 3);
  assert.equal(prevented, true);
  harness.listeners.get("webglcontextrestored")!({});
  field.layer.render(harness.gl, harness.input);
  assert.equal(harness.draws.length, 6);
  assert.equal(harness.uploads.length, 6);
  field.layer.onRemove!(harness.map, harness.gl);
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.textures.length, 3);
});

test("palette and edge setters repaint without reuploading class ids", () => {
  const harness = createHarness();
  harness.field.setIds(new Uint8Array(12).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  const uploadCount = harness.uploads.length;

  harness.field.setColors([[100, 110, 120]]);
  harness.field.setEdges({ smooth: false, rounding: 0.6, softnessCells: 1, outline: true });
  harness.field.layer.render(harness.gl, harness.input);

  assert.equal(harness.uploads.length, uploadCount + 1);
  assert.equal(harness.uniforms.get("uSmooth"), 0);
  assert.equal(harness.uniforms.get("uRounding"), 0.6);
  assert.equal(harness.uniforms.get("uSoftnessCells"), 1);
  assert.equal(harness.uniforms.get("uOutline"), 1);
  assert.equal(harness.uniforms.get("uOutlineStrength"), FILL_OUTLINE_STRENGTH);
  assert.equal(harness.repaints(), 2);
});

test("class field geometry uses the normalised Mercator projection, not world pixels", () => {
  const harness = createHarness();
  harness.field.setIds(new Uint8Array(12).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  const matrix = harness.uniforms.get("uMatrix") as Float32Array;

  assert.ok(Math.abs(matrix[0] - 1 / 360) < 1e-8);
  assert.ok(Math.abs(matrix[12] - 1.6) < 1e-6);
});

test("a 2048 texture limit splits a long grid into haloed uploads", () => {
  const harness = createHarness({ nx: 4096, maxTextureSize: 2048 });
  harness.field.setIds(new Uint8Array(4096 * 3).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  const idUploads = harness.uploads.slice(2);

  assert.deepEqual(idUploads.map((upload) => upload[3]), [2046, 2048, 10]);
  assert.ok(idUploads.every((upload) => upload[4] === 3));
  assert.equal(harness.draws.length, 9);
});

test("shader failures report once outside onAdd and free partially created resources", async () => {
  const harness = createHarness({ compile: false });
  harness.field.layer.onAdd!(harness.map, harness.gl);
  assert.equal(harness.failures.length, 0);
  await Promise.resolve();

  assert.match(harness.failures[0].message, /Cannot compile.*driver log/);
  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.shaders.length, 1);
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.failures.length, 1);
});

test("link failures report fallback with the driver log and free both shaders", async () => {
  const harness = createHarness({ link: false });
  harness.field.layer.onAdd!(harness.map, harness.gl);
  await Promise.resolve();

  assert.match(harness.failures[0].message, /Cannot link.*driver log/);
  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.shaders.length, 2);
});

test("a failed texture upload reports fallback and frees the failed texture", async () => {
  const harness = createHarness({ uploadError: 1285 });
  harness.field.layer.onAdd!(harness.map, harness.gl);
  await Promise.resolve();

  assert.match(harness.failures[0].message, /GL error 1285/);
  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.textures.length, 1);
  assert.equal(harness.deleted.buffers.length, 1);
  assert.equal(harness.deleted.arrays.length, 1);
});

test("globe drawing requests fallback instead of drawing Mercator quads", async () => {
  const harness = createHarness({ globe: true });
  harness.field.setIds(new Uint8Array(12).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  await Promise.resolve();

  assert.equal(harness.draws.length, 0);
  assert.match(harness.failures[0].message, /Mercator/);
});

test("the outline option draws faint ink over the opaque class fill", () => {
  const harness = createHarness();
  harness.field.setIds(new Uint8Array(12).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);

  assert.equal(harness.uniforms.get("uOutline"), 0);
  assert.equal(harness.uniforms.get("uOutlineStrength"), FILL_OUTLINE_STRENGTH);

  harness.field.setEdges({ smooth: true, rounding: 0.25, softnessCells: 0, outline: true });
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.uniforms.get("uOutline"), 1);
  assert.equal(harness.uniforms.get("uOutlineStrength"), FILL_OUTLINE_STRENGTH);
});
