import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finiteValues,
  isChartType,
  isContinuousShape,
  toDisplayTable,
  type DistributionTable,
  type SeasonalCycleTable,
  type TimeSeriesTable,
} from "./table.ts";

test("only line, bar and area count as chart types", () => {
  assert.equal(isChartType("line"), true);
  assert.equal(isChartType("bar"), true);
  assert.equal(isChartType("area"), true);
  assert.equal(isChartType("pie"), false);
  assert.equal(isChartType("donut"), false);
  assert.equal(isChartType(null), false);
});

test("continuous shapes exclude the reserved categorical shares", () => {
  assert.equal(isContinuousShape("time_series"), true);
  assert.equal(isContinuousShape("seasonal_cycle"), true);
  assert.equal(isContinuousShape("distribution"), true);
  assert.equal(isContinuousShape("categorical_shares"), false);
});

test("time rows keep null gaps while zero and negative values stay valid", () => {
  const table = timeTable();
  const values = finiteValues(table);

  assert.deepEqual(values, [10.123456789012345, 0, -3.75]);
  assert.equal(table.rows[1].value, null);
  assert.equal(table.rows[2].value, 0);
  assert.equal(table.rows[3].value, -3.75);
  assert.deepEqual(
    table.rows.map((row) => row.x),
    [
      Date.parse("2015-01-01"),
      Date.parse("2015-02-01"),
      Date.parse("2015-03-01"),
      Date.parse("2015-04-01"),
    ],
  );
});

test("conversions keep canonical values untouched and use the exact offset", () => {
  const table = timeTable();
  const before = table.rows.map((row) => row.value);
  const converted = toDisplayTable(table, "in/month") as TimeSeriesTable;

  assert.deepEqual(before, [10.123456789012345, null, 0, -3.75]);
  assert.deepEqual(table.rows.map((row) => row.value), before);
  assert.equal(converted.units, "in/month");
  assert.equal(converted.rows[0].value, 10.123456789012345 / 25.4);
  assert.equal(converted.rows[1].value, null);
  assert.equal(converted.rows[2].value, 0);
  assert.equal(converted.rows[3].value, -3.75 / 25.4);
  assert.equal(converted.yTitle, "Rain (in/month)");
  assert.equal(table.units, "mm/month");
  assert.equal(table.yTitle, "Rain (mm/month)");

  converted.rows[0].interval.start = "mutated";
  assert.equal(table.rows[0].interval.start, "2015-01-01");
});

test("temperature conversion keeps full precision without mutating the table", () => {
  const table: TimeSeriesTable = {
    ...timeTable(),
    layerId: "temp",
    units: "°C",
    yTitle: "Temperature (°C)",
    rows: timeTable().rows.map((row) => ({ ...row, interval: { ...row.interval } })),
  };
  const converted = toDisplayTable({ ...table, units: "°C" }, "°F") as TimeSeriesTable;

  assert.equal(converted.rows[0].value, 10.123456789012345 * (9 / 5) + 32);
  assert.equal(converted.rows[3].value, -3.75 * (9 / 5) + 32);
  assert.equal(converted.yTitle, "Temperature (°F)");
  assert.equal(table.rows[0].value, 10.123456789012345);
  assert.equal(table.yTitle, "Temperature (°C)");
});

test("distribution conversion moves mean, median, extremes and sea level together", () => {
  const table = distributionTable();
  const converted = toDisplayTable(table, "ft") as DistributionTable;

  assert.equal(converted.units, "ft");
  assert.equal(converted.min, table.min / 0.3048);
  assert.equal(converted.max, table.max / 0.3048);
  assert.equal(converted.mean, table.mean / 0.3048);
  assert.equal(converted.median, table.median / 0.3048);
  assert.equal(converted.referenceValues[0].value, 0);
  assert.equal(converted.referenceValues[1].value, table.referenceValues[1].value / 0.3048);
  assert.equal(converted.rows[0].value, table.rows[0].value / 0.3048);
  assert.equal(converted.rows[1].value, table.rows[1].value / 0.3048);
  assert.equal(converted.rows[2].value, table.rows[2].value / 0.3048);
  assert.equal(converted.yTitle, "Elevation (ft)");
  assert.equal(table.units, "m");
  assert.equal(table.yTitle, "Elevation (m)");
  assert.equal(table.rows[0].value, 0.123456789);
  assert.equal(table.referenceValues[1].value, 250.678901234);

  converted.referenceValues[1].value = -1;
  converted.rows[1].value = -1;
  assert.equal(table.referenceValues[1].value, 250.678901234);
  assert.equal(table.rows[1].value, 500.123456789);
});

test("seasonal conversion keeps counts and year ranges while converting means", () => {
  const table = seasonalTable();
  const converted = toDisplayTable(table, "in/month") as SeasonalCycleTable;

  assert.equal(converted.rows[0].sampleCount, 2);
  assert.deepEqual(converted.rows[0].yearRange, [2019, 2020]);
  assert.equal(converted.rows[0].value, 10 / 25.4);
  assert.equal(converted.yTitle, "Rain by month (in/month)");
  assert.equal(table.rows[0].value, 10);
  assert.equal(table.yTitle, "Rain by month (mm/month)");

  converted.rows[0].yearRange![0] = 1999;
  assert.deepEqual(table.rows[0].yearRange, [2019, 2020]);
});

