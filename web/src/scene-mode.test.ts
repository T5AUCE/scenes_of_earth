import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

import { Window } from "happy-dom";
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
        openFull(tab, options) {
          calls.push(["open", tab, options]);
          state.open = true;
        },
        closeFull() {
          calls.push(["close"]);
          state.open = false;
        },
        get isOpen() { return state.open; },
        destroy() {},
      };
    };
  `,
  "./scene-url": `
    export const sceneUrl = () => "/?scene=test";
    export const timeForPrefix = () => null;
  `,
  "./view": `
    export const OUTLINE_ID = "soe-area-outline";
    export function mountScene(map, scene, slots) {
      globalThis.sceneModeTest.onUnits = slots.onUnits;
      globalThis.sceneModeTest.onTime = slots.onTime;
      const layerIds = ["relief", "contours", "rain", "overview"];
      if (slots.onUnits) {
        const initial = globalThis.sceneModeTest.initialUnits ?? ["m", {}];
        slots.onUnits(initial[0], initial[1], [...layerIds]);
      }
      const snapshot = {
        display: { layers: {}, off: new Set(), showAs: {} },
        allocation: { owner: null, draws: new Map(), as: new Map() },
        on: new Set(),
      };
      const mountStore = {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        dispatch: () => {},
      };
      globalThis.sceneModeTest.mountStore = mountStore;
      return {
        timeline: null,
        layerIds,
        store: mountStore,
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

test("the panel receives the scene store and follows the timeline", () => {
  const harness = createHarness();
  harness.initialUnits = ["ft", { terrain: "ft" }];
  harness.enter();

  assert.equal(harness.panelStore, harness.mountStore);
  assert.deepEqual(harness.times, [[null, null]]);

  harness.onTime!("2020-02-01", "2020-02");

  assert.deepEqual(harness.times.at(-1), ["2020-02-01", "2020-02"]);
});

test("the panel owner pushes history and forwards notice options to reopen", () => {
  const harness = createHarness();
  const pushedEntries: [unknown, string][] = [];
  const backCalls: string[] = [];
  let historyState: { panel?: string } | null = null;
  // The stubbed history records the owner boundary without browser navigation.
  Object.assign(globalThis, {
    history: {
      get state() {
        return historyState;
      },
      pushState(next: unknown, _title: string, url: string) {
        pushedEntries.push([next, url]);
        historyState = next as { panel?: string } | null;
      },
      replaceState(next: unknown) {
        historyState = next as { panel?: string } | null;
      },
      back() {
        backCalls.push("back");
      },
    },
  });
  harness.enter();

  const hooks = harness.panelHooks as {
    requestOpen(tab: string, options?: { scrollToNotices?: boolean }): void;
    requestClose(): void;
  };
  const recorded = harness as unknown as {
    panelCalls: [string, string?, { scrollToNotices?: boolean }?][];
    panelState: { open: boolean };
  };

  hooks.requestOpen("about", { scrollToNotices: true });

  assert.deepEqual(pushedEntries.at(-1), [{ panel: "about" }, "/?scene=test"]);
  assert.deepEqual(recorded.panelCalls.at(-1), [
    "open",
    "about",
    { scrollToNotices: true },
  ]);
  assert.equal(recorded.panelState.open, true);

  hooks.requestOpen("credits");

  assert.deepEqual(pushedEntries.at(-1), [{ panel: "credits" }, "/?scene=test"]);
  assert.deepEqual(recorded.panelCalls.at(-1), ["open", "credits", undefined]);

  const callsBeforeBack = recorded.panelCalls.length;
  hooks.requestClose();

  assert.deepEqual(backCalls, ["back"]);
  assert.equal(recorded.panelCalls.length, callsBeforeBack);

  harness.mode.showFullscreen(null);

  assert.deepEqual(recorded.panelCalls.at(-1), ["close"]);
  assert.equal(recorded.panelState.open, false);

  harness.mode.showFullscreen("credits");

  assert.deepEqual(recorded.panelCalls.at(-1), ["open", "credits", undefined]);
  assert.equal(recorded.panelState.open, true);

  const callsWhileOpen = recorded.panelCalls.length;
  harness.mode.showFullscreen("credits");

  assert.equal(recorded.panelCalls.length, callsWhileOpen);

  harness.mode.showFullscreen(null);
  harness.mode.showFullscreen("unknown-tab");

  assert.deepEqual(recorded.panelCalls.at(-1), ["open", "about", undefined]);

  historyState = null;
  const callsBeforeDirect = recorded.panelCalls.length;
  const backsBeforeDirect = backCalls.length;
  hooks.requestClose();

  assert.equal(recorded.panelCalls.length, callsBeforeDirect + 1);
  assert.deepEqual(recorded.panelCalls.at(-1), ["close"]);
  assert.equal(backCalls.length, backsBeforeDirect);
});

test("the owner and real panel keep history through Back and Forward", async (context) => {
  const window = new Window({ url: "http://localhost/?scene=test" });
  context.after(() => window.happyDOM.abort());
  const harness = createHarness();
  installBrowser(context, window);
  const previousHistory = (globalThis as Record<string, unknown>).history;
  (globalThis as Record<string, unknown>).history = window.history;
  context.after(() => {
    (globalThis as Record<string, unknown>).history = previousHistory;
  });
  const { act } = await import("react");
  const { createScenePanel: realCreate } = await import("./ui/scene-panel.tsx");
  const testState = harness as unknown as Record<string, unknown>;
  testState.useRealPanel = true;
  testState.realCreateScenePanel = realCreate;
  const column = document.createElement("div");
  const timeBar = document.createElement("div");
  const dialog = makeIntegrationDialog();
  document.body.append(column, timeBar, dialog);
  const roots = harness.roots as unknown as Record<string, unknown>;
  roots.column = column;
  roots.timeBar = timeBar;
  roots.dialog = dialog;
  const scrolled = installScrollSpy(context);
  const backCalls: string[] = [];
  const originalBack = window.history.back.bind(window.history);
  window.history.back = () => {
    backCalls.push("back");
    originalBack();
  };
  const originalReplace = window.history.replaceState.bind(window.history);
  window.history.replaceState = (next: unknown, title: string, url: string) => {
    // Happy-dom drops forward entries on a no-op replace while real browsers keep them.
    if (next === history.state && url === "/?scene=test") return;
    return (originalReplace as (...replaceArgs: [unknown, string, string]) => void)(
      next,
      title,
      url,
    );
  };
  window.addEventListener("popstate", () => {
    const tab = (history.state as { panel?: string } | null)?.panel ?? null;
    harness.mode.showFullscreen(tab);
  });

  const scene = makeIntegrationScene();
  await act(async () => {
    harness.mode.enter(scene, { time: null, entry: "replace" });
  });
  harness.geometry.resolve(FEATURE);
  await settle();
  harness.map.finishMask();
  await settle();
  await act(async () => {});

  assert.equal(history.state, null);
  assert.equal(dialog.open, false);

  const badge = [...column.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes("note"),
  )!;
  await act(async () => {
    badge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(history.state, { panel: "about" });
  assert.equal(dialog.open, true);
  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "About",
  );
  const aboutTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "About",
  ) as HTMLButtonElement;
  assert.equal(document.activeElement, aboutTab);
  const main = dialog.querySelector("main") as HTMLElement;
  assert.equal(main.scrollTop, 0);
  assert.equal(dialog.querySelector("#notices-heading")?.textContent, "Notices and limits");
  assert.ok(scrolled.includes("notices-heading"));

  main.scrollTop = 123;
  const closed = new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(null), { once: true });
  });
  await act(async () => {
    const event = new window.Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  });
  assert.deepEqual(backCalls, ["back"]);
  await closed;
  await act(async () => {});
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement, column.querySelector(".expand"));

  main.scrollTop = 123;
  scrolled.length = 0;
  const reopened = new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(null), { once: true });
  });
  await act(async () => {
    history.forward();
  });
  await reopened;
  await act(async () => {});
  assert.equal(dialog.open, true);
  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "About",
  );
  assert.equal(document.activeElement, aboutTab);
  assert.equal(main.scrollTop, 0);
  assert.deepEqual(scrolled, []);
  await act(async () => {
    harness.mode.exit();
  });
});

