import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

import { Window } from "happy-dom";

import { BORDER_DISPUTED_ID, BORDER_LINE_ID, BORDER_LOW_ID } from "./layers/borders.ts";
import type { Scene } from "./types.ts";

interface PendingRead {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ReadyGate {
  promise: Promise<void>;
  resolve: () => void;
}

interface ViewRecord {
  layerId: string;
  prepareCalls: (string | null)[];
  showCalls: unknown[];
}

interface ViewTestState {
  records: ViewRecord[];
  pendingReads: Map<string, PendingRead>;
  readyGates: Map<string, ReadyGate>;
  currentTime: string | null;
  areaDocuments: Record<string, unknown>;
  createView(context: {
    layer: { id: string; time: unknown };
    map?: { addLayer: (spec: { id: string }, beforeId?: string) => void };
    slots?: { fill?: string };
  }): unknown;
}

const window = new Window({ url: "http://localhost/?scene=test" });
const previousGlobals = {
  window: (globalThis as Record<string, unknown>).window,
  document: globalThis.document,
  navigator: (globalThis as Record<string, unknown>).navigator,
  storage: (globalThis as Record<string, unknown>).localStorage,
};

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function installBrowser() {
  defineGlobal("window", window);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("localStorage", window.localStorage);
}

function removeBrowser() {
  const globals = globalThis as Record<string, unknown>;

  if (previousGlobals.window === undefined) Reflect.deleteProperty(globals, "window");
  else globals.window = previousGlobals.window;

  globals.document = previousGlobals.document;

  if (previousGlobals.navigator === undefined) Reflect.deleteProperty(globals, "navigator");
  else globals.navigator = previousGlobals.navigator;
  if (previousGlobals.storage === undefined) Reflect.deleteProperty(globals, "localStorage");
  else globals.localStorage = previousGlobals.storage;
}

function freshState(): ViewTestState {
  return {
    records: [],
    pendingReads: new Map(),
    readyGates: new Map(),
    currentTime: null,
    areaDocuments: {},
    createView(context: {
      layer: { id: string; time: unknown };
      map?: { addLayer: (spec: { id: string }, beforeId?: string) => void };
      slots?: { fill?: string };
    }) {
      const state = globalThis.viewTest as ViewTestState;
      const record: ViewRecord = { layerId: context.layer.id, prepareCalls: [], showCalls: [] };
      state.records.push(record);

      if (context.map && context.slots?.fill) {
        context.map.addLayer({ id: `${context.layer.id}-draw` }, context.slots.fill);
      }

      const loadEntry = (stepTime: string | null, signal?: AbortSignal) => {
        record.prepareCalls.push(stepTime);

        return new Promise<void>((resolve, reject) => {
          const key = `${context.layer.id}:${stepTime}`;
          state.pendingReads.set(key, { resolve, reject });
          signal?.addEventListener(
            "abort",
            () => {
              if (state.pendingReads.get(key)) {
                state.pendingReads.delete(key);

                const error = new Error("Entry preparation was cancelled");
                error.name = "AbortError";
                reject(error);
              }
            },
            { once: true },
          );
        });
      };

      const loader = {
        load(stepTime: string | null, signal?: AbortSignal) {
          return loadEntry(stepTime, signal);
        },
      };

      return {
        parts: [{ id: context.layer.id, label: context.layer.id, layerIds: [] as string[] }],
        options: [],
        time: context.layer.time,
        ready: state.readyGates.get(context.layer.id)?.promise,
        loader,
        async prepare(stepTime: string) {
          return loader.load(stepTime);
        },
        async prepareEntry(stepTime: string | null, signal?: AbortSignal) {
          if (signal?.aborted) {
            const error = new Error("Entry preparation was cancelled");
            error.name = "AbortError";
            throw error;
          }
          return loader.load(stepTime, signal);
        },
        setTime() {},
        show(draw: unknown) {
          record.showCalls.push(draw);
        },
        legend() {
          return null;
        },
        destroy() {},
      };
    },
  };
}

const viewUrl = new URL("./view.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== viewUrl) return next(specifier, context);
    if (specifier === "./api") {
      const stub =
        "export const loadAreaFeature = async (href) => globalThis.viewTest.areaDocuments[href] ?? {};";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./data") {
      const stub = "export const openStore = async () => ({});";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./map") {
      const stub =
        "export const firstSymbolId = () => undefined;"
        + "export const removeLayerAndSource = (map, id) => {"
        + " map.removeLayer(id); map.removeSource(id); };"
        + "export const showScaleBar = () => () => {};";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./layers/registry") {
      const stub =
        "export const LAYER_KINDS = new Map(["
        + "['alpha', { stack: 0, create: (context) => globalThis.viewTest.createView(context) }],"
        + "['beta', { stack: 1, create: (context) => globalThis.viewTest.createView(context) }],"
        + "['categorical', { stack: 0, create: (context) => globalThis.viewTest.createView(context) }],"
        + "['field', { stack: 1, create: (context) => globalThis.viewTest.createView(context) }]]);";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./layers/blend") {
      const stub = "export const BLEND_TITLE = 'Blend';export const createBlendView = () => null;";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./ui/scene-column") {
      const stub = "export const mountSceneColumn = () => ({ unmount() {} });";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }

    return next(specifier, context);
  },
});
const { mountScene } = await import("./view.ts");
hooks.deregister();

