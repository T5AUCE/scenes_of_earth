import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { newContext, trialSpot } from "./browser.mjs";
import { installCache, isFresh, readEntry, writeEntry } from "./cache.mjs";
import {
  classifyFailure,
  contourLegend,
  isSettled,
  nearestPx,
  pickArea,
  sameSample,
  slug,
  viewRecord,
} from "./measure.mjs";
import { getRemainingMs, getRetryDelayMs, postScene } from "./scenes.mjs";
import { isOpen, stopServers } from "./servers.mjs";

test("nearestPx measures to the closest point of a segment, not only its ends", () => {
  const line = [
    [0, 10],
    [100, 10],
  ];

  assert.equal(nearestPx([line], [50, 0]), 10);
  assert.equal(nearestPx([line], [130, 10]), 30);
});

test("nearestPx picks the closest of several lines and tolerates single points", () => {
  const far = [
    [0, 200],
    [10, 200],
  ];

  assert.equal(nearestPx([far, [[3, 4]]], [0, 0]), 5);
  assert.equal(nearestPx([], [0, 0]), null);
});

test("pickArea prefers an id match, then a name match, then the first hit", () => {
  const hits = [
    { id: "a", name: "Nairobi County" },
    { id: "sample:nairobi", name: "Nairobi" },
  ];

  assert.equal(pickArea(hits, "sample:nairobi").id, "sample:nairobi");
  assert.equal(pickArea(hits, "nairobi").id, "sample:nairobi");
  assert.equal(pickArea(hits, "Nairo").id, "a");
  assert.equal(pickArea([], "x"), null);
});

test("classifyFailure separates Mapterhorn, glyph and other requests", () => {
  assert.equal(classifyFailure("https://tiles.mapterhorn.com/6/63/36.webp"), "dem");
  assert.equal(
    classifyFailure("https://tiles.openfreemap.org/fonts/Open%20Sans/0-255.pbf"),
    "glyph",
  );
  assert.equal(classifyFailure("http://127.0.0.1:5173/scenes/x/data.zarr/zarr.json"), "other");
});

test("contourLegend returns only the contour line", () => {
  const text = "Rainfall\nContours every 100 m (bold every 500 m)\nmm";

  assert.equal(contourLegend(text), "Contours every 100 m (bold every 500 m)");
  assert.equal(contourLegend("Rainfall"), null);
});

test("sameSample is false without a previous sample", () => {
  assert.equal(sameSample(null, { labelCount: 1 }), false);
  assert.equal(sameSample({ labelCount: 1 }, { labelCount: 1 }), true);
  assert.equal(sameSample({ labelCount: 1 }, { labelCount: 2 }), false);
});

test("idle samples cannot settle while delayed mask geometry still gates scene data", () => {
  const gated = { sceneReady: false, tilesLoaded: true };
  const ready = { sceneReady: true, tilesLoaded: true };

  assert.equal(isSettled(gated, gated, true), false);
  assert.equal(isSettled(gated, ready, true), false);
  assert.equal(isSettled(ready, ready, true), true);
  assert.equal(isSettled(ready, ready, false), false);
  assert.equal(isSettled(ready, { ...ready, tilesLoaded: false }, true), false);
});

test("the first view keeps failures emitted before the outline is ready", async () => {
  const handlers = new Map();
  const sample = {
    sceneReady: true,
    tilesLoaded: true,
    zoom: 8,
    labelCount: 0,
    lineCount: 0,
    labelLines: [],
    centre: [0, 0],
    cardText: "",
  };
  const mapErrors = ["early map error"];
  const page = {
    on: (event, handler) => handlers.set(event, handler),
    goto: async () => {
      handlers.get("response")({
        status: () => 500,
        url: () => "https://example.test/startup",
      });
      handlers.get("pageerror")(new Error("early JavaScript error"));
    },
    waitForFunction: async () => {},
    evaluate: async (callback) => {
      if (callback.name === "waitForIdle") return true;
      if (callback.name === "takeSample") return sample;
      return mapErrors.splice(0);
    },
    close: async () => {},
  };
  const records = await trialSpot(
    { newPage: async () => page },
    "https://example.test",
    { name: "Startup", enable: [], zooms: ["fitted", "fitted"] },
    "scene",
    { screens: false },
  );

  assert.equal(records[0].failed_requests, 1);
  assert.deepEqual(records[0].error_samples, [
    "pageerror: early JavaScript error",
    "early map error",
  ]);
  assert.equal(records[1].failed_requests, 0);
  assert.equal(records[1].errors, 0);
});

