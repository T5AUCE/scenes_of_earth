import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import type { GridDoc, LayerContext } from "../types.ts";
import {
  ISOTHERM_CASING_RATIO,
  ISOTHERM_DASH_PATTERN,
  isolineInterval,
  isolineLevels,
  toLngLat,
  traceIsolines,
} from "../render/isolines.ts";
import { inkPaint } from "../render/palettes.ts";

const KENYA_STOPS = [5, 8, 11, 14, 17, 20, 23, 26, 29];

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("/src/") && specifier.startsWith(".")) {
      const extension = specifier.endsWith(".ts") ? "" : ".ts";
      return next(new URL(`${specifier}${extension}`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { createIsolineOverlay } = await import("./isolines.ts")
  .finally(() => hooks.deregister());

test("the overlay follows the display range and retraces after a change", () => {
  const { map, data } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = {
    map,
    layer,
    shift: 0,
    display: { range: [20, 24] },
  } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  overlay.setValues([0, 30, 30, 0], 0);
  const initial = overlayLevels(data());
  assert.ok(initial.every((level) => level >= 20 && level <= 24));
  assert.ok(initial.includes(20));
  assert.ok(!initial.includes(6));

  overlay.setRange([10, 14]);
  overlay.setValues([0, 30, 30, 0], 0);
  const changed = overlayLevels(data());
  assert.ok(changed.every((level) => level >= 10 && level <= 14));
  assert.ok(changed.includes(10));
});

test("fahrenheit intervals stay round with native geometry", () => {
  const { map, data } = fakeMap();
  const layer = {
    id: "temperature",
    units: "°C",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = {
    map,
    layer,
    shift: 0,
    display: { range: [10, 30], units: "°F" },
  } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));

  assert.equal(overlay.interval, 5);
  overlay.setValues([0, 100, 100, 0], 0);
  const levels = overlayLevels(data());
  assert.ok(levels.length > 0);
  assert.ok(new Set(levels).size <= 12);
  assert.ok(levels.every((level) => level >= 50 && level <= 86 && level % 5 === 0));
  assert.ok(levels.includes(50));
});

test("switching display units retraces with converted labels", () => {
  const { map, data } = fakeMap();
  const layer = {
    id: "temperature",
    units: "°C",
    grid: { bbox: [0, 0, 1, 1], nx: 3, ny: 3, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = {
    map,
    layer,
    shift: 0,
    display: { range: [20, 24] },
  } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  const values = [0, 30, 0, 30, 0, 30, 0, 30, 0];

  overlay.setValues(values, 0);
  assert.equal(overlay.interval, 0.5);

  overlay.setUnits("°F");
  overlay.setValues(values, 0);
  assert.equal(overlay.interval, 1);
  const levels = overlayLevels(data());
  assert.ok(levels.every((level) => level >= 68 && level <= 75.2));
});

test("the overlay defaults to smooth tracing and caches each step and mode", () => {
  const { map, data } = fakeMap();
  const grid = {
    bbox: [0, 0, 1, 1] as [number, number, number, number],
    nx: 3,
    ny: 3,
    res: 1,
  };
  const layer = { id: "temperature", grid, style: { stops: KENYA_STOPS } };
  const range: [number, number] = [20, 24];
  const context = {
    map,
    layer,
    shift: 0,
    display: { range },
  } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  const values = [0, 30, 0, 30, 0, 30, 0, 30, 0];
  const counted = countingValues(values);
  const levels = isolineLevels(range[0], range[1], isolineInterval(range));
  const expectedSmooth = tracedCoordinates(values, grid, levels, true);
  const expectedRaw = tracedCoordinates(values, grid, levels, false);

  overlay.setValues(counted.values, 0);
  const smoothReads = counted.reads();
  assert.ok(smoothReads > 0);
  assert.deepEqual(overlayCoordinates(data()), expectedSmooth);
  assert.notDeepEqual(overlayCoordinates(data()), expectedRaw);

  overlay.setValues(counted.values, 0);
  assert.equal(counted.reads(), smoothReads);

  overlay.setSmooth(false);
  overlay.setValues(counted.values, 0);
  const rawReads = counted.reads();
  assert.ok(rawReads > smoothReads);
  assert.deepEqual(overlayCoordinates(data()), expectedRaw);

  overlay.setSmooth(true);
  overlay.setValues(counted.values, 0);
  assert.equal(counted.reads(), rawReads);
  assert.deepEqual(overlayCoordinates(data()), expectedSmooth);

  overlay.setValues(counted.values, 1);
  assert.ok(counted.reads() > rawReads);
});

test("changing the display interval retraces the same step", () => {
  const { map, data } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 3, ny: 3, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = {
    map,
    layer,
    shift: 0,
    display: { range: [20, 24] },
  } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  const counted = countingValues([0, 30, 0, 30, 0, 30, 0, 30, 0]);

  overlay.setValues(counted.values, 0);
  const initialReads = counted.reads();
  const initial = overlayLevels(data());
  const initialInterval = overlay.interval;

  overlay.setRange([10, 30]);
  overlay.setValues(counted.values, 0);
  const changed = overlayLevels(data());

  assert.equal(initialInterval, 0.5);
  assert.equal(overlay.interval, 2);
  assert.ok(counted.reads() > initialReads);
  assert.ok(initial.every((level) => level >= 20 && level <= 24));
  assert.ok(changed.every((level) => level >= 10 && level <= 30 && level % 2 === 0));
  assert.ok(changed.includes(10));
});

test("the isotherm overlays validate in MapLibre", () => {
  const { map, layers, sources } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = { map, layer, shift: 0, display: null } as unknown as LayerContext;
  createIsolineOverlay(context, inkPaint("charcoal"));
  const errors = validateStyleMin({
    version: 8,
    glyphs: "https://example.test/{fontstack}/{range}.pbf",
    sources: {
      basemap: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      ...Object.fromEntries(sources),
    },
    layers,
  });

  assert.deepEqual(errors.map((error) => error.message), []);
});

test("changing the ink repaints the lines, casing and labels with the matching halo", () => {
  const { map, layers } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = { map, layer, shift: 0, display: null } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  const paintOf = (suffix: string) => layers.find(({ id }) => id.endsWith(suffix))!.paint!;

  assert.equal(paintOf("-lines")["line-color"], "rgb(49, 63, 77)");
  assert.equal(paintOf("-casing")["line-color"], "rgb(246, 239, 227)");

  overlay.setInk(inkPaint("white"));

  assert.equal(paintOf("-lines")["line-color"], "rgb(255, 255, 255)");
  assert.equal(paintOf("-casing")["line-color"], "rgb(31, 31, 31)");
  assert.equal(paintOf("-labels")["text-halo-color"], "rgb(31, 31, 31)");
});

test("the casing dashes line up with the isotherms in screen pixels at every zoom", () => {
  const { map, layers } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = { map, layer, shift: 0, display: null } as unknown as LayerContext;
  createIsolineOverlay(context, inkPaint("charcoal"));
  const paintOf = (suffix: string) => layers.find(({ id }) => id.endsWith(suffix))!.paint!;
  const line = paintOf("-lines");
  const casing = paintOf("-casing");
  const lineDashes = line["line-dasharray"] as number[];
  const casingDashes = casing["line-dasharray"] as number[];

  assert.deepEqual(lineDashes, ISOTHERM_DASH_PATTERN);
  for (const zoom of [0, 5, 8, 14, 18, 22]) {
    for (const isBold of [false, true]) {
      const linePx = widthAt(line["line-width"] as unknown[], zoom, isBold);
      const casingPx = widthAt(casing["line-width"] as unknown[], zoom, isBold);
      assert.ok(approximately(casingPx, linePx * ISOTHERM_CASING_RATIO), `${zoom} width`);

      const lineDashPx = lineDashes.map((length) => length * linePx);
      const casingDashPx = casingDashes.map((length) => length * casingPx);
      lineDashPx.forEach((length, index) => {
        assert.ok(approximately(casingDashPx[index], length), `${zoom} dash ${index}`);
      });
    }
  }
});

function fakeMap() {
  let data: unknown;
  const layers: { id: string; paint?: Record<string, unknown> }[] = [];
  const sources = new Map<string, unknown>();
  const map = {
    addSource(id: string, source: { data: unknown }) {
      data = source.data;
      sources.set(id, source);
    },
    addLayer(layer: { id: string; paint?: Record<string, unknown> }) {
      layers.push(layer);
    },
    getStyle: () => ({ layers: [] }),
    getSource: () => ({
      setData(next: unknown) {
        data = next;
      },
    }),
    setLayoutProperty() {},
    setPaintProperty(id: string, name: string, value: unknown) {
      layers.find((layer) => layer.id === id)!.paint![name] = value;
    },
    getLayer: () => ({}),
    removeLayer() {},
    removeSource() {},
  };

  return { map, layers, sources, data: () => data };
}

function overlayLevels(data: unknown) {
  const collection = data as { features: { properties: { label: string } }[] };
  return collection.features.map(({ properties }) => Number.parseFloat(properties.label));
}

function overlayCoordinates(data: unknown): [number, number][][] {
  const collection = data as {
    features: { geometry: { coordinates: [number, number][] } }[];
  };
  return collection.features.map(({ geometry }) => geometry.coordinates);
}

function tracedCoordinates(
  values: readonly number[],
  grid: Pick<GridDoc, "bbox" | "nx" | "ny">,
  levels: readonly number[],
  refine: boolean,
): [number, number][][] {
  return traceIsolines(values, grid.nx, grid.ny, levels, refine)
    .map(({ coordinates }) => toLngLat(coordinates, grid, 0));
}

function countingValues(values: readonly number[]) {
  let reads = 0;
  const counted = new Proxy([...values], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });

  return { values: counted as ArrayLike<number>, reads: () => reads };
}

function widthAt(expression: readonly unknown[], zoom: number, isBold: boolean): number {
  const stops: [number, number][] = [];
  for (let index = 3; index < expression.length; index += 2) {
    const branch = expression[index + 1] as readonly unknown[];
    stops.push([Number(expression[index]), Number(isBold ? branch[2] : branch[3])]);
  }

  if (zoom <= stops[0][0]) return stops[0][1];
  for (let index = 1; index < stops.length; index++) {
    const [lowZoom, lowWidth] = stops[index - 1];
    const [highZoom, highWidth] = stops[index];
    if (zoom <= highZoom) {
      const along = (zoom - lowZoom) / (highZoom - lowZoom);
      return lowWidth + (highWidth - lowWidth) * along;
    }
  }

  return stops[stops.length - 1][1];
}

function approximately(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}
