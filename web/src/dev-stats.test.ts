import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
import type { AsyncReadable } from "zarrita";

import { assertSameNode } from "./testing/dom-assert.ts";
import {
  beginPreload,
  DevStatsLoop,
  formatBytes,
  formatDevStats,
  formatGpuPart,
  formatPreloadPart,
  formatTileSettlePart,
  framesPerSecond,
  layerForSource,
  entryStats,
  noteEntryGap,
  noteEntryWait,
  noteSceneOpen,
  noteSceneReady,
  notePreloadHit,
  notePreloadMiss,
  preloadSnapshot,
  pruneStamps,
  renderDevStats,
  sceneLoadStats,
  setPreloadDisabled,
  setPreloadProgress,
  shouldShowDevStats,
  startDevStats,
  TileSettleTracker,
  worstFrameMs,
} from "./dev-stats.ts";
import { fetchStats, mergingStore, noteFetch, resetFetchStats } from "./merging-store.ts";

test("dev builds show the readout without the query", () => {
  assert.equal(shouldShowDevStats(true, ""), true);
  assert.equal(shouldShowDevStats(true, "?debug"), true);
});

test("production shows the readout only with debug", () => {
  assert.equal(shouldShowDevStats(false, "?debug"), true);
  assert.equal(shouldShowDevStats(false, ""), false);
  assert.equal(shouldShowDevStats(false, "?scene=test"), false);
});

test("a debug value still enables the readout", () => {
  assert.equal(shouldShowDevStats(false, "?debug=1"), true);
  assert.equal(shouldShowDevStats(false, "debug"), true);
});

test("the frame count covers only the last second", () => {
  const stamps = [4000, 4001, 4500, 4999, 5000];

  assert.equal(framesPerSecond(stamps, 5000), 5);
  assert.equal(framesPerSecond(stamps, 5500), 3);
  assert.equal(framesPerSecond([], 5000), 0);
});

test("the worst frame is the longest gap between stamps", () => {
  assert.equal(worstFrameMs([]), 0);
  assert.equal(worstFrameMs([100]), 0);
  assert.equal(worstFrameMs([0, 16, 32, 48]), 16);
  assert.equal(worstFrameMs([0, 16, 32, 100]), 68);
});

test("pruning keeps only the last five seconds", () => {
  assert.deepEqual(pruneStamps([0, 4999, 5000, 10000], 10000), [5000, 10000]);
  assert.deepEqual(pruneStamps([], 10000), []);
});

test("byte counts use binary units with one decimal", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});

test("the badge line stays compact with a missing load", () => {
  const text = formatDevStats({
    fps: 60,
    worstMs: 33,
    zoom: 5.25,
    loadMs: null,
    requests: 2,
    bytes: 1536,
    gpuMs: {},
    gpuUnavailable: true,
    longtasks: 0,
  });

  assert.equal(text, "60 fps · worst 33 ms · z 5.3 · load — · 2 req 1.5 KB · gpu n/a\n0 long");
});

test("the badge line rounds the load time", () => {
  const text = formatDevStats({
    fps: 59,
    worstMs: 50,
    zoom: 4,
    loadMs: 842.4,
    requests: 14,
    bytes: 512,
    gpuMs: { "geology-classes": 6.14, "rain-dots": 0.94 },
    gpuUnavailable: false,
    longtasks: 3,
  });

  assert.equal(
    text,
    "59 fps · worst 50 ms · z 4.0 · load 842 ms · 14 req 512 B"
      + " · gpu geology-classes 6.1 ms rain-dots 0.9 ms\n3 long",
  );
});

test("the gpu part shows n/a without timings or the extension", () => {
  assert.equal(formatGpuPart({}, false), "gpu n/a");
  assert.equal(formatGpuPart({}, true), "gpu n/a");
  assert.equal(formatGpuPart({ "rain-dots": 1 }, true), "gpu n/a");
});

test("the gpu part lists per-layer timings in name order", () => {
  assert.equal(
    formatGpuPart({ "rain-dots": 0.94, "geology-classes": 6.14 }, false),
    "gpu geology-classes 6.1 ms rain-dots 0.9 ms",
  );
});