test("slug keeps file names simple", () => {
  assert.equal(slug("Viti Levu (Sigatoka valley)"), "viti-levu-sigatoka-valley");
});

test("viewRecord counts failures by kind and lists each message once", () => {
  const sample = {
    zoom: 12.0004,
    centre: [640, 400],
    labelCount: 2,
    labelLines: [
      [
        [640, 450],
        [700, 450],
      ],
    ],
    lineCount: 40,
    tilesLoaded: true,
    legend: "Contours every 10 m",
  };
  const failures = [{ kind: "dem" }, { kind: "dem" }, { kind: "glyph" }, { kind: "other" }];

  const record = viewRecord({
    spot: "Nairobi",
    scene: "sample:kenya",
    zoom: 12,
    sample,
    failures,
    messages: ["boom", "boom", "bang"],
    timedOut: false,
  });

  assert.equal(record.zoom, "12");
  assert.equal(record.zoom_actual, 12);
  assert.equal(record.nearest_label_px, 50);
  assert.equal(record.dem_404, 2);
  assert.equal(record.glyph_404, 1);
  assert.equal(record.failed_requests, 1);
  assert.equal(record.errors, 2);
});

test("viewRecord reports a view without a sample as not loaded", () => {
  const record = viewRecord({
    spot: "S",
    scene: "x",
    zoom: "fitted",
    sample: null,
    failures: [],
    messages: ["jump failed"],
    timedOut: true,
  });

  assert.equal(record.label_features, null);
  assert.equal(record.tiles_loaded, false);
  assert.equal(record.timed_out, true);
});

test("mutable cache entries require revalidation across runs even before max-age", () => {
  const entry = makeCacheEntry({ "cache-control": "max-age=60" });

  assert.equal(isFresh(entry, 2000, 0), true);
  assert.equal(isFresh(entry, 2000, 1500), false);
  assert.equal(isFresh(entry, 61 * 1000, 0), false);
});

function makeCacheEntry(headers = {}) {
  return { status: 200, headers, storedAtMs: 1000, body: Buffer.from("original") };
}

test("immutable cache entries still respect expiration and upstream age", () => {
  const entry = makeCacheEntry({ "cache-control": "max-age=60, immutable" });

  assert.equal(isFresh(entry, 2000, 1500), true);
  assert.equal(isFresh(entry, 61 * 1000, 1500), false);
  assert.equal(isFresh({ ...entry, headers: { ...entry.headers, age: "60" } }, 2000, 0), false);
});

test("cache freshness honors expires, no-cache and uncacheable responses", () => {
  const entry = makeCacheEntry({ date: new Date(1000).toUTCString() });
  const makeEntryWithControl = (control) => ({
    ...entry,
    headers: { "cache-control": control },
  });

  assert.equal(isFresh(entry, 2000, 0), false);
  assert.equal(isFresh({ ...entry, status: 404 }, 2000, 0), false);
  assert.equal(isFresh(makeEntryWithControl("no-store, max-age=60"), 2000, 0), false);
  assert.equal(isFresh(makeEntryWithControl("private, max-age=60"), 2000, 0), false);
  assert.equal(isFresh(makeEntryWithControl("no-cache, max-age=60"), 2000, 0), false);
  entry.headers.expires = new Date(3000).toUTCString();
  assert.equal(isFresh(entry, 2000, 0), true);
  assert.equal(isFresh(entry, 3000, 0), false);
});

