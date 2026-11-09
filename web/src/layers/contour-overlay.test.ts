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

import type { LayerContext, TerrainStats, TerrainTiles } from "../types.ts";
import {
  cappedDemMaxZoom,
  ContourOverlay,
  levelsForZoom,
  MAX_MISSING_DEM_TILES,
  memoizeMissingDemTiles,
} from "./contour-overlay.ts";
import { contourLadder } from "../contour-ladder.ts";
import { LABEL_FADE_MS } from "../reduced-motion.ts";
import {
  formatPrefetchPart,
  isPrefetchDisabled,
  resetSpeculativeStats,
  speculativeSnapshot,
} from "../dev-stats.ts";
import { BASEMAP_SOURCE_ID } from "../render/tile-viewport.ts";
import {
  PREFETCH_MAX_HTTP_PER_PREDICTION,
  PREFETCH_MAX_PER_SOURCE,
  PREFETCH_NETWORK_LANES,
  PREFETCH_TRACE_LANES,
  type HttpWarmer,
} from "./tile-prefetch.ts";

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
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );
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
    const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );

    map.emit("movestart");
    assert.equal(map.layoutOf(LABEL_ID, "visibility"), undefined);

    map.emit("moveend");
    assert.equal(map.layoutOf(LABEL_ID, "visibility"), undefined);
    overlay.destroy();
  });
});

test("leaving mid-gesture restores the contour labels", () => {
  const map = fakeMap();
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );

  map.emit("movestart");
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  overlay.destroy();
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
});

test("a measurement cap lowers the contour tiling zoom and nothing else", () => {
  withSearch("?contourMaxZoom=9", () => {
    assert.equal(cappedDemMaxZoom(12), 9);
    const map = fakeMap();
    const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );
    const source = map.sources.get("terrain-contours") as { maxzoom: number };
    const labelSource = map.sources.get("terrain-labels-contours") as { maxzoom: number };

    assert.equal(source.maxzoom, 9);
    assert.equal(labelSource.maxzoom, 9);
    overlay.destroy();
  });
});

test("without a cap the contour tiling keeps its crisp ceiling", () => {
  assert.equal(cappedDemMaxZoom(12), 12);
  assert.equal(cappedDemMaxZoom(14), 12);
  const map = fakeMap();
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );
  const source = map.sources.get("terrain-contours") as { maxzoom: number };
  const labelSource = map.sources.get("terrain-labels-contours") as { maxzoom: number };

  assert.equal(source.maxzoom, 12);
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
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );

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
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );

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
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );

  assert.equal(map.layoutProp(LABEL_ID, "symbol-spacing"), 350);
  overlay.destroy();
});

test("reduced motion restores the contour labels instantly", () => {
  withReducedMotion(true, () => {
    const map = fakeMap();
    const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );

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
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );

  map.emit("movestart");
  overlay.part.onToggle?.(false);
  map.emit("moveend");
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");
  overlay.destroy();
});

test("zooming keeps the contour source so stretched parents cover late children", () => {
  const map = fakeMap();
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );
  const source = map.sources.get("terrain-contours") as { maxzoom?: number; minzoom?: unknown };
  assert.equal(source.maxzoom, 12);
  assert.equal(source.minzoom, undefined);

  map.state.zoom = 8.5;
  map.emit("zoom");
  map.emit("zoomend");
  assert.ok(map.sources.has("terrain-contours"));
  assert.ok(map.sources.has("terrain-labels-contours"));
  assert.ok(overlay.part.layerIds.every((id) => map.layers.has(id)));
  overlay.destroy();
});

test("warm levels mirror the protocol threshold lookup", () => {
  assert.deepEqual(levelsForZoom({ 8: 50, 10: 10 }, 7), []);
  assert.deepEqual(levelsForZoom({ 8: 50, 10: 10 }, 9), [50]);
  assert.deepEqual(levelsForZoom({ 8: 50, 10: 10 }, 10), [10]);
});