test("the scene timing measures open to drawn", () => {
  noteSceneOpen(1000);

  assert.equal(sceneLoadStats.loadMs, null);

  noteSceneReady(1842);

  assert.equal(sceneLoadStats.loadMs, 842);
});

test("the entry part shows the wait and the landing gap on the second line", () => {
  const text = formatDevStats({
    fps: 60,
    worstMs: 33,
    zoom: 5.25,
    loadMs: null,
    requests: 2,
    bytes: 1536,
    gpuMs: {},
    gpuUnavailable: true,
    longtasks: 0,
    entry: { waitMs: 1240.4, gapMs: 17.6 },
  });

  assert.equal(
    text,
    "60 fps · worst 33 ms · z 5.3 · load — · 2 req 1.5 KB · gpu n/a\n"
      + "entry wait 1240 ms gap 18 ms · 0 long",
  );
});

test("the entry part shows a dash until the fade has started", () => {
  noteSceneOpen(0);
  noteEntryWait(900);

  assert.deepEqual({ ...entryStats }, { waitMs: 900, gapMs: null });

  noteEntryGap(20);

  assert.deepEqual({ ...entryStats }, { waitMs: 900, gapMs: 20 });

  noteSceneOpen(0);

  assert.deepEqual({ ...entryStats }, { waitMs: null, gapMs: null });
});

test("the fetch counter totals covering requests", () => {
  resetFetchStats();
  noteFetch(10);
  noteFetch(24);

  assert.equal(fetchStats.requests, 2);
  assert.equal(fetchStats.bytes, 34);

  resetFetchStats();

  assert.equal(fetchStats.requests, 0);
  assert.equal(fetchStats.bytes, 0);
});

test("one tick of ranges counts one covering request", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  resetFetchStats();
  const source = rangeSource();
  const store = mergingStore(source.store);
  const asked = [
    store.getRange!("/a", { offset: 10, length: 5 }),
    store.getRange!("/a", { offset: 15, length: 5 }),
  ];
  context.mock.timers.tick(1);
  await Promise.all(asked);

  assert.equal(fetchStats.requests, 1);
  assert.equal(fetchStats.bytes, 10);
  assert.deepEqual(source.requests, [{ key: "/a", offset: 10, length: 10 }]);

  resetFetchStats();
});

test("a suffix read counts one request with its bytes", async () => {
  resetFetchStats();
  const source = rangeSource();
  const store = mergingStore(source.store);
  const tail = await store.getRange!("/a", { suffixLength: 3 });

  assert.deepEqual([...tail!], [97, 98, 99]);
  assert.equal(fetchStats.requests, 1);
  assert.equal(fetchStats.bytes, 3);

  resetFetchStats();
});

test("a metadata read counts one request with its bytes", async () => {
  resetFetchStats();
  const store = mergingStore(metaSource());
  const bytes = await store.get("/a");

  assert.equal(bytes?.byteLength, 5);
  assert.equal(fetchStats.requests, 1);
  assert.equal(fetchStats.bytes, 5);

  resetFetchStats();
});

test("a short covering read credits only the bytes returned", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  resetFetchStats();
  const store = mergingStore(shortRangeSource());

  const asked = store.getRange!("/a", { offset: 10, length: 10 });
  context.mock.timers.tick(1);
  const bytes = await asked;

  assert.equal(bytes?.byteLength, 3);
  assert.equal(fetchStats.requests, 1);
  assert.equal(fetchStats.bytes, 3);

  resetFetchStats();
});

test("a failed covering read counts the request without bytes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  resetFetchStats();
  const store = mergingStore(failingRangeSource());

  const asked = [0, 4].map((offset) => {
    return store.getRange!("/a", { offset, length: 4 }).then(() => "ok", () => "failed");
  });
  context.mock.timers.tick(1);

  assert.deepEqual(await Promise.all(asked), ["failed", "failed"]);
  assert.equal(fetchStats.requests, 1);
  assert.equal(fetchStats.bytes, 0);

  resetFetchStats();
});

