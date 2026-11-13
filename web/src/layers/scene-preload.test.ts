/** The DEM, contour and basemap preload sources: enumeration, keys and downloads. */
import assert from "node:assert/strict";
import { test } from "node:test";

import mlcontour from "maplibre-contour";

import {
  contourLadder,
  CONTOUR_OVERZOOM,
  contourOptionsVersion,
  demParentsForTile,
  levelsForZoom,
} from "../contour-ladder.ts";
import { BASEMAP_SOURCE_ID, scenePyramidTiles } from "../render/tile-viewport.ts";
import type { Bbox, TerrainStats } from "../types.ts";
import {
  BASEMAP_PRELOAD_MAX_ZOOM,
  BASEMAP_PRELOAD_TILES,
  basemapPreloadSource,
  contourCacheKey,
  contourPreloadSource,
  CONTOUR_PRELOAD_TILES,
  demFetcherFor,
  demPreloadSource,
  DEM_PRELOAD_TILES,
  tileUrl,
  type ContourPlan,
  type DemFetcher,
} from "./scene-preload.ts";
import {
  PRELOAD_BUDGET_BYTES,
  ScenePreload,
  serveStoredTile,
  type PreloadMap,
  type PreloadTelemetry,
} from "./tile-prefetch.ts";

const TEMPLATE = "https://tiles.example.test/{z}/{x}/{y}.webp";
const LIBERTY = "https://tiles.openfreemap.org/planet/20260101_001001_pt/{z}/{x}/{y}.pbf";
const SMALL_SCENE: Bbox = [36.5, -1.5, 37.5, -0.5];
const COUNTRY_SCENE: Bbox = [33.9, -4.7, 41.9, 5.5];
const STATS: TerrainStats = {
  min: 1,
  max: 820,
  mean: 100,
  p2: 6,
  p98: 700,
  slope_p50_deg: 5,
  slope_p90_deg: 10,
  cell_m: 500,
};

test("tile URLs fill the template without scene identity", () => {
  assert.equal(
    tileUrl(TEMPLATE, { z: 9, x: 1, y: 2 }),
    "https://tiles.example.test/9/1/2.webp",
  );
});

test("contour keys separate options but never scenes", () => {
  const tile = { z: 9, x: 1, y: 2 };

  assert.equal(
    contourCacheKey(tile, { levels: [50], buffer: 1 }, "v1"),
    contourCacheKey(tile, { buffer: 1, levels: [50] }, "v1"),
  );
  assert.notEqual(
    contourCacheKey(tile, { levels: [50] }, "v1"),
    contourCacheKey(tile, { levels: [10] }, "v1"),
  );
});

test("the global byte budget stays inside the agreed download size", () => {
  assert.ok(PRELOAD_BUDGET_BYTES >= 10 * 1024 * 1024);
  assert.ok(PRELOAD_BUDGET_BYTES <= 25 * 1024 * 1024);
});

test("a small scene preloads every DEM level from the contour parents down to the cap", () => {
  const tasks = demSource(SMALL_SCENE).tasks(9.3);
  const zooms = tasks.map((task) => zoomOf(task.key));

  assert.deepEqual([...new Set(zooms)], [8, 9, 10, 11]);
  assert.ok(tasks.length <= DEM_PRELOAD_TILES);
  assert.deepEqual(zooms, [...zooms].sort((first, second) => first - second));
  assert.ok(tasks.every((task) => task.key.startsWith("https://tiles.example.test/")));
});

test("a country scene stops at the last whole level inside the budget", () => {
  const tasks = demSource(COUNTRY_SCENE).tasks(6.2);
  const deepest = Math.max(...tasks.map((task) => zoomOf(task.key)));

  assert.ok(tasks.length <= DEM_PRELOAD_TILES);
  assert.ok(deepest >= 7 && deepest <= 9);
  const nextLevel = scenePyramidTiles(COUNTRY_SCENE, deepest + 1, deepest + 1, 100_000);
  assert.ok(tasks.length + nextLevel.length > DEM_PRELOAD_TILES);
});