test("the overlay warms DEM parents before traces and the Liberty template", async (t) => {
  optInPrefetch(t);
  const map = fakeMap();
  map.sources.set(BASEMAP_SOURCE_ID, {
    url: "https://tiles.openfreemap.org/planet",
    tiles: ["https://tiles.openfreemap.org/planet/20260101_001001_pt/{z}/{x}/{y}.pbf"],
    maxzoom: 14,
  });
  map.emit("movestart");
  const warm = warmingDem();
  const http = warmingHttp();
  let now = 1000;
  const overlay = overlayWithDem(map, warm.dem, http.warmer, () => now);
  try {
    frame(map, () => {
      map.state.zoom = 8;
      now += 100;
    });
    frame(map, () => {
      map.state.zoom = 8.2;
      now += 100;
    });

    await settled();
    assert.ok(warm.demCalls.length > 0);
    assert.equal(warm.calls.length, 0);

    for (let round = 0; round < 10 && warm.demPending.size > 0; round += 1) {
      for (const entry of [...warm.demPending.values()]) entry.resolve();
      await settled();
    }

    assert.ok(warm.calls.length > 0);
    assert.ok(warm.calls.length <= PREFETCH_MAX_PER_SOURCE);
    assert.ok(warm.peak <= PREFETCH_TRACE_LANES);
    assert.ok(http.urls.length > 0);
    assert.ok(http.urls.length <= PREFETCH_MAX_HTTP_PER_PREDICTION);
    assert.ok(http.peak <= PREFETCH_NETWORK_LANES);
    const versioned = "https://tiles.openfreemap.org/planet/20260101_001001_pt/";
    assert.ok(http.urls.every((url) => url.startsWith(versioned)));
    const latest = warm.calls.at(-1)!;
    assert.deepEqual(latest.options, {
      levels: levelsForZoom(contourLadder(STATS, { maxZoom: 12 }).thresholds, latest.z),
      overzoom: 1,
      buffer: 1,
    });
  } finally {
    overlay.destroy();
  }
});

test("the prefetch switch off warms nothing and the badge says off", async () => {
  const previous = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = { search: "?prefetch=0" };
  try {
    resetSpeculativeStats();
    const map = fakeMap();
    map.emit("movestart");
    const warm = warmingDem();
    const http = warmingHttp();
    let now = 1000;
    const overlay = overlayWithDem(map, warm.dem, http.warmer, () => now);
    try {
      frame(map, () => {
        map.state.zoom = 8;
        now += 100;
      });
      frame(map, () => {
        map.state.zoom = 8.2;
        now += 100;
      });
      await settled();

      assert.equal(warm.demCalls.length, 0);
      assert.equal(warm.calls.length, 0);
      assert.equal(http.urls.length, 0);
      assert.deepEqual(speculativeSnapshot(), {
        terrain: { hits: 0, misses: 0, wasted: 0 },
        basemap: { hits: 0, misses: 0, wasted: 0 },
        contours: { hits: 0, misses: 0, wasted: 0 },
      });
      assert.equal(formatPrefetchPart(speculativeSnapshot()), "prefetch off");
    } finally {
      overlay.destroy();
    }
    assert.equal(isPrefetchDisabled(), false);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "location");
    else (globalThis as Record<string, unknown>).location = previous;
  }
});

test("a visible contour tile load credits one hit after the overlay warmed it", async (t) => {
  optInPrefetch(t);
  resetSpeculativeStats();
  const map = fakeMap();
  map.emit("movestart");
  const warm = warmingDem();
  let now = 1000;
  const overlay = overlayWithDem(map, warm.dem, silentHttp(), () => now);
  try {
    frame(map, () => {
      map.state.zoom = 8;
      now += 100;
    });
    frame(map, () => {
      map.state.zoom = 8.2;
      now += 100;
    });
    for (let round = 0; round < 10; round += 1) {
      for (const entry of [...warm.demPending.values(), ...warm.pending.values()]) entry.resolve();
      await settled();
    }
    const traced = warm.calls[0];
    const loading = { sourceId: "terrain-contours", tile: { tileID: { canonical: traced } } };

    map.emit("sourcedataloading", loading);
    map.emit("sourcedataloading", loading);

    assert.equal(speculativeSnapshot().contours.hits, 1);
  } finally {
    overlay.destroy();
  }
});

test("switching contours off cancels speculative work at once", async (t) => {
  optInPrefetch(t);
  const map = fakeMap();
  const warm = warmingDem();
  const http = warmingHttp();
  let now = 1000;
  const overlay = overlayWithDem(map, warm.dem, http.warmer, () => now);
  map.state.zoom = 8;
  map.emit("movestart");
  map.emit("zoom");
  now += 100;
  map.state.zoom = 8.2;
  map.emit("zoom");
  await settled();
  assert.ok(warm.demPending.size > 0);

  overlay.part.onToggle?.(false);
  await settled();

  assert.equal(warm.demPending.size + warm.pending.size, 0);
  overlay.destroy();
});

