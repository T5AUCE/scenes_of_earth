import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { Map as MapLibreMap } from "maplibre-gl";

import type { ShadeWorkerRequest, ShadeWorkerResponse } from "../workers/shade-worker.ts";

type ShadeProtocol = (
  parameters: { url: string },
  abortController: AbortController,
) => Promise<{ data: ImageBitmap }>;

const rootUrl = new URL("./", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.startsWith(rootUrl)) return next(specifier, context);

    if (specifier === "maplibre-gl") {
      const source = "export const addProtocol = (name, handler) => {"
        + " globalThis.shadeProtocol = handler; };";
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const {
  PINNED_SHADE_TILES_MAX,
  ShadeBitmapStore,
  ShadeClient,
  ShadeRaster,
} = await import("./shade-raster.ts");
hooks.deregister();

const BBOX: [number, number, number, number] = [-180, -85, 180, 85];
// A scene-sized bbox, so the fitted levels fit the pinned base cap.
const SCENE_BBOX: [number, number, number, number] = [5, 15, 15, 25];
// A wider scene for the refit probe, so the old and new bases overlap on one level.
const REFIT_BBOX: [number, number, number, number] = [5, 15, 20, 25];
const TILES = {
  url: "https://example.test/{z}/{x}/{y}.webp",
  encoding: "terrarium",
  tile_size: 512,
  maxzoom: 12,
  source: { attribution: "Terrain data" },
};

test("a client answers each request with its own bitmap", async () => {
  const worker = new FakeWorker();
  const client = new ShadeClient(() => worker);

  const first = client.shade({ z: 5, x: 1, y: 2 }, 2, TILES.url, new AbortController().signal);
  const second = client.shade({ z: 5, x: 3, y: 4 }, 2, TILES.url, new AbortController().signal);
  const [firstBitmap, secondBitmap] = [fakeBitmap(), fakeBitmap()];
  worker.reply({ id: 1, bitmap: secondBitmap });
  worker.reply({ id: 0, bitmap: firstBitmap });

  assert.equal(await first, firstBitmap);
  assert.equal(await second, secondBitmap);
});

test("an aborted request rejects as an abort and tells the worker to stop", async () => {
  const worker = new FakeWorker();
  const client = new ShadeClient(() => worker);
  const abort = new AbortController();
  const result = client.shade({ z: 5, x: 1, y: 2 }, 2, TILES.url, abort.signal);

  abort.abort();

  await assert.rejects(result, { name: "AbortError", message: "aborted" });
  assert.deepEqual(worker.sent.at(-1), { type: "cancel", id: 0 });
});

test("a bitmap that arrives after its request was aborted is closed", async () => {
  const worker = new FakeWorker();
  const client = new ShadeClient(() => worker);
  const abort = new AbortController();
  const result = client.shade({ z: 5, x: 1, y: 2 }, 2, TILES.url, abort.signal);
  abort.abort();
  await result.catch(() => {});
  const late = fakeBitmap();

  worker.reply({ id: 0, bitmap: late });

  assert.equal(late.closed, true);
});

test("a worker failure message becomes the request's error", async () => {
  const worker = new FakeWorker();
  const client = new ShadeClient(() => worker);
  const result = client.shade({ z: 5, x: 1, y: 2 }, 2, TILES.url, new AbortController().signal);

  worker.reply({ id: 0, error: "Bad response: 404 for tile 5/1/2" });

  await assert.rejects(result, /Bad response: 404/);
});

test("a crashed worker fails its requests and the next request starts a new worker", async () => {
  const workers: FakeWorker[] = [];
  const client = new ShadeClient(() => {
    workers.push(new FakeWorker());
    return workers.at(-1)!;
  });
  const lost = client.shade({ z: 5, x: 1, y: 2 }, 2, TILES.url, new AbortController().signal);

  workers[0].onerror?.({} as ErrorEvent);

  await assert.rejects(lost, /shading worker failed/);
  assert.equal(workers[0].terminated, true);
  client.shade({ z: 5, x: 1, y: 2 }, 2, TILES.url, new AbortController().signal);
  assert.equal(workers.length, 2);
});

test("destroying a client stops its worker and aborts what is pending", async () => {
  const worker = new FakeWorker();
  const client = new ShadeClient(() => worker);
  const result = client.shade({ z: 5, x: 1, y: 2 }, 2, TILES.url, new AbortController().signal);

  client.destroy();

  await assert.rejects(result, { name: "AbortError" });
  assert.equal(worker.terminated, true);
});

test("the layer fades tiles in and serves them through the shade protocol", async () => {
  const { map, sources, layers } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];

  assert.equal(sources.get("terrain-relief")!.type, "raster");
  assert.equal(sources.get("terrain-relief")!.maxzoom, 12);
  assert.deepEqual(layers[0].paint, { "raster-fade-duration": 250 });
  assert.match(tilesUrl, /^soeshade:\/\/\d+\/0\/\{z\}\/\{x\}\/\{y\}$/);

  // The whole world never fits the pinned base, so the idle warm sends nothing.
  runIdle(map);
  assert.equal(worker.sent.length, 0);

  const url = tilesUrl.replace("{z}/{x}/{y}", "5/6/7");
  const served = protocol()({ url }, new AbortController());
  const bitmap = fakeBitmap();
  assert.deepEqual(worker.sent[0], {
    type: "shade",
    id: 0,
    tile: { z: 5, x: 6, y: 7 },
    strength: 2,
    demUrl: TILES.url,
  });
  worker.reply({ id: 0, bitmap });
  assert.equal((await served).data, bitmap);

  raster.destroy();
});