afterEach(async () => {
  removeBrowser();
  Reflect.deleteProperty(globalThis, "viewTest");
  await new Promise((resolve) => setImmediate(resolve));
});

function firstDataOf(mounted: ReturnType<typeof mountScene>) {
  const getTime = () => (globalThis.viewTest as ViewTestState).currentTime;
  const controller = new AbortController();
  const waiting = mounted.prepareEntry(getTime, controller.signal);

  return { waiting, cancel: () => controller.abort() };
}

test("preparation keeps its receiver and blocks the wait until its read settles", async () => {
  const { mounted } = mountTwoLayers();
  const { waiting, cancel } = firstDataOf(mounted);
  const isWaitingSettled = track(waiting);
  await settle();

  const record = recordFor("a");

  assert.deepEqual(record.prepareCalls, ["2020-01-01"]);
  assert.equal(isWaitingSettled(), false);

  readFor("a:2020-01-01").resolve();
  await waiting;

  assert.equal(isWaitingSettled(), true);

  cancel();
  mounted.unmount();
});

test("a selected later month keeps the wait after the first month settles", async () => {
  const { mounted } = mountTwoLayers();
  (globalThis.viewTest as ViewTestState).currentTime = "2020-02-01";

  const { waiting, cancel } = firstDataOf(mounted);
  const isWaitingSettled = track(waiting);
  await settle();

  const state = globalThis.viewTest as ViewTestState;
  const record = recordFor("a");

  assert.deepEqual(record.prepareCalls, ["2020-02-01"]);
  assert.equal(isWaitingSettled(), false);
  assert.equal(state.pendingReads.has("a:2020-01-01"), false);

  readFor("a:2020-02-01").resolve();
  await waiting;

  assert.equal(isWaitingSettled(), true);

  cancel();
  mounted.unmount();
});

test("a colour switch during preparation is caught by comparing the result", async () => {
  const { mounted } = mountTwoLayers();
  const { waiting, cancel } = firstDataOf(mounted);
  const staleOutcome = waiting.then(
    () => "ready",
    (error: Error) => error.name,
  );
  const first = globalThis.viewTest as ViewTestState;
  await settle();

  assert.deepEqual(recordFor("a").prepareCalls, ["2020-01-01"]);
  assert.deepEqual(recordFor("b").prepareCalls, []);

  const before = mounted.store.getSnapshot();

  mounted.store.dispatch({ kind: "choose", unit: "b", draw: "colour" });
  await settle();

  assert.notEqual(mounted.store.getSnapshot().allocation, before.allocation);
  assert.equal(first.pendingReads.has("a:2020-01-01"), true);

  cancel();

  assert.equal(await staleOutcome, "AbortError");

  const second = mounted.prepareEntry(() => first.currentTime, new AbortController().signal);
  const isSecondSettled = track(second);
  await settle();

  assert.deepEqual(recordFor("b").prepareCalls, ["2020-01-01"]);
  assert.equal(isSecondSettled(), false);

  readFor("b:2020-01-01").resolve();

  const preparation = await second;

  assert.equal(preparation.allocation, mounted.store.getSnapshot().allocation);
  assert.notEqual(preparation.allocation, before.allocation);

  mounted.unmount();
});

test("aborting a preparation rejects it and stops its reads", async () => {
  const { mounted } = mountTwoLayers();
  const { waiting, cancel } = firstDataOf(mounted);
  const outcome = waiting.then(
    () => "ready",
    (error: Error) => error.name,
  );
  await settle();

  assert.ok((globalThis.viewTest as ViewTestState).pendingReads.has("a:2020-01-01"));

  cancel();

  assert.equal(await outcome, "AbortError");
  assert.equal((globalThis.viewTest as ViewTestState).pendingReads.size, 0);

  mounted.unmount();
});

