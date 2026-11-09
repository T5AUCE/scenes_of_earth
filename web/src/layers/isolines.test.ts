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
import { LABEL_FADE_MS } from "../reduced-motion.ts";

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

test("the crossfade keeps zoom on top and scales the stops by the mix", () => {
  const { map, layers } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  assert.equal(overlay.holds(1), false);
  assert.equal(overlay.frame(0, 1, 0), true);
  assert.equal(overlay.isReady(0, 1), true);

  assert.equal(overlay.frame(0, 1, 0.25), true);

  const outgoing = opacityOf(layers, "temperature-isotherms-a-lines");
  const incoming = opacityOf(layers, "temperature-isotherms-b-lines");
  assert.deepEqual(outgoing.slice(0, 3), ["interpolate", ["linear"], ["zoom"]]);
  assert.deepEqual(incoming.slice(0, 3), ["interpolate", ["linear"], ["zoom"]]);
  assert.ok(approximately(stopAt(outgoing, 0), 0.85 * 0.75));
  assert.ok(approximately(stopAt(outgoing, 16), 1 * 0.75));
  assert.ok(approximately(stopAt(incoming, 0), 0.85 * 0.25));
  assert.ok(approximately(stopAt(incoming, 16), 1 * 0.25));
});

test("the crossfade disables opacity transitions so per-frame values apply", () => {
  const { map, layers } = fakeMap();
  mountOverlay(map);
  const paintOf = (id: string) => layers.find((layer) => layer.id === id)!.paint!;

  for (const source of ["temperature-isotherms-a", "temperature-isotherms-b"]) {
    assert.deepEqual(paintOf(`${source}-casing`)["line-opacity-transition"], { duration: 0 });
    assert.deepEqual(paintOf(`${source}-lines`)["line-opacity-transition"], { duration: 0 });
    assert.deepEqual(paintOf(`${source}-labels`)["text-opacity-transition"], { duration: 0 });
  }
});

test("labels show only on the dominant set and flip halfway", () => {
  const { map, layers } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  overlay.frame(0, 1, 0);

  overlay.frame(0, 1, 0.25);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 1);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-b-labels"), 0);

  overlay.frame(0, 1, 0.75);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 0);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-b-labels"), 1);
});

test("a camera gesture hides the isotherm labels and restores the dominant set", () => {
  const { map, layoutOf } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "visible");

  map.emit("movestart");
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "none");

  map.emit("moveend");
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "visible");
  overlay.destroy();
});

test("the isotherm labels fade back after a gesture instead of popping", () => {
  const { map, layers, layoutOf } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);

  map.emit("movestart");
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 0);

  map.emit("moveend");
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "visible");
  assert.deepEqual(transitionOf(layers, "temperature-isotherms-a-labels"), {
    duration: LABEL_FADE_MS,
  });
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 1);
  overlay.destroy();
});

test("reduced motion restores the isotherm labels instantly", () => {
  const { map, layers } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  useReducedMotion(true);

  try {
    map.emit("movestart");
    map.emit("moveend");
    assert.deepEqual(transitionOf(layers, "temperature-isotherms-a-labels"), { duration: 0 });
    assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 1);
  } finally {
    useReducedMotion(false);
  }
  overlay.destroy();
});

test("the next crossfade frame clears the gesture fade transition", () => {
  const { map, layers } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  overlay.frame(0, 1, 0);

  map.emit("movestart");
  map.emit("moveend");
  assert.equal(overlay.frame(0, 1, 0.5), true);
  assert.deepEqual(transitionOf(layers, "temperature-isotherms-a-labels"), { duration: 0 });
  overlay.destroy();
});

test("the sources swap roles after the fade ends", () => {
  const { map } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  overlay.frame(0, 1, 0);
  overlay.frame(0, 1, 1);
  overlay.prepareStep(2, [0, 25, 25, 0]);
  overlay.frame(1, 2, 0);

  assert.equal(overlay.holds(0), false);
  assert.equal(overlay.holds(1), true);
  assert.equal(overlay.holds(2), true);
  assert.equal(overlay.frame(1, 2, 0.5), true);
});

test("the fade waits while the hidden source has not loaded", () => {
  const { map, layers, setLoaded } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  setLoaded("temperature-isotherms-b", false);
  assert.equal(overlay.frame(0, 1, 0), true);

  assert.equal(overlay.isReady(0, 1), false);
  const before = opacityOf(layers, "temperature-isotherms-a-lines");
  assert.equal(overlay.frame(0, 1, 0.5), false);
  assert.deepEqual(opacityOf(layers, "temperature-isotherms-a-lines"), before);

  setLoaded("temperature-isotherms-b", true);
  assert.equal(overlay.isReady(0, 1), true);
  assert.equal(overlay.frame(0, 1, 0.5), true);
});

