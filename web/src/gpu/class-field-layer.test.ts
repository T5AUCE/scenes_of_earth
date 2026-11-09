import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness } from "./class-field-harness.test.ts";
import { createClassFieldLayer } from "./class-field-layer.ts";
import {
  FILL_OUTLINE_STRENGTH,
  homogeneousFlags,
  markThinCells,
  THIN_CELL_FLAG,
} from "./class-field-shaders.ts";

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
  assert.equal(harness.uniforms.has("uBake"), false);
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

test("a 2048 texture limit splits a long grid into haloed uploads", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness({ nx: 4096, maxTextureSize: 2048 });
    harness.field.setIds(Uint8Array.from({ length: 4096 * 3 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);
    const tileUploads = harness.uploads.slice(2, 8);
    const idUploads = tileUploads.filter((_, index) => index % 2 === 0);
    const flagUploads = tileUploads.filter((_, index) => index % 2 === 1);

    assert.deepEqual(idUploads.map((upload) => upload[3]), [2040, 2048, 40]);
    assert.ok(idUploads.every((upload) => upload[4] === 3));
    assert.deepEqual(flagUploads.map((upload) => upload[3]), [2040, 2048, 40]);
    assert.ok(flagUploads.every((upload) => upload[4] === 3));
    const bandUploads = harness.uploads.slice(8);
    assert.equal(bandUploads.length, 9);
    assert.deepEqual(bandUploads.map((upload) => upload[3]), [
      2040,
      2040,
      2040,
      2048,
      2048,
      2048,
      40,
      40,
      40,
    ]);
    assert.ok(bandUploads.every((upload) => upload[4] === 3));
    assert.equal(harness.draws.length, 9);
    assert.equal(harness.uniforms.get("uBake"), 1);
  });
});

test("band uploads stage across renders while tiles keep drawing", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness({ nx: 100, maxTextureSize: 24 });
    harness.field.setIds(Uint8Array.from({ length: 300 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    const bakes: unknown[] = [];
    const original = harness.gl.uniform1i.bind(harness.gl);
    (harness.gl as unknown as { uniform1i: (name: string, value: unknown) => void }).uniform1i = (
      name,
      value,
    ) => {
      if (name === "uBake") bakes.push(value);
      original(name, value);
    };
    harness.field.layer.render(harness.gl, harness.input);
    const firstUploads = harness.uploads.length;
    const firstBakes = [...bakes];
    harness.field.layer.render(harness.gl, harness.input);
    harness.field.layer.render(harness.gl, harness.input);
    harness.field.layer.render(harness.gl, harness.input);

    // The first render carries only a staged subset while every tile still draws.
    assert.ok(harness.uploads.length > firstUploads);
    assert.ok(firstBakes.includes(1) && firstBakes.includes(0));
    assert.ok(harness.draws.length > 0);
  });
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

test("uniform ids upload set homogeneous flags beside the ids", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    const ids = new Uint8Array(12).fill(10);
    harness.field.setIds(ids);
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    // Uniform interiors return before any band fetch, so no band textures ride along.
    assert.equal(harness.uploads.length, 4);
    const flags = harness.uploads[3][8] as Uint8Array;
    assert.deepEqual([...flags], [...homogeneousFlags(ids, 4, 3)]);
    assert.ok(flags.every((flag) => flag === 1));
    assert.equal(harness.uniforms.get("uIds"), 0);
    assert.equal(harness.uniforms.get("uHomogeneous"), 2);
    assert.equal(harness.uniforms.get("uPalette"), 3);
    assert.equal(harness.uniforms.get("uBake"), 0);
  });
});

test("a split field uploads cleared homogeneous flags", () => {
  const harness = createHarness();
  const ids = new Uint8Array([10, 10, 20, 20, 10, 10, 20, 20, 10, 10, 20, 20]);
  harness.field.setIds(ids);
  harness.field.setEdges(smoothingEdges());
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);

  const flags = harness.uploads[3][8] as Uint8Array;
  const expected = homogeneousFlags(ids, 4, 3);
  markThinCells(ids, 4, 3, expected);
  assert.deepEqual([...flags], [...expected]);
  assert.ok(flags.every((flag) => flag === THIN_CELL_FLAG));
});

