import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";

import {
  edgeCoverage,
  sampleClassField,
  type ClassFieldResult,
} from "./class-field-shaders.ts";
import type { LayerContext } from "../types.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.includes("/src/gpu/")
      && specifier.startsWith("./")
      && !specifier.endsWith(".ts")
    ) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { createClassFieldLayer } = await import("./class-field-layer.ts")
  .finally(() => hooks.deregister());

const viewHooks = registerHooks({
  resolve(specifier, context, next) {
    const source = viewMockModule(specifier);
    if (source && context.parentURL?.includes("/src/")) {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    if (context.parentURL?.includes("/src/") && specifier.startsWith(".")) {
      const extension = specifier.endsWith(".ts") ? "" : ".ts";
      return next(new URL(`${specifier}${extension}`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { createCategoricalView } = await import("../layers/categorical.ts")
  .finally(() => viewHooks.deregister());

const TREE = 10;
const GRASS = 20;
const COVER = 30;

function viewMockModule(specifier: string) {
  switch (specifier) {
    case "../data":
      return `
        export const arrayDoc = (layer) => layer.arrays.value;
        export const readArray = async () => Float32Array.of(10, 20, 0, 10);
        export const decode = (raw) => raw;
      `;
    case "../legend":
      return "export const classLegend = () => ({});";
    case "../map":
      return `
        export const removeLayerAndSource = (map, id) => {
          if (map.getLayer(id)) map.removeLayer(id);
        };
        export const addImageLayer = (map, id, bbox, shift, beforeId) => {
          map.addLayer({ id, type: "raster" }, beforeId);
        };
        export const maxTextureSize = () => 64;
        export const setImage = (map, id, image) => { map.image = image; };
      `;
    default:
      return null;
  }
}

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
  harness.listeners.get("webglcontextlost")!({ preventDefault: () => { prevented = true; } });
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
  assert.equal(harness.repaints(), 2);
});

test("class field geometry uses the normalized Mercator projection, not world pixels", () => {
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

test("the scalar edge formula centres a one-pixel anti-alias", () => {
  const cellGradient: [number, number] = [2, 0];
  const screenGradient: [number, number] = [0.02, 0]; // One cell is 100 px wide.
  const at = (gap: number) => edgeCoverage(gap, cellGradient, screenGradient, 0);

  assert.equal(at(0).coverage, 0.5);
  assert.ok(Math.abs(at(0.005).coverage - 0.75) < 1e-12);
  assert.ok(Math.abs(at(-0.005).coverage - 0.25) < 1e-12);
  assert.equal(at(0.01).coverage, 1);
  assert.equal(at(-0.01).coverage, 0);
  assert.ok(Math.abs(edgeCoverage(0.2, [0, 2], [0, 1], 1).distanceCells - 0.1) < 1e-12);
});

test("class neighbourhoods centre a two-class edge and reach pure interiors", () => {
  const ids = edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]);
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const at = (fractionX: number) => sampleClassField(
    {
      ids,
      fraction: [fractionX, 0.5],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );

  assert.equal(weightOf(at(0), TREE), 1);
  assert.ok(Math.abs(weightOf(at(0.25), TREE) - 0.75) < 1e-12);
  assert.ok(Math.abs(weightOf(at(0.25), GRASS) - 0.25) < 1e-12);
  assert.ok(Math.abs(weightOf(at(0.5), TREE) - 0.5) < 1e-12);
  assert.ok(Math.abs(weightOf(at(0.5), GRASS) - 0.5) < 1e-12);
  assert.ok(weightOf(at(0.999), GRASS) > 0.998);
});

test("a subpixel edge widens to one device pixel on both sides", () => {
  const ids = edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]);
  const edges = { smooth: true, rounding: 0, softnessCells: 0 };
  const at = (fractionX: number) => sampleClassField(
    {
      ids,
      fraction: [fractionX, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    edges,
  );

  assert.ok(Math.abs(weightOf(at(0.4975), TREE) - 0.75) < 1e-12);
  assert.ok(Math.abs(weightOf(at(0.5025), GRASS) - 0.75) < 1e-12);
  assert.equal(weightOf(at(0.49), TREE), 1);
  assert.equal(weightOf(at(0.51), GRASS), 1);
});

test("the screen Jacobian sets the blend width without moving the edge", () => {
  const ids = edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]);
  const edges = { smooth: true, rounding: 0, softnessCells: 0 };
  const sample = (
    positionDx: [number, number],
    positionDy: [number, number],
  ) => sampleClassField(
    { ids, fraction: [0.4975, 0.5], positionDx, positionDy },
    edges,
  );
  const rotated = 0.01 / Math.SQRT2;

  assert.ok(Math.abs(weightOf(sample([0.01, 0], [0, 0.01]), TREE) - 0.75) < 1e-12);
  assert.ok(weightOf(sample([0.005, 0], [0, 0.01]), TREE) > 0.999);
  assert.ok(Math.abs(weightOf(sample([rotated, rotated], [-rotated, rotated]), TREE) - 0.75)
    < 1e-12);
});

test("multi-class blends stay continuous across a winner change", () => {
  const ids = edgeNeighbourhood([TREE, COVER], [GRASS, GRASS]);
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const at = (fractionX: number) => sampleClassField(
    {
      ids,
      fraction: [fractionX, 0.25],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );
  const tie = 3 / 7;
  const tied = at(tie);
  const below = at(tie - 1e-4);
  const above = at(tie + 1e-4);

  assert.equal(tied.weights.length, 3);
  assert.ok(weightOf(tied, COVER) > 0.05 && weightOf(tied, COVER) < 0.2);
  assert.ok(Math.abs(weightOf(below, TREE) - weightOf(above, TREE)) < 0.001);
  assert.ok(Math.abs(weightOf(below, GRASS) - weightOf(above, GRASS)) < 0.001);
  assert.ok(Math.abs(weightOf(below, COVER) - weightOf(above, COVER)) < 0.001);

  assert.equal(strongest(at(tie - 0.01)), TREE);
  assert.equal(strongest(at(tie + 0.01)), GRASS);
  assert.ok(weightOf(at(tie + 0.01), COVER) > 0.02);
});

test("a class entering the stencil changes no blend at any rounding", () => {
  const field = [
    [GRASS, GRASS, GRASS, GRASS, GRASS],
    [GRASS, GRASS, GRASS, GRASS, COVER],
    [TREE, TREE, TREE, TREE, TREE],
    [TREE, TREE, TREE, TREE, TREE],
  ];
  const window = (firstColumn: number, fractionX: number, rounding: number) => sampleClassField(
    {
      ids: field.map((row) => row.slice(firstColumn, firstColumn + 4)),
      fraction: [fractionX, 0.25],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    { smooth: true, rounding, softnessCells: 1 },
  );

  for (const rounding of [0, 0.25, 0.6]) {
    const before = window(0, 1 - 1e-7, rounding);
    const after = window(1, 1e-7, rounding);

    assert.ok(Math.abs(weightOf(before, GRASS) - weightOf(after, GRASS)) < 1e-4, `${rounding}`);
    assert.ok(Math.abs(weightOf(before, TREE) - weightOf(after, TREE)) < 1e-4, `${rounding}`);
    assert.ok(weightOf(after, COVER) < 1e-4, `${rounding}`);
  }
});

test("outline ink is continuous where a class enters the stencil", () => {
  const field = [
    [GRASS, GRASS, GRASS, GRASS, GRASS],
    [GRASS, GRASS, GRASS, GRASS, COVER],
    [TREE, TREE, TREE, TREE, TREE],
    [TREE, TREE, TREE, TREE, TREE],
  ];

  for (const softnessCells of [0, 1]) {
    for (const rounding of [0.25, 1]) {
      const ink = (firstColumn: number, fractionX: number) => sampleClassField(
        {
          ids: field.map((row) => row.slice(firstColumn, firstColumn + 4)),
          fraction: [fractionX, 0.5],
          positionDx: [2, 0],
          positionDy: [0, 2],
        },
        { smooth: true, rounding, softnessCells },
      ).outline;

      const message = `${softnessCells} ${rounding}`;
      assert.ok(Math.abs(ink(0, 1 - 1e-9) - ink(1, 1e-9)) < 1e-6, message);
    }
  }
});

test("an unsupported outer class leaves a two-class blend unchanged", () => {
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const blend = (outer: number) => sampleClassField(
    {
      ids: [
        [0, 0, 0, outer],
        [0, TREE, GRASS, 0],
        [0, TREE, GRASS, 0],
        [0, 0, 0, 0],
      ],
      fraction: [0.25, 0.5],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );

  assert.ok(Math.abs(weightOf(blend(COVER), TREE) - 0.75) < 1e-12);
  assert.equal(weightOf(blend(COVER), COVER), 0);
});

test("outline ink marks real edges and never a pure interior", () => {
  const sample = (ids: number[][], rounding: number, fractionX = 0.5) => sampleClassField(
    {
      ids,
      fraction: [fractionX, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding, softnessCells: 0 },
  );
  const interior = [
    [COVER, GRASS, GRASS, COVER],
    [GRASS, TREE, TREE, GRASS],
    [GRASS, TREE, TREE, GRASS],
    [COVER, GRASS, GRASS, COVER],
  ];
  const edge = edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]);

  for (const rounding of [0, 0.25, 0.6]) {
    assert.ok(sample(interior, rounding).outline < 1e-3, `${rounding}`);
  }
  assert.ok(sample(edge, 0).outline > 0.99);
  assert.ok(sample(edge, 0, 0.9).outline < 1e-3);
});

test("outline ink skips a tie hidden under a dominant third class", () => {
  const ids = edgeNeighbourhood([TREE, GRASS], [COVER, GRASS]);
  const ink = (fractionX: number, fractionY: number) => sampleClassField(
    {
      ids,
      fraction: [fractionX, fractionY],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding: 0, softnessCells: 0 },
  ).outline;

  assert.ok(ink(0.5, 0.25) > 0.8);
  assert.ok(ink(0.3, 0.7 / 1.7) > 0.9);
  assert.ok(ink(0.5, 0.75) < 1e-3);
  assert.ok(ink(0.3, 0.9) < 1e-3);
});

test("outline ink stops at a junction instead of following a losing pair's tie", () => {
  const ids = edgeNeighbourhood([TREE, COVER], [GRASS, COVER]);
  const ink = (fractionY: number, softnessCells: number) => sampleClassField(
    {
      ids,
      fraction: [0.5, fractionY],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding: 0, softnessCells },
  ).outline;

  for (const softnessCells of [0, 1]) {
    assert.ok(ink(0.2, softnessCells) > 0.5, `${softnessCells}`);
    assert.ok(ink(0.8, softnessCells) < 1e-3, `${softnessCells}`);
    assert.ok(ink(0.95, softnessCells) < 1e-3, `${softnessCells}`);
  }
});

test("outline ink is continuous where the runner-up swaps places", () => {
  const ids = edgeNeighbourhood([TREE, COVER], [GRASS, COVER]);
  const swapY = 0.495 / 1.495;
  const ink = (fractionY: number, positionDx: [number, number], positionDy: [number, number]) =>
    sampleClassField(
      { ids, fraction: [0.495, fractionY], positionDx, positionDy },
      { smooth: true, rounding: 0, softnessCells: 1 },
    ).outline;
  const scales: [[number, number], [number, number]][] = [
    [[0.01, 0], [0, 0.01]],
    [[0.04, 0], [0, 0.005]],
  ];

  for (const [positionDx, positionDy] of scales) {
    const before = ink(swapY - 1e-9, positionDx, positionDy);
    const after = ink(swapY + 1e-9, positionDx, positionDy);

    assert.ok(Math.abs(before - after) < 1e-6, `${positionDx} ${before} ${after}`);
  }
});

test("outline ink is continuous where the top two classes swap places", () => {
  const ids = edgeNeighbourhood([TREE, COVER], [GRASS, COVER]);
  const swapX = 0.48752205697000256;
  const swapY = 0.3388333333333333;

  for (const softnessCells of [0, 1]) {
    const ink = (offset: number) => sampleClassField(
      {
        ids,
        fraction: [swapX, swapY + offset],
        positionDx: [0.04, 0],
        positionDy: [0, 0.005],
      },
      { smooth: true, rounding: 0, softnessCells },
    ).outline;

    assert.ok(Math.abs(ink(-1e-9) - ink(1e-9)) < 1e-6, `${softnessCells}`);
  }
});

test("Smooth off paints the nearest cell instead of the kernel winner", () => {
  const ids = edgeNeighbourhood([TREE, GRASS], [GRASS, GRASS]);
  const fragment = {
    ids,
    fraction: [0.49, 0.49] as [number, number],
    positionDx: [0.0001, 0] as [number, number],
    positionDy: [0, 0.0001] as [number, number],
  };
  const smooth = sampleClassField(fragment, { smooth: true, rounding: 0, softnessCells: 1 });
  const flat = sampleClassField(fragment, { smooth: false, rounding: 0, softnessCells: 1 });

  assert.equal(flat.nearest, TREE);
  assert.deepEqual(flat.weights, [{ id: TREE, weight: 1 }]);
  assert.equal(smooth.nearest, TREE);
  assert.ok(weightOf(smooth, GRASS) > 0.7);
  assert.ok(weightOf(smooth, GRASS) > weightOf(smooth, TREE));
});

test("no-data keeps the nearest-cell mask and isolated classes whole", () => {
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const isolated = sampleClassField(
    {
      ids: edgeNeighbourhood([TREE, 0], [0, 0]),
      fraction: [0.49, 0.49],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );
  const loneCell = sampleClassField(
    {
      ids: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, TREE, 0],
        [0, 0, 0, 0],
      ],
      fraction: [0.6, 0.6],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );
  const besideEmpty = sampleClassField(
    {
      ids: edgeNeighbourhood([TREE, 0], [GRASS, 0]),
      fraction: [0.49, 0.49],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );
  const nearestEmpty = {
    ids: edgeNeighbourhood([0, TREE], [TREE, 0]),
    fraction: [0.49, 0.49] as [number, number],
    positionDx: [0.0001, 0] as [number, number],
    positionDy: [0, 0.0001] as [number, number],
  };

  assert.equal(isolated.discarded, false);
  assert.deepEqual(isolated.weights, [{ id: TREE, weight: 1 }]);
  assert.equal(loneCell.discarded, false);
  assert.deepEqual(loneCell.weights, [{ id: TREE, weight: 1 }]);
  assert.ok(Math.abs(weightOf(besideEmpty, TREE) + weightOf(besideEmpty, GRASS) - 1) < 1e-12);
  assert.ok(weightOf(besideEmpty, TREE) > 0.4);
  assert.equal(sampleClassField(nearestEmpty, edges).discarded, true);
  assert.equal(sampleClassField(nearestEmpty, { ...edges, smooth: false }).discarded, true);
});

test("categorical fallback keeps layer order and mask zoom gates when a shader fails", async () => {
  const harness = createViewHarness(false);
  try {
    const view = createCategoricalView(harness.context);
    const map = harness.map;
    map.setLayoutProperty("cover-classes", "visibility", "none");
    map.setLayerZoomRange("cover-classes", 8, 22);
    map.addLayer({ id: "field", type: "raster" }, "outline");
    await view.ready;

    assert.deepEqual(map.getLayersOrder(), ["cover-classes", "field", "outline"]);
    assert.equal(map.getLayer("cover-classes")?.type, "raster");
    assert.equal(map.getLayoutProperty("cover-classes", "visibility"), "none");
    assert.equal(map.getLayer("cover-classes")?.minzoom, 8);
    assert.equal(map.getLayer("cover-classes")?.maxzoom, 22);
    assert.equal(harness.body.dataset.landcoverRenderer, "image");
    assert.equal(view.menu?.edges, undefined);
    assert.equal(view.menu?.edgesNote, "Edge options need WebGL drawing.");
    assert.ok(map.image);
    view.destroy();
  } finally {
    harness.cleanup();
  }
});

test("categorical context restoration preserves position and visibility", async () => {
  const harness = createViewHarness(true);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;
    const map = harness.map;
    map.setLayoutProperty("cover-classes", "visibility", "none");
    map.setLayerZoomRange("cover-classes", 7, 22);
    map.addLayer({ id: "field", type: "raster" }, "outline");
    harness.capture.get("webglcontextlost")!();
    assert.equal(map.getLayer("cover-classes"), undefined);
    harness.capture.get("webglcontextrestored")!();

    assert.deepEqual(map.getLayersOrder(), ["cover-classes", "field", "outline"]);
    assert.equal(map.getLayer("cover-classes")?.type, "custom");
    assert.equal(map.getLayer("cover-classes")?.minzoom, 7);
    assert.equal(map.getLayoutProperty("cover-classes", "visibility"), "none");
    view.destroy();
    assert.equal(harness.capture.size, 0);
  } finally {
    harness.cleanup();
  }
});

function edgeNeighbourhood(
  left: readonly [number, number],
  right: readonly [number, number],
): number[][] {
  return [
    [0, 0, 0, 0],
    [0, left[0], right[0], 0],
    [0, left[1], right[1], 0],
    [0, 0, 0, 0],
  ];
}

function weightOf(result: ClassFieldResult, id: number): number {
  return result.weights.find((entry) => entry.id === id)?.weight ?? 0;
}

function strongest(result: ClassFieldResult): number {
  return result.weights.reduce((best, entry) => (entry.weight > best.weight ? entry : best)).id;
}

function createViewHarness(compile: boolean) {
  const gpu = createHarness({ compile });
  const globals = ["document", "localStorage", "ImageData"] as const;
  const original = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const body = { dataset: {} as Record<string, string> };
  Object.assign(globalThis, {
    document: { body, createElement: () => ({ replaceChildren: () => {} }) },
    localStorage: { getItem: () => null },
    ImageData: class {
      constructor(_pixels: Uint8ClampedArray, _width: number, _height: number) {}
    },
  });
  const capture = new Map<string, () => void>();
  const layers: { id: string; type: string; minzoom?: number; maxzoom?: number }[] = [
    { id: "outline", type: "line" },
  ];
  const visibility = new Map<string, string>();
  const custom = new Map<string, typeof gpu.field.layer>();
  const map = {
    image: null as ImageData | null,
    getCanvas: () => ({
      addEventListener: (name: string, callback: () => void, useCapture: boolean) => {
        if (useCapture || name === "webglcontextrestored") capture.set(name, callback);
      },
      removeEventListener: (name: string, _callback: () => void, useCapture: boolean) => {
        if (useCapture) capture.delete(name);
      },
    }),
    getProjection: () => ({ type: "mercator" }),
    getLayersOrder: () => layers.map(({ id }) => id),
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    getLayoutProperty: (id: string, _property: string) => visibility.get(id),
    setLayoutProperty: (id: string, _property: string, value: string) => visibility.set(id, value),
    getMaxZoom: () => 22,
    setLayerZoomRange: (id: string, minzoom: number, maxzoom: number) => {
      Object.assign(map.getLayer(id)!, { minzoom, maxzoom });
    },
    addLayer: (layer: { id: string; type: string }, beforeId?: string) => {
      const index = beforeId ? layers.findIndex(({ id }) => id === beforeId) : layers.length;
      layers.splice(index, 0, { id: layer.id, type: layer.type });
      if (layer.type !== "custom") return;

      const field = layer as typeof gpu.field.layer;
      custom.set(layer.id, field);
      field.onAdd!(gpu.map, gpu.gl);
    },
    removeLayer: (id: string) => {
      layers.splice(layers.findIndex((layer) => layer.id === id), 1);
      custom.get(id)?.onRemove!(gpu.map, gpu.gl);
      custom.delete(id);
    },
    triggerRepaint: () => {},
    isStyleLoaded: () => true,
    off: (_event: string, _callback: () => void) => {
      capture.delete("webglcontextrestored");
    },
  };
  const context = {
    map,
    store: Promise.resolve({}),
    layer: {
      id: "cover",
      title: "Cover",
      style: {
        kind: "categorical",
        palette: "painted",
        classes: [
          { value: 10, label: "Trees", color: "#112233" },
          { value: 20, label: "Grass", color: "#445566" },
        ],
      },
      arrays: { value: { path: "value" } },
      grid: { bbox: [36, -2, 37, -1], nx: 2, ny: 2 },
    },
    shift: 0,
    beforeId: "outline",
    report: (error: unknown) => { throw error; },
  } as unknown as LayerContext;
  return {
    context,
    map,
    body,
    capture,
    cleanup: () => globals.forEach((name, index) => {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }),
  };
}

function createHarness(options: {
  compile?: boolean;
  link?: boolean;
  uploadError?: number;
  globe?: boolean;
  nx?: number;
  maxTextureSize?: number;
} = {}) {
  const deleted = {
    programs: [] as object[],
    shaders: [] as object[],
    textures: [] as object[],
    buffers: [] as object[],
    arrays: [] as object[],
  };
  const listeners = new Map<string, (event: object) => void>();
  const uploads: unknown[][] = [];
  const draws: unknown[][] = [];
  const failures: Error[] = [];
  const uniforms = new Map<string, unknown>();
  let vertexArray: unknown = null;
  let repaints = 0;
  const gl = {
    MAX_TEXTURE_SIZE: 1,
    COMPILE_STATUS: 2,
    LINK_STATUS: 3,
    NO_ERROR: 0,
    createProgram: () => ({}),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => options.compile ?? true,
    getShaderInfoLog: () => "driver log",
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => options.link ?? true,
    getProgramInfoLog: () => "driver log",
    deleteShader: (value: object) => deleted.shaders.push(value),
    deleteProgram: (value: object) => deleted.programs.push(value),
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    bindVertexArray: (value: unknown) => { vertexArray = value; },
    bindBuffer: () => {},
    bindSampler: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    deleteBuffer: (value: object) => deleted.buffers.push(value),
    deleteVertexArray: (value: object) => deleted.arrays.push(value),
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    texImage2D: (...args: unknown[]) => uploads.push(args),
    getError: () => options.uploadError ?? 0,
    deleteTexture: (value: object) => deleted.textures.push(value),
    getParameter: (name: number) => name === 1 ? options.maxTextureSize ?? 4096 : 0,
    getUniformLocation: (_program: unknown, name: string) => name,
    uniform1i: (name: string, value: unknown) => uniforms.set(name, value),
    uniform1f: (name: string, value: unknown) => uniforms.set(name, value),
    uniform2i: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: (name: string, _transpose: boolean, value: unknown) => {
      uniforms.set(name, value);
    },
    activeTexture: () => {},
    useProgram: () => {},
    drawArrays: (...args: unknown[]) => draws.push(args),
  } as unknown as WebGL2RenderingContext;
  const map = {
    triggerRepaint: () => { repaints++; },
    getProjection: () => ({ type: options.globe ? "globe" : "mercator" }),
    getCanvas: () => ({
      addEventListener: (name: string, listener: (event: object) => void) => {
        listeners.set(name, listener);
      },
      removeEventListener: (name: string) => listeners.delete(name),
    }),
  } as unknown as MapLibreMap;
  const field = createClassFieldLayer({
    id: "classes",
    grid: { bbox: [36, -2, 37, -1], nx: options.nx ?? 4, ny: 3 },
    shift: 0,
    opacity: 0.8,
    edges: { smooth: true, rounding: 0.25, softnessCells: 0, outline: false },
    onFail: (error) => failures.push(error),
  });
  const input = {
    modelViewProjectionMatrix: new Float64Array(16),
    defaultProjectionData: {
      mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  } as unknown as CustomRenderMethodInput;
  return {
    field,
    gl,
    map,
    input,
    listeners,
    uploads,
    draws,
    failures,
    uniforms,
    deleted,
    vertexArray: () => vertexArray,
    repaints: () => repaints,
  };
}