test("one failing layer rejects the preparation and aborts the other reads", async () => {
  const { mounted } = mountTwoLayers();
  mounted.store.dispatch({ kind: "choose", unit: "b", draw: "colour" });

  const { waiting, cancel } = firstDataOf(mounted);
  const outcome = waiting.then(
    () => "ready",
    (error: Error) => error.message,
  );
  await settle();

  readFor("b:2020-01-01").reject(new Error("read failed"));

  assert.equal(await outcome, "read failed");

  cancel();
  mounted.unmount();
});

test("a static-only deferred ready blocks the wait until it settles", async () => {
  const { mounted } = mountTwoLayers(false, ["a"]);
  const { waiting, cancel } = firstDataOf(mounted);
  const isWaitingSettled = track(waiting);
  await settle();

  assert.deepEqual(recordFor("a").prepareCalls, []);
  assert.equal(isWaitingSettled(), false);

  readyFor("a").resolve();
  await settle();

  assert.deepEqual(recordFor("a").prepareCalls, [null]);
  assert.equal(isWaitingSettled(), false);

  readFor("a:null").resolve();
  await waiting;

  assert.equal(isWaitingSettled(), true);

  cancel();
  mounted.unmount();
});

test("the outline layer paints the linked colour and width and hides when linked off", () => {
  const { mounted, map } = mountTwoLayers(true, [], "off:navy:2");

  assert.ok(map.layouts.includes("soe-area-outline:visibility:none"));
  assert.ok(map.paints.includes("soe-area-outline:line-color:#1a3658"));
  assert.ok(map.paints.includes("soe-area-outline:line-width:2"));

  mounted.unmount();
});

test("the outline draws only the land borders when the area is cut to land", () => {
  const outlineData = (map: ReturnType<typeof fakeMap>) =>
    (map.getSource("soe-area-outline") as { data: string }).data;

  const cut = mountTwoLayers(true, [], "", { borders_href: "borders.geojson" });
  const uncut = mountTwoLayers();

  assert.equal(outlineData(cut.map), "borders.geojson");
  assert.equal(outlineData(uncut.map), "area.geojson");

  cut.mounted.unmount();
  uncut.mounted.unmount();
});

test("a shifted scene draws both border features with their properties", async () => {
  const borders = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Test", disputed: false },
        geometry: {
          type: "LineString",
          coordinates: [
            [179, 0],
            [181, 0],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Test", disputed: true },
        geometry: {
          type: "LineString",
          coordinates: [
            [182, 1],
            [184, 1],
          ],
        },
      },
    ],
  };
  const { mounted, map } = mountTwoLayers(
    true,
    [],
    "",
    { bbox: [176, -20, 190, -15], borders_href: "borders.geojson" },
    { "borders.geojson": borders },
  );

  await settle();
  await settle();

  const data = (map.getSource("soe-area-outline") as { data: typeof borders }).data;

  assert.equal(data.type, "FeatureCollection");
  assert.equal(data.features.length, 2);
  assert.deepEqual(data.features[0].geometry.coordinates, [
    [-181, 0],
    [-179, 0],
  ]);
  assert.deepEqual(data.features[1].geometry.coordinates, [
    [-178, 1],
    [-176, 1],
  ]);
  assert.deepEqual(data.features[0].properties, { name: "Test", disputed: false });
  assert.deepEqual(data.features[1].properties, { name: "Test", disputed: true });

  mounted.unmount();
});

test("an outline display change repaints the map and remembers the choice", () => {
  const { mounted, map } = mountTwoLayers();

  mounted.store.dispatch({
    kind: "display",
    update: (next) => {
      next.outline = { shown: true, color: "white", widthPx: 3 };
    },
  });

  assert.ok(map.layouts.includes("soe-area-outline:visibility:visible"));
  assert.ok(map.paints.includes("soe-area-outline:line-color:#ffffff"));
  assert.ok(map.paints.includes("soe-area-outline:line-width:3"));
  assert.equal(
    window.localStorage.getItem("soe.outline.v1"),
    JSON.stringify({ shown: true, color: "white", widthPx: 3 }),
  );

  mounted.unmount();
});

test("an outline change repaints every border copy and keeps the fallback outline hidden", () => {
  const { mounted, map } = mountTwoLayers();

  for (const id of [BORDER_LOW_ID, BORDER_LINE_ID, BORDER_DISPUTED_ID]) {
    map.layers.set(id, { id });
  }

  mounted.store.dispatch({
    kind: "display",
    update: (next) => {
      next.outline = { shown: true, color: "white", widthPx: 2 };
    },
  });

  assert.ok(map.layouts.includes("soe-area-outline:visibility:none"));

  for (const id of [BORDER_LOW_ID, BORDER_LINE_ID, BORDER_DISPUTED_ID]) {
    assert.ok(map.layouts.includes(`${id}:visibility:visible`), id);
    assert.ok(map.paints.includes(`${id}:line-color:#ffffff`), id);
    assert.ok(map.paints.includes(`${id}:line-width:4`), id);
  }

  mounted.unmount();
});

