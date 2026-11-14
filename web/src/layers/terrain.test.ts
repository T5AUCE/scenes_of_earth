import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

import type { Map as MapLibreMap } from "maplibre-gl";

import { closeScenePreload, openScenePreload } from "./tile-prefetch.ts";

const TERRAIN_SOURCES = ["terrain-relief", "terrain-contours"];
const WARNING = "Terrain shading or contour tiles could not be loaded";

const rootUrl = new URL("./", import.meta.url).href;
const mockModules = {
  "maplibre-gl": `export const addProtocol = () => {};`,
  "./contour-overlay": `
    export const sharedDemSource = () => ({
      sharedDemProtocolUrl: "dem://{z}/{x}/{y}",
      contourProtocolUrl: () => "contour://{z}/{x}/{y}",
    });
    export const terrainTileBounds = () => ({});
    export const cappedDemMaxZoom = (maxzoom) => maxzoom;
    export class ContourOverlay {
      constructor() {
        if (globalThis.contourOverlayShouldThrow) {
          throw new Error("Contour setup failed");
        }
      }
      part = { id: "contours", label: "Contours", layerIds: [] };
      contourSourceIds = ["terrain-contours", "terrain-labels-contours"];
      units = "m";
      setColor() {}
      setUnits(unit) {
        this.units = unit;
      }
      destroy() {}
    }
  `,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.startsWith(rootUrl)) return next(specifier, context);

    if (specifier in mockModules) {
      const source = mockModules[specifier as keyof typeof mockModules];
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const {
  createTerrainView,
  MAX_MISSING_TILES,
  setTerrainBaseZoom,
  watchTerrainTiles,
} = await import("./terrain.ts");
const { ShadeRaster } = await import("./shade-raster.ts");
hooks.deregister();

test("a terrain view warms its elevation tiles with the HTTP-cache warmer", (t) => {
  t.mock.method(globalThis, "fetch", () => new Promise(() => {}));
  const { map } = terrainMap();
  const preload = openScenePreload(map as never);
  try {
    const view = createTestTerrainView(map);
    preload.start(9.5);
    assert.ok(preload.progress().total > 0);
    assert.equal(preload.progress().bytes, 0);

    view.destroy();

    assert.equal(preload.progress().total, 0);
  } finally {
    closeScenePreload();
  }
});

test("a cancellation or missing tile is ignored", (context) => {
  const { map, emit } = fakeMap();
  const reporter = makeReporter(context);
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, reporter.report);

  for (const error of [
    { name: "Error", message: "aborted" },
    { name: "AbortError", message: "The operation was aborted" },
    { name: "Error", message: "Bad response: 404 for https://example.test/8/1/2.webp" },
  ]) {
    emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(), error });
  }

  assert.deepEqual(reporter.notes, []);
});

test("worker-forwarded cancellations and missing tiles are ignored", (context) => {
  const reporter = makeReporter(context);

  for (const error of [
    { name: "Error", message: "Error: aborted" },
    { name: "Error", message: "Error: Bad response: 404 for https://example.test/8/1/2.webp" },
  ]) {
    const { map, emit } = fakeMap();
    watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, reporter.report);

    for (let failureCount = 0; failureCount < 3; failureCount += 1) {
      emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(), error });
    }

    assert.deepEqual(reporter.notes, []);
  }
});

test("a repeated missing tile warns once per session", (context) => {
  const warnings: unknown[][] = [];
  context.mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args));
  const { map, emit } = fakeMap();
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, () => () => {});
  const missing = {
    name: "Error",
    message: "Bad response: 404 for https://example.test/7/3/5.webp",
  };

  emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(7, 3, 5), error: missing });
  emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(7, 3, 5), error: missing });
  emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(7, 3, 6), error: missing });

  assert.equal(warnings.length, 2);
});

test("the missing tile memo drops its oldest tile past its cap", (context) => {
  const warnings: unknown[][] = [];
  context.mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args));
  const { map, emit } = fakeMap();
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, () => () => {});
  const missing = {
    name: "Error",
    message: "Bad response: 404 for https://example.test/tile.webp",
  };

  for (let tileX = 0; tileX <= MAX_MISSING_TILES; tileX++) {
    emit("error", {
      sourceId: TERRAIN_SOURCES[0],
      tile: tile(9, tileX, 1),
      error: missing,
    });
  }
  assert.equal(warnings.length, MAX_MISSING_TILES + 1);

  // The first tile fell out of the full memo, so it warns again while a fresh tile does not.
  emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(9, 0, 1), error: missing });
  assert.equal(warnings.length, MAX_MISSING_TILES + 2);
  emit("error", {
    sourceId: TERRAIN_SOURCES[0],
    tile: tile(9, MAX_MISSING_TILES, 1),
    error: missing,
  });
  assert.equal(warnings.length, MAX_MISSING_TILES + 2);
});

