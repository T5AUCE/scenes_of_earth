import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Window } from "happy-dom";

import { assertSameNode } from "./testing/dom-assert.ts";
import {
  createHarness,
  DATA_IDS,
  exitActiveHarness,
  FEATURE,
  MASK_ID,
  resetHarness,
} from "./testing/scene-mode-harness.ts";
import type { TestMap } from "./testing/scene-mode-harness.ts";
import type { Scene } from "./types.ts";

afterEach(resetHarness);

test("delayed geometry and mask tiles keep data hidden through resize until ready", async () => {
  const harness = createHarness();
  harness.enter();
  harness.data.resolve();
  assertDataHidden(harness.map);
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
  assertRanges(harness.map, [[4.75, 24], [6, 12], [4.75, 24], [4, 4]]);
  assert.equal(harness.labelMoves, 1);
  assertListenersRemoved(harness.map);
});

test("the flight waits for the mask and the first data", async () => {
  const harness = createHarness();
  harness.enter();
  const waitingLand = harness.land;
  assert.ok(harness.notes.includes("Preparing scene..."));

  harness.geometry.resolve(FEATURE);
  harness.data.resolve();
  await settle();
  assert.equal(harness.land, waitingLand);
  assert.ok(harness.notes.includes("Preparing scene..."));

  harness.map.finishMask();
  await settle();

  assert.notEqual(harness.land, waitingLand);
  assert.ok(!harness.notes.includes("Preparing scene..."));
  assertRanges(harness.map, [[4.75, 24], [6, 12], [4.75, 24], [4, 4]]);
});

test("the flight starts at the cap when readiness never comes", async () => {
  const harness = createHarness();
  harness.enter();
  const waitingLand = harness.land;

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(harness.land, waitingLand);

  await new Promise((resolve) => setTimeout(resolve, 1600));

  assert.notEqual(harness.land, waitingLand);
  assert.ok(!harness.notes.includes("Preparing scene..."));
});

test("closing during the wait starts no flight", async () => {
  const harness = createHarness();
  harness.enter();
  const waitingLand = harness.land;
  harness.mode.exit();
  const writes = harness.map.rangeWrites;
  harness.geometry.resolve(FEATURE);
  harness.data.resolve();
  harness.map.finishMask();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(harness.land, waitingLand);
  assert.deepEqual(harness.notes, []);
  assert.equal(harness.map.rangeWrites, writes);
  assertListenersRemoved(harness.map);
});

test("rejected geometry keeps data hidden after landing and refitting", async () => {
  const harness = createHarness();
  harness.enter();
  harness.data.resolve();
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
  harness.data.resolve();
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
  harness.data.resolve();
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
  harness.data.resolve();
  harness.geometry.resolve(FEATURE);
  await settle();

  assertRanges(harness.map, [[4.75, 24], [6, 12], [4.75, 24], [4, 4]]);
  assertListenersRemoved(harness.map);
});