test("a scene fitted deeper than the DEM cap still gets the deepest level", () => {
  const tasks = demSource(SMALL_SCENE).tasks(14);

  assert.ok(tasks.length > 0 && tasks.every((task) => zoomOf(task.key) === 11));
});

test("a scene across the antimeridian wraps its tile columns", () => {
  const tasks = demSource([171, 50, 231, 55]).tasks(5)
    .filter((task) => zoomOf(task.key) === 4);
  const columns = new Set(tasks.map((task) => zxy(task.key)[1]));

  assert.ok(columns.has(15) && columns.has(0));
  assert.ok([...columns].every((column) => column >= 0 && column < 16));
});

test("a DEM download goes through the manager and keeps the returned body", async () => {
  const body = new Blob(["dem"]);
  const calls: number[][] = [];
  const fetcher: DemFetcher = {
    fetchTile: async (z, x, y) => {
      calls.push([z, x, y]);
      return { data: body };
    },
  };
  const [task] = demSource(SMALL_SCENE, fetcher).tasks(11);

  assert.equal(await task.run(new AbortController()), body);
  assert.deepEqual(calls, [zxy(task.key)]);
});

test("a DEM download without a manager falls back to a low-priority fetch", async (t) => {
  const requests: { url: string; priority?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { priority?: string }) => {
    requests.push({ url, priority: init.priority });
    return new Response("bytes", { status: url.endsWith("0.webp") ? 404 : 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const [task] = demSource(SMALL_SCENE).tasks(11);

  const blob = await task.run(new AbortController());

  assert.equal(await blob?.text(), "bytes");
  assert.deepEqual(requests, [{ url: task.key, priority: "low" }]);
});

test("a failed download reports its status so a missing tile can be remembered", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const [task] = demSource(SMALL_SCENE).tasks(11);

  await assert.rejects(task.run(new AbortController()), /Bad response: 404/);
});

test("only visible loads of the relief source map to a DEM task key", () => {
  const source = demSource(SMALL_SCENE);

  assert.equal(
    source.visibleKey("terrain-relief", { z: 9, x: 1, y: 2 }),
    "https://tiles.example.test/9/1/2.webp",
  );
  assert.equal(source.visibleKey("terrain-contours", { z: 9, x: 1, y: 2 }), null);
});

test("contour traces use the global ladder keys and stop one level below the DEM", () => {
  const plan = contourPlan("m");
  const source = contourSource(SMALL_SCENE, plan, fakeManager().fetcher);
  const tasks = source.tasks(9.3);
  const [z, x, y] = traceTile(tasks[0].key);
  const options = { levels: levelsForZoom(plan.ladder.thresholds, z), overzoom: 1, buffer: 1 };
  const version = contourOptionsVersion("m", CONTOUR_OVERZOOM, 1);

  assert.equal(source.after, "dem");
  assert.ok(tasks.length > 0 && tasks.length <= CONTOUR_PRELOAD_TILES);
  const zooms = tasks.map((task) => traceTile(task.key)[0]);
  assert.ok(Math.min(...zooms) >= 9 && Math.max(...zooms) <= 12);
  assert.equal(tasks[0].key, contourCacheKey({ z, x, y }, options, version));
});

test("a trace asks the manager for exactly the options the visible source sends", async () => {
  const manager = fakeManager();
  const plan = contourPlan("ft");
  const [task] = contourSource(SMALL_SCENE, plan, manager.fetcher).tasks(11);

  assert.equal(await task.run(new AbortController()), undefined);

  const [call] = manager.traces;
  assert.deepEqual(call.options, {
    levels: levelsForZoom(plan.ladder.thresholds, call.z),
    overzoom: 1,
    buffer: 1,
    multiplier: 3.280839895013123,
  });
  assert.equal(task.key.includes('"multiplier"'), true);
});

test("the DEM plan covers every parent the contour traces read inside the tile bound", () => {
  const bbox: Bbox = [0, 0, 1.2, 1.2];
  const demKeys = new Set(demSource(bbox).tasks(9.737).map((task) => task.key));
  const plan = contourPlan("m");
  const traced = contourSource(bbox, plan, fakeManager().fetcher).tasks(9.737);

  assert.ok(demKeys.size <= DEM_PRELOAD_TILES);
  assert.ok(traced.length > 0);
  for (const task of traced) {
    const [z, x, y] = traceTile(task.key);
    for (const parent of demParentsForTile({ z, x, y }, CONTOUR_OVERZOOM)) {
      assert.ok(
        demKeys.has(tileUrl(TEMPLATE, parent)),
        `trace ${task.key} needs parent ${parent.z}/${parent.x}/${parent.y}`,
      );
    }
  }
});

test("traces read only parents the DEM plan already fetched", async () => {
  const manager = fakeWorkerManager();
  const dem = demSource(SMALL_SCENE, manager.fetcher);
  const demKeys = new Set(dem.tasks(9.3).map((task) => task.key));
  for (const task of dem.tasks(9.3)) await task.run(new AbortController());
  manager.network.length = 0;

  const plan = contourPlan("m");
  const traced = contourSource(SMALL_SCENE, plan, manager.fetcher).tasks(9.3);
  for (const task of traced) await task.run(new AbortController());

  assert.ok(traced.length > 0);
  assert.ok(traced.every((task) => task.estimatedBytes > 0));
  assert.ok(traced.every((task) => task.needs !== undefined && task.needs.length > 0));
  assert.equal(manager.network.length, 0);
  assert.ok(manager.traced.every((url) => demKeys.has(url)));
});

test("traces still succeed when evicted parents must download again", async () => {
  const manager = fakeWorkerManager();
  const dem = demSource(SMALL_SCENE, manager.fetcher);
  const demKeys = new Set(dem.tasks(9.3).map((task) => task.key));
  for (const task of dem.tasks(9.3)) await task.run(new AbortController());
  manager.cached.clear();
  manager.network.length = 0;

  const traced = contourSource(SMALL_SCENE, contourPlan("m"), manager.fetcher).tasks(9.3);
  for (const task of traced) await task.run(new AbortController());

  assert.ok(manager.network.length > 0);
  assert.ok(manager.network.every((url) => demKeys.has(url)));
});

test("a contour load maps to the trace key only for the line source and a traced zoom", () => {
  const plan = contourPlan("m");
  const source = contourSource(SMALL_SCENE, plan, fakeManager().fetcher);
  const tile = { z: 10, x: 5, y: 6 };
  const options = { levels: levelsForZoom(plan.ladder.thresholds, 10), overzoom: 1, buffer: 1 };
  const version = contourOptionsVersion("m", CONTOUR_OVERZOOM, 1);

  const expected = contourCacheKey(tile, options, version);

  assert.equal(source.visibleKey("terrain-contours", tile), expected);
  assert.equal(source.visibleKey("terrain-labels-contours", tile), null);
  assert.equal(source.visibleKey("terrain-contours", { z: 1, x: 0, y: 0 }), null);
});

test("without a manager the contour source has nothing to trace", () => {
  assert.deepEqual(contourSource(SMALL_SCENE, contourPlan("m"), null).tasks(9), []);
});

test("basemap preload stops at the preload zoom and the source ceiling", () => {
  const source = basemapPreloadSource(basemapMap(LIBERTY, 14), SMALL_SCENE);
  const tasks = source.tasks(9.3);
  const zooms = tasks.map((task) => basemapZoom(task.key));

  assert.ok(tasks.length <= BASEMAP_PRELOAD_TILES);
  assert.ok(Math.max(...zooms) <= BASEMAP_PRELOAD_MAX_ZOOM);
  assert.ok(tasks.every((task) => task.key.startsWith("https://tiles.openfreemap.org/planet/")));
  const lower = basemapPreloadSource(basemapMap(LIBERTY, 10), SMALL_SCENE).tasks(9.3);
  assert.ok(Math.max(...lower.map((task) => basemapZoom(task.key))) <= 10);
});

test("basemap preload waits for a resolved source and keys visible loads by its template", () => {
  const empty = basemapPreloadSource(basemapMap(null, 14), SMALL_SCENE);
  assert.deepEqual(empty.tasks(9), []);
  assert.equal(empty.visibleKey(BASEMAP_SOURCE_ID, { z: 9, x: 1, y: 2 }), null);

  const source = basemapPreloadSource(basemapMap(LIBERTY, 14), SMALL_SCENE);
  source.tasks(9);
  assert.equal(
    source.visibleKey(BASEMAP_SOURCE_ID, { z: 9, x: 1, y: 2 }),
    "https://tiles.openfreemap.org/planet/20260101_001001_pt/9/1/2.pbf",
  );
  assert.equal(source.visibleKey("terrain-relief", { z: 9, x: 1, y: 2 }), null);
});

test("preload tasks carry their tile zoom so entry waits only through the fit", () => {
  const dem = demSource(SMALL_SCENE).tasks(9.3);
  assert.ok(dem.length > 0);
  assert.ok(dem.every((task) => typeof task.zoom === "number"));
  assert.ok(dem.some((task) => task.zoom === 9));
  assert.ok(dem.some((task) => (task.zoom ?? 0) > 9));

  const basemap = basemapPreloadSource(basemapMap(LIBERTY, 14), SMALL_SCENE).tasks(9.3);
  assert.ok(basemap.length > 0);
  assert.ok(basemap.every((task) => typeof task.zoom === "number"));
  assert.ok(basemap.some((task) => task.zoom === 9));

  const plan = contourPlan("m");
  const traced = contourSource(SMALL_SCENE, plan, fakeManager().fetcher).tasks(9.3);
  assert.ok(traced.length > 0);
  assert.ok(traced.every((task) => typeof task.zoom === "number"));
  assert.ok(traced.some((task) => task.zoom === 9));
});

test("the DEM fetcher is the shared manager when one exists", () => {
  const manager = {};

  assert.equal(demFetcherFor({ manager }), manager);
  assert.equal(demFetcherFor({}), null);
});

test("a clipped DEM budget drops dependent traces without upstream fetches", async (t) => {
  const tracking = { running: 0, peak: 0, urls: [] as string[] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    tracking.running += 1;
    tracking.peak = Math.max(tracking.peak, tracking.running);
    tracking.urls.push(url);
    try {
      await Promise.resolve();
      return new Response("dem", { status: 200 });
    } finally {
      tracking.running -= 1;
    }
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const manager = new mlcontour.LocalDemManager({
    demUrlPattern: TEMPLATE,
    cacheSize: 120,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 5000,
    decodeImage: async () => ({ width: 64, height: 64, data: new Float32Array(64 * 64) }),
    getTile: async (url: string) => {
      tracking.running += 1;
      tracking.peak = Math.max(tracking.peak, tracking.running);
      tracking.urls.push(url);
      try {
        await Promise.resolve();
        return { data: new Blob(["dem"]) };
      } finally {
        tracking.running -= 1;
      }
    },
  });
  const map = fakeMap();
  const preload = new ScenePreload(map, fakeTelemetry(), 100);
  const bbox: Bbox = [0, 0, 1.2, 1.2];
  preload.add(demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox,
    reliefSourceId: "relief",
    fetcher: manager as unknown as DemFetcher,
  }));
  preload.add(contourPreloadSource({
    lineSourceId: "lines",
    plan: () => contourPlan("m"),
    bbox,
    demMaxzoom: 11,
    demTemplate: TEMPLATE,
    fetcher: manager as unknown as DemFetcher,
  }));
  preload.start(9.737);
  await idle(preload);

  assert.equal(tracking.urls.length, 0);
  assert.deepEqual(preload.progress(), { done: 0, total: 0, bytes: 0 });
  preload.destroy();
});

test("evicted parents refetch on one lane through the real manager", async (t) => {
  const tracking = { running: 0, peak: 0, urls: [] as string[] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    tracking.running += 1;
    tracking.peak = Math.max(tracking.peak, tracking.running);
    tracking.urls.push(url);
    try {
      await Promise.resolve();
      return new Response("dem", { status: 200 });
    } finally {
      tracking.running -= 1;
    }
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const manager = new mlcontour.LocalDemManager({
    demUrlPattern: TEMPLATE,
    cacheSize: 120,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 5000,
    decodeImage: async () => ({ width: 64, height: 64, data: new Float32Array(64 * 64) }),
    getTile: async (url: string) => {
      tracking.running += 1;
      tracking.peak = Math.max(tracking.peak, tracking.running);
      tracking.urls.push(url);
      try {
        await Promise.resolve();
        return { data: new Blob(["dem"]) };
      } finally {
        tracking.running -= 1;
      }
    },
  });
  const map = fakeMap();
  const preload = new ScenePreload(map, fakeTelemetry());
  const bbox: Bbox = [0, 0, 1.2, 1.2];
  preload.add(demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox,
    reliefSourceId: "relief",
    fetcher: manager as unknown as DemFetcher,
  }));
  preload.start(9.737);
  await idle(preload);

  assert.ok(tracking.urls.length > 0);
  for (let index = 0; index < 120; index += 1) {
    await manager.fetchTile(10, 1000 + index, 0, new AbortController());
  }
  tracking.urls.length = 0;
  tracking.peak = 0;
  preload.add(contourPreloadSource({
    lineSourceId: "lines",
    plan: () => contourPlan("m"),
    bbox,
    demMaxzoom: 11,
    demTemplate: TEMPLATE,
    fetcher: manager as unknown as DemFetcher,
  }));
  await idle(preload);

  assert.ok(tracking.peak <= 3);
  preload.destroy();
});