test("a request for a removed layer is dropped as an abort", async () => {
  const { map, sources } = fakeMap();
  const raster = newRaster(map, new FakeWorker());
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  raster.destroy();

  await assert.rejects(
    protocol()({ url: tilesUrl.replace("{z}/{x}/{y}", "5/6/7") }, new AbortController()),
    { name: "AbortError" },
  );
});

test("a strength drag reloads the tiles once and keeps the last value", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { map, sources, reloads } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];

  raster.setStrength(3);
  raster.setStrength(4);
  raster.setStrength(4.5);
  assert.deepEqual(reloads, []);
  // Superseded background warms are cancelled, so the visible tiles shade at most once.
  assert.ok(worker.sent.some((message) => message.type === "cancel"));
  context.mock.timers.tick(200);

  assert.equal(reloads.length, 1);
  assert.notEqual(reloads[0][0], tilesUrl);
  const served = protocol()(
    { url: reloads[0][0].replace("{z}/{x}/{y}", "5/6/7") },
    new AbortController(),
  );
  assert.equal((worker.sent.at(-1) as { strength: number }).strength, 4.5);

  raster.destroy();
  await assert.rejects(served, { name: "AbortError" });
});

test("an unchanged strength does not reload the tiles", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { map, reloads } = fakeMap();
  const raster = newRaster(map, new FakeWorker());

  raster.setStrength(2);
  context.mock.timers.tick(1000);

  assert.deepEqual(reloads, []);
  raster.destroy();
});

test("a strength change warms the visible tiles before the reload", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { map, sources, reloads } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];

  raster.setStrength(4.5);

  const warms = worker.sent.filter((message) => message.type === "shade");
  assert.ok(warms.length > 0);
  assert.ok(warms.every((message) => (message as { strength: number }).strength === 4.5));
  const bitmaps = replyAll(worker);
  context.mock.timers.tick(200);
  await settled();

  assert.equal(reloads.length, 1);
  const first = warms[0] as { id: number; tile: { z: number; x: number; y: number } };
  const url = reloads[0][0].replace("{z}/{x}/{y}", `${first.tile.z}/${first.tile.x}/${first.tile.y}`);
  const sentBefore = worker.sent.length;

  assert.equal((await protocol()({ url }, new AbortController())).data, bitmaps.get(first.id));
  assert.equal(worker.sent.length, sentBefore);
  assert.notEqual(url, tilesUrl);
  raster.destroy();
});

test("demand and background work run on separate workers", async () => {
  const { map, sources } = fakeMap();
  const workers: FakeWorker[] = [];
  const raster = new ShadeRaster(map as unknown as MapLibreMap, {
    id: "terrain-relief",
    tiles: TILES as never,
    maxzoom: 12,
    bounds: {},
    bbox: SCENE_BBOX,
    strength: 2,
    beforeId: "shade",
    createWorker: () => {
      workers.push(new FakeWorker());
      return workers.at(-1)!;
    },
    scheduleIdle: (work) => void map.idle.push(work),
  });
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const served = protocol()(
    { url: tilesUrl.replace("{z}/{x}/{y}", "9/100/100") },
    new AbortController(),
  );
  runIdle(map);

  // The visible tile shades on the demand lane while the base warms on the background lane.
  assert.equal(workers.length, 2);
  assert.equal(workers[0].sent.length, 1);
  assert.ok(workers[1].sent.length > 0);
  const bitmap = fakeBitmap();
  workers[0].reply({ id: 0, bitmap });
  assert.equal((await served).data, bitmap);

  const warmed = workers[1].sent.find((message) => message.type === "shade") as {
    id: number;
    tile: { z: number; x: number; y: number };
  };
  const stored = fakeBitmap();
  workers[1].reply({ id: warmed.id, bitmap: stored });
  await settled();
  const sentBefore = workers[0].sent.length + workers[1].sent.length;
  const url = tilesUrl.replace("{z}/{x}/{y}", `${warmed.tile.z}/${warmed.tile.x}/${warmed.tile.y}`);

  assert.equal((await protocol()({ url }, new AbortController())).data, stored);
  assert.equal(workers[0].sent.length + workers[1].sent.length, sentBefore);
  raster.destroy();
});