test("a zero smoothing radius uploads ids without flags", () => {
  const harness = createHarness();
  harness.field.setIds(new Uint8Array(12).fill(10));
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);

  assert.equal(harness.uploads.length, 3);
  assert.equal(harness.draws.length, 3);
});

test("flags are built once per data set and reused within one window", () => {
  const harness = createHarness();
  harness.field.setIds(new Uint8Array(12).fill(10));
  harness.field.setEdges(smoothingEdges());
  harness.field.layer.onAdd!(harness.map, harness.gl);
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.uploads.length, 4);

  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.uploads.length, 4);

  // Rounding and a radius within the small window reuse the cached pair.
  harness.field.setEdges({ ...smoothingEdges(), rounding: 0.5 });
  harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 2 });
  harness.field.layer.render(harness.gl, harness.input);
  assert.equal(harness.uploads.length, 4);
  assert.ok((harness.uploads[3][8] as Uint8Array).every((flag) => flag === 1));
});

test("a radius crossing the stride threshold rebuilds the flags", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    const ids = new Uint8Array(12).fill(10);
    harness.field.setIds(ids);
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);
    assert.equal(harness.uploads.length, 4);

    // Editing the shared ids in place makes the rebuilt flags differ from the cached ones.
    ids.set([20, 20, 20, 20], 4);
    harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 3 });
    await harness.field.bakeSettled();
    harness.field.layer.render(harness.gl, harness.input);
    assert.equal(harness.uploads.length, 9);
    assert.ok((harness.uploads[5][8] as Uint8Array).every((flag) => flag !== 1));

    harness.field.setIds(ids);
    await harness.field.bakeSettled();
    harness.field.layer.render(harness.gl, harness.input);
    assert.equal(harness.uploads.length, 14);
    assert.ok((harness.uploads[10][8] as Uint8Array).every((flag) => flag !== 1));
  });
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

test("pending bands keep every sampler on the integer ids texture", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    const bands = trackBandSamplers(harness);
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.get("uBake"), 0);
    assert.ok(bands.everyDrawOnIntegerIds());
    assert.ok(bands.sawUnit(0));
  });
});

test("uniform tiles keep every sampler on the integer ids texture", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    const bands = trackBandSamplers(harness);
    harness.field.setIds(new Uint8Array(12).fill(10));
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.get("uBake"), 0);
    assert.ok(bands.everyDrawOnIntegerIds());
    assert.ok(bands.sawUnit(0));
  });
});

test("disabled bake leaves no band sampler to validate", () => {
  withSearch("", () => {
    const harness = createHarness();
    const bands = trackBandSamplers(harness);
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.has("uBake"), false);
    assert.equal(harness.uniforms.has("uBandIds"), false);
    assert.equal(bands.drawCount(), 0);
  });
});

test("mixed tiles validate ready bands and fall back the rest on integer ids", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness({ nx: 4096, maxTextureSize: 2049 });
    const bands = trackBandSamplers(harness);
    const ids = new Uint8Array(4096 * 3).fill(10);
    ids[2025] = 20;
    harness.field.setIds(ids);
    harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 4 });
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    assert.ok(bands.everyDrawOnIntegerIds());
    assert.ok(bands.sawUnit(0));
    assert.ok(bands.sawUnit(4));
  });
});

test("colours reuse the baked band without re-uploading it", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);
    assert.equal(harness.uploads.length, 7);
    assert.equal(harness.uniforms.get("uBandIds"), 4);
    assert.equal(harness.uniforms.get("uBandLow"), 5);
    assert.equal(harness.uniforms.get("uBandHigh"), 6);

    harness.field.setColors([[100, 110, 120]]);
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uploads.length, 8);
    assert.equal(harness.uniforms.get("uBandIds"), 4);
    assert.equal(harness.uniforms.get("uBandLow"), 5);
    assert.equal(harness.uniforms.get("uBandHigh"), 6);
  });
});