test("scene view mounts no water copy because the scene owner adds the single inland cover", async () => {
  const { INLAND_WATER_ID } = await import("./layers/geology-water.ts");

  for (const layerIds of [["geology"], ["esa_worldcover"], ["geology", "esa_worldcover"]]) {
    const { mounted, map } = mountCategoricalLayers(layerIds);

    assert.equal(map.getLayer(INLAND_WATER_ID), undefined, layerIds.join(","));
    assert.equal(map.getLayer("soe-geology-water"), undefined, layerIds.join(","));

    mounted.unmount();
  }
});

test("scenes without categorical layers mount no water copy", () => {
  const { mounted, map } = mountTwoLayers();

  assert.equal(map.getLayer("soe-inland-water"), undefined);
  assert.equal(map.getLayer("soe-geology-water"), undefined);

  mounted.unmount();
});

test("categorical fills and climate colours mount in stack order with no water between them", async () => {
  const { mounted, map } = mountMixedLayers();
  const orderOf = () => [...map.layers.keys()];

  assert.ok(orderOf().indexOf("esa_worldcover-draw") < orderOf().indexOf("rain-draw"));
  assert.equal(map.getLayer("soe-inland-water"), undefined);
  assert.equal(map.addedSources(), 0);

  mounted.store.dispatch({ kind: "choose", unit: "rain", draw: "colour" });

  assert.ok(orderOf().indexOf("esa_worldcover-draw") < orderOf().indexOf("rain-draw"));

  mounted.store.dispatch({ kind: "choose", unit: "esa_worldcover", draw: "colour" });

  assert.ok(orderOf().indexOf("esa_worldcover-draw") < orderOf().indexOf("rain-draw"));

  mounted.unmount();

  assert.equal(map.getLayer("soe-inland-water"), undefined);
});

function mountTwoLayers(
  withTime = true,
  readyLayers: string[] = [],
  outline = "",
  areaPatch: Partial<Scene["area"]> = {},
  areaDocuments: Record<string, unknown> = {},
) {
  installBrowser();

  const state = freshState();
  state.areaDocuments = areaDocuments;

  for (const layerId of readyLayers) state.readyGates.set(layerId, deferredUnit());

  (globalThis as Record<string, unknown>).viewTest = state;

  const map = fakeMap();
  const scene = makeScene(withTime);
  Object.assign(scene.area, areaPatch);

  const mounted = mountScene(map as never, scene, {
    cards: document.createElement("div"),
    timeBar: document.createElement("div"),
    display: {
      pal: "",
      range: "",
      off: "",
      as: "",
      ink: "",
      dens: "",
      units: "",
      outline,
      charts: "",
    },
    onTime() {},
    onDisplay() {},
  });

  return { mounted, map };
}

function recordFor(layerId: string): ViewRecord {
  const state = globalThis.viewTest as ViewTestState;
  const record = state.records.find((entry) => entry.layerId === layerId);

  assert.ok(record);

  return record;
}

function readFor(key: string): PendingRead {
  const state = globalThis.viewTest as ViewTestState;
  const read = state.pendingReads.get(key);

  assert.ok(read);

  return read;
}

function readyFor(layerId: string): ReadyGate {
  const state = globalThis.viewTest as ViewTestState;
  const gate = state.readyGates.get(layerId);

  assert.ok(gate);

  return gate;
}

function deferredUnit(): ReadyGate {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });

  return { promise, resolve };
}

