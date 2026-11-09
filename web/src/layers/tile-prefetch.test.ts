/** Bounded destination-aware prefetch: prediction, priority, ownership and lanes. */
import assert from "node:assert/strict";
import { test } from "node:test";

import mlcontour from "maplibre-contour";

import { contourLadder, CONTOUR_OVERZOOM, demParentsForTile } from "../contour-ladder.ts";
import type { BasemapDescriptor } from "../render/tile-viewport.ts";
import {
  BoundedKeySet,
  contourCacheKey,
  PREFETCH_MAX_HTTP_PER_PREDICTION,
  PREFETCH_MAX_PER_SOURCE,
  PREFETCH_NETWORK_LANES,
  PREFETCH_TRACE_LANES,
  tileUrl,
  TilePrefetchScheduler,
  type ContourPrefetchPlan,
  type DemFetcher,
  type HttpWarmer,
  type PrefetchTelemetry,
  type TilePrefetchMap,
} from "./tile-prefetch.ts";

const DEM_TEMPLATE = "https://tiles.example.test/{z}/{x}/{y}.webp";
const LIBERTY_TEMPLATE = "https://tiles.openfreemap.org/planet/20260101_001001_pt/{z}/{x}/{y}.pbf";
const BBOX: [number, number, number, number] = [-15, -15, 15, 15];
const DEM_ESTIMATE_BYTES = 1024 * 1024;
const DECODED_PARENT_BYTES = 4 * 514 * 514;
const WIDE_VIEW = { west: -3, south: -3, east: 3, north: 3 };

test("tile URLs fill the template without scene identity", () => {
  assert.equal(
    tileUrl(DEM_TEMPLATE, { z: 9, x: 1, y: 2 }),
    "https://tiles.example.test/9/1/2.webp",
  );
});

test("contour keys separate options but never scenes", () => {
  const tile = { z: 9, x: 1, y: 2 };
  const first = contourCacheKey(tile, { levels: [50] }, "v1");
  const same = contourCacheKey(tile, { levels: [50] }, "v1");
  const changed = contourCacheKey(tile, { levels: [10] }, "v1");

  assert.equal(first, same);
  assert.notEqual(first, changed);
  assert.ok(!first.includes("Kenya"));
});

test("memo sets forget their oldest key at the cap", () => {
  const keys = new BoundedKeySet(2);
  keys.add("a");
  keys.add("b");
  keys.add("a");
  keys.add("c");

  assert.equal(keys.size, 2);
  assert.ok(keys.has("a") && keys.has("c") && !keys.has("b"));
});

test("traces wait for their counted DEM parents and stay inside every cap", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    frame(t.map, { zoom: 8.2 });
    await settled();

    assert.ok(t.dem.demCalls.length > 0);
    assert.equal(t.dem.traces.length, 0);
    assert.ok(t.dem.demInflight.size + t.http.inflight.size <= PREFETCH_NETWORK_LANES);

    await drainAll(t);

    assert.ok(t.dem.traces.length > 0);
    assert.ok(t.dem.traces.length <= PREFETCH_MAX_PER_SOURCE);
    assert.ok(t.dem.traces.every((call) => call.z === 9));
    assert.ok(t.http.urls.length > 0);
    assert.ok(t.dem.tracePeak <= PREFETCH_TRACE_LANES);
    assert.ok(t.dem.demPeak <= PREFETCH_NETWORK_LANES);
    assert.ok(t.http.peak <= PREFETCH_NETWORK_LANES);
  } finally {
    t.scheduler.destroy();
  }
});

test("completions drain one prediction without resetting its allowance", async () => {
  const t = setup();
  try {
    t.map.state.bounds = WIDE_VIEW;
    frame(t.map, { zoom: 8 });
    frame(t.map, { zoom: 8.2 });
    await settled();
    const before = t.dem.demCalls.length + t.http.urls.length;

    await drainAll(t);

    const started = t.dem.demCalls.length + t.http.urls.length - before;
    assert.ok(started > PREFETCH_NETWORK_LANES);
    assert.ok(started <= PREFETCH_MAX_HTTP_PER_PREDICTION);
    assert.equal(t.scheduler.speculativeUsage().plans, 2);
  } finally {
    t.scheduler.destroy();
  }
});

test("unchanged coverage and sub-tile pans plan once and start nothing new", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    frame(t.map, {});
    await settled();
    const plans = t.scheduler.speculativeUsage().plans;
    const starts = t.dem.demCalls.length + t.http.urls.length;

    for (let step = 1; step <= 6; step += 1) {
      frame(t.map, {
        bounds: { west: -0.5 + step * 0.01, south: -0.5, east: 0.5 + step * 0.01, north: 0.5 },
      });
    }
    frame(t.map, {});
    await settled();

    assert.equal(t.scheduler.speculativeUsage().plans, plans);
    assert.equal(t.dem.demCalls.length + t.http.urls.length, starts);
  } finally {
    t.scheduler.destroy();
  }
});

test("move-plus-zoom pairs keep the measured lookahead", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    frame(t.map, { zoom: 8.2 });
    frame(t.map, { zoom: 8.4 });
    frame(t.map, { zoom: 8.6 });
    await drainAll(t);

    assert.ok(t.dem.traces.length > 0);
    assert.ok(t.dem.traces.every((call) => call.z >= 9));
    assert.ok(t.http.urls.every((url) => /\/(9|10)\//.test(url)));
  } finally {
    t.scheduler.destroy();
  }
});

