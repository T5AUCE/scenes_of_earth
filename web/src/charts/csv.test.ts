import assert from "node:assert/strict";
import { test } from "node:test";

import type { LayerDoc, Scene } from "../types.ts";
import { buildSeasonalCycle } from "./series.ts";
import {
  areaMeansFilename,
  buildAreaMeansCsv,
  buildByMonthCsv,
  buildElevationCsv,
  byMonthFilename,
  elevationFilename,
  escapeCsvCell,
  formatCsvValue,
  titleSlug,
} from "./csv.ts";

test("csv cells quote commas, quotes and newlines by doubling quotes", () => {
  assert.equal(escapeCsvCell("plain"), "plain");
  assert.equal(escapeCsvCell("a,b"), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell("first\nsecond"), '"first\nsecond"');
  assert.equal(escapeCsvCell("a\rb"), '"a\rb"');
});

test("csv values keep exact numbers while missing values stay empty", () => {
  assert.equal(formatCsvValue(0.3333333333333333), "0.3333333333333333");
  assert.equal(formatCsvValue(0), "0");
  assert.equal(formatCsvValue(-5.5), "-5.5");
  assert.equal(formatCsvValue(null), "");
  assert.equal(formatCsvValue(undefined), "");
  assert.equal(formatCsvValue(Number.NaN), "");
});

test("csv documents use CRLF and prefix every metadata physical line", () => {
  const file = buildAreaMeansCsv(makeScene([rainLayer()]));

  assert.ok(file.content.endsWith("\r\n"));
  assert.equal(file.content.includes("\n") && !file.content.includes("\r\n"), false);
  const lines = file.content.split("\r\n").slice(0, -1);
  const headerIndex = lines.findIndex((line) => line.startsWith("period_start,"));
  assert.ok(headerIndex > 0);
  for (const line of lines.slice(0, headerIndex)) assert.ok(line.startsWith("# "));
  for (const line of lines.slice(headerIndex)) assert.equal(line.startsWith("# "), false);
});

test("area csv writes exact numbers with empty cells for missing steps", () => {
  const file = buildAreaMeansCsv(makeScene([gappyLayer()]));
  const rows = dataRows(file.content);

  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes("0.3333333333333333"));
  assert.ok(rows[1].includes(",,") || rows[1].endsWith(","));
  assert.ok(rows[2].includes(",0,"));
});

test("area csv headers keep source units instead of display units", () => {
  const file = buildAreaMeansCsv(makeScene([rainLayer(), tempLayer()]));
  const header = file.content.split("\r\n").find((line) => line.startsWith("period_start,"))!;

  assert.ok(header.includes("rain_mean [mm/month]"));
  assert.ok(header.includes("temp_mean [°C]"));
  assert.equal(header.includes("in/month"), false);
  assert.equal(header.includes("°F"), false);
});

test("area csv unions distinct intervals without inventing a common period", () => {
  const rain = rainLayer(["2020-01-01", "2020-02-01", "2020-03-01"], "2020-04-01");
  const temp = tempLayer(["2020-02-01", "2020-03-01"], "2020-04-01");
  const file = buildAreaMeansCsv(makeScene([rain, temp]));
  const rows = dataRows(file.content);

  assert.equal(rows.length, 3);
  assert.ok(rows[0].startsWith("2020-01-01,2020-02-01,"));
  const january = splitRow(rows[0]);
  assert.equal(january[2], "10");
  assert.equal(january[5], "");
  const february = splitRow(rows[1]);
  assert.equal(february[2], "10");
  assert.equal(february[5], "20");
});

test("area csv matches exact intervals so nested periods stay empty", () => {
  const annual = rainLayer(["2020-01-01"], "2021-01-01");
  const monthly = tempLayer(["2020-01-01", "2020-02-01"], "2020-03-01");
  const file = buildAreaMeansCsv(makeScene([annual, monthly]));
  const rows = dataRows(file.content);

  assert.equal(rows.length, 3);
  assert.ok(rows[0].startsWith("2020-01-01,2020-02-01,"));
  assert.ok(rows[1].startsWith("2020-01-01,2021-01-01,"));
  assert.ok(rows[2].startsWith("2020-02-01,2020-03-01,"));
  const januaryMonth = splitRow(rows[0]);
  assert.equal(januaryMonth[2], "");
  assert.equal(januaryMonth[5], "20");
  const annualRow = splitRow(rows[1]);
  assert.equal(annualRow[2], "10");
  assert.equal(annualRow[5], "");
  const februaryMonth = splitRow(rows[2]);
  assert.equal(februaryMonth[2], "");
  assert.equal(februaryMonth[5], "20");
});

test("area csv omits fallback columns unless a fallback is configured", () => {
  const withFallback = buildAreaMeansCsv(makeScene([rainLayer()]));
  const withoutFallback = buildAreaMeansCsv(makeScene([tempLayer()]));
  const headerWith = withFallback.content.split("\r\n")
    .find((line) => line.startsWith("period_start,"))!;
  const headerWithout = withoutFallback.content.split("\r\n")
    .find((line) => line.startsWith("period_start,"))!;

  assert.ok(headerWith.includes("rain_fallback_fraction"));
  assert.equal(headerWithout.includes("temp_fallback_fraction"), false);
});

