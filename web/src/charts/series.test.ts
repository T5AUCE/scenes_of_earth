import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDistributionTable,
  buildSeasonalCycle,
  buildTimeSeries,
  isDistributionLayer,
  isSeasonalEligible,
  isTimeSeriesLayer,
  MONTH_LABELS,
  rowAtTime,
  SEASONAL_MIN_STEPS,
  shapesForLayer,
  unionIntervals,
} from "./series.ts";
import type { LayerDoc } from "../types.ts";

test("monthly layers need two full years before By month is offered", () => {
  assert.equal(SEASONAL_MIN_STEPS, 24);
  assert.equal(isSeasonalEligible(monthlyLayer(24)), true);
  assert.equal(isSeasonalEligible(monthlyLayer(23)), false);
  assert.equal(isSeasonalEligible(yearlyLayer()), false);
  assert.equal(isSeasonalEligible(staticLayer()), false);
});

test("shapes follow stored blocks rather than renderer kinds or dataset ids", () => {
  assert.deepEqual(shapesForLayer(monthlyLayer(30)), ["time_series", "seasonal_cycle"]);
  assert.deepEqual(shapesForLayer(yearlyLayer()), ["time_series"]);
  assert.deepEqual(shapesForLayer(terrainLayer()), ["distribution"]);
  assert.deepEqual(shapesForLayer(categoricalLayer()), []);
});

test("time tables keep unionable intervals with null gaps and zero values", () => {
  const table = buildTimeSeries(monthlyLayer(30));

  assert.equal(table.rows.length, 30);
  assert.equal(table.rows[0].interval.start, "2019-01-01");
  assert.equal(table.rows[0].interval.end, "2019-02-01");
  assert.equal(table.rows[29].interval.end, "2021-07-01");
  assert.equal(table.method, "sum");
  assert.ok(table.rows.some((row) => row.value === null));
  assert.ok(table.rows.some((row) => row.value === 0));
  assert.ok(table.rows.some((row) => typeof row.value === "number" && row.value < 0));
  assert.equal(table.units, "mm/month");
  assert.equal(table.rows[0].x, Date.parse("2019-01-01"));
  assert.equal(table.rows[1].x, Date.parse("2019-02-01"));
});

test("seasonal tables average finite yearly means with counts and year ranges", () => {
  const table = buildSeasonalCycle(seasonalLayer());

  assert.equal(table.rows.length, 12);
  assert.deepEqual(table.rows.map((row) => row.x), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(table.rows.map((row) => row.label), MONTH_LABELS);

  const january = table.rows[0];
  assert.equal(january.value, 15);
  assert.equal(january.sampleCount, 2);
  assert.deepEqual(january.yearRange, [2019, 2020]);
  assert.ok(Math.abs(january.validFraction - 0.85) < 1e-12);
  assert.ok(Math.abs((january.fallbackFraction ?? 0) - 0.05) < 1e-12);

  const february = table.rows[1];
  assert.equal(february.value, null);
  assert.equal(february.sampleCount, 0);
  assert.equal(february.yearRange, null);
  assert.equal(february.validFraction, 0);
});

test("seasonal averaging never sums and skips all-missing years", () => {
  const table = buildSeasonalCycle(seasonalLayer());

  assert.equal(table.rows[2].value, 40);
  assert.equal(table.rows[2].sampleCount, 1);
  assert.deepEqual(table.rows[2].yearRange, [2020, 2020]);
});

test("seasonal averaging keeps zero and negative means without fallback shares", () => {
  const layer = {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"] },
    time: {
      step: "P1M",
      values: ["2019-01-01", "2019-02-01", "2020-01-01", "2020-02-01"],
      end: "2020-03-01",
      method: "sum",
    },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: [0, null, -10, null],
      valid_fraction: [1, 0, 1, 0],
    },
  } as unknown as LayerDoc;
  const table = buildSeasonalCycle(layer);

  assert.equal(table.rows[0].value, -5);
  assert.equal(table.rows[0].sampleCount, 2);
  assert.equal(table.rows[0].fallbackFraction, null);
  assert.equal(table.rows[1].value, null);
  assert.equal(table.rows[1].fallbackFraction, null);
});