test("a visible-first DEM shares one download with the manager cache", async (t) => {
  const tracking = { running: 0, peak: 0, urls: [] as string[] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    tracking.running += 1;
    tracking.peak = Math.max(tracking.peak, tracking.running);
    tracking.urls.push(url);
    try {
      await Promise.resolve();
      return new Response("dem", { status: 200 });
    } finally {
      tracking.running -= 1;
    }
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const manager = new mlcontour.LocalDemManager({
    demUrlPattern: TEMPLATE,
    cacheSize: 120,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 5000,
    decodeImage: async () => ({ width: 64, height: 64, data: new Float32Array(64 * 64) }),
    getTile: async (url: string) => {
      tracking.running += 1;
      tracking.peak = Math.max(tracking.peak, tracking.running);
      tracking.urls.push(url);
      try {
        await Promise.resolve();
        return { data: new Blob(["dem"]) };
      } finally {
        tracking.running -= 1;
      }
    },
  });
  const map = fakeMap();
  const preload = new ScenePreload(map, fakeTelemetry());
  const bbox: Bbox = [0, 0, 1.2, 1.2];
  const dem = demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox,
    reliefSourceId: "relief",
    fetcher: manager as unknown as DemFetcher,
  });
  preload.add(dem);
  preload.start(9.737);
  const planned = dem.tasks(9.737).map((task) => task.key);
  const queued = planned[10];
  const reading = serveStoredTile({ url: `soetile://${queued}` }, new AbortController());
  const body = await reading;
  await idle(preload);

  assert.equal(await new Response(body.data).text(), "dem");
  const distinct = new Set(tracking.urls);
  assert.equal(distinct.size, 50);
  assert.equal(tracking.urls.filter((url) => url === queued).length, 1);
  preload.destroy();
});

