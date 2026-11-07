import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness } from "./class-field-harness.test.ts";
import { FILL_OUTLINE_STRENGTH, homogeneousFlags } from "./class-field-shaders.ts";

test("class fields retain ids across context loss and release resources on removal", () => {
  const harness = createHarness();
  const field = harness.field;
  field.setIds(new Uint8Array(12).fill(1));
  field.setColors([[10, 20, 30]]);
  field.setEdges(smoothingEdges());
  field.layer.onAdd!(harness.map, harness.gl);
  field.layer.render(harness.gl, harness.input);

  assert.equal(harness.draws.length, 3);
  assert.equal(harness.uploads.length, 4);
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
  assert.equal(harness.uploads.length, 8);
  field.layer.onRemove!(harness.map, harness.gl);
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.textures.length, 4);
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
  assert.equal(harness.uniforms.get("uSmoothRadiusCells"), 0);
  assert.equal(harness.uniforms.get("uOutline"), 1);
  assert.equal(harness.uniforms.get("uOutlineStrength"), FILL_OUTLINE_STRENGTH);
  assert.equal(harness.uniforms.get("uPixelRatio"), 1);
  assert.equal(harness.repaints(), 2);
});

test("the geology smoothing radius reaches the fragment shader", () => {
  const harness = createHarness();
  harness.field.setIds(new Uint8Array(12).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);

  harness.field.setEdges({
    smooth: true,
    rounding: 0.25,
    softnessCells: 0,
    smoothRadiusCells: 1.5,
    outline: false,
  });
  harness.field.layer.render(harness.gl, harness.input);

  assert.equal(harness.uniforms.get("uSmoothRadiusCells"), 1.5);
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
  harness.field.setEdges(smoothingEdges());
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  const tileUploads = harness.uploads.slice(2);
  const idUploads = tileUploads.filter((_, index) => index % 2 === 0);
  const flagUploads = tileUploads.filter((_, index) => index % 2 === 1);

  assert.deepEqual(idUploads.map((upload) => upload[3]), [2040, 2048, 40]);
  assert.ok(idUploads.every((upload) => upload[4] === 3));
  assert.deepEqual(flagUploads.map((upload) => upload[3]), [2040, 2048, 40]);
  assert.ok(flagUploads.every((upload) => upload[4] === 3));
  assert.equal(harness.draws.length, 9);
});

test("shader failures report once outside onAdd and free partially created resources", async () => {
  const harness = createHarness({ compile: false });
  harness.field.setIds(new Uint8Array(12).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  assert.equal(harness.failures.length, 0);
  harness.field.layer.render(harness.gl, harness.input);
  await Promise.resolve();

  assert.match(harness.failures[0].message, /Cannot compile.*driver log/);
  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.shaders.length, 1);
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.failures.length, 1);
});

test("link failures report fallback with the driver log and free both shaders", async () => {
  const harness = createHarness({ link: false });
  harness.field.setIds(new Uint8Array(12).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  await Promise.resolve();

  assert.match(harness.failures[0].message, /Cannot link.*driver log/);
  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.shaders.length, 2);
});

test("a failed texture upload reports fallback and frees the failed texture", async () => {
  const harness = createHarness({ uploadError: 1285 });
  harness.field.setIds(new Uint8Array(12).fill(1));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
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

test("uniform ids upload set homogeneous flags beside the ids", () => {
  const harness = createHarness();
  const ids = new Uint8Array(12).fill(10);
  harness.field.setIds(ids);
  harness.field.setEdges(smoothingEdges());
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);

  assert.equal(harness.uploads.length, 4);
  const flags = harness.uploads[3][8] as Uint8Array;
  assert.deepEqual([...flags], [...homogeneousFlags(ids, 4, 3)]);
  assert.ok(flags.every((flag) => flag === 1));
  assert.equal(harness.uniforms.get("uIds"), 0);
  assert.equal(harness.uniforms.get("uHomogeneous"), 2);
  assert.equal(harness.uniforms.get("uPalette"), 3);
});

test("a split field uploads cleared homogeneous flags", () => {
  const harness = createHarness();
  const ids = new Uint8Array([10, 10, 20, 20, 10, 10, 20, 20, 10, 10, 20, 20]);
  harness.field.setIds(ids);
  harness.field.setEdges(smoothingEdges());
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);

  const flags = harness.uploads[3][8] as Uint8Array;
  assert.deepEqual([...flags], [...homogeneousFlags(ids, 4, 3)]);
  assert.ok(flags.every((flag) => flag === 0));
});