test("union intervals never invent a common period for unlike layers", () => {
  const monthly = monthlyLayer(24);
  const other = {
    ...monthlyLayer(12),
    id: "other",
    time: { step: "P1M", values: ["2021-01-01", "2021-02-01"], end: "2021-03-01" },
  } as unknown as LayerDoc;
  const intervals = unionIntervals([monthly, other, terrainLayer()]);

  assert.ok(intervals.length > 0);
  assert.deepEqual(intervals[0], { start: "2019-01-01", end: "2019-02-01" });
  assert.ok(intervals.some(({ start }) => start === "2021-01-01"));
  assert.equal(new Set(intervals.map(({ start }) => start)).size, intervals.length);
});

test("distribution tables keep exact summaries and sea-level references", () => {
  const table = buildDistributionTable(terrainLayer());

  assert.equal(table.rows.length, 101);
  assert.equal(table.rows[0].x, 0);
  assert.equal(table.rows[100].x, 100);
  assert.equal(table.rows[50].value, 500);
  assert.equal(table.median, 500);
  assert.equal(table.min, 0);
  assert.equal(table.max, 1000);
  assert.equal(table.mean, 500);
  assert.deepEqual(table.referenceValues, [{ id: "sea_level", value: 0 }]);
});

test("union keeps unlike ends for identical starts and drops exact duplicates", () => {
  const first = {
    ...monthlyLayer(2),
    id: "first",
    time: { step: "P1M", values: ["2019-01-01", "2019-02-01"], end: "2019-03-01" },
  } as unknown as LayerDoc;
  const second = {
    ...monthlyLayer(1),
    id: "second",
    time: { step: "P1M", values: ["2019-01-01"], end: "2019-01-15" },
  } as unknown as LayerDoc;
  const duplicate = {
    ...monthlyLayer(2),
    id: "duplicate",
    time: { step: "P1M", values: ["2019-01-01", "2019-02-01"], end: "2019-03-01" },
  } as unknown as LayerDoc;
  const intervals = unionIntervals([first, second, duplicate]);

  assert.deepEqual(intervals, [
    { start: "2019-01-01", end: "2019-01-15" },
    { start: "2019-01-01", end: "2019-02-01" },
    { start: "2019-02-01", end: "2019-03-01" },
  ]);
});

test("a union time maps to each layer's covering interval without future values", () => {
  const table = buildTimeSeries(monthlyLayer(24));

  assert.equal(rowAtTime(table, "2018-12-01"), null);
  assert.equal(rowAtTime(table, "2019-01-01")?.interval.start, "2019-01-01");
  assert.equal(rowAtTime(table, "2019-01-15")?.interval.start, "2019-01-01");
  assert.equal(rowAtTime(table, "2019-02-01")?.interval.start, "2019-02-01");
  assert.equal(rowAtTime(table, "2021-07-01"), null);
});

function monthlyLayer(count: number) {
  const values = Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2019, index, 1));
    return date.toISOString().slice(0, 10);
  });

  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1M", values, end: "2021-07-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map((_, index) => (index % 7 === 0 ? null : index % 5 === 0 ? 0 : index - 10)),
      valid_fraction: values.map(() => 1),
      fallback_fraction: values.map(() => 0),
    },
  } as unknown as LayerDoc;
}

function yearlyLayer() {
  return {
    id: "yearly",
    title: "Yearly",
    units: "°C",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1Y", values: ["2019-01-01", "2020-01-01"], end: "2021-01-01", method: "mean" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: [10, 12],
      valid_fraction: [1, 1],
    },
  } as unknown as LayerDoc;
}

function staticLayer() {
  return {
    id: "static",
    title: "Static",
    units: "m",
    style: { kind: "field", encodings: ["ramp"] },
    time: null,
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
      reference_values: [{ id: "sea_level", value: 0 }],
    },
  } as unknown as LayerDoc;
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

function seasonalLayer() {
  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"] },
    time: {
      step: "P1M",
      values: ["2019-01-01", "2019-02-01", "2019-03-01", "2020-01-01", "2020-02-01", "2020-03-01"],
      end: "2020-04-01",
      method: "sum",
    },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: [10, null, null, 20, null, 40],
      valid_fraction: [0.8, 0, 0, 0.9, 0, 0.9],
      fallback_fraction: [0, 0, 0, 0.1, 0, 0.1],
    },
  } as unknown as LayerDoc;
}
