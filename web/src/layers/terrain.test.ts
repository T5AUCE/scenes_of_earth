import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

import type { Map as MapLibreMap } from "maplibre-gl";

const TERRAIN_SOURCES = ["terrain-relief", "terrain-contours"];
const WARNING = "Terrain shading or contour tiles could not be loaded";

const rootUrl = new URL("./", import.meta.url).href;
const mockModules = {
  "../map": `export const removeLayerAndSource = () => {};`,
  "./contour-overlay": `
    export const sharedDemSource = () => ({
      sharedDemProtocolUrl: "dem://{z}/{x}/{y}",
      contourProtocolUrl: () => "contour://{z}/{x}/{y}",
    });
    export const terrainTileBounds = () => ({});
    export class ContourOverlay {
      part = { id: "contours", label: "Contours", layerIds: [] };
      setColor() {}
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
const { watchTerrainTiles } = await import("./terrain.ts");
hooks.deregister();

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
