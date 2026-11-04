import assert from "node:assert/strict";
import { test } from "node:test";

import type { LayerDoc } from "../types.ts";
import type { ChartTable } from "./table.ts";
import { chartNotesFor } from "./notes.ts";

test("terrain keeps sea-level branches without proving a coastline", () => {
  const layer = terrainLayer([]);
  const withSea = distributionTable([{ id: "sea_level", value: 0 }]);
  const before = JSON.stringify(withSea);
  const seaNotes = chartNotesFor(layer, withSea, "area");
  assert.ok(seaNotes.some((note) => note.includes("Valid terrain covers")));
  assert.ok(seaNotes.some((note) => note.includes("Sea level marks 0 m")));
  assert.equal(JSON.stringify(withSea), before);

  const withoutSea = distributionTable([]);
  const plainNotes = chartNotesFor(layer, withoutSea, "area");
  assert.ok(plainNotes.some((note) => note.includes("No sea-level reference")));
  assert.ok(plainNotes.some((note) => note.includes("proves nothing about a coastline")));
  assert.ok(!plainNotes.some((note) => note.includes("Sea level marks")));
});

test("seasonal and coverage notes preserve counts while staying concise", () => {
  const layer = timeLayer();
  const seasonal = seasonalTable([2, 9]);
  const notes = chartNotesFor(layer, seasonal, "line");
  assert.ok(notes.some((note) => note.includes("2-9")));
  assert.ok(notes.some((note) => note.includes("Sample count")));

  const hollow = timeTable([{ validFraction: 0.5, fallbackFraction: null }]);
  assert.ok(
    chartNotesFor(layer, hollow, "line").some((note) => note.includes("Hollow marks")),
  );
  const full = timeTable([{ validFraction: 1, fallbackFraction: null }]);
  assert.ok(
    !chartNotesFor(layer, full, "line").some((note) => note.includes("Hollow marks")),
  );
});

test("fallback names its source while zero and absent shares stay quiet", () => {
  const layer = timeLayer([{ name: "ERA5" }]);
  const table = timeTable([{ validFraction: 1, fallbackFraction: 0.2 }]);
  const notes = chartNotesFor(layer, table, "line");
  const fallback = notes.find((note) => note.includes("ERA5"))!;
  assert.ok(fallback.includes("area-weighted fractions"));
  assert.ok(fallback.includes("inspection or Table"));

  const zero = timeTable([{ validFraction: 1, fallbackFraction: 0 }]);
  assert.ok(!chartNotesFor(layer, zero, "line").some((note) => note.includes("ERA5")));
  const absent = timeTable([{ validFraction: 1, fallbackFraction: null }]);
  assert.ok(!chartNotesFor(layer, absent, "line").some((note) => note.includes("filled from")));
});

test("type hints stay in notes without changing source values", () => {
  const terrain = terrainLayer([]);
  const quantile = distributionTable([]);
  assert.ok(
    chartNotesFor(terrain, quantile, "bar").some((note) => note.includes("quantile")),
  );
  const warm = timeLayer([]);
  warm.units = "°C";
  const offset = timeTable([{ validFraction: 1, fallbackFraction: null }]);
  assert.ok(chartNotesFor(warm, offset, "area").some((note) => note.includes("zero")));

  const denseLayer = timeLayer([]);
  const dense = denseTable(61);
  assert.ok(chartNotesFor(denseLayer, dense, "bar").some((note) => note.includes("line")));

  const precise = distributionTable([{ id: "sea_level", value: 0 }]);
  precise.validFraction = 1 / 3;
  precise.mean = 500.123456789;
  const before = JSON.stringify(precise);
  const notes = chartNotesFor(terrain, precise, "area");
  assert.equal(JSON.stringify(precise), before);
  assert.ok(!notes.join("\n").includes("33.3333333"));
  assert.ok(!notes.join("\n").includes("500.123456789"));
});

function timeLayer(sources: { name: string }[] = []): LayerDoc {
  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    source: { name: "CHIRPS" } as LayerDoc["source"],
    fallback_sources: sources as LayerDoc["fallback_sources"],
  } as LayerDoc;
}

function terrainLayer(sources: { name: string }[] = []): LayerDoc {
  return {
    id: "terrain",
    title: "Terrain",
    units: "m",
    source: { name: "GLO" } as LayerDoc["source"],
    fallback_sources: sources as LayerDoc["fallback_sources"],
  } as LayerDoc;
}

function timeTable(
  rows: { validFraction: number; fallbackFraction: number | null }[],
): ChartTable {
  return {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: rows.map((row, index) => ({
      x: Date.parse("2019-01-01") + index * 30 * 24 * 60 * 60 * 1000,
      value: 10,
      label: "2019-01-01",
      validFraction: row.validFraction,
      fallbackFraction: row.fallbackFraction,
      interval: { start: "2019-01-01", end: "2019-02-01" },
    })),
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
}

function denseTable(count: number): ChartTable {
  return {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: Array.from({ length: count }, (_, index) => ({
      x: Date.parse("2019-01-01") + index * 30 * 24 * 60 * 60 * 1000,
      value: 10 + index,
      label: "2019-01-01",
      validFraction: 1,
      fallbackFraction: null,
      interval: { start: "2019-01-01", end: "2019-02-01" },
    })),
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
}

function seasonalTable(counts: number[]): ChartTable {
  return {
    shape: "seasonal_cycle",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: counts.map((sampleCount, index) => ({
      x: index + 1,
      value: 10,
      label: ["Jan", "Feb"][index] ?? "Mar",
      validFraction: 1,
      fallbackFraction: null,
      sampleCount,
      yearRange: [2019, 2020] as [number, number],
    })),
    xTitle: "Month",
    yTitle: "Rain by month (mm/month)",
  };
}

function distributionTable(references: { id: string; value: number }[]): ChartTable {
  return {
    shape: "distribution",
    layerId: "terrain",
    units: "m",
    rows: [
      { x: 0, value: 100, label: "0%", validFraction: 0.9, fallbackFraction: null },
      { x: 100, value: 1000, label: "100%", validFraction: 0.9, fallbackFraction: null },
    ],
    xTitle: "Share of valid area below (%)",
    yTitle: "Elevation (m)",
    validFraction: 0.9,
    mean: 500,
    median: 500,
    min: 100,
    max: 1000,
    referenceValues: references,
  };
}