test("a synchronous landing cannot bypass pending mask readiness", async () => {
  const harness = createHarness();
  harness.landImmediately = true;
  harness.enter();
  harness.data.resolve();
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
  harness.data.resolve();
  harness.geometry.resolve(FEATURE);
  await settle();
  harness.land();
  harness.resize();

  assertDataHidden(harness.map);
  assert.deepEqual(harness.notes, ["mask setup failed"]);
  assertListenersRemoved(harness.map);
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

  assert.deepEqual(pushedEntries.at(-1), [{ panel: "about" }, "?scene=test"]);
  assert.deepEqual(recorded.panelCalls.at(-1), [
    "open",
    "about",
    { scrollToNotices: true },
  ]);
  assert.equal(recorded.panelState.open, true);

  hooks.requestOpen("credits");

  assert.deepEqual(pushedEntries.at(-1), [{ panel: "credits" }, "?scene=test"]);
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
  context.after(async () => {
    await exitActiveHarness();
    window.happyDOM.abort();
  });
  const harness = createHarness();
  installBrowser(context, window);
  (globalThis as Record<string, unknown>).location = window.location;
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
    const candidate = new URL(url, window.location.href).href;
    if (candidate === window.location.href && next === window.history.state) return;
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
  assertSameNode(document.activeElement, aboutTab);
  const main = dialog.querySelector("main") as HTMLElement;
  assert.equal(main.scrollTop, 0);
  assert.equal(dialog.querySelector("#notices-heading")?.textContent, "Notices and Limits");
  assert.ok(scrolled.includes("notices-heading"));

  main.scrollTop = 123;
  const closed = waitForPopstate(window, "closing the dialog did not navigate");
  await act(async () => {
    const event = new window.Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  });
  assert.deepEqual(backCalls, ["back"]);
  await closed;
  await act(async () => {});
  assert.equal(dialog.open, false);
  assertSameNode(document.activeElement, column.querySelector(".expand"));

  main.scrollTop = 123;
  scrolled.length = 0;
  const reopened = waitForPopstate(window, "forward did not reopen the dialog");
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
  assertSameNode(document.activeElement, aboutTab);
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

test("chart commits update the share link without clobbering display or history", () => {
  const harness = createHarness();
  const replaced: [unknown, string][] = [];
  let historyState: { panel?: string } | null = null;
  Object.assign(globalThis, {
    history: {
      get state() {
        return historyState;
      },
      pushState(next: unknown, _title: string, url: string) {
        historyState = next as { panel?: string } | null;
        replaced.push([next, url]);
      },
      replaceState(next: unknown, _title: string, url: string) {
        historyState = next;
        replaced.push([next, url]);
      },
      back() {},
    },
  });
  harness.enter();
  replaced.length = 0;
  historyState = { panel: "charts" };

  harness.onCharts!("token123");

  assert.equal(replaced.length, 1);
  assert.equal(replaced[0][0], historyState);
  assert.match(replaced[0][1] as string, /charts=token123/);
  assert.match(replaced[0][1] as string, /scene=test/);
});

test("oversized chart commits keep a safe URL and recover through the owner", () => {
  const harness = createHarness();
  (globalThis as Record<string, unknown>).location = new URL("https://example.test/a-path/");
  const replaced: string[] = [];
  Object.assign(globalThis, {
    history: {
      get state() {
        return null;
      },
      pushState() {},
      replaceState(_next: unknown, _title: string, url: string) {
        replaced.push(url);
      },
      back() {},
    },
  });
  harness.enter();
  replaced.length = 0;

  harness.onCharts!("token123");
  assert.equal(replaced.length, 1);
  assert.match(replaced[0], /charts=token123/);
  const fittingUrl = replaced[0];
  assert.ok(fittingUrl.length <= 8192);
  assert.equal(harness.syncNotices.at(-1), undefined);

  harness.onCharts!("a".repeat(9000));

  assert.equal(replaced.length, 2);
  assert.equal(replaced[1], fittingUrl);
  assert.ok(replaced[1].length <= 8192);
  assert.match(replaced[1], /charts=token123/);
  assert.equal(
    harness.syncNotices.at(-1),
    "The share link is too long to include these charts.",
  );

  harness.onCharts!("token123");

  assert.equal(replaced.length, 3);
  assert.match(replaced[2], /charts=token123/);
  assert.equal(replaced[2], fittingUrl);
  assert.equal(harness.syncNotices.at(-1), null);
});

test("a dirty editor holds the entry on browser back", () => {
  const harness = createHarness();
  Object.assign(globalThis, {
    history: {
      get state() {
        return null;
      },
      pushState(next: unknown) {
        (globalThis.sceneModeTest as Record<string, unknown>).pushed = next;
      },
      replaceState() {},
      back() {},
    },
  });
  harness.enter();
  (globalThis.sceneModeTest as Record<string, unknown>).editorDirty = true;
  const recorded = harness as unknown as { confirmCalls?: string[] };

  harness.mode.showFullscreen(null);

  assert.deepEqual(recorded.confirmCalls, ["confirm"]);
  assert.deepEqual(
    (globalThis.sceneModeTest as Record<string, unknown>).pushed,
    { panel: "charts" },
  );
});

test("complete urls keep time display and panel at the exact boundary", async () => {
  const { isCompleteUrlOversized } = await import("./charts/state.ts");
  const { sceneUrl, withChartsToken } = await import("./scene-url.ts");
  const base = "https://example.test/a-long-application-path/?scene=test";
  const display = "&units=rain%3A%C2%B0F";
  const timeLabel = "2020-02";
  const relative = sceneUrl("test", timeLabel, display);
  const emptyAbsolute = new URL(withChartsToken(relative, ""), base).href;
  const tokenLength = 8192 - emptyAbsolute.length;
  assert.ok(tokenLength > 0);
  const token8192 = "a".repeat(tokenLength);
  const absolute8192 = new URL(withChartsToken(relative, token8192), base).href;
  assert.equal(absolute8192.length, 8192);
  assert.equal(isCompleteUrlOversized(absolute8192), false);
  assert.ok(absolute8192.includes("/a-long-application-path/"));
  assert.ok(absolute8192.includes("%C2%B0"));
  assert.ok(absolute8192.includes(timeLabel));
  const absolute8193 = new URL(withChartsToken(relative, `${token8192}a`), base).href;
  assert.equal(absolute8193.length, 8193);
  assert.equal(isCompleteUrlOversized(absolute8193), true);
});

test("exact-boundary chart tokens keep display and time in controller history", async () => {
  const { isCompleteUrlOversized } = await import("./charts/state.ts");
  const { sceneUrl } = await import("./scene-url.ts");
  const page = "https://example.test/a-long-application-path/?scene=test";
  (globalThis as Record<string, unknown>).location = new URL(page);
  const display = "&units=rain%3A%C2%B0F";
  const emptyComplete = new URL(sceneUrl("test", "2020-02", display), page).href;
  const fittingLength = 8192 - emptyComplete.length - "&charts=".length;
  assert.ok(fittingLength > 0);
  const harness = createHarness();
  const replaced: { state: unknown; url: string }[] = [];
  let historyState: { panel?: string } | null = null;
  Object.assign(globalThis, {
    history: {
      get state() {
        return historyState;
      },
      pushState() {},
      replaceState(next: unknown, _title: string, url: string) {
        historyState = next as { panel?: string } | null;
        replaced.push({ state: next, url });
      },
      back() {},
    },
  });
  harness.enter("2020-02");
  assert.deepEqual(harness.restoredTimes, ["2020-02-01"]);
  harness.onDisplay!(display);
  harness.onTime!("2020-02-01", "2020-02");
  historyState = { panel: "charts" };
  replaced.length = 0;

  const fitting = "c".repeat(fittingLength);
  harness.onCharts!(fitting);

  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].url.length, 8192);
  assert.equal(isCompleteUrlOversized(replaced[0].url), false);
  assert.ok(replaced[0].url.includes("/a-long-application-path/"));
  assert.ok(replaced[0].url.includes("%C2%B0"));
  assert.ok(replaced[0].url.includes("t=2020-02"));
  assert.deepEqual(replaced[0].state, { panel: "charts" });

  harness.onCharts!(`${fitting}d`);

  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].url, replaced[0].url);
  assert.ok(replaced[1].url.length <= 8192);
  assert.match(replaced[1].url, /charts=c+/);
  assert.deepEqual(replaced[1].state, { panel: "charts" });
  assert.equal(
    harness.syncNotices.at(-1),
    "The share link is too long to include these charts.",
  );

  harness.onDisplay!("");

  assert.equal(replaced.length, 3);
  assert.ok(replaced[2].url.length <= 8192);
  assert.equal(isCompleteUrlOversized(replaced[2].url), false);
  assert.match(replaced[2].url, /charts=c+d/);
  assert.ok(replaced[2].url.includes("t=2020-02"));
  assert.equal(replaced[2].url.includes("%C2%B0"), false);
  assert.deepEqual(replaced[2].state, { panel: "charts" });
  assert.equal(harness.syncNotices.at(-1), null);

  harness.onDisplay!(display);

  assert.equal(replaced.length, 4);
  assert.equal(replaced[3].url, replaced[2].url);
  assert.ok(replaced[3].url.length <= 8192);
  assert.deepEqual(replaced[3].state, { panel: "charts" });
  assert.equal(
    harness.syncNotices.at(-1),
    "The share link is too long to include these charts.",
  );

  harness.onTime!(null as unknown as string, null as unknown as string);

  assert.equal(replaced.length, 5);
  assert.ok(replaced[4].url.length <= 8192);
  assert.equal(isCompleteUrlOversized(replaced[4].url), false);
  assert.match(replaced[4].url, /charts=c+d/);
  assert.ok(replaced[4].url.includes("%C2%B0"));
  assert.equal(replaced[4].url.includes("t=2020-02"), false);
  assert.deepEqual(replaced[4].state, { panel: "charts" });
  assert.equal(harness.syncNotices.at(-1), null);

  harness.onCharts!(fitting);

  assert.equal(replaced.length, 6);
  assert.ok(replaced[5].url.length <= 8192);
  assert.match(replaced[5].url, /charts=c+/);
  assert.equal(harness.syncNotices.at(-1), null);
  for (const entry of replaced) assert.ok(entry.url.length <= 8192);
});