test("same-unit copies isolate nested intervals, ranges and references", () => {
  const timeSource = timeTable();
  const time = toDisplayTable(timeSource, "mm/month") as TimeSeriesTable;
  time.rows[0].interval.start = "mutated";
  assert.equal(timeSource.rows[0].interval.start, "2015-01-01");

  const seasonalSource = seasonalTable();
  const seasonal = toDisplayTable(seasonalSource, "mm/month") as SeasonalCycleTable;
  seasonal.rows[0].yearRange![0] = 1999;
  assert.deepEqual(seasonalSource.rows[0].yearRange, [2019, 2020]);

  const distributionSource = distributionTable();
  const distribution = toDisplayTable(distributionSource, "m") as DistributionTable;
  distribution.referenceValues[1].value = -1;
  distribution.rows[1].value = -1;
  assert.equal(distributionSource.referenceValues[1].value, 250.678901234);
  assert.equal(distributionSource.rows[1].value, 500.123456789);
});

test("explicit y-axis titles stay verbatim while generated titles relabel", () => {
  const custom = "Custom threshold (mm/month)";

  const time = toDisplayTable(timeTable(), "in/month", custom) as TimeSeriesTable;
  assert.equal(time.yTitle, custom);
  assert.equal(time.rows[0].value, 10.123456789012345 / 25.4);

  const seasonal = toDisplayTable(seasonalTable(), "in/month", custom) as SeasonalCycleTable;
  assert.equal(seasonal.yTitle, custom);
  assert.equal(seasonal.rows[0].value, 10 / 25.4);

  const distribution = toDisplayTable(distributionTable(), "ft", custom) as DistributionTable;
  assert.equal(distribution.yTitle, custom);
  assert.equal(distribution.rows[0].value, 0.123456789 / 0.3048);

  const sameUnit = toDisplayTable(timeTable(), "mm/month", custom) as TimeSeriesTable;
  assert.equal(sameUnit.yTitle, custom);
  assert.equal(sameUnit.rows[0].value, 10.123456789012345);

  const generatedTime = toDisplayTable(timeTable(), "in/month") as TimeSeriesTable;
  assert.equal(generatedTime.yTitle, "Rain (in/month)");

  const generatedSeasonal = toDisplayTable(seasonalTable(), "in/month") as SeasonalCycleTable;
  assert.equal(generatedSeasonal.yTitle, "Rain by month (in/month)");

  const generatedDistribution = toDisplayTable(distributionTable(), "ft") as DistributionTable;
  assert.equal(generatedDistribution.yTitle, "Elevation (ft)");
});

function timeTable(): TimeSeriesTable {
  return {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: [
      {
        x: Date.parse("2015-01-01"),
        value: 10.123456789012345,
        label: "2015-01-01",
        validFraction: 1,
        fallbackFraction: 0.2,
        interval: { start: "2015-01-01", end: "2015-02-01" },
      },
      {
        x: Date.parse("2015-02-01"),
        value: null,
        label: "2015-02-01",
        validFraction: 0,
        fallbackFraction: 0,
        interval: { start: "2015-02-01", end: "2015-03-01" },
      },
      {
        x: Date.parse("2015-03-01"),
        value: 0,
        label: "2015-03-01",
        validFraction: 0.5,
        fallbackFraction: 0,
        interval: { start: "2015-03-01", end: "2015-04-01" },
      },
      {
        x: Date.parse("2015-04-01"),
        value: -3.75,
        label: "2015-04-01",
        validFraction: 0.7,
        fallbackFraction: 0.1,
        interval: { start: "2015-04-01", end: "2015-05-01" },
      },
    ],
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
}

function seasonalTable(): SeasonalCycleTable {
  return {
    shape: "seasonal_cycle",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: [
      {
        x: 1,
        value: 10,
        label: "Jan",
        validFraction: 0.9,
        fallbackFraction: 0.1,
        sampleCount: 2,
        yearRange: [2019, 2020],
      },
      {
        x: 2,
        value: null,
        label: "Feb",
        validFraction: 0,
        fallbackFraction: 0,
        sampleCount: 0,
        yearRange: null,
      },
    ],
    xTitle: "Month",
    yTitle: "Rain by month (mm/month)",
  };
}

function distributionTable(): DistributionTable {
  return {
    shape: "distribution",
    layerId: "terrain",
    units: "m",
    rows: [
      { x: 0, value: 0.123456789, label: "0%", validFraction: 0.9, fallbackFraction: null },
      { x: 50, value: 500.123456789, label: "50%", validFraction: 0.9, fallbackFraction: null },
      { x: 100, value: 1000.987654321, label: "100%", validFraction: 0.9, fallbackFraction: null },
    ],
    xTitle: "Share of valid area below (%)",
    yTitle: "Elevation (m)",
    validFraction: 0.9,
    mean: 500.123456789,
    median: 400.987654321,
    min: 0.123456789,
    max: 1000.987654321,
    referenceValues: [
      { id: "sea_level", value: 0 },
      { id: "treeline", value: 250.678901234 },
    ],
  };
}