test("seasonal csv matches the chart transformation with counts and years", () => {
  const layer = seasonalLayer();
  const table = buildSeasonalCycle(layer);
  const file = buildByMonthCsv(makeScene([layer]), layer);
  const rows = dataRows(file.content);

  assert.equal(rows.length, 12);
  const header = file.content.split("\r\n").find((line) => line.startsWith("month,"))!;
  assert.ok(header.includes("rain_mean [mm/month]"));
  assert.ok(header.includes("sample_count"));
  assert.ok(header.includes("year_start"));
  rows.forEach((row, index) => {
    const cells = splitRow(row);
    const tableRow = table.rows[index];
    assert.equal(cells[0], String(index + 1));
    assert.equal(cells[1], tableRow.label);
    assert.equal(cells[2], formatCsvValue(tableRow.value));
    assert.equal(cells[3], formatCsvValue(tableRow.validFraction));
  });
  const january = splitRow(rows[0]);
  assert.equal(january[january.length - 3], "2");
  assert.equal(january[january.length - 2], "2019");
  assert.equal(january[january.length - 1], "2020");
});

test("csv metadata carries every credit, disclaimer, endorsement and terms line", () => {
  const scene = makeScene([rainLayer(), terrainLayer()]);
  const file = buildAreaMeansCsv(scene);

  for (const line of scene.credits!.lines!) assert.ok(file.content.includes(line));
  for (const line of scene.credits!.disclaimers!) assert.ok(file.content.includes(line));
  assert.ok(file.content.includes(scene.credits!.endorsement!));
  assert.ok(file.content.includes(scene.credits!.terms_passthrough!));
  assert.ok(file.content.includes("Rain credit"));
  assert.ok(file.content.includes("DEM credit"));
  assert.ok(file.content.includes("Boundary credit"));
  assert.ok(file.content.includes(`(${scene.id})`));
  assert.ok(file.content.includes("cell_area_inside_outline"));
  assert.ok(file.content.includes("0.01"));
});

test("multiline metadata prefixes each physical line with a hash", () => {
  const scene = makeScene([rainLayer()]);
  scene.credits!.disclaimers = ["First line.\nSecond line."];
  const file = buildAreaMeansCsv(scene);
  const lines = file.content.split("\r\n");

  assert.ok(lines.includes("# Disclaimer: First line."));
  assert.ok(lines.includes("# Second line."));
});

test("metadata prefixes CRLF and bare CR lines in terms and sources", () => {
  const scene = makeScene([rainLayer()]);
  scene.credits!.disclaimers = ["First line.\r\nSecond line.\rThird line."];
  scene.credits!.terms_passthrough = "Terms first.\r\nTerms second.\rTerms third.";
  scene.layers[0].source.attribution = "Rain credit\r\nSecond credit\rThird credit";
  const file = buildAreaMeansCsv(scene);
  const lines = file.content.split("\r\n").slice(0, -1);
  const headerIndex = lines.findIndex((line) => !line.startsWith("# "));

  assert.ok(headerIndex > 0);
  for (const line of lines.slice(0, headerIndex)) assert.ok(line.startsWith("# "));
  for (const line of lines.slice(0, headerIndex)) assert.equal(line.includes("\r"), false);
  assert.ok(lines.includes("# Disclaimer: First line."));
  assert.ok(lines.includes("# Second line."));
  assert.ok(lines.includes("# Third line."));
  assert.ok(lines.includes("# Terms: Terms first."));
  assert.ok(lines.includes("# Terms second."));
  assert.ok(lines.includes("# Terms third."));
  assert.ok(lines.includes("# Second credit"));
  assert.ok(lines.includes("# Third credit"));
});

test("metadata with commas stays a comment without csv quoting", () => {
  const scene = makeScene([rainLayer()]);
  scene.credits!.lines = ["Rain, summed over the month."];
  const file = buildAreaMeansCsv(scene);

  assert.ok(file.content.includes("# Credit: Rain, summed over the month."));
});

test("elevation csv keeps exact stats, resolution and reference values", () => {
  const layer = terrainLayer();
  const file = buildElevationCsv(makeScene([layer]), layer);
  const lines = file.content.split("\r\n");

  assert.ok(lines.includes("share_of_valid_area_below_pct,elevation [m]"));
  assert.ok(lines.includes("# Minimum elevation: 0 m."));
  assert.ok(lines.includes("# Maximum elevation: 1000 m."));
  assert.ok(lines.includes("# Mean elevation: 500 m."));
  assert.ok(lines.includes("# Median elevation: 500 m."));
  assert.ok(lines.includes("# Valid fraction: 0.9."));
  assert.ok(lines.includes("# Grid resolution: 0.01 degrees."));
  assert.ok(lines.includes("# Reference sea_level: 0 m."));
  assert.equal(dataRows(file.content).length, 101);
});