test("a zero smoothing radius uploads ids without flags", () => {
  const harness = createHarness();
  harness.field.setIds(new Uint8Array(12).fill(10));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);

  assert.equal(harness.uploads.length, 3);
  assert.equal(harness.draws.length, 3);
});

test("flags are built once per data set and reused across edge and radius changes", () => {
  const harness = createHarness();
  const ids = new Uint8Array(12).fill(10);
  harness.field.setIds(ids);
  harness.field.setEdges(smoothingEdges());
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.uploads.length, 4);

  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.uploads.length, 4);

  // Editing the shared ids in place makes a rebuilt flag set differ from the cached one.
  ids.set([20, 20, 20, 20], 4);
  harness.field.setEdges({ ...smoothingEdges(), rounding: 0.5 });
  harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 3 });
  harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 0 });
  harness.field.setEdges(smoothingEdges());
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.uploads.length, 6);
  assert.ok((harness.uploads[5][8] as Uint8Array).every((flag) => flag === 1));

  harness.field.setIds(ids);
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.uploads.length, 8);
  assert.ok((harness.uploads[7][8] as Uint8Array).every((flag) => flag === 0));
});

test("the flag sampler stays on an integer texture when no flags are uploaded", () => {
  const cases = [
    { name: "zero radius", edges: { ...smoothingEdges(), smoothRadiusCells: 0 } },
    { name: "smooth off", edges: { ...smoothingEdges(), smooth: false } },
  ];
  for (const { name, edges } of cases) {
    const harness = createHarness();
    const bindings = trackBindings(harness);
    harness.field.setIds(new Uint8Array(12).fill(10));
    harness.field.setEdges(edges);
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(bindings.homogeneousIsInteger(), true, name);
    assert.equal(harness.uniforms.get("uHomogeneous"), 0, name);
  }
});

test("the flag sampler follows the companion through positive and zero radius", () => {
  const harness = createHarness();
  const bindings = trackBindings(harness);
  harness.field.setIds(new Uint8Array(12).fill(10));
  harness.field.setEdges(smoothingEdges());
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(bindings.homogeneousIsInteger(), true);
  assert.equal(harness.uniforms.get("uHomogeneous"), 2);

  harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 0 });
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(bindings.homogeneousIsInteger(), true);
  assert.equal(harness.uniforms.get("uHomogeneous"), 0);

  harness.field.setEdges(smoothingEdges());
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(bindings.homogeneousIsInteger(), true);
  assert.equal(harness.uniforms.get("uHomogeneous"), 2);
});

/** Records which texture backs the flag sampler at each draw, starting with a foreign one on unit 2. */
function trackBindings(harness: ReturnType<typeof createHarness>) {
  const { gl, uniforms } = harness;
  const units: unknown[] = [];
  const integerTextures = new Set<unknown>();
  const sampled: unknown[] = [];
  let activeUnit = 0;
  const upload = gl.texImage2D;
  const draw = gl.drawArrays;
  Object.assign(gl, {
    TEXTURE0: FIRST_UNIT,
    TEXTURE2: FIRST_UNIT + 2,
    TEXTURE3: FIRST_UNIT + 3,
    activeTexture: (unit: number) => {
      activeUnit = unit - FIRST_UNIT;
    },
    bindTexture: (_target: number, texture: unknown) => {
      units[activeUnit] = texture;
    },
    texImage2D: (...args: unknown[]) => {
      if ((args[8] as Uint8Array).byteLength !== PALETTE_BYTES) {
        integerTextures.add(units[activeUnit]);
      }
      return upload.apply(gl, args as Parameters<typeof upload>);
    },
    drawArrays: (...args: unknown[]) => {
      sampled.push(units[uniforms.get("uHomogeneous") as number]);
      return draw.apply(gl, args as Parameters<typeof draw>);
    },
  });
  // MapLibre leaves its own non-integer image textures on the units it used last.
  units[2] = {};
  return {
    homogeneousIsInteger: () => sampled.length > 0 && sampled.every((texture) => (
      integerTextures.has(texture)
    )),
  };
}

const PALETTE_BYTES = 256 * 4;
const FIRST_UNIT = 100; // arbitrary base for the fake texture unit constants

function smoothingEdges() {
  return { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 1.5, outline: false };
}