test("the band uploads two ids with two mask words per texel", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    const bandIds = harness.uploads[4][8] as Uint8Array;
    const bandLow = harness.uploads[5][8] as Uint32Array;
    const bandHigh = harness.uploads[6][8] as Uint32Array;
    assert.equal(bandIds.length, 12 * 2);
    assert.equal(bandLow.length, 12);
    assert.equal(bandHigh.length, 12);
    assert.equal(bandIds.byteLength + bandLow.byteLength + bandHigh.byteLength, 12 * 10);
  });
});

test("without the bake flag the layer uploads no band and takes the pre-bake path", () => {
  withSearch("", () => {
    const harness = createHarness();
    harness.field.setIds(new Uint8Array(12).fill(10));
    harness.field.setEdges(smoothingEdges());
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uploads.length, 4);
    for (const name of ["uBake", "uBandIds", "uBandLow", "uBandHigh"]) {
      assert.equal(harness.uniforms.has(name), false, name);
    }
  });
});

test("tiles draw the full path while the band builds off the arrival task", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.get("uBake"), 0);
    assert.equal(harness.draws.length, 3);
    await harness.field.bakeSettled();
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.get("uBake"), 1);
    assert.equal(harness.uploads.length, 7);
    assert.equal(harness.draws.length, 6);
  });
});

test("an odd window origin skips its band and keeps the full gather", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness({ nx: 4096, maxTextureSize: 2049 });
    const ids = new Uint8Array(4096 * 3).fill(10);
    ids[2025] = 20;
    harness.field.setIds(ids);
    harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 4 });
    await harness.field.bakeSettled();
    const bakes: unknown[] = [];
    const original = harness.gl.uniform1i.bind(harness.gl);
    (harness.gl as unknown as { uniform1i: (name: string, value: unknown) => void }).uniform1i = (
      name,
      value,
    ) => {
      if (name === "uBake") bakes.push(value);
      original(name, value);
    };
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    // Only the even non-uniform tile uploads bands; the odd and uniform tiles fall back.
    assert.equal(harness.uploads.length, 11);
    assert.deepEqual(bakes, [1, 0, 0]);
  });
});

test("a failed second band upload frees its tile textures", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness({ failUploadAt: 5 });
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);
    await Promise.resolve();

    assert.match(harness.failures[0].message, /GL error 1285/);
    harness.field.layer.onRemove!(harness.map, harness.gl);
    assert.equal(harness.deleted.textures.length, harness.uploads.length);
  });
});

test("a failed third band upload frees its tile textures", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness({ failUploadAt: 6 });
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);
    await Promise.resolve();

    assert.match(harness.failures[0].message, /GL error 1285/);
    harness.field.layer.onRemove!(harness.map, harness.gl);
    assert.equal(harness.deleted.textures.length, harness.uploads.length);
  });
});

test("the baked band reports time and memory per tile", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    const stats = (globalThis as unknown as {
      __bakeStats?: Record<string, { ms: number; cpuBytes: number; gpuBytes: number }>;
    }).__bakeStats?.classes;
    assert.ok(stats);
    assert.ok(stats.ms >= 0);
    assert.equal(stats.cpuBytes, 12 * 10);
    assert.equal(stats.gpuBytes, 12 * 10);
  });
});

test("removing the layer cancels a pending bake and clears its stats", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    harness.field.setIds(new Uint8Array(12).fill(10));
    harness.field.setEdges(smoothingEdges());
    harness.field.layer.onAdd!(harness.map, harness.gl);
    const settled = harness.field.bakeSettled();
    harness.field.layer.onRemove!(harness.map, harness.gl);
    await settled;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(bakeStatsFor("classes"), undefined);
    harness.field.setEdges({ ...smoothingEdges(), rounding: 0.5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(bakeStatsFor("classes"), undefined);
  });
});

