import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowedTypesFor,
  creationAvailability,
  defaultChartTypeFor,
  defaultDefinitions,
  defaultOptionsFor,
  hintFor,
  isSupportedShape,
  MAX_DEFINITIONS,
  MAX_TITLE_CHARS,
  newChartId,
  resolveMainId,
  unavailableTemplates,
  validateDefinition,
  type ChartDefinition,
} from "./definitions.ts";
import type { LayerDoc } from "../types.ts";

test("only the three continuous shapes can be saved", () => {
  assert.equal(isSupportedShape("time_series"), true);
  assert.equal(isSupportedShape("seasonal_cycle"), true);
  assert.equal(isSupportedShape("distribution"), true);
  assert.equal(isSupportedShape("categorical_shares"), false);
  assert.equal(isSupportedShape("pie"), false);
});

test("defaults follow the period method and hypsometry uses area", () => {
  assert.equal(defaultChartTypeFor("time_series", "sum"), "bar");
  assert.equal(defaultChartTypeFor("time_series", "mean"), "line");
  assert.equal(defaultChartTypeFor("seasonal_cycle", "sum"), "bar");
  assert.equal(defaultChartTypeFor("seasonal_cycle", "mean"), "line");
  assert.equal(defaultChartTypeFor("distribution", "sum"), "area");
  assert.equal(defaultChartTypeFor("distribution", null), "area");
});

test("every continuous shape allows line, bar and area with hints instead of hiding", () => {
  for (const shape of ["time_series", "seasonal_cycle", "distribution"] as const) {
    assert.deepEqual(allowedTypesFor(shape), ["line", "bar", "area"]);
  }
  assert.deepEqual(allowedTypesFor("categorical_shares"), []);
});

test("hints explain quantile bars, offset fills and dense bars", () => {
  assert.ok((hintFor("distribution", "bar", "m", 10) ?? "").includes("quantile"));
  assert.equal(hintFor("distribution", "area", "m", 10), null);
  assert.ok((hintFor("time_series", "area", "°C", 10) ?? "").includes("zero"));
  assert.equal(hintFor("time_series", "line", "°C", 10), null);
  assert.ok((hintFor("time_series", "bar", "mm/month", 61) ?? "").includes("line"));
  assert.equal(hintFor("time_series", "bar", "mm/month", 60), null);
  assert.equal(hintFor("time_series", "line", "mm/month", 61), null);
  assert.equal(hintFor("time_series", "area", "mm/month", 61), null);
  assert.equal(hintFor("distribution", "area", "m", 61), null);
});

test("defaults use metadata rather than hard-coded dataset ids", () => {
  const layers = [rainLayer(), tempLayer(), terrainLayer()];
  const defaults = defaultDefinitions(layers);

  assert.equal(defaults.length, 3);
  assert.deepEqual(defaults.map((definition) => definition.source.shape), [
    "time_series",
    "time_series",
    "distribution",
  ]);
  assert.deepEqual(defaults.map((definition) => definition.chartType), ["bar", "line", "area"]);
  assert.deepEqual(
    defaults.map((definition) => definition.id),
    ["rain:time_series", "temp:time_series", "terrain:distribution"],
  );
  assert.equal(MAX_DEFINITIONS, 32);
  assert.equal(MAX_TITLE_CHARS, 120);
});

test("unavailable templates explain missing sources without fabricated numbers", () => {
  const rainOnly = unavailableTemplates([rainLayer()]);
  assert.deepEqual(
    rainOnly.map((template) => template.title),
    ["No temperature series", "No elevation distribution"],
  );

  const tempOnly = unavailableTemplates([tempLayer()]);
  assert.deepEqual(
    tempOnly.map((template) => template.title),
    ["No rainfall accumulation", "No elevation distribution"],
  );

  const rainTerrain = unavailableTemplates([rainLayer(), terrainLayer()]);
  assert.deepEqual(
    rainTerrain.map((template) => template.title),
    ["No temperature series"],
  );

  const empty = unavailableTemplates([]);
  assert.deepEqual(
    empty.map((template) => template.title),
    ["No rainfall accumulation", "No temperature series", "No elevation distribution"],
  );

  for (const template of empty) {
    assert.ok(template.reason.length > 0);
    assert.equal("source" in template, false);
  }
});

