/** The DEM and basemap preload sources: enumeration, keys and downloads. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { warmTilesForZoom } from "../contour-ladder.ts";
import { acquireDemPool, releaseDemPool } from "../gpu/dem/pool-registry.ts";
import { BASEMAP_SOURCE_ID, scenePyramidTiles } from "../render/tile-viewport.ts";
import type { Bbox } from "../types.ts";
import {
  BASEMAP_ANCESTOR_LEVELS,
  BASEMAP_PRELOAD_MAX_ZOOM,
  BASEMAP_PRELOAD_TILES,
  basemapPreloadSource,
  demPreloadSource,
  DEM_PRELOAD_TILES,
  tileUrl,
} from "./scene-preload.ts";
import type { PreloadSource, PreloadTask } from "./tile-prefetch.ts";
import { TileWarmer, WARMER_LANES } from "./tile-warmer.ts";

const TEMPLATE = "https://tiles.example.test/{z}/{x}/{y}.webp";
const LIBERTY = "https://tiles.openfreemap.org/planet/20260101_001001_pt/{z}/{x}/{y}.pbf";
const SMALL_SCENE: Bbox = [36.5, -1.5, 37.5, -0.5];
const COUNTRY_SCENE: Bbox = [33.9, -4.7, 41.9, 5.5];
const REST_VIEWPORT = { west: 36.8, south: -1.2, east: 37.2, north: -0.8 };

test("tile URLs fill the template without scene identity", () => {
  assert.equal(tileUrl(TEMPLATE, { z: 9, x: 1, y: 2 }), "https://tiles.example.test/9/1/2.webp");
});

test("a small scene preloads every DEM level from the contour parents down to the cap", () => {
  const tasks = demSource(SMALL_SCENE).tasks(9.3);
  const zooms = tasks.map((task) => zoomOf(task.key));

  assert.deepEqual([...new Set(zooms)], [8, 9, 10, 11]);
  assert.ok(tasks.length <= DEM_PRELOAD_TILES);
  assert.deepEqual(
    zooms,
    [...zooms].sort((first, second) => first - second),
  );
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
  const tasks = demSource([171, 50, 231, 55])
    .tasks(5)
    .filter((task) => zoomOf(task.key) === 4);
  const columns = new Set(tasks.map((task) => zxy(task.key)[1]));

  assert.ok(columns.has(15) && columns.has(0));
  assert.ok([...columns].every((column) => column >= 0 && column < 16));
});

test("a DEM download uses a low-priority fetch", async (t) => {
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
  globalThis.fetch = async () => new Response("", { status: 404 });
  t.after(() => {
    globalThis.fetch = original;
  });

  const [task] = demSource(SMALL_SCENE).tasks(11);

  await assert.rejects(task.run(new AbortController()), /Bad response: 404/);
});

test("a DEM plan skips tiles the pool already holds", async () => {
  const canvas = new EventTarget();
  const listeners = new Set<() => void>();
  const map = {
    getCanvas: () => canvas,
    triggerRepaint: () => {},
    on: (_type: "render", listener: () => void) => void listeners.add(listener),
    off: (_type: "render", listener: () => void) => void listeners.delete(listener),
  };
  const options = {
    map,
    gl: {} as WebGL2RenderingContext,
    tileUrl: TEMPLATE,
    createStore: () => ({ linear: true, create: () => ({}), patch: () => {}, remove: () => {} }),
    createWorker: () => ({ post: () => {}, onResponse: () => {}, terminate: () => {} }),
  };
  const pool = acquireDemPool(options);

  try {
    const [first] = demSource(SMALL_SCENE).tasks(9.3);
    const [z, x, y] = zxy(first.key);
    pool.update([{ z, x, y, tier: "view" }]);

    const keys = new Set(
      demSource(SMALL_SCENE)
        .tasks(9.3)
        .map((task) => task.key),
    );

    assert.equal(keys.has(first.key), false);

    const dwell = demSource(SMALL_SCENE).dwell!(
      { west: 36, south: -2, east: 38, north: 0 },
      5,
      9.3,
    );

    assert.ok(dwell.every((task) => task.key !== first.key));
  } finally {
    releaseDemPool(map, TEMPLATE);
  }
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

test("basemap preload waits for a resolved source", () => {
  const empty = basemapPreloadSource(basemapMap(null, 14), SMALL_SCENE);

  assert.deepEqual(empty.tasks(9), []);

  const source = basemapPreloadSource(basemapMap(LIBERTY, 14), SMALL_SCENE);
  const tasks = source.tasks(9);

  assert.ok(tasks.length > 0);
  assert.ok(tasks.every((task) => task.key.startsWith("https://tiles.openfreemap.org/planet/")));
});

test("a DEM dwell warms the resting viewport inside the request cap", () => {
  const viewport = { west: 36, south: -2, east: 38, north: 0 };
  const source = demSource(SMALL_SCENE);
  const tasks = source.dwell!(viewport, 5, 9.3);

  assert.ok(tasks.length > 0 && tasks.length <= 64);
  assert.ok(tasks.every((task) => task.key.startsWith("https://tiles.example.test/")));
  assert.ok(tasks.every((task) => zoomOf(task.key) <= 11));
  assert.ok(tasks.every((task) => typeof task.zoom === "number"));
});

test("a DEM dwell warms nothing past the DEM ceiling", () => {
  const viewport = { west: 36, south: -2, east: 38, north: 0 };
  const tasks = demSource(SMALL_SCENE).dwell!(viewport, 11, 14);

  assert.ok(tasks.every((task) => zoomOf(task.key) <= 11));
});

test("a DEM dwell far from the scene warms nothing", () => {
  const viewport = { west: -20, south: -10, east: 20, north: 10 };

  assert.deepEqual(demSource(SMALL_SCENE).dwell!(viewport, 5, 9.3), []);
});

test("a basemap dwell warms the viewport inside the cap and ceiling", () => {
  const viewport = { west: 36, south: -2, east: 38, north: 0 };
  const source = basemapPreloadSource(basemapMap(LIBERTY, 14), SMALL_SCENE);
  const tasks = source.dwell!(viewport, 5, 9.3);

  assert.ok(tasks.length > 0 && tasks.length <= 64);
  assert.ok(tasks.every((task) => task.key.startsWith("https://tiles.openfreemap.org/planet/")));
  assert.ok(tasks.every((task) => basemapZoom(task.key) <= BASEMAP_PRELOAD_MAX_ZOOM));
});

test("a basemap dwell far from the scene warms nothing", () => {
  const viewport = { west: -20, south: -10, east: 20, north: 10 };
  const source = basemapPreloadSource(basemapMap(LIBERTY, 14), SMALL_SCENE);

  assert.deepEqual(source.dwell!(viewport, 5, 9.3), []);
});

test("a basemap dwell without a resolved source warms nothing", () => {
  const viewport = { west: 36, south: -2, east: 38, north: 0 };
  const source = basemapPreloadSource(basemapMap(null, 14), SMALL_SCENE);

  assert.deepEqual(source.dwell!(viewport, 5, 9.3), []);
});

test("preload tasks carry their tile zoom for gate ordering", () => {
  const dem = demSource(SMALL_SCENE).tasks(9.3);

  assert.ok(dem.length > 0);
  assert.ok(dem.every((task) => typeof task.zoom === "number"));
  assert.ok(dem.some((task) => task.zoom === 9));
  assert.ok(dem.some((task) => (task.zoom ?? 0) > 9));

  const basemap = basemapPreloadSource(basemapMap(LIBERTY, 14), SMALL_SCENE).tasks(9.3);

  assert.ok(basemap.length > 0);
  assert.ok(basemap.every((task) => typeof task.zoom === "number"));
  assert.ok(basemap.some((task) => task.zoom === 9));
});

test("a basemap dwell loads the coarser levels into the tile manager nearest level first", async () => {
  const { map, added } = tileManagerMap();
  const run = startAncestors(map, 10.3);

  await settle();

  assert.deepEqual(added.map(zoomOfTileId), [9]);

  for (let level = 0; level < BASEMAP_ANCESTOR_LEVELS; level += 1) {
    await finishLastAddedTile(map);
  }

  await run.done;

  const zooms = added.map(zoomOfTileId);

  assert.deepEqual(zooms.slice(0, 1), [9]);
  assert.deepEqual(
    zooms,
    [...zooms].sort((first, second) => second - first),
  );
  assert.ok(zooms.every((zoom) => zoom >= 10 - BASEMAP_ANCESTOR_LEVELS && zoom < 10));
});

test("a basemap dwell leaves the loaded levels to the tile manager instead of downloading them", () => {
  const { map } = tileManagerMap();
  const source = basemapPreloadSource(map, SMALL_SCENE);
  const zooms = source.dwell!(REST_VIEWPORT, 5, 10.3)
    .filter((task) => !isAncestorTask(task))
    .map((task) => basemapZoom(task.key));

  assert.ok(zooms.length > 0);
  assert.ok(zooms.every((zoom) => zoom < 7 || zoom >= 10));

  map.emit("movestart", {});
});

test("a rest loads the ancestors while the entry download backlog is still queued", async (t) => {
  const { warmer, map, added, fetched } = await restedWarmerWithBacklog(t);

  assert.equal(fetched.length, WARMER_LANES);
  assert.ok(added.length > 0);

  warmer.destroy();
  map.emit("movestart", {});
});

test("closing the preload stops the ancestor loading that ran ahead of the entry backlog", async (t) => {
  const { warmer, map, added } = await restedWarmerWithBacklog(t);

  warmer.destroy();
  await settle();
  await finishLastAddedTile(map);

  assert.equal(added.length, 1);
  assert.equal(map.listenerCount(), 0);
});

test("removing the basemap source stops the ancestor loading while other sources hold every lane", async (t) => {
  const { warmer, map, added } = await restedWarmerWithBacklog(t, { otherSourceFirst: true });

  assert.equal(added.length, 1);

  warmer.remove("basemap");
  await finishLastAddedTile(map);

  assert.equal(added.length, 1);

  warmer.destroy();
});

test("closing the preload stops the ancestor loading while other sources hold every lane", async (t) => {
  const { warmer, map, added } = await restedWarmerWithBacklog(t, { otherSourceFirst: true });

  warmer.destroy();
  await finishLastAddedTile(map);

  assert.equal(added.length, 1);
  assert.equal(map.listenerCount(), 0);
});

test("a camera move stops the ancestor loading that ran ahead of the entry backlog", async (t) => {
  const { warmer, map, added, removed } = await restedWarmerWithBacklog(t);

  map.emit("movestart", {});
  await settle();

  assert.equal(added.length, 1);
  assert.deepEqual(removed, [added[0].key]);

  warmer.destroy();
});

test("the ancestor loader starts a tile only after the previous one settles", async () => {
  const { map, added } = tileManagerMap();

  startAncestors(map, 10.3);
  await settle();

  assert.equal(added.length, 1);

  await finishLastAddedTile(map);

  assert.equal(added.length, 2);
});

test("a later dwell releases the tile the replaced loader was waiting on before the next starts", async () => {
  const { map, added, removed } = tileManagerMap();
  const first = startAncestors(map, 10.3);
  await settle();

  first.abort.abort();
  await first.done;

  assert.deepEqual(removed, [added[0].key]);
  assert.equal(map.listenerCount(), 0);

  startAncestors(map, 8.3);
  await settle();

  assert.equal(added.length, 2);
  assert.ok(zoomOfTileId(added[1]) < 8);
});

test("the ancestor loader stops and releases its tile when the camera starts moving", async () => {
  const { map, added, removed } = tileManagerMap();
  const run = startAncestors(map, 10.3);
  await settle();

  map.emit("movestart", {});
  await run.done;

  assert.equal(added.length, 1);
  assert.deepEqual(removed, [added[0].key]);
  assert.equal(map.listenerCount(), 0);
});

test("the ancestor loader stops for good when the preloader aborts it", async () => {
  const { map, added } = tileManagerMap();
  const run = startAncestors(map, 10.3);
  await settle();

  run.abort.abort();
  await run.done;
  await finishLastAddedTile(map);

  assert.equal(added.length, 1);
  assert.equal(map.listenerCount(), 0);
});

test("the ancestor loader releases a tile that never announces itself before the next one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { map, added, removed } = tileManagerMap();

  startAncestors(map, 10.3);
  await settle();
  t.mock.timers.tick(5 * 1000);
  await settle();

  assert.deepEqual(removed, [added[0].key]);
  assert.equal(added.length, 2);
  assert.equal(map.listenerCount(), 4);
});

test("the ancestor loader leaves a tile the manager already held when it stops", async () => {
  const { map, removed } = tileManagerMap({ holdsAncestors: true });
  const run = startAncestors(map, 10.3);
  await settle();

  run.abort.abort();
  await run.done;

  assert.deepEqual(removed, []);
});

test("the ancestor loader skips tiles the manager already holds", async () => {
  const { map, added } = tileManagerMap({ loaded: true });
  const run = startAncestors(map, 10.3);

  await run.done;

  assert.ok(added.length > 1);
  assert.equal(map.listenerCount(), 0);
});

test("a dwell downloads the ancestors itself when the tile manager lookup throws", () => {
  const { map } = tileManagerMap({ breaks: "getIds" });

  assert.deepEqual(dwellKeys(map).filter(isAncestorUrl).sort(), expectedAncestorUrls().sort());
  assert.equal(dwellTasks(map).filter(isAncestorTask).length, 0);
});

test("a dwell downloads the ancestors itself when the tile manager lacks the private methods", () => {
  const { map } = tileManagerMap({ bare: true });

  assert.deepEqual(dwellKeys(map).filter(isAncestorUrl).sort(), expectedAncestorUrls().sort());
  assert.equal(dwellTasks(map).filter(isAncestorTask).length, 0);
});

test("a dwell downloads the ancestors itself when no shown tile covers them", () => {
  const { map } = tileManagerMap({ shownNothing: true });

  assert.deepEqual(dwellKeys(map).filter(isAncestorUrl).sort(), expectedAncestorUrls().sort());
});

test("the ancestor loader downloads a tile when adding it to the tile manager throws", async (t) => {
  const requests: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return new Response("bytes", { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const { map } = tileManagerMap({ breaks: "_addTile" });
  const run = startAncestors(map, 10.3);

  await run.done;

  assert.deepEqual([...requests].sort(), expectedAncestorUrls().sort());
});

// Never-settling tasks fill every warmer lane before the basemap gets one.
function heldLanesSource(): PreloadSource {
  return {
    id: "other",
    layer: "terrain",
    lanes: WARMER_LANES,
    tasks: () => {
      return Array.from({ length: WARMER_LANES }, (_unused, index) => ({
        key: `other-${index}`,
        run: () => new Promise<undefined>(() => {}),
      }));
    },
  };
}

// Entry downloads never settle, so the country scene's whole entry backlog stays queued.
async function restedWarmerWithBacklog(
  t: TestContext,
  options: { otherSourceFirst?: boolean } = {},
) {
  const fetched: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init: { signal: AbortSignal }) => {
    fetched.push(url);

    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const { map, added, removed } = tileManagerMap();
  const warmer = new TileWarmer({
    ...map,
    getZoom: () => 10.3,
    getBounds: () => ({
      getWest: () => REST_VIEWPORT.west,
      getSouth: () => REST_VIEWPORT.south,
      getEast: () => REST_VIEWPORT.east,
      getNorth: () => REST_VIEWPORT.north,
    }),
  });

  if (options.otherSourceFirst) warmer.add(heldLanesSource());
  warmer.add(basemapPreloadSource(map, COUNTRY_SCENE));
  warmer.start(3);
  warmer.noteLanded();
  map.emit("idle", {});
  await settle();

  return { warmer, map, added, removed, fetched };
}

function startAncestors(map: ReturnType<typeof tileManagerMap>["map"], zoom: number) {
  const abort = new AbortController();
  const task = dwellTasks(map, zoom).find(isAncestorTask)!;

  return { abort, done: task.run(abort) };
}

function dwellTasks(map: ReturnType<typeof tileManagerMap>["map"], zoom = 10.3): PreloadTask[] {
  return basemapPreloadSource(map, SMALL_SCENE).dwell!(REST_VIEWPORT, 5, zoom);
}

function dwellKeys(map: ReturnType<typeof tileManagerMap>["map"]): string[] {
  return dwellTasks(map).map((task) => task.key);
}

function isAncestorTask(task: PreloadTask): boolean {
  return task.key.includes("ancestors");
}

function isAncestorUrl(url: string): boolean {
  const zoom = basemapZoom(url);
  return url.startsWith("https://tiles.openfreemap.org/") && zoom >= 7 && zoom < 10;
}

function expectedAncestorUrls(): string[] {
  return [9, 8, 7].flatMap((zoom) => {
    return warmTilesForZoom(36.8, -1.2, 37.2, -0.8, zoom, 12).map((tile) => tileUrl(LIBERTY, tile));
  });
}

function demSource(bbox: Bbox) {
  return demPreloadSource({ template: TEMPLATE, maxzoom: 11, bbox });
}

function basemapMap(template: string | null, maxzoom: number) {
  return {
    getSource: (id: string) =>
      id === BASEMAP_SOURCE_ID && template ? { tiles: [template], maxzoom } : null,
  };
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

interface FakeTileId {
  key: number;
  overscaledZ: number;
  canonical: { z: number; x: number; y: number };
  scaledTo: (zoom: number) => FakeTileId;
}

function fakeTileId(z: number, x: number, y: number): FakeTileId {
  return {
    key: (z * 4096 + x) * 4096 + y,
    overscaledZ: z,
    canonical: { z, x, y },
    scaledTo: (zoom) => fakeTileId(zoom, x >> (z - zoom), y >> (z - zoom)),
  };
}

function zoomOfTileId(tileId: FakeTileId): number {
  return tileId.canonical.z;
}

interface TileManagerOptions {
  loaded?: boolean;
  bare?: boolean;
  shownNothing?: boolean;
  holdsAncestors?: boolean;
  breaks?: "getIds" | "_addTile";
}

// The map shows the z10 tiles of the viewport, as a resting map does.
function tileManagerMap(options: TileManagerOptions = {}) {
  const added: FakeTileId[] = [];
  const removed: number[] = [];
  const returned: { state: string }[] = [];
  const shown = warmTilesForZoom(36.8, -1.2, 37.2, -0.8, 10, 50).map((tile) => {
    return { tileID: fakeTileId(10, tile.x, tile.y) };
  });
  const listeners = new Map<string, Set<(event: { tile?: unknown }) => void>>();
  const manager = options.bare
    ? {}
    : {
        getIds: () => {
          if (options.breaks === "getIds") throw new Error("private lookup changed");

          return options.shownNothing ? [] : shown.map((_tile, index) => String(index));
        },
        getTileByID: (id: string) => {
          return shown[Number(id)] ?? (options.holdsAncestors ? { tileID: undefined } : undefined);
        },
        _addTile: (tileId: FakeTileId) => {
          if (options.breaks === "_addTile") throw new Error("tile manager changed");

          added.push(tileId);

          const tile = { state: options.loaded ? "loaded" : "loading" };
          returned.push(tile);

          return tile;
        },
        _removeTile: (id: number) => {
          removed.push(id);
          returned.find((_tile, index) => added[index].key === id)!.state = "unloaded";
        },
      };
  const map = {
    returned,
    style: { tileManagers: { [BASEMAP_SOURCE_ID]: manager } },
    getSource: () => ({ tiles: [LIBERTY], maxzoom: 14 }),
    on: (type: string, listener: (event: { tile?: unknown }) => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    off: (type: string, listener: (event: { tile?: unknown }) => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: string, event: { tile?: unknown }) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };

  return { map, added, removed };
}

async function finishLastAddedTile(map: ReturnType<typeof tileManagerMap>["map"]): Promise<void> {
  map.emit("sourcedata", { tile: map.returned.at(-1) });
  await settle();
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