test("a units change refreshes the gate and drops removed contour ids", async () => {
  const harness = createHarness();
  harness.enter();
  harness.geometry.resolve(FEATURE);
  await settle();
  harness.map.finishMask();
  await settle();

  harness.map.layers.set("contours-ft", {
    id: "contours-ft",
    minzoom: 7,
    maxzoom: 12,
    layout: { visibility: "visible" },
  });
  harness.map.layers.delete("contours");
  harness.onUnits!("ft", { terrain: "ft" }, ["relief", "contours-ft", "rain", "overview"]);

  assert.equal(harness.map.getLayer("contours-ft")!.minzoom, 7);
  harness.flight.zoom = 8;
  harness.resize();
  assert.equal(harness.map.getLayer("contours-ft")!.minzoom, 7.75);
  assert.equal(harness.map.getLayer("contours"), undefined);
});

test("docking observes the attribution and time bar and publishes their extent", (context) => {
  const harness = createHarness();
  const docking = installDockingStubs(context, { footerHeight: 40, barHeight: 50 });
  harness.roots.timeBar = docking.timeBar;
  harness.enter();

  assert.ok(docking.observed.includes(docking.timeBar));
  assert.ok(docking.observed.includes(docking.footer));
  assert.equal(docking.observed.length, 2);
  assert.equal(docking.values["--scene-dock-bottom"], "86px");

  docking.setFooterHeight(100);
  docking.trigger();
  assert.equal(docking.values["--scene-dock-bottom"], "108px");

  docking.setFooterHeight(40);
  docking.setBarHeight(100);
  docking.trigger();
  assert.equal(docking.values["--scene-dock-bottom"], "136px");

  harness.mode.exit();
  assert.equal(docking.disconnects, 1);
});

