import assert from "node:assert/strict";
import { test } from "node:test";

import type { Map as MapLibreMap } from "maplibre-gl";

import type { LayerContext, TerrainStats, TerrainTiles } from "../types.ts";
import { ContourOverlay } from "./contour-overlay.ts";
import { CONTOUR_PRELOAD_ID } from "./scene-preload.ts";
import type { ScenePreloader } from "./tile-prefetch.ts";

Object.assign(globalThis, {
  document: { createElement: () => ({}), documentElement: {} },
  getComputedStyle: () => ({ getPropertyValue: () => "#faf8f3" }),
});

const TILES: TerrainTiles = {
  url: "https://tiles.example.test/{z}/{x}/{y}.webp",
  encoding: "terrarium",
  tile_size: 512,
  maxzoom: 11,
  source: { name: "DEM", licence: "open", attribution: "DEM attribution" },
};
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
const LABEL_SOURCE_ID = "terrain-labels-contours";
const LABEL_ID = "terrain-contours-labels";

function setup(preload: ScenePreloader | null = null) {
  const map = fakeMap();
  const requests: { thresholds: Record<number, number> }[] = [];
  const dem = {
    contourProtocolUrl: (request: { thresholds: Record<number, number> }) => {
      requests.push(request);
      return "dem-contour://terrain/{z}/{x}/{y}";
    },
  };
  const overlay = new ContourOverlay(layerContext(map), dem as never, TILES, STATS, preload, true);
  return { map, overlay, requests };
}

test("a labels-only overlay adds the label source and layer but no line source or tiers", () => {
  const { map, overlay } = setup();

  assert.deepEqual([...map.sources.keys()], [LABEL_SOURCE_ID]);
  assert.deepEqual([...map.layers.keys()], [LABEL_ID]);
  assert.deepEqual(overlay.contourSourceIds, [LABEL_SOURCE_ID]);
  assert.deepEqual(overlay.part.layerIds, [LABEL_ID]);
  overlay.destroy();
});

test("a labels-only overlay traces each label height from the zoom its labels enter", () => {
  const { requests, overlay } = setup();

  assert.deepEqual(requests.map((request) => request.thresholds), [
    { 5: 2000, 6: 1000, 7: 500, 9: 100, 12: 50 },
  ]);
  overlay.destroy();
});

test("a labels-only overlay registers no contour trace preload", () => {
  const added: string[] = [];
  const preload = {
    add: (source: { id: string }) => added.push(source.id),
    remove: () => {},
  } as unknown as ScenePreloader;
  const { overlay } = setup(preload);

  overlay.part.onToggle?.(false);
  overlay.part.onToggle?.(true);

  assert.equal(added.includes(CONTOUR_PRELOAD_ID), false);
  overlay.destroy();
});

test("a unit change rebuilds the labels and the ladder the GPU lines read", () => {
  const { map, overlay, requests } = setup();

  overlay.setUnits("ft");

  assert.equal(overlay.ladder.tiers[0].interval, 5000);
  assert.equal(requests.length, 2);
  assert.deepEqual([...map.sources.keys()], [LABEL_SOURCE_ID]);
  assert.deepEqual([...map.layers.keys()], [LABEL_ID]);
  overlay.destroy();
});

test("destroying a labels-only overlay removes its source and layer", () => {
  const { map, overlay } = setup();

  overlay.destroy();

  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 0);
});

function layerContext(map: ReturnType<typeof fakeMap>): LayerContext {
  return {
    map: map as unknown as MapLibreMap,
    store: Promise.resolve({} as never),
    layer: {
      id: "terrain",
      title: "Terrain",
      units: "m",
      grid: { bbox: [-5, -5, 5, 5], res: 0.01, nx: 900, ny: 1000 },
      tiles: TILES,
      stats: STATS,
    } as LayerContext["layer"],
    shift: 0,
    slots: { fill: "places", shade: "places", marks: "places", lines: "places" },
    beforeId: "places",
    report: (error) => {
      throw error;
    },
  };
}

function fakeMap() {
  const sources = new Map<string, object>();
  const layers = new Map<string, object>();
  const listeners = new Map<string, Set<(event: object) => void>>();
  return {
    sources,
    layers,
    getStyle: () => ({ layers: [] }),
    getZoom: () => 8,
    getCenter: () => ({ lng: 0, lat: 0 }),
    getCanvas: () => ({ clientWidth: 1280, clientHeight: 800 }),
    isSourceLoaded: () => true,
    getSource: (id: string) => sources.get(id) ?? null,
    getLayer: (id: string) => layers.get(id),
    addSource: (id: string, source: object) => void sources.set(id, source),
    addLayer: (layer: { id: string }) => void layers.set(layer.id, layer),
    removeLayer: (id: string) => void layers.delete(id),
    removeSource: (id: string) => void sources.delete(id),
    setPaintProperty: () => {},
    setLayoutProperty: () => {},
    on: (type: string, listener: (event: object) => void) => {
      const entries = listeners.get(type) ?? new Set<(event: object) => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off: (type: string, listener: (event: object) => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
}
