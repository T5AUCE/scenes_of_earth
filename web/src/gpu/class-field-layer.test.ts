import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness } from "./class-field-harness.test.ts";
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
    harness.field.setIds(new Uint8Array(4096 * 3).fill(1));
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

    assert.equal(harness.uploads.length, 7);
    const flags = harness.uploads[3][8] as Uint8Array;
    assert.deepEqual([...flags], [...homogeneousFlags(ids, 4, 3)]);
    assert.ok(flags.every((flag) => flag === 1));
    assert.equal(harness.uniforms.get("uIds"), 0);
    assert.equal(harness.uniforms.get("uHomogeneous"), 2);
    assert.equal(harness.uniforms.get("uPalette"), 3);
    assert.equal(harness.uniforms.get("uBake"), 1);
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
    assert.equal(harness.uploads.length, 7);

    // Editing the shared ids in place makes the rebuilt flags differ from the cached ones.
    ids.set([20, 20, 20, 20], 4);
    harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 3 });
    await harness.field.bakeSettled();
    harness.field.layer.render(harness.gl, harness.input);
    assert.equal(harness.uploads.length, 12);
    assert.ok((harness.uploads[8][8] as Uint8Array).every((flag) => flag !== 1));

    harness.field.setIds(ids);
    await harness.field.bakeSettled();
    harness.field.layer.render(harness.gl, harness.input);
    assert.equal(harness.uploads.length, 17);
    assert.ok((harness.uploads[13][8] as Uint8Array).every((flag) => flag !== 1));
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

test("colours reuse the baked band without re-uploading it", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness();
    harness.field.setIds(new Uint8Array(12).fill(10));
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
    harness.field.setIds(new Uint8Array(12).fill(10));
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
    harness.field.setIds(new Uint8Array(12).fill(10));
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

test("an odd window origin uploads a complex band that falls back", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness({ nx: 4096, maxTextureSize: 2049 });
    const ids = new Uint8Array(4096 * 3).fill(10);
    ids[2025] = 20;
    harness.field.setIds(ids);
    harness.field.setEdges({ ...smoothingEdges(), smoothRadiusCells: 4 });
    await harness.field.bakeSettled();
    harness.field.layer.onAdd!(harness.map, harness.gl);
    harness.field.layer.render(harness.gl, harness.input);

    const bandIds = harness.uploads[11][8] as Uint8Array;
    assert.ok(bandIds.every((value) => value === 0));
    const bandLow = harness.uploads[12][8] as Uint32Array;
    assert.ok(bandLow.every((value) => value === 0xffffffff));
    const bandHigh = harness.uploads[13][8] as Uint32Array;
    assert.ok(bandHigh.every((value) => value === 0xffffffff));
  });
});

test("a failed second band upload frees its tile textures", async () => {
  await withSearchAsync("?bake=1", async () => {
    const harness = createHarness({ failUploadAt: 5 });
    harness.field.setIds(new Uint8Array(12).fill(10));
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
    harness.field.setIds(new Uint8Array(12).fill(10));
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
    harness.field.setIds(new Uint8Array(12).fill(10));
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
    harness.field.setIds(new Uint8Array(12).fill(10));
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