test("speculation keeps a small share while visible sources load", async () => {
  const t = setup();
  try {
    t.map.state.unloaded.add("terrain-relief");
    frame(t.map, { zoom: 8 });
    frame(t.map, { zoom: 8.2 });
    await settled();

    assert.ok(t.dem.demCalls.length > 0);
    assert.ok(t.dem.demInflight.size + t.http.inflight.size <= PREFETCH_NETWORK_LANES);

    t.map.state.unloaded.delete("terrain-relief");
    t.map.emit("sourcedata", {});
    await settled();

    assert.ok(t.dem.demCalls.length > 0);
  } finally {
    t.scheduler.destroy();
  }
});

test("a reversal cancels the old prediction and plans the new direction", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    frame(t.map, { zoom: 8.2 });
    await settled();
    const plans = t.scheduler.speculativeUsage().plans;
    const aborted = t.dem.demAborted.length;

    frame(t.map, { zoom: 8.1 });
    await settled();

    assert.ok(t.dem.demAborted.length > aborted);
    assert.equal(t.scheduler.speculativeUsage().plans, plans + 1);
    assert.ok(t.dem.demCalls.some((call) => call.z <= 8));
  } finally {
    t.scheduler.destroy();
  }
});

test("a stale DEM rejection holds its lane and never hits its replacement", async () => {
  const t = setup({ settleOnAbort: false });
  try {
    frame(t.map, { zoom: 8 });
    await settled();
    const stale = [...t.dem.demInflight.values()];
    assert.ok(stale.length > 0);

    t.map.emit("sourcedataloading", { sourceId: "terrain-relief" });
    t.map.emit("sourcedata", {});
    await settled();

    assert.equal(t.dem.demCalls.length, stale.length);
    for (const call of stale) call.reject(new Error("aborted"));
    await settled();

    assert.equal(t.dem.demCalls.length, stale.length * 2);
    assert.equal(t.scheduler.speculativeUsage().bytes, t.dem.demInflight.size * DEM_ESTIMATE_BYTES);
    t.scheduler.destroy();
    for (const call of [...t.dem.demInflight.values()]) call.reject(new Error("aborted"));
    await settled();

    assert.equal(t.scheduler.speculativeUsage().bytes, 0);
    assert.equal(t.dem.demCalls.length, stale.length * 2);
  } finally {
    t.scheduler.destroy();
  }
});

test("a stale trace rejection or success never touches its replacement", async () => {
  const t = setup({ settleOnAbort: false });
  try {
    frame(t.map, { zoom: 8 });
    await drainDemOnly(t);
    const stale = [...t.dem.tracePending.values()];
    assert.equal(stale.length, 1);
    const traced = t.dem.traces.length;

    t.map.emit("sourcedataloading", { sourceId: "terrain-relief" });
    t.map.emit("sourcedata", {});
    await settled();

    assert.equal(t.dem.traces.length, traced);
    stale[0].resolve(undefined);
    await settled();

    assert.equal(t.dem.traces.length, traced + 1);
    assert.equal(t.scheduler.speculativeUsage().entries, parentCount(t) + 1);
    const replacement = [...t.dem.tracePending.values()];
    assert.equal(replacement.length, 1);
    const decoded = demParentsForTile(t.dem.traces[0], CONTOUR_OVERZOOM).length
      * DECODED_PARENT_BYTES;
    // The stale trace records its 40-byte body while the replacement still holds its reservation.
    const staleTraceBytes = 40;
    assert.equal(
      t.scheduler.speculativeUsage().bytes,
      parentBytes(t) + decoded + staleTraceBytes + 32 * 1024
        + t.http.inflight.size * 128 * 1024,
    );

    t.scheduler.destroy();
    replacement[0].reject(new Error("aborted"));
    await settled();

    assert.equal(t.scheduler.speculativeUsage().bytes, 0);
    assert.equal(t.dem.traces.length, traced + 1);
  } finally {
    t.scheduler.destroy();
  }
});

test("a stale HTTP rejection never deletes its replacement", async () => {
  const t = setup({ settleOnAbort: false, noDem: true });
  try {
    frame(t.map, { zoom: 8 });
    await settled();
    const stale = [...t.http.inflight.values()];
    assert.ok(stale.length > 0);

    t.map.emit("sourcedataloading", { sourceId: "terrain-relief" });
    t.map.emit("sourcedata", {});
    await settled();

    assert.equal(t.http.urls.length, stale.length);
    for (const call of stale) call.reject(new Error("aborted"));
    await settled();

    assert.equal(t.http.urls.length, stale.length * 2);
    const continued = t.http.urls.slice(stale.length).sort();
    const firstBatch = t.http.urls.slice(0, stale.length).sort();
    assert.ok(continued.every((url) => !firstBatch.includes(url)));
    assert.equal(t.scheduler.speculativeUsage().bytes, t.http.inflight.size * 128 * 1024);
    t.scheduler.destroy();
    for (const call of [...t.http.inflight.values()]) call.reject(new Error("aborted"));
    await settled();

    assert.equal(t.scheduler.speculativeUsage().bytes, 0);
  } finally {
    t.scheduler.destroy();
  }
});

