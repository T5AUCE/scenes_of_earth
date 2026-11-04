import assert from "node:assert/strict";
import { test } from "node:test";

import { fieldGradient, rgbToHex } from "../render/palettes.ts";
import type { LayerDoc } from "../types.ts";
import {
  CHART_SURFACE_HEX,
  CONTRAST_EDGE_INK,
  FALLBACK_CHART_INK,
  MIN_PAINT_CONTRAST,
  chartPaintFor,
  contrastRatio,
  paletteInkFor,
} from "./paint.ts";
import { seriesInkFor } from "./series-chart.tsx";

test("blue-red skips its white midpoint while climate keeps its middle stop", () => {
  const blueRed = fieldGradient("blue-red")!;
  const middle = rgbToHex([...blueRed[Math.floor(blueRed.length / 2)]]);
  assert.equal(middle, "#f7f7f7");
  const picked = paletteInkFor(blueRed);
  assert.notEqual(picked, "#f7f7f7");
  assert.ok(contrastRatio(picked, CHART_SURFACE_HEX) >= MIN_PAINT_CONTRAST);

  const climate = fieldGradient("climate")!;
  const climateMiddle = rgbToHex([...climate[Math.floor(climate.length / 2)]]);
  assert.equal(climateMiddle, "#189d73");
  assert.equal(paletteInkFor(climate), "#189d73");
});

test("equidistant qualifying stops prefer the earlier one", () => {
  const navy = [26, 54, 88];
  const black = [31, 31, 31];
  const white = [255, 255, 255];
  const stops = [white, navy, white, black, white];
  assert.equal(paletteInkFor(stops), rgbToHex([...navy]));
});

test("even-length custom palettes break middle ties toward the earlier stop", () => {
  const navy = [26, 54, 88];
  const black = [31, 31, 31];
  const white = [255, 255, 255];
  const stops = [white, navy, black, white];
  assert.equal(paletteInkFor(stops), rgbToHex([...navy]));
});

test("all-light custom gradients and missing palettes fall back", () => {
  const allLight = [[255, 255, 255], [247, 247, 247], [250, 250, 250]];
  assert.equal(paletteInkFor(allLight), FALLBACK_CHART_INK);
  assert.equal(paletteInkFor(null), FALLBACK_CHART_INK);
  assert.equal(paletteInkFor([], "#6e6e6e"), "#6e6e6e");
  assert.equal(paletteInkFor(allLight, "#6e6e6e"), "#6e6e6e");
});

test("chart ink overrides win while unknown palettes fall back to navy", () => {
  const layer = fieldLayer("blue-red");
  assert.equal(seriesInkFor(layer, "white", "climate", "black"), "#ffffff");
  assert.equal(seriesInkFor(layer, "#f7f7f7", "climate", "black"), "#f7f7f7");
  assert.equal(seriesInkFor(layer, undefined, "climate", "black"), "#1f1f1f");
  assert.equal(seriesInkFor(layer, undefined, "climate", null), "#189d73");
  assert.equal(seriesInkFor(layer, undefined, "brown", null), "#5b4636");
  assert.equal(seriesInkFor(layer, undefined, "no-such-palette", null), FALLBACK_CHART_INK);
  assert.equal(seriesInkFor(layer, undefined, "climate", "no-such-ink"), FALLBACK_CHART_INK);
  assert.equal(seriesInkFor(fieldLayer("no-such-palette"), undefined), FALLBACK_CHART_INK);
  assert.equal(seriesInkFor(layer, "no-such-ink"), FALLBACK_CHART_INK);
});

test("contrast edges preserve explicit light inks while dark inks stay plain", () => {
  const white = chartPaintFor("#ffffff");
  assert.equal(white.ink, "#ffffff");
  assert.equal(white.edge, CONTRAST_EDGE_INK);

  const custom = chartPaintFor("#f7f7f7");
  assert.equal(custom.ink, "#f7f7f7");
  assert.equal(custom.edge, CONTRAST_EDGE_INK);

  const navy = chartPaintFor(FALLBACK_CHART_INK);
  assert.equal(navy.ink, FALLBACK_CHART_INK);
  assert.equal(navy.edge, null);

  const variable = chartPaintFor("var(--chart-ink, #1a3658)");
  assert.equal(variable.edge, null);
});

function fieldLayer(palette: string): LayerDoc {
  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"], palette },
  } as unknown as LayerDoc;
}