test("destroying the overlay aborts speculative work and stops new requests", async (t) => {
  optInPrefetch(t);
  const map = fakeMap();
  const warm = warmingDem();
  const http = warmingHttp();
  let now = 1000;
  const overlay = overlayWithDem(map, warm.dem, http.warmer, () => now);
  map.state.zoom = 8;
  map.emit("movestart");
  map.emit("zoom");
  now += 100;
  map.state.zoom = 8.2;
  map.emit("zoom");
  await settled();
  assert.ok(warm.demCalls.length > 0);

  const calls = warm.demCalls.length;
  overlay.destroy();
  now += 100;
  map.state.zoom = 8.4;
  map.emit("zoom");
  await settled();

  assert.equal(warm.demCalls.length, calls);
  assert.equal(warm.demPending.size + warm.pending.size + http.pending.size, 0);
});

test("toggling contours on mid-gesture keeps the labels frozen until moveend", () => {
  const map = fakeMap();
  const overlay = new ContourOverlay(
    layerContext(map),
    fakeDem(),
    TILES,
    STATS,
    undefined,
    undefined,
    silentHttp(),
  );

  map.emit("movestart");
  // drawView shows every part layer before it notifies the toggle.
  map.setLayoutProperty(LABEL_ID, "visibility", "visible");
  overlay.part.onToggle?.(true);
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");

  map.emit("moveend");
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
  overlay.destroy();
});

test("a gesture hides only the labels while the line source and buckets stay put", () => {
  const map = fakeMap();
  const dem = fakeDem();
  const overlay = overlayWithDem(map, dem, silentHttp());
  const lineSource = map.sources.get("terrain-contours");
  const labelSource = map.sources.get("terrain-labels-contours");
  const lineIds = overlay.part.layerIds.filter((id) => id !== LABEL_ID);
  assert.ok(lineIds.length > 0);
  // Identical protocol URLs decode to one worker cache entry, so the labels add no traces.
  const lineTiles = (map.sources.get("terrain-contours") as { tiles: unknown }).tiles;
  const labelTiles = (map.sources.get("terrain-labels-contours") as { tiles: unknown }).tiles;
  assert.deepEqual(labelTiles, lineTiles);

  map.emit("movestart");
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "none");
  assert.equal(map.sources.get("terrain-contours"), lineSource);
  assert.equal(map.sources.get("terrain-labels-contours"), labelSource);
  for (const id of lineIds) {
    assert.equal(map.layoutOf(id, "visibility"), undefined);
    assert.ok(map.layers.has(id));
  }

  map.emit("moveend");
  assert.equal(map.layoutOf(LABEL_ID, "visibility"), "visible");
  assert.equal(map.sources.get("terrain-contours"), lineSource);
  for (const id of lineIds) {
    assert.equal(map.layoutOf(id, "visibility"), undefined);
    assert.ok(map.layers.has(id));
  }
  overlay.destroy();
});

function fakeDem() {
  return {
    contourProtocolUrl: (request: unknown) =>
      `dem-contour://terrain/{z}/{x}/{y}?${encodeContourOptions(request)}`,
  };
}

/** Silent HTTP warming for overlay tests, so gestures never touch the network. */
function silentHttp(): HttpWarmer {
  return () => Promise.resolve(new ArrayBuffer(0));
}

/** Build an overlay whose scheduler warms through fakes instead of the network. */
function overlayWithDem(
  map: FakeMap,
  dem: { contourProtocolUrl: (request: unknown) => string; manager?: unknown },
  http: HttpWarmer,
  clock?: () => number,
): ContourOverlay {
  return new ContourOverlay(
    layerContext(map),
    dem as never,
    TILES,
    STATS,
    clock,
    undefined,
    http,
  );
}

// The worker keys its contour cache by tile plus encoded options, so equal URLs share traces.
function encodeContourOptions(request: unknown): string {
  const entries = Object.entries(request as Record<string, unknown>);
  entries.sort(([first], [second]) => (first < second ? -1 : 1));
  return entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("&");
}

/** Let aborted and resolved fakes reach the scheduler before the test asserts. */
async function settled(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await Promise.resolve();
}

/** Step one camera frame the way MapLibre emits it: move then zoom at one position. */
function frame(map: FakeMap, advance: () => void): void {
  advance();
  map.emit("move");
  map.emit("zoom");
}

interface PendingCall {
  id: number;
  key: string;
  resolve: (data?: unknown) => void;
  reject: (error: unknown) => void;
}

interface WarmingHttp {
  warmer: HttpWarmer;
  urls: string[];
  ids: number[];
  pending: Map<number, PendingCall & { url: string }>;
  aborted: string[];
  readonly peak: number;
}

