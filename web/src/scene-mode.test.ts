import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

import type { Map as MapLibreMap } from "maplibre-gl";

import type { SceneRoots } from "./scene-mode.ts";
import type { Scene } from "./types.ts";

const MASK_ID = "soe-scene-mask";
const DATA_IDS = ["relief", "contours", "rain", "overview"];
const FEATURE = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [[[33, -5], [42, -5], [42, 5], [33, 5], [33, -5]]],
  },
};
const SCENE = {
  id: "test",
  title: "Test scene",
  area: { bbox: [33, -5, 42, 5], geometry_href: "/area.geojson" },
} as Scene;

// Browser dependencies are stubbed so controller tests need neither WebGL nor network requests.
const dependencies = {
  "./api": `
    export const loadAreaFeature = () => globalThis.sceneModeTest.geometry.promise;
  `,
  "./html": `
    export function makeHtmlElement(tag, text = "", parent) {
      const element = document.createElement(tag);
      element.textContent = text;
      parent?.append(element);
      return element;
    }
  `,
  "./label-filter": `
    export const polygonParts = (type, coordinates) => [coordinates];
    export const tileAreaGeometry = (geometry) => geometry;
  `,
  "./map": `
    export const MAX_ZOOM = 24;
    export const WORLD_VIEW = { center: [0, 20], zoom: 1.5 };
    export function removeLayerAndSource(map, id) {
      map.removeLayer(id);
      map.removeSource(id);
    }
    export function moveLabelsIntoArea() {
      globalThis.sceneModeTest.labelMoves++;
      return () => {};
    }
  `,
  "./render/mercator": `
    export const shiftLongitudes = (coordinates) => coordinates;
    export const worldShift = () => 0;
  `,
  "./scene-camera": `
    export const flightDuration = () => 0;
    export function flyIn(map, scene, roots, onLanded) {
      globalThis.sceneModeTest.land = onLanded;
      if (globalThis.sceneModeTest.landImmediately) onLanded();
      return globalThis.sceneModeTest.flight;
    }
    export function watchResize(onResize) {
      globalThis.sceneModeTest.resize = onResize;
      return () => {};
    }
  `,
  "./scene-panel": `
    export const PANEL_TABS = ["about"];
    export const createScenePanel = () => ({
      element: {},
      setTimeLabel() {},
      destroy() {},
    });
  `,
  "./scene-url": `
    export const sceneUrl = () => "/?scene=test";
    export const timeForPrefix = () => null;
  `,
  "./view": `
    export const OUTLINE_ID = "soe-area-outline";
    export function mountScene(map) {
      return {
        timeline: null,
        layerIds: ["relief", "contours", "rain", "overview"],
        addNote: (note) => globalThis.sceneModeTest.notes.push(note),
        unmount() {
          for (const id of this.layerIds) map.removeLayer(id);
        },
      };
    }
  `,
};
const controllerUrl = new URL("./scene-mode.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== controllerUrl || !(specifier in dependencies)) {
      return next(specifier, context);
    }

    const source = dependencies[specifier as keyof typeof dependencies];
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const { createSceneMode } = await import("./scene-mode.ts");
hooks.deregister();

let active: ReturnType<typeof createHarness> | undefined;
const originalGlobals = {
  document: globalThis.document,
  history: globalThis.history,
  getComputedStyle: globalThis.getComputedStyle,
};

afterEach(() => {
  active?.mode.exit();
  active = undefined;
  Object.assign(globalThis, originalGlobals);
  Reflect.deleteProperty(globalThis, "sceneModeTest");
});

test("delayed geometry and mask tiles keep data hidden through landing and resize", async () => {
  const harness = createHarness();
  harness.enter();
  assertDataHidden(harness.map);
  harness.land();
  harness.resize();
  assertDataHidden(harness.map);

  harness.geometry.resolve(FEATURE);
  await settle();
  assert.ok(harness.map.getLayer(MASK_ID));
  assertDataHidden(harness.map);
  harness.map.emit("sourcedata", { sourceId: MASK_ID, isSourceLoaded: false });
  harness.map.emit("sourcedata", { sourceId: MASK_ID, isSourceLoaded: true });
  harness.map.emit("sourcedata", { sourceId: "rain", isSourceLoaded: true });
  await settle();
  assertDataHidden(harness.map);
  assert.equal(harness.labelMoves, 0);

  harness.map.finishMask();
  await settle();
  assertRanges(harness.map, [[0, 24], [6, 12], [0, 24], [1, 4]]);
  assert.equal(harness.labelMoves, 1);
  assertListenersRemoved(harness.map);
});

