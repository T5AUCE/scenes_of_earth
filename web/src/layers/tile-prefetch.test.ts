/** The scene preload scheduler: lanes, budget, ordering, ownership and teardown. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WarmTile } from "../contour-ladder.ts";
import {
  BoundedKeySet,
  closeScenePreload,
  currentScenePreload,
  openScenePreload,
  ScenePreload,
  serveStoredTile,
  TileStore,
  withVisibleDemand,
  type PreloadMap,
  type PreloadSource,
  type PreloadTelemetry,
} from "./tile-prefetch.ts";

test("memo sets forget their oldest key at the cap", () => {
  const keys = new BoundedKeySet(2);
  keys.add("a");
  keys.add("b");
  keys.add("a");
  keys.add("c");

  assert.equal(keys.size, 2);
  assert.ok(keys.has("a") && keys.has("c") && !keys.has("b"));
});

test("the store hands a running download to readers and keeps the finished body", async () => {
  const store = new TileStore();
  const body = new Blob(["abcd"]);
  let finish: (blob: Blob) => void = () => {};
  const download = new Promise<Blob | undefined>((resolve) => {
    finish = resolve;
  });
  const held = store.hold("a", download);

  assert.equal(store.has("a"), true);
  assert.equal(store.bytes, 0);
  const reading = store.read("a") as Promise<Blob | undefined>;
  finish(body);
  await held;

  assert.equal(await reading, body);
  assert.equal(store.read("a"), body);
  assert.equal(store.bytes, 4);
});

test("a failed download rejects its readers and leaves nothing behind", async () => {
  const store = new TileStore();
  const held = store.hold("a", Promise.reject(new Error("Bad response: 404")));
  const reading = store.read("a") as Promise<Blob | undefined>;

  await assert.rejects(held, /404/);
  await assert.rejects(reading, /404/);
  assert.equal(store.has("a"), false);
  assert.equal(store.bytes, 0);
});

test("the store discards bodies that would overflow its retained cap", async () => {
  const store = new TileStore(100);
  await store.hold("a", Promise.resolve(new Blob(["x".repeat(90)])));

  assert.equal(store.bytes, 90);
  await store.hold("b", Promise.resolve(new Blob(["y".repeat(90)])));

  assert.equal(store.bytes, 90);
  assert.ok(store.read("a") instanceof Blob);
  assert.equal(store.read("b"), undefined);
  assert.equal(store.absentError("b"), undefined);
});

test("clearing the store drops finished and running downloads", async () => {
  const store = new TileStore();
  await store.hold("done", Promise.resolve(new Blob(["xy"])));
  void store.hold("running", new Promise<Blob | undefined>(() => {}));
  store.clear();

  assert.equal(store.has("done") || store.has("running"), false);
  assert.equal(store.bytes, 0);
});

test("nothing downloads before the scene starts and lanes cap what runs after", async () => {
  const t = setup();
  const feed = fakeSource("dem", ["8/0/0", "8/0/1", "8/1/0", "8/1/1"], { lanes: 2 });
  t.preload.add(feed.source);
  await settled();

  assert.equal(feed.runs.size, 0);
  t.preload.start(8);
  assert.deepEqual([...feed.runs.keys()], ["8/0/0", "8/0/1"]);

  feed.finish("8/0/0");
  await settled();
  assert.deepEqual([...feed.runs.keys()], ["8/0/0", "8/0/1", "8/1/0"]);
  assert.ok(feed.peak <= 2);
  t.preload.destroy();
});

test("a source waits for the source it follows to finish", async () => {
  const t = setup();
  const dem = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 2 });
  const traces = fakeSource("contours", ["9/0/0"], { lanes: 1, after: "dem", layer: "contours" });
  t.preload.add(traces.source);
  t.preload.add(dem.source);
  t.preload.start(8);

  assert.equal(traces.runs.size, 0);
  dem.finish("8/0/0");
  await settled();
  assert.equal(traces.runs.size, 0);
  dem.finish("8/0/1");
  await settled();

  assert.deepEqual([...traces.runs.keys()], ["9/0/0"]);
  t.preload.destroy();
});

test("the byte budget drops the rest of a plan and shrinks the planned total", async () => {
  const t = setup(250);
  const feed = fakeSource("dem", ["8/0/0", "8/0/1", "8/1/0", "8/1/1"], { lanes: 4, bytes: 100 });
  t.preload.add(feed.source);
  t.preload.start(8);

  assert.deepEqual([...feed.runs.keys()], ["8/0/0", "8/0/1"]);
  assert.deepEqual(t.preload.progress(), { done: 0, total: 2, bytes: 0 });
  feed.finish("8/0/0", 100);
  feed.finish("8/0/1", 100);
  await settled();

  assert.equal(feed.runs.size, 2);
  assert.deepEqual(t.preload.progress(), { done: 2, total: 2, bytes: 200 });
  assert.deepEqual(t.telemetry.lastProgress, { done: 2, total: 2, bytes: 200 });
  t.preload.destroy();
});

test("settled waits for every planned task and wakes on each report", async () => {
  const t = setup();
  const feed = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 2 });
  t.preload.add(feed.source);
  t.preload.start(8);
  await settled();
  let isDone = false;
  const waiting = t.preload.settled().then(() => {
    isDone = true;
  });

  feed.finish("8/0/0", 4);
  await settled();

  assert.equal(isDone, false);

  feed.finish("8/0/1", 4);
  await waiting;

  assert.equal(t.preload.isSettled(), true);
  t.preload.destroy();
});

test("settled rejects when aborted or when the preload is destroyed", async () => {
  const t = setup();
  t.preload.add(fakeSource("dem", ["8/0/0"], { lanes: 1 }).source);
  t.preload.start(8);
  await settled();
  const abort = new AbortController();
  const aborted = t.preload.settled(abort.signal);
  const destroyed = t.preload.settled();

  abort.abort();
  t.preload.destroy();

  await assert.rejects(aborted, { name: "AbortError" });
  await assert.rejects(destroyed, { name: "AbortError" });
});

test("stored tiles are rewritten from the first download on and undone at the end", async () => {
  const t = setup();
  const feed = fakeSource("dem", ["8/0/0"], { lanes: 1 });
  t.preload.add(feed.source);
  assert.equal(t.map.transform, undefined);
  t.preload.start(8);
  const rewrite = t.map.transform!;

  assert.deepEqual(rewrite("8/0/0", "Tile"), { url: "soetile://8/0/0" });
  assert.equal(rewrite("8/0/0", "Style"), undefined);
  assert.equal(rewrite("8/9/9", "Tile"), undefined);
  feed.finish("8/0/0", 4);
  await settled();
  assert.deepEqual(rewrite("8/0/0", "Tile"), { url: "soetile://8/0/0" });

  t.preload.destroy();
  assert.equal(t.map.transform, null);
});

test("destroying aborts every running download, frees the store and stops listening", async () => {
  const t = setup();
  const feed = fakeSource("dem", ["8/0/0", "8/0/1", "8/1/0"], { lanes: 2 });
  t.preload.add(feed.source);
  t.preload.start(8);
  feed.finish("8/0/0");
  await settled();

  t.preload.destroy();
  await settled();

  assert.deepEqual(feed.aborted, ["8/0/1", "8/1/0"]);
  assert.equal(feed.runs.size, 3);
  assert.equal(t.preload.progress().bytes, 0);
  assert.equal(t.map.listenerCount(), 0);
  t.preload.add(feed.source);
  t.preload.start(9);
  assert.equal(feed.runs.size, 3);
});

test("replacing a source aborts its work and ignores its late result", async () => {
  const t = setup();
  const first = fakeSource("dem", ["8/0/0"], { lanes: 1 });
  const second = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 1 });
  t.preload.add(first.source);
  t.preload.start(8);

  t.preload.add(second.source);
  await settled();

  assert.deepEqual(first.aborted, ["8/0/0"]);
  assert.deepEqual([...second.runs.keys()], ["8/0/0"]);
  second.finish("8/0/0");
  await settled();
  assert.deepEqual([...second.runs.keys()], ["8/0/0", "8/0/1"]);
  assert.equal(t.preload.progress().done, 1);
  t.preload.destroy();
});

test("removing a source aborts it and drops it from the progress", async () => {
  const t = setup();
  const feed = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 1 });
  t.preload.add(feed.source);
  t.preload.start(8);

  t.preload.remove("dem");
  await settled();

  assert.deepEqual(feed.aborted, ["8/0/0"]);
  assert.deepEqual(t.preload.progress(), { done: 0, total: 0, bytes: 0 });
  assert.equal(feed.runs.size, 1);
  t.preload.destroy();
});

test("a missing tile is remembered while other failures download again", async () => {
  const t = setup();
  const feed = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 2 });
  t.preload.add(feed.source);
  t.preload.start(8);
  feed.fail("8/0/0", "Bad response: 404 for https://tiles.example.test/8/0/0");
  feed.fail("8/0/1", "Bad response: 503 for https://tiles.example.test/8/0/1");
  await settled();

  const again = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 2 });
  t.preload.add(again.source);
  await settled();

  assert.deepEqual([...again.runs.keys()], ["8/0/1"]);
  t.preload.destroy();
});

test("settledThrough waits only for the fitted zoom while deeper work continues", async () => {
  const t = setup();
  let releaseFit!: (blob: Blob | undefined) => void;
  let releaseDeep!: (blob: Blob | undefined) => void;
  const fitGate = new Promise<Blob | undefined>((resolve) => {
    releaseFit = resolve;
  });
  const deepGate = new Promise<Blob | undefined>((resolve) => {
    releaseDeep = resolve;
  });
  t.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 2,
    tasks: () => [
      { key: "fit-tile", estimatedBytes: 0, zoom: 8, run: () => fitGate },
      { key: "deep-tile", estimatedBytes: 0, zoom: 12, run: () => deepGate },
    ],
    visibleKey: () => null,
  } satisfies PreloadSource);
  t.preload.start(8);
  await settled();

  assert.equal(t.preload.isSettledThrough(8), false);
  let throughDone = false;
  const through = t.preload.settledThrough(8).then(() => {
    throughDone = true;
  });
  let allDone = false;
  const all = t.preload.settled().then(() => {
    allDone = true;
  });
  await settled();

  assert.equal(throughDone, false);
  assert.equal(allDone, false);

  releaseFit(undefined);
  await through;
  await settled();

  assert.equal(throughDone, true);
  assert.equal(t.preload.isSettledThrough(8), true);
  assert.equal(t.preload.isSettled(), false);
  assert.equal(allDone, false);

  releaseDeep(undefined);
  await all;

  assert.equal(t.preload.isSettled(), true);
  assert.equal(allDone, true);
  t.preload.destroy();
});

test("a gated source runs its fitted-zoom task while the gate has deeper work", async () => {
  const t = setup();
  const gates = new Map<string, (blob: Blob | undefined) => void>();
  const gated = (key: string) => {
    return new Promise<Blob | undefined>((resolve) => gates.set(key, resolve));
  };
  t.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 2,
    tasks: () => [
      { key: "dem-8", estimatedBytes: 0, zoom: 8, run: () => gated("dem-8") },
      { key: "dem-12", estimatedBytes: 0, zoom: 12, run: () => gated("dem-12") },
    ],
    visibleKey: () => null,
  } satisfies PreloadSource);
  t.preload.add({
    id: "contours",
    layer: "contours",
    lanes: 1,
    after: "dem",
    tasks: () => [{ key: "trace-8", estimatedBytes: 0, zoom: 8, run: () => gated("trace-8") }],
    visibleKey: () => null,
  } satisfies PreloadSource);
  t.preload.start(8);
  await settled();

  assert.equal(gates.has("trace-8"), false);
  gates.get("dem-8")!(undefined);
  await settled();
  assert.equal(gates.has("trace-8"), true);
  gates.get("trace-8")!(undefined);
  await t.preload.settledThrough(8);

  assert.equal(t.preload.isSettledThrough(8), true);
  assert.equal(t.preload.isSettled(), false);
  t.preload.destroy();
});

test("the first visible load after landing counts one hit or miss for its layer", async () => {
  const t = setup();
  const dem = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 1 });
  const traces = fakeSource("contours", ["9/0/0"], { lanes: 1, layer: "contours" });
  t.preload.add(dem.source);
  t.preload.add(traces.source);
  t.map.emit("sourcedataloading", loading("dem", { z: 8, x: 0, y: 0 }));
  assert.deepEqual(t.telemetry.counts, []);

  t.preload.start(8);
  dem.finish("8/0/0");
  await settled();
  t.map.emit("sourcedataloading", loading("dem", { z: 8, x: 0, y: 1 }));
  assert.deepEqual(t.telemetry.counts, []);

  t.preload.noteLanded();
  t.map.emit("sourcedataloading", loading("dem", { z: 8, x: 0, y: 0 }));
  t.map.emit("sourcedataloading", loading("dem", { z: 8, x: 0, y: 0 }));
  t.map.emit("sourcedataloading", loading("dem", { z: 8, x: 0, y: 1 }));
  t.map.emit("sourcedataloading", loading("dem", { z: 8, x: 5, y: 5 }));
  t.map.emit("sourcedataloading", loading("elsewhere", { z: 8, x: 5, y: 6 }));

  assert.deepEqual(t.telemetry.counts, ["hit terrain", "hit terrain", "miss terrain"]);
  t.preload.destroy();
});

test("a tile known to be missing counts neither a hit nor a miss", async () => {
  const t = setup();
  const feed = fakeSource("dem", ["8/0/0"], { lanes: 1 });
  t.preload.add(feed.source);
  t.preload.start(8);
  feed.fail("8/0/0", "Bad response: 404");
  await settled();

  t.preload.noteLanded();
  t.map.emit("sourcedataloading", loading("dem", { z: 8, x: 0, y: 0 }));

  assert.deepEqual(t.telemetry.counts, []);
  t.preload.destroy();
});

const TILE_URL = "https://tiles.example.test/8/0/0";
const SLOW_URL = "https://tiles.example.test/8/0/0";
const WANTED_URL = "https://tiles.example.test/8/0/1";

test("oversized completions never push the store over budget", async () => {
  const t = setup(100);
  const feed = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 2, bytes: 50 });
  t.preload.add(feed.source);
  t.preload.start(8);
  feed.finish("8/0/0", 90);
  feed.finish("8/0/1", 90);
  await settled();

  assert.deepEqual(t.preload.progress(), { done: 2, total: 2, bytes: 90 });
  t.preload.destroy();
});

test("retention respects outstanding reservations while a producer is still pending", async () => {
  const t = setup(100);
  const feed = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 2, bytes: 50 });
  t.preload.add(feed.source);
  t.preload.start(8);
  feed.finish("8/0/0", 90);
  await settled();

  assert.deepEqual(t.preload.progress(), { done: 1, total: 2, bytes: 0 });
  feed.finish("8/0/1", 90);
  await settled();

  assert.deepEqual(t.preload.progress(), { done: 2, total: 2, bytes: 90 });
  t.preload.destroy();
});

test("a download that finishes after removal is dropped instead of retained", async () => {
  const t = setup();
  const feed = fakeSource("dem", ["8/0/0"], { lanes: 1, bytes: 50, abortable: false });
  t.preload.add(feed.source);
  t.preload.start(8);
  t.preload.remove("dem");
  await settled();
  feed.finish("8/0/0", 7);
  await settled();

  assert.deepEqual(t.preload.progress(), { done: 0, total: 0, bytes: 0 });
  t.preload.destroy();
});

test("a late completion never clobbers a replacement entry for the same key", async () => {
  const t = setup();
  const first = fakeSource("dem", ["8/0/0"], { lanes: 1, abortable: false });
  t.preload.add(first.source);
  t.preload.start(8);
  const second = fakeSource("dem", ["8/0/0"], { lanes: 1 });
  t.preload.add(second.source);
  await settled();
  first.finish("8/0/0", 7);
  await settled();
  second.finish("8/0/0", 4);
  await settled();

  assert.equal(t.preload.progress().bytes, 4);
  t.preload.destroy();
});

test("a stale 404 never poisons its replacement", async () => {
  const t = setup();
  const first = fakeSource("dem", ["8/0/0"], { lanes: 1, abortable: false });
  t.preload.add(first.source);
  t.preload.start(8);
  const second = fakeSource("dem", ["8/0/0"], { lanes: 1 });
  t.preload.add(second.source);
  await settled();
  first.fail("8/0/0", "Bad response: 404 for https://tiles.example.test/8/0/0");
  await settled();

  assert.deepEqual([...second.runs.keys()], ["8/0/0"]);
  second.finish("8/0/0", 4);
  await settled();

  assert.deepEqual(t.preload.progress(), { done: 1, total: 1, bytes: 4 });
  t.preload.destroy();
});

test("replacement work waits for lanes that cancelled jobs still occupy", async () => {
  const t = setup();
  const first = fakeSource("dem", ["8/0/0", "8/0/1"], { lanes: 2, abortable: false });
  t.preload.add(first.source);
  t.preload.start(8);
  const second = fakeSource("dem", ["8/1/0", "8/1/1", "8/1/2", "8/1/3"], { lanes: 2 });
  t.preload.add(second.source);
  await settled();

  assert.deepEqual([...second.runs.keys()], []);
  first.finish("8/0/0");
  await settled();
  assert.deepEqual([...second.runs.keys()], ["8/1/0"]);
  first.finish("8/0/1");
  await settled();

  assert.deepEqual([...second.runs.keys()], ["8/1/0", "8/1/1"]);
  t.preload.destroy();
});

test("a visible load joins a running preload instead of fetching again", async (t) => {
  const fetched = stubFetch(t, "net");
  const setupState = setup();
  let release!: (blob: Blob) => void;
  const gate = new Promise<Blob>((resolve) => {
    release = resolve;
  });
  setupState.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 1,
    tasks: () => [{ key: TILE_URL, estimatedBytes: 0, run: () => gate }],
    visibleKey: () => null,
  } satisfies PreloadSource);
  setupState.preload.start(8);
  const rewrite = setupState.map.transform!;
  assert.deepEqual(rewrite(TILE_URL, "Tile"), { url: `soetile://${TILE_URL}` });

  const reader = new AbortController();
  const reading = serveStoredTile({ url: `soetile://${TILE_URL}` }, reader);
  await settled();
  assert.equal(fetched.length, 0);
  reader.abort();
  await assert.rejects(reading, (error: unknown) => (error as Error).name === "AbortError");
  release(new Blob(["tile"]));
  await settled();

  assert.equal(setupState.preload.progress().bytes, 4);
  const served = await serveStoredTile({ url: `soetile://${TILE_URL}` }, new AbortController());
  assert.equal(await new Response(served.data).text(), "tile");
  setupState.preload.destroy();
});

test("a visible load before launch shares one download with the preload", async (t) => {
  const fetched = stubFetch(t, "net");
  const setupState = setup();
  let releaseSlow!: (blob: Blob | undefined) => void;
  const slow = new Promise<Blob | undefined>((resolve) => {
    releaseSlow = resolve;
  });
  let taskRuns = 0;
  setupState.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 1,
    tasks: () => [
      { key: SLOW_URL, estimatedBytes: 0, run: () => slow },
      {
        key: WANTED_URL,
        estimatedBytes: 0,
        run: () => {
          taskRuns += 1;
          return Promise.resolve(new Blob(["pre"]));
        },
      },
    ],
    visibleKey: () => null,
  } satisfies PreloadSource);
  setupState.preload.start(8);

  const served = await serveStoredTile({ url: `soetile://${WANTED_URL}` }, new AbortController());
  assert.equal(await new Response(served.data).text(), "net");
  assert.equal(fetched.length, 1);
  const again = await serveStoredTile({ url: `soetile://${WANTED_URL}` }, new AbortController());
  assert.equal(await new Response(again.data).text(), "net");
  assert.equal(fetched.length, 1);
  releaseSlow(undefined);
  await settled();

  assert.equal(taskRuns, 0);
  setupState.preload.destroy();
});

test("a cancelled visible read of a finished body rejects before converting it", async (t) => {
  const fetched = stubFetch(t, "tile");
  const setupState = setup();
  setupState.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 1,
    tasks: () => [{
      key: TILE_URL,
      estimatedBytes: 0,
      run: () => Promise.resolve(new Blob(["t"])),
    }],
    visibleKey: () => null,
  } satisfies PreloadSource);
  setupState.preload.start(8);
  await settled();

  const reader = new AbortController();
  reader.abort();
  await assert.rejects(
    serveStoredTile({ url: `soetile://${TILE_URL}` }, reader),
    (error: unknown) => (error as Error).name === "AbortError",
  );

  assert.equal(fetched.length, 0);
  setupState.preload.destroy();
});

test("a style replacement aborts the old plan and frees its store", async () => {
  const t = setup();
  let template = "a";
  const feed = fakeSource("dem", () => [`${template}/8/0/0`, `${template}/8/0/1`], {
    lanes: 2,
    revision: () => template,
  });
  t.preload.add(feed.source);
  t.preload.start(8);
  feed.finish("a/8/0/0", 10);
  await settled();
  assert.equal(t.preload.progress().bytes, 10);

  template = "b";
  t.map.emit("styledata", {});
  await settled();

  assert.deepEqual(feed.aborted, ["a/8/0/1"]);
  assert.equal(t.preload.progress().bytes, 0);
  assert.deepEqual([...feed.runs.keys()].sort(), ["a/8/0/0", "a/8/0/1", "b/8/0/0", "b/8/0/1"]);
  t.preload.destroy();
});

test("an unresolved basemap plan wakes when its source is ready", async () => {
  const t = setup();
  let template: string | null = null;
  const feed = fakeSource(
    "basemap",
    () => template === null ? [] : [`${template}/8/0/0`],
    { lanes: 1, layer: "basemap", revision: () => template },
  );
  t.preload.add(feed.source);
  t.preload.start(8);
  await settled();
  assert.deepEqual(t.preload.progress(), { done: 0, total: 0, bytes: 0 });
  assert.equal(feed.runs.size, 0);

  template = "https://tiles.example.test/{z}/{x}/{y}.pbf";
  t.map.emit("sourcedata", {});
  await settled();

  assert.deepEqual([...feed.runs.keys()], [`${template}/8/0/0`]);
  t.preload.destroy();
});

test("joined readers share a 404 without a second network request", async (t) => {
  const fetched = stubFetch(t, "net");
  const setupState = setup();
  let rejectRun!: (error: Error) => void;
  const gate = new Promise<Blob | undefined>((_, reject) => {
    rejectRun = reject;
  });
  setupState.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 1,
    tasks: () => [{ key: TILE_URL, estimatedBytes: 0, run: () => gate }],
    visibleKey: () => null,
  } satisfies PreloadSource);
  setupState.preload.start(8);

  const first = serveStoredTile({ url: `soetile://${TILE_URL}` }, new AbortController());
  const firstOutcome = first.then(
    () => "resolved",
    (error: unknown) => (error as Error).message,
  );
  rejectRun(new Error(`Bad response: 404 for ${TILE_URL}`));
  assert.match(await firstOutcome, /404/);
  await settled();

  const secondOutcome = serveStoredTile({ url: `soetile://${TILE_URL}` }, new AbortController())
    .then(
      () => "resolved",
      (error: unknown) => (error as Error).message,
    );
  assert.match(await secondOutcome, /404/);
  assert.equal(fetched.length, 0);
  setupState.preload.destroy();
});

test("a transient failure still falls back to the network", async (t) => {
  const fetched = stubFetch(t, "fresh");
  const setupState = setup();
  let rejectRun!: (error: Error) => void;
  const gate = new Promise<Blob | undefined>((_, reject) => {
    rejectRun = reject;
  });
  setupState.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 1,
    tasks: () => [{ key: TILE_URL, estimatedBytes: 0, run: () => gate }],
    visibleKey: () => null,
  } satisfies PreloadSource);
  setupState.preload.start(8);

  const first = serveStoredTile({ url: `soetile://${TILE_URL}` }, new AbortController());
  rejectRun(new Error(`Bad response: 503 for ${TILE_URL}`));
  const served = await first;
  assert.equal(await new Response(served.data).text(), "fresh");
  assert.equal(fetched.length, 1);
  await settled();

  const again = await serveStoredTile({ url: `soetile://${TILE_URL}` }, new AbortController());
  assert.equal(await new Response(again.data).text(), "fresh");
  assert.equal(fetched.length, 1);
  setupState.preload.destroy();
});

test("joined transient readers share one fallback fetch", async (t) => {
  const fetched = stubFetch(t, "fresh");
  const setupState = setup();
  let rejectRun!: (error: Error) => void;
  const gate = new Promise<Blob | undefined>((_, reject) => {
    rejectRun = reject;
  });
  setupState.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 1,
    tasks: () => [{ key: TILE_URL, estimatedBytes: 0, run: () => gate }],
    visibleKey: () => null,
  } satisfies PreloadSource);
  setupState.preload.start(8);

  const first = serveStoredTile({ url: `soetile://${TILE_URL}` }, new AbortController());
  const second = serveStoredTile({ url: `soetile://${TILE_URL}` }, new AbortController());
  await settled();
  rejectRun(new Error(`Bad response: 503 for ${TILE_URL}`));
  const [one, two] = await Promise.all([first, second]);

  assert.equal(await new Response(one.data).text(), "fresh");
  assert.equal(await new Response(two.data).text(), "fresh");
  assert.equal(fetched.length, 1);
  setupState.preload.destroy();
});

test("a visible download that finishes after removal leaves no retained body", async (t) => {
  stubFetch(t, "net");
  const setupState = setup();
  let releaseSlow!: (blob: Blob | undefined) => void;
  const slow = new Promise<Blob | undefined>((resolve) => {
    releaseSlow = resolve;
  });
  setupState.preload.add({
    id: "dem",
    layer: "terrain",
    lanes: 1,
    tasks: () => [
      { key: SLOW_URL, estimatedBytes: 0, run: () => slow },
      { key: WANTED_URL, estimatedBytes: 0, run: () => Promise.resolve(new Blob(["pre"])) },
    ],
    visibleKey: () => null,
  } satisfies PreloadSource);
  setupState.preload.start(8);

  const reading = serveStoredTile({ url: `soetile://${WANTED_URL}` }, new AbortController());
  await settled();
  setupState.preload.remove("dem");
  await settled();
  releaseSlow(undefined);
  await settled();
  const body = await reading;

  assert.equal(await new Response(body.data).text(), "net");
  assert.deepEqual(setupState.preload.progress(), { done: 0, total: 0, bytes: 0 });
  setupState.preload.destroy();
});

test("a replacement generation never joins the old visible flight or its 404", async (t) => {
  const fetched: string[] = [];
  const original = globalThis.fetch;
  let resolveOld!: (response: Response) => void;
  let resolveNew!: (response: Response) => void;
  const oldGate = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  const newGate = new Promise<Response>((resolve) => {
    resolveNew = resolve;
  });
  let calls = 0;
  globalThis.fetch = (async (url: string) => {
    fetched.push(url);
    calls += 1;
    if (calls === 1) return oldGate;
    return newGate;
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const setupState = setup();
  const first = fakeSource("dem", [SLOW_URL, WANTED_URL], { lanes: 1, abortable: false });
  setupState.preload.add(first.source);
  setupState.preload.start(8);

  const firstReading = serveStoredTile({ url: `soetile://${WANTED_URL}` }, new AbortController());
  const firstOutcome = firstReading.then(
    () => "resolved",
    (error: unknown) => (error as Error).message,
  );
  await settled();
  setupState.preload.remove("dem");
  const second = fakeSource("dem", [WANTED_URL], { lanes: 1 });
  setupState.preload.add(second.source);
  await settled();
  const secondReading = serveStoredTile({ url: `soetile://${WANTED_URL}` }, new AbortController());
  const secondOutcome = secondReading.then(
    async (served) => new Response(served.data).text(),
    (error: unknown) => (error as Error).message,
  );
  await settled();

  assert.equal(fetched.length, 2);
  resolveOld(new Response("", { status: 404 }));
  assert.match(await firstOutcome, /404/);
  first.finish(SLOW_URL);
  await settled();
  resolveNew(new Response("new", { status: 200 }));
  assert.equal(await secondOutcome, "new");
  await settled();

  assert.deepEqual(setupState.preload.progress(), { done: 1, total: 1, bytes: 3 });
  setupState.preload.destroy();
});

test("opening a scene preload closes the previous one", () => {
  const first = fakeMap();
  const second = fakeMap();
  const opened = openScenePreload(first);

  assert.equal(currentScenePreload(), opened);
  openScenePreload(second);
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 3);
  closeScenePreload();

  assert.equal(currentScenePreload(), null);
  assert.equal(second.listenerCount(), 0);
});

test("an old visible demand settles against its own scene after replacement", async () => {
  openScenePreload(fakeMap());
  let rejectOld!: (error: Error) => void;
  const oldGate = new Promise<void>((_, reject) => {
    rejectOld = reject;
  });
  const oldDemand = withVisibleDemand(() => oldGate);
  const second = openScenePreload(fakeMap());
  let releaseNew!: () => void;
  const newGate = new Promise<void>((resolve) => {
    releaseNew = resolve;
  });
  const newDemand = withVisibleDemand(() => newGate);
  rejectOld(new Error("aborted"));
  await assert.rejects(oldDemand, /aborted/);
  await settled();

  const feed = fakeSource("dem", ["a", "b"], { lanes: 1 });
  second.add(feed.source);
  second.start(8);
  await settled();

  assert.equal(feed.runs.size, 0);
  releaseNew();
  await newDemand;
  await settled();

  assert.ok(feed.runs.size > 0);
  closeScenePreload();
});

interface Run {
  resolve(blob: Blob | undefined): void;
  reject(error: Error): void;
}

interface SourceOptions {
  lanes: number;
  after?: string;
  layer?: PreloadSource["layer"];
  bytes?: number;
  abortable?: boolean;
  revision?: () => string | null;
  keys?: string[] | (() => string[]);
}

/** A source whose downloads wait until the test finishes or fails them one by one. */
function fakeSource(id: string, keys: string[] | (() => string[]), options: SourceOptions) {
  const runs = new Map<string, Run>();
  const aborted: string[] = [];
  let running = 0;
  const feed = {
    runs,
    aborted,
    peak: 0,
    finish(key: string, size = 0) {
      runs.get(key)!.resolve(size > 0 ? new Blob(["x".repeat(size)]) : undefined);
    },
    fail(key: string, message: string) {
      runs.get(key)!.reject(new Error(message));
    },
    source: {
      id,
      layer: options.layer ?? "terrain",
      lanes: options.lanes,
      after: options.after,
      tasks: () => (typeof keys === "function" ? keys() : keys).map((key) => ({
        key,
        estimatedBytes: options.bytes ?? 0,
        run: (abort: AbortController) => new Promise<Blob | undefined>((resolve, reject) => {
          running += 1;
          feed.peak = Math.max(feed.peak, running);
          const done = <T>(finish: (value: T) => void) => (value: T) => {
            running -= 1;
            finish(value);
          };
          runs.set(key, {
            resolve: done(resolve),
            reject: done(reject),
          });
          if (options.abortable === false) return;
          abort.signal.addEventListener("abort", () => {
            aborted.push(key);
            reject(new Error("aborted"));
          });
        }),
      })),
      visibleKey: (sourceId: string, tile: WarmTile) => {
        return sourceId === id ? `${tile.z}/${tile.x}/${tile.y}` : null;
      },
      ...(options.revision === undefined ? {} : { revisionKey: options.revision }),
    } satisfies PreloadSource,
  };
  return feed;
}