test("docking disconnects on exit and re-observes on re-entry", (context) => {
  const harness = createHarness();
  const docking = installDockingStubs(context, { footerHeight: 32, barHeight: 24 });
  harness.roots.timeBar = docking.timeBar;
  harness.enter();
  assert.equal(docking.observed.length, 2);
  assert.equal(docking.values["--scene-dock-bottom"], "60px");

  harness.mode.exit();
  assert.equal(docking.disconnects, 1);

  harness.map.layers.set("relief", { id: "relief", layout: { visibility: "visible" } });
  harness.map.layers.set("contours", {
    id: "contours",
    minzoom: 6,
    maxzoom: 12,
    layout: { visibility: "visible" },
  });
  harness.map.layers.set("rain", {
    id: "rain",
    minzoom: 0,
    maxzoom: 24,
    layout: { visibility: "visible" },
  });
  harness.map.layers.set("overview", {
    id: "overview",
    minzoom: 1,
    maxzoom: 4,
    layout: { visibility: "visible" },
  });
  harness.enter();
  assert.equal(docking.observed.length, 4);
  assert.equal(docking.values["--scene-dock-bottom"], "60px");

  harness.mode.exit();
  assert.equal(docking.disconnects, 2);
});

function createHarness() {
  const map = new TestMap();
  const roots = { column: element(), timeBar: element(), dialog: element() };
  const harness = {
    map,
    roots,
    geometry: deferred(),
    notes: [] as string[],
    times: [] as [string | null, string | null][],
    panelStore: null as unknown,
    mountStore: null as unknown,
    panelHooks: null as unknown,
    onUnits: null as ((elevation: string, units: Record<string, string>, ids: string[]) => void)
      | null,
    onTime: null as ((time: string, label: string) => void) | null,
    initialUnits: null as [string, Record<string, string>] | null,
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

function installDockingStubs(
  context: { after(hook: () => void): void },
  sizes: { footerHeight: number; barHeight: number },
): {
  footer: unknown;
  timeBar: unknown;
  observed: unknown[];
  values: Record<string, string>;
  trigger(): void;
  setFooterHeight(height: number): void;
  setBarHeight(height: number): void;
  readonly disconnects: number;
} {
  const previous = {
    document: globalThis.document,
    history: globalThis.history,
    getComputedStyle: globalThis.getComputedStyle,
    window: (globalThis as Record<string, unknown>).window,
    ResizeObserver: (globalThis as Record<string, unknown>).ResizeObserver,
    Element: (globalThis as Record<string, unknown>).Element,
    HTMLElement: (globalThis as Record<string, unknown>).HTMLElement,
  };
  context.after(() => {
    Object.assign(globalThis, {
      document: previous.document,
      history: previous.history,
      getComputedStyle: previous.getComputedStyle,
    });
    (globalThis as Record<string, unknown>).window = previous.window;
    (globalThis as Record<string, unknown>).ResizeObserver = previous.ResizeObserver;
    (globalThis as Record<string, unknown>).Element = previous.Element;
    (globalThis as Record<string, unknown>).HTMLElement = previous.HTMLElement;
  });

  const INNER_HEIGHT_PX = 800;
  const TIME_BAR_BOTTOM_PX = 28;
  let footerHeight = sizes.footerHeight;
  let barHeight = sizes.barHeight;
  class DockingElement {
    constructor(readonly kind: string) {}

    getBoundingClientRect() {
      if (this.kind === "footer") {
        return {
          top: INNER_HEIGHT_PX - footerHeight,
          bottom: INNER_HEIGHT_PX,
          height: footerHeight,
        };
      }

      return {
        top: INNER_HEIGHT_PX - TIME_BAR_BOTTOM_PX - barHeight,
        bottom: INNER_HEIGHT_PX - TIME_BAR_BOTTOM_PX,
        height: barHeight,
      };
    }
  }

  const values: Record<string, string> = {};
  const footer = new DockingElement("footer");
  const timeBar = new DockingElement("bar") as unknown as HTMLElement;
  const observed: unknown[] = [];
  let disconnects = 0;
  let update: (() => void) | null = null;
  class TestObserver {
    constructor(callback: () => void) {
      update = callback;
    }

    observe(target: unknown) {
      observed.push(target);
    }

    disconnect() {
      disconnects += 1;
    }
  }

  (globalThis as Record<string, unknown>).Element = DockingElement;
  (globalThis as Record<string, unknown>).HTMLElement = DockingElement;
  (globalThis as Record<string, unknown>).window = { innerHeight: INNER_HEIGHT_PX };
  (globalThis as Record<string, unknown>).ResizeObserver = TestObserver;
  Object.assign(globalThis, {
    document: {
      body: { classList: { add() {}, remove() {} } },
      createElement: element,
      documentElement: {
        style: {
          setProperty(name: string, value: string) {
            values[name] = value;
          },
        },
      },
      querySelector(selector: string) {
        if (selector === ".maplibregl-ctrl-bottom-left") return footer;

        return null;
      },
    },
    history: { state: null, replaceState() {}, pushState() {}, back() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "#faf8f3" }),
  });

  return {
    footer,
    timeBar,
    observed,
    values,
    trigger() {
      update?.();
    },
    setFooterHeight(height: number) {
      footerHeight = height;
    },
    setBarHeight(height: number) {
      barHeight = height;
    },
    get disconnects() {
      return disconnects;
    },
  };
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

function installBrowser(context: { after(hook: () => void): void }, window: Window): void {
  const previous = {
    node: (globalThis as Record<string, unknown>).Node,
    element: (globalThis as Record<string, unknown>).Element,
    htmlElement: (globalThis as Record<string, unknown>).HTMLElement,
    dialogElement: (globalThis as Record<string, unknown>).HTMLDialogElement,
    svgElement: (globalThis as Record<string, unknown>).SVGElement,
    fragment: (globalThis as Record<string, unknown>).DocumentFragment,
    event: (globalThis as Record<string, unknown>).Event,
    customEvent: (globalThis as Record<string, unknown>).CustomEvent,
    mouseEvent: (globalThis as Record<string, unknown>).MouseEvent,
    keyboardEvent: (globalThis as Record<string, unknown>).KeyboardEvent,
    browser: (globalThis as Record<string, unknown>).window,
    document: globalThis.document,
    navigator: (globalThis as Record<string, unknown>).navigator,
    storage: (globalThis as Record<string, unknown>).localStorage,
    actEnvironment: (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT,
  };
  context.after(() => {
    const globals = globalThis as Record<string, unknown>;
    globals.Node = previous.node;
    globals.Element = previous.element;
    globals.HTMLElement = previous.htmlElement;
    globals.HTMLDialogElement = previous.dialogElement;
    globals.SVGElement = previous.svgElement;
    globals.DocumentFragment = previous.fragment;
    globals.Event = previous.event;
    globals.CustomEvent = previous.customEvent;
    globals.MouseEvent = previous.mouseEvent;
    globals.KeyboardEvent = previous.keyboardEvent;
    globals.window = previous.browser;
    globals.document = previous.document;
    globals.navigator = previous.navigator;
    globals.localStorage = previous.storage;
    globals.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
  });
  const names = [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDialogElement",
    "SVGElement",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
  ] as const;
  for (const name of names) defineGlobal(name, window[name]);
  defineGlobal("window", window);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("localStorage", window.localStorage);
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function installScrollSpy(context: { after(hook: () => void): void }): string[] {
  const scrolled: string[] = [];
  const prototype = globalThis.Element.prototype as unknown as {
    scrollIntoView?: () => void;
  };
  const original = prototype.scrollIntoView;
  prototype.scrollIntoView = function (this: Element) {
    scrolled.push((this as HTMLElement).id);
  };
  context.after(() => {
    prototype.scrollIntoView = original!;
  });

  return scrolled;
}

function makeIntegrationDialog(): HTMLDialogElement {
  const dialog = document.createElement("dialog") as HTMLDialogElement;
  if (typeof dialog.showModal !== "function") {
    let open = false;
    Object.defineProperty(dialog, "open", {
      get: () => open,
      configurable: true,
    });
    dialog.showModal = () => {
      open = true;
    };
    dialog.close = () => {
      open = false;
    };
  }
  if (typeof dialog.scrollIntoView !== "function") {
    (dialog as unknown as Record<string, unknown>).scrollIntoView = () => {};
  }

  return dialog;
}

function makeIntegrationScene(): Scene {
  return {
    id: "test",
    title: "Test scene",
    generator: { name: "soe", version: "0.9.0" },
    version: "0.7",
    created: "2026-10-23T00:00:00Z",
    area: {
      boundary: {
        id: "test",
        name: "Test",
        level: "level",
        iso3: null,
        source: "geoBoundaries",
        licence: "CC BY 4.0",
        attribution: "Boundary credit",
      },
      bbox: [0, -1, 1, 1],
      geometry_href: "area.geojson",
      clipped_to_coverage: false,
    },
    period: null,
    layers: [
      {
        id: "rain",
        title: "Rainfall",
        units: "mm/month",
        source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
        style: { kind: "field", encodings: ["ramp"] },
        grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
        mask: { path: "mask.zarr", cells_inside: 100 },
        time: null,
        arrays: {},
      },
      {
        id: "terrain",
        title: "Terrain",
        units: "m",
        source: { name: "DEM", licence: "open", attribution: "DEM credit" },
        style: { kind: "terrain", encodings: ["shade"] },
        grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
        mask: { path: "mask.zarr", cells_inside: 100 },
        time: null,
        arrays: {},
      },
    ],
    data: { href: "data.zarr" },
    notices: { limits: ["Coarse terrain."] },
    credits: {
      lines: ["Rain credit", "DEM credit", "Boundary credit"],
      disclaimers: [],
      endorsement: "Endorsement.",
      terms_passthrough: "Terms.",
    },
  } as unknown as Scene;
}