test("adding the layer again restarts the bake and removing it clears the stats", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    harness.field.setIds(new Uint8Array(12).fill(10));
    harness.field.setEdges(smoothingEdges());
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.onRemove!(harness.map, harness.gl);
    harness.field.layer.onAdd!(harness.map, harness.gl);
    await harness.field.bakeSettled();
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(bakeStatsFor("classes")?.cpuBytes, 12 * 10);
    harness.field.layer.onRemove!(harness.map, harness.gl);
    assert.equal(bakeStatsFor("classes"), undefined);
  });
});

test("a context restore uploads the finished band again", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    harness.field.setIds(Uint8Array.from({ length: 12 }, (_, cell) => 10 + (cell % 2) * 10));
    harness.field.setEdges(smoothingEdges());
    harness.field.layer.onAdd!(harness.map, harness.gl);
    await harness.field.bakeSettled();
    harness.field.layer.render(harness.gl, harness.input);
    assert.equal(harness.uploads.length, 7);

    harness.listeners.get("webglcontextlost")!({ preventDefault: () => {} });
    harness.listeners.get("webglcontextrestored")!({});
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uploads.length, 14);
    assert.equal(harness.uniforms.get("uBake"), 1);
  });
});

test("a large non-uniform grid stages band uploads within budgets", async () => {
  await withSearchAsync("?bake=1", async () => {
    const size = 1000;
    const harness = createHarness({ maxTextureSize: 2048 });
    const bandRows = installBandSubuploads(harness);
    const failures: Error[] = [];
    const field = createClassFieldLayer({
      id: "classes",
      grid: { bbox: [36, -2, 37, -1], nx: size, ny: size },
      shift: 0,
      opacity: 0.8,
      edges: smoothingEdges(),
      onFail: (error) => failures.push(error),
    });
    const cells = Uint8Array.from({ length: size * size }, (_, cell) => 10 + (cell % 2) * 10);
    field.setIds(cells);
    field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 1.5 });
    await field.bakeSettled();
    field.layer.onAdd!(harness.map, harness.gl);
    const rowBytes = (rows: unknown[][]) => rows.reduce((sum, upload) => (
      sum + ((upload[8] as ArrayBufferView | null)?.byteLength ?? 0)
    ), 0);
    let renders = 0;
    let finished = false;
    let peakBytes = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const beforeRows = bandRows.length;
      field.layer.render(harness.gl, harness.input);
      renders += 1;
      const extraRows = bandRows.slice(beforeRows);
      peakBytes = Math.max(peakBytes, rowBytes(extraRows));
      assert.ok(rowBytes(extraRows) <= 2 * 1024 * 1024 + 1024, `${rowBytes(extraRows)}`);
      if (harness.uniforms.get("uBake") === 1) {
        finished = true;
        break;
      }
      assert.equal(harness.uniforms.get("uBake"), 0);
    }
    assert.equal(failures.length, 0);
    assert.ok(finished);
    assert.ok(renders > 1);
    assert.ok(renders <= 10);
    assert.ok(peakBytes > 0);
    assert.ok(peakBytes <= 2 * 1024 * 1024 + 1024);
  });
});

test("staged allocation clears a foreign unpack buffer and image flags", async () => {
  await withSearchAsync("?bake=1", async () => {
    const size = 512;
    const harness = createHarness({ maxTextureSize: 2048 });
    const unpack = installContaminatedUnpack(harness);
    const failures: Error[] = [];
    const field = createClassFieldLayer({
      id: "classes",
      grid: { bbox: [36, -2, 37, -1], nx: size, ny: size },
      shift: 0,
      opacity: 0.8,
      edges: smoothingEdges(),
      onFail: (error) => failures.push(error),
    });
    const cells = Uint8Array.from({ length: size * size }, (_, cell) => 10 + (cell % 2) * 10);
    field.setIds(cells);
    field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 1.5 });
    await field.bakeSettled();
    field.layer.onAdd!(harness.map, harness.gl);
    let finished = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      unpack.contaminate();
      field.layer.render(harness.gl, harness.input);
      if (harness.uniforms.get("uBake") === 1) {
        finished = true;
        break;
      }
    }
    assert.equal(failures.length, 0);
    assert.ok(finished);
    assert.ok(unpack.bandRows.length > 0);
    assert.equal(unpack.violations(), 0);
    assert.ok(unpack.isContaminated());
  });
});