test("a failed tile among successful loads gives no warning", (context) => {
  const { map, emit } = fakeMap();
  const reporter = makeReporter(context);
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, reporter.report);

  emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(), error: failure() });
  emit("sourcedata", { sourceId: TERRAIN_SOURCES[0], tile: tile() });
  emit("error", { sourceId: TERRAIN_SOURCES[1], tile: tile(), error: failure() });
  emit("error", { sourceId: TERRAIN_SOURCES[1], tile: tile(), error: failure() });

  assert.deepEqual(reporter.notes, []);
});

test("persistent failures without a loaded tile give a warning", (context) => {
  const { map, emit } = fakeMap();
  const reporter = makeReporter(context);
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, reporter.report);

  for (let failureCount = 0; failureCount < 3; failureCount += 1) {
    emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(), error: failure() });
  }

  assert.deepEqual(reporter.notes, [WARNING]);

  emit("error", { sourceId: TERRAIN_SOURCES[0], tile: tile(), error: failure() });
  assert.deepEqual(reporter.notes, [WARNING]);
});

test("a persistent label-source failure warns while the line source stays healthy", (context) => {
  const sources = ["terrain-relief", "terrain-contours", "terrain-labels-contours"];
  const { map, emit } = fakeMap();
  const reporter = makeReporter(context);
  watchTerrainTiles(map as unknown as MapLibreMap, sources, reporter.report);

  emit("sourcedata", { sourceId: "terrain-contours", tile: tile() });
  for (let failureCount = 0; failureCount < 3; failureCount += 1) {
    emit("error", { sourceId: "terrain-labels-contours", tile: tile(), error: failure() });
  }

  assert.deepEqual(reporter.notes, [WARNING]);
});

test("the terrain view watches its label source for failures", (context) => {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const map = {
    addSource() {},
    addLayer() {},
    getLayer: () => undefined,
    getSource: () => undefined,
    on(type: string, listener: (event: object) => void) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off(type: string, listener: (event: object) => void) {
      listeners.get(type)?.delete(listener);
    },
    setPaintProperty() {},
  };
  const reporter = makeReporter(context);
  const view = createTerrainView({
    map,
    store: Promise.resolve({}),
    layer: {
      id: "terrain",
      title: "Terrain",
      units: "m",
      grid: { bbox: [0, 0, 1, 1], res: 1, nx: 2, ny: 2 },
      tiles: {
        url: "https://example.test/{z}/{x}/{y}",
        encoding: "terrarium",
        tile_size: 512,
        maxzoom: 11,
        source: { name: "DEM", licence: "open" },
      },
      stats: {
        min: 0,
        max: 100,
        mean: 50,
        p2: 5,
        p98: 95,
        slope_p50_deg: 5,
        slope_p90_deg: 10,
        cell_m: 500,
      },
    },
    shift: 0,
    slots: { fill: "fill", shade: "shade", marks: "marks", lines: "lines" },
    beforeId: undefined,
    report: reporter.report,
  } as unknown as Parameters<typeof createTerrainView>[0]);

  const emit = (type: string, event: object) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };
  for (let failureCount = 0; failureCount < 3; failureCount += 1) {
    emit("error", { sourceId: "terrain-labels-contours", tile: tile(), error: failure() });
  }
  assert.deepEqual(reporter.notes, [WARNING]);
  view.destroy();
});

test("a successful tile clears the warning", (context) => {
  const { map, emit } = fakeMap();
  const reporter = makeReporter(context);
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, reporter.report);

  for (let failureCount = 0; failureCount < 3; failureCount += 1) {
    emit("error", { sourceId: TERRAIN_SOURCES[1], tile: tile(), error: failure() });
  }
  assert.deepEqual(reporter.notes, [WARNING]);

  emit("sourcedata", { sourceId: TERRAIN_SOURCES[1], tile: tile() });
  assert.deepEqual(reporter.notes, []);

  emit("error", { sourceId: TERRAIN_SOURCES[1], tile: tile(), error: failure() });
  assert.deepEqual(reporter.notes, []);
});

test("a successful source does not mask another source's failures", (context) => {
  const { map, emit } = fakeMap();
  const reporter = makeReporter(context);
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, reporter.report);

  emit("sourcedata", { sourceId: TERRAIN_SOURCES[0], tile: tile() });
  for (let failureCount = 0; failureCount < 3; failureCount += 1) {
    emit("error", { sourceId: TERRAIN_SOURCES[1], tile: tile(), error: failure() });
  }

  assert.deepEqual(reporter.notes, [WARNING]);
});