test("a label flip reloading the sources never stalls the fade", () => {
  const { map, layers, setLoaded } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  assert.equal(overlay.frame(0, 1, 0), true);
  assert.equal(overlay.frame(0, 1, 0.3), true);
  assert.equal(overlay.frame(0, 1, 0.6), true);

  setLoaded("temperature-isotherms-a", false);
  setLoaded("temperature-isotherms-b", false);

  assert.equal(overlay.isReady(0, 1), true);
  assert.equal(overlay.frame(0, 1, 0.7), true);
  const outgoing = stopAt(opacityOf(layers, "temperature-isotherms-a-lines"), 0);
  const incoming = stopAt(opacityOf(layers, "temperature-isotherms-b-lines"), 0);
  assert.ok(approximately(outgoing, 0.85 * 0.3));
  assert.ok(approximately(incoming, 0.85 * 0.7));
});

test("a reload after the label flip keeps the fade ready with one source loaded", () => {
  const { map, setLoaded } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  assert.equal(overlay.frame(0, 1, 0), true);
  assert.equal(overlay.frame(0, 1, 0.3), true);
  assert.equal(overlay.frame(0, 1, 0.6), true);

  setLoaded("temperature-isotherms-b", false);
  setLoaded("temperature-isotherms-a", true);

  assert.equal(overlay.isReady(0, 1), true);
});

test("fade frames flip labels by opacity with both sets visible while playing", () => {
  const { map, layers, layoutCalls, layoutOf } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  assert.equal(overlay.frame(0, 1, 0), true);
  overlay.setPlaying(true);
  const calls = layoutCalls();

  assert.equal(overlay.frame(0, 1, 0.25), true);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 1);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-b-labels"), 0);
  assert.equal(layoutCalls(), calls);
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "visible");
  assert.equal(layoutOf("temperature-isotherms-b-labels", "visibility"), "visible");

  assert.equal(overlay.frame(0, 1, 0.75), true);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 0);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-b-labels"), 1);
  assert.equal(layoutCalls(), calls);
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "visible");
  assert.equal(layoutOf("temperature-isotherms-b-labels", "visibility"), "visible");
});

test("play start shows both label sets with overlap and play stop restores paused culling", () => {
  const { map, layers, layoutOf } = fakeMap();
  const overlay = mountOverlay(map);
  const flagOf = (id: string, name: string) =>
    layoutOf(id, name) ?? layers.find((layer) => layer.id === id)!.layout![name];
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  assert.equal(overlay.frame(0, 1, 0), true);

  assert.equal(flagOf("temperature-isotherms-a-labels", "text-allow-overlap"), false);
  assert.equal(flagOf("temperature-isotherms-a-labels", "text-ignore-placement"), false);
  assert.equal(flagOf("temperature-isotherms-b-labels", "text-allow-overlap"), false);
  assert.equal(flagOf("temperature-isotherms-b-labels", "text-ignore-placement"), false);
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "visible");
  assert.equal(layoutOf("temperature-isotherms-b-labels", "visibility"), "none");

  overlay.setPlaying(true);

  assert.equal(layoutOf("temperature-isotherms-a-labels", "text-allow-overlap"), true);
  assert.equal(layoutOf("temperature-isotherms-a-labels", "text-ignore-placement"), true);
  assert.equal(layoutOf("temperature-isotherms-b-labels", "text-allow-overlap"), true);
  assert.equal(layoutOf("temperature-isotherms-b-labels", "text-ignore-placement"), true);
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "visible");
  assert.equal(layoutOf("temperature-isotherms-b-labels", "visibility"), "visible");

  assert.equal(overlay.frame(0, 1, 0.75), true);
  overlay.setPlaying(false);

  assert.equal(layoutOf("temperature-isotherms-a-labels", "text-allow-overlap"), false);
  assert.equal(layoutOf("temperature-isotherms-a-labels", "text-ignore-placement"), false);
  assert.equal(layoutOf("temperature-isotherms-b-labels", "text-allow-overlap"), false);
  assert.equal(layoutOf("temperature-isotherms-b-labels", "text-ignore-placement"), false);
  assert.equal(layoutOf("temperature-isotherms-a-labels", "visibility"), "none");
  assert.equal(layoutOf("temperature-isotherms-b-labels", "visibility"), "visible");
});

test("a failed trace lets the fade move on without it", () => {
  const { map } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.markFailed(1);

  assert.equal(overlay.isReady(0, 1), true);
  assert.equal(overlay.frame(0, 1, 0.5), true);
});

