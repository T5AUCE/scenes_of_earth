import assert from "node:assert/strict";
import { registerHooks } from "node:module";

import type { Map as MapLibreMap } from "maplibre-gl";

import type { SceneRoots } from "../scene-mode";
import type { Scene } from "../types";

export const MASK_ID = "soe-scene-mask";
export const DATA_IDS = ["relief", "contours", "rain", "overview"];

export const FEATURE = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [[[33, -5], [42, -5], [42, 5], [33, 5], [33, -5]]],
  },
};
export const SCENE = {
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
  `,
  "./render/mercator": `
    export const shiftLongitudes = (coordinates) => coordinates;
    export const worldShift = () => 0;
  `,
  "./scene-camera": `
    export const flightDuration = () => 0;
    export function flyIn(map, scene, roots, onLanded) {
      const flight = globalThis.sceneModeTest.flight;
      return {
        get zoom() { return flight.zoom; },
        refit() { flight.refit(); },
        stopClamp() { flight.stopClamp(); },
        start() {
          globalThis.sceneModeTest.land = onLanded;
          flight.started = true;
          if (globalThis.sceneModeTest.landImmediately) onLanded();
        },
      };
    }
    export function watchResize(onResize) {
      globalThis.sceneModeTest.resize = onResize;
      return () => {};
    }
  `,
  "./ui/scene-panel": `
    export const PANEL_TABS = ["charts", "about", "credits"];
    export const createScenePanel = (scene, dialog, store, hooks) => {
      const test = globalThis.sceneModeTest;
      // The integrated test forwards to the real panel so the owner boundary stays real.
      if (test?.useRealPanel && test?.realCreateScenePanel) {
        return test.realCreateScenePanel(scene, dialog, store, hooks);
      }
      globalThis.sceneModeTest.panelStore = store;
      globalThis.sceneModeTest.panelHooks = hooks;
      const calls = (globalThis.sceneModeTest.panelCalls ??= []);
      const state = (globalThis.sceneModeTest.panelState ??= { open: false });
      return {
        element: {},
        setTime(time, label) {
          globalThis.sceneModeTest.times.push([time, label]);
        },
        setSyncNotice(notice) {
          (globalThis.sceneModeTest.syncNotices ??= []).push(notice);
        },
        openFull(tab, options) {
          calls.push(["open", tab, options]);
          state.open = true;
        },
        closeFull() {
          calls.push(["close"]);
          state.open = false;
        },
        get isOpen() { return state.open; },
        isEditorDirty() {
          return !!globalThis.sceneModeTest.editorDirty;
        },
        showCloseConfirm() {
          (globalThis.sceneModeTest.confirmCalls ??= []).push("confirm");
        },
        destroy() {},
      };
    };
  `,
  "./view": `
    export const OUTLINE_ID = "soe-area-outline";
    export function mountScene(map, scene, slots) {
      globalThis.sceneModeTest.onUnits = slots.onUnits;
      globalThis.sceneModeTest.onTime = slots.onTime;
      globalThis.sceneModeTest.onPlayingChange = slots.onPlayingChange;
      globalThis.sceneModeTest.onCharts = slots.onCharts;
      globalThis.sceneModeTest.onDisplay = slots.onDisplay;
      globalThis.sceneModeTest.onChartSync = slots.onChartSync;
      const layerIds = ["relief", "contours", "rain", "overview"];
      if (slots.onUnits) {
        const initial = globalThis.sceneModeTest.initialUnits ?? ["m", {}];
        slots.onUnits(initial[0], initial[1], [...layerIds]);
      }
      if (globalThis.sceneModeTest.initialCharts != null && slots.onCharts) {
        slots.onCharts(globalThis.sceneModeTest.initialCharts);
      }
      const snapshot = {
        display: {
          layers: {},
          off: new Set(),
          showAs: {},
          outline: { shown: true, color: "graphite", widthPx: 1.5 },
        },
        allocation: { owner: null, draws: new Map(), as: new Map() },
        on: new Set(),
      };
      const listeners = new Set();
      const mountStore = globalThis.sceneModeTest.mountStore ?? {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        dispatch: (action) => {
          if (action?.kind === "display" && typeof action.update === "function") {
            const next = {
              layers: { ...snapshot.display.layers },
              off: new Set(snapshot.display.off),
              showAs: { ...snapshot.display.showAs },
              outline: { ...snapshot.display.outline },
            };
            action.update(next);
            snapshot.display = next;
            for (const listener of [...listeners]) listener();
          }
        },
      };
      globalThis.sceneModeTest.mountStore = mountStore;
      mountStore.subscribe(() => {
        const outline = snapshot.display.outline;
        if (!outline) return;
        const layer = map.layers.get("soe-area-outline");
        if (!layer) return;
        layer.layout.visibility = outline.shown ? "visible" : "none";
        layer.paint ??= {};
        layer.paint["line-color"] = outline.color;
        layer.paint["line-width"] = outline.widthPx;
      });
      const requestedTime = globalThis.sceneModeTest.requestedTime;
      const timeline = requestedTime == null
        ? null
        : {
          times: ["2020-01-01", "2020-02-01"],
          goTo(time) {
            (globalThis.sceneModeTest.restoredTimes ??= []).push(time);
            // The real timeline notifies the owner, so the stub delivers the month label.
            slots.onTime?.(time, time.slice(0, 7));
          },
          move() {},
        };
      return {
        timeline,
        layerIds,
        store: mountStore,
        addNote: (note) => {
          globalThis.sceneModeTest.notes.push(note);
          return () => {
            const notes = globalThis.sceneModeTest.notes;
            const index = notes.indexOf(note);
            if (index >= 0) notes.splice(index, 1);
          };
        },
        whenEntryReady: (getTime, getGeneration) => {
          const harness = globalThis.sceneModeTest;
          const data = harness.data;
          const store = harness.mountStore;
          const preparationTime = getTime();
          (harness.preparationTimes ??= []).push(preparationTime);
          let cancelReady = () => {};
          const ready = Promise.race([
            data.promise.then(() => {
              const snapshot = store?.getSnapshot?.() ?? { allocation: null, display: null };
              return {
                time: preparationTime,
                generation: getGeneration?.() ?? 0,
                allocation: snapshot.allocation,
                display: snapshot.display,
              };
            }),
            new Promise((_, reject) => {
              cancelReady = () => {
                const error = new Error("Entry preparation was cancelled");
                error.name = "AbortError";
                reject(error);
              };
            }),
          ]);
          return {
            ready,
            cancel: () => cancelReady(),
            retarget: () => {
              harness.retargetCount = (harness.retargetCount ?? 0) + 1;
            },
          };
        },
        unmount() {
          for (const id of this.layerIds) map.removeLayer(id);
        },
      };
    }
  `,
};
const controllerUrl = new URL("../scene-mode.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== controllerUrl || !(specifier in dependencies)) {
      return next(specifier, context);
    }

    const source = dependencies[specifier as keyof typeof dependencies];
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const { createSceneMode } = await import("../scene-mode");
hooks.deregister();

let active: ReturnType<typeof createHarness> | undefined;
const originalGlobals = {
  document: globalThis.document,
  history: globalThis.history,
  getComputedStyle: globalThis.getComputedStyle,
  location: (globalThis as Record<string, unknown>).location,
};

/** Exit the active harness and restore the globals it replaced. */
export async function resetHarness(): Promise<void> {
  await exitActiveHarness();
  Object.assign(globalThis, originalGlobals);
  if (originalGlobals.location === undefined) Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "sceneModeTest");
  await new Promise((resolve) => setImmediate(resolve));
}

/** Exit the active harness while leaving globals alone for window teardown. */
export async function exitActiveHarness(): Promise<void> {
  const live = active;
  if (live === undefined) return;

  const { act } = await import("react");
  await act(async () => {
    live.mode.exit();
  });
  await act(async () => {});
  active = undefined;
}

/** Create an isolated controller harness with stubbed browser dependencies. */
export function createHarness() {
  const map = new TestMap();
  const roots = { column: element(), timeBar: element(), dialog: element() };
  const bodyClasses = new Set<string>();
  const harness = {
    map,
    roots,
    bodyClasses,
    geometry: deferred(),
    data: deferredSignal(),
    notes: [] as string[],
    times: [] as [string | null, string | null][],
    panelStore: null as unknown,
    mountStore: null as unknown,
    panelHooks: null as unknown,
    onUnits: null as ((elevation: string, units: Record<string, string>, ids: string[]) => void)
      | null,
    onTime: null as ((time: string, label: string) => void) | null,
    onPlayingChange: null as ((playing: boolean) => void) | null,
    onCharts: null as ((token: string | null) => void) | null,
    onDisplay: null as ((params: string) => void) | null,
    onChartSync: null as ((notice: string | null) => void) | null,
    initialUnits: null as [string, Record<string, string>] | null,
    initialCharts: null as string | null,
    restoredTimes: [] as string[],
    syncNotices: [] as (string | null)[],
    requestedTime: null as string | null,
    preparationTimes: [] as (string | null)[],
    retargetCount: 0,
    landImmediately: false,
    land: () => {},
    resize: () => {},
    flight: {
      zoom: 5,
      refit() {},
      stopClamp() {},
      started: false,
    },
    mode: createSceneMode(map as unknown as MapLibreMap, roots as unknown as SceneRoots),
    enter(time: string | null = null) {
      this.requestedTime = time;
      this.mode.enter(SCENE, { time, entry: "replace" });
    },
  };
  const originalEnter = harness.mode.enter.bind(harness.mode);
  harness.mode.enter = ((...args: Parameters<typeof originalEnter>) => {
    harness.requestedTime = (args[1] as { time?: string | null }).time ?? null;
    return originalEnter(...args);
  }) as typeof harness.mode.enter;
  Object.assign(globalThis, {
    sceneModeTest: harness,
    document: {
      body: {
        offsetHeight: 0,
        classList: {
          add(...names: string[]) {
            for (const name of names) bodyClasses.add(name);
          },
          remove(...names: string[]) {
            for (const name of names) bodyClasses.delete(name);
          },
          contains: (name: string) => bodyClasses.has(name),
        },
      },
      documentElement: { offsetHeight: 0, style: { setProperty() {}, removeProperty() {} } },
      createElement: element,
    },
    history: { state: null, replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "#faf8f3" }),
  });
  active = harness;

  return harness;
}

/** Create a minimal stub element for harness roots. */
export function element() {
  return {
    append() {},
    replaceChildren() {},
    hidden: false,
  };
}

/** Create a manually settled geometry promise for the harness. */
export function deferred() {
  let resolve!: (feature: typeof FEATURE) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof FEATURE>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}

/** Create a manually settled data promise for the harness. */
export function deferredSignal() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
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
  paint?: Record<string, unknown>;
  type?: string;
}

/** Minimal map double tracking zoom ranges and listeners. */

export class TestMap {
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
  readonly filters = new Map<string, unknown>();
  readonly listeners = new Map<string, Set<(event: object) => void>>();
  rangeWrites = 0;
  readyOnAdd = false;
  failMaskLayer = false;
  private maskLoaded = false;

  getCenter() { return { lng: 37, lat: 0 }; }
  getZoom() { return 5; }
  stop() {}
  getLayer(id: string) { return this.layers.get(id); }
  getSource(id: string) { return this.sources.get(id); }
  removeLayer(id: string) { this.layers.delete(id); }
  removeSource(id: string) { this.sources.delete(id); }
  moveLayer() {}
  setPaintProperty(id: string, name: string, value: unknown) {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.paint ??= {};
    layer.paint[name] = value;
  }
  getLayoutProperty(id: string, name: string) {
    if (name === "visibility") return this.layers.get(id)?.layout.visibility;
    return undefined;
  }
  setLayoutProperty(id: string, name: string, value: unknown) {
    const layer = this.layers.get(id);
    if (!layer) return;
    if (name === "visibility") {
      layer.layout ??= { visibility: "visible" };
      layer.layout.visibility = value as string;
    }
  }
  getFilter(id: string) { return this.filters.get(id); }
  setFilter(id: string, filter: unknown) {
    if (filter === null || filter === undefined) this.filters.delete(id);
    else this.filters.set(id, filter);
  }
  flyTo() {}
  setTransformRequest() {}

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