test("atomic cache replacement keeps the old entry readable until publication", (context) => {
  const directory = createTemporaryCache(context);
  const file = path.join(directory, "entry.json");
  const original = makeCacheEntry();
  writeEntry(file, original);
  const rename = fs.renameSync;
  context.mock.method(fs, "renameSync", (temporary, destination) => {
    assert.deepEqual(readEntry(destination), original);
    assert.equal(readEntry(temporary).body.toString(), "replacement");
    rename(temporary, destination);
  });
  writeEntry(file, { ...original, body: Buffer.from("replacement") });

  assert.equal(readEntry(file).body.toString(), "replacement");
  assert.deepEqual(fs.readdirSync(directory), ["entry.json"]);
});

function createTemporaryCache(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "soe-visual-trial-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("failed cache publication leaves the previous entry intact and removes staging", (context) => {
  const directory = createTemporaryCache(context);
  const file = path.join(directory, "entry.json");
  const original = makeCacheEntry();
  writeEntry(file, original);
  context.mock.method(fs, "renameSync", () => {
    throw new Error("interrupted commit");
  });

  assert.throws(() => writeEntry(file, { ...original, body: Buffer.from("new") }), /interrupted/);
  assert.deepEqual(readEntry(file), original);
  assert.deepEqual(fs.readdirSync(directory), ["entry.json"]);
});

test("missing, malformed and mismatched cache entries are misses", (context) => {
  const file = path.join(createTemporaryCache(context), "entry.json");

  assert.equal(readEntry(file), null);
  fs.writeFileSync(file, "{");
  assert.equal(readEntry(file), null);
  fs.writeFileSync(file, "null");
  assert.equal(readEntry(file), null);
  writeEntry(file, makeCacheEntry());
  const serialized = JSON.parse(fs.readFileSync(file, "utf8"));
  const corrupted = { ...serialized, body: Buffer.from("bad").toString("base64") };
  fs.writeFileSync(file, JSON.stringify(corrupted));
  assert.equal(readEntry(file), null);
});

test("cache revalidation sends validators and retains a body on 304", async (context) => {
  const cache = await createCacheHarness(context, [
    { status: 200, headers: { etag: '"version-1"' }, body: "original" },
    { status: 304, headers: { "cache-control": "max-age=60" } },
  ]);
  await cache.request();
  const response = await cache.request();

  assert.equal(cache.fetches[1].headers["if-none-match"], '"version-1"');
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), "original");
});

async function createCacheHarness(context, responses) {
  const directory = createTemporaryCache(context);
  const fetches = [];
  let handler;
  await installCache({ route: async (_pattern, callback) => { handler = callback; } }, directory);

  return {
    directory,
    fetches,
    request: async () => handler({
      request: () => ({
        method: () => "GET",
        url: () => "https://tiles.openfreemap.org/style",
        headers: () => ({}),
      }),
      fetch: async (options) => {
        fetches.push(options);
        const response = responses.shift();
        assert.ok(response, "unexpected upstream request");
        return {
          status: () => response.status,
          headers: () => response.headers ?? {},
          body: async () => Buffer.from(response.body ?? ""),
        };
      },
      fulfill: async (entry) => entry,
    }),
  };
}

test("missing resources are fetched again instead of caching negatives", async (context) => {
  const cache = await createCacheHarness(context, [
    { status: 404, body: "missing" },
    { status: 200, body: "available" },
  ]);
  await cache.request();

  assert.deepEqual(fs.readdirSync(cache.directory), []);
  assert.equal((await cache.request()).body.toString(), "available");
  assert.equal(cache.fetches.length, 2);
});

test("no-store responses never create a cache entry", async (context) => {
  const cache = await createCacheHarness(context, [
    { status: 200, headers: { "cache-control": "no-store" }, body: "private" },
  ]);
  await cache.request();

  assert.deepEqual(fs.readdirSync(cache.directory), []);
});