test("stale completions never touch replacements while speculation runs during loads", async () => {
  const t = setup({ settleOnAbort: false });
  try {
    frame(t.map, { zoom: 8 });
    await settled();
    const stale = [...t.dem.demInflight.values()];
    t.map.state.unloaded.add("terrain-relief");
    t.map.emit("sourcedataloading", { sourceId: "terrain-relief" });
    const calls = t.dem.demCalls.length;

    for (const call of stale) call.reject(new Error("aborted"));
    await settled();

    assert.ok(t.dem.demCalls.length > calls);

    t.map.state.unloaded.delete("terrain-relief");
    t.map.emit("idle", {});
    await settled();

    assert.ok(t.dem.demCalls.length > calls);
  } finally {
    t.scheduler.destroy();
  }
});

test("a replaced basemap source cancels speculation and drops old results", async () => {
  const t = setup({ settleOnAbort: false, noDem: true });
  try {
    frame(t.map, { zoom: 8 });
    await settled();
    const stale = [...t.http.inflight.values()];
    assert.ok(stale.length > 0);

    t.state.basemap = { template: LIBERTY_TEMPLATE.replace("20260101", "20270202"), maxzoom: 14 };
    t.map.emit("styledata", {});
    await settled();
    const started = t.http.urls.length;
    const [succeeded, ...rejected] = stale;
    succeeded.resolve(undefined);
    for (const call of rejected) call.reject(new Error("aborted"));
    await settled();

    assert.equal(t.http.urls.length, started);
    assert.equal(t.scheduler.speculativeUsage().entries, 0);
    assert.equal(t.scheduler.speculativeUsage().bytes, 0);

    frame(t.map, {});
    await settled();

    assert.ok(t.http.urls.slice(started).every((url) => url.includes("20270202")));
  } finally {
    t.scheduler.destroy();
  }
});

test("switching contours off drops queued and in-flight speculation", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    await settled();
    assert.ok(t.dem.demInflight.size > 0);

    t.state.plan.enabled = false;
    frame(t.map, { zoom: 8 });
    await settled();

    assert.equal(t.dem.demInflight.size + t.http.inflight.size, 0);
    const calls = t.dem.demCalls.length;
    t.map.emit("sourcedata", {});
    await settled();

    assert.equal(t.dem.demCalls.length, calls);
  } finally {
    t.scheduler.destroy();
  }
});

test("relief clamps to its ceiling while contours and basemap clamp to theirs", async () => {
  const t = setup();
  try {
    t.map.state.zoom = 12.6;
    frame(t.map, {});
    await drainAll(t);

    assert.ok(t.dem.demCalls.some((call) => call.z === 11));
    assert.ok(t.dem.traces.every((call) => call.z === 12));
    assert.ok(t.http.urls.every((url) => url.includes("/12/")));

    t.map.state.zoom = 15.4;
    frame(t.map, {});
    await drainAll(t);

    assert.ok(t.http.urls.some((url) => url.includes("/14/")));
    assert.ok(t.http.urls.every((url) => !url.includes("/15/")));
  } finally {
    t.scheduler.destroy();
  }
});

test("fractional zooms floor vector tiles and cover both relief neighbours", async () => {
  const t = setup();
  try {
    t.map.state.zoom = 8.6;
    frame(t.map, {});
    await drainAll(t);

    assert.ok(t.dem.demCalls.some((call) => call.z === 8));
    assert.ok(t.dem.demCalls.some((call) => call.z === 9));
    assert.ok(t.dem.traces.every((call) => call.z === 8));
    assert.ok(t.http.urls.length > 0);
    assert.ok(t.http.urls.every((url) => url.includes("/8/")));
  } finally {
    t.scheduler.destroy();
  }
});

test("a pure pan warms directional neighbours without a zoom change", async () => {
  const t = setup();
  try {
    frame(t.map, {});
    await drainAll(t);
    const before = t.dem.demCalls.length;

    frame(t.map, { bounds: { west: 0.5, south: -0.5, east: 1.5, north: 0.5 } });
    await settled();

    assert.ok(t.dem.demCalls.length > before);
  } finally {
    t.scheduler.destroy();
  }
});

test("a northern viewport warms northern tiles", async () => {
  const south = setup();
  south.map.state.zoom = 5;
  south.map.state.bounds = { west: -0.5, south: -10.5, east: 0.5, north: -9.5 };
  const north = setup();
  north.map.state.zoom = 5;
  north.map.state.bounds = { west: -0.5, south: 9.5, east: 0.5, north: 10.5 };
  try {
    frame(south.map, {});
    frame(north.map, {});
    await settled();

    const southernmost = Math.max(...south.dem.demCalls.map((call) => call.y));
    assert.ok(north.dem.demCalls.length > 0);
    assert.ok(Math.min(...north.dem.demCalls.map((call) => call.y)) < southernmost);
  } finally {
    south.scheduler.destroy();
    north.scheduler.destroy();
  }
});