test("manager-backed DEM requests keep background work low priority", async (t) => {
  const requests: { url: string; priority?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { priority?: string }) => {
    requests.push({ url, priority: init?.priority });
    return new Response("dem", { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const manager = new mlcontour.LocalDemManager({
    demUrlPattern: TEMPLATE,
    cacheSize: 120,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 5000,
    decodeImage: async () => ({ width: 64, height: 64, data: new Float32Array(64 * 64) }),
  });
  const source = demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox: SMALL_SCENE,
    reliefSourceId: "relief",
    fetcher: manager as unknown as DemFetcher,
  });
  const tasks = source.tasks(11);
  await tasks[0].run(new AbortController());

  assert.equal(requests[0].priority, "low");
  requests.length = 0;
  manager.tileCache.clear();
  const loader = source.loadShared?.(tasks[0].key);
  await loader?.();

  assert.equal(requests[0].priority, undefined);
});

test("a clipped budget drops remote traces without upstream fetches", async () => {
  const tracking = { running: 0, peak: 0, urls: [] as string[] };
  const inner = new mlcontour.LocalDemManager({
    demUrlPattern: TEMPLATE,
    cacheSize: 120,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 5000,
    decodeImage: async () => ({
      width: 64,
      height: 64,
      data: new Float32Array(64 * 64),
    }),
    getTile: async (url: string) => {
      tracking.running += 1;
      tracking.peak = Math.max(tracking.peak, tracking.running);
      tracking.urls.push(url);
      try {
        await Promise.resolve();
        return { data: new Blob(["dem"]) };
      } finally {
        tracking.running -= 1;
      }
    },
  });
  const fetcher: DemFetcher = {
    fetchTile: (z, x, y, abort) => inner.fetchTile(z, x, y, abort),
    fetchContourTile: (z, x, y, options, abort) => {
      return inner.fetchContourTile(z, x, y, options, abort);
    },
  };
  const map = fakeMap();
  const preload = new ScenePreload(map, fakeTelemetry(), 100);
  const bbox: Bbox = [0, 0, 1.2, 1.2];
  preload.add(demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox,
    reliefSourceId: "relief",
    fetcher,
  }));
  preload.add(contourPreloadSource({
    lineSourceId: "lines",
    plan: () => contourPlan("m"),
    bbox,
    demMaxzoom: 11,
    demTemplate: TEMPLATE,
    fetcher,
  }));
  preload.start(9.737);
  await idle(preload);

  assert.equal(tracking.urls.length, 0);
  assert.equal(tracking.peak, 0);
  assert.deepEqual(preload.progress(), { done: 0, total: 0, bytes: 0 });
  preload.destroy();
});