test("creation is disabled with a reason when no layer is chartable", () => {
  assert.equal(creationAvailability([rainLayer()]).allowed, true);
  assert.equal(creationAvailability([rainLayer()]).reason, null);
  assert.equal(creationAvailability([]).allowed, false);
  assert.ok((creationAvailability([]).reason ?? "").length > 0);
  assert.equal(creationAvailability([categoricalLayer()]).allowed, false);
});

test("the main chart prefers rainfall and falls back deterministically", () => {
  const layers = [rainLayer(), tempLayer()];
  const defaults = defaultDefinitions(layers);

  assert.equal(resolveMainId(defaults, null, layers), "rain:time_series");
  assert.equal(resolveMainId(defaults, "temp:time_series", layers), "temp:time_series");
  assert.equal(resolveMainId(defaults, "missing", layers), "rain:time_series");
  assert.equal(resolveMainId([], null, layers), null);
  const tempOnly = defaultDefinitions([tempLayer()]);
  assert.equal(resolveMainId(tempOnly, null, [tempLayer()]), "temp:time_series");

  const reversed = [defaults[1], defaults[0]];
  assert.equal(resolveMainId(reversed, null, layers), "rain:time_series");
  assert.equal(resolveMainId(reversed, "missing", layers), "temp:time_series");
});

test("fresh ids avoid collisions deterministically", () => {
  const values = [0.123456789, 0.123456789, 0.987654321];
  const original = Math.random;
  let index = 0;
  Math.random = () => values[index++ % values.length];
  try {
    const first = newChartId([]);

    assert.ok(first.length > 0);
    const second = newChartId([first]);

    assert.ok(second.length > 0);
    assert.notEqual(second, first);
  } finally {
    Math.random = original;
  }
});

test("validation rejects unknown layers, shapes, types and bad options", () => {
  const layers = [rainLayer(), terrainLayer()];
  const valid = {
    id: "rain:time_series",
    title: "Rain over time",
    source: { layerId: "rain", shape: "time_series" },
    chartType: "bar",
    options: defaultOptionsFor(),
  } as ChartDefinition;
  assert.equal(validateDefinition(valid, layers), null);

  const missingLayer = { ...valid, source: { layerId: "nowhere", shape: "time_series" } };
  assert.ok((validateDefinition(missingLayer, layers) ?? "").includes("missing"));

  const badShape = { ...valid, source: { layerId: "rain", shape: "categorical_shares" } };
  assert.ok((validateDefinition(badShape, layers) ?? "").includes("shape"));

  const badType = { ...valid, chartType: "pie" };
  assert.ok((validateDefinition(badType, layers) ?? "").includes("type"));

  const seasonalOnYearly = {
    ...valid,
    source: { layerId: "rain", shape: "seasonal_cycle" },
  };
  assert.ok((validateDefinition(seasonalOnYearly, [shortRainLayer()]) ?? "").includes("24"));

  const badInk = { ...valid, options: { ...valid.options, ink: "pink" } };
  assert.ok((validateDefinition(badInk, layers) ?? "").includes("ink"));

  const arrayInk = { ...valid, options: { ...valid.options, ink: ["#123456"] } };
  assert.ok((validateDefinition(arrayInk, layers) ?? "").includes("ink"));

  const hostileInk = {
    ...valid,
    options: { ...valid.options, ink: { toString: null } as unknown as string },
  };
  assert.ok((validateDefinition(hostileInk, layers) ?? "").includes("ink"));

  const nullOptions = { ...valid, options: null };
  assert.ok((validateDefinition(nullOptions, layers) ?? "").includes("options"));

  const arrayOptions = { ...valid, options: [] };
  assert.ok((validateDefinition(arrayOptions, layers) ?? "").includes("options"));

  const { options: _dropped, ...missingOptions } = valid;
  assert.ok((validateDefinition(missingOptions, layers) ?? "").includes("options"));

  const arrayDefinition = [] as unknown as ChartDefinition;
  assert.ok((validateDefinition(arrayDefinition, layers) ?? "").includes("object"));

  const badUnit = { ...valid, options: { ...valid.options, displayUnit: "°F" } };
  assert.ok((validateDefinition(badUnit, layers) ?? "").includes("display unit"));

  const longTitle = { ...valid, title: "x".repeat(MAX_TITLE_CHARS + 1) };
  assert.ok((validateDefinition(longTitle, layers) ?? "").includes("too long"));

  const clippingRange = { ...valid, options: { ...valid.options, yRange: [10, 100] } };
  assert.ok((validateDefinition(clippingRange, layers) ?? "").includes("baseline"));
});