test("rendering writes the badge and keeps its node", () => {
  const window = new Window({ url: "http://localhost/" });
  const badge = window.document.createElement("div");
  badge.id = "dev-stats";
  window.document.body.append(badge);
  try {
    renderDevStats(badge, "60 fps · worst 16 ms");

    assert.equal(badge.textContent, "60 fps · worst 16 ms");
    assertSameNode(badge, window.document.getElementById("dev-stats"));
  } finally {
    window.happyDOM.abort();
  }
});

test("a second start keeps one frame chain", () => {
  const window = new Window({ url: "http://localhost/" });
  const stubs = installFrameStubs(window);
  try {
    const badge = window.document.createElement("div");
    badge.hidden = true;
    window.document.body.append(badge);
    const loop = new DevStatsLoop(badge, { getZoom: () => 5 });
    loop.start();
    loop.start();

    assert.equal(stubs.scheduled.length, 1);
    assert.equal(badge.hidden, false);

    loop.stop();

    assert.equal(badge.hidden, true);
    assert.equal(window.document.body.classList.contains("has-dev-stats"), false);
    assert.deepEqual(stubs.cancelled, [1]);
  } finally {
    stubs.restore();
    window.happyDOM.abort();
  }
});

test("stopping the readout hides the badge and frees the panel", () => {
  const window = new Window({ url: "http://localhost/" });
  const stubs = installFrameStubs(window);
  try {
    const badge = window.document.createElement("div");
    badge.hidden = true;
    window.document.body.append(badge);
    const stop = startDevStats(badge, { getZoom: () => 5 });

    assert.equal(badge.hidden, false);
    assert.equal(window.document.body.classList.contains("has-dev-stats"), true);

    stop();

    assert.equal(badge.hidden, true);
    assert.equal(window.document.body.classList.contains("has-dev-stats"), false);
    assert.deepEqual(stubs.cancelled, [1]);
  } finally {
    stubs.restore();
    window.happyDOM.abort();
  }
});

interface FrameStubs {
  scheduled: FrameRequestCallback[];
  cancelled: number[];
  restore(): void;
}

function installFrameStubs(window: Window): FrameStubs {
  const target = globalThis as unknown as Record<string, unknown>;
  const previousDocument = target.document;
  const previousSchedule = target.requestAnimationFrame;
  const previousCancel = target.cancelAnimationFrame;
  const scheduled: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  let nextId = 0;
  target.document = window.document;
  target.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    scheduled.push(callback);
    nextId += 1;
    return nextId;
  };
  target.cancelAnimationFrame = (id: number): void => {
    cancelled.push(id);
  };

  const restore = (): void => {
    target.document = previousDocument;
    target.requestAnimationFrame = previousSchedule;
    target.cancelAnimationFrame = previousCancel;
  };

  return { scheduled, cancelled, restore };
}

function metaSource(): AsyncReadable {
  return {
    async get() {
      return Uint8Array.from([1, 2, 3, 4, 5]);
    },
    async getRange() {
      return undefined;
    },
  };
}

function shortRangeSource(): AsyncReadable {
  return {
    async get() {
      return undefined;
    },
    async getRange() {
      return Uint8Array.from([1, 2, 3]);
    },
  };
}

function failingRangeSource(): AsyncReadable {
  return {
    async get() {
      return undefined;
    },
    async getRange() {
      throw new Error("failed");
    },
  };
}

interface RangeRequest {
  key: string;
  offset: number;
  length: number;
}

function rangeSource(): { store: AsyncReadable; requests: RangeRequest[] } {
  const bytes = Uint8Array.from({ length: 100 }, (_, index) => index % 256);
  const requests: RangeRequest[] = [];
  const store: AsyncReadable = {
    async get() {
      return undefined;
    },
    async getRange(key, range) {
      if ("suffixLength" in range) return bytes.slice(bytes.length - range.suffixLength);
      requests.push({ key: key as string, offset: range.offset, length: range.length });

      return bytes.slice(range.offset, range.offset + range.length);
    },
  };

  return { store, requests };
}

