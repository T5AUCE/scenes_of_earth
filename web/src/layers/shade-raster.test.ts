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
const { PREFETCH_MAX_IN_FLIGHT, ShadeClient, ShadePrefetch, ShadeRaster } = await import(
  "./shade-raster.ts"
);
hooks.deregister();

const BBOX: [number, number, number, number] = [-180, -85, 180, 85];
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

test("zooming in during a gesture shades the next zoom a few tiles at a time", () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());

  zoomIn(map, emit, 5.05, 5.2);

  assert.equal(shaded.length, PREFETCH_MAX_IN_FLIGHT);
  assert.ok(shaded.every((entry) => entry.tile.z === 6));
  prefetch.destroy();
});

test("a handed-over tile is not shaded again while the camera keeps moving", async () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());
  zoomIn(map, emit, 5.05, 5.2);
  const running = prefetch.take(shaded[0].tile, new AbortController().signal);
  running?.catch(() => {});
  const bitmap = fakeBitmap();
  shaded[1].resolve(bitmap);
  await Promise.resolve();

  assert.equal(await prefetch.take(shaded[1].tile, new AbortController().signal), bitmap);
  assert.equal(prefetch.take(shaded[1].tile, new AbortController().signal), undefined);
  emit("move", {});
  emit("move", {});

  assert.equal(occurrences(shaded, shaded[0].tile), 1);
  assert.equal(occurrences(shaded, shaded[1].tile), 1);
  prefetch.destroy();
});

test("aborting a handed-over running tile cancels its shading", async () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());
  zoomIn(map, emit, 5.05, 5.2);
  const caller = new AbortController();
  const handed = prefetch.take(shaded[0].tile, caller.signal);

  caller.abort();

  assert.ok(shaded[0].signal.aborted);
  await assert.rejects(handed!);
  prefetch.destroy();
});

test("reversing the zoom aborts the running shadings", () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());
  zoomIn(map, emit, 5.05, 5.2);

  map.zoom = 5.1;
  emit("zoom", {});

  assert.ok(shaded.every((entry) => entry.signal.aborted));
  prefetch.destroy();
});

test("a fling does not prefetch", () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const times = [0, 10];
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, () => times.shift() ?? 10);

  zoomIn(map, emit, 5.05, 6);

  assert.equal(shaded.length, 0);
  prefetch.destroy();
});

test("ending the gesture aborts the running shadings", () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());
  zoomIn(map, emit, 5.05, 5.2);

  emit("moveend", {});

  assert.ok(shaded.every((entry) => entry.signal.aborted));
  prefetch.destroy();
});

test("a pan after the gesture ends starts no prefetch and closes finished tiles", async () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());
  zoomIn(map, emit, 5.05, 5.2);
  const bitmaps = shaded.map(() => fakeBitmap());
  shaded.forEach((entry, index) => entry.resolve(bitmaps[index]));
  await Promise.resolve();

  emit("moveend", {});
  await Promise.resolve();

  assert.ok(shaded.every((entry) => entry.signal.aborted));
  assert.ok(bitmaps.every((bitmap) => bitmap.closed));
  emit("movestart", {});
  emit("move", {});
  emit("move", {});

  assert.equal(shaded.length, PREFETCH_MAX_IN_FLIGHT);
  prefetch.destroy();
});

test("a pan without any zoom never starts the prefetch", () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());

  map.zoom = 5.2;
  emit("movestart", {});
  emit("move", {});

  assert.equal(shaded.length, 0);
  prefetch.destroy();
});

test("a drag starting mid-zoom drops the owned prefetch without losing moves", () => {
  const { map, emit } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());
  zoomIn(map, emit, 5.05, 5.2);

  assert.equal(shaded.length, PREFETCH_MAX_IN_FLIGHT);
  emit("dragstart", {});

  assert.ok(shaded.every((entry) => entry.signal.aborted));
  const started = shaded.length;
  emit("move", {});
  emit("move", {});

  assert.equal(shaded.length, started);
  prefetch.destroy();
});

test("the prefetch stays past the deepest source zoom and outside the scene", () => {
  const { map, emit } = fakeMap();
  const deep = fakeRaster();
  const atMaxZoom = new ShadePrefetch(map, deep.raster, 5, BBOX, clockAt());
  zoomIn(map, emit, 5.05, 5.2);
  assert.equal(deep.shaded.length, 0);
  atMaxZoom.destroy();

  const far = fakeRaster();
  const outside = new ShadePrefetch(map, far.raster, 12, [100, 10, 110, 20], clockAt());
  zoomIn(map, emit, 5.05, 5.2);
  assert.equal(far.shaded.length, 0);
  outside.destroy();
});

test("destroying the prefetch aborts everything and stops listening", () => {
  const { map, emit, listenerCount } = fakeMap();
  const { raster, shaded } = fakeRaster();
  const prefetch = new ShadePrefetch(map, raster, 12, BBOX, clockAt());
  zoomIn(map, emit, 5.05, 5.2);

  prefetch.destroy();

  assert.ok(shaded.every((entry) => entry.signal.aborted));
  assert.equal(listenerCount(), 0);
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
  workers[1].reply({ id: 1, bitmap });
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

function protocol(): ShadeProtocol {
  return (globalThis as unknown as { shadeProtocol: ShadeProtocol }).shadeProtocol;
}

function newRaster(map: ReturnType<typeof fakeMap>["map"], worker: FakeWorker) {
  return new ShadeRaster(map as unknown as MapLibreMap, {
    id: "terrain-relief",
    tiles: TILES as never,
    maxzoom: 12,
    bounds: {},
    bbox: BBOX,
    strength: 2,
    beforeId: "shade",
    createWorker: () => worker,
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

function fakeMap() {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const sources = new Map<string, Record<string, unknown>>();
  const layers: { paint?: unknown }[] = [];
  const reloads: string[][] = [];
  const canvas = Object.assign(new EventTarget(), { clientWidth: 1280, clientHeight: 800 });
  const map = {
    zoom: 5,
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

/** How many shadings started for one tile, so a re-shade of a handed-over tile shows. */
function occurrences(
  shaded: { tile: { z: number; x: number; y: number } }[],
  tile: { z: number; x: number; y: number },
): number {
  return shaded.filter((entry) =>
    entry.tile.z === tile.z && entry.tile.x === tile.x && entry.tile.y === tile.y
  ).length;
}

/** Step the camera inside a gesture, 100 ms per step, from one zoom to another. */function zoomIn(
  map: ReturnType<typeof fakeMap>["map"],
  emit: (type: string, event: object) => void,
  from: number,
  to: number,
) {
  map.zoom = from;
  emit("movestart", {});
  emit("zoom", {});
  map.zoom = to;
  emit("zoom", {});
}

/** A clock that advances one second per reading, so zooming speed stays below the fling limit. */
function clockAt() {
  let nowMs = 0;
  return () => (nowMs += 1000);
}

function fakeRaster() {
  const shaded: {
    tile: { z: number; x: number; y: number };
    signal: AbortSignal;
    resolve: (bitmap: ImageBitmap) => void;
  }[] = [];
  const raster = {
    shadeNow(tile: { z: number; x: number; y: number }, signal: AbortSignal) {
      return new Promise<ImageBitmap>((resolve, reject) => {
        shaded.push({ tile, signal, resolve });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  };
  return { raster: raster as never, shaded };
}