test("the pinned base answers a zoom-out without the worker", async () => {
  const { map, sources } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  const warms = worker.sent.filter((message) => message.type === "shade");
  assert.ok(warms.length > 0);
  assert.ok(warms.length <= PINNED_SHADE_TILES_MAX);
  const bitmaps = replyAll(worker);
  await settled();
  const first = warms[0] as { id: number; tile: { z: number; x: number; y: number } };
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const url = tilesUrl.replace("{z}/{x}/{y}", `${first.tile.z}/${first.tile.x}/${first.tile.y}`);
  const sentBefore = worker.sent.length;

  assert.equal((await protocol()({ url }, new AbortController())).data, bitmaps.get(first.id));
  assert.equal(worker.sent.length, sentBefore);
  raster.destroy();
});

test("viewport ancestors warm on idle after the camera rests", async () => {
  const { map, emit, sources } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  replyAll(worker);
  await settled();

  map.zoom = 8;
  emit("moveend", {});
  const warmedBefore = worker.sent.length;
  runIdle(map);
  const warmed = worker.sent.slice(warmedBefore);

  // Raster rounds the zoom, so the ancestor and child follow the ideal level.
  const rounded = Math.round(map.zoom);
  assert.ok(warmed.length > 0);
  assert.ok(warmed.every((message) => message.type === "shade"));
  assert.ok(warmed.some((message) => (message as { tile: { z: number } }).tile.z === rounded - 1));
  assert.ok(warmed.some((message) => (message as { tile: { z: number } }).tile.z === rounded + 1));
  assert.ok(warmed.every(
    (message) => {
      const zoom = (message as { tile: { z: number } }).tile.z;
      return zoom === rounded - 1 || zoom === rounded + 1;
    },
  ));
  const bitmaps = replyAll(worker);
  await settled();
  const served = warmed.at(-1) as { id: number; tile: { z: number; x: number; y: number } };
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const url = tilesUrl.replace("{z}/{x}/{y}", `${served.tile.z}/${served.tile.x}/${served.tile.y}`);
  const sentBefore = worker.sent.length;

  assert.equal((await protocol()({ url }, new AbortController())).data, bitmaps.get(served.id));
  assert.equal(worker.sent.length, sentBefore);
  raster.destroy();
});

test("a fractional zoom plans the rounded raster level", async () => {
  const { map, emit } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  replyAll(worker);
  await settled();

  map.zoom = 7.6;
  emit("moveend", {});
  const warmedBefore = worker.sent.length;
  runIdle(map);
  const warmed = worker.sent.slice(warmedBefore).filter((message) => message.type === "shade");
  const zooms = warmed.map((message) => (message as { tile: { z: number } }).tile.z);

  // Raster rounds 7.6 to 8, so the ancestor is 7 and the child is 9, never below 7.
  assert.ok(warmed.length > 0);
  assert.ok(zooms.includes(7));
  assert.ok(zooms.includes(9));
  assert.ok(Math.max(...zooms) >= 8);
  raster.destroy();
});

test("the zoom-out footprint warms beyond the detail bounds", async () => {
  const { map, emit } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, BBOX);
  runIdle(map);
  replyAll(worker);
  await settled();

  map.zoom = 6;
  emit("moveend", {});
  const warmedBefore = worker.sent.length;
  runIdle(map);
  const atFive = worker.sent.slice(warmedBefore).filter(
    (message) => message.type === "shade" && (message as { tile: { z: number } }).tile.z === 5,
  );

  // Detail bounds 5-15E at z5 need four tiles, but the expanded footprint needs eight.
  assert.ok(atFive.length > 4);
  raster.destroy();
});

test("the next child level warms centre-first", async () => {
  const { map, emit } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  replyAll(worker);
  await settled();

  map.zoom = 8;
  emit("moveend", {});
  const warmedBefore = worker.sent.length;
  runIdle(map);
  const child = worker.sent.slice(warmedBefore).filter(
    (message) => message.type === "shade" && (message as { tile: { z: number } }).tile.z === 9,
  );

  assert.ok(child.length > 0 && child.length <= 12);
  const first = (child[0] as { tile: { z: number; x: number; y: number } }).tile;
  const distances = child.map((message) => {
    const tile = (message as { tile: { z: number; x: number; y: number } }).tile;
    const wraparound = Math.min(Math.abs(tile.x - first.x), 2 ** 9 - Math.abs(tile.x - first.x));
    return wraparound ** 2 + (tile.y - first.y) ** 2;
  });
  assert.deepEqual([...distances].sort((left, right) => left - right), distances);
  raster.destroy();
});