test("tile sources map to their readout layers", () => {
  assert.equal(layerForSource("terrain-relief"), "terrain");
  assert.equal(layerForSource("my-scene-relief"), "terrain");
  assert.equal(layerForSource("terrain-contours"), "contours");
  assert.equal(layerForSource("openmaptiles"), "basemap");
  assert.equal(layerForSource("rain"), null);
  assert.equal(layerForSource(undefined), null);
});

test("the tile readout stays empty without a gesture", () => {
  const tracker = new TileSettleTracker({ getZoom: () => 8 }, () => 1000);
  tracker.start();

  assert.deepEqual(tracker.snapshot(), {
    terrain: { settleMs: null, requests: 0 },
    basemap: { settleMs: null, requests: 0 },
    contours: { settleMs: null, requests: 0 },
  });
  tracker.stop();
});

test("a zoom gesture counts requests and times each layer until loaded", () => {
  let now = 1000;
  const map = tileMap(() => 8);
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-relief" });
  map.emit("sourcedataloading", { sourceId: "terrain-relief" });
  map.emit("sourcedataloading", { sourceId: "openmaptiles" });
  map.emit("zoom", {});
  now += 120;
  map.emit("sourcedata", { sourceId: "terrain-relief", isSourceLoaded: true });
  map.emit("zoomend", {});
  map.emit("moveend", {});

  const settled = tracker.snapshot();
  assert.equal(settled.terrain.requests, 2);
  assert.equal(settled.terrain.settleMs, 120);
  assert.equal(settled.basemap.requests, 1);
  assert.equal(settled.basemap.settleMs, null);

  map.loaded.add("openmaptiles");
  now += 60;
  map.emit("idle", {});
  assert.equal(tracker.snapshot().basemap.settleMs, 180);
  tracker.stop();
});

test("a loading-loaded-end sequence keeps its requests and settle time", () => {
  let now = 1000;
  const map = tileMap(() => 8);
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "openmaptiles" });
  now += 40;
  map.emit("sourcedata", { sourceId: "openmaptiles", isSourceLoaded: true });
  map.emit("zoomend", {});
  map.emit("moveend", {});

  assert.deepEqual(tracker.snapshot().basemap, { settleMs: 40, requests: 1 });
  tracker.stop();
});

test("moveend settles already-loaded sources with no further events", () => {
  let now = 1000;
  const map = tileMap(() => 8);
  map.loaded.add("terrain-contours");
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-contours" });
  now += 40;
  map.emit("moveend", {});

  assert.deepEqual(tracker.snapshot().contours, { settleMs: 40, requests: 1 });
  tracker.stop();
});

test("idle settles loaded sources after an unresolved moveend", () => {
  let now = 1000;
  const map = tileMap(() => 8);
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-relief" });
  map.emit("moveend", {});

  assert.equal(tracker.snapshot().terrain.settleMs, null);

  map.loaded.add("terrain-relief");
  now += 80;
  map.emit("idle", {});

  assert.equal(tracker.snapshot().terrain.settleMs, 80);
  tracker.stop();
});

test("a new gesture resets the previous counts", () => {
  const map = tileMap(() => 8);
  const tracker = new TileSettleTracker(map, () => 1000);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-contours" });
  map.emit("moveend", {});
  map.emit("movestart", {});

  assert.deepEqual(tracker.snapshot().contours, { settleMs: null, requests: 0 });
  tracker.stop();
});

test("a zoomstart outside a gesture opens a step without resetting mid-gesture", () => {
  const map = tileMap(() => 8);
  const tracker = new TileSettleTracker(map, () => 1000);
  tracker.start();

  map.emit("zoomstart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-relief" });
  map.emit("zoomstart", {});

  assert.equal(tracker.snapshot().terrain.requests, 1);
  tracker.stop();
});

