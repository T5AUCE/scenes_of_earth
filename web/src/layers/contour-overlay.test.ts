import assert from "node:assert/strict";
import { test } from "node:test";

import { latest } from "@maplibre/maplibre-gl-style-spec/dist/index.mjs";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  DataDrivenProperty,
  Properties,
  Transitionable,
} from "../../node_modules/maplibre-gl/src/style/properties.ts";
import {
  EvaluationParameters,
} from "../../node_modules/maplibre-gl/src/style/evaluation_parameters.ts";

import type { Bbox, LayerContext, TerrainStats, TerrainTiles } from "../types.ts";
import {
  cappedDemMaxZoom,
  ContourOverlay,
  ContourWarmerPlan,
  ContourZoomWarmer,
  levelsForZoom,
  MAX_MISSING_DEM_TILES,
  memoizeMissingDemTiles,
  WARM_MAX_IN_FLIGHT,
} from "./contour-overlay.ts";
import { contourLadder, type ContourLadder } from "../contour-ladder.ts";
import { subscribeGesture } from "../gesture-quality.ts";
import { LABEL_FADE_MS } from "../reduced-motion.ts";

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

test("a camera gesture hides the contour labels and restores them on moveend", () => {
  const map = fakeMap();
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);
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
    const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);

    map.emit("movestart");
    assert.equal(map.layoutOf(LABEL_ID, "visibility"), undefined);

    map.emit("moveend");
    assert.equal(map.layoutOf(LABEL_ID, "visibility"), undefined);
    overlay.destroy();
  });
});

test("leaving mid-gesture restores the contour labels", () => {
  const map = fakeMap();
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);

  map.emit("movestart");
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  overlay.destroy();
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
});

test("a measurement cap lowers the contour tiling zoom and nothing else", () => {
  withSearch("?contourMaxZoom=9", () => {
    assert.equal(cappedDemMaxZoom(12), 9);
    const map = fakeMap();
    const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);
    const source = map.sources.get("terrain-contours") as { maxzoom: number };

    assert.equal(source.maxzoom, 9);
    overlay.destroy();
  });
});

test("without a cap the contour tiling keeps its crisp ceiling", () => {
  assert.equal(cappedDemMaxZoom(12), 12);
  assert.equal(cappedDemMaxZoom(14), 12);
  const map = fakeMap();
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);
  const source = map.sources.get("terrain-contours") as { maxzoom: number };

  assert.equal(source.maxzoom, 12);
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
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);

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
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);

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
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);

  assert.equal(map.layoutProp(LABEL_ID, "symbol-spacing"), 350);
  overlay.destroy();
});

test("reduced motion restores the contour labels instantly", () => {
  withReducedMotion(true, () => {
    const map = fakeMap();
    const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);

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
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);

  map.emit("movestart");
  overlay.part.onToggle?.(false);
  map.emit("moveend");
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");
  overlay.destroy();
});

test("zooming keeps the contour source so stretched parents cover late children", () => {
  const map = fakeMap();
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);
  const source = map.sources.get("terrain-contours") as { maxzoom?: number; minzoom?: unknown };
  assert.equal(source.maxzoom, 12);
  assert.equal(source.minzoom, undefined);

  map.state.zoom = 8.5;
  map.emit("zoom");
  map.emit("zoomend");
  assert.ok(map.sources.has("terrain-contours"));
  assert.ok(overlay.part.layerIds.every((id) => map.layers.has(id)));
  overlay.destroy();
});

test("warm levels mirror the protocol threshold lookup", () => {
  assert.deepEqual(levelsForZoom({ 8: 50, 10: 10 }, 7), []);
  assert.deepEqual(levelsForZoom({ 8: 50, 10: 10 }, 9), [50]);
  assert.deepEqual(levelsForZoom({ 8: 50, 10: 10 }, 10), [10]);
});

test("the warm-up traces the next zoom while zooming in with spare capacity", () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.zoom = 8;
    map.emit("zoom");
    now += 100;
    map.state.zoom = 8.2;
    map.emit("zoom");
    assert.ok(warm.calls.length > 0);
    assert.ok(warm.calls.length <= WARM_MAX_IN_FLIGHT);
    assert.ok(warm.calls.every((call) => call.z === 9));
    assert.deepEqual(warm.calls[0].options, {
      levels: levelsForZoom(ladder.thresholds, 9),
      overzoom: 1,
      buffer: 1,
    });
  } finally {
    warmer.destroy();
    stop();
  }
});

test("the warm-up waits while the visible tiles are still loading", () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.loaded = false;
    map.state.zoom = 8;
    map.emit("zoom");
    now += 100;
    map.state.zoom = 8.2;
    map.emit("zoom");
    assert.equal(warm.calls.length, 0);

    map.state.loaded = true;
    now += 100;
    map.state.zoom = 8.4;
    map.emit("zoom");
    assert.ok(warm.calls.length > 0);
  } finally {
    warmer.destroy();
    stop();
  }
});