test("a stalled background warming still settles demand through the demand lane", async () => {
  const { map, sources } = fakeMap();
  const workers: FakeWorker[] = [];
  const raster = new ShadeRaster(map as unknown as MapLibreMap, {
    id: "terrain-relief",
    tiles: TILES as never,
    maxzoom: 12,
    bounds: {},
    bbox: SCENE_BBOX,
    strength: 2,
    beforeId: "shade",
    createWorker: () => {
      workers.push(new FakeWorker());
      return workers.at(-1)!;
    },
    scheduleIdle: (work) => void map.idle.push(work),
  });
  runIdle(map);

  // Stall the background base so the visible request must use the demand lane.
  assert.equal(workers.length, 1);
  const background = workers[0];
  const stalled = background.sent.find((message) => message.type === "shade") as {
    id: number;
    tile: { z: number; x: number; y: number };
  };
  assert.ok(stalled);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const url = tilesUrl.replace(
    "{z}/{x}/{y}",
    `${stalled.tile.z}/${stalled.tile.x}/${stalled.tile.y}`,
  );
  const served = protocol()({ url }, new AbortController());

  // The visible request leaves the stalled background for a free demand worker.
  assert.equal(workers.length, 2);
  const demand = workers[1];
  const demanded = demand.sent.find((message) => message.type === "shade") as {
    id: number;
    tile: { z: number; x: number; y: number };
  };
  assert.deepEqual(demanded.tile, stalled.tile);
  assert.ok(background.sent.some((message) => message.type === "cancel"));
  const bitmap = fakeBitmap();
  demand.reply({ id: demanded.id, bitmap });
  assert.equal((await served).data, bitmap);

  // A late background answer must not overwrite the demand bitmap, so it closes.
  const late = fakeBitmap();
  background.reply({ id: stalled.id, bitmap: late });
  await settled();
  assert.equal(late.closed, true);
  raster.destroy();
});

test("stalled work stays bounded across twenty distinct dwells", () => {
  const { map, emit } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, BBOX);
  runIdle(map);

  // Shift the viewport each dwell without replying, so stalled jobs accumulate.
  map.zoom = 11;
  for (let dwell = 0; dwell < 20; dwell += 1) {
    const longitude = 5.5 + dwell * 0.4;
    (map as unknown as { getCenter: () => { lng: number; lat: number } }).getCenter = () => ({
      lng: longitude,
      lat: 20,
    });
    (map as unknown as {
      getBounds: () => {
        getWest: () => number;
        getEast: () => number;
        getSouth: () => number;
        getNorth: () => number;
      };
    }).getBounds = () => ({
      getWest: () => longitude - 5,
      getEast: () => longitude + 5,
      getSouth: () => 15,
      getNorth: () => 25,
    });
    emit("moveend", {});
    runIdle(map);
  }

  const warming = (raster as unknown as { warming: Map<string, unknown> }).warming;
  assert.ok(warming.size <= 48 + 36);
  raster.destroy();
});

test("a late visible result stays open after the dwell fills", async () => {
  const { map, emit } = fakeMap();
  const workers: FakeWorker[] = [];
  const raster = new ShadeRaster(map as unknown as MapLibreMap, {
    id: "terrain-relief",
    tiles: TILES as never,
    maxzoom: 12,
    bounds: {},
    bbox: SCENE_BBOX,
    strength: 2,
    beforeId: "shade",
    createWorker: () => {
      workers.push(new FakeWorker());
      return workers.at(-1)!;
    },
    scheduleIdle: (work) => void map.idle.push(work),
  });
  runIdle(map);
  replyAll(workers[0]);
  await settled();

  map.zoom = 10;
  const viewport = (
    raster as unknown as { visibleTiles: () => { z: number; x: number; y: number }[] }
  ).visibleTiles();
  assert.ok(viewport.length > 0);
  const pending = raster.shadeTile(viewport[0], new AbortController().signal);
  const demand = workers[1];
  const request = demand.sent.find((message) => message.type === "shade") as { id: number };
  emit("moveend", {});
  runIdle(map);
  for (const worker of workers) {
    for (const message of worker.sent.filter((candidate) => candidate.type === "shade") as {
      id: number;
    }[]) {
      if (message.id !== request.id) worker.reply({ id: message.id, bitmap: fakeBitmap() });
    }
  }
  await settled();
  const bitmap = fakeBitmap();
  demand.reply({ id: request.id, bitmap });
  const served = await pending;

  // The dwell fills first, so the demand must still be open when it returns.
  assert.equal(served, bitmap);
  assert.equal(served.closed, false);
  raster.destroy();
});

test("near-identical dwells refresh useful cached ancestors instead of evicting them", async () => {
  const { map, emit } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  replyAll(worker);
  await settled();

  map.zoom = 10;
  const layered = raster as unknown as {
    ancestorTiles: () => { z: number; x: number; y: number }[];
    store: { get: (tile: { z: number; x: number; y: number }, strength: number) => unknown };
  };
  const nearest = layered.ancestorTiles().filter((tile) => tile.z === 9);
  assert.ok(nearest.length > 0);
  const hits: number[] = [];
  for (let dwell = 0; dwell < 4; dwell += 1) {
    emit("moveend", {});
    runIdle(map);
    replyAll(worker);
    await settled();
    hits.push(nearest.filter((tile) => layered.store.get(tile, 2)).length);
  }

  assert.equal(hits.at(-1), nearest.length);
  raster.destroy();
});