test("a dateline pan wraps east instead of reversing", async () => {
  const t = setup({ plan: plan(11, [170, -20, 190, 20]) });
  t.map.state.zoom = 2;
  t.map.state.bounds = { west: 179, south: -0.5, east: 179.9, north: 0.5 };
  try {
    frame(t.map, {});
    frame(t.map, { bounds: { west: -179.9, south: -0.5, east: -179, north: 0.5 } });
    await settled();

    assert.ok(t.dem.demCalls.some((call) => call.x === 0));
  } finally {
    t.scheduler.destroy();
  }
});

test("unused completions count nothing while cold visible demand counts a miss", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    await drainAll(t);

    assert.deepEqual(t.telemetry.hits, { terrain: 0, basemap: 0, contours: 0 });
    assert.deepEqual(t.telemetry.misses, { terrain: 0, basemap: 0, contours: 0 });

    visibleLoad(t.map, "terrain-relief", { z: 3, x: 1, y: 1 });

    assert.equal(t.telemetry.misses.terrain, 1);
  } finally {
    t.scheduler.destroy();
  }
});

test("the first visible reuse of a warmed tile counts once and leaves the ledger", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    await drainAll(t);
    const warmed = t.dem.demCalls[0];
    const before = t.scheduler.speculativeUsage().bytes;

    visibleLoad(t.map, "terrain-relief", warmed);
    visibleLoad(t.map, "terrain-relief", warmed);

    assert.equal(t.telemetry.hits.terrain, 1);
    assert.equal(t.telemetry.misses.terrain, 0);
    assert.ok(t.scheduler.speculativeUsage().bytes < before);
    assert.equal(t.scheduler.speculativeUsage().consumed, 1);
  } finally {
    t.scheduler.destroy();
  }
});

test("visible demand promotes a trace and a basemap tile through real source events", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    await drainAll(t);
    const trace = t.dem.traces[0];
    const basemapUrl = t.http.urls[0];
    const basemapTile = basemapUrl.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf/)!;

    visibleLoad(t.map, "terrain-contours", trace);
    visibleLoad(t.map, "openmaptiles", {
      z: Number(basemapTile[1]),
      x: Number(basemapTile[2]),
      y: Number(basemapTile[3]),
    });

    assert.equal(t.telemetry.hits.contours, 1);
    assert.equal(t.telemetry.hits.basemap, 1);
  } finally {
    t.scheduler.destroy();
  }
});

test("an in-flight tile promoted by visible demand survives and counts once", async () => {
  const t = setup();
  try {
    frame(t.map, { zoom: 8 });
    await settled();
    const [promoted, ...others] = [...t.dem.demInflight.values()];
    const key = promoted.key;
    const tile = key.split("/").map(Number);

    visibleLoad(t.map, "terrain-relief", { z: tile[0], x: tile[1], y: tile[2] });
    visibleLoad(t.map, "terrain-relief", { z: tile[0], x: tile[1], y: tile[2] });
    await settled();

    assert.ok(!t.dem.demAborted.includes(key));
    assert.ok(others.every((call) => !t.dem.demAborted.includes(call.key)));
    promoted.resolve(undefined);
    await settled();

    assert.equal(t.telemetry.hits.terrain, 1);
    assert.equal(t.scheduler.speculativeUsage().consumed, 1);
  } finally {
    t.scheduler.destroy();
  }
});

test("failures count no hit or miss while cancelled work counts as wasted", async () => {
  const t = setup();
  try {
    t.map.state.bounds = WIDE_VIEW;
    frame(t.map, { zoom: 8 });
    await settled();
    for (const call of [...t.dem.demInflight.values()]) call.reject(new Error("offline"));
    await settled();

    assert.equal(t.telemetry.hits.terrain + t.telemetry.misses.terrain, 0);
    assert.equal(t.scheduler.speculativeUsage().missing, 0);

    frame(t.map, { zoom: 8.2 });
    await settled();

    assert.ok(t.telemetry.wastes.terrain > 0);
  } finally {
    t.scheduler.destroy();
  }
});

test("ocean 404s are remembered in a bounded memo and not warmed again", async () => {
  const t = setup();
  try {
    t.map.state.bounds = WIDE_VIEW;
    frame(t.map, { zoom: 8 });
    await settled();
    const rejected = [...t.dem.demInflight.values()].map((call) => call.key);
    for (const call of [...t.dem.demInflight.values()]) call.reject(new Error("Bad response: 404"));
    await settled();
    t.map.emit("sourcedata", {});
    await drainAll(t);

    const later = t.dem.demCalls.slice(rejected.length)
      .map((call) => `${call.z}/${call.x}/${call.y}`);
    assert.ok(t.scheduler.speculativeUsage().missing >= rejected.length);
    assert.ok(later.length > 0);
    assert.ok(later.every((key) => !rejected.includes(key)));
  } finally {
    t.scheduler.destroy();
  }
});

test("the byte budget stops admission without forgetting manager-owned tiles", async () => {
  const budget = Math.floor(DEM_ESTIMATE_BYTES * 2.5);
  const t = setup({ demBytes: 900_000, budget });
  try {
    t.map.state.bounds = WIDE_VIEW;
    frame(t.map, { zoom: 8 });
    await drainAll(t);

    const usage = t.scheduler.speculativeUsage();
    assert.ok(usage.peak <= budget);
    assert.equal(usage.bytes, 1_800_000);
    assert.equal(usage.entries, 2);
    assert.equal(t.dem.demCalls.length, 2);
    assert.equal(t.telemetry.wastes.terrain, 0);
  } finally {
    t.scheduler.destroy();
  }
});

