import assert from "node:assert/strict";
import { test } from "node:test";

import { latest } from "@maplibre/maplibre-gl-style-spec/dist/index.mjs";
import type { Map as MapLibreMap } from "maplibre-gl";

import { EvaluationParameters } from "../../node_modules/maplibre-gl/src/style/evaluation_parameters.ts";
import {
  DataDrivenProperty,
  Properties,
  Transitionable,
} from "../../node_modules/maplibre-gl/src/style/properties.ts";
import { LABEL_FADE_MS } from "../reduced-motion.ts";
import type { LayerContext, TerrainStats, TerrainTiles } from "../types.ts";
import {
  cappedDemMaxZoom,
  ContourLabels,
  MAX_MISSING_DEM_TILES,
  memoizeMissingDemTiles,
} from "./contour-labels.ts";

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
const LABEL_ID = "terrain-contours-labels";
const LABEL_SOURCE_ID = "terrain-labels-contours";

test("a camera gesture hides the contour labels and restores them on moveend", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), undefined);

  map.emit("movestart");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  map.emit("moveend");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");

  overlay.destroy();
});

test("a disabled freeze flag leaves the contour labels alone", () => {
  withSearch("?freezeLabels=0", () => {
    const map = fakeMap();
    const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

    map.emit("movestart");

    assert.equal(map.layoutOf(LABEL_ID, "visibility"), undefined);

    map.emit("moveend");

    assert.equal(map.layoutOf(LABEL_ID, "visibility"), undefined);

    overlay.destroy();
  });
});

test("leaving mid-gesture restores the contour labels", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  map.emit("movestart");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  overlay.destroy();

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
});

test("a measurement cap lowers the contour tiling zoom and nothing else", () => {
  withSearch("?contourMaxZoom=9", () => {
    assert.equal(cappedDemMaxZoom(12), 9);

    const map = fakeMap();
    const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);
    const labelSource = map.sources.get("terrain-labels-contours") as { maxzoom: number };

    assert.equal(labelSource.maxzoom, 9);

    overlay.destroy();
  });
});

test("without a cap the contour tiling keeps its crisp ceiling", () => {
  assert.equal(cappedDemMaxZoom(12), 12);
  assert.equal(cappedDemMaxZoom(14), 12);

  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);
  const labelSource = map.sources.get("terrain-labels-contours") as { maxzoom: number };

  assert.equal(labelSource.maxzoom, 12);

  overlay.destroy();
});

test("a memoized 404 contour tile fails without another fetch", async () => {
  let fetches = 0;
  const dem = {
    manager: {
      fetchTile: async () => ({ data: new ArrayBuffer(0) }),
      fetchContourTile: async () => {
        fetches += 1;
        throw new Error("Bad response: 404 for https://example.test/8/1/2.webp");
      },
    },
  };
  memoizeMissingDemTiles(dem as never);

  const options = { thresholds: [10, 20], overzoom: 1 };

  await assert.rejects(dem.manager.fetchContourTile(8, 1, 2, options));
  assert.equal(fetches, 1);
  await assert.rejects(dem.manager.fetchContourTile(8, 1, 2, options));
  assert.equal(fetches, 1);
});

test("other failures keep retrying without memoizing", async () => {
  let fetches = 0;
  const dem = {
    manager: {
      fetchContourTile: async () => {
        fetches += 1;
        throw new Error("Network request failed");
      },
    },
  };
  memoizeMissingDemTiles(dem as never);

  const options = { thresholds: [10, 20], overzoom: 1 };

  await assert.rejects(dem.manager.fetchContourTile(9, 4, 4, options));
  await assert.rejects(dem.manager.fetchContourTile(9, 4, 4, options));
  assert.equal(fetches, 2);
});

test("a memoized 404 contour tile stays memoized across threshold sets", async () => {
  let fetches = 0;
  const dem = {
    manager: {
      fetchContourTile: async () => {
        fetches += 1;
        throw new Error("Bad response: 404 for https://example.test/8/1/2.webp");
      },
    },
  };
  memoizeMissingDemTiles(dem as never);

  // A missing DEM stays missing whatever thresholds the contour request carries.
  await assert.rejects(dem.manager.fetchContourTile(8, 1, 2, { thresholds: [10, 20] }));
  await assert.rejects(dem.manager.fetchContourTile(8, 1, 2, { thresholds: [50, 100, 150] }));
  assert.equal(fetches, 1);
});

