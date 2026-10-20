import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";

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
  harness.field.setEdges({ smooth: false, rounding: 0.6, softnessPx: 1.5, outline: true });
  harness.field.layer.render(harness.gl, harness.input);

  assert.equal(harness.uploads.length, uploadCount + 1);
  assert.equal(harness.uniforms.get("uSmooth"), 0);
  assert.equal(harness.uniforms.get("uRounding"), 0.6);
  assert.equal(harness.uniforms.get("uSoftnessPx"), 1.5);
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
    edges: { smooth: true, rounding: 0.25, softnessPx: 0, outline: false },
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