test("rejected geometry keeps data hidden after landing and refitting", async () => {
  const harness = createHarness();
  harness.enter();
  harness.geometry.reject(new Error("geometry unavailable"));
  await settle();
  harness.land();
  harness.resize();

  assertDataHidden(harness.map);
  assert.equal(harness.map.getLayer(MASK_ID), undefined);
  assert.deepEqual(harness.notes, ["Area outline: geometry unavailable"]);
  assertListenersRemoved(harness.map);
});

test("mask worker failure stays hidden even if later events claim readiness", async () => {
  const harness = createHarness();
  harness.enter();
  harness.geometry.resolve(FEATURE);
  await settle();
  harness.map.emit("error", { sourceId: MASK_ID, error: new Error("worker failed") });
  await settle();
  harness.map.finishMask();
  harness.land();
  harness.resize();
  await settle();

  assertDataHidden(harness.map);
  assert.deepEqual(harness.notes, ["Area mask: worker failed"]);
  assertListenersRemoved(harness.map);
});

test("mask readiness preserves own ranges and toggles through refits and landing", async () => {
  const harness = createHarness();
  harness.enter();
  harness.map.getLayer("relief")!.layout.visibility = "none";
  harness.geometry.resolve(FEATURE);
  await settle();
  harness.map.emit("error", { sourceId: "rain", error: new Error("unrelated") });
  harness.map.finishMask();
  await settle();

  assertRanges(harness.map, [[4.75, 24], [6, 12], [4.75, 24], [4, 4]]);
  assert.equal(harness.map.getLayer("relief")!.layout.visibility, "none");
  harness.flight.zoom = 8;
  harness.resize();
  assertRanges(harness.map, [[7.75, 24], [7.75, 12], [7.75, 24], [4, 4]]);
  harness.map.getLayer("rain")!.layout.visibility = "none";
  harness.land();
  assertRanges(harness.map, [[0, 24], [6, 12], [0, 24], [1, 4]]);
  assert.equal(harness.map.getLayer("relief")!.layout.visibility, "none");
  assert.equal(harness.map.getLayer("rain")!.layout.visibility, "none");
  assert.deepEqual(harness.notes, []);
});

test("an already loaded mask restores ranges without another source event", async () => {
  const harness = createHarness();
  harness.map.readyOnAdd = true;
  harness.enter();
  harness.geometry.resolve(FEATURE);
  await settle();

  assertRanges(harness.map, [[4.75, 24], [6, 12], [4.75, 24], [4, 4]]);
  assertListenersRemoved(harness.map);
});

test("a synchronous landing cannot bypass pending mask readiness", async () => {
  const harness = createHarness();
  harness.landImmediately = true;
  harness.enter();
  assertDataHidden(harness.map);
  harness.geometry.resolve(FEATURE);
  await settle();
  assertDataHidden(harness.map);
  harness.map.finishMask();
  await settle();

  assertRanges(harness.map, [[0, 24], [6, 12], [0, 24], [1, 4]]);
});

test("closing during geometry loading ignores late completion", async () => {
  const harness = createHarness();
  harness.enter();
  harness.mode.exit();
  const writes = harness.map.rangeWrites;
  harness.geometry.resolve(FEATURE);
  await settle();

  assert.equal(harness.map.getSource(MASK_ID), undefined);
  assert.equal(harness.map.rangeWrites, writes);
  assert.deepEqual(harness.notes, []);
  assertListenersRemoved(harness.map);
});

test("closing during mask loading cancels listeners and ignores stale readiness", async () => {
  const harness = createHarness();
  harness.enter();
  harness.geometry.resolve(FEATURE);
  await settle();
  assert.equal(harness.map.listeners.get("sourcedata")!.size, 1);
  harness.mode.exit();
  const writes = harness.map.rangeWrites;
  harness.map.finishMask();
  await settle();

  assert.equal(harness.map.rangeWrites, writes);
  assert.deepEqual(harness.notes, []);
  assertListenersRemoved(harness.map);
});

test("closing just after mask readiness cannot reveal disposed layers", async () => {
  const harness = createHarness();
  harness.enter();
  harness.geometry.resolve(FEATURE);
  await settle();
  harness.map.finishMask();
  harness.mode.exit();
  const writes = harness.map.rangeWrites;
  await settle();

  assert.equal(harness.map.rangeWrites, writes);
  assert.equal(harness.labelMoves, 0);
  assert.deepEqual(harness.notes, []);
  assertListenersRemoved(harness.map);
});

