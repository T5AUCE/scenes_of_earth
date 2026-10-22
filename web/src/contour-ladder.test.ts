import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import mlcontour from "maplibre-contour";
import type { Map as MapLibreMap } from "maplibre-gl";

import {
  contourLadder,
  FADE_SPAN_ZOOM,
  finestIntervalAt,
  INTERVAL_CHAIN_FT,
  INTERVAL_CHAIN_M,
  labelIntervalsAt,
  metresPerPixel,
} from "./contour-ladder.ts";
import { RELIEF_STRENGTH, reliefPaint } from "./layers/relief.ts";
import type { LayerContext, TerrainStats, TerrainTiles } from "./types.ts";

const FIJI = makeStats(1, 820, 6, 14);
const KENYA = makeStats(39, 2426, 1, 5);
const FLAT = makeStats(150, 260, 0.1, 0.5);
const TILES: TerrainTiles = {
  url: "https://tiles.example.test/{z}/{x}/{y}.webp",
  encoding: "terrarium",
  tile_size: 512,
  maxzoom: 11,
  source: { name: "DEM", licence: "open", attribution: "DEM attribution" },
};

test("Fiji, Kenya and the flat scene keep the specified fixed bold steps", () => {
  assert.equal(contourLadder(FIJI, -18).boldInterval, 100);
  assert.equal(contourLadder(KENYA, 0).boldInterval, 500);
  assert.equal(contourLadder(FLAT, 12).boldInterval, 50);
});

test("zoom-in only adds contour heights and every chain step divides the next", () => {
  for (const [index, interval] of INTERVAL_CHAIN_M.entries()) {
    if (index > 0) assert.equal(interval % INTERVAL_CHAIN_M[index - 1], 0);
  }
  for (const sample of [FIJI, KENYA, FLAT]) {
    const ladder = contourLadder(sample, -18);
    let previous = Infinity;
    for (let zoom = 0; zoom <= 14; zoom += 1) {
      const interval = finestIntervalAt(ladder, zoom) ?? Infinity;
      assert.ok(interval <= previous);
      if (Number.isFinite(previous)) assert.equal(previous % interval, 0);
      previous = interval;
    }
  }
});

test("every tier is traced one whole zoom before it enters except at the z0 floor", () => {
  for (const sample of [FIJI, KENYA, FLAT, makeStats(0, 0, 0, 0)]) {
    const ladder = contourLadder(sample, 0);
    for (const tier of ladder.tiers) {
      assert.equal(tier.traceZoom, Math.max(0, tier.entryZoom - 1));
      assert.ok(thresholdAt(ladder.thresholds, tier.traceZoom) <= tier.interval);
    }
  }
});

test("the slope spacing rule is met at entry and was not met one zoom earlier", () => {
  const ladder = contourLadder(FIJI, -18);
  const required = (zoom: number) =>
    5 * metresPerPixel(zoom, -18) * Math.tan(FIJI.slope_p90_deg * Math.PI / 180);
  for (const tier of ladder.tiers) {
    assert.ok(tier.interval >= required(tier.entryZoom));
    if (tier.entryZoom > 0) assert.ok(tier.interval < required(tier.entryZoom - 1));
  }
});

test("the feet ladder stays round and nested like the metre ladder", () => {
  for (const [index, interval] of INTERVAL_CHAIN_FT.entries()) {
    if (index > 0) assert.equal(interval % INTERVAL_CHAIN_FT[index - 1], 0);
  }
  for (const sample of [FIJI, KENYA, FLAT]) {
    const ladder = contourLadder(sample, -18, { elevationUnit: "ft" });
    let previous = Infinity;
    for (let zoom = 0; zoom <= 14; zoom += 1) {
      const interval = finestIntervalAt(ladder, zoom) ?? Infinity;
      assert.ok(interval <= previous);
      if (Number.isFinite(previous)) assert.equal(previous % interval, 0);
      previous = interval;
    }
    assert.ok(ladder.tiers.every((tier) => INTERVAL_CHAIN_FT.includes(tier.interval)));
  }
});

