import assert from "node:assert/strict";
import { test } from "node:test";

import { warmTilesForZoom } from "../contour-ladder.ts";
import type { Bbox } from "../types.ts";
import {
  basemapMaxZoom,
  isBasemapWaterAbsent,
  isWaterCoverageComplete,
  noteWaterReadinessUnknown,
  readyWaterCoverage,
  resetWaterReadinessWarningsForTests,
  waterScreenQuads,
} from "./basemap-water-readiness.ts";

function tileDouble(options: {
  z: number;
  x: number;
  y: number;
  wrap?: number;
  state?: string;
  buckets?: Record<string, unknown>;
}) {
  const tile: Record<string, unknown> = {
    tileID: {
      overscaledZ: options.z,
      wrap: options.wrap ?? 0,
      canonical: { z: options.z, x: options.x, y: options.y },
    },
    state: options.state ?? "loaded",
  };

  if (options.buckets !== undefined) tile.buckets = options.buckets;

  return tile;
}

function waterBucketDouble() {
  return { layers: [{ sourceLayer: "water" }] };
}

function coverageMapDouble(
  zoom: number,
  tiles: ReturnType<typeof tileDouble>[],
  extra?: Record<string, unknown>,
) {
  const manager = {
    getRenderableIds: () => tiles.map((_, index) => `key${index}`),
    getTileById: (key: string) => tiles[Number(key.replace("key", ""))],
  };

  return {
    getZoom: () => zoom,
    getCenter: () => ({ lng: 0, lat: 0 }),
    getBearing: () => 0,
    getBounds: () => ({
      getWest: () => 36,
      getSouth: () => -2,
      getEast: () => 37,
      getNorth: () => -1,
    }),
    getStyle: () => ({ layers: [{ id: "water", type: "fill", "source-layer": "water" }] }),
    style: { tileManagers: { openmaptiles: manager } },
    ...extra,
  };
}

test("a loaded tile with no buckets counts as ready", () => {
  const dry = tileDouble({ z: 5, x: 19, y: 16, buckets: {} });
  const map = coverageMapDouble(5, [dry]);

  const coverage = readyWaterCoverage(map as never)!;

  assert.deepEqual(coverage.tiles, [{ z: 5, x: 19, y: 16, wrap: 0 }]);
});

test("a loaded tile with only non-water buckets counts as ready", () => {
  const park = tileDouble({
    z: 5,
    x: 20,
    y: 16,
    buckets: { park: { layers: [{ sourceLayer: "park" }] } },
  });
  const map = coverageMapDouble(5, [park]);

  const coverage = readyWaterCoverage(map as never)!;

  assert.deepEqual(coverage.tiles, [{ z: 5, x: 20, y: 16, wrap: 0 }]);
});

test("a loaded tile without a buckets field counts as ready", () => {
  const tile = tileDouble({ z: 5, x: 19, y: 16 });
  delete tile.buckets;
  const map = coverageMapDouble(5, [tile]);

  const coverage = readyWaterCoverage(map as never)!;

  assert.deepEqual(coverage.tiles, [{ z: 5, x: 19, y: 16, wrap: 0 }]);
});

test("loading and errored tiles never count as ready", () => {
  const loading = tileDouble({ z: 5, x: 19, y: 16, state: "loading", buckets: {} });
  const errored = tileDouble({ z: 5, x: 20, y: 16, state: "errored", buckets: {} });
  const map = coverageMapDouble(5, [loading, errored]);

  const coverage = readyWaterCoverage(map as never)!;

  assert.deepEqual(coverage.tiles, []);
});

test("an ideal tile at the current zoom counts while a loaded parent never does", () => {
  const child = tileDouble({ z: 5, x: 19, y: 16, buckets: { water: waterBucketDouble() } });
  const parent = tileDouble({ z: 4, x: 9, y: 8, buckets: { water: waterBucketDouble() } });
  const map = coverageMapDouble(5, [child, parent]);

  const coverage = readyWaterCoverage(map as never)!;

  assert.deepEqual(coverage.tiles, [{ z: 5, x: 19, y: 16, wrap: 0 }]);
});