test("ranges stay in canonical units through display-unit switches", () => {
  const layers = [rainLayer()];
  const valid = {
    id: "rain:time_series",
    title: "Rain over time",
    source: { layerId: "rain", shape: "time_series" },
    chartType: "bar",
    options: { ...defaultOptionsFor(), displayUnit: "in/month", yRange: [0, 100] },
  } as ChartDefinition;

  assert.equal(validateDefinition(valid, layers), null);

  const clipped = {
    ...valid,
    options: { ...valid.options, yRange: [10, 100] as [number, number] },
  };
  assert.ok((validateDefinition(clipped, layers) ?? "").includes("baseline"));
});

test("no-table validation uses canonical bounds and references", () => {
  const negativeLayers = [negativeRainLayer()];
  const negativeBar = {
    id: "rain:time_series",
    title: "Rain over time",
    source: { layerId: "rain", shape: "time_series" },
    chartType: "bar",
    options: { ...defaultOptionsFor(), yRange: [0, 100] as [number, number] },
  } as ChartDefinition;
  assert.ok((validateDefinition(negativeBar, negativeLayers) ?? "").includes("observed"));

  const negativeLine = {
    ...negativeBar,
    chartType: "line" as const,
    options: { ...defaultOptionsFor(), yRange: [10, 20] as [number, number] },
  } as ChartDefinition;
  assert.ok((validateDefinition(negativeLine, negativeLayers) ?? "").includes("observed"));

  const negativeAreaFit = {
    ...negativeBar,
    chartType: "area" as const,
    options: {
      ...defaultOptionsFor(),
      yRange: [-5, 20] as [number, number],
    },
  } as ChartDefinition;
  assert.equal(validateDefinition(negativeAreaFit, negativeLayers), null);

  const negativeAreaClipped = {
    ...negativeBar,
    chartType: "area" as const,
    options: {
      ...defaultOptionsFor(),
      yRange: [0, 20] as [number, number],
    },
  } as ChartDefinition;
  assert.ok((validateDefinition(negativeAreaClipped, negativeLayers) ?? "").includes("baseline"));

  const terrainLayers = [terrainWithSeaLevel()];
  const shown = {
    id: "terrain:distribution",
    title: "Terrain distribution",
    source: { layerId: "terrain", shape: "distribution" },
    chartType: "line" as const,
    options: {
      ...defaultOptionsFor(),
      showReferences: true,
      yRange: [200, 300] as [number, number],
    },
  } as ChartDefinition;
  assert.ok((validateDefinition(shown, terrainLayers) ?? "").includes("observed"));

  const hidden = {
    ...shown,
    options: {
      ...defaultOptionsFor(),
      showReferences: false,
      yRange: [200, 300] as [number, number],
    },
  } as ChartDefinition;
  assert.ok((validateDefinition(hidden, terrainLayers) ?? "").includes("observed"));

  const fitting = {
    ...shown,
    options: {
      ...defaultOptionsFor(),
      showReferences: true,
      yRange: [0, 1000] as [number, number],
    },
  } as ChartDefinition;
  assert.equal(validateDefinition(fitting, terrainLayers), null);

  const positiveLayers = [positiveTerrainWithSeaLevel()];
  const positiveShown = {
    id: "terrain:distribution",
    title: "Terrain distribution",
    source: { layerId: "terrain", shape: "distribution" },
    chartType: "line" as const,
    options: {
      ...defaultOptionsFor(),
      showReferences: true,
      yRange: [100, 1000] as [number, number],
    },
  } as ChartDefinition;
  assert.ok((validateDefinition(positiveShown, positiveLayers) ?? "").includes("visible"));

  const positiveHidden = {
    ...positiveShown,
    options: {
      ...defaultOptionsFor(),
      showReferences: false,
      yRange: [100, 1000] as [number, number],
    },
  } as ChartDefinition;
  assert.equal(validateDefinition(positiveHidden, positiveLayers), null);
});