test("a full store drops remote traces without unreserved misses", async () => {
  const tracking = { running: 0, peak: 0, urls: [] as string[] };
  const inner = new mlcontour.LocalDemManager({
    demUrlPattern: TEMPLATE,
    cacheSize: 120,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 5000,
    decodeImage: async () => ({
      width: 64,
      height: 64,
      data: new Float32Array(64 * 64),
    }),
    getTile: async (url: string) => {
      tracking.running += 1;
      tracking.peak = Math.max(tracking.peak, tracking.running);
      tracking.urls.push(url);
      try {
        await Promise.resolve();
        return { data: new Blob(["dem"]) };
      } finally {
        tracking.running -= 1;
      }
    },
  });
  const fetcher: DemFetcher = {
    fetchTile: (z, x, y, abort) => inner.fetchTile(z, x, y, abort),
    fetchContourTile: (z, x, y, options, abort) => {
      return inner.fetchContourTile(z, x, y, options, abort);
    },
  };
  const map = fakeMap();
  const preload = new ScenePreload(map, fakeTelemetry(), 1024 * 1024);
  preload.add({
    id: "fill",
    layer: "terrain",
    lanes: 1,
    tasks: () => [{
      key: "fill",
      estimatedBytes: 1024 * 1024,
      run: () => Promise.resolve(new Blob(["x".repeat(1024 * 1024)])),
    }],
    visibleKey: () => null,
  });
  preload.start(9.737);
  await idle(preload);
  assert.equal(preload.progress().bytes, 1024 * 1024);

  preload.add(contourPreloadSource({
    lineSourceId: "lines",
    plan: () => contourPlan("m"),
    bbox: [0, 0, 1.2, 1.2],
    demMaxzoom: 11,
    demTemplate: TEMPLATE,
    fetcher,
  }));
  await idle(preload);

  assert.equal(tracking.urls.length, 0);
  assert.deepEqual(preload.progress().bytes, 1024 * 1024);
  preload.destroy();
});