test("a stale warming bitmap is closed instead of stored", async () => {
  const { map, sources } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  const shades = worker.sent.filter((message) => message.type === "shade");
  const old = shades.at(-1) as { id: number; tile: { z: number; x: number; y: number } };
  // The base ends with its deeper level, which the visible-only rewarm leaves alone.
  assert.equal(old.tile.z, 6);

  raster.setStrength(4);

  assert.ok(worker.sent.some((message) => message.type === "cancel"));
  const stale = fakeBitmap();
  worker.reply({ id: old.id, bitmap: stale });

  assert.equal(stale.closed, true);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const url = tilesUrl.replace("{z}/{x}/{y}", `${old.tile.z}/${old.tile.x}/${old.tile.y}`);
  protocol()({ url }, new AbortController()).catch(() => {});

  assert.equal((worker.sent.at(-1) as { type: string }).type, "shade");
  raster.destroy();
});

test("the store keeps pinned tiles while ancestors evict oldest-first", () => {
  const store = new ShadeBitmapStore(2, 1);
  const pinned = [fakeBitmap(), fakeBitmap(), fakeBitmap()];
  store.put({ z: 5, x: 1, y: 1 }, 2, pinned[0], true);
  store.put({ z: 5, x: 2, y: 2 }, 2, pinned[1], true);
  store.put({ z: 5, x: 3, y: 3 }, 2, pinned[2], true);

  assert.equal(store.size, 2);
  assert.ok(pinned[0].closed);
  assert.equal(store.get({ z: 5, x: 2, y: 2 }, 2), pinned[1]);

  const ancestor = [fakeBitmap(), fakeBitmap()];
  store.put({ z: 4, x: 0, y: 0 }, 2, ancestor[0], false);
  store.put({ z: 4, x: 0, y: 1 }, 2, ancestor[1], false);

  assert.equal(store.size, 3);
  assert.ok(ancestor[0].closed);
  assert.equal(store.get({ z: 4, x: 0, y: 1 }, 2), ancestor[1]);
});

test("the store misses on another strength and clears everything on exit", () => {
  const store = new ShadeBitmapStore();
  const bitmap = fakeBitmap();
  store.put({ z: 5, x: 1, y: 1 }, 2, bitmap, true);

  assert.equal(store.get({ z: 5, x: 1, y: 1 }, 4), undefined);

  store.clear();

  assert.equal(store.size, 0);
  assert.equal(bitmap.closed, true);
});

test("destroying the layer closes stored bitmaps and stops listening", async () => {
  const { map, sources, listenerCount } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  const bitmaps = [...replyAll(worker).values()];
  assert.ok(bitmaps.length > 0);
  await settled();
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];

  raster.destroy();

  assert.ok(bitmaps.every((bitmap) => bitmap.closed));
  assert.equal(worker.terminated, true);
  assert.equal(listenerCount(), 0);
  await assert.rejects(
    protocol()({ url: tilesUrl.replace("{z}/{x}/{y}", "5/6/7") }, new AbortController()),
    { name: "AbortError" },
  );
});

test("losing the context fails pending tiles, stops the worker and clears the timer", async (
  context,
) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { map, sources, canvas, reloads } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const served = protocol()(
    { url: tilesUrl.replace("{z}/{x}/{y}", "5/6/7") },
    new AbortController(),
  );

  raster.setStrength(3);
  canvas.dispatchEvent(new Event("webglcontextlost"));

  await assert.rejects(served, { name: "AbortError" });
  assert.equal(worker.terminated, true);
  context.mock.timers.tick(1000);
  assert.deepEqual(reloads, []);
  raster.destroy();
});

test("the worker restarts lazily on the next tile after the context is restored", async () => {
  const { map, sources, canvas } = fakeMap();
  const workers: FakeWorker[] = [];
  const raster = new ShadeRaster(map as unknown as MapLibreMap, {
    id: "terrain-relief",
    tiles: TILES as never,
    maxzoom: 12,
    bounds: {},
    bbox: BBOX,
    strength: 2,
    beforeId: "shade",
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    scheduleIdle: () => {},
  });
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const first = protocol()(
    { url: tilesUrl.replace("{z}/{x}/{y}", "5/6/7") },
    new AbortController(),
  );
  workers[0].reply({ id: 0, bitmap: fakeBitmap() });
  await first;

  canvas.dispatchEvent(new Event("webglcontextlost"));
  canvas.dispatchEvent(new Event("webglcontextrestored"));

  assert.equal(workers.length, 1);
  const second = protocol()(
    { url: tilesUrl.replace("{z}/{x}/{y}", "5/6/8") },
    new AbortController(),
  );
  assert.equal(workers.length, 2);
  const bitmap = fakeBitmap();
  workers[1].reply({ id: 1, bitmap: bitmap });
  assert.equal((await second).data, bitmap);
  raster.destroy();
});