function rainLayer() {
  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1M", values: monthlyValues(30), end: "2021-07-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: monthlyValues(30).map(() => 10),
      valid_fraction: monthlyValues(30).map(() => 1),
    },
  } as unknown as LayerDoc;
}

function shortRainLayer() {
  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1M", values: monthlyValues(6), end: "2019-07-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: monthlyValues(6).map(() => 10),
      valid_fraction: monthlyValues(6).map(() => 1),
    },
  } as unknown as LayerDoc;
}

function tempLayer() {
  return {
    id: "temp",
    title: "Temperature",
    units: "°C",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1M", values: monthlyValues(30), end: "2021-07-01", method: "mean" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: monthlyValues(30).map(() => 20),
      valid_fraction: monthlyValues(30).map(() => 1),
    },
  } as unknown as LayerDoc;
}

function terrainLayer() {
  return {
    id: "terrain",
    title: "Terrain",
    units: "m",
    style: { kind: "terrain", encodings: ["shade"] },
    grid: { res: 0.000833333333333 },
    time: null,
    distribution: {
      statistic: "quantiles",
      weights: "cell_area_inside_outline",
      percent: 1,
      values: Array.from({ length: 101 }, (_, index) => index * 10),
      min: 0,
      max: 1000,
      mean: 500,
      valid_fraction: 0.9,
      reference_values: [],
    },
  } as unknown as LayerDoc;
}

function negativeRainLayer() {
  const values = monthlyValues(30);

  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1M", values, end: "2021-07-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map((_, index) => (index === 0 ? -5 : 10)),
      valid_fraction: values.map(() => 1),
    },
  } as unknown as LayerDoc;
}

function terrainWithSeaLevel() {
  const layer = terrainLayer() as unknown as {
    distribution: { reference_values: { id: string; value: number }[]; mean: number };
  };
  layer.distribution.reference_values = [{ id: "sea_level", value: 0 }];
  layer.distribution.mean = 400;

  return layer as unknown as LayerDoc;
}

function positiveTerrainWithSeaLevel() {
  const layer = terrainLayer() as unknown as {
    distribution: {
      values: number[];
      min: number;
      max: number;
      mean: number;
      reference_values: { id: string; value: number }[];
    };
  };
  layer.distribution.values = Array.from({ length: 101 }, (_, index) => 100 + index * 9);
  layer.distribution.min = 100;
  layer.distribution.max = 1000;
  layer.distribution.mean = 500;
  layer.distribution.reference_values = [{ id: "sea_level", value: 0 }];

  return layer as unknown as LayerDoc;
}

function categoricalLayer() {
  return {
    id: "landcover",
    title: "Land cover",
    units: "class",
    style: { kind: "categorical", encodings: ["fill"] },
    time: null,
  } as unknown as LayerDoc;
}

function monthlyValues(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2019, index, 1));
    return date.toISOString().slice(0, 10);
  });
}