test("evicted remote parents refetch on one lane", async () => {
  const tracking = { running: 0, peak: 0, urls: [] as string[] };
  const inner = new mlcontour.LocalDemManager({
    demUrlPattern: TEMPLATE,
    cacheSize: 120,
    encoding: "terrarium",
    maxzoom: 11,
    timeoutMs: 5000,
    decodeImage: async () => ({
      width: 64,
      height: 64,
      data: new Float32Array(64 * 64),
    }),
    getTile: async (url: string) => {
      tracking.running += 1;
      tracking.peak = Math.max(tracking.peak, tracking.running);
      tracking.urls.push(url);
      try {
        await Promise.resolve();
        return { data: new Blob(["dem"]) };
      } finally {
        tracking.running -= 1;
      }
    },
  });
  const fetcher: DemFetcher = {
    fetchTile: (z, x, y, abort) => inner.fetchTile(z, x, y, abort),
    fetchContourTile: (z, x, y, options, abort) => {
      return inner.fetchContourTile(z, x, y, options, abort);
    },
  };
  const map = fakeMap();
  const preload = new ScenePreload(map, fakeTelemetry());
  const bbox: Bbox = [0, 0, 1.2, 1.2];
  preload.add(demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox,
    reliefSourceId: "relief",
    fetcher,
  }));
  preload.start(9.737);
  await idle(preload);
  assert.ok(tracking.urls.length > 0);

  for (let index = 0; index < 120; index += 1) {
    await fetcher.fetchTile!(10, 1000 + index, 0, new AbortController());
  }
  tracking.urls.length = 0;
  tracking.peak = 0;
  preload.add(contourPreloadSource({
    lineSourceId: "lines",
    plan: () => contourPlan("m"),
    bbox,
    demMaxzoom: 11,
    demTemplate: TEMPLATE,
    fetcher,
  }));
  await idle(preload);

  assert.ok(tracking.urls.length > 0);
  assert.ok(tracking.peak <= 1);
  preload.destroy();
});

