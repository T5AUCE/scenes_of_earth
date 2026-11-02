import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autoDomain,
  baselineFor,
  densityHint,
  DENSITY_HINT_THRESHOLD,
  domainIncludes,
  offsetFillWarning,
  quantileBarHint,
  ticksForDomain,
  validateYRange,
} from "./ticks.ts";
import type { DistributionTable, TimeSeriesTable } from "./table.ts";

test("bars anchor at zero while filled areas include negative minima", () => {
  assert.equal(DENSITY_HINT_THRESHOLD, 60);
  assert.equal(baselineFor("bar", 10), 0);
  assert.equal(baselineFor("bar", null), 0);
  assert.equal(baselineFor("area", 10), 0);
  assert.equal(baselineFor("area", -5), -5);
  assert.equal(baselineFor("area", null), 0);
  assert.equal(baselineFor("line", 10), null);
});

test("automatic domains include baselines and sea level without rounding", () => {
  const time = timeTable();
  assert.deepEqual(autoDomain(time, "bar"), [0, 20.5]);
  assert.deepEqual(autoDomain(time, "line"), [5.25, 20.5]);
  assert.deepEqual(autoDomain(distributionTable(), "area"), [0, 1000]);

  const empty = { ...time, rows: time.rows.map((row) => ({ ...row, value: null })) };
  assert.equal(autoDomain(empty, "line"), null);
});

test("explicit ranges must stay finite, increasing and wide enough for baselines", () => {
  const time = timeTable();
  assert.equal(validateYRange(null, time, "line"), null);
  assert.equal(validateYRange([0, 100], time, "bar"), null);
  assert.ok(validateYRange([10, 100], time, "bar")?.includes("baseline"));
  assert.ok(validateYRange([5, 5], time, "line")?.includes("low end"));
  assert.ok(validateYRange([0, Number.NaN], time, "line")?.includes("finite"));
  assert.ok(validateYRange("0:100", time, "line")?.includes("low and high"));
});

test("ranges that clip visible sea level are rejected", () => {
  const table = distributionTable();
  const seaLevel = [{ id: "sea_level", value: 0 }];

  assert.equal(validateYRange([0, 1000], table, "area", seaLevel), null);
  assert.ok(validateYRange([10, 1000], table, "area", seaLevel)?.includes("baseline"));
  assert.equal(validateYRange([10, 1000], table, "line", []), null);
  assert.ok(validateYRange([10, 1000], table, "line", seaLevel)?.includes("references"));
});

test("ranges that include baselines but clip observations are rejected", () => {
  const time = timeTable();

  assert.equal(validateYRange([5.25, 20.5], time, "line"), null);
  assert.ok(validateYRange([10, 20], time, "line")?.includes("observed"));
  assert.ok(validateYRange([0, 10], time, "bar")?.includes("observed"));

  const negative = negativeTable();

  assert.equal(validateYRange([-5, 100], negative, "line"), null);
  assert.ok(validateYRange([10, 20], negative, "line")?.includes("observed"));
  assert.ok(validateYRange([0, 50], negative, "bar")?.includes("observed"));
  assert.ok(validateYRange([-5, 50], negative, "area")?.includes("observed"));

  const distribution = distributionTable();

  assert.equal(validateYRange([0, 1000], distribution, "line", []), null);
  assert.ok(validateYRange([200, 300], distribution, "line", [])?.includes("observed"));
  assert.ok(validateYRange([0, 500], distribution, "area", [])?.includes("observed"));
});

test("ticks keep both ends and stay in canonical precision", () => {
  assert.deepEqual(ticksForDomain([0, 100], 3), [0, 50, 100]);
  assert.deepEqual(ticksForDomain([5.25, 20.5], 2), [5.25, 20.5]);
  assert.deepEqual(ticksForDomain([7, 7], 5), [7]);
});

test("density, offset and quantile hints explain without switching types", () => {
  assert.equal(densityHint(60), null);
  assert.ok((densityHint(61) ?? "").includes("line"));
  assert.equal(offsetFillWarning("mm/month", "area"), null);
  assert.ok((offsetFillWarning("°C", "area") ?? "").includes("zero"));
  assert.equal(offsetFillWarning("°C", "line"), null);
  assert.ok((quantileBarHint("distribution", "bar") ?? "").includes("quantile"));
  assert.equal(quantileBarHint("distribution", "area"), null);
  assert.equal(quantileBarHint("time_series", "bar"), null);
});

test("domain helpers treat endpoints as included", () => {
  assert.equal(domainIncludes([0, 10], 0), true);
  assert.equal(domainIncludes([0, 10], 10), true);
  assert.equal(domainIncludes([0, 10], -0.1), false);
});

function timeTable(): TimeSeriesTable {
  return {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: [
      {
        x: 0,
        value: 5.25,
        label: "2019-01-01",
        validFraction: 1,
        fallbackFraction: null,
        interval: { start: "2019-01-01", end: "2019-02-01" },
      },
      {
        x: 1,
        value: 20.5,
        label: "2019-02-01",
        validFraction: 1,
        fallbackFraction: null,
        interval: { start: "2019-02-01", end: "2019-03-01" },
      },
    ],
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
}

function distributionTable(): DistributionTable {
  return {
    shape: "distribution",
    layerId: "terrain",
    units: "m",
    rows: [
      { x: 0, value: 100, label: "0%", validFraction: 1, fallbackFraction: null },
      { x: 100, value: 1000, label: "100%", validFraction: 1, fallbackFraction: null },
    ],
    xTitle: "Share of valid area below (%)",
    yTitle: "Elevation (m)",
    validFraction: 1,
    mean: 500,
    median: 500,
    min: 100,
    max: 1000,
    referenceValues: [{ id: "sea_level", value: 0 }],
  };
}

function negativeTable(): TimeSeriesTable {
  const base = timeTable();

  return {
    ...base,
    rows: [
      {
        x: 0,
        value: -5,
        label: "2019-01-01",
        validFraction: 1,
        fallbackFraction: null,
        interval: { start: "2019-01-01", end: "2019-02-01" },
      },
      {
        x: 1,
        value: 0,
        label: "2019-02-01",
        validFraction: 1,
        fallbackFraction: null,
        interval: { start: "2019-02-01", end: "2019-03-01" },
      },
      {
        x: 2,
        value: 100,
        label: "2019-03-01",
        validFraction: 1,
        fallbackFraction: null,
        interval: { start: "2019-03-01", end: "2019-04-01" },
      },
    ],
  };
}
