import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
import type { AsyncReadable } from "zarrita";

import { assertSameNode } from "./testing/dom-assert.ts";
import {
  DevStatsLoop,
  formatBytes,
  formatDevStats,
  formatGpuPart,
  framesPerSecond,
  noteSceneOpen,
  noteSceneReady,
  pruneStamps,
  renderDevStats,
  sceneLoadStats,
  shouldShowDevStats,
  startDevStats,
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

  assert.equal(text, "60 fps · worst 33 ms · z 5.3 · load — · 2 req 1.5 KB · gpu n/a · 0 long");
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
      + " · gpu geology-classes 6.1 ms rain-dots 0.9 ms · 3 long",
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