test("failures from different sources do not add up to a warning", (context) => {
  const { map, emit } = fakeMap();
  const reporter = makeReporter(context);
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, reporter.report);

  for (const sourceId of TERRAIN_SOURCES) {
    for (let failureCount = 0; failureCount < 2; failureCount += 1) {
      emit("error", { sourceId, tile: tile(), error: failure() });
    }
  }

  assert.deepEqual(reporter.notes, []);
});

test("a source's success clears only its own warning", (context) => {
  const { map, emit } = fakeMap();
  const reporter = makeReporter(context);
  watchTerrainTiles(map as unknown as MapLibreMap, TERRAIN_SOURCES, reporter.report);

  for (let failureCount = 0; failureCount < 3; failureCount += 1) {
    emit("error", { sourceId: TERRAIN_SOURCES[1], tile: tile(), error: failure() });
  }
  assert.deepEqual(reporter.notes, [WARNING]);

  emit("sourcedata", { sourceId: TERRAIN_SOURCES[0], tile: tile() });
  assert.deepEqual(reporter.notes, [WARNING]);

  emit("sourcedata", { sourceId: TERRAIN_SOURCES[1], tile: tile() });
  assert.deepEqual(reporter.notes, []);
});

test("the terrain view exposes its relief base refit", () => {
  const { map } = terrainMap();
  const view = createTestTerrainView(map);

  assert.equal(typeof view.setBaseZoom, "function");

  view.destroy();
});

test("entry refits every terrain base on its map", (t) => {
  const seen: number[] = [];
  t.mock.method(ShadeRaster.prototype, "setBaseZoom", (zoom: number) => {
    seen.push(zoom);
  });
  const { map } = terrainMap();
  const { map: otherMap } = terrainMap();
  const view = createTestTerrainView(map);
  const other = createTestTerrainView(otherMap);

  setTerrainBaseZoom(map, 5);

  assert.deepEqual(seen, [5]);

  view.setBaseZoom(6);

  assert.deepEqual(seen, [5, 6]);

  view.destroy();
  setTerrainBaseZoom(map, 7);

  assert.deepEqual(seen, [5, 6]);

  other.destroy();
});

test("a failed contour setup rolls back its shading registration", (t) => {
  const seen: number[] = [];
  t.mock.method(ShadeRaster.prototype, "setBaseZoom", (zoom: number) => {
    seen.push(zoom);
  });
  const { map, removed } = terrainMap();
  const flag = globalThis as { contourOverlayShouldThrow?: boolean };
  flag.contourOverlayShouldThrow = true;
  try {
    assert.throws(() => createTestTerrainView(map), /Contour setup failed/);
  } finally {
    flag.contourOverlayShouldThrow = false;
  }

  assert.ok(removed.includes("terrain-relief"));
  setTerrainBaseZoom(map as unknown as MapLibreMap, 5);

  assert.deepEqual(seen, []);

  const view = createTestTerrainView(map);
  setTerrainBaseZoom(map as unknown as MapLibreMap, 5);

  assert.deepEqual(seen, [5]);

  view.destroy();
});

function fakeMap() {
  const listeners = new Map<string, Set<(event: object) => void>>();

  const map = {
    on(type: string, listener: (event: object) => void) {
      const typeListeners = listeners.get(type) ?? new Set();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    off(type: string, listener: (event: object) => void) {
      listeners.get(type)?.delete(listener);
    },
  };

  const emit = (type: string, event: object) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };

  return { map, emit };
}

function makeReporter(context: TestContext) {
  context.mock.method(console, "warn", () => {});
  const notes: string[] = [];

  const report = (error: unknown) => {
    const message = (error as Error).message;
    notes.push(message);
    return () => {
      const index = notes.indexOf(message);
      if (index >= 0) notes.splice(index, 1);
    };
  };

  return { notes, report };
}

function tile(z = 8, x = 1, y = 2) {
  return { tileID: { canonical: { z, x, y } } };
}

function failure() {
  return { name: "Error", message: "Network request failed" };
}