test("visible tiles loading cancels warm work so visible requests keep priority", () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.zoom = 8;
    map.emit("zoom");
    now += 100;
    map.state.zoom = 8.2;
    map.emit("zoom");
    assert.ok(warm.pending.size > 0);

    map.state.loaded = false;
    map.emit("zoom");
    assert.equal(warm.pending.size, 0);
    assert.equal(warm.aborted.length, warm.calls.length);
  } finally {
    warmer.destroy();
    stop();
  }
});

test("a stale warm rejection never erases its replacement request", async () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.zoom = 8;
    map.emit("zoom");
    now += 100;
    map.state.zoom = 8.2;
    map.emit("zoom");
    assert.ok(warm.pending.size > 0);

    now += 100;
    map.state.zoom = 8.4;
    map.state.bounds = { west: 30, south: -0.5, east: 31, north: 0.5 };
    map.emit("zoom");
    assert.equal(warm.pending.size, 0);

    now += 100;
    map.state.zoom = 8.6;
    map.state.bounds = { west: -0.5, south: -0.5, east: 0.5, north: 0.5 };
    map.emit("zoom");
    const retraced = warm.calls.length;
    assert.ok(warm.pending.size > 0);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warm.pending.size, 4);
    now += 100;
    map.state.zoom = 8.8;
    map.emit("zoom");
    assert.equal(warm.calls.length, retraced);
    assert.equal(warm.pending.size, 4);
  } finally {
    warmer.destroy();
    stop();
  }
  assert.equal(warm.pending.size, 0);
});

test("panning prunes drifted warm tiles without a zoom event", () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.zoom = 8;
    map.emit("zoom");
    now += 100;
    map.state.zoom = 8.2;
    map.emit("zoom");
    assert.ok(warm.pending.size > 0);

    map.state.bounds = { west: 60, south: -0.5, east: 61, north: 0.5 };
    map.emit("move");
    assert.equal(warm.pending.size, 0);
    assert.equal(warm.aborted.length, warm.calls.length);
  } finally {
    warmer.destroy();
    stop();
  }
});

test("the warm-up covers the target zoom viewport inside the scene bounds", () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.bounds = { west: -20, south: -10, east: 20, north: 10 };
    map.state.zoom = 8;
    map.emit("zoom");
    now += 100;
    map.state.zoom = 8.2;
    map.emit("zoom");
    assert.ok(warm.calls.length > 0);
    for (const call of warm.calls) {
      assert.equal(call.z, 9);
      const centreLng = (call.x + 0.5) / 512 * 360 - 180;
      assert.ok(Math.abs(centreLng) <= 12, `tile ${call.x} sits outside the target viewport`);
      const west = call.x / 512 * 360 - 180;
      assert.ok(west <= 15 && west + 360 / 512 >= -15, `tile ${call.x} sits outside the scene`);
    }
  } finally {
    warmer.destroy();
    stop();
  }
});

test("switching contours off cancels warm work at once", () => {
  const map = fakeMap();
  const warm = warmingDem();
  let now = 1000;
  const overlay = new ContourOverlay(layerContext(map), warm.dem as never, TILES, STATS, () => now);
  map.state.zoom = 8;
  map.emit("movestart");
  map.emit("zoom");
  now += 100;
  map.state.zoom = 8.2;
  map.emit("zoom");
  assert.ok(warm.pending.size > 0);

  overlay.part.onToggle?.(false);
  assert.equal(warm.pending.size, 0);
  overlay.destroy();
});

test("the warm-up skips flings and stops past the tiling cap", () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.zoom = 8;
    map.emit("zoom");
    now += 10;
    map.state.zoom = 9.5;
    map.emit("zoom");
    assert.equal(warm.calls.length, 0);

    now += 1000;
    map.state.zoom = 12.5;
    map.emit("zoom");
    now += 1000;
    map.state.zoom = 12.7;
    map.emit("zoom");
    assert.equal(warm.calls.length, 0);
  } finally {
    warmer.destroy();
    stop();
  }
});

test("the warm-up never runs more traces than its in-flight bound", () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.zoom = 8;
    map.emit("zoom");
    for (let step = 1; step <= 6; step += 1) {
      now += 100;
      map.state.zoom = 8 + step * 0.1;
      map.state.bounds = { west: step * 2 - 0.5, south: -0.5, east: step * 2 + 0.5, north: 0.5 };
      map.emit("zoom");
    }
    assert.ok(warm.peak <= WARM_MAX_IN_FLIGHT);
  } finally {
    warmer.destroy();
    stop();
  }
});