test("the bubbled dataloading event counts nothing on its own", () => {
  const map = tileMap(() => 8);
  const tracker = new TileSettleTracker(map, () => 1000);
  tracker.start();

  map.emit("movestart", {});
  map.emit("dataloading", { sourceId: "terrain-relief" });

  assert.equal(tracker.snapshot().terrain.requests, 0);
  tracker.stop();
});

test("the tracker falls back to isSourceLoaded and ignores unknown sources", () => {
  let now = 1000;
  const map = tileMap(() => 8);
  map.loaded.add("terrain-contours");
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "rain" });
  now += 40;
  map.emit("sourcedata", { sourceId: "terrain-contours" });

  const settled = tracker.snapshot();
  assert.equal(settled.contours.settleMs, 40);
  assert.equal(settled.terrain.requests, 0);
  tracker.stop();
});

test("a gesture with no source events settles cached style sources", () => {
  let now = 1000;
  const map = tileMap(() => 8);
  map.loaded.add("terrain-relief");
  map.loaded.add("openmaptiles");
  map.loaded.add("terrain-contours");
  (map as unknown as { getStyle: () => { sources: Record<string, object> } }).getStyle = () => ({
    sources: {
      "terrain-relief": {},
      "openmaptiles": {},
      "terrain-contours": {},
    },
  });
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  now += 50;
  map.emit("moveend", {});

  const settled = tracker.snapshot();
  assert.equal(settled.terrain.settleMs, 50);
  assert.equal(settled.basemap.settleMs, 50);
  assert.equal(settled.contours.settleMs, 50);
  assert.equal(settled.terrain.requests, 0);

  map.loaded.clear();
  map.emit("movestart", {});
  now += 30;
  map.emit("moveend", {});

  assert.equal(tracker.snapshot().terrain.settleMs, null);
  tracker.stop();
});

test("a second load wave in one gesture reopens until all sources load", () => {
  let now = 1000;
  const map = tileMap(() => 8);
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-relief" });
  map.emit("sourcedataloading", { sourceId: "my-scene-relief" });
  now += 40;
  map.emit("sourcedata", { sourceId: "terrain-relief", isSourceLoaded: true });

  assert.equal(tracker.snapshot().terrain.settleMs, null);

  map.loaded.add("terrain-relief");
  map.loaded.add("my-scene-relief");
  now += 40;
  map.emit("sourcedata", { sourceId: "my-scene-relief", isSourceLoaded: true });

  assert.equal(tracker.snapshot().terrain.settleMs, 80);

  map.emit("sourcedataloading", { sourceId: "terrain-relief" });

  assert.equal(tracker.snapshot().terrain.settleMs, null);

  map.loaded.delete("terrain-relief");
  map.emit("moveend", {});

  assert.equal(tracker.snapshot().terrain.settleMs, null);

  map.loaded.add("terrain-relief");
  now += 100;
  map.emit("sourcedata", { sourceId: "terrain-relief", isSourceLoaded: true });

  assert.deepEqual(tracker.snapshot().terrain, { settleMs: 180, requests: 3 });
  tracker.stop();
});

test("a removed source never queries its manager after delete-before-metadata", () => {
  let now = 1000;
  const map = removalTileMap(() => 8);
  map.live.add("terrain-contours");
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-contours" });
  map.live.delete("terrain-contours");
  now += 40;
  map.emit("sourcedata", { sourceId: "terrain-contours", isSourceLoaded: false });

  assert.deepEqual(map.errors, []);
  assert.equal(tracker.snapshot().contours.settleMs, 40);
  assert.equal(tracker.snapshot().contours.requests, 1);
  tracker.stop();
});

test("a pending source removed on exit settles without a manager error", () => {
  let now = 1000;
  const map = removalTileMap(() => 8);
  map.live.add("terrain-contours");
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-contours" });
  map.live.delete("terrain-contours");
  now += 50;
  map.emit("moveend", {});

  assert.deepEqual(map.errors, []);
  assert.equal(tracker.snapshot().contours.settleMs, 50);
  tracker.stop();
});