test("the ladder has a 10 m floor and freezes at z12 or the DEM overzoom ceiling", () => {
  const flat = contourLadder(makeStats(0, 0, 0, 0), 0, { maxZoom: 20 });
  assert.equal(finestIntervalAt(flat, 0), 10);
  assert.equal(finestIntervalAt(flat, 20), 10);
  assert.ok(Object.keys(flat.thresholds).every((zoom) => Number(zoom) <= 12));
  assert.deepEqual(contourLadder(FIJI, -18, { maxZoom: 20 }), contourLadder(FIJI, -18));
  const capped = contourLadder(FIJI, -18, { maxZoom: 9 });
  assert.ok(capped.tiers.every((tier) => tier.entryZoom <= 9));
});

test("labels are bold-only without the sparse switch, which only adds a finer tier", () => {
  for (const sample of [FIJI, KENYA, FLAT]) {
    const bold = contourLadder(sample, 0, { labelSparseFallback: false });
    assert.deepEqual(bold.labelTiers.map((tier) => tier.interval), [bold.boldInterval]);
    const sparse = contourLadder(sample, 0, { labelSparseFallback: true });
    let previous: number[] = [];
    for (let zoom = 0; zoom <= 14; zoom += 1) {
      const current = labelIntervalsAt(sparse, zoom);
      assert.ok(previous.every((interval) => current.includes(interval)));
      previous = current;
    }
  }
  assert.equal(contourLadder(FLAT, 12, { labelSparseFallback: true }).labelTiers.length, 2);
  assert.equal(contourLadder(FLAT, 12).labelTiers.length, 2);
});

test("the ladder is deterministic and does not mutate its statistics", () => {
  const sample = Object.freeze({ ...KENYA });
  assert.deepEqual(contourLadder(sample, 0), contourLadder(sample, 0));
});

function makeStats(
  low: number,
  high: number,
  medianSlope: number,
  steepSlope: number,
): TerrainStats {
  return {
    min: low,
    max: high,
    mean: (low + high) / 2,
    p2: low,
    p98: high,
    slope_p50_deg: medianSlope,
    slope_p90_deg: steepSlope,
    cell_m: 500,
  };
}

function thresholdAt(thresholds: Record<number, number>, zoom: number) {
  const entries = Object.entries(thresholds).filter(([entry]) => Number(entry) <= zoom);
  return entries.at(-1)?.[1] ?? Infinity;
}

// Browser dependencies are replaced so integration checks need no worker or terrain downloads.
const rootUrl = new URL("./", import.meta.url).href;
const mockModules = {
  "maplibre-contour": `export default { DemSource: globalThis.contourTestDemSource };`,
  "maplibre-gl": `export const addProtocol = () => {};`,
  "../html": `export const makeHtmlElement = () => ({ textContent: "", hidden: false });`,
  "../map": `export function removeLayerAndSource(map, id) {
    map.removeLayer(id);
    map.removeSource(id);
  }`,
  "./api": `export const loadAreaFeature = () => {};`,
  "./html": `export const makeHtmlElement = () => {};`,
  "./map": `
    export const MAX_ZOOM = 24;
    export const WORLD_VIEW = {};
    export const moveLabelsIntoArea = () => { throw new Error("Scene symbols must be excluded"); };
    export const removeLayerAndSource = () => {};
  `,
  "./scene-camera": `export const flightDuration = () => {};
    export const flyIn = () => {}; export const watchResize = () => {};`,
  "./scene-panel": `export const createScenePanel = () => {}; export const PANEL_TABS = [];`,
  "./view": `export const mountScene = () => {}; export const OUTLINE_ID = "outline";`,
};

class TestDemSource {
  static instances: TestDemSource[] = [];
  readonly sharedDemProtocolUrl = "dem-shared://{z}/{x}/{y}";
  options: object;
  contourOptions: object = {};
  setups = 0;

  constructor(options: object) {
    this.options = options;
    TestDemSource.instances.push(this);
  }

  setupMaplibre() {
    this.setups += 1;
  }

  contourProtocolUrl(options: object) {
    this.contourOptions = options;
    return "dem-contour://{z}/{x}/{y}";
  }
}

Object.assign(globalThis, { contourTestDemSource: TestDemSource });
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
const { ContourOverlay, sharedDemSource, terrainTileBounds } =
  await import("./layers/contour-overlay.ts");