test("getRemainingMs rejects at the deadline before another request can start", () => {
  assert.equal(getRemainingMs(1000, 900), 100);
  assert.throws(() => getRemainingMs(1000, 1000), /deadline expired/);
  assert.throws(() => getRemainingMs(1000, 1001), /deadline expired/);
});

test("Retry-After supports seconds and dates while capping waits to the budget", () => {
  assert.equal(getRetryDelayMs("60", 2000, 1000), 1000);
  assert.equal(getRetryDelayMs("0", 2000, 1000), 0);
  assert.equal(getRetryDelayMs(null, 2000, 1000), 1000);
  assert.equal(getRetryDelayMs("invalid", 2000, 1000), 1000);
  assert.equal(getRetryDelayMs(new Date(3000).toUTCString(), 5000, 1000), 2000);
  assert.throws(() => getRetryDelayMs("5", 1000, 1000), /deadline expired/);
});

test("repeated POST 503 responses stop at the shared deadline", async (context) => {
  let nowMs = 0;
  let requests = 0;
  context.mock.method(Date, "now", () => nowMs);
  context.mock.method(globalThis, "setTimeout", (callback, delayMs) => {
    nowMs += delayMs;
    queueMicrotask(callback);
  });
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    requests += 1;
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
  });

  await assert.rejects(postScene("https://example.test", {}, 2500), /deadline expired/);
  assert.equal(requests, 3);
  assert.equal(nowMs, 2500);
});

test("an expired POST deadline fails before fetch", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });

  await assert.rejects(postScene("https://example.test", {}, Date.now() - 1), /deadline expired/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("a stalled POST is aborted by its request budget", async (context) => {
  context.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      postScene("https://example.test", {}, Date.now() + 20),
      { name: "TimeoutError" },
    );
  } finally {
    clearInterval(keepAlive);
  }
});

test("readiness instrumentation matches the current app modules without editing them", async () => {
  const routes = [];
  const context = {
    addInitScript: async () => {},
    route: async (pattern, handler) => routes.push({ pattern, handler }),
  };
  await newContext({ newContext: async () => context });
  for (const { pattern, handler } of routes) {
    const module = /\/src\/([^*]+)/.exec(pattern)[1];
    const source = fs.readFileSync(new URL(`../../src/${module}`, import.meta.url), "utf8");
    let instrumented;
    await handler({
      fetch: async () => ({ text: async () => source }),
      fulfill: async ({ body }) => { instrumented = body; },
    });

    assert.notEqual(instrumented, source);
    assert.match(instrumented, /window\.__/);
  }
});

test("port probes resolve even when destroy returns the socket", async (context) => {
  const socket = createFakeSocket(context);
  const probe = isOpen(12345);
  socket.emit("connect");

  assert.equal(await probe, true);
  assert.equal(socket.destroyed, true);
});

function createFakeSocket(context) {
  const socket = new EventEmitter();
  socket.setTimeout = (timeoutMs) => { socket.timeoutMs = timeoutMs; };
  socket.destroy = () => {
    socket.destroyed = true;
    return socket;
  };
  context.mock.method(net, "connect", () => socket);
  return socket;
}

test("port probes are bounded and conservatively report timeout as occupied", async (context) => {
  const socket = createFakeSocket(context);
  const probe = isOpen(12345);

  assert.ok(socket.timeoutMs > 0);
  socket.emit("timeout");
  assert.equal(await probe, true);
  assert.equal(socket.destroyed, true);
});

test("connection refusal reports a free port", async (context) => {
  const socket = createFakeSocket(context);
  const probe = isOpen(12345);
  socket.emit("error", new Error("connection refused"));

  assert.equal(await probe, false);
});

test("repeated shutdown calls share one cleanup promise", async () => {
  const first = stopServers();
  const second = stopServers();

  assert.equal(first, second);
  await first;
});
