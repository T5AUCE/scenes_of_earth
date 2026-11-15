/** The DEM and basemap preload sources: enumeration, keys and downloads. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { acquireDemPool, releaseDemPool } from "../gpu/dem-pool.ts";
import { BASEMAP_SOURCE_ID, scenePyramidTiles } from "../render/tile-viewport.ts";
import type { Bbox } from "../types.ts";
import {
  BASEMAP_PRELOAD_MAX_ZOOM,
  BASEMAP_PRELOAD_TILES,
  basemapPreloadSource,
  demPreloadSource,
  DEM_PRELOAD_TILES,
  tileUrl,
} from "./scene-preload.ts";

const TEMPLATE = "https://tiles.example.test/{z}/{x}/{y}.webp";
const LIBERTY = "https://tiles.openfreemap.org/planet/20260101_001001_pt/{z}/{x}/{y}.pbf";
const SMALL_SCENE: Bbox = [36.5, -1.5, 37.5, -0.5];
const COUNTRY_SCENE: Bbox = [33.9, -4.7, 41.9, 5.5];

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
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
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