function track(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });

  return () => settled;
}

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function fakeMap(withWater = false) {
  const layers = new Map<string, object>();
  const sources = new Map<string, object>();
  const layouts: string[] = [];
  const paints: string[] = [];
  const addedSourceIds: string[] = [];

  return {
    layouts,
    paints,
    layers,
    addSource(id: string, source: Record<string, unknown>) {
      addedSourceIds.push(id);
      const stored: Record<string, unknown> & { setData(data: unknown): void } = {
        ...source,
        setData(data: unknown) {
          stored.data = data;
        },
      };
      sources.set(id, stored);
    },
    addedSources: () => addedSourceIds.filter((id) => id === "openmaptiles").length,
    addLayer(spec: { id: string }, _beforeId?: string) {
      layers.set(spec.id, spec);
    },
    getSource(id: string) {
      if (id === "openmaptiles") return {};
      return sources.get(id);
    },
    getLayer(id: string) {
      return layers.get(id);
    },
    removeLayer(id: string) {
      layers.delete(id);
    },
    removeSource(id: string) {
      sources.delete(id);
    },
    setLayoutProperty(id: string, name: string, value: unknown) {
      layouts.push(`${id}:${name}:${String(value)}`);
    },
    setPaintProperty(id: string, name: string, value: unknown) {
      paints.push(`${id}:${name}:${String(value)}`);
    },
    getStyle() {
      if (!withWater) return { layers: [] };
      return {
        layers: [
          {
            id: "water",
            type: "fill",
            source: "openmaptiles",
            "source-layer": "water",
            filter: ["!=", ["get", "brunnel"], "tunnel"],
            paint: { "fill-color": "rgb(158,189,255)" },
          },
        ],
      };
    },
    addControl() {},
    removeControl() {},
  };
}

function mountCategoricalLayers(layerIds: string[]) {
  installBrowser();

  const state = freshState();
  (globalThis as Record<string, unknown>).viewTest = state;

  const map = fakeMap(true);
  const scene = makeScene(false);
  scene.layers = layerIds.map((id) => ({
    id,
    title: id.toUpperCase(),
    units: "",
    source: { name: "Test", licence: "CC0", attribution: "Test" },
    style: { kind: "categorical", encodings: ["fill"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    mask: { path: "mask.zarr", cells_inside: 100 },
    time: null,
    arrays: {},
  })) as unknown as Scene["layers"];

  const mounted = mountScene(map as never, scene, {
    cards: document.createElement("div"),
    timeBar: document.createElement("div"),
    display: {
      pal: "",
      range: "",
      off: "",
      as: "",
      ink: "",
      dens: "",
      units: "",
      outline: "",
      charts: "",
    },
    onTime() {},
    onDisplay() {},
  });

  return { mounted, map };
}

function mountMixedLayers() {
  installBrowser();

  const state = freshState();
  (globalThis as Record<string, unknown>).viewTest = state;

  const map = fakeMap(true);
  const scene = makeScene(false);
  scene.layers = [
    {
      id: "esa_worldcover",
      title: "ESA_WORLDCOVER",
      units: "",
      source: { name: "Test", licence: "CC0", attribution: "Test" },
      style: { kind: "categorical", encodings: ["fill"] },
      grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
      mask: { path: "mask.zarr", cells_inside: 100 },
      time: null,
      arrays: {},
    },
    {
      id: "rain",
      title: "RAIN",
      units: "units",
      source: { name: "Test", licence: "CC0", attribution: "Test" },
      style: { kind: "field", encodings: ["ramp"] },
      grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
      mask: { path: "mask.zarr", cells_inside: 100 },
      time: null,
      arrays: {},
    },
  ] as unknown as Scene["layers"];

  const mounted = mountScene(map as never, scene, {
    cards: document.createElement("div"),
    timeBar: document.createElement("div"),
    display: {
      pal: "",
      range: "",
      off: "",
      as: "",
      ink: "",
      dens: "",
      units: "",
      outline: "",
      charts: "",
    },
    onTime() {},
    onDisplay() {},
  });

  return { mounted, map };
}

function makeScene(withTime: boolean): Scene {
  const time = withTime
    ? { step: "P1M", values: ["2020-01-01", "2020-02-01"], end: "2020-03-01", method: "mean" }
    : null;
  const layerDoc = (id: string, kind: string) => ({
    id,
    title: id.toUpperCase(),
    units: "units",
    source: { name: "Test", licence: "CC0", attribution: "Test" },
    style: { kind, encodings: ["ramp"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    mask: { path: "mask.zarr", cells_inside: 100 },
    time,
    arrays: {},
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: [1, 2],
      valid_fraction: [1, 1],
    },
  });

  return {
    id: "test",
    title: "Test scene",
    generator: { name: "soe", version: "0.9.0" },
    version: "0.8",
    area: {
      boundary: null,
      bbox: [0, -1, 1, 1],
      geometry_href: "area.geojson",
      clipped_to_coverage: false,
    },
    period: withTime ? { start: "2020-01-01", end: "2020-03-01", step: "P1M" } : null,
    layers: [layerDoc("a", "alpha"), layerDoc("b", "beta")],
    data: { href: "data.zarr" },
    notices: { limits: [] },
    credits: { lines: [], disclaimers: [], endorsement: "", terms_passthrough: "" },
  } as unknown as Scene;
}