test("relief loads worker-shaded raster tiles instead of the contour protocol", () => {
  const { map, sources } = terrainMap();
  const tiles = {
    url: "https://example.test/{z}/{x}/{y}",
    encoding: "terrarium",
    tile_size: 512,
    maxzoom: 11,
    source: { name: "DEM", licence: "open" },
  };
  const view = createTerrainView({
    map,
    store: Promise.resolve({}),
    layer: {
      id: "terrain",
      title: "Terrain",
      units: "m",
      grid: { bbox: [0, 0, 1, 1], res: 1, nx: 2, ny: 2 },
      tiles,
      stats: {
        min: 0,
        max: 100,
        mean: 50,
        p2: 5,
        p98: 95,
        slope_p50_deg: 5,
        slope_p90_deg: 10,
        cell_m: 500,
      },
    },
    shift: 0,
    slots: { fill: "fill", shade: "shade", marks: "marks", lines: "lines" },
    beforeId: undefined,
    report: () => () => {},
  } as unknown as Parameters<typeof createTerrainView>[0]);

  const relief = sources.get("terrain-relief")!;
  assert.equal(relief.type, "raster");
  assert.match((relief.tiles as string[])[0], /^soeshade:\/\/\d+\/0\/\{z\}\/\{x\}\/\{y\}$/);

  view.destroy();
});

test("relief is always a fading raster layer", () => {
  const { map, layers, removed } = terrainMap();

  const view = createTestTerrainView(map);

  assert.equal(layers[0].type, "raster");
  assert.equal((layers[0].paint as Record<string, unknown>)["raster-fade-duration"], 250);

  view.destroy();

  assert.ok(removed.includes("terrain-relief"));
});

test("terrain offers metres and feet and forwards the choice to contours", () => {
  const map = {
    addSource() {},
    addLayer() {},
    getLayer: () => undefined,
    getSource: () => undefined,
    removeLayer() {},
    removeSource() {},
    on() {},
    off() {},
    setPaintProperty() {},
  };
  const view = createTerrainView({
    map,
    store: Promise.resolve({}),
    layer: {
      id: "terrain",
      title: "Terrain",
      units: "m",
      grid: { bbox: [0, 0, 1, 1], res: 1, nx: 2, ny: 2 },
      tiles: {
        url: "https://example.test/{z}/{x}/{y}",
        encoding: "terrarium",
        tile_size: 512,
        maxzoom: 11,
        source: { name: "DEM", licence: "open" },
      },
      stats: {
        min: 0,
        max: 100,
        mean: 50,
        p2: 5,
        p98: 95,
        slope_p50_deg: 5,
        slope_p90_deg: 10,
        cell_m: 500,
      },
    },
    shift: 0,
    slots: { fill: "fill", shade: "shade", marks: "marks", lines: "lines" },
    beforeId: undefined,
    report: () => () => {},
  } as unknown as Parameters<typeof createTerrainView>[0]);

  assert.deepEqual(view.menu?.units?.options, ["m", "ft"]);
  assert.equal(view.menu?.units?.defaultUnit, "m");
  assert.equal(view.menu?.units?.value, "m");

  view.menu?.units?.set("ft");
  assert.equal(view.menu?.units?.value, "ft");

  view.menu?.units?.set("m");
  assert.equal(view.menu?.units?.value, "m");

  view.destroy();
});

function terrainMap() {
  const sources = new Map<string, { type?: unknown; tiles?: unknown }>();
  const layers: { id: string; type: string; paint?: unknown }[] = [];
  const removed: string[] = [];
  const map = {
    addSource(id: string, source: { tiles?: unknown }) {
      sources.set(id, source);
    },
    addLayer(layer: { id: string; type: string }) {
      layers.push(layer);
    },
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    getSource: (id: string) => sources.get(id),
    removeLayer(id: string) {
      removed.push(id);
    },
    removeSource(id: string) {
      removed.push(id);
    },
    on() {},
    off() {},
    setPaintProperty() {},
  };
  return { map, sources, layers, removed };
}

function createTestTerrainView(map: ReturnType<typeof terrainMap>["map"]) {
  return createTerrainView({
    map,
    store: Promise.resolve({}),
    layer: {
      id: "terrain",
      title: "Terrain",
      units: "m",
      grid: { bbox: [0, 0, 1, 1], res: 1, nx: 2, ny: 2 },
      tiles: {
        url: "https://example.test/{z}/{x}/{y}",
        encoding: "terrarium",
        tile_size: 512,
        maxzoom: 11,
        source: { name: "DEM", licence: "open" },
      },
      stats: {
        min: 0,
        max: 100,
        mean: 50,
        p2: 5,
        p98: 95,
        slope_p50_deg: 5,
        slope_p90_deg: 10,
        cell_m: 500,
      },
    },
    shift: 0,
    slots: { fill: "fill", shade: "shade", marks: "marks", lines: "lines" },
    beforeId: undefined,
    report: () => () => {},
  } as unknown as Parameters<typeof createTerrainView>[0]);
}