test("later band rows clear a foreign unpack buffer and image flags", async () => {
  await withSearchAsync("?bake=1", async () => {
    const size = 512;
    const harness = createHarness({ maxTextureSize: 2048 });
    const unpack = installContaminatedUnpack(harness);
    const failures: Error[] = [];
    const field = createClassFieldLayer({
      id: "classes",
      grid: { bbox: [36, -2, 37, -1], nx: size, ny: size },
      shift: 0,
      opacity: 0.8,
      edges: smoothingEdges(),
      onFail: (error) => failures.push(error),
    });
    const cells = Uint8Array.from({ length: size * size }, (_, cell) => 10 + (cell % 2) * 10);
    field.setIds(cells);
    field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 1.5 });
    await field.bakeSettled();
    field.layer.onAdd!(harness.map, harness.gl);
    unpack.makeClean();
    field.layer.render(harness.gl, harness.input);
    assert.equal(failures.length, 0);
    assert.equal(harness.uniforms.get("uBake"), 0);
    let finished = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      unpack.contaminate();
      field.layer.render(harness.gl, harness.input);
      if (harness.uniforms.get("uBake") === 1) {
        finished = true;
        break;
      }
    }
    assert.equal(failures.length, 0);
    assert.ok(finished);
    assert.ok(unpack.bandRows.length > 0);
    assert.equal(unpack.violations(), 0);
    assert.ok(unpack.isContaminated());
  });
});

function bakeStatsFor(id: string) {
  return (globalThis as unknown as {
    __bakeStats?: Record<string, { ms: number; cpuBytes: number; gpuBytes: number }>;
  }).__bakeStats?.[id];
}

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

function trackBandSamplers(harness: ReturnType<typeof createHarness>): {
  everyDrawOnIntegerIds: () => boolean;
  sawUnit: (unit: number) => boolean;
  drawCount: () => number;
} {
  const { gl, uniforms } = harness;
  const units: unknown[] = [];
  const integerTextures = new Set<unknown>();
  const records: { units: number[]; integer: boolean[] }[] = [];
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
      const data = args[8] as Uint8Array | null;
      if (data && data.byteLength !== PALETTE_BYTES) {
        integerTextures.add(units[activeUnit]);
      }
      return upload.apply(gl, args as Parameters<typeof upload>);
    },
    drawArrays: (...args: unknown[]) => {
      const names = ["uBandIds", "uBandLow", "uBandHigh"];
      const sampledUnits = names.map((name) => uniforms.get(name) as number | undefined);
      const hasBands = sampledUnits.every((unit) => unit !== undefined);
      if (hasBands) {
        const unitList = sampledUnits as number[];
        records.push({
          units: [...unitList],
          integer: unitList.map((unit) => integerTextures.has(units[unit])),
        });
      }
      return draw.apply(gl, args as Parameters<typeof draw>);
    },
  });
  for (const unit of [4, 5, 6]) units[unit] = { foreignImage: unit };
  return {
    everyDrawOnIntegerIds: () => records.length > 0 && records.every((record) => (
      record.integer.every((isInteger) => isInteger)
    )),
    sawUnit: (unit: number) => records.some((record) => record.units.includes(unit)),
    drawCount: () => records.length,
  };
}

