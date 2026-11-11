import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { createHarness } from "../gpu/class-field-harness.test.ts";
import {
  CLASS_HATCH_ID,
  homogeneousFlags,
  markThinCells,
  sampleClassField,
  THIN_CELL_FLAG,
} from "../gpu/class-field-shaders.ts";
import { GEOLOGY_SMOOTH_RADIUS_CELLS } from "../display-state.ts";
import { classColors, rgbToHex } from "../render/palettes.ts";
import { smoothClassIds } from "../render/smooth-classes.ts";
import type { Bbox, LayerContext } from "../types.ts";

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
const categoricalModule = await import("./categorical.ts");
await import("./categorical-image.ts").finally(() => viewHooks.deregister());
const { createCategoricalView, coastalFillRadiusCells, fillCoastalGaps, unhatchIds } =
  categoricalModule;

function viewMockModule(specifier: string) {
  switch (specifier) {
    case "../data":
      return `
        export const arrayDoc = (layer) => layer.arrays.value;
        export const readArray = async () => Float32Array.of(10, 20, 0, 10);
        export const decode = (raw) => raw;
        export const decodeInSlices = async (raw) => raw;
        export const isCancel = (error) => error?.name === "AbortError";
        export const yieldToBrowser = async () => {};
        export const readMask = async () => globalThis.__mask ?? Uint8Array.of(1, 1, 0, 1);
      `;
    case "../legend":
      return [
        "globalThis.__classLegendCalls = [];",
        "globalThis.__noDataLegendCalls = [];",
        "export const classLegend = (...args) => {",
        "  globalThis.__classLegendCalls.push(args);",
        "  return { append: () => {} };",
        "};",
        "export const classNoDataLegend = (...args) => {",
        "  globalThis.__noDataLegendCalls.push(args);",
        "  return {};",
        "};",
      ].join("\n");
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
        export const warmHiddenRaster = async () => {};
      `;
    default:
      return null;
  }
}

test("categorical fallback keeps layer order and mask zoom gates when a shader fails", async () => {
  const harness = createViewHarness(false);
  try {
    const view = createCategoricalView(harness.context);
    const map = harness.map;
    map.setLayoutProperty("cover-classes", "visibility", "none");
    map.setLayerZoomRange("cover-classes", 8, 22);
    map.addLayer({ id: "field", type: "raster" }, "outline");
    await view.ready;
    const field = harness.custom.get("cover-classes")!;
    field.render(harness.gpu.gl, harness.gpu.input);
    await Promise.resolve();

    assert.equal(map.getLayer("cover-classes")?.type, "custom");
    assert.equal(harness.gpu.failures.length, 0);
    map.setLayoutProperty("cover-classes", "visibility", "visible");
    field.render(harness.gpu.gl, harness.gpu.input);
    map.setLayoutProperty("cover-classes", "visibility", "none");
    await Promise.resolve();

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

test("categorical restoration applies a hide requested while the layer is removed", async () => {
  const harness = createViewHarness(true);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;
    const map = harness.map;
    map.setLayerZoomRange("cover-classes", 7, 22);
    harness.capture.get("webglcontextlost")!();
    view.show(null);
    harness.capture.get("webglcontextrestored")!();

    assert.equal(map.getLayer("cover-classes")?.minzoom, 7);
    assert.equal(map.getLayer("cover-classes")?.maxzoom, 22);
    assert.equal(map.getLayoutProperty("cover-classes", "visibility"), "none");
    view.destroy();
  } finally {
    harness.cleanup();
  }
});

test("the geology menu previews GLiM family shades instead of value colours", async () => {
  const harness = createViewHarness(true, undefined, "geology", GLIM_LIKE_CLASSES);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;
    const painted = view.menu?.palettes.find(({ name }) => name === "painted");
    const expected = classColors("geology", GLIM_LIKE_CLASSES, "painted");

    assert.deepEqual(
      painted?.colors,
      GLIM_LIKE_CLASSES.map(({ value }) => rgbToHex(expected.get(value)!)),
    );
    assert.notEqual(painted?.colors[0], "#e7a1b0");
  } finally {
    harness.cleanup();
  }
});

test("the geology age menu offers painted colours before the ICS colours of the bundle", async () => {
  const harness = createViewHarness(true, undefined, "geology_age", AGE_LIKE_CLASSES);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;

    assert.deepEqual(view.menu?.palettes, [
      { name: "painted", label: "Painted", colors: ["#f4efb6", "#9fc079"] },
      { name: "esa", label: "ICS colours", colors: ["#f9f97f", "#7fc64e"] },
    ]);
  } finally {
    harness.cleanup();
  }
});

test("geology layers offer Edge smoothing at the geology default", async () => {
  for (const layerId of ["geology", "geology_age"]) {
    const harness = createViewHarness(true, undefined, layerId, GLIM_LIKE_CLASSES);
    try {
      const view = createCategoricalView(harness.context);
      await view.ready;
      const smoothing = view.menu?.edges?.controls.find(
        (control) => control.label === "Smoothing",
      );

      assert.ok(smoothing, layerId);
      assert.equal(smoothing.value, GEOLOGY_SMOOTH_RADIUS_CELLS);

      smoothing.set(0.5);
      assert.equal(smoothing.value, 0.5);
      assert.equal(view.menu?.edges?.isDefault, false);

      view.menu?.edges?.reset();
      assert.equal(smoothing.value, GEOLOGY_SMOOTH_RADIUS_CELLS);
      assert.equal(view.menu?.edges?.isDefault, true);
      view.destroy();
    } finally {
      harness.cleanup();
    }
  }
});

test("geology Edge smoothing menu reaches the fragment shader for both ids", async () => {
  for (const layerId of ["geology", "geology_age"]) {
    const harness = createViewHarness(true, undefined, layerId, GLIM_LIKE_CLASSES);
    try {
      const view = createCategoricalView(harness.context);
      await view.ready;
      const smoothing = view.menu?.edges?.controls.find(
        (control) => control.label === "Smoothing",
      );
      const layer = harness.custom.get(`${layerId}-classes`)!;

      assert.ok(smoothing, layerId);
      layer.render!(harness.gpu.gl, harness.gpu.input);
      assert.equal(harness.gpu.uniforms.get("uSmoothRadiusCells"), GEOLOGY_SMOOTH_RADIUS_CELLS);

      smoothing.set(0.5);
      layer.render!(harness.gpu.gl, harness.gpu.input);
      assert.equal(harness.gpu.uniforms.get("uSmoothRadiusCells"), 0.5);

      view.menu?.edges?.reset();
      layer.render!(harness.gpu.gl, harness.gpu.input);
      assert.equal(harness.gpu.uniforms.get("uSmoothRadiusCells"), GEOLOGY_SMOOTH_RADIUS_CELLS);
      view.destroy();
    } finally {
      harness.cleanup();
    }
  }
});

test("land cover keeps only Rounding and softness with a default edge menu", async () => {
  const harness = createViewHarness(true);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;
    const labels = view.menu?.edges?.controls.map((control) => control.label) ?? [];

    assert.deepEqual(labels, ["Smoothing", "Softness"]);
    assert.equal(view.menu?.edges?.isDefault, true);
    view.destroy();
  } finally {
    harness.cleanup();
  }
});

test("geology layers offer softness and smoothing without Rounding", async () => {
  for (const layerId of ["geology", "geology_age"]) {
    const harness = createViewHarness(true, undefined, layerId, GLIM_LIKE_CLASSES);
    try {
      const view = createCategoricalView(harness.context);
      await view.ready;
      const labels = view.menu?.edges?.controls.map((control) => control.label) ?? [];

      assert.deepEqual(labels, ["Softness", "Smoothing"], layerId);
      view.destroy();
    } finally {
      harness.cleanup();
    }
  }
});

test("a repaint keeps the legend groups the viewer expanded", async () => {
  const harness = createViewHarness(true);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;
    const expanded = legendCalls().at(-1)?.[3] as Set<string> | undefined;

    assert.ok(expanded instanceof Set);
    expanded.add("Sediments");
    const repaintedCount = legendCalls().length;
    view.show("colour");
    const repainted = legendCalls().slice(repaintedCount);

    assert.equal(repainted.length, 1);
    assert.ok(repainted[0][3] === expanded);
    assert.ok((repainted[0][3] as Set<string>).has("Sediments"));
  } finally {
    harness.cleanup();
  }
});

test("categorical restoration keeps the fill slot while removed", async () => {
  const harness = createViewHarness(true, { fill: "fill-anchor", lines: "line-anchor" });
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;
    const map = harness.map;
    harness.capture.get("webglcontextlost")!();
    view.show("colour");
    harness.capture.get("webglcontextrestored")!();

    assert.deepEqual(map.getLayersOrder(), [
      "cover-classes",
      "fill-anchor",
      "line-anchor",
      "outline",
    ]);
    assert.equal(map.getLayoutProperty("cover-classes", "visibility"), "visible");
    view.destroy();
  } finally {
    harness.cleanup();
  }
});

test("in-area no-data adds a Hatched: no data legend row on the GPU path", async () => {
  (globalThis as { __mask?: Uint8Array }).__mask = Uint8Array.of(1, 1, 1, 1);
  (globalThis as { __noDataLegendCalls?: unknown[] }).__noDataLegendCalls = [];
  const harness = createViewHarness(true);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;

    assert.equal(noDataLegendCalls().length, 1);
    view.destroy();
  } finally {
    harness.cleanup();
    Reflect.deleteProperty(globalThis, "__mask");
  }
});

test("outside no-data adds no Hatched: no data legend row", async () => {
  (globalThis as { __noDataLegendCalls?: unknown[] }).__noDataLegendCalls = [];
  const harness = createViewHarness(true);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;

    assert.equal(noDataLegendCalls().length, 0);
    view.destroy();
  } finally {
    harness.cleanup();
  }
});

test("the image fallback shows no legend row while no-data stays transparent", async () => {
  (globalThis as { __mask?: Uint8Array }).__mask = Uint8Array.of(1, 1, 1, 1);
  (globalThis as { __noDataLegendCalls?: unknown[] }).__noDataLegendCalls = [];
  const harness = createViewHarness(false);
  try {
    const view = createCategoricalView(harness.context);
    await view.ready;
    harness.custom.get("cover-classes")!.render(harness.gpu.gl, harness.gpu.input);
    const gpuHatchCalls = noDataLegendCalls().length;
    await Promise.resolve();

    assert.equal(harness.body.dataset.landcoverRenderer, "image");
    assert.equal(noDataLegendCalls().length, gpuHatchCalls);
    assert.ok(harness.map.image);
    view.destroy();
  } finally {
    harness.cleanup();
    Reflect.deleteProperty(globalThis, "__mask");
  }
});

test("a no-data neighbour does not distort a class edge in the image fallback", () => {
  const raw = Uint8Array.of(1, 2, CLASS_HATCH_ID, 1);
  const painted = unhatchIds(raw);

  assert.deepEqual([...painted], [1, 2, 0, 1]);
  assert.ok(!painted.includes(CLASS_HATCH_ID));

  const grid = { bbox: [36, -2, 37, -1] as Bbox, nx: 2, ny: 2 };
  const size = { width: 2, height: 2 };
  const smoothed = smoothClassIds(painted, grid, size, 64);
  const eroded = smoothClassIds(raw, grid, size, 64);

  assert.ok(!smoothed.ids.includes(CLASS_HATCH_ID));
  assert.equal(smoothed.ids[35], 0);
  assert.equal(eroded.ids[35], 1);
});

test("the coastal fill is about two kilometres with a one-cell floor", () => {
  assert.equal(coastalFillRadiusCells(1 / 480), 9);
  assert.equal(coastalFillRadiusCells(1 / 120), 2);
  assert.equal(coastalFillRadiusCells(1 / 120, 60), 3);
  assert.equal(coastalFillRadiusCells(0.1), 1);
  assert.equal(coastalFillRadiusCells(NaN), 1);
});

test("the coastal fill stops at its radius and stays discrete", () => {
  const nx = 7;
  const ny = 1;
  const ids = Uint8Array.of(1, 255, 255, 255, 255, 255, 2);
  const mask = new Uint8Array(nx * ny).fill(1);
  const filled = fillCoastalGaps(ids, mask, nx, ny, 2);

  assert.deepEqual([...filled], [1, 1, 1, 255, 2, 2, 2]);
  assert.ok([...filled].every((id) => [1, 2, CLASS_HATCH_ID].includes(id)));
  assert.deepEqual([...ids], [1, 255, 255, 255, 255, 255, 2]);
});

test("coastal ties go to the smallest id and outside cells stay outside", () => {
  const ids = Uint8Array.of(2, CLASS_HATCH_ID, 1, 0);
  const mask = Uint8Array.of(1, 1, 1, 0);
  const first = fillCoastalGaps(ids, mask, 4, 1, 1);
  const second = fillCoastalGaps(ids, mask, 4, 1, 1);

  assert.deepEqual([...first], [2, 1, 1, 0]);
  assert.deepEqual([...second], [...first]);
});

test("the coastal fill measures a circular distance so diagonals stay hatched", () => {
  const ids = new Uint8Array(25).fill(CLASS_HATCH_ID);
  ids[0] = 1;
  const mask = new Uint8Array(25).fill(1);
  const filled = fillCoastalGaps(ids, mask, 5, 5, 2);

  assert.equal(filled[2], 1);
  assert.equal(filled[6], 1);
  assert.equal(filled[12], CLASS_HATCH_ID);
});

test("the coastal fill picks the nearer source across unequal distances", () => {
  const ids = new Uint8Array(16).fill(CLASS_HATCH_ID);
  ids[0] = 1;
  ids[3] = 2;
  const mask = new Uint8Array(16).fill(1);
  const filled = fillCoastalGaps(ids, mask, 4, 4, 5);

  assert.equal(filled[15], 2);
  assert.equal(filled[12], 1);
});

test("invalid coastal dimensions fall back to metre cells for window and distance", () => {
  const ids = Uint8Array.of(1, CLASS_HATCH_ID);
  const mask = Uint8Array.of(1, 1);
  const filled = fillCoastalGaps(ids, mask, 2, 1, 1, NaN, NaN);

  assert.deepEqual([...filled], [1, 1]);
});

test("geology fill hides a coastal hatch while land cover keeps it", async () => {
  (globalThis as { __mask?: Uint8Array }).__mask = Uint8Array.of(1, 1, 1, 1);
  (globalThis as { __noDataLegendCalls?: unknown[] }).__noDataLegendCalls = [];
  const geologyHarness = createViewHarness(true, undefined, "geology", COVER_CLASSES);
  try {
    const view = createCategoricalView(geologyHarness.context);
    await view.ready;

    assert.equal(noDataLegendCalls().length, 0);
    view.destroy();
  } finally {
    geologyHarness.cleanup();
  }
  (globalThis as { __noDataLegendCalls?: unknown[] }).__noDataLegendCalls = [];
  const coverHarness = createViewHarness(true, undefined, "cover", COVER_CLASSES);
  try {
    const view = createCategoricalView(coverHarness.context);
    await view.ready;

    assert.equal(noDataLegendCalls().length, 1);
    view.destroy();
  } finally {
    coverHarness.cleanup();
    Reflect.deleteProperty(globalThis, "__mask");
  }
});

const SMALL_PATCHES: Record<string, (column: number, row: number) => number> = {
  island: (column, row) => (column === 3 && row === 3 ? 2 : 1),
  pair: (column, row) => (column >= 2 && column < 4 && row >= 2 && row < 4 ? 2 : 1),
  strip: (column) => (column === 3 ? 2 : 1),
  oddIsland: (column, row) => (column === 4 && row === 2 ? 2 : 1),
};

test("the image fallback and the GPU field both keep small patches at their cell centres", () => {
  const grid = { bbox: [0, 0, 7, 7] as Bbox, nx: 7, ny: 7 };
  for (const [name, patch] of Object.entries(SMALL_PATCHES)) {
    const cells = new Uint8Array(49);
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 7; column++) cells[row * 7 + column] = patch(column, row);
    }
    const raster = smoothClassIds(cells, grid, { width: 7, height: 7 }, 64);
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 7; column++) {
        const centreColumn = Math.floor(((column + 0.5) * raster.width) / grid.nx);
        const centreRow = Math.floor(((row + 0.5) * raster.height) / grid.ny);
        const expected = cells[row * 7 + column];
        assert.equal(raster.ids[centreRow * raster.width + centreColumn], expected, `cpu ${name}`);
        assert.equal(gpuWinnerAt(cells, column, row, GEOLOGY_SMOOTH_RADIUS_CELLS), expected, name);
      }
    }
  }
});

test("the image fallback keeps a straight edge where bilinear selection put it", () => {
  const grid = { bbox: [0, 0, 8, 4] as Bbox, nx: 8, ny: 4 };
  const cells = new Uint8Array(32);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 8; column++) cells[row * 8 + column] = column < 4 ? 1 : 2;
  }
  const raster = smoothClassIds(cells, grid, { width: 8, height: 4 }, 64);
  const firstRow = [...raster.ids.subarray(0, raster.width)];
  const edge = firstRow.indexOf(2);
  assert.equal(edge, raster.width / 2);
  assert.ok(firstRow.slice(0, edge).every((id) => id === 1));
  assert.ok(firstRow.slice(edge).every((id) => id === 2));
});

/** The class that the GPU field mirror paints at a cell centre of a padded grid. */
function gpuWinnerAt(cells: Uint8Array, column: number, row: number, radius: number): number {
  const size = 7;
  const flags = homogeneousFlags(cells, size, size, radius);
  markThinCells(cells, size, size, flags);
  const clamp = (value: number) => Math.min(size - 1, Math.max(0, value));
  const sample = (cellX: number, cellY: number) => cells[clamp(cellY) * size + clamp(cellX)];
  const thinAt = (cellX: number, cellY: number) => (
    flags[clamp(cellY) * size + clamp(cellX)] === THIN_CELL_FLAG
  );
  const ids = [-1, 0, 1, 2].map((rowOffset) => (
    [-1, 0, 1, 2].map((columnOffset) => sample(column + columnOffset, row + rowOffset))
  ));
  const result = sampleClassField(
    {
      ids,
      fraction: [0, 0],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
      position: [column, row],
      sampleId: sample,
      homogeneous: flags[row * size + column] === 1,
      thin: [
        [thinAt(column, row), thinAt(column + 1, row)],
        [thinAt(column, row + 1), thinAt(column + 1, row + 1)],
      ],
    },
    { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: radius },
  );
  return result.weights.reduce((best, entry) => (entry.weight > best.weight ? entry : best)).id;
}

const COVER_CLASSES = [
  { value: 10, label: "Trees", color: "#112233" },
  { value: 20, label: "Grass", color: "#445566" },
];

const AGE_LIKE_CLASSES = [
  { value: 1, label: "Quaternary", color: "#f9f97f", group: "Cenozoic" },
  { value: 5, label: "Cretaceous", color: "#7fc64e", group: "Mesozoic" },
];

const GLIM_LIKE_CLASSES = [
  { value: 1, label: "Sediment, mixed", color: "#fdf0a8", parent: "su", variant: 0 },
  { value: 6, label: "Sediment, alluvial", color: "#fdf0a8", parent: "su", variant: 5 },
  { value: 11, label: "Siliciclastic, mixed", color: "#e8c33c", parent: "ss", variant: 0 },
];

function legendCalls(): unknown[][] {
  const calls = (globalThis as { __classLegendCalls?: unknown[][] }).__classLegendCalls;
  return calls ?? [];
}

function noDataLegendCalls(): unknown[][] {
  const calls = (globalThis as { __noDataLegendCalls?: unknown[][] }).__noDataLegendCalls;
  return calls ?? [];
}

function createViewHarness(
  compile: boolean,
  slots?: { fill?: string; lines?: string },
  layerId = "cover",
  classes = COVER_CLASSES,
) {
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
  const layers: { id: string; type: string; minzoom?: number; maxzoom?: number }[] = slots
    ? [
        { id: slots.fill ?? "fill-anchor", type: "line" },
        { id: slots.lines ?? "line-anchor", type: "line" },
        { id: "outline", type: "line" },
      ]
    : [{ id: "outline", type: "line" }];
  const visibility = new Map<string, string>();
  const custom = new Map<string, typeof gpu.field.layer>();
  const gpuMap = { ...gpu.map, getLayoutProperty: (id: string) => visibility.get(id) };
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
    moveLayer: (id: string, beforeId: string) => {
      const [layer] = layers.splice(layers.findIndex((entry) => entry.id === id), 1);
      const index = layers.findIndex((entry) => entry.id === beforeId);
      layers.splice(index, 0, layer);
    },
    addLayer: (layer: { id: string; type: string }, beforeId?: string) => {
      const index = beforeId ? layers.findIndex(({ id }) => id === beforeId) : layers.length;
      layers.splice(index, 0, { id: layer.id, type: layer.type });
      if (layer.type !== "custom") return;

      const field = layer as typeof gpu.field.layer;
      custom.set(layer.id, field);
      field.onAdd!(gpuMap as typeof gpu.map, gpu.gl);
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
      id: layerId,
      title: "Cover",
      style: {
        kind: "categorical",
        palette: "painted",
        classes,
      },
      arrays: { value: { path: "value" } },
      grid: { bbox: [36, -2, 37, -1], nx: 2, ny: 2, res: 0.5 },
    },
    slots: { fill: "outline", shade: "outline", marks: "outline", lines: "outline", ...slots },
    shift: 0,
    beforeId: "outline",
    report: (error: unknown) => {
      throw error;
    },
  } as unknown as LayerContext;
  return {
    context,
    map,
    body,
    capture,
    gpu,
    custom,
    cleanup: () => globals.forEach((name, index) => {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }),
  };
}