test("an oversized result is counted as measured and blocks further admission", async () => {
  const t = setup({ demBytes: 1_500_000, budget: 4 * DEM_ESTIMATE_BYTES });
  try {
    t.map.state.bounds = WIDE_VIEW;
    frame(t.map, { zoom: 8 });
    await drainAll(t);
    frame(t.map, { zoom: 8.2 });
    await drainAll(t);

    const usage = t.scheduler.speculativeUsage();
    // Two lanes serialize admission, so the budget stops after three oversized tiles.
    assert.equal(t.dem.demCalls.length, 3);
    assert.equal(usage.entries, 3);
    assert.equal(usage.bytes, 3 * 1_500_000);
    assert.equal(t.telemetry.wastes.terrain, 0);
  } finally {
    t.scheduler.destroy();
  }
});

test("traced parents stay counted as decoded bytes inside the budget", async () => {
  const budget = 12 * DEM_ESTIMATE_BYTES;
  const t = setup({ budget });
  try {
    frame(t.map, { zoom: 8 });
    frame(t.map, { zoom: 8.2 });
    await drainAll(t);

    const usage = t.scheduler.speculativeUsage();
    assert.ok(t.dem.traces.length > 0);
    assert.ok(usage.bytes >= 4 * DECODED_PARENT_BYTES);
    assert.ok(usage.peak <= budget);
    assert.ok(t.dem.traces.length < PREFETCH_MAX_PER_SOURCE);
  } finally {
    t.scheduler.destroy();
  }
});

test("destroy aborts everything, counts unused tiles as waste and stops listening", async () => {
  const t = setup({ settleOnAbort: false });
  const listeners = listenerCount(t.map);
  frame(t.map, { zoom: 8 });
  await settled();
  const pending = [...t.dem.demInflight.values()];
  pending[0].resolve(undefined);
  await settled();
  const wasted = t.telemetry.wastes.terrain;

  t.scheduler.destroy();

  assert.equal(t.scheduler.speculativeUsage().bytes, 0);
  assert.equal(t.scheduler.speculativeUsage().entries, 0);
  assert.ok(t.telemetry.wastes.terrain > wasted);
  assert.ok(t.dem.demAborted.length >= pending.length - 1);
  assert.ok(listenerCount(t.map) < listeners);
  const calls = t.dem.demCalls.length;
  for (const call of pending.slice(1)) call.reject(new Error("aborted"));
  frame(t.map, { zoom: 8.4 });
  await settled();

  assert.equal(t.dem.demCalls.length, calls);
});

test("destroy releases a promoted DEM job and settles its reservation once", async () => {
  const t = setup({ settleOnAbort: false });
  frame(t.map, { zoom: 8 });
  await settled();
  const [promoted] = [...t.dem.demInflight.values()];
  const [z, x, y] = promoted.key.split("/").map(Number);
  visibleLoad(t.map, "terrain-relief", { z, x, y });
  const calls = t.dem.demCalls.length;

  t.scheduler.destroy();

  assert.ok(t.dem.demAborted.includes(promoted.key));
  assert.equal(t.scheduler.speculativeUsage().bytes, 0);
  promoted.reject(new Error("aborted"));
  await settled();

  assert.equal(t.scheduler.speculativeUsage().bytes, 0);
  assert.equal(t.dem.demCalls.length, calls);
});

test("destroy releases a promoted trace", async () => {
  const t = setup({ settleOnAbort: false });
  frame(t.map, { zoom: 8 });
  await drainDemOnly(t);
  const [pending] = [...t.dem.tracePending.values()];
  visibleLoad(t.map, "terrain-contours", t.dem.traces.at(-1)!);

  t.scheduler.destroy();

  assert.equal(t.dem.traceAborted.length, 1);
  pending.reject(new Error("aborted"));
  await settled();

  assert.equal(t.scheduler.speculativeUsage().bytes, 0);
  assert.equal(t.dem.traces.length, 1);
});

test("disabling releases a promoted HTTP warm", async () => {
  const t = setup({ settleOnAbort: false, noDem: true });
  try {
    frame(t.map, { zoom: 8 });
    await settled();
    const [promoted] = [...t.http.inflight.values()];
    const [, z, x, y] = promoted.url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf/)!.map(Number);
    visibleLoad(t.map, "openmaptiles", { z, x, y });

    t.state.plan.enabled = false;
    frame(t.map, { zoom: 8 });

    assert.ok(t.http.aborted.includes(promoted.url));
    for (const call of [...t.http.inflight.values()]) call.reject(new Error("aborted"));
    await settled();

    assert.equal(t.scheduler.speculativeUsage().bytes, 0);
    assert.equal(t.scheduler.speculativeUsage().consumed, 0);
  } finally {
    t.scheduler.destroy();
  }
});

test("traces through the real manager revalidate evicted parents inside the lanes", async () => {
  const run = await runThroughRealManager(null);

  assert.ok(run.traced.length > 0);
  assert.ok(run.fetched.length > new Set(run.fetched).size);
  // The worker fetches up to four parents at once outside the two speculation lanes.
  const maxWorkerBurst = 4;
  assert.ok(run.peak <= maxWorkerBurst);
});