function installContaminatedUnpack(harness: ReturnType<typeof createHarness>): {
  bandRows: unknown[][];
  violations: () => number;
  isContaminated: () => boolean;
  contaminate: () => void;
  makeClean: () => void;
} {
  const gl = harness.gl as unknown as Record<string, any>;
  gl.UNPACK_ALIGNMENT ??= 3317;
  gl.UNPACK_FLIP_Y_WEBGL ??= 37440;
  gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL ??= 37441;
  gl.UNPACK_ROW_LENGTH ??= 3314;
  gl.UNPACK_SKIP_ROWS ??= 3315;
  gl.UNPACK_SKIP_PIXELS ??= 3316;
  gl.PIXEL_UNPACK_BUFFER ??= 35052;
  gl.PIXEL_UNPACK_BUFFER_BINDING ??= 35053;
  const alignmentKey = gl.UNPACK_ALIGNMENT as number;
  const flipKey = gl.UNPACK_FLIP_Y_WEBGL as number;
  const premultiplyKey = gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL as number;
  const rowLengthKey = gl.UNPACK_ROW_LENGTH as number;
  const skipRowsKey = gl.UNPACK_SKIP_ROWS as number;
  const skipPixelsKey = gl.UNPACK_SKIP_PIXELS as number;
  const bufferKey = gl.PIXEL_UNPACK_BUFFER as number;
  const bindingKey = gl.PIXEL_UNPACK_BUFFER_BINDING as number;
  const foreign = { foreign: true };
  const contaminated = {
    alignment: 4,
    flipY: true,
    premultiply: true,
    rowLength: 7,
    skipRows: 2,
    skipPixels: 3,
    unpackBuffer: foreign as unknown | null,
  };
  const state = { ...contaminated };
  let violations = 0;
  let pendingError = 0;
  const isClean = () => state.alignment === 1 && !state.flipY && !state.premultiply
    && state.rowLength === 0 && state.skipRows === 0 && state.skipPixels === 0
    && state.unpackBuffer === null;
  const bandRows = installBandSubuploads(harness);
  const originalGetParameter = (
    harness.gl.getParameter as unknown as (...args: any[]) => any
  ).bind(harness.gl);
  const originalGetError = harness.gl.getError.bind(harness.gl);
  const originalTexImage = harness.gl.texImage2D.bind(harness.gl);
  const subuploads = harness.gl as unknown as { texSubImage2D: (...args: any[]) => void };
  const originalTexSub = subuploads.texSubImage2D.bind(harness.gl);
  gl.getParameter = (name: number) => {
    if (name === alignmentKey) return state.alignment;
    if (name === flipKey) return state.flipY;
    if (name === premultiplyKey) return state.premultiply;
    if (name === rowLengthKey) return state.rowLength;
    if (name === skipRowsKey) return state.skipRows;
    if (name === skipPixelsKey) return state.skipPixels;
    if (name === bindingKey) return state.unpackBuffer;
    return originalGetParameter(name);
  };
  gl.pixelStorei = (name: number, value: number | boolean) => {
    if (name === alignmentKey) state.alignment = value as number;
    else if (name === flipKey) state.flipY = value as boolean;
    else if (name === premultiplyKey) state.premultiply = value as boolean;
    else if (name === rowLengthKey) state.rowLength = value as number;
    else if (name === skipRowsKey) state.skipRows = value as number;
    else if (name === skipPixelsKey) state.skipPixels = value as number;
  };
  gl.bindBuffer = (target: number, buffer: unknown) => {
    if (target === bufferKey) state.unpackBuffer = buffer;
  };
  gl.texImage2D = (...args: any[]) => {
    if (!isClean()) {
      violations += 1;
      pendingError = 1285;
    }
    return originalTexImage(...args);
  };
  subuploads.texSubImage2D = (...args: any[]) => {
    if (!isClean()) {
      violations += 1;
      pendingError = 1285;
    }
    return originalTexSub(...args);
  };
  gl.getError = () => {
    if (pendingError !== 0) {
      const error = pendingError;
      pendingError = 0;
      return error;
    }
    return originalGetError();
  };
  return {
    bandRows,
    violations: () => violations,
    isContaminated: () => (
      state.alignment === contaminated.alignment
      && state.flipY === contaminated.flipY
      && state.premultiply === contaminated.premultiply
      && state.rowLength === contaminated.rowLength
      && state.skipRows === contaminated.skipRows
      && state.skipPixels === contaminated.skipPixels
      && state.unpackBuffer === foreign
    ),
    contaminate: () => {
      Object.assign(state, contaminated, { unpackBuffer: foreign });
    },
    makeClean: () => {
      state.alignment = 1;
      state.flipY = false;
      state.premultiply = false;
      state.rowLength = 0;
      state.skipRows = 0;
      state.skipPixels = 0;
      state.unpackBuffer = null;
    },
  };
}