test("the warm-up cancels when the gesture turns around or the scene exits", () => {
  const map = fakeMap();
  const stop = startGesture(map);
  map.emit("movestart");
  const warm = warmingDem();
  const ladder = contourLadder(STATS, 0, { maxZoom: 12 });
  let now = 1000;
  const warmer = new ContourZoomWarmer(map, warm.dem, () => warmPlan(ladder), () => now);
  try {
    map.state.zoom = 8;
    map.emit("zoom");
    now += 100;
    map.state.zoom = 8.2;
    map.emit("zoom");
    assert.ok(warm.pending.size > 0);

    now += 100;
    map.state.zoom = 8.1;
    map.emit("zoom");
    assert.equal(warm.pending.size, 0);
    assert.ok(warm.aborted.length > 0);

    const calls = warm.calls.length;
    warmer.destroy();
    map.state.zoom = 8.3;
    map.emit("zoom");
    assert.equal(warm.calls.length, calls);
  } finally {
    stop();
  }
});

test("the overlay warms the next zoom mid-gesture and stops on destroy", () => {
  const map = fakeMap();
  const warm = warmingDem();
  let now = 1000;
  const overlay = new ContourOverlay(layerContext(map), warm.dem as never, TILES, STATS, () => now);
  map.state.zoom = 8;
  map.emit("movestart");
  map.emit("zoom");
  now += 100;
  map.state.zoom = 8.2;
  map.emit("zoom");
  assert.ok(warm.calls.length > 0);

  const calls = warm.calls.length;
  overlay.destroy();
  now += 100;
  map.state.zoom = 8.4;
  map.emit("zoom");
  assert.equal(warm.calls.length, calls);
  assert.equal(warm.pending.size, 0);
});

test("toggling contours on mid-gesture keeps the labels frozen until moveend", () => {
  const map = fakeMap();
  const overlay = new ContourOverlay(layerContext(map), fakeDem(), TILES, STATS);

  map.emit("movestart");
  // drawView shows every part layer before it notifies the toggle.
  map.setLayoutProperty(LABEL_ID, "visibility", "visible");
  overlay.part.onToggle?.(true);
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  map.emit("moveend");
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
  overlay.destroy();
});

function fakeDem() {
  return { contourProtocolUrl: () => "dem-contour://terrain/{z}/{x}/{y}" };
}

function startGesture(map: FakeMap): () => void {
  return subscribeGesture(map, { onStart() {}, onEnd() {} });
}

function warmPlan(ladder: ContourLadder, bbox: Bbox = [-15, -15, 15, 15]): ContourWarmerPlan {
  return {
    sourceId: "terrain-contours",
    ladder,
    maxzoom: 12,
    elevationUnit: "m",
    enabled: true,
    bbox,
  };
}

interface WarmingDem {
  dem: {
    contourProtocolUrl: () => string;
    manager: {
      fetchContourTile: (
        z: number,
        x: number,
        y: number,
        options: unknown,
        cancel: AbortController,
      ) => Promise<unknown>;
    };
  };
  calls: { z: number; x: number; y: number; options: unknown }[];
  pending: Map<string, () => void>;
  aborted: string[];
  readonly peak: number;
}

function warmingDem(): WarmingDem {
  const calls: { z: number; x: number; y: number; options: unknown }[] = [];
  const pending = new Map<string, () => void>();
  const aborted: string[] = [];
  let peak = 0;
  const manager = {
    fetchContourTile: (
      z: number,
      x: number,
      y: number,
      options: unknown,
      cancel: AbortController,
    ) => {
      const key = `${z}/${x}/${y}`;
      calls.push({ z, x, y, options });
      peak = Math.max(peak, pending.size + 1);
      return new Promise<unknown>((resolve, reject) => {
        if (cancel.signal.aborted) {
          aborted.push(key);
          reject(new Error("aborted"));
          return;
        }
        pending.set(key, () => {
          pending.delete(key);
          resolve({ arrayBuffer: new ArrayBuffer(0) });
        });
        cancel.signal.addEventListener("abort", () => {
          if (!pending.has(key)) return;
          pending.delete(key);
          aborted.push(key);
          reject(new Error("aborted"));
        });
      });
    },
  };
  return {
    dem: { contourProtocolUrl: () => "dem-contour://terrain/{z}/{x}/{y}", manager },
    calls,
    pending,
    aborted,
    get peak() {
      return peak;
    },
  };
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
    .get("text-color").evaluate({}, {});
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
    .get("text-opacity").evaluate({ properties: { ele: 100 } }, {});
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
  const listeners = new Map<string, Set<() => void>>();
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
    getLayer: (id: string) => layers.get(id),
    addSource: (id: string, source: object) => void sources.set(id, source),
    addLayer: (layer: {
      id: string;
      layout?: Record<string, unknown>;
      paint?: Record<string, unknown>;
    }) => {
      layers.set(layer.id, {
        id: layer.id,
        paint: layer.paint ?? {},
        layout: layer.layout ?? {},
      });
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
    on: (type: string, listener: () => void) => {
      const entries = listeners.get(type) ?? new Set<() => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off: (type: string, listener: () => void) => void listeners.get(type)?.delete(listener),
    emit: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
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