test("the 404 memo drops its oldest tile past its cap", async () => {
  let fetches = 0;
  const dem = {
    manager: {
      fetchTile: async () => {
        fetches += 1;
        throw new Error("Bad response: 404 for https://example.test/tile.webp");
      },
    },
  };
  memoizeMissingDemTiles(dem as never);

  for (let tile = 0; tile <= MAX_MISSING_DEM_TILES; tile++) {
    await assert.rejects(dem.manager.fetchTile(10, tile, 4));
  }

  assert.equal(fetches, MAX_MISSING_DEM_TILES + 1);

  // The first tile fell out of the full memo, so it fetches again while a fresh tile does not.
  await assert.rejects(dem.manager.fetchTile(10, 0, 4));
  assert.equal(fetches, MAX_MISSING_DEM_TILES + 2);
  await assert.rejects(dem.manager.fetchTile(10, MAX_MISSING_DEM_TILES, 4));
  assert.equal(fetches, MAX_MISSING_DEM_TILES + 2);
});

test("the contour labels fade back after a gesture instead of popping", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  map.emit("movestart");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");
  assert.equal(map.paintOf(LABEL_ID, "text-color"), "rgba(91, 70, 54, 0)");
  assert.equal(map.paintOf(LABEL_ID, "text-halo-color"), "rgba(250, 248, 243, 0)");
  assert.deepEqual(map.paintOf(LABEL_ID, "text-color-transition"), { duration: 0 });

  map.emit("moveend");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
  assert.deepEqual(map.paintOf(LABEL_ID, "text-color-transition"), { duration: LABEL_FADE_MS });
  assert.deepEqual(map.paintOf(LABEL_ID, "text-halo-color-transition"), {
    duration: LABEL_FADE_MS,
  });
  assert.equal(map.paintOf(LABEL_ID, "text-color"), "#5b4636");
  assert.equal(map.paintOf(LABEL_ID, "text-halo-color"), "#faf8f3");
  assert.ok(Array.isArray(map.paintOf(LABEL_ID, "text-opacity")));

  overlay.destroy();
});

test("the label fade passes through a translucent midpoint", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  map.emit("movestart");

  const hidden = map.paintOf(LABEL_ID, "text-color");
  map.emit("moveend");

  const shown = map.paintOf(LABEL_ID, "text-color");

  assert.ok(fadedColorAlpha(hidden, shown, 150) > 0);
  assert.ok(fadedColorAlpha(hidden, shown, 150) < 1);
  assert.equal(fadedColorAlpha(hidden, shown, 400), 1);

  overlay.destroy();
});

test("a data-driven opacity snaps instead of fading, so the fade runs on colour", () => {
  const tierLike = [
    "interpolate",
    ["linear"],
    ["zoom"],
    8,
    ["case", ["==", ["get", "ele"], 100], 1, 0],
    12,
    ["case", ["==", ["get", "ele"], 100], 1, 0],
  ];

  assert.equal(snappedOpacityAt(tierLike, 150), 1);
  assert.equal(snappedOpacityAt(tierLike, 400), 1);
});

test("low-zoom contour labels keep the resting 350 px spacing", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  assert.equal(map.layoutProp(LABEL_ID, "symbol-spacing"), 350);

  overlay.destroy();
});

test("reduced motion restores the contour labels instantly", () => {
  withReducedMotion(true, () => {
    const map = fakeMap();
    const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

    map.emit("movestart");
    map.emit("moveend");

    assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
    assert.deepEqual(map.paintOf(LABEL_ID, "text-color-transition"), { duration: 0 });
    assert.equal(map.paintOf(LABEL_ID, "text-color"), "#5b4636");

    overlay.destroy();
  });
});

test("a hidden contour toggle stays hidden through the gesture fade", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  map.emit("movestart");
  overlay.part.onToggle?.(false);
  map.emit("moveend");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  overlay.destroy();
});

test("zooming keeps the label source so stretched parents cover late children", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);
  const source = map.sources.get("terrain-labels-contours") as {
    maxzoom?: number;
    minzoom?: unknown;
  };

  assert.equal(source.maxzoom, 12);
  assert.equal(source.minzoom, undefined);

  map.state.zoom = 8.5;
  map.emit("zoom");
  map.emit("zoomend");

  assert.ok(map.sources.has("terrain-labels-contours"));
  assert.ok(overlay.part.layerIds.every((id) => map.layers.has(id)));

  overlay.destroy();
});