test("traces through the real manager skip candidates with a known-missing parent", async () => {
  const unrestricted = await runThroughRealManager(null);

  assert.ok(unrestricted.traced.length > 0);
  const missingUrl = tileUrl(
    DEM_TEMPLATE,
    demParentsForTile(unrestricted.traced[0], CONTOUR_OVERZOOM)[0],
  );
  const run = await runThroughRealManager(missingUrl);
  const first = unrestricted.traced[0];

  for (const tile of run.traced) {
    const parents = demParentsForTile(tile, CONTOUR_OVERZOOM).map((parent) => {
      return tileUrl(DEM_TEMPLATE, parent);
    });
    assert.ok(!parents.includes(missingUrl));
  }
  assert.ok(!run.traced.some((tile) => {
    return tile.z === first.z && tile.x === first.x && tile.y === first.y;
  }));
  // The worker fetches up to four parents at once outside the two speculation lanes.
  const maxWorkerBurst = 4;
  assert.ok(run.peak <= maxWorkerBurst);
  assert.ok(unrestricted.peak <= maxWorkerBurst);
});

/** Drive the scheduler over a real manager whose two-entry cache evicts parents between traces. */
async function runThroughRealManager(missingUrl: string | null) {
  const pending: (() => void)[] = [];
  const fetched: string[] = [];
  const traced: { z: number; x: number; y: number }[] = [];
  let running = 0;
  let peak = 0;
  const manager = new mlcontour.LocalDemManager({
    demUrlPattern: DEM_TEMPLATE,
    cacheSize: 2,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 20000,
    getTile: (url: string, abort: AbortController) => new Promise((resolve, reject) => {
      fetched.push(url);
      running += 1;
      peak = Math.max(peak, running);
      let open = true;
      const finish = (settle: () => void) => {
        if (!open) return;
        open = false;
        running -= 1;
        settle();
      };
      abort.signal.addEventListener("abort", () => finish(() => reject(new Error("aborted"))));
      pending.push(() => finish(() => {
        if (url === missingUrl) reject(new Error("Bad response: 404"));
        else resolve({ data: new Blob([new Uint8Array(200)]) });
      }));
    }),
    decodeImage: async () => {
      const width = 16;
      const height = 16;
      const data = new Float32Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) data[y * width + x] = (x + y) * 10;
      }
      return { width, height, data };
    },
  });
  const traceThroughManager = manager.fetchContourTile.bind(manager);
  const fetcher: DemFetcher = {
    fetchTile: manager.fetchTile.bind(manager),
    fetchContourTile: (z, x, y, options, cancel) => {
      traced.push({ z, x, y });
      return traceThroughManager(z, x, y, options as never, cancel);
    },
  };
  const t = setup({ fetcher });
  t.map.state.bounds = { west: -0.5, south: -1, east: 2, north: 1 };
  try {
    frame(t.map, { zoom: 8 });
    frame(t.map, { zoom: 8.2 });
    for (let round = 0; round < 120; round += 1) {
      await settled();
      for (const settle of pending.splice(0)) settle();
    }
  } finally {
    t.scheduler.destroy();
  }
  return { traced, fetched, peak };
}

test("DEM warming shares the manager cache instead of racing it", async () => {
  const fetched: string[] = [];
  const blob = new Blob([new Uint8Array(200)]);
  const manager = new mlcontour.LocalDemManager({
    demUrlPattern: DEM_TEMPLATE,
    cacheSize: 120,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 20000,
    getTile: (url: string) => {
      fetched.push(url);
      return Promise.resolve({ data: blob });
    },
  });
  const first = manager.fetchTile(8, 1, 2, new AbortController());
  const second = manager.fetchTile(8, 1, 2, new AbortController());
  await Promise.all([first, second]);

  assert.equal(fetched.length, 1);

  // Aborting one waiter shares the in-flight download instead of cancelling it.
  const thirdAbort = new AbortController();
  const third = manager.fetchTile(8, 3, 4, thirdAbort);
  const fourth = manager.fetchTile(8, 3, 4, new AbortController());
  thirdAbort.abort();
  await Promise.all([third, fourth]);

  assert.equal(fetched.filter((url) => url.includes("/8/3/4")).length, 1);

  // The last waiter aborting cancels the shared download.
  const loneAbort = new AbortController();
  const lone = manager.fetchTile(8, 5, 6, loneAbort);
  loneAbort.abort();
  await assert.rejects(lone);
});

function plan(
  reliefMaxzoom = 11,
  bbox: [number, number, number, number] = BBOX,
): ContourPrefetchPlan {
  const stats = {
    min: 1,
    max: 820,
    mean: 100,
    p2: 6,
    p98: 700,
    slope_p50_deg: 5,
    slope_p90_deg: 10,
    cell_m: 500,
  };
  return {
    sourceId: "terrain-contours",
    ladder: contourLadder(stats, { maxZoom: 12 }),
    maxzoom: 12,
    reliefMaxzoom,
    elevationUnit: "m",
    enabled: true,
    bbox,
  };
}

/** Step one camera frame the way MapLibre emits it: move then zoom at one position. */
function frame(
  map: FakeMap,
  state: { zoom?: number; bounds?: { west: number; south: number; east: number; north: number } },
): void {
  if (state.zoom !== undefined) map.state.zoom = state.zoom;
  if (state.bounds) map.state.bounds = state.bounds;
  map.emit("move", {});
  map.emit("zoom", {});
}