test("destroying the layer removes its context listeners", () => {
  const { map, canvas } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker);

  raster.destroy();
  canvas.dispatchEvent(new Event("webglcontextlost"));

  assert.equal(worker.terminated, false);
});

test("the pinned base follows the fitted zoom after landing", () => {
  const { map } = fakeMap();
  map.zoom = 1;
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  const landed = worker.sent.filter((message) => message.type === "shade");
  assert.ok(landed.length > 0);
  assert.ok(landed.every(
    (message) => (message as { tile: { z: number } }).tile.z <= 2,
  ));

  map.zoom = 5;
  raster.setBaseZoom(5);
  const warmedBefore = worker.sent.length;
  runIdle(map);
  const fitted = worker.sent.slice(warmedBefore).filter((message) => message.type === "shade");

  assert.ok(fitted.length > 0);
  assert.ok(fitted.every(
    (message) => [5, 6].includes((message as { tile: { z: number } }).tile.z),
  ));
  raster.destroy();
});

test("a deeply zoomed replacement warms nothing until the base is refit", () => {
  const { map } = fakeMap();
  map.zoom = 9;
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);

  assert.equal(worker.sent.filter((message) => message.type === "shade").length, 0);

  map.zoom = 5;
  raster.setBaseZoom(5);
  runIdle(map);
  const fitted = worker.sent.filter((message) => message.type === "shade");

  assert.ok(fitted.length > 0);
  assert.ok(fitted.every(
    (message) => [5, 6].includes((message as { tile: { z: number } }).tile.z),
  ));
  raster.destroy();
});

test("a refit keeps the new base pinned when old jobs finish late", async () => {
  const { map, sources } = fakeMap();
  map.zoom = 6;
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, REFIT_BBOX);
  runIdle(map);
  const oldShades = worker.sent.filter((message) => message.type === "shade");
  assert.ok(oldShades.length > 0);

  raster.setBaseZoom(5);
  const refitSent = worker.sent.length;
  runIdle(map);
  const freshShades = worker.sent.slice(refitSent).filter(
    (message) => message.type === "shade",
  );
  assert.ok(freshShades.length > 0);
  for (const message of freshShades) {
    const fresh = message as { id: number };
    worker.reply({ id: fresh.id, bitmap: fakeBitmap() });
  }
  await settled();
  for (const message of oldShades) {
    const old = message as { id: number };
    worker.reply({ id: old.id, bitmap: fakeBitmap() });
  }
  await settled();

  const current = new Map<string, { z: number; x: number; y: number }>();
  for (const message of worker.sent) {
    if (message.type !== "shade") continue;
    const tile = (message as { tile: { z: number; x: number; y: number } }).tile;
    if (tile.z !== 5 && tile.z !== 6) continue;
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (!current.has(key)) current.set(key, tile);
  }
  assert.ok(current.size > 0);
  assert.ok(current.size <= PINNED_SHADE_TILES_MAX);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  for (const tile of current.values()) {
    const url = tilesUrl.replace("{z}/{x}/{y}", `${tile.z}/${tile.x}/${tile.y}`);
    const sentBefore = worker.sent.length;

    assert.ok((await protocol()({ url }, new AbortController())).data);
    assert.equal(worker.sent.length, sentBefore);
  }
  raster.destroy();
});

test("a base tile demanded before idle stays pinned under ancestor pressure", async () => {
  const { map, emit, sources } = fakeMap();
  const baseTile = probeBaseTile(map);
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const demandUrl = tilesUrl.replace(
    "{z}/{x}/{y}",
    `${baseTile.z}/${baseTile.x}/${baseTile.y}`,
  );
  const demanded = protocol()({ url: demandUrl }, new AbortController());
  const demandId = (worker.sent.find((message) => message.type === "shade") as { id: number }).id;
  worker.reply({ id: demandId, bitmap: fakeBitmap() });
  await demanded;
  runIdle(map);
  replyAll(worker);
  await settled();
  await ancestorPressure(map, emit, worker);
  const sentBefore = worker.sent.length;

  assert.ok((await protocol()({ url: demandUrl }, new AbortController())).data);
  assert.equal(worker.sent.length, sentBefore);
  raster.destroy();
});