test("a throwing renderer keeps charts while the working layer keeps colour", async (context) => {
  const window = new Window({ url: "https://example.test/?scene=test" });
  context.after(async () => {
    const { act } = await import("react");
    await act(async () => {});
    window.happyDOM.abort();
  });
  installBrowser(context, window);
  const mountScene = await importViewWithStubs(THROWING_REGISTRY_STUB);
  const { defaultSlice, encodeSlice } = await import("./charts/state.ts");
  const { NO_TOKENS } = await import("./display-state.ts");
  const rain = {
    id: "rain",
    title: "Rainfall",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"], palette: "batlow" },
    time: { step: "P1M", values: ["2020-01-01", "2020-02-01"], end: "2020-03-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: [1, 2],
      valid_fraction: [1, 1],
    },
    arrays: {},
  } as unknown as Scene;
  const temp = {
    ...(rain as unknown as Record<string, unknown>),
    id: "temp",
    title: "Temperature",
    units: "°C",
    style: { kind: "field", encodings: ["ramp", "isolines"] },
    time: { step: "P1M", values: ["2020-01-01", "2020-02-01"], end: "2020-03-01", method: "mean" },
  } as unknown as Scene;
  const scene = {
    id: "test",
    layers: [rain, temp],
    area: { bbox: [0, -1, 1, 1], geometry_href: "area.geojson" },
    data: { href: "data.zarr" },
    period: { start: "2020-01-01", end: "2020-03-01", step: "P1M" },
  } as unknown as Scene;
  const slice = defaultSlice((scene as unknown as { layers: never[] }).layers as never[]);
  (slice.definitions[0] as { title: string }).title = "Custom retained source";
  const map = {
    addSource() {},
    addLayer() {},
    setLayoutProperty() {},
    addControl() {},
    removeControl() {},
    getSource() {},
    getLayer() {},
    removeLayer() {},
    removeSource() {},
  };
  const cards = document.createElement("div");
  const timeBar = document.createElement("div");
  const mounted = mountScene(map as never, scene, {
    cards,
    timeBar,
    display: { ...NO_TOKENS, charts: encodeSlice(slice) },
    onDisplay() {},
    onCharts() {},
    onTime() {},
  });
  assert.ok(
    mounted.store.getSnapshot().charts.definitions.some(
      (entry) => entry.title === "Custom retained source",
    ),
  );
  assert.equal(mounted.store.getSnapshot().charts.definitions.length, slice.definitions.length);
  assert.equal(mounted.store.getSnapshot().allocation.owner, "rain");
  assert.equal(mounted.store.getSnapshot().allocation.draws.get("rain"), "colour");
  mounted.unmount();
});