/** Fake versioned HTTP warming that records URLs without touching the network. */
function warmingHttp(settleOnAbort = true): WarmingHttp {
  const urls: string[] = [];
  const ids: number[] = [];
  const pending = new Map<number, PendingCall & { url: string }>();
  const aborted: string[] = [];
  let peak = 0;
  let nextId = 0;
  const warmer: HttpWarmer = (url, signal) => {
    const id = nextId++;
    urls.push(url);
    ids.push(id);
    peak = Math.max(peak, pending.size + 1);
    return new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) {
        aborted.push(url);
        reject(new Error("aborted"));
        return;
      }
      const call: PendingCall & { url: string } = {
        id,
        key: url,
        url,
        resolve: (data?: unknown) => {
          pending.delete(id);
          resolve(data ?? new ArrayBuffer(0));
        },
        reject: (error: unknown) => {
          pending.delete(id);
          reject(error);
        },
      };
      pending.set(id, call);
      signal.addEventListener("abort", () => {
        aborted.push(url);
        if (!settleOnAbort) return;
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error("aborted"));
      });
    });
  };
  return {
    warmer,
    urls,
    ids,
    pending,
    aborted,
    get peak() {
      return peak;
    },
  };
}

interface WarmingDem {
  dem: {
    contourProtocolUrl: () => string;
    manager: {
      fetchTile: (z: number, x: number, y: number, cancel: AbortController) => Promise<unknown>;
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
  traceIds: number[];
  pending: Map<number, PendingCall>;
  aborted: string[];
  readonly peak: number;
  demCalls: { z: number; x: number; y: number }[];
  demIds: number[];
  demPending: Map<number, PendingCall>;
  demAborted: string[];
}

function warmingDem(demBytes = 200, settleOnAbort = true): WarmingDem {
  const calls: { z: number; x: number; y: number; options: unknown }[] = [];
  const traceIds: number[] = [];
  const pending = new Map<number, PendingCall>();
  const aborted: string[] = [];
  let peak = 0;
  const demCalls: { z: number; x: number; y: number }[] = [];
  const demIds: number[] = [];
  const demPending = new Map<number, PendingCall>();
  const demAborted: string[] = [];
  let nextId = 0;
  const manager = {
    fetchTile: (z: number, x: number, y: number, cancel: AbortController) => {
      const key = `${z}/${x}/${y}`;
      const id = nextId++;
      demCalls.push({ z, x, y });
      demIds.push(id);
      return new Promise<unknown>((resolve, reject) => {
        if (cancel.signal.aborted) {
          demAborted.push(key);
          reject(new Error("aborted"));
          return;
        }
        const call: PendingCall = {
          id,
          key,
          resolve: (data) => {
            demPending.delete(id);
            resolve(data ?? { data: new Blob([new Uint8Array(demBytes)]) });
          },
          reject: (error) => {
            demPending.delete(id);
            reject(error);
          },
        };
        demPending.set(id, call);
        cancel.signal.addEventListener("abort", () => {
          demAborted.push(key);
          if (!settleOnAbort) return;
          if (!demPending.has(id)) return;
          demPending.delete(id);
          reject(new Error("aborted"));
        });
      });
    },
    fetchContourTile: (
      z: number,
      x: number,
      y: number,
      options: unknown,
      cancel: AbortController,
    ) => {
      const key = `${z}/${x}/${y}`;
      const id = nextId++;
      calls.push({ z, x, y, options });
      traceIds.push(id);
      peak = Math.max(peak, pending.size + 1);
      return new Promise<unknown>((resolve, reject) => {
        if (cancel.signal.aborted) {
          aborted.push(key);
          reject(new Error("aborted"));
          return;
        }
        const call: PendingCall = {
          id,
          key,
          resolve: (data) => {
            pending.delete(id);
            resolve(data ?? { arrayBuffer: new ArrayBuffer(0) });
          },
          reject: (error) => {
            pending.delete(id);
            reject(error);
          },
        };
        pending.set(id, call);
        cancel.signal.addEventListener("abort", () => {
          aborted.push(key);
          if (!settleOnAbort) return;
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error("aborted"));
        });
      });
    },
  };
  return {
    dem: { contourProtocolUrl: () => "dem-contour://terrain/{z}/{x}/{y}", manager },
    calls,
    traceIds,
    pending,
    aborted,
    get peak() {
      return peak;
    },
    demCalls,
    demIds,
    demPending,
    demAborted,
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

/** Opt the test into the prefetch scheduler, which the address must now request. */
function optInPrefetch(t: { after: (cleanup: () => void) => void }) {
  const previous = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = { search: "?prefetch=1" };
  t.after(() => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "location");
    else (globalThis as Record<string, unknown>).location = previous;
  });
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