test("equal steps do no work and keep the single set", () => {
  const { map, paintCalls } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  const calls = paintCalls();

  assert.equal(overlay.frame(0, 0, 0.5), true);
  assert.equal(paintCalls(), calls);
  assert.equal(overlay.isReady(0, 0), true);
});

test("a step at minus one fades to and from empty", () => {
  const { map, layers } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);

  assert.equal(overlay.isReady(0, -1), true);
  assert.equal(overlay.frame(0, -1, 0.25), true);
  const faded = stopAt(opacityOf(layers, "temperature-isotherms-a-lines"), 0);
  assert.ok(approximately(faded, 0.85 * 0.75));
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 1);

  assert.equal(overlay.isReady(-1, 0), true);
  assert.equal(overlay.frame(-1, 0, 0.5), true);
  const half = stopAt(opacityOf(layers, "temperature-isotherms-a-lines"), 0);
  assert.ok(approximately(half, 0.85 * 0.5));

  assert.equal(overlay.frame(-1, -1, 0), true);
});

test("scrubbing shows one set at full opacity", () => {
  const { map, layers } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.setValues([0, 20, 20, 0], 1);

  assert.ok(approximately(stopAt(opacityOf(layers, "temperature-isotherms-a-lines"), 0), 0.85));
  assert.ok(approximately(stopAt(opacityOf(layers, "temperature-isotherms-b-lines"), 0), 0));
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-a-labels"), 1);
  assert.equal(labelOpacityOf(layers, "temperature-isotherms-b-labels"), 0);
});

test("reduced motion never sets a partial opacity", () => {
  const { map, layers } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  useReducedMotion(true);

  try {
    assert.equal(overlay.frame(0, 1, 0.75), true);
    assert.ok(approximately(stopAt(opacityOf(layers, "temperature-isotherms-a-lines"), 0), 0.85));
    assert.ok(approximately(stopAt(opacityOf(layers, "temperature-isotherms-b-lines"), 0), 0));
  } finally {
    useReducedMotion(false);
  }
});

test("a settings change mid-fade resets both sources cleanly", () => {
  const { map, layers } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  overlay.frame(0, 1, 0);
  overlay.frame(0, 1, 0.5);
  overlay.setRange([10, 14]);

  assert.equal(overlay.holds(0), false);
  assert.equal(overlay.holds(1), false);
  assert.ok(approximately(stopAt(opacityOf(layers, "temperature-isotherms-a-lines"), 0), 0));
  assert.ok(approximately(stopAt(opacityOf(layers, "temperature-isotherms-b-lines"), 0), 0));
});

test("hiding the overlay resets both sources including mid-fade", () => {
  const { map } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  overlay.frame(0, 1, 0);
  overlay.frame(0, 1, 0.5);
  overlay.setVisible(false);

  assert.equal(overlay.holds(0), false);
  assert.equal(overlay.holds(1), false);
});

test("smoothing change resets the sources but keeps the traced cache", () => {
  const { map } = fakeMap();
  const overlay = mountOverlay(map);
  const values = [0, 30, 0, 30, 0, 30, 0, 30, 0];
  const counted = countingValues(values);
  overlay.setValues(counted.values, 0);
  const reads = counted.reads();
  overlay.setSmooth(false);

  assert.equal(overlay.holds(0), false);
  overlay.setValues(counted.values, 0);
  assert.ok(counted.reads() > reads);
  overlay.setSmooth(true);
  overlay.setValues(counted.values, 0);
  assert.equal(counted.reads(), counted.reads());
});

test("preparing further steps caches without painting new sources", () => {
  const { map } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  overlay.prepareStep(2, [0, 25, 25, 0]);

  assert.equal(overlay.holds(0), true);
  assert.equal(overlay.holds(1), false);
  assert.equal(overlay.holds(2), false);
  assert.equal(overlay.frame(0, 1, 0), true);
  assert.equal(overlay.holds(1), true);
  assert.equal(overlay.holds(2), false);
});

test("preparing the step after next never overwrites the incoming set", () => {
  const { map, dataOf } = fakeMap();
  const overlay = mountOverlay(map);
  overlay.setValues([0, 30, 30, 0], 0);
  overlay.prepareStep(1, [0, 20, 20, 0]);
  overlay.prepareStep(2, [0, 25, 25, 0]);
  overlay.frame(0, 1, 0);
  const incoming = dataOf("temperature-isotherms-b");

  assert.equal(overlay.frame(0, 1, 0.6), true);
  assert.equal(overlay.holds(1), true);
  assert.equal(overlay.holds(2), false);
  assert.deepEqual(dataOf("temperature-isotherms-b"), incoming);
});