test("visible demand suspends remote background launches", async () => {
  const started: string[] = [];
  const gates = new Map<string, (blob: Blob) => void>();
  const fetcher: DemFetcher = {
    fetchTile: (z, x, y) => {
      const url = tileUrl(TEMPLATE, { z, x, y });
      started.push(url);
      return new Promise<unknown>((resolve) => {
        gates.set(url, (blob) => resolve({ data: blob }));
      });
    },
  };
  const map = fakeMap();
  const preload = new ScenePreload(map, fakeTelemetry());
  const bbox: Bbox = [0, 0, 1.2, 1.2];
  const dem = demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox,
    reliefSourceId: "relief",
    fetcher,
  });
  preload.add(dem);
  preload.start(9.737);
  await settled();
  assert.ok(started.length >= 2);

  const planned = dem.tasks(9.737).map((task) => task.key);
  const wanted = planned.find((key) => !started.includes(key))!;
  const reading = serveStoredTile({ url: `soetile://${wanted}` }, new AbortController());
  await settled();
  assert.ok(started.includes(wanted));
  const before = started.length;
  gates.get(started[0])!(new Blob(["dem"]));
  await settled();

  assert.equal(started.length, before);
  gates.get(wanted)!(new Blob(["dem"]));
  const served = await reading;
  assert.equal(await new Response(served.data).text(), "dem");
  await settled();
  assert.ok(started.length > before);
  preload.destroy();
});

test("a visible join of a pending preload suspends background launches", async () => {
  const started: string[] = [];
  const gates = new Map<string, (blob: Blob) => void>();
  const fetcher: DemFetcher = {
    fetchTile: (z, x, y) => {
      const url = tileUrl(TEMPLATE, { z, x, y });
      started.push(url);
      return new Promise<unknown>((resolve) => {
        gates.set(url, (blob) => resolve({ data: blob }));
      });
    },
  };
  const map = fakeMap();
  const preload = new ScenePreload(map, fakeTelemetry());
  const bbox: Bbox = [0, 0, 1.2, 1.2];
  const dem = demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox,
    reliefSourceId: "relief",
    fetcher,
  });
  preload.add(dem);
  preload.start(9.737);
  await settled();
  assert.ok(started.length >= 2);

  const pending = started[0];
  const reading = serveStoredTile({ url: `soetile://${pending}` }, new AbortController());
  await settled();
  const before = started.length;
  const other = started.find((key) => key !== pending)!;
  gates.get(other)!(new Blob(["dem"]));
  await settled();

  assert.equal(started.length, before);
  gates.get(pending)!(new Blob(["dem"]));
  const served = await reading;
  assert.equal(await new Response(served.data).text(), "dem");
  await settled();
  assert.ok(started.length > before);
  preload.destroy();
});