test("a throwing geology mount adds no water copy while others still mount", async (context) => {
  const window = new Window({ url: "https://example.test/?scene=test" });
  context.after(async () => {
    const { act } = await import("react");
    await act(async () => {});
    window.happyDOM.abort();
  });
  installBrowser(context, window);
  const mountScene = await importViewWithStubs(THROWING_REGISTRY_STUB);
  const { NO_TOKENS } = await import("./display-state.ts");
  const { GEOLOGY_WATER_ID } = await import("./layers/geology-water.ts");
  const rain = {
    id: "rain",
    title: "Rainfall",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"], palette: "batlow" },
    time: { step: "P1M", values: ["2020-01-01", "2020-02-01"], end: "2020-03-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: [1, 2],
      valid_fraction: [1, 1],
    },
    arrays: {},
  } as unknown as Scene;
  const geology = {
    ...(rain as unknown as Record<string, unknown>),
    id: "geology",
    title: "Geology",
    units: "",
    style: { kind: "categorical", encodings: ["fill"] },
  } as unknown as Scene;
  const scene = {
    id: "test",
    layers: [rain, geology],
    area: { bbox: [0, -1, 1, 1], geometry_href: "area.geojson" },
    data: { href: "data.zarr" },
    period: { start: "2020-01-01", end: "2020-03-01", step: "P1M" },
  } as unknown as Scene;
  const cards = document.createElement("div");
  const timeBar = document.createElement("div");
  const failedMap = makeWaterMap();
  const failed = mountScene(failedMap as never, scene, {
    cards,
    timeBar,
    display: NO_TOKENS,
    onDisplay() {},
    onCharts() {},
    onTime() {},
  });
  assert.equal(failed.layerIds.includes("rain"), true);
  assert.equal(failed.layerIds.includes("geology"), false);
  assert.equal(failedMap.getLayer(GEOLOGY_WATER_ID), undefined);
  assert.match(cards.textContent ?? "", /renderer failed/);
  failed.unmount();

  const age = { ...(geology as unknown as Record<string, unknown>), id: "geology_age" };
  const wateredMap = makeWaterMap();
  const watering = mountScene(wateredMap as never, {
    ...(scene as unknown as Record<string, unknown>),
    layers: [rain, age],
  } as unknown as Scene, {
    cards: document.createElement("div"),
    timeBar: document.createElement("div"),
    display: NO_TOKENS,
    onDisplay() {},
    onCharts() {},
    onTime() {},
  });
  assert.equal(watering.layerIds.includes("geology_age"), true);
  assert.ok(wateredMap.getLayer(GEOLOGY_WATER_ID));
  watering.unmount();
});