test("switching contours off hides the labels and back on shows them again", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  overlay.part.onToggle?.(false);

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  overlay.part.onToggle?.(true);

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");

  overlay.destroy();
});

test("destroying the overlay removes its label source and layer", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  overlay.destroy();

  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 0);
});

test("the overlay adds only the label source and layer", () => {
  const map = fakeMap();
  const requests: { thresholds: Record<number, number> }[] = [];
  const dem = {
    contourProtocolUrl: (request: { thresholds: Record<number, number> }) => {
      requests.push(request);
      return "dem-contour://terrain/{z}/{x}/{y}";
    },
  };
  const overlay = new ContourLabels(layerContext(map), dem as never, TILES, STATS);

  assert.deepEqual([...map.sources.keys()], [LABEL_SOURCE_ID]);
  assert.deepEqual([...map.layers.keys()], [LABEL_ID]);
  assert.equal(overlay.labelSourceId, LABEL_SOURCE_ID);
  assert.deepEqual(overlay.part.layerIds, [LABEL_ID]);

  overlay.destroy();
});

test("the overlay traces each label height from the zoom its labels enter", () => {
  const requests: { thresholds: Record<number, number> }[] = [];
  const dem = {
    contourProtocolUrl: (request: { thresholds: Record<number, number> }) => {
      requests.push(request);
      return "dem-contour://terrain/{z}/{x}/{y}";
    },
  };
  const overlay = new ContourLabels(layerContext(fakeMap()), dem as never, TILES, STATS);

  assert.deepEqual(
    requests.map((request) => request.thresholds),
    [{ 5: 2000, 6: 1000, 7: 500, 9: 100, 12: 50 }],
  );

  overlay.destroy();
});

test("a unit change rebuilds the labels and the ladder the GPU lines read", () => {
  const map = fakeMap();
  const requests: { thresholds: Record<number, number> }[] = [];
  const dem = {
    contourProtocolUrl: (request: { thresholds: Record<number, number> }) => {
      requests.push(request);
      return "dem-contour://terrain/{z}/{x}/{y}";
    },
  };
  const overlay = new ContourLabels(layerContext(map), dem as never, TILES, STATS);

  overlay.setUnits("ft");

  assert.equal(overlay.ladder.tiers[0].interval, 5000);
  assert.equal(requests.length, 2);
  assert.deepEqual([...map.sources.keys()], [LABEL_SOURCE_ID]);
  assert.deepEqual([...map.layers.keys()], [LABEL_ID]);

  overlay.destroy();
});

test("toggling contours on mid-gesture keeps the labels frozen until moveend", () => {
  const map = fakeMap();
  const overlay = new ContourLabels(layerContext(map), fakeDem(), TILES, STATS);

  map.emit("movestart");
  // drawView shows every part layer before it notifies the toggle.
  map.setLayoutProperty(LABEL_ID, "visibility", "visible");
  overlay.part.onToggle?.(true);

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  map.emit("moveend");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");

  overlay.destroy();
});

test("a gesture hides only the labels while the source stays put", () => {
  const map = fakeMap();
  const dem = fakeDem();
  const overlay = overlayWithDem(map, dem);
  const labelSource = map.sources.get("terrain-labels-contours");

  map.emit("movestart");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");
  assert.equal(map.sources.get("terrain-labels-contours"), labelSource);
  assert.ok(map.layers.has(LABEL_ID));

  map.emit("moveend");

  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
  assert.equal(map.sources.get("terrain-labels-contours"), labelSource);
  assert.ok(map.layers.has(LABEL_ID));

  overlay.destroy();
});

function fakeDem() {
  return { contourProtocolUrl: () => "dem-contour://terrain/{z}/{x}/{y}" };
}

/** Build an overlay without a scene preload, as outside a scene. */
function overlayWithDem(
  map: FakeMap,
  dem: { contourProtocolUrl: (request: unknown) => string; manager?: unknown },
): ContourLabels {
  return new ContourLabels(layerContext(map), dem as never, TILES, STATS);
}

function withReducedMotion(matches: boolean, run: () => void): void {
  const target = globalThis as Record<string, unknown>;
  const previous = target.matchMedia;
  target.matchMedia = () => ({ matches, addEventListener() {}, removeEventListener() {} });

  try {
    run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(target, "matchMedia");
    else target.matchMedia = previous;
  }
}