function fakeMap() {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const map = {
    transform: undefined as ((url: string, type?: string) => unknown) | null | undefined,
    on: (type: string, listener: (event: object) => void) => {
      const entries = listeners.get(type) ?? new Set<(event: object) => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off: (type: string, listener: (event: object) => void) => {
      listeners.get(type)?.delete(listener);
    },
    setTransformRequest: (transform: ((url: string, type?: string) => unknown) | null) => {
      map.transform = transform;
    },
    emit: (type: string, event: object) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
  return map as typeof map & PreloadMap;
}

function fakeTelemetry() {
  const telemetry = {
    counts: [] as string[],
    lastProgress: { done: 0, total: 0, bytes: 0 },
    begin() {
      telemetry.counts.length = 0;
    },
    progress(done: number, total: number, bytes: number) {
      telemetry.lastProgress = { done, total, bytes };
    },
    hit: (layer: string) => void telemetry.counts.push(`hit ${layer}`),
    miss: (layer: string) => void telemetry.counts.push(`miss ${layer}`),
  };
  return telemetry as typeof telemetry & PreloadTelemetry;
}

function setup(budgetBytes?: number) {
  const map = fakeMap();
  const telemetry = fakeTelemetry();
  const preload = new ScenePreload(map, telemetry, budgetBytes);
  return { map, telemetry, preload };
}

/** Count network fallback fetches while serving a fixed body for every request. */
function stubFetch(t: { after: (finish: () => void) => void }, body: string): string[] {
  const fetched: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetched.push(url);
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return fetched;
}

function loading(sourceId: string, canonical: WarmTile) {
  return { sourceId, tile: { tileID: { canonical } } };
}

/** Let resolved and aborted fakes reach the scheduler before the test asserts. */
async function settled(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}