test("a demand settling after the background warm keeps the base pinned", async () => {
  const { map, emit, sources } = fakeMap();
  const baseTile = probeBaseTile(map);
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const demandUrl = tilesUrl.replace(
    "{z}/{x}/{y}",
    `${baseTile.z}/${baseTile.x}/${baseTile.y}`,
  );
  const demanded = protocol()({ url: demandUrl }, new AbortController());
  const demandId = (worker.sent.find((message) => message.type === "shade") as { id: number }).id;
  runIdle(map);
  const backgroundId = (worker.sent.find(
    (message) => message.type === "shade"
      && (message as { tile: { z: number; x: number; y: number } }).tile.z === baseTile.z
      && (message as { tile: { z: number; x: number; y: number } }).tile.x === baseTile.x
      && (message as { tile: { z: number; x: number; y: number } }).tile.y === baseTile.y
      && (message as { id: number }).id !== demandId,
  ) as { id: number } | undefined)?.id;
  assert.ok(backgroundId !== undefined);
  worker.reply({ id: backgroundId!, bitmap: fakeBitmap() });
  worker.reply({ id: demandId, bitmap: fakeBitmap() });
  await demanded;
  replyAll(worker);
  await settled();
  await ancestorPressure(map, emit, worker);
  const sentBefore = worker.sent.length;

  assert.ok((await protocol()({ url: demandUrl }, new AbortController())).data);
  assert.equal(worker.sent.length, sentBefore);
  raster.destroy();
});

test("a later unpinned insert never demotes a pinned base entry", () => {
  const store = new ShadeBitmapStore(2, 1);
  const pinned = fakeBitmap();
  const replaced = fakeBitmap();
  store.put({ z: 5, x: 1, y: 1 }, 2, pinned, true);
  store.put({ z: 5, x: 1, y: 1 }, 2, replaced, false);

  assert.equal(pinned.closed, true);
  store.put({ z: 5, x: 2, y: 2 }, 2, fakeBitmap(), false);
  store.put({ z: 5, x: 3, y: 3 }, 2, fakeBitmap(), false);

  assert.equal(store.get({ z: 5, x: 1, y: 1 }, 2), replaced);
  assert.equal(store.size, 2);
});

test("promoting a demand insert keeps it under ancestor pressure", () => {
  const store = new ShadeBitmapStore(2, 1);
  const bitmap = fakeBitmap();
  store.put({ z: 5, x: 1, y: 1 }, 2, bitmap, false);
  store.promote({ z: 5, x: 1, y: 1 });
  store.put({ z: 5, x: 2, y: 2 }, 2, fakeBitmap(), false);
  store.put({ z: 5, x: 3, y: 3 }, 2, fakeBitmap(), false);

  assert.equal(store.get({ z: 5, x: 1, y: 1 }, 2), bitmap);
  assert.equal(store.size, 2);
});

test("a strength change rebuilds the pinned base for a worker-free zoom-out", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { map, sources, reloads } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  const baseWarms = worker.sent.filter((message) => message.type === "shade");
  assert.ok(baseWarms.length > 0);
  replyAll(worker);
  await settled();

  map.zoom = 8;
  raster.setStrength(4);
  const rebuilt = worker.sent.filter(
    (message) => message.type === "shade" && (message as { strength: number }).strength === 4,
  );
  assert.ok(rebuilt.length > 0);
  runIdle(map);
  replyAll(worker);
  await settled();
  context.mock.timers.tick(200);
  await settled();

  assert.equal(reloads.length, 1);
  const first = baseWarms[0] as { tile: { z: number; x: number; y: number } };
  const url = reloads[0][0].replace(
    "{z}/{x}/{y}",
    `${first.tile.z}/${first.tile.x}/${first.tile.y}`,
  );
  const sentBefore = worker.sent.length;

  assert.ok((await protocol()({ url }, new AbortController())).data);
  assert.equal(worker.sent.length, sentBefore);
  raster.destroy();
});

test("a lost context releases bitmaps and pauses shading until restore", async () => {
  const { map, sources, canvas } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);
  runIdle(map);
  const bitmaps = [...replyAll(worker).values()];
  assert.ok(bitmaps.length > 0);
  await settled();
  const tilesUrl = (sources.get("terrain-relief")!.tiles as string[])[0];
  const first = (worker.sent.find((message) => message.type === "shade") as {
    tile: { z: number; x: number; y: number };
  }).tile;
  const cachedUrl = tilesUrl.replace("{z}/{x}/{y}", `${first.z}/${first.x}/${first.y}`);

  canvas.dispatchEvent(new Event("webglcontextlost"));

  assert.ok(bitmaps.every((bitmap) => bitmap.closed));
  await assert.rejects(
    protocol()({ url: cachedUrl }, new AbortController()),
    { name: "AbortError" },
  );
  const sentWhileLost = worker.sent.length;
  raster.setStrength(4);

  assert.equal(worker.sent.length, sentWhileLost);

  canvas.dispatchEvent(new Event("webglcontextrestored"));
  runIdle(map);
  assert.ok(worker.sent.length > sentWhileLost);
  replyAll(worker);
  await settled();
  const sentBefore = worker.sent.length;

  assert.ok((await protocol()({ url: cachedUrl }, new AbortController())).data);
  assert.equal(worker.sent.length, sentBefore);
  raster.destroy();
});