const { createTerrainView } = await import("./layers/terrain.ts");
const { SceneDataLayers, movePlaceLabels } = await import("./scene-mode.ts");
const { contourLegendText } = await import("./legend.ts");
hooks.deregister();
Reflect.deleteProperty(globalThis, "contourTestDemSource");

test("both terrain displays reuse one worker cache and register protocols once per source", () => {
  const first = sharedDemSource(TILES);
  assert.equal(sharedDemSource({ ...TILES }), first);
  const source = first as unknown as TestDemSource;
  assert.equal(source.setups, 1);
  assert.deepEqual(source.options, {
    url: TILES.url,
    encoding: "terrarium",
    maxzoom: 11,
    worker: true,
    cacheSize: 50,
  });
});

test("normal tile bounds are kept while unwrapped antimeridian bounds are omitted", () => {
  assert.deepEqual(terrainTileBounds([33, -5, 42, 5]), { bounds: [33, -5, 42, 5] });
  assert.deepEqual(terrainTileBounds([178, -20, 182, -15]), {});
  assert.deepEqual(terrainTileBounds([-182, -20, -178, -15]), {});
});

test("contour styles validate in MapLibre and cap refinement at z12", (context) => {
  mockPage(context);
  const map = new TestMap();
  const dem = sharedDemSource(TILES);
  const overlay = new ContourOverlay(layerContext(map), dem, TILES, FIJI);
  const source = map.sources.get("terrain-contours")!;
  assert.equal(map.sources.size, 1);
  assert.equal(source.maxzoom, 12);
  assert.equal((dem as unknown as TestDemSource).contourOptions["overzoom"], 1);
  const errors = validateStyleMin({
    version: 8,
    glyphs: "https://example.test/{fontstack}/{range}.pbf",
    sources: {
      basemap: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      ...Object.fromEntries(map.sources),
    },
    layers: [...map.layers.values()],
  });
  assert.deepEqual(errors.map((error) => error.message), []);
  const tierLines = map.layers.values().filter((layer) => layer.type === "line");
  for (const layer of tierLines) {
    assert.ok(!JSON.stringify(layer).includes('"level"'));
    const opacity = layer.paint["line-opacity"];
    assert.equal(opacity[3], layer.minzoom);
    assert.equal(opacity[5], layer.minzoom + FADE_SPAN_ZOOM);
    assert.equal(opacity[4], 0);
  }
  const labels = map.layers.get("terrain-contours-labels")!;
  assert.deepEqual(labels.layout["text-font"], ["Noto Sans Regular"]);
  assert.equal(labels.layout["symbol-spacing"], 350);
  assert.equal(labels.paint["text-halo-color"], "#faf8f3");
  assert.equal(labels.minzoom, contourLadder(FIJI, 0).tiers[0].entryZoom);
  assert.ok(overlay.part.layerIds.includes(labels.id));
  map.zoom = 12;
  map.emit("zoomend");
  assert.equal(overlay.legend.textContent, contourLegendText(50, 100));
  overlay.part.onToggle?.(false);
  assert.equal(overlay.legend.hidden, true);
  overlay.destroy();
  assert.equal(map.listeners.get("zoomend")?.size, 0);
  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 1);
});