function demSource(bbox: Bbox, fetcher: DemFetcher | null = null) {
  return demPreloadSource({
    template: TEMPLATE,
    maxzoom: 11,
    bbox,
    reliefSourceId: "terrain-relief",
    fetcher,
  });
}

function contourSource(bbox: Bbox, plan: ContourPlan, fetcher: DemFetcher | null) {
  return contourPreloadSource({
    lineSourceId: "terrain-contours",
    plan: () => plan,
    bbox,
    demMaxzoom: 11,
    demTemplate: TEMPLATE,
    fetcher,
  });
}

function contourPlan(elevationUnit: string): ContourPlan {
  const ladder = contourLadder(STATS, { maxZoom: 12, elevationUnit });
  return { ladder, maxzoom: 12, elevationUnit };
}

function fakeManager() {
  const traces: { z: number; options: unknown }[] = [];
  const fetcher: DemFetcher = {
    fetchContourTile: async (z, _x, _y, options) => {
      traces.push({ z, options });
      return {};
    },
  };
  return { fetcher, traces };
}

/** A manager fake where tracing fans out through the DEM cache like the worker does. */
function fakeWorkerManager() {
  const cached = new Map<string, Blob>();
  const network: string[] = [];
  const traced: string[] = [];
  const fetcher: DemFetcher = {
    fetchTile: async (z, x, y) => {
      const url = tileUrl(TEMPLATE, { z, x, y });
      const hit = cached.get(url);
      if (hit) return { data: hit };
      network.push(url);
      const body = new Blob([`dem-${z}-${x}-${y}`]);
      cached.set(url, body);
      return { data: body };
    },
    fetchContourTile: async (z, x, y, options) => {
      for (const parent of demParentsForTile({ z, x, y }, CONTOUR_OVERZOOM)) {
        const fetched = await fetcher.fetchTile!(
          parent.z,
          parent.x,
          parent.y,
          new AbortController(),
        ) as { data?: unknown };
        if (fetched.data instanceof Blob) {
          traced.push(tileUrl(TEMPLATE, parent));
        }
      }
      return { traced: options };
    },
  };
  return { fetcher, cached, network, traced };
}

function basemapMap(template: string | null, maxzoom: number) {
  return {
    getSource: (id: string) => id === BASEMAP_SOURCE_ID && template
      ? { tiles: [template], maxzoom }
      : null,
  };
}

type FakeMap = PreloadMap & {
  emit(type: string, event: object): void;
  transform: ((url: string, type?: string) => unknown) | null | undefined;
};

function fakeMap(): FakeMap {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const map = {
    transform: undefined as ((url: string, type?: string) => unknown) | null | undefined,
    on: (type: string, listener: (event: object) => void): void => {
      const entries = listeners.get(type) ?? new Set<(event: object) => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off: (type: string, listener: (event: object) => void): void => {
      listeners.get(type)?.delete(listener);
    },
    setTransformRequest: (transform: ((url: string, type?: string) => unknown) | null): void => {
      map.transform = transform;
    },
    emit: (type: string, event: object): void => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
  return map as FakeMap;
}

function fakeTelemetry(): PreloadTelemetry {
  return {
    begin(): void {},
    progress(): void {},
    hit(): void {},
    miss(): void {},
  };
}

/** Let resolved fakes reach the scheduler before the test asserts. */
function settled(): Promise<void> {
  const rounds = 20;
  const advance = async (): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) await Promise.resolve();
  };
  return advance();
}

/** Wait until a real-manager preload finishes, polling with microtasks only. */
async function idle(preload: ScenePreload): Promise<void> {
  for (let round = 0; round < 500; round += 1) {
    await settled();
    const progress = preload.progress();
    if (progress.done === progress.total) {
      await settled();
      if (preload.progress().done === preload.progress().total) return;
    }
  }
}

function traceTile(key: string): number[] {
  return /:(\d+)\/(\d+)\/(\d+):/.exec(key)!.slice(1).map(Number);
}

function zxy(url: string): number[] {
  return url.replace("https://tiles.example.test/", "").replace(".webp", "").split("/").map(Number);
}

function basemapZoom(url: string): number {
  return Number(url.split("/").at(-3));
}

function zoomOf(url: string): number {
  return zxy(url)[0];
}