test("filenames slug titles and ranges while static-only names omit dates", () => {
  assert.equal(titleSlug("Test scene!"), "test-scene");
  assert.equal(titleSlug("  Rain & Heat  "), "rain-heat");
  assert.equal(titleSlug("!!!"), "scene");

  const scene = makeScene([rainLayer()]);
  assert.equal(
    areaMeansFilename(scene),
    "test-scene_2019-01-01_2021-07-01_area-means.csv",
  );
  assert.equal(
    byMonthFilename(scene, seasonalLayer()),
    "test-scene_2019-01-01_2021-01-01_by-month.csv",
  );
  assert.ok(byMonthFilename(scene, seasonalLayer()).includes("_by-month.csv"));
  assert.equal(
    elevationFilename(scene, terrainLayer()),
    "test-scene_elevation-distribution.csv",
  );
});

test("area filenames end at the maximum union end regardless of order", () => {
  const annual = rainLayer(["2020-01-01"], "2021-01-01");
  const monthly = tempLayer(["2020-01-01", "2020-02-01"], "2020-03-01");
  const scene = makeScene([annual, monthly]);

  assert.equal(
    areaMeansFilename(scene),
    "test-scene_2020-01-01_2021-01-01_area-means.csv",
  );
});

function dataRows(content: string): string[] {
  const lines = content.split("\r\n").slice(0, -1);
  const headerIndex = lines.findIndex((line) => !line.startsWith("# "));

  return lines.slice(headerIndex + 1);
}

function splitRow(row: string): string[] {
  return row.split(",");
}

function makeScene(layers: LayerDoc[]): Scene {
  return {
    id: "b63e8da2925141a8695d",
    title: "Test scene!",
    generator: { name: "soe", version: "0.9.0" },
    version: "0.7",
    area: {
      boundary: {
        id: "test",
        name: "Test",
        level: "level",
        iso3: null,
        source: "geoBoundaries",
        licence: "CC BY 4.0",
        attribution: "Boundary credit",
      },
      bbox: [0, -1, 1, 1],
      geometry_href: "area.geojson",
      clipped_to_coverage: false,
    },
    period: { start: "2019-01-01", end: "2021-07-01", step: "P1M" },
    layers,
    data: { href: "data.zarr" },
    notices: { limits: ["Coarse terrain."] },
    credits: {
      lines: ["Rain credit", "DEM credit", "Boundary credit"],
      disclaimers: ["Values are modelled."],
      endorsement: "Endorsement.",
      terms_passthrough: "Terms.",
    },
  } as unknown as Scene;
}

function rainLayer(
  values: string[] = monthlyValues(30),
  end = "2021-07-01",
): LayerDoc {
  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
    style: { kind: "field", encodings: ["ramp"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    mask: { path: "mask.zarr", cells_inside: 100 },
    time: { step: "P1M", values, end, method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map(() => 10),
      valid_fraction: values.map(() => 1),
      fallback_fraction: values.map(() => 0),
    },
    arrays: {},
  } as unknown as LayerDoc;
}

function tempLayer(
  values: string[] = monthlyValues(30),
  end = "2021-07-01",
): LayerDoc {
  return {
    id: "temp",
    title: "Temperature",
    units: "°C",
    source: { name: "ERA5", licence: "open", attribution: "ERA5 credit" },
    style: { kind: "field", encodings: ["ramp"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.02, nx: 5, ny: 5 },
    mask: { path: "mask.zarr", cells_inside: 50 },
    time: { step: "P1M", values, end, method: "mean" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map(() => 20),
      valid_fraction: values.map(() => 1),
    },
    arrays: {},
  } as unknown as LayerDoc;
}

function gappyLayer(): LayerDoc {
  const values = ["2020-01-01", "2020-02-01", "2020-03-01"];

  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
    style: { kind: "field", encodings: ["ramp"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    time: { step: "P1M", values, end: "2020-04-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: [0.3333333333333333, null, 0],
      valid_fraction: [1, 0, 0.5],
    },
  } as unknown as LayerDoc;
}

function seasonalLayer(): LayerDoc {
  const values = monthlyValues(24);

  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
    style: { kind: "field", encodings: ["ramp"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    time: { step: "P1M", values, end: "2021-01-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map((_, index) => (index % 12 === 0 ? 10 + (index / 12) * 10 : 5)),
      valid_fraction: values.map(() => 1),
      fallback_fraction: values.map(() => 0),
    },
  } as unknown as LayerDoc;
}

function terrainLayer(): LayerDoc {
  return {
    id: "terrain",
    title: "Terrain",
    units: "m",
    source: { name: "DEM", licence: "open", attribution: "DEM credit" },
    style: { kind: "terrain", encodings: ["shade"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    mask: { path: "mask.zarr", cells_inside: 100 },
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
    arrays: {},
  } as unknown as LayerDoc;
}

function monthlyValues(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2019, index, 1));
    return date.toISOString().slice(0, 10);
  });
}