test("feet contours use scaled elevations with round feet labels", (context) => {
  mockPage(context);
  const map = new TestMap();
  const dem = sharedDemSource(TILES);
  const overlay = new ContourOverlay(
    { ...layerContext(map), display: { units: "ft" } },
    dem,
    TILES,
    FIJI,
  );
  const { multiplier } = (dem as unknown as TestDemSource).contourOptions as {
    multiplier?: number;
  };
  assert.ok(multiplier !== undefined && Math.abs(multiplier - 3.28084) < 1e-4);

  const labels = map.layers.get("terrain-contours-labels")!;
  const field = JSON.stringify(labels.layout["text-field"]);
  assert.ok(field.includes("ft"));
  assert.ok(!field.includes('" m"'));

  const feetLadder = contourLadder(FIJI, 0, { elevationUnit: "ft" });
  const multipleOf = (interval: number) => ["==", ["%", ["get", "ele"], interval], 0];
  const soleMultiple = (interval: number, coarser: number) => [
    "all",
    multipleOf(interval),
    ["!", multipleOf(coarser)],
  ];
  assert.deepEqual(
    [...map.layers.values()]
      .filter((layer) => layer.type === "line")
      .map((layer) => layer.filter),
    feetLadder.tiers.map((tier, index) => {
      const coarser = feetLadder.tiers[index - 1];
      if (!coarser) return multipleOf(tier.interval);

      return soleMultiple(tier.interval, coarser.interval);
    }),
  );

  map.zoom = 12;
  map.emit("zoomend");
  const interval = feetLadder.tiers.length > 0 ? overlay.legend.textContent : "";
  assert.match(interval ?? "", /ft/);

  overlay.setUnits("m");
  const relabelled = map.layers.get("terrain-contours-labels")!;
  assert.ok(JSON.stringify(relabelled.layout["text-field"]).includes("m"));
  assert.doesNotMatch(overlay.legend.textContent ?? "", /ft/);
  overlay.destroy();
});

test("the terrain legend shows the interval while the contours part carries no note", (context) => {
  mockPage(context);
  const map = new TestMap();
  const view = createTerrainView(layerContext(map));
  const contours = view.parts.find((part) => part.id === "terrain.contours")!;
  assert.equal(contours.note, undefined);

  const legend = view.legend();
  assert.ok(legend);
  map.zoom = 12;
  map.emit("zoomend");
  const ladder = contourLadder(FIJI, 0, { maxZoom: 12 });
  assert.equal(
    legend.textContent,
    contourLegendText(finestIntervalAt(ladder, 12)!, ladder.boldInterval),
  );
  assert.equal(legend.hidden, false);

  map.zoom = 0;
  map.emit("zoomend");
  assert.equal(legend.hidden, finestIntervalAt(ladder, 0) === null);

  map.zoom = 12;
  map.emit("zoomend");
  view.menu?.units?.set("ft");
  assert.equal(view.legend(), legend);
  const feetLadder = contourLadder(FIJI, 0, { maxZoom: 12, elevationUnit: "ft" });
  assert.equal(
    legend.textContent,
    contourLegendText(finestIntervalAt(feetLadder, 12)!, feetLadder.boldInterval, "ft"),
  );

  contours.onToggle?.(false);
  assert.equal(legend.hidden, true);
  view.destroy();
});

test("the configured contour buffer stays inside the plugin's materialized padding", (context) => {
  mockPage(context);
  const map = new TestMap();
  const dem = sharedDemSource(TILES);
  const overlay = new ContourOverlay(layerContext(map), dem, TILES, FIJI);
  const { buffer } = (dem as unknown as TestDemSource).contourOptions as { buffer: number };
  const extent = 4096;
  const tileWidth = 257;
  const elevationStepM = 20;
  const intervalM = 1000;
  const plane = new mlcontour.HeightTile(
    tileWidth,
    tileWidth,
    (x) => x * elevationStepM,
  ).materialize(1);
  const lines = mlcontour.generateIsolines(intervalM, plane, extent, buffer);

  for (const [elevation, fragments] of Object.entries(lines)) {
    assert.equal(fragments.length, 1);
    const expectedX = Math.round(Number(elevation) / elevationStepM * extent / (tileWidth - 1));
    assert.ok(fragments[0].every((value, index) => index % 2 !== 0 || value === expectedX));
  }
  assert.ok(Object.keys(lines).length > 0);
  overlay.destroy();
});

test("relief stays single-layered through zoom and source loading events", (context) => {
  mockPage(context);
  const map = new TestMap();
  const view = createTerrainView(layerContext(map));
  const reliefId = "terrain-relief";
  const initialPaint = reliefPaint(RELIEF_STRENGTH.initial);
  const hillshades = [...map.layers.values()].filter((layer) => layer.type === "hillshade");

  assert.deepEqual(view.parts[0].layerIds, [reliefId]);
  assert.ok(!map.sources.has(`${reliefId}-backdrop`));
  assert.deepEqual(hillshades.map((layer) => layer.id), [reliefId]);
  map.zooming = true;
  map.emit("zoomstart");
  map.emit("dataloading", { sourceId: reliefId });
  map.emit("sourcedata", { sourceId: reliefId });
  map.zooming = false;
  map.emit("zoomend");

  assert.deepEqual(map.layers.get(reliefId).paint, initialPaint);
  assert.ok(map.paints.every(([id]) => id !== reliefId && id !== `${reliefId}-backdrop`));
  view.destroy();
  assert.equal(map.sources.size, 0);
  assert.ok([...map.listeners.values()].every((listeners) => listeners.size === 0));
});

