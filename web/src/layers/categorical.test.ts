import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { createHarness } from "../gpu/class-field-harness.test.ts";
import { classColors, rgbToHex } from "../render/palettes.ts";
import type { LayerContext } from "../types.ts";

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
const { createCategoricalView } = await import("./categorical.ts")
  .finally(() => viewHooks.deregister());

function viewMockModule(specifier: string) {
  switch (specifier) {
    case "../data":
      return `
        export const arrayDoc = (layer) => layer.arrays.value;
        export const readArray = async () => Float32Array.of(10, 20, 0, 10);
        export const decode = (raw) => raw;
      `;
    case "../legend":
      return [
        "globalThis.__classLegendCalls = [];",
        "export const classLegend = (...args) => {",
        "  globalThis.__classLegendCalls.push(args);",
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

const COVER_CLASSES = [
  { value: 10, label: "Trees", color: "#112233" },
  { value: 20, label: "Grass", color: "#445566" },
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
      id: layerId,
      title: "Cover",
      style: {
        kind: "categorical",
        palette: "painted",
        classes,
      },
      arrays: { value: { path: "value" } },
      grid: { bbox: [36, -2, 37, -1], nx: 2, ny: 2 },
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
    cleanup: () => globals.forEach((name, index) => {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }),
  };
}