function installBandSubuploads(harness: ReturnType<typeof createHarness>): unknown[][] {
  const gl = harness.gl as unknown as { texSubImage2D: (...args: unknown[]) => void };
  const uploads = harness.uploads as unknown[][];
  const bandRows: unknown[][] = [];
  gl.texSubImage2D = (...args: unknown[]) => {
    uploads.push(args);
    bandRows.push(args);
  };
  return bandRows;
}

const PALETTE_BYTES = 256 * 4;
const FIRST_UNIT = 100; // arbitrary base for the fake texture unit constants

function smoothingEdges() {
  return { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 1.5, outline: false };
}

test("a camera gesture draws flat fills without re-uploading and restores the edges", () => {
  withSearch("?fastClass=1", () => {
    const harness = createHarness();
    harness.field.setIds(new Uint8Array(12).fill(1));
    harness.field.setEdges({ smooth: true, rounding: 0.25, softnessCells: 0.5, outline: true });
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);
    const uploads = harness.uploads.length;
    assert.equal(harness.uniforms.get("uSmooth"), 1);
    assert.equal(harness.uniforms.get("uOutline"), 1);

    harness.emitMapEvent("movestart");
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.get("uSmooth"), 0);
    assert.equal(harness.uniforms.get("uOutline"), 0);
    assert.equal(harness.uploads.length, uploads);

    harness.emitMapEvent("moveend");
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.get("uSmooth"), 1);
    assert.equal(harness.uniforms.get("uOutline"), 1);
    assert.equal(harness.uploads.length, uploads);
  });
});

test("without the opt-in a camera gesture leaves the edges alone", () => {
  withSearch("", () => {
    const harness = createHarness();
    harness.field.setIds(new Uint8Array(12).fill(1));
    harness.field.setEdges({ smooth: true, rounding: 0.25, softnessCells: 0.5, outline: true });
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);
    const uploads = harness.uploads.length;
    assert.equal(harness.uniforms.get("uSmooth"), 1);
    assert.equal(harness.uniforms.get("uOutline"), 1);

    harness.emitMapEvent("movestart");
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.get("uSmooth"), 1);
    assert.equal(harness.uniforms.get("uOutline"), 1);
    assert.equal(harness.uploads.length, uploads);

    harness.emitMapEvent("moveend");
    harness.field.layer.render(harness.gl, harness.input);

    assert.equal(harness.uniforms.get("uSmooth"), 1);
    assert.equal(harness.uniforms.get("uOutline"), 1);
  });
});

test("removing the layer mid-gesture restores its edges and listeners", () => {
  withSearch("?fastClass=1", () => {
    const harness = createHarness();
    harness.field.setIds(new Uint8Array(12).fill(1));
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.emitMapEvent("movestart");
    harness.field.layer.render(harness.gl, harness.input);
    assert.equal(harness.uniforms.get("uSmooth"), 0);

    harness.field.layer.onRemove!(harness.map, harness.gl);

    assert.equal(harness.mapListenerCount("movestart"), 0);
    assert.equal(harness.mapListenerCount("moveend"), 0);
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

async function withSearchAsync(search: string, run: () => Promise<void>): Promise<void> {
  const previous = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = { search };
  try {
    await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "location");
    else (globalThis as Record<string, unknown>).location = previous;
  }
}