test("relief strength updates only the main hillshade and zero stays flat on zoom", (context) => {
  mockPage(context);
  const map = new TestMap();
  const view = createTerrainView(layerContext(map));
  const strength = view.parts[0].controls![0];

  for (const value of [RELIEF_STRENGTH.max, RELIEF_STRENGTH.min]) {
    map.paints.length = 0;
    strength.set(value);

    const expectedPaint = [
      "terrain-relief",
      reliefPaint(value)["hillshade-exaggeration"],
    ];
    assert.deepEqual(map.paints, [expectedPaint]);
  }
  map.zooming = true;
  map.emit("zoomstart");
  map.zooming = false;
  map.emit("zoomend");

  assert.deepEqual(map.layers.get("terrain-relief").paint, reliefPaint(0));
  view.destroy();
});

test("shared relief and contour layers keep their mask-gated zoom bounds", (context) => {
  mockPage(context);
  const map = new TestMap();
  const view = createTerrainView(layerContext(map));
  const relief = map.sources.get("terrain-relief")!;
  assert.deepEqual(relief.tiles, [sharedDemSource(TILES).sharedDemProtocolUrl]);
  assert.equal(relief.tileSize, 512);
  assert.equal(relief.maxzoom, 11);
  const ids = view.parts.flatMap((part) => part.layerIds);
  const native = ids.map((id) => ({ id, min: map.layers.get(id).minzoom ?? 0 }));
  const gate = new SceneDataLayers(map as unknown as MapLibreMap, ids);
  for (const id of ids) assert.equal(map.layers.get(id).minzoom, 24);
  gate.update(5);
  gate.show();
  for (const { id, min } of native) assert.equal(map.layers.get(id).minzoom, Math.max(min, 4.75));
  const restore = movePlaceLabels(map as unknown as MapLibreMap, {} as never, 4.75, ids);
  assert.ok(!map.layers.has("terrain-contours-labels-soe-scene-label"));
  assert.ok(map.layers.has("places-soe-scene-label"));
  gate.update(undefined);
  for (const { id, min } of native) assert.equal(map.layers.get(id).minzoom, min);
  restore();
  view.destroy();
  assert.equal(map.layers.size, 1);
  assert.equal(map.sources.size, 0);
});

test("switching units refreshes the mask gate and drops removed tiers", (context) => {
  mockPage(context);
  const map = new TestMap();
  const view = createTerrainView(layerContext(map, KENYA));
  const ids = view.parts.flatMap((part) => part.layerIds);
  const gate = new SceneDataLayers(map as unknown as MapLibreMap, ids);
  gate.update(5);
  gate.show();

  const layersBeforeFeet = new Map(ids.map((id) => [id, map.layers.get(id)]));
  view.menu?.units?.set("ft");
  const feetIds = view.parts.flatMap((part) => part.layerIds);
  // Persisting layers still show the mask gate, so only rebuilt tiers carry fresh native zooms.
  const feetNative = feetIds
    .filter((id) => map.layers.get(id) !== layersBeforeFeet.get(id))
    .map((id) => ({ id, min: map.layers.get(id)?.minzoom ?? 0 }));
  assert.ok(!feetIds.includes("terrain-contours-10"));
  assert.ok(feetNative.length > 0);
  gate.sync(feetIds);
  gate.update(undefined);
  for (const { id, min } of feetNative) {
    assert.equal(map.layers.get(id)?.minzoom, min);
  }
  gate.update(5);
  for (const { id, min } of feetNative) {
    assert.equal(map.layers.get(id)?.minzoom, Math.max(min, 4.75));
  }
  gate.update(undefined);
  for (const { id, min } of feetNative) {
    assert.equal(map.layers.get(id)?.minzoom, min);
  }

  const layersBeforeMetres = new Map(feetIds.map((id) => [id, map.layers.get(id)]));
  view.menu?.units?.set("m");
  const metreIds = view.parts.flatMap((part) => part.layerIds);
  // Persisting layers still show the mask gate, so only rebuilt tiers carry fresh native zooms.
  const metreNative = metreIds
    .filter((id) => map.layers.get(id) !== layersBeforeMetres.get(id))
    .map((id) => ({ id, min: map.layers.get(id)?.minzoom ?? 0 }));
  assert.ok(metreIds.includes("terrain-contours-10"));
  assert.ok(metreNative.length > 0);
  gate.sync(metreIds);
  gate.update(undefined);
  for (const { id, min } of metreNative) {
    assert.equal(map.layers.get(id)?.minzoom, min);
  }
  gate.update(5);
  for (const { id, min } of metreNative) {
    assert.equal(map.layers.get(id)?.minzoom, Math.max(min, 4.75));
  }
  gate.update(undefined);
  for (const { id, min } of metreNative) {
    assert.equal(map.layers.get(id)?.minzoom, min);
  }
  view.destroy();
});

