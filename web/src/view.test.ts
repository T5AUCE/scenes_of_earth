import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

import { Window } from "happy-dom";

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
  prepareCalls: string[];
  showCalls: unknown[];
}

interface ViewTestState {
  records: ViewRecord[];
  pendingReads: Map<string, PendingRead>;
  readyGates: Map<string, ReadyGate>;
  currentTime: string | null;
  createView(context: { layer: { id: string; time: unknown } }): unknown;
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
    createView(context: { layer: { id: string; time: unknown } }) {
      const state = globalThis.viewTest as ViewTestState;
      const record: ViewRecord = { layerId: context.layer.id, prepareCalls: [], showCalls: [] };
      state.records.push(record);
      return {
        parts: [{ id: context.layer.id, label: context.layer.id, layerIds: [] as string[] }],
        options: [],
        time: context.layer.time,
        ready: state.readyGates.get(context.layer.id)?.promise,
        loader: {
          load(stepTime: string) {
            record.prepareCalls.push(stepTime);
            return new Promise<void>((resolve, reject) => {
              state.pendingReads.set(`${context.layer.id}:${stepTime}`, { resolve, reject });
            });
          },
        },
        async prepare(stepTime: string) {
          return this.loader.load(stepTime);
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
      const stub = "export const loadAreaFeature = async () => ({});";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./data") {
      const stub = "export const openStore = async () => ({});";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./map") {
      const stub = "export const firstSymbolId = () => undefined;"
        + "export const removeLayerAndSource = (map, id) => {"
        + " map.removeLayer(id); map.removeSource(id); };"
        + "export const showScaleBar = () => () => {};";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./layers/registry") {
      const stub = "export const LAYER_KINDS = new Map(["
        + "['alpha', { stack: 0, create: (context) => globalThis.viewTest.createView(context) }],"
        + "['beta', { stack: 1, create: (context) => globalThis.viewTest.createView(context) }]]);";
      return { url: `data:text/javascript,${stub}`, shortCircuit: true };
    }
    if (specifier === "./layers/blend") {
      const stub = "export const BLEND_TITLE = 'Blend';"
        + "export const createBlendView = () => null;";
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
  const firstData = mounted.whenFirstDataReady(getTime);

  return { waiting: firstData.ready, cancel: firstData.cancel };
}

test("preparation keeps its receiver and blocks the wait until its read settles", async () => {
  const mounted = mountTwoLayers();
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
  const mounted = mountTwoLayers();
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

test("switching colour awaits the drawn layer and drops the hidden one", async () => {
  const mounted = mountTwoLayers();
  const { waiting, cancel } = firstDataOf(mounted);
  const isWaitingSettled = track(waiting);
  await settle();
  assert.deepEqual(recordFor("a").prepareCalls, ["2020-01-01"]);
  assert.deepEqual(recordFor("b").prepareCalls, []);

  mounted.store.dispatch({ kind: "choose", unit: "b", draw: "colour" });
  await settle();
  assert.deepEqual(recordFor("b").prepareCalls, ["2020-01-01"]);

  readFor("a:2020-01-01").resolve();
  await settle();
  assert.equal(isWaitingSettled(), false);

  readFor("b:2020-01-01").resolve();
  await waiting;
  assert.equal(isWaitingSettled(), true);

  mounted.store.dispatch({ kind: "choose", unit: "a", draw: "colour" });
  await settle();
  assert.deepEqual(recordFor("a").prepareCalls, ["2020-01-01"]);
  assert.deepEqual(recordFor("b").prepareCalls, ["2020-01-01"]);
  cancel();
  mounted.unmount();
});

test("a static-only deferred ready blocks the wait until it settles", async () => {
  const mounted = mountTwoLayers(false, ["a"]);
  const { waiting, cancel } = firstDataOf(mounted);
  const isWaitingSettled = track(waiting);
  await settle();
  assert.deepEqual(recordFor("a").prepareCalls, []);
  assert.equal(isWaitingSettled(), false);

  readyFor("a").resolve();
  await waiting;

  assert.equal(isWaitingSettled(), true);
  cancel();
  mounted.unmount();
});

function mountTwoLayers(withTime = true, readyLayers: string[] = []) {
  installBrowser();
  const state = freshState();
  for (const layerId of readyLayers) state.readyGates.set(layerId, deferredUnit());
  (globalThis as Record<string, unknown>).viewTest = state;
  const map = fakeMap();
  const mounted = mountScene(map as never, makeScene(withTime), {
    cards: document.createElement("div"),
    timeBar: document.createElement("div"),
    onTime() {},
    onDisplay() {},
  });

  return mounted;
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

function track(promise: Promise<void>): () => boolean {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });

  return () => settled;
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function fakeMap() {
  const layers = new Map<string, object>();
  const sources = new Map<string, object>();
  return {
    addSource(id: string, source: object) {
      sources.set(id, source);
    },
    addLayer(spec: { id: string }) {
      layers.set(spec.id, spec);
    },
    getSource(id: string) {
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
    setLayoutProperty() {},
    getStyle() {
      return { layers: [] };
    },
    addControl() {},
    removeControl() {},
  };
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
    version: "0.7",
    created: "2026-10-23T00:00:00Z",
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