/** The alpha of a colour transition from one recorded paint value to another. */
function fadedColorAlpha(from: unknown, to: unknown, atMs: number): number {
  const property = new DataDrivenProperty(latest.paint_symbol["text-color"], "text-color");
  const transitionable = new Transitionable(
    new Properties({ "text-color": property }),
    "paint",
    {},
  );
  transitionable.setValue("text-color", from);

  const prior = transitionable.untransitioned();
  transitionable.setTransition("text-color", { duration: LABEL_FADE_MS, delay: 0 });
  transitionable.setValue("text-color", to);

  const transitioning = transitionable.transitioned(
    new EvaluationParameters(9, { now: 1000 }),
    prior,
  );
  const color = transitioning
    .possiblyEvaluate(new EvaluationParameters(9, { now: 1000 + atMs }))
    .get("text-color")
    .evaluate({}, {});

  return color.a;
}

/** The evaluated opacity of a data-driven value partway through its transition. */
function snappedOpacityAt(expression: unknown, atMs: number): number {
  const property = new DataDrivenProperty(latest.paint_symbol["text-opacity"], "text-opacity");
  const transitionable = new Transitionable(
    new Properties({ "text-opacity": property }),
    "paint",
    {},
  );
  transitionable.setValue("text-opacity", 0);

  const prior = transitionable.untransitioned();
  transitionable.setTransition("text-opacity", { duration: LABEL_FADE_MS, delay: 0 });
  transitionable.setValue("text-opacity", expression);

  const transitioning = transitionable.transitioned(
    new EvaluationParameters(9, { now: 1000 }),
    prior,
  );

  return transitioning
    .possiblyEvaluate(new EvaluationParameters(9, { now: 1000 + atMs }))
    .get("text-opacity")
    .evaluate({ properties: { ele: 100 } }, {});
}

function layerContext(map: FakeMap): LayerContext {
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

type FakeMap = ReturnType<typeof fakeMap>;

function fakeMap() {
  const sources = new Map<string, object>();
  const layers = new Map<
    string,
    { id: string; paint: Record<string, unknown>; layout: Record<string, unknown> }
  >();
  const listeners = new Map<string, Set<(event: object) => void>>();
  const layouts = new Map<string, Map<string, unknown>>();
  const state = {
    zoom: 8,
    loaded: true,
    bounds: { west: -0.5, south: -0.5, east: 0.5, north: 0.5 },
  };

  const map = {
    getStyle: () => ({ layers: [] }),
    getZoom: () => state.zoom,
    getCenter: () => ({
      lng: (state.bounds.west + state.bounds.east) / 2,
      lat: (state.bounds.south + state.bounds.north) / 2,
    }),
    getCanvas: () => ({ clientWidth: 1280, clientHeight: 800 }),
    getBounds: () => ({
      getWest: () => state.bounds.west,
      getSouth: () => state.bounds.south,
      getEast: () => state.bounds.east,
      getNorth: () => state.bounds.north,
    }),
    isSourceLoaded: () => state.loaded,
    getSource: (id: string) => sources.get(id) ?? null,
    getLayer: (id: string) => layers.get(id),
    addSource: (id: string, source: object) => void sources.set(id, source),
    addLayer: (layer: {
      id: string;
      layout?: Record<string, unknown>;
      paint?: Record<string, unknown>;
    }) => {
      layers.set(layer.id, { id: layer.id, paint: layer.paint ?? {}, layout: layer.layout ?? {} });
    },
    removeLayer: (id: string) => void layers.delete(id),
    removeSource: (id: string) => void sources.delete(id),
    setPaintProperty: (id: string, property: string, value: unknown) => {
      layers.get(id)!.paint[property] = value;
    },
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      const entries = layouts.get(id) ?? new Map<string, unknown>();
      entries.set(name, value);
      layouts.set(id, entries);
    },
    setTransformRequest: () => {},
    on: (type: string, listener: (event: object) => void) => {
      const entries = listeners.get(type) ?? new Set<(event: object) => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off: (type: string, listener: (event: object) => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: string, event: object = {}) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    layoutOf: (id: string, name: string) => layouts.get(id)?.get(name),
    paintOf: (id: string, name: string) => layers.get(id)!.paint[name],
    layoutProp: (id: string, name: string) => layers.get(id)?.layout[name],
  };

  return {
    ...map,
    sources,
    layers,
    layoutOf: map.layoutOf,
    paintOf: map.paintOf,
    layoutProp: map.layoutProp,
    state,
  };
}

function withSearch(search: string, run: () => void) {
  const previous = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = { search };

  try {
    run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "location");
    else (globalThis as Record<string, unknown>).location = previous;
  }
}