test("flat and capped contour styles validate when several tiers enter together", (context) => {
  mockPage(context);
  for (const sample of [FLAT, makeStats(0, 0, 0, 0), makeStats(0, 1000, 89.9, 89.9)]) {
    const map = new TestMap();
    const dem = sharedDemSource(TILES);
    const overlay = new ContourOverlay(layerContext(map), dem, TILES, sample);
    const errors = validateStyleMin({
      version: 8,
      glyphs: "https://example.test/{fontstack}/{range}.pbf",
      sources: {
        basemap: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        ...Object.fromEntries(map.sources),
      },
      layers: [...map.layers.values()],
    });
    assert.deepEqual(errors.map((error) => error.message), []);
    overlay.destroy();
  }
});

function layerContext(map: TestMap, stats: TerrainStats = FIJI): LayerContext {
  return {
    map: map as unknown as MapLibreMap,
    store: Promise.resolve({} as never),
    layer: {
      id: "terrain",
      title: "Terrain",
      units: "m",
      grid: { bbox: [33, -5, 42, 5], res: 0.01, nx: 900, ny: 1000 },
      tiles: TILES,
      stats,
    } as LayerContext["layer"],
    shift: 0,
    slots: { fill: "places", shade: "places", marks: "places", lines: "places" },
    beforeId: "places",
    report: (error) => {
      throw error;
    },
  };
}

function mockPage(context: TestContext) {
  const originals = ["document", "getComputedStyle"].map((name) => (
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  ));
  Object.assign(globalThis, {
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => "#faf8f3" }),
  });
  context.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
}

class TestMap {
  readonly sources = new Map<string, any>();
  readonly layers = new Map<string, any>([
    [
      "places",
      {
        id: "places",
        type: "symbol",
        source: "basemap",
        layout: { "text-font": ["Noto Sans Regular"] },
      },
    ],
  ]);
  readonly listeners = new Map<string, Set<(event: object) => void>>();
  zoom = 6;

  zooming = false;
  readonly paints: [string, unknown][] = [];

  getStyle() {
    return { layers: [...this.layers.values()] };
  }

  getZoom() {
    return this.zoom;
  }

  getLayer(id: string) {
    return this.layers.get(id);
  }

  addSource(id: string, source: object) {
    this.sources.set(id, source);
  }

  addLayer(layer: { id: string }) {
    this.layers.set(layer.id, layer);
  }

  removeLayer(id: string) {
    this.layers.delete(id);
  }

  removeSource(id: string) {
    this.sources.delete(id);
  }

  setPaintProperty(id: string, property: string, value: unknown) {
    this.paints.push([id, value]);
    this.layers.get(id).paint[property] = value;
  }

  setLayerZoomRange(id: string, minzoom: number, maxzoom: number) {
    Object.assign(this.layers.get(id), { minzoom, maxzoom });
  }

  on(event: string, listener: (event: object) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  off(event: string, listener: (event: object) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, data: object = {}) {
    this.listeners.get(event)?.forEach((listener) => listener(data));
  }
}