test("a units rebuild keeps waiting for the recreated source without errors", () => {
  let now = 1000;
  const map = removalTileMap(() => 8);
  map.live.add("terrain-relief");
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-relief" });
  map.live.delete("terrain-relief");
  map.emit("sourcedata", { sourceId: "terrain-relief", isSourceLoaded: false });

  assert.deepEqual(map.errors, []);

  map.live.add("terrain-relief");
  map.emit("sourcedataloading", { sourceId: "terrain-relief" });
  map.emit("sourcedata", { sourceId: "terrain-relief", isSourceLoaded: false });

  assert.equal(tracker.snapshot().terrain.settleMs, null);
  assert.deepEqual(map.errors, []);

  map.loaded.add("terrain-relief");
  now += 40;
  map.emit("sourcedata", { sourceId: "terrain-relief", isSourceLoaded: true });

  assert.equal(tracker.snapshot().terrain.settleMs, 40);
  assert.deepEqual(map.errors, []);
  tracker.stop();
});

test("a loaded sibling waits for its pending sibling without errors", () => {
  let now = 1000;
  const map = removalTileMap(() => 8);
  map.live.add("terrain-contours");
  map.live.add("terrain-labels-contours");
  map.loaded.add("terrain-contours");
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-contours" });
  map.emit("sourcedataloading", { sourceId: "terrain-labels-contours" });
  now += 40;
  map.emit("sourcedata", { sourceId: "terrain-contours", isSourceLoaded: true });

  assert.equal(tracker.snapshot().contours.settleMs, null);
  assert.deepEqual(map.errors, []);

  map.loaded.add("terrain-labels-contours");
  now += 40;
  map.emit("sourcedata", { sourceId: "terrain-labels-contours", isSourceLoaded: true });

  assert.equal(tracker.snapshot().contours.settleMs, 80);
  assert.deepEqual(map.errors, []);
  tracker.stop();
});

test("a late removal event after settle leaves the settle time alone", () => {
  let now = 1000;
  const map = removalTileMap(() => 8);
  map.live.add("terrain-contours");
  map.loaded.add("terrain-contours");
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  now += 30;
  map.emit("moveend", {});

  assert.equal(tracker.snapshot().contours.settleMs, 30);

  map.live.delete("terrain-contours");
  map.emit("sourcedata", { sourceId: "terrain-contours", isSourceLoaded: false });

  assert.deepEqual(map.errors, []);
  assert.equal(tracker.snapshot().contours.settleMs, 30);
  tracker.stop();
});

test("a repeat entry after removal starts from live sources only", () => {
  let now = 1000;
  const map = removalTileMap(() => 8);
  map.live.add("terrain-contours");
  const tracker = new TileSettleTracker(map, () => now);
  tracker.start();

  map.emit("movestart", {});
  map.emit("sourcedataloading", { sourceId: "terrain-contours" });
  map.live.delete("terrain-contours");
  now += 20;
  map.emit("moveend", {});

  assert.deepEqual(map.errors, []);
  assert.equal(tracker.snapshot().contours.settleMs, 20);

  map.live.add("openmaptiles");
  map.loaded.add("openmaptiles");
  map.emit("movestart", {});

  assert.deepEqual(tracker.snapshot().contours, { settleMs: null, requests: 0 });

  now += 30;
  map.emit("moveend", {});

  assert.deepEqual(map.errors, []);
  assert.equal(tracker.snapshot().contours.settleMs, 30);
  assert.equal(tracker.snapshot().basemap.settleMs, 30);
  tracker.stop();
});

test("the tile badge part lists each layer once", () => {
  const text = formatTileSettlePart({
    terrain: { settleMs: 120, requests: 12 },
    basemap: { settleMs: null, requests: 0 },
    contours: { settleMs: 80.4, requests: 2 },
  });

  assert.equal(text, "tiles terrain 120 ms 12 req basemap — 0 req contours 80 ms 2 req");
});

