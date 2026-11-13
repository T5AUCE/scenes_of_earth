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
    export function flyIn() {
      const test = globalThis.sceneModeTest;
      const flight = test.flight;
      return {
        get zoom() { return flight.zoom; },
        get durationMs() { return flight.durationMs; },
        refit() {
          flight.refits += 1;
          if ((flight.isLanded || flight.relanding) && flight.holds === 0) {
            flight.isLanded = false;
            if (!flight.relanding) {
              flight.relanding = new Promise((resolve) => {
                flight.finishRelanding = resolve;
              });
            }
            test.land = () => {
              flight.isLanded = true;
              test.events.push("land");
              const finish = flight.finishRelanding;
              flight.relanding = null;
              flight.finishRelanding = null;
              finish?.();
            };
          }
        },
        stop() { flight.isStopped = true; },
        settled() { return flight.relanding ?? Promise.resolve(); },
        hold() {
          test.events.push("hold");
          flight.holds += 1;
        },
        start() {
          test.events.push("fly");
          flight.isStarted = true;
          flight.isLanded = false;
          flight.relanding = null;
          flight.finishRelanding = null;
          return new Promise((resolve) => {
            test.land = () => {
              flight.isLanded = true;
              flight.relanding = null;
              flight.finishRelanding = null;
              test.events.push("land");
              resolve();
            };
            if (test.landImmediately) test.land();
          });
        },
      };
    }
    export function watchResize(onResize) {
      globalThis.sceneModeTest.resize = onResize;
      return () => {};
    }
  `,
  "./entry-curtain": `
    export const nextEntryFrame = () => Promise.resolve();
    // Mirrors the real reveal window so stubbed entries time the UI the same way.
    export const REVEAL_MS = 650;
    export function revealUnderCurtain(map, stage, onFadeStart, onFadeEnd) {
      const test = globalThis.sceneModeTest;
      let finishDone;
      const done = new Promise((resolve) => { finishDone = resolve; });
      const curtain = {
        isCovered: false,
        isFading: false,
        isCancelled: false,
        isRetired: false,
        // The real curtain stages inside the map's render event.
        cover() {
          if (curtain.isCovered || curtain.isRetired) return;
          curtain.isCovered = true;
          test.events.push("cover");
          stage();
        },
        fade() {
          if (curtain.isFading || curtain.isRetired) return;
          curtain.isFading = true;
          test.events.push("fade");
          onFadeStart();
          test.atFade = test.snapshotFade();
        },
        finish() {
          if (curtain.isFading && !curtain.isRetired) {
            test.events.push("end");
            onFadeEnd();
          }
          finishDone();
        },
        retire() {
          if (curtain.isRetired) return;
          curtain.isRetired = true;
          curtain.finish();
        },
      };
      test.events.push("curtain");
      test.curtain = curtain;
      if (test.autoReveal) {
        curtain.cover();
        curtain.fade();
        curtain.finish();
      }
      return {
        done,
        cancel() {
          curtain.isCancelled = true;
          curtain.cover();
          curtain.fade();
          curtain.finish();
        },
        retire() {
          curtain.retire();
        },
      };
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
      globalThis.sceneModeTest.onMount?.();
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
        prepareEntry: (getTime, signal) => {
          const harness = globalThis.sceneModeTest;
          const store = harness.mountStore;
          const preparationTime = getTime();
          (harness.preparationTimes ??= []).push(preparationTime);
          const aborted = new Promise((_, reject) => {
            const cancel = () => {
              const error = new Error("Entry preparation was cancelled");
              error.name = "AbortError";
              reject(error);
            };
            if (signal.aborted) cancel();
            else signal.addEventListener("abort", cancel, { once: true });
          });
          return Promise.race([
            harness.data.promise.then(() => {
              // The real layers fill their legends from decoded data before entry is ready.
              harness.legendsReady = true;
              const snapshot = store?.getSnapshot?.() ?? { allocation: null, display: null };
              return {
                time: preparationTime,
                allocation: snapshot.allocation,
                display: snapshot.display,
              };
            }),
            aborted,
          ]);
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
  const bodyListeners = new Map<string, Set<(event: object) => void>>();
  const harness = {
    map,
    roots,
    bodyClasses,
    bodyListeners,
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
    // The order in which the entry phases happened, so tests can assert it.
    events: [] as string[],
    // Every class the body ever received, so tests can prove the scene UI never showed.
    classLog: [] as string[],
    legendsReady: false,
    // The state at the moment the fade started, which is when the scene UI slides in.
    atFade: null as null | {
      legendsReady: boolean;
      classes: string[];
      styleWrites: [string, string][];
    },
    snapshotFade() {
      return {
        legendsReady: harness.legendsReady,
        classes: [...bodyClasses],
        styleWrites: [...harness.styleWrites],
      };
    },
    statuses: [] as string[],
    styleWrites: [] as [string, string][],
    inertPanel: false,
    busyPanel: false,
    // Both default on so most tests see a finished entry; phase tests switch them off.
    landImmediately: true,
    autoReveal: true,
    land: () => {},
    resize: () => {},
    curtain: null as null | {
      isCovered: boolean;
      isFading: boolean;
      isCancelled: boolean;
      cover(): void;
      fade(): void;
      finish(): void;
    },
    flight: {
      zoom: 5,
      durationMs: 1200,
      refits: 0,
      holds: 0,
      isStarted: false,
      isStopped: false,
      isLanded: false,
      relanding: null as Promise<void> | null,
    },
    buildPanel: {
      showStatus(text: string) {
        harness.statuses.push(text);
      },
      setBusy(isBusy: boolean) {
        harness.busyPanel = isBusy;
      },
      setInert(isInert: boolean) {
        harness.inertPanel = isInert;
      },
    },
    mode: createSceneMode(map as unknown as MapLibreMap, roots as unknown as SceneRoots),
    enter(time: string | null = null) {
      this.requestedTime = time;
      this.mode.enter(SCENE, { time, entry: "replace", buildPanel: this.buildPanel });
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
        addEventListener(type: string, listener: (event: object) => void) {
          bodyListeners.set(type, new Set([...(bodyListeners.get(type) ?? []), listener]));
        },
        removeEventListener(type: string, listener: (event: object) => void) {
          bodyListeners.get(type)?.delete(listener);
        },
        classList: {
          add(...names: string[]) {
            for (const name of names) {
              bodyClasses.add(name);
              harness.classLog.push(name);
            }
          },
          remove(...names: string[]) {
            for (const name of names) bodyClasses.delete(name);
          },
          contains: (name: string) => bodyClasses.has(name),
        },
      },
      documentElement: {
        offsetHeight: 0,
        style: {
          setProperty(name: string, value: string) {
            harness.styleWrites.push([name, value]);
          },
          removeProperty(name: string) {
            harness.styleWrites.push([name, ""]);
          },
        },
      },
      createElement: element,
    },
    history: { state: null, replaceState() {} },
    location: (globalThis as Record<string, unknown>).location ?? { pathname: "/", search: "" },
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
  readonly container = { inert: false };
  readonly sources = new Map<string, object>();
  readonly filters = new Map<string, unknown>();
  readonly listeners = new Map<string, Set<(event: object) => void>>();
  readonly canvasListeners = new Map<string, Set<(event: object) => void>>();
  readonly canvas = {
    addEventListener: (type: string, listener: (event: object) => void) => {
      if (!this.canvasListeners.has(type)) this.canvasListeners.set(type, new Set());
      this.canvasListeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: object) => void) => {
      this.canvasListeners.get(type)?.delete(listener);
    },
  };
  rangeWrites = 0;
  readyOnAdd = false;
  failMaskLayer = false;
  private maskLoaded = false;

  getContainer() { return this.container; }
  getCanvas() { return this.canvas as unknown as HTMLCanvasElement; }
  loseContext() {
    for (const listener of [...(this.canvasListeners.get("webglcontextlost") ?? [])]) {
      listener({});
    }
  }
  getStyle() { return { layers: [...this.layers.values()] }; }
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