test("a multi-frame drag shades at most twice and keeps the last value", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { map, reloads } = fakeMap();
  const worker = new FakeWorker();
  const raster = newRaster(map, worker, SCENE_BBOX);

  raster.setStrength(3);
  const firstPass = worker.sent.filter((message) => message.type === "shade").length;
  assert.ok(firstPass > 0 && firstPass <= 12);
  for (const strength of [3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.5]) {
    raster.setStrength(strength);
  }
  const shadesBeforeTrailing = worker.sent.filter((message) => message.type === "shade").length;

  assert.equal(shadesBeforeTrailing, firstPass);
  context.mock.timers.tick(200);
  const shades = worker.sent.filter((message) => message.type === "shade");
  const strengths = shades.map((message) => (message as { strength: number }).strength);

  assert.ok(shades.length <= firstPass * 2);
  assert.equal(strengths.at(-1), 4.5);
  assert.equal(reloads.length, 1);
  raster.destroy();
});

/** One base tile learned from a probe layer, so demand tests can run before idle. */
function probeBaseTile(
  map: ReturnType<typeof fakeMap>["map"],
): { z: number; x: number; y: number } {
  const probeWorker = new FakeWorker();
  const probe = newRaster(map, probeWorker, SCENE_BBOX);
  runIdle(map);
  const warmed = probeWorker.sent.find((message) => message.type === "shade") as {
    tile: { z: number; x: number; y: number };
  };
  probe.destroy();
  return warmed.tile;
}

/** Fill the ancestor LRU after the base is populated, evicting any unpinned base tile. */
async function ancestorPressure(
  map: ReturnType<typeof fakeMap>["map"],
  emit: (type: string, event: object) => void,
  worker: FakeWorker,
): Promise<void> {
  map.zoom = 8;
  emit("moveend", {});
  runIdle(map);
  replyAll(worker);
  await settled();
}

function protocol(): ShadeProtocol {
  return (globalThis as unknown as { shadeProtocol: ShadeProtocol }).shadeProtocol;
}

function newRaster(
  map: ReturnType<typeof fakeMap>["map"],
  worker: FakeWorker,
  bbox: [number, number, number, number] = BBOX,
) {
  return new ShadeRaster(map as unknown as MapLibreMap, {
    id: "terrain-relief",
    tiles: TILES as never,
    maxzoom: 12,
    bounds: {},
    bbox,
    strength: 2,
    beforeId: "shade",
    createWorker: () => worker,
    scheduleIdle: (work) => void map.idle.push(work),
  });
}

class FakeWorker {
  sent: ShadeWorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<ShadeWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(request: ShadeWorkerRequest) {
    this.sent.push(request);
  }

  terminate() {
    this.terminated = true;
  }

  reply(response: ShadeWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<ShadeWorkerResponse>);
  }
}

function fakeBitmap() {
  return { closed: false, close() { this.closed = true; } } as unknown as ImageBitmap
    & { closed: boolean };
}

/** Let resolved worker replies reach the store before the test asserts. */
async function settled(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}

/** Answer every pending shade request with a fresh bitmap, keyed by request id. */
function replyAll(worker: FakeWorker): Map<number, ImageBitmap> {
  const bitmaps = new Map<number, ImageBitmap>();
  for (const message of worker.sent) {
    if (message.type !== "shade" || bitmaps.has(message.id)) continue;
    const bitmap = fakeBitmap();
    bitmaps.set(message.id, bitmap);
    worker.reply({ id: message.id, bitmap });
  }
  return bitmaps;
}

function runIdle(map: ReturnType<typeof fakeMap>["map"]) {
  for (const work of map.idle.splice(0)) work();
}

function fakeMap() {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const sources = new Map<string, Record<string, unknown>>();
  const layers: { paint?: unknown }[] = [];
  const reloads: string[][] = [];
  const canvas = Object.assign(new EventTarget(), { clientWidth: 1280, clientHeight: 800 });
  const map = {
    zoom: 5,
    idle: [] as (() => void)[],
    sources,
    addSource: (id: string, source: Record<string, unknown>) => sources.set(id, source),
    addLayer: (layer: { paint?: unknown }) => layers.push(layer),
    getLayer: () => undefined,
    getSource: () => ({ setTiles: (tiles: string[]) => reloads.push(tiles) }),
    removeLayer: () => {},
    removeSource: () => {},
    getZoom() {
      return this.zoom;
    },
    getCanvas: () => canvas,
    getCenter: () => ({ lng: 10, lat: 20 }),
    getBounds: () => ({
      getWest: () => 5,
      getEast: () => 15,
      getSouth: () => 15,
      getNorth: () => 25,
    }),
    on(type: string, listener: (event: object) => void) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    off(type: string, listener: (event: object) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const emit = (type: string, event: object) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };
  const listenerCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);

  return { map, emit, sources, layers, reloads, listenerCount, canvas };
}