function fakeTelemetry(): PrefetchTelemetry & {
  hits: Record<string, number>;
  misses: Record<string, number>;
  wastes: Record<string, number>;
} {
  const hits: Record<string, number> = { terrain: 0, basemap: 0, contours: 0 };
  const misses: Record<string, number> = { terrain: 0, basemap: 0, contours: 0 };
  const wastes: Record<string, number> = { terrain: 0, basemap: 0, contours: 0 };
  return {
    hits,
    misses,
    wastes,
    hit: (source) => {
      hits[source] += 1;
    },
    miss: (source) => {
      misses[source] += 1;
    },
    wasted: (source) => {
      wastes[source] += 1;
    },
  };
}

interface FakeCall {
  id: number;
  key: string;
  resolve: (data: unknown) => void;
  reject: (error: unknown) => void;
}

interface WarmingDem {
  fetcher: DemFetcher;
  traces: { z: number; x: number; y: number; options: unknown }[];
  traceIds: number[];
  tracePending: Map<number, FakeCall>;
  traceAborted: string[];
  readonly tracePeak: number;
  demCalls: { z: number; x: number; y: number }[];
  demInflight: Map<number, FakeCall>;
  demAborted: string[];
  readonly demPeak: number;
}

function warmingDem(demBytes = 200, contourBytes = 40, settleOnAbort = true): WarmingDem {
  const traces: { z: number; x: number; y: number; options: unknown }[] = [];
  const traceIds: number[] = [];
  const tracePending = new Map<number, FakeCall>();
  const traceAborted: string[] = [];
  let tracePeak = 0;
  const demCalls: { z: number; x: number; y: number }[] = [];
  const demInflight = new Map<number, FakeCall>();
  const demAborted: string[] = [];
  let demPeak = 0;
  let nextId = 0;
  const cachedDem = new Set<string>();
  const fetcher: DemFetcher = {
    fetchTile: (z: number, x: number, y: number, abort: AbortController) => {
      return startDemCall(z, x, y, abort);
    },
    fetchContourTile: (
      z: number,
      x: number,
      y: number,
      options: unknown,
      abort: AbortController,
    ) => {
      const key = `${z}/${x}/${y}:${JSON.stringify(options)}`;
      const id = nextId++;
      traces.push({ z, x, y, options });
      traceIds.push(id);
      tracePeak = Math.max(tracePeak, tracePending.size + 1);
      return manualCall(tracePending, traceAborted, key, id, abort, () => ({
        arrayBuffer: new ArrayBuffer(contourBytes),
      }), settleOnAbort);
    },
  };

  return {
    fetcher,
    traces,
    traceIds,
    tracePending,
    traceAborted,
    get tracePeak() {
      return tracePeak;
    },
    demCalls,
    demInflight,
    demAborted,
    get demPeak() {
      return demPeak;
    },
  };

  function startDemCall(z: number, x: number, y: number, abort: AbortController) {
    const key = `${z}/${x}/${y}`;
    const body = () => ({ data: new Blob([new Uint8Array(demBytes)]) });
    // A tile the manager already holds answers at once, like the real cache.
    if (cachedDem.has(key)) return Promise.resolve(body());
    const id = nextId++;
    demCalls.push({ z, x, y });
    demPeak = Math.max(demPeak, demInflight.size + 1);
    return manualCall(demInflight, demAborted, key, id, abort, body, settleOnAbort)
      .then((value) => {
        cachedDem.add(key);
        return value;
      });
  }
}

function manualCall(
  inflight: Map<number, FakeCall>,
  aborted: string[],
  key: string,
  id: number,
  abort: AbortController,
  body: () => unknown,
  settleOnAbort = true,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (abort.signal.aborted) {
      aborted.push(key);
      reject(new Error("aborted"));
      return;
    }
    inflight.set(id, {
      id,
      key,
      resolve: (data) => {
        inflight.delete(id);
        resolve(data ?? body());
      },
      reject: (error) => {
        inflight.delete(id);
        reject(error);
      },
    });
    abort.signal.addEventListener("abort", () => {
      // A fetcher that ignores cancellation leaves the job unsettled, so a late
      // settlement still reaches the scheduler and must be ignored by identity.
      aborted.push(key);
      if (!settleOnAbort) return;
      if (!inflight.has(id)) return;
      inflight.delete(id);
      reject(new Error("aborted"));
    });
  });
}

interface WarmingHttp {
  warmer: HttpWarmer;
  urls: string[];
  ids: number[];
  inflight: Map<number, FakeCall & { url: string }>;
  aborted: string[];
  readonly peak: number;
}