test("a denied storage write stays visible until the retry succeeds", async (context) => {
  const window = new Window({ url: "https://example.test/a/?scene=test" });
  installBrowser(context, window);
  const mountScene = await importViewWithStubs(FIELD_REGISTRY_STUB);
  const { NO_TOKENS } = await import("./display-state.ts");
  const { STORAGE_DENIED_NOTICE, encodeSlice } = await import("./charts/state.ts");
  const { formatDisplayParams } = await import("./display-state.ts");
  const { act } = await import("react");
  const { createScenePanel } = await import("./ui/scene-panel.tsx");
  const scene = makeChartableIntegrationScene();
  scene.id = "test-storage";
  const previousStorage = (globalThis as Record<string, unknown>).localStorage;
  const deniedStorage = {
    getItem: (() => null) as () => null,
    setItem: (() => {
      throw new Error("storage unavailable");
    }) as () => void,
    removeItem: (() => {}) as () => void,
    clear: (() => {}) as () => void,
    key: (() => null) as () => null,
    get length() {
      return 0;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: deniedStorage,
    configurable: true,
    writable: true,
  });
  const notices: (string | null)[] = [];
  let panel: ReturnType<typeof createScenePanel> | null = null;
  let mounted: ReturnType<typeof mountScene> | null = null;
  context.after(async () => {
    const { act } = await import("react");
    await act(async () => {
      panel?.destroy();
    });
    panel = null;
    await act(async () => {
      mounted?.unmount();
    });
    mounted = null;
    await act(async () => {});
    window.happyDOM.abort();
  });
  const map = {
    addSource() {},
    addLayer() {},
    setLayoutProperty() {},
    addControl() {},
    removeControl() {},
    getSource() {},
    getLayer() {},
    removeLayer() {},
    removeSource() {},
  };
  const cards = document.createElement("div");
  const timeBar = document.createElement("div");
  let lastCharts: string | null = null;
  let lastDisplay = "";
  mounted = mountScene(map as never, scene, {
    cards,
    timeBar,
    display: NO_TOKENS,
    onDisplay: (params) => {
      lastDisplay = params;
    },
    onCharts: (token) => {
      lastCharts = token;
    },
    onTime() {},
    onChartSync: (notice) => {
      notices.push(notice);
      panel?.setSyncNotice(notice);
    },
  });
  assert.equal(lastCharts, encodeSlice(mounted.store.getSnapshot().charts));
  assert.equal(
    lastDisplay,
    formatDisplayParams(mounted.store.getSnapshot().display, scene.layers),
  );
  const dialog = makeIntegrationDialog();
  document.body.append(dialog);
  await act(async () => {
    panel = createScenePanel(scene, dialog, mounted.store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    panel.openFull("charts");
  });
  const definition = {
    id: "denied-chart",
    title: "Denied chart",
    source: { layerId: "rain", shape: "time_series" },
    chartType: "line",
    options: {},
  } as never;
  await act(async () => {
    mounted!.store.dispatch({ kind: "saveChart", definition });
  });
  assert.ok(notices.length >= 1);
  assert.equal(notices.at(-1), STORAGE_DENIED_NOTICE);
  assert.equal(lastCharts, encodeSlice(mounted!.store.getSnapshot().charts));
  assert.match(dialog.textContent ?? "", /kept for this visit/);
  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.match(dialog.textContent ?? "", /kept for this visit/);
  assert.equal(
    [...dialog.textContent!.matchAll(/kept for this visit/g)].length,
    1,
  );
  await act(async () => {
    mounted!.store.dispatch({
      kind: "display",
      update: (next) => {
        next.layers.rain = { palette: "cividis" };
      },
    });
  });
  assert.equal(notices.at(-1), STORAGE_DENIED_NOTICE);
  assert.equal(
    lastDisplay,
    formatDisplayParams(mounted!.store.getSnapshot().display, scene.layers),
  );
  assert.ok(lastDisplay.includes("cividis"));
  assert.match(dialog.textContent ?? "", /kept for this visit/);
  Object.defineProperty(globalThis, "localStorage", {
    value: previousStorage,
    configurable: true,
    writable: true,
  });
  const recovery = {
    ...(definition as unknown as Record<string, unknown>),
    title: "Recovered chart",
  } as never;
  await act(async () => {
    mounted!.store.dispatch({ kind: "saveChart", definition: recovery });
  });
  assert.equal(notices.at(-1), null);
  assert.equal(lastCharts, encodeSlice(mounted!.store.getSnapshot().charts));
  assert.equal((dialog.textContent ?? "").includes("kept for this visit"), false);
  await act(async () => {
    panel!.destroy();
  });
  mounted!.unmount();
  panel = null;
  mounted = null;
});

test("oversized charts keep the dirty Back entry through Keep editing", async (context) => {
  const pending = await openOversizedPendingClose(context, "Oversized draft");
  const { window, dialog, act, urls, input, store } = pending;
  const keep = [...dialog.querySelectorAll(".chart-confirm button")].find(
    (button) => button.textContent === "Keep editing",
  )!;
  await act(async () => {
    keep.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.equal(input.value, "Oversized draft");
  assert.ok(document.activeElement === input, "Keep editing restores focus to the invoker");
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.equal(window.history.length, 2);
  assert.match(dialog.textContent ?? "", /too long to include these charts/);
  for (const url of urls) assert.ok(url.length <= 8192);
  const retainedUrl = window.location.href;

  const secondPopped = waitForPopstate(window, "second Back did not navigate");
  await act(async () => {
    window.history.back();
  });
  await secondPopped;
  await act(async () => {});
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.equal(window.history.length, 2);
  assert.ok(dialog.querySelector(".chart-confirm"));
  assert.equal(window.location.href, retainedUrl);
  for (const url of urls) assert.ok(url.length <= 8192);

  const secondSave = [...dialog.querySelectorAll(".chart-confirm button")].find(
    (button) => button.textContent === "Save",
  ) as HTMLButtonElement;
  const secondClosed = waitForPopstate(window, "second Save did not navigate back");
  await act(async () => {
    secondSave.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await secondClosed;
  await act(async () => {});
  assert.equal(dialog.open, false);
  assert.equal(window.history.state, null);
  assert.equal(pending.pushedUrls.length, 3);
  assert.equal(window.location.href, pending.retainedUrl);
  const savedTitles = store.getSnapshot().charts.definitions.map((entry) => entry.title);
  assert.ok(savedTitles.includes("Oversized draft"));
  assert.ok(window.location.href.length <= 8192);
  for (const url of urls) assert.ok(url.length <= 8192);
});

test("oversized pending close completes through Discard", async (context) => {
  const pending = await openOversizedPendingClose(context, "Discarded draft");
  const { window, dialog, column, act, urls, store, before } = pending;
  assert.equal(window.history.length, 2);
  assert.deepEqual(window.history.state, { panel: "charts" });
  const discard = [...dialog.querySelectorAll(".chart-confirm button")].find(
    (button) => button.textContent === "Discard",
  )!;
  const closed = waitForPopstate(window, "discard did not navigate back");
  await act(async () => {
    discard.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await closed;
  await act(async () => {});
  assert.equal(dialog.open, false);
  assert.ok(dialog.querySelector(".chart-gallery"));
  assert.equal(JSON.stringify(store.getSnapshot().charts), before);
  assert.equal(window.history.state, null);
  assert.equal(pending.pushedUrls.length, 2);
  assert.equal(window.location.href, pending.retainedUrl);
  assert.ok(window.location.href.length <= 8192);
  assert.equal(window.location.href.includes("charts="), false);
  const expand = column.querySelector(".expand") as HTMLButtonElement;
  assert.ok(document.activeElement === expand, "closing returns focus to Expand");
  for (const url of urls) assert.ok(url.length <= 8192);
});

test("oversized pending close completes through Save", async (context) => {
  const pending = await openOversizedPendingClose(context, "Pending save draft");
  const { window, dialog, column, act, urls, store } = pending;
  const save = pending.save;
  assert.equal(window.history.length, 2);
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.match(dialog.textContent ?? "", /too long to include these charts/);
  const closed = waitForPopstate(window, "save did not navigate back");
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await closed;
  await act(async () => {});
  assert.equal(dialog.open, false);
  const savedTitles = store.getSnapshot().charts.definitions.map((entry) => entry.title);
  assert.ok(savedTitles.includes("Pending save draft"));
  assert.equal(store.getSnapshot().charts.definitions.length, 32);
  assert.equal(window.history.state, null);
  assert.equal(pending.pushedUrls.length, 2);
  assert.equal(window.location.href, pending.retainedUrl);
  assert.ok(window.location.href.length <= 8192);
  assert.equal(window.location.href.includes("charts="), false);
  const expand = column.querySelector(".expand") as HTMLButtonElement;
  assert.ok(document.activeElement === expand, "closing returns focus to Expand");
  for (const url of urls) assert.ok(url.length <= 8192);
});

test("initial oversized entry clears its warning on a fitting edit", async (context) => {
  const scene = makeChartableIntegrationScene();
  const oversized = await oversizedSlice(scene.layers);
  const { createSceneStore } = await import("./scene-store.ts");
  const { encodeSlice, STORAGE_DENIED_NOTICE } = await import("./charts/state.ts");
  const store = createSceneStore(
    scene.layers,
    { layers: {}, off: new Set(), showAs: {} },
    oversized,
  );
  const huge = encodeSlice(oversized);
  const setup = await enterOwnerPanel(context, { chartsToken: huge, mountStore: store, scene });
  const { window, harness, dialog, column, act, urls } = setup;
  assert.equal(window.location.href.includes("charts="), false);
  assert.equal(window.history.length, 1);
  assert.equal(window.history.state, null);

  const chartsTab = [...column.querySelectorAll("button")].find(
    (button) => button.textContent === "Charts",
  )!;
  await act(async () => {
    chartsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const expand = column.querySelector(".expand") as HTMLButtonElement;
  await act(async () => {
    expand.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.equal(window.history.length, 2);
  assert.match(dialog.textContent ?? "", /too long to include these charts/);
  const entryUrl = window.location.href;
  assert.ok(entryUrl.length <= 8192);
  assert.equal(entryUrl.includes("charts="), false);

  await act(async () => {
    harness.onChartSync!(STORAGE_DENIED_NOTICE);
  });
  assert.match(dialog.textContent ?? "", /kept for this visit/);
  await act(async () => {
    harness.onChartSync!(null);
  });
  assert.match(dialog.textContent ?? "", /too long to include these charts/);
  assert.equal((dialog.textContent ?? "").includes("kept for this visit"), false);

  await act(async () => {
    store.dispatch({
      kind: "display",
      update: (next) => {
        next.layers.rain = { palette: "cividis" };
      },
    });
  });
  assert.equal(window.location.href, entryUrl);
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.equal(window.history.length, 2);
  assert.match(dialog.textContent ?? "", /too long to include these charts/);

  await act(async () => {
    (harness.onTime as (time: string | null, label: string | null) => void)(
      "2020-02-01",
      "2020-02",
    );
  });
  assert.equal(window.location.href, entryUrl);
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.equal(window.history.length, 2);

  await act(async () => {
    store.dispatch({ kind: "resetCharts" });
  });
  assert.match(window.location.href, /charts=/);
  assert.ok(window.location.href.includes("cividis"));
  assert.ok(window.location.href.includes("t=2020-02"));
  assert.ok(window.location.href.length <= 8192);
  assert.equal(
    (dialog.textContent ?? "").includes("too long to include these charts"),
    false,
  );
  assert.ok(dialog.querySelector(".chart-gallery"));
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.equal(window.history.length, 2);
  for (const url of urls) assert.ok(url.length <= 8192);
});

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
  context.after(async () => {
    const { act } = await import("react");
    await act(async () => {});
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

const THROWING_REGISTRY_STUB = "export const LAYER_KINDS=new Map(["
  + "['field',{stack:1,create:({layer})=>{if(layer.id==='temp')throw new Error('renderer failed');"
  + "return{parts:[{id:layer.id,label:layer.id,layerIds:[layer.id]}],"
  + "show(){},destroy(){},setTime(){},legend:()=>null};}}],"
  + "['categorical',{stack:0,create:({layer})=>{"
  + "if(layer.id==='geology')throw new Error('renderer failed');"
  + "return{parts:[{id:layer.id,label:layer.id,layerIds:[layer.id]}],"
  + "show(){},destroy(){},setTime(){},legend:()=>null};}}]]);";
const FIELD_REGISTRY_STUB = "export const LAYER_KINDS=new Map([['field',{stack:1,"
  + "create:()=>({parts:[{id:'rain',label:'rain',layerIds:['rain']}],"
  + "show(){},destroy(){},setTime(){},legend:()=>null})}]]);";

function makeWaterMap() {
  const order: string[] = [];
  return {
    getLayersOrder: () => [...order],
    addSource() {},
    addLayer: (spec: { id: string }, beforeId?: string) => {
      const index = beforeId ? order.indexOf(beforeId) : order.length;
      order.splice(index < 0 ? order.length : index, 0, spec.id);
    },
    setLayoutProperty() {},
    addControl() {},
    removeControl() {},
    getSource() {},
    getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
    removeLayer: (id: string) => {
      order.splice(order.indexOf(id), 1);
    },
    removeSource() {},
    getStyle: () => ({
      layers: [
        {
          id: "water",
          type: "fill",
          source: "openmaptiles",
          "source-layer": "water",
          paint: { "fill-color": "rgb(158,189,255)" },
        },
      ],
    }),
  };
}

async function importViewWithStubs(registryStub: string) {
  const { registerHooks: registerInner } = await import("node:module");
  const viewUrl = new URL("./view.ts", import.meta.url).href;
  const viewHooks = registerInner({
    resolve(specifier, context, next) {
      if (typeof specifier === "string" && specifier.endsWith(".css")) {
        return { url: "data:text/javascript,export default {}", shortCircuit: true };
      }
      if (context?.parentURL === viewUrl) {
        if (specifier === "./map") {
          const stub = "export const firstSymbolId=()=>undefined;"
            + "export const removeLayerAndSource=()=>{};"
            + "export const showScaleBar=()=>()=>{};";
          return {
            url: `data:text/javascript,${stub}`,
            shortCircuit: true,
          };
        }
        if (specifier === "./data") {
          return {
            url: "data:text/javascript,export const openStore=async()=>({});",
            shortCircuit: true,
          };
        }
        if (specifier === "./api") {
          return {
            url: "data:text/javascript,export const loadAreaFeature=async()=>({});",
            shortCircuit: true,
          };
        }
        if (specifier === "./layers/blend") {
          const stub = "export const BLEND_TITLE='Blend';"
            + "export const createBlendView=()=>null;";
          return {
            url: `data:text/javascript,${stub}`,
            shortCircuit: true,
          };
        }
        if (specifier === "./layers/registry") {
          return { url: `data:text/javascript,${registryStub}`, shortCircuit: true };
        }
        if (specifier === "./ui/scene-column") {
          return {
            url: "data:text/javascript,export const mountSceneColumn=()=>({unmount(){}});",
            shortCircuit: true,
          };
        }
      }
      return next(specifier, context);
    },
  });
  const { mountScene } = await import("./view.ts");
  viewHooks.deregister();

  return mountScene;
}

async function enterOwnerPanel(
  context: { after(hook: () => void | Promise<void>): void },
  options: { chartsToken?: string; mountStore?: unknown; scene?: Scene } = {},
) {
  const window = new Window({ url: "https://example.test/a/?scene=test" });
  context.after(async () => {
    await exitActiveHarness();
    window.happyDOM.abort();
  });
  const harness = createHarness();
  installBrowser(context, window);
  (globalThis as Record<string, unknown>).location = window.location;
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
  if (options.chartsToken !== undefined) testState.initialCharts = options.chartsToken;
  if (options.mountStore !== undefined) testState.mountStore = options.mountStore;
  const column = document.createElement("div");
  const timeBar = document.createElement("div");
  const dialog = makeIntegrationDialog();
  document.body.append(column, timeBar, dialog);
  const roots = harness.roots as unknown as Record<string, unknown>;
  roots.column = column;
  roots.timeBar = timeBar;
  roots.dialog = dialog;
  const urls: string[] = [];
  // Count pushes because happy-dom truncates forward entries on replaceState after Back.
  const pushedUrls: string[] = [];
  const originalPush = window.history.pushState.bind(window.history);
  window.history.pushState = (next: unknown, title: string, url: string) => {
    urls.push(url);
    pushedUrls.push(url);
    return (originalPush as (...pushArgs: [unknown, string, string]) => void)(
      next,
      title,
      url,
    );
  };
  const originalReplace = window.history.replaceState.bind(window.history);
  window.history.replaceState = (next: unknown, title: string, url: string) => {
    urls.push(url);
    return (originalReplace as (...replaceArgs: [unknown, string, string]) => void)(
      next,
      title,
      url,
    );
  };
  window.addEventListener("popstate", () => {
    const tab = (window.history.state as { panel?: string } | null)?.panel ?? null;
    // Browser popstate arrives async, so routing waits past the committing act.
    queueMicrotask(() => harness.mode.showFullscreen(tab));
  });
  const scene = options.scene ?? makeIntegrationScene();
  await act(async () => {
    harness.mode.enter(scene, { time: null, entry: "replace" });
  });
  // Committed store actions reach the owner like the real mount's subscription does.
  const wired = (options.mountStore ?? harness.mountStore) as {
    getSnapshot(): { charts: unknown; display: unknown };
    subscribe(listener: () => void): () => void;
  };
  if (wired && typeof wired.subscribe === "function") {
    const { encodeSlice } = await import("./charts/state.ts");
    const { formatDisplayParams } = await import("./display-state.ts");
    let previousCharts = wired.getSnapshot().charts;
    let previousDisplay = wired.getSnapshot().display;
    wired.subscribe(() => {
      const snapshot = wired.getSnapshot() as {
        charts: Parameters<typeof encodeSlice>[0];
        display: Parameters<typeof formatDisplayParams>[0];
      };
      if (snapshot.charts !== previousCharts) {
        previousCharts = snapshot.charts;
        harness.onCharts?.(encodeSlice(snapshot.charts));
      }
      if (snapshot.display !== previousDisplay) {
        previousDisplay = snapshot.display;
        harness.onDisplay?.(formatDisplayParams(snapshot.display, scene.layers));
      }
    });
  }

  return { window, harness, dialog, column, act, urls, pushedUrls, store: wired };
}

async function dirtyOwnerEditor(
  setup: Awaited<ReturnType<typeof enterOwnerPanel>>,
  title: string,
) {
  const { window, dialog, act } = setup;
  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const input = dialog.querySelector('.chart-editor input[type="text"]') as HTMLInputElement;
  await act(async () => {
    input.focus();
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    native?.set?.call(input, title);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });

  return input;
}

async function openOversizedPendingClose(
  context: { after(hook: () => void): void },
  title: string,
) {
  const scene = makeChartableIntegrationScene();
  const oversized = await oversizedSlice(scene.layers);
  const { createSceneStore } = await import("./scene-store.ts");
  const { encodeSlice } = await import("./charts/state.ts");
  const store = createSceneStore(
    scene.layers,
    { layers: {}, off: new Set(), showAs: {} },
    oversized,
  );
  const before = JSON.stringify(store.getSnapshot().charts);
  const huge = encodeSlice(oversized);
  const setup = await enterOwnerPanel(context, { chartsToken: huge, mountStore: store, scene });
  const { window, dialog, column, act } = setup;
  assert.equal(window.history.state, null);
  assert.equal(window.location.href.includes("charts="), false);
  const retainedUrl = window.location.href;

  const chartsTab = [...column.querySelectorAll("button")].find(
    (button) => button.textContent === "Charts",
  )!;
  await act(async () => {
    chartsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const expand = column.querySelector(".expand") as HTMLButtonElement;
  await act(async () => {
    expand.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.match(dialog.textContent ?? "", /too long to include these charts/);

  const input = await dirtyOwnerEditor(setup, title);
  const popped = waitForPopstate(window, "browser Back did not navigate");
  await act(async () => {
    window.history.back();
  });
  await popped;
  await act(async () => {});
  assert.deepEqual(window.history.state, { panel: "charts" });
  assert.ok(dialog.querySelector(".chart-confirm"));
  const save = [...dialog.querySelectorAll(".chart-confirm button")].find(
    (button) => button.textContent === "Save",
  ) as HTMLButtonElement;
  assert.ok(
    document.activeElement === save,
    "outer confirmation moves focus to its Save control",
  );

  return { ...setup, store, before, input, save, retainedUrl };
}

async function oversizedSlice(layers: unknown) {
  const { defaultSlice, isValidSlice } = await import("./charts/state.ts");
  const seed = defaultSlice(layers as never[]);
  const first = seed.definitions[0];
  const definitions = Array.from({ length: 32 }, (_, index) => ({
    ...first,
    id: `oversized-${index}`,
    title: `Oversized ${String(index)} ${"T".repeat(100)}`.slice(0, 120),
  }));
  const slice = { version: 1 as const, definitions, mainChartId: "oversized-0" };
  assert.ok(isValidSlice(slice, layers as never[]));

  return slice;
}

async function oversizedSliceToken(layers: unknown) {
  const { encodeSlice } = await import("./charts/state.ts");

  return encodeSlice(await oversizedSlice(layers));
}

function makeChartableIntegrationScene(): Scene {
  const scene = makeIntegrationScene();
  const layers = JSON.parse(JSON.stringify(scene.layers)) as unknown[];
  const rain = layers[0] as Record<string, unknown>;
  rain.time = {
    step: "P1M",
    values: ["2020-01-01", "2020-02-01"],
    end: "2020-03-01",
    method: "sum",
  };
  rain.area_series = {
    statistic: "mean",
    weights: "cell_area_inside_outline",
    values: [10, 12],
    valid_fraction: [1, 1],
  };
  const terrain = layers[1] as Record<string, unknown>;
  terrain.distribution = {
    statistic: "quantiles",
    weights: "cell_area_inside_outline",
    percent: 1,
    values: Array.from({ length: 101 }, (_, index) => index * 10),
    min: 0,
    max: 1000,
    mean: 500,
    valid_fraction: 0.9,
    reference_values: [],
  };

  return { ...scene, layers } as unknown as Scene;
}

async function waitForPopstate(window: Window, label: string) {
  await Promise.race([
    new Promise((resolve) => {
      window.addEventListener("popstate", () => resolve(null), { once: true });
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), 5 * 1000);
    }),
  ]);
}