test("preload counters accumulate per source and reset when a scene opens", () => {
  beginPreload();
  notePreloadHit("contours");
  notePreloadMiss("contours");
  notePreloadMiss("terrain");
  setPreloadProgress(5, 12, 2048);

  assert.deepEqual(preloadSnapshot(), {
    progress: { done: 5, total: 12, bytes: 2048 },
    counts: {
      terrain: { hits: 0, misses: 1 },
      basemap: { hits: 0, misses: 0 },
      contours: { hits: 1, misses: 1 },
    },
  });
  beginPreload();

  assert.deepEqual(preloadSnapshot().counts.contours, { hits: 0, misses: 0 });
  assert.deepEqual(preloadSnapshot().progress, { done: 0, total: 0, bytes: 0 });
});

test("the preload badge shows progress, hit rates and off when disabled", () => {
  beginPreload();
  const snapshot = {
    progress: { done: 62, total: 246, bytes: 8.1 * 1024 * 1024 },
    counts: {
      terrain: { hits: 91, misses: 9 },
      basemap: { hits: 7, misses: 1 },
      contours: { hits: 0, misses: 0 },
    },
  };
  assert.equal(
    formatPreloadPart(snapshot),
    "preload 62/246 tiles 8.1 MB hit terrain 91% basemap 88% contours —",
  );
  const stats = {
    fps: 60,
    worstMs: 33,
    zoom: 5.25,
    loadMs: null,
    requests: 2,
    bytes: 1536,
    gpuMs: {},
    gpuUnavailable: true,
    longtasks: 0,
  };
  assert.ok(formatDevStats({ ...stats, preload: snapshot }).includes("\npreload 62/246"));
  assert.equal(formatDevStats({ ...stats, preload: preloadSnapshot() }).includes("preload"), false);
  setPreloadDisabled(true);
  try {
    assert.equal(formatPreloadPart(snapshot), "preload off");
    assert.ok(formatDevStats({ ...stats, preload: snapshot }).includes("preload off"));
  } finally {
    setPreloadDisabled(false);
  }
});

test("the badge line gains the tile part only while tracking", () => {
  const plain = formatDevStats({
    fps: 60,
    worstMs: 33,
    zoom: 5.25,
    loadMs: null,
    requests: 2,
    bytes: 1536,
    gpuMs: {},
    gpuUnavailable: true,
    longtasks: 0,
  });
  assert.ok(!plain.includes("tiles"));

  const withTiles = formatDevStats({
    fps: 60,
    worstMs: 33,
    zoom: 5.25,
    loadMs: null,
    requests: 2,
    bytes: 1536,
    gpuMs: {},
    gpuUnavailable: true,
    longtasks: 0,
    tiles: {
      terrain: { settleMs: 120, requests: 3 },
      basemap: { settleMs: null, requests: 0 },
      contours: { settleMs: 40, requests: 1 },
    },
  });
  assert.ok(withTiles.includes("tiles terrain 120 ms 3 req"));
});

function tileMap(zoom: () => number) {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const loaded = new Set<string>();
  return {
    loaded,
    getZoom: zoom,
    isSourceLoaded: (id: string) => loaded.has(id),
    on: (type: string, listener: (event: object) => void) => {
      const entries = listeners.get(type) ?? new Set<(event: object) => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off: (type: string, listener: (event: object) => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: string, event: object) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

// A map double that models MapLibre removal, so missing managers fire an error.
function removalTileMap(zoom: () => number) {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const live = new Set<string>();
  const loaded = new Set<string>();
  const errors: string[] = [];
  return {
    live,
    loaded,
    errors,
    getZoom: zoom,
    getSource: (id: string) => (live.has(id) ? {} : undefined),
    getStyle: () => ({ sources: Object.fromEntries([...live].map((id) => [id, {}])) }),
    isSourceLoaded: (id: string) => {
      if (!live.has(id)) {
        errors.push(`There is no tile manager with ID '${id}'`);
        return false;
      }
      return loaded.has(id);
    },
    on: (type: string, listener: (event: object) => void) => {
      const entries = listeners.get(type) ?? new Set<(event: object) => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off: (type: string, listener: (event: object) => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: string, event: object) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}