test("the trace cache survives a lookahead of further steps", () => {
  const { map } = fakeMap();
  const overlay = mountOverlay(map);
  const values = [0, 30, 0, 30, 0, 30, 0, 30, 0];
  const counted = countingValues(values);
  overlay.setValues(counted.values, 0);
  overlay.prepareStep(1, counted.values);
  overlay.prepareStep(2, counted.values);
  overlay.prepareStep(3, counted.values);
  const preparedReads = counted.reads();

  overlay.setValues(counted.values, 1);

  assert.equal(counted.reads(), preparedReads);
  assert.equal(overlay.holds(1), true);
});

function fakeMap() {
  let data: unknown;
  const datas = new Map<string, unknown>();
  const layers: {
    id: string;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
  }[] = [];
  const sources = new Map<string, unknown>();
  const layouts = new Map<string, Map<string, unknown>>();
  const loaded = new Map<string, boolean>();
  const gestureListeners = new Map<string, Set<() => void>>();
  let paintCalls = 0;
  let layoutCalls = 0;
  const map = {
    addSource(id: string, source: { data: unknown }) {
      data = source.data;
      datas.set(id, source.data);
      sources.set(id, source);
    },
    addLayer(layer: {
      id: string;
      layout?: Record<string, unknown>;
      paint?: Record<string, unknown>;
    }) {
      layers.push(layer);
    },
    getStyle: () => ({ layers: [] }),
    getSource: (id: string) => ({
      setData(next: unknown) {
        data = next;
        datas.set(id, next);
      },
    }),
    isSourceLoaded: (id: string) => loaded.get(id) ?? true,
    setLayoutProperty(id: string, name: string, value: unknown) {
      layoutCalls += 1;
      const entries = layouts.get(id) ?? new Map<string, unknown>();
      entries.set(name, value);
      layouts.set(id, entries);
    },
    setPaintProperty(id: string, name: string, value: unknown) {
      paintCalls += 1;
      layers.find((layer) => layer.id === id)!.paint![name] = value;
    },
    getLayer: () => ({}),
    removeLayer() {},
    removeSource() {},
    on(type: string, listener: () => void) {
      const entries = gestureListeners.get(type) ?? new Set<() => void>();
      entries.add(listener);
      gestureListeners.set(type, entries);
    },
    off(type: string, listener: () => void) {
      gestureListeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of [...(gestureListeners.get(type) ?? [])]) listener();
    },
  };

  return {
    map,
    layers,
    sources,
    layouts,
    data: () => data,
    dataOf: (id: string) => datas.get(id),
    setLoaded: (id: string, isLoaded: boolean) => void loaded.set(id, isLoaded),
    paintCalls: () => paintCalls,
    layoutCalls: () => layoutCalls,
    layoutOf: (id: string, name: string) => layouts.get(id)?.get(name),
  };
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

function mountOverlay(map: unknown) {
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = { map, layer, shift: 0, display: null } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  overlay.setVisible(true);
  return overlay;
}

function opacityOf(
  layers: { id: string; paint?: Record<string, unknown> }[],
  id: string,
): unknown[] {
  return layers.find((layer) => layer.id === id)!.paint!["line-opacity"] as unknown[];
}

function labelOpacityOf(
  layers: { id: string; paint?: Record<string, unknown> }[],
  id: string,
): unknown {
  return layers.find((layer) => layer.id === id)!.paint!["text-opacity"];
}

function transitionOf(
  layers: { id: string; paint?: Record<string, unknown> }[],
  id: string,
): unknown {
  return layers.find((layer) => layer.id === id)!.paint!["text-opacity-transition"];
}

function stopAt(expression: readonly unknown[], zoom: number): number {
  const stops: [number, number][] = [];
  for (let index = 3; index < expression.length; index += 2) {
    stops.push([Number(expression[index]), Number(expression[index + 1])]);
  }

  if (zoom <= stops[0][0]) return stops[0][1];
  for (let index = 1; index < stops.length; index++) {
    const [lowZoom, lowOpacity] = stops[index - 1];
    const [highZoom, highOpacity] = stops[index];
    if (zoom <= highZoom) {
      const along = (zoom - lowZoom) / (highZoom - lowZoom);
      return lowOpacity + (highOpacity - lowOpacity) * along;
    }
  }

  return stops[stops.length - 1][1];
}

function useReducedMotion(matches: boolean) {
  const target = globalThis as unknown as Record<string, unknown>;
  if (matches) {
    target.matchMedia = () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    });
  } else {
    Reflect.deleteProperty(target, "matchMedia");
  }
}