function warmingHttp(byteSize = 300, settleOnAbort = true): WarmingHttp {
  const urls: string[] = [];
  const ids: number[] = [];
  const inflight = new Map<number, FakeCall & { url: string }>();
  const aborted: string[] = [];
  let peak = 0;
  let nextId = 0;
  const warmer: HttpWarmer = (url, signal) => {
    const id = nextId++;
    urls.push(url);
    ids.push(id);
    peak = Math.max(peak, inflight.size + 1);
    return new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) {
        aborted.push(url);
        reject(new Error("aborted"));
        return;
      }
      const call: FakeCall & { url: string } = {
        id,
        key: url,
        url,
        resolve: (data) => {
          inflight.delete(id);
          resolve(data ?? new ArrayBuffer(byteSize));
        },
        reject: (error) => {
          inflight.delete(id);
          reject(error);
        },
      };
      inflight.set(id, call);
      if (settleOnAbort) {
        signal.addEventListener("abort", () => {
          if (!inflight.has(id)) return;
          inflight.delete(id);
          aborted.push(url);
          reject(new Error("aborted"));
        });
      } else {
        signal.addEventListener("abort", () => {
          aborted.push(url);
        });
      }
    });
  };
  return {
    warmer,
    urls,
    ids,
    inflight,
    aborted,
    get peak() {
      return peak;
    },
  };
}

function clock(): () => number {
  let now = 1000;
  return () => {
    now += 100;
    return now;
  };
}

type FakeMap = ReturnType<typeof fakeMap>;

function fakeMap() {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const sources = new Map<string, unknown>();
  const state = {
    zoom: 8,
    unloaded: new Set<string>(),
    bounds: { west: -0.5, south: -0.5, east: 0.5, north: 0.5 },
  };
  const map = {
    state,
    getZoom: () => state.zoom,
    getCenter: () => ({
      lng: (state.bounds.west + state.bounds.east) / 2,
      lat: (state.bounds.south + state.bounds.north) / 2,
    }),
    getCanvas: () => ({ clientWidth: 1280, clientHeight: 800 }),
    getBounds: () => ({
      getWest: () => state.bounds.west,
      getSouth: () => state.bounds.south,
      getEast: () => state.bounds.east,
      getNorth: () => state.bounds.north,
    }),
    isSourceLoaded: (id: string) => !state.unloaded.has(id),
    getStyle: () => ({ sources: {} }),
    getSource: (id: string) => sources.get(id) ?? null,
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
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
  return map as unknown as TilePrefetchMap & {
    state: typeof state;
    emit: (type: string, event: object) => void;
    sources: Map<string, unknown>;
  };
}

function listenerCount(map: FakeMap): number {
  const exposed = map as unknown as { count?: () => number };
  if (typeof exposed.count === "function") return exposed.count();
  return 0;
}

interface Harness {
  map: FakeMap;
  dem: WarmingDem;
  http: WarmingHttp;
  telemetry: ReturnType<typeof fakeTelemetry>;
  scheduler: TilePrefetchScheduler;
  state: { plan: ContourPrefetchPlan; basemap: BasemapDescriptor | null };
}

interface SetupOptions {
  settleOnAbort?: boolean;
  noDem?: boolean;
  demBytes?: number;
  budget?: number;
  plan?: ContourPrefetchPlan;
  fetcher?: DemFetcher;
}

/** Build a scheduler over fakes whose plan and basemap the test can change. */
function setup(options: SetupOptions = {}): Harness {
  const map = fakeMap();
  const dem = warmingDem(options.demBytes ?? 200, 40, options.settleOnAbort ?? true);
  const http = warmingHttp(300, options.settleOnAbort ?? true);
  const telemetry = fakeTelemetry();
  const state = {
    plan: options.plan ?? plan(),
    basemap: { template: LIBERTY_TEMPLATE, maxzoom: 14 } as BasemapDescriptor | null,
  };
  const scheduler = new TilePrefetchScheduler(
    map,
    () => state.plan,
    { tileTemplate: DEM_TEMPLATE, fetcher: options.noDem ? null : options.fetcher ?? dem.fetcher },
    { reliefSourceId: "terrain-relief", basemapSourceId: "openmaptiles" },
    () => state.basemap,
    http.warmer,
    clock(),
    telemetry,
    options.budget,
  );

  return { map, dem, http, telemetry, scheduler, state };
}

/** Let resolved and aborted fakes reach the scheduler before the test asserts. */
async function settled(): Promise<void> {
  for (let round = 0; round < 40; round += 1) await Promise.resolve();
}

/** Resolve every pending fake until the scheduler goes quiet, bounding total work. */
async function drainAll(t: Harness): Promise<void> {
  await settled();
  for (let round = 0; round < 40; round += 1) {
    const pending = [
      ...t.dem.demInflight.values(),
      ...t.dem.tracePending.values(),
      ...t.http.inflight.values(),
    ];
    if (pending.length === 0) return;
    for (const call of pending) call.resolve(undefined);
    await settled();
  }
}

/** Resolve DEM fetches only, so the gated traces start and stay pending. */
async function drainDemOnly(t: Harness): Promise<void> {
  for (let round = 0; round < 40 && t.dem.demInflight.size > 0; round += 1) {
    for (const call of [...t.dem.demInflight.values()]) call.resolve(undefined);
    await settled();
  }
}

function parentCount(t: Harness): number {
  return t.dem.demCalls.length;
}

function parentBytes(t: Harness): number {
  return t.dem.demCalls.length * 200;
}

/** Emit the sourcedataloading event MapLibre fires when a visible tile starts loading. */
function visibleLoad(map: FakeMap, sourceId: string, tile: { z: number; x: number; y: number }) {
  map.emit("sourcedataloading", { sourceId, tile: { tileID: { canonical: tile } } });
}