test("synchronous mask setup failure leaves data hidden and removes listeners", async () => {
  const harness = createHarness();
  harness.map.failMaskLayer = true;
  harness.enter();
  harness.geometry.resolve(FEATURE);
  await settle();
  harness.land();
  harness.resize();

  assertDataHidden(harness.map);
  assert.deepEqual(harness.notes, ["mask setup failed"]);
  assertListenersRemoved(harness.map);
});

function createHarness() {
  const map = new TestMap();
  const roots = { column: element(), timeBar: element(), dialog: element() };
  const harness = {
    map,
    geometry: deferred(),
    notes: [] as string[],
    labelMoves: 0,
    landImmediately: false,
    land: () => {},
    resize: () => {},
    flight: { zoom: 5, refit() {}, stopClamp() {} },
    mode: createSceneMode(map as unknown as MapLibreMap, roots as unknown as SceneRoots),
    enter() { this.mode.enter(SCENE, { time: null, entry: "replace" }); },
  };
  Object.assign(globalThis, {
    sceneModeTest: harness,
    document: { body: { classList: { add() {}, remove() {} } }, createElement: element },
    history: { state: null, replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "#faf8f3" }),
  });
  active = harness;
  return harness;
}

function element() {
  return { append() {}, replaceChildren() {}, hidden: false };
}

function deferred() {
  let resolve!: (feature: typeof FEATURE) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof FEATURE>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface TestLayer {
  id: string;
  minzoom?: number;
  maxzoom?: number;
  layout: { visibility: string };
}

class TestMap {
  readonly layers = new Map<string, TestLayer>([
    ["relief", { id: "relief", layout: { visibility: "visible" } }],
    [
      "contours",
      {
        id: "contours",
        minzoom: 6,
        maxzoom: 12,
        layout: { visibility: "visible" },
      },
    ],
    ["rain", { id: "rain", minzoom: 0, maxzoom: 24, layout: { visibility: "visible" } }],
    ["overview", { id: "overview", minzoom: 1, maxzoom: 4, layout: { visibility: "visible" } }],
  ]);
  readonly sources = new Map<string, object>();
  readonly listeners = new Map<string, Set<(event: object) => void>>();
  rangeWrites = 0;
  readyOnAdd = false;
  failMaskLayer = false;
  private maskLoaded = false;

  getCenter() { return { lng: 37, lat: 0 }; }
  getZoom() { return 5; }
  getLayer(id: string) { return this.layers.get(id); }
  getSource(id: string) { return this.sources.get(id); }
  removeLayer(id: string) { this.layers.delete(id); }
  removeSource(id: string) { this.sources.delete(id); }
  moveLayer() {}
  setPaintProperty() {}
  flyTo() {}

  addSource(id: string, source: object) {
    this.sources.set(id, source);
    this.maskLoaded = this.readyOnAdd;
  }

  addLayer(layer: TestLayer) {
    if (this.failMaskLayer) throw new Error("mask setup failed");

    this.layers.set(layer.id, layer);
  }

  setLayerZoomRange(id: string, minzoom: number, maxzoom: number) {
    assert.ok(minzoom <= maxzoom);
    Object.assign(this.layers.get(id)!, { minzoom, maxzoom });
    this.rangeWrites++;
  }

  isSourceLoaded(id: string) {
    return this.sources.has(id) && this.maskLoaded;
  }

  finishMask() {
    this.maskLoaded = true;
    this.emit("sourcedata", { sourceId: MASK_ID, isSourceLoaded: true });
  }

  on(type: string, listener: (event: object) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  off(type: string, listener: (event: object) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: object) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function assertDataHidden(map: TestMap) {
  for (const id of DATA_IDS) {
    const layer = map.getLayer(id)!;
    assert.equal(layer.minzoom, layer.maxzoom, `${id} must have an empty zoom range`);
  }
}

function assertRanges(map: TestMap, expected: number[][]) {
  const actual = DATA_IDS.map((id) => {
    const layer = map.getLayer(id)!;
    return [layer.minzoom, layer.maxzoom];
  });
  assert.deepEqual(actual, expected);
}

function assertListenersRemoved(map: TestMap) {
  assert.equal(map.listeners.get("sourcedata")?.size ?? 0, 0);
  assert.equal(map.listeners.get("error")?.size ?? 0, 0);
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