test("quads project four corners so bearing keeps their shape", () => {
  const tile = tileDouble({ z: 5, x: 19, y: 16, buckets: {} });
  const map = {
    ...coverageMapDouble(5, [tile]),
    // A 45 degree turn shares one screen x between opposite corners.
    project: ([longitude, latitude]: [number, number]) => ({
      x: (longitude + latitude) * 10,
      y: (longitude - latitude) * 10,
    }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
  };
  const coverage = readyWaterCoverage(map as never)!;

  const quads = waterScreenQuads(map as never, coverage);

  assert.equal(quads.length, 1);
  assert.equal(quads[0].points.length, 4);
  const xs = quads[0].points.map((point) => point.x);
  assert.ok(new Set(xs).size > 1);
});

test("quads follow the current projection instead of a cached box", () => {
  const tile = tileDouble({ z: 5, x: 19, y: 16, buckets: {} });
  const base = coverageMapDouble(5, [tile]);
  const first = {
    ...base,
    project: () => ({ x: 10, y: 20 }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
  };
  const second = {
    ...base,
    project: () => ({ x: 30, y: 40 }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
  };
  const coverage = readyWaterCoverage(first as never)!;

  const before = waterScreenQuads(first as never, coverage);
  const after = waterScreenQuads(second as never, coverage);

  assert.notDeepEqual(before, after);
});

test("a missing projection yields no quads instead of guessing coverage", () => {
  const map = { getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }) };

  assert.deepEqual(
    waterScreenQuads(map as never, { key: "one", tiles: [{ z: 1, x: 0, y: 0, wrap: 0 }] }),
    [],
  );
});

test("the completeness check uses overzoomed parents above the basemap ceiling", () => {
  const bbox = [36, -2, 37, -1] as Bbox;
  const expected14 = warmTilesForZoom(36, -2, 37, -1, 14, 512);
  const ready = expected14.map((tile) => ({ ...tile, wrap: 0 }));
  const zoomed = (zoom: number) => ({
    getZoom: () => zoom,
    getBounds: () => ({
      getWest: () => 36,
      getSouth: () => -2,
      getEast: () => 37,
      getNorth: () => -1,
    }),
    getSource: () => ({ tiles: ["https://tiles.example.test/{z}/{x}/{y}.pbf"], maxzoom: 14 }),
  });

  assert.ok(expected14.length > 0);

  for (const zoom of [15, 18]) {
    assert.equal(
      isWaterCoverageComplete(zoomed(zoom) as never, { key: "ready", tiles: ready }, bbox, 0),
      true,
      `z${zoom}`,
    );
    assert.equal(
      isWaterCoverageComplete(zoomed(zoom) as never, { key: "none", tiles: [] }, bbox, 0),
      false,
      `z${zoom} empty`,
    );
  }
});

test("the basemap ceiling falls back to z14 without a source descriptor", () => {
  const map = { getSource: () => undefined, getStyle: () => ({ sources: {} }) };

  assert.equal(basemapMaxZoom(map as never), 14);
});

test("absent water is confirmed only when the style has no water fill", () => {
  const absent = { getStyle: () => ({ layers: [{ id: "roads", type: "line" }] }) };
  const present = {
    getStyle: () => ({ layers: [{ id: "water", type: "fill", "source-layer": "water" }] }),
  };
  const broken = {
    getStyle: () => {
      throw new Error("style unavailable");
    },
  };

  assert.equal(isBasemapWaterAbsent(absent as never), true);
  assert.equal(isBasemapWaterAbsent(present as never), false);
  assert.equal(isBasemapWaterAbsent(broken as never), false);
});

test("unknown readiness warns once while absent water stays silent", () => {
  resetWaterReadinessWarningsForTests();
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);

  try {
    noteWaterReadinessUnknown();
    noteWaterReadinessUnknown();

    assert.equal(warnings.length, 1);
  } finally {
    console.warn = original;
    resetWaterReadinessWarningsForTests();
  }
});

test("a throwing tile accessor yields no coverage instead of ready colour", () => {
  const manager = {
    getRenderableIds: () => ["key0"],
    getTileById: () => {
      throw new Error("private state unavailable");
    },
  };
  const map = {
    getZoom: () => 5,
    getStyle: () => ({ layers: [{ id: "water", type: "fill", "source-layer": "water" }] }),
    style: { tileManagers: { openmaptiles: manager } },
  };

  assert.equal(readyWaterCoverage(map as never), null);
  assert.equal(isBasemapWaterAbsent(map as never), false);
});
