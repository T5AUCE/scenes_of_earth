import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { Map as MapLibreMap } from "maplibre-gl";

import type { BlendView } from "./layers/blend.ts";
import type { MountedLayer } from "./scene-cards.ts";
import { createSceneStore } from "./scene-store.ts";
import type { LayerDoc, LayerView } from "./types.ts";

const cardsUrl = new URL("./scene-cards.ts", import.meta.url).href;
const sourceRoot = new URL("./", cardsUrl).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".")) {
      if (specifier.endsWith(".ts")) return next(specifier, context);
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { subscribeDrawing } = await import("./scene-cards.ts").finally(() => hooks.deregister());

const RAIN = layer("rain", "Rainfall", ["ramp", "dots", "chroma"]);
const TEMPERATURE = layer("temp", "Temperature", ["ramp", "isolines", "warmth"]);
const LAYERS = [RAIN, TEMPERATURE];

test("the map draws the store's allocation and follows later choices", () => {
  const store = createSceneStore(LAYERS, display());
  const rain = view("rain");
  const temperature = view("temp");
  const changes: string[] = [];
  const map = fakeMap((id, value) => changes.push(`${id}:${value}`));

  const stop = subscribeDrawing(
    map,
    [{ layer: RAIN, view: rain }, { layer: TEMPERATURE, view: temperature }],
    null,
    store,
  );

  assert.deepEqual(rain.shown, ["dots"]);
  assert.deepEqual(temperature.shown, ["colour"]);
  assert.deepEqual(changes, []);

  store.dispatch({ kind: "choose", unit: "rain", draw: "colour" });

  assert.deepEqual(rain.shown, ["dots", "colour"]);
  assert.deepEqual(temperature.shown, ["colour", "isolines"]);

  stop();
  store.dispatch({ kind: "clear", unit: "rain" });
  assert.equal(rain.shown.length, 2);
});

test("switching a part off hides its map layers and shows them again", () => {
  const terrainLayer = layer("terrain", "Terrain", ["shade"], ["contours"]);
  const store = createSceneStore([terrainLayer], display());
  const terrain = view("terrain", ["terrain", "terrain.contours"], false);
  const changes: string[] = [];
  const map = fakeMap((id, value) => changes.push(`${id}:${value}`));
  const mounted = [{ layer: terrainLayer, view: terrain }];

  subscribeDrawing(map, mounted, null, store);
  changes.length = 0;

  store.dispatch({ kind: "toggle", unit: "terrain.contours", on: false });

  assert.deepEqual(changes, [
    "terrain:visible",
    "terrain.contours:none",
  ]);
});

test("the blend follows colour ownership and hides its legend when it stops drawing", () => {
  const store = createSceneStore(LAYERS, display());
  const rain = view("rain");
  const temperature = view("temp");
  const blend = blendView();
  const map = fakeMap(() => {});

  subscribeDrawing(
    map,
    [{ layer: RAIN, view: rain }, { layer: TEMPERATURE, view: temperature }],
    blend,
    store,
  );

  assert.deepEqual(blend.shown, [null]);
  assert.equal(blend.legendElement.hidden, true);

  store.dispatch({ kind: "choose", unit: "blend", draw: "colour" });

  assert.deepEqual(blend.shown, [null, "colour"]);
  assert.equal(blend.legendElement.hidden, false);
});

test("a multi-part master toggle draws each part once", () => {
  const terrainLayer = layer("terrain", "Terrain", ["shade"], ["contours"]);
  const store = createSceneStore([terrainLayer], display());
  const terrain = view("terrain", ["terrain", "terrain.contours"], false);
  const changes: string[] = [];
  const map = fakeMap((id, value) => changes.push(`${id}:${value}`));

  subscribeDrawing(map, [{ layer: terrainLayer, view: terrain }], null, store);
  changes.length = 0;

  store.dispatch({ kind: "toggleMany", units: ["terrain", "terrain.contours"], on: false });

  assert.deepEqual(changes, ["terrain:none", "terrain.contours:none"]);
});

test("the blend restyles only when its ranges change", () => {
  const store = createSceneStore(LAYERS, display());
  const rain = view("rain");
  const temperature = view("temp");
  let restyles = 0;
  const blend = { ...blendView(), restyle: () => restyles++ };
  const map = fakeMap(() => {});

  subscribeDrawing(
    map,
    [{ layer: RAIN, view: rain }, { layer: TEMPERATURE, view: temperature }],
    blend,
    store,
  );
  restyles = 0;

  store.dispatch({ kind: "toggle", unit: "rain", on: false });
  assert.equal(restyles, 0);

  store.dispatch({
    kind: "display",
    update: (next) => {
      next.layers.rain = { range: [0, 5] };
    },
  });
  assert.equal(restyles, 1);

  store.dispatch({
    kind: "display",
    update: (next) => {
      next.layers.rain = { range: [0, 5] };
    },
  });
  assert.equal(restyles, 1);
});

function display() {
  return { layers: {}, off: new Set<string>(), showAs: {} };
}

function layer(
  id: string,
  title: string,
  encodings: string[],
  parts: string[] = [],
): LayerDoc {
  return {
    id,
    title,
    units: "",
    style: { kind: "field", encodings, parts },
  } as unknown as LayerDoc;
}

interface TestView extends LayerView {
  shown: (string | null)[];
}

function view(id: string, parts: string[] = [id], usesShow = true): TestView {
  const shown: (string | null)[] = [];

  return {
    parts: parts.map((part) => ({ id: part, label: part, layerIds: [part] })),
    options: [],
    time: null,
    shown,
    ...(usesShow && { show: (draw: string | null) => shown.push(draw) }),
    setTime: () => {},
    legend: () => null,
    destroy: () => {},
  };
}

function blendView(): BlendView & { shown: (string | null)[]; legendElement: HTMLElement } {
  const shown: (string | null)[] = [];
  const legendElement = { hidden: false } as HTMLElement;

  return {
    parts: [{ id: "blend", label: "Blend", layerIds: ["blend"] }],
    options: [],
    time: null,
    shown,
    legendElement,
    show: (draw) => shown.push(draw),
    restyle: () => {},
    setTime: () => {},
    legend: () => legendElement,
    destroy: () => {},
  };
}

function fakeMap(onVisibility: (id: string, value: string) => void): MapLibreMap {
  return {
    setLayoutProperty: (id: string, _name: string, value: string) => onVisibility(id, value),
  } as unknown as MapLibreMap;
}
