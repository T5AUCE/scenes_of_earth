import assert from "node:assert/strict";
import { test } from "node:test";

import { decode } from "../data.ts";
import type { Bbox } from "../types.ts";
import {
  CLASS_PALETTES,
  classColors,
  COLOR_CHANNELS,
  legendTicks,
  lut,
  paintClasses,
  paintColormap,
  RGBA_CHANNELS,
  stopPosition,
} from "./colormap.ts";
import { mercY, sampleTable } from "./mercator.ts";
import type { SampleTable } from "./mercator.ts";

const table = (src: number[]) => ({ width: src.length, height: 1, src: Int32Array.from(src) });
const alphaOf = (rgba: Uint8ClampedArray) =>
  [...rgba].filter((_, index) => index % RGBA_CHANNELS === COLOR_CHANNELS);

test("NaN cells are transparent", () => {
  const rgba = paintColormap(Float32Array.of(5, NaN), table([0, 1]), lut("ink-blue"), [0, 10]);

  assert.deepEqual(alphaOf(rgba), [255, 0]);
});

test("Fiji rainfall covers the point whose nearest sample falls south of its finite cell", () => {
  const grid = { bbox: [177, -19.2, 181.65, -12.45] as Bbox, nx: 93, ny: 135 };
  const samples = sampleTable(grid, undefined, { preserveCoverage: true });
  const pixel = pixelAt(samples, grid.bbox, 179.225, -16.691719876);
  const values = new Float32Array(grid.nx * grid.ny).fill(NaN);
  values[84 * grid.nx + 44] = 384.7;
  const colors = lut("ink-blue");
  const rgba = paintColormap(values, samples, colors, [0, values[84 * grid.nx + 44]]);

  assert.equal(samples.src[pixel], 85 * grid.nx + 44);
  assert.deepEqual(
    rgba.slice(pixel * RGBA_CHANNELS, (pixel + 1) * RGBA_CHANNELS),
    colors.slice(-RGBA_CHANNELS),
  );
});

test("Fiji temperature covers the point sampling north of its finite cell", () => {
  const grid = { bbox: [176.95, -19.25, 181.65, -12.45] as Bbox, nx: 47, ny: 68 };
  const samples = sampleTable(grid, undefined, { preserveCoverage: true });
  const pixel = pixelAt(samples, grid.bbox, 179.902406751, -18.5745);
  const values = new Float32Array(grid.nx * grid.ny).fill(NaN);
  values[61 * grid.nx + 29] = 26.8;
  const colors = lut("climate");
  const rgba = paintColormap(values, samples, colors, [0, values[61 * grid.nx + 29]]);

  assert.equal(samples.src[pixel], 60 * grid.nx + 29);
  assert.deepEqual(
    rgba.slice(pixel * RGBA_CHANNELS, (pixel + 1) * RGBA_CHANNELS),
    colors.slice(-RGBA_CHANNELS),
  );
});

test("a finite nearest sample keeps its colour even when other cells overlap", () => {
  const grid = { bbox: [180, -3, 186, 3] as Bbox, nx: 6, ny: 6 };
  const samples = sampleTable(grid, 2, { preserveCoverage: true });
  const values = new Float32Array(36).fill(10);
  values[samples.src[0]] = 0;
  const colors = lut("climate");
  const rgba = paintColormap(values, samples, colors, [0, 10]);

  assert.deepEqual(rgba.slice(0, RGBA_CHANNELS), colors.slice(0, RGBA_CHANNELS));
});

test("capped pixels use the nearest finite overlap without interpolating", () => {
  const grid = { bbox: [180, -5, 190, 5] as Bbox, nx: 10, ny: 10 };
  const samples = sampleTable(grid, 2, { preserveCoverage: true });
  const values = new Float32Array(grid.nx * grid.ny).fill(NaN);
  values[0] = 0;
  values[4 * grid.nx + 3] = 10;
  values[2 * grid.nx + 3] = Infinity;
  const colors = lut("climate");
  const rgba = paintColormap(values, samples, colors, [0, 10]);

  assert.ok(Number.isNaN(values[samples.src[0]]));
  assert.deepEqual(rgba.slice(0, RGBA_CHANNELS), colors.slice(-RGBA_CHANNELS));
  assert.deepEqual(alphaOf(rgba), [255, 0, 0, 0]);
});

test("an empty footprint stays transparent beside finite cells touching only its edges", () => {
  const grid = { bbox: [180, -3, 186, 3] as Bbox, nx: 6, ny: 6 };
  const samples = sampleTable(grid, 2, { preserveCoverage: true });
  const values = new Float32Array(36).fill(NaN);
  values[3] = 10;
  values[3 * grid.nx] = 10;
  const rgba = paintColormap(values, samples, lut("climate"), [0, 10]);

  assert.deepEqual(rgba.slice(0, RGBA_CHANNELS), new Uint8ClampedArray(RGBA_CHANNELS));
  assert.deepEqual(alphaOf(rgba), [0, 255, 255, 0]);
});

test("a field boundary east of 180 keeps its source column when filling a footprint", () => {
  const grid = { bbox: [177, -19.2, 181.65, -12.45] as Bbox, nx: 93, ny: 135 };
  const samples = sampleTable(grid, undefined, { preserveCoverage: true });
  const pixel = pixelAt(samples, grid.bbox, 180.725, -17.01);
  const values = new Float32Array(grid.nx * grid.ny).fill(NaN);
  values[91 * grid.nx + 74] = 10;
  const rgba = paintColormap(values, samples, lut("ink-blue"), [0, 10]);

  assert.equal(samples.src[pixel], 90 * grid.nx + 74);
  assert.equal(alphaOf(rgba)[pixel], 255);
});

test("climate palette runs from slate blue to terracotta", () => {
  const colors = lut("climate");
  const [firstRed, , firstBlue] = colors.slice(0, COLOR_CHANNELS);
  const [lastRed, , lastBlue] = colors.slice(-RGBA_CHANNELS);

  assert.ok(firstBlue > firstRed);
  assert.ok(lastRed > lastBlue);
});

test("values outside the stops take the end colours", () => {
  const colors = lut("ink-blue");
  const rgba = paintColormap(Float32Array.of(-5, 0, 10, 99), table([0, 1, 2, 3]), colors, [0, 10]);

  assert.deepEqual([...rgba.slice(0, 4)], [...rgba.slice(4, 8)]);
  assert.deepEqual([...rgba.slice(8, 12)], [...rgba.slice(12, 16)]);
  assert.deepEqual([...rgba.slice(0, 4)], [...colors.slice(0, 4)]);
  assert.deepEqual([...rgba.slice(8, 12)], [...colors.slice(255 * 4, 256 * 4)]);
});

test("each stop sits on its own colour however uneven the stops are", () => {
  const stops = [0, 1, 50, 100];

  assert.deepEqual(stops.map((stop) => stopPosition(stop, stops)), [0, 1 / 3, 2 / 3, 1]);
  assert.equal(stopPosition(25.5, stops), 0.5);
});

test("legend labels sit at their stop's palette position when stops are irregular", () => {
  const ticks = legendTicks([0, 10, 20, 30, 40, 100]);

  assert.deepEqual(ticks.map((tick) => tick.value), [0, 10, 30, 40, 100]);
  assert.deepEqual(ticks.map((tick) => tick.position), [0, 1 / 5, 3 / 5, 4 / 5, 1]);
});

test("legend labels of two stops are just the two ends", () => {
  assert.deepEqual(legendTicks([3, 3]), [
    { position: 0, value: 3 },
    { position: 1, value: 3 },
  ]);
});

test("legend labels keep the backend's rounded values", () => {
  const stops = [1234, 1237, 1240, 1244, 1247, 1250, 1254, 1257, 1260];

  assert.deepEqual(legendTicks(stops).map((tick) => tick.value), [1234, 1240, 1247, 1254, 1260]);
});

test("uint16 rain decodes with the scale factor and the fill becomes NaN", () => {
  const doc = { scale_factor: 0.1, add_offset: 0, fill: 65535 };
  const values = decode(Uint16Array.of(0, 1234, 65535), doc);

  assert.ok(Math.abs(values[1] - 123.4) < 0.01);
  assert.ok(Number.isNaN(values[2]));
});

function pixelAt(samples: SampleTable, bbox: Bbox, longitude: number, latitude: number) {
  const [west, south, east, north] = bbox;
  const column = Math.floor(((longitude - west) / (east - west)) * samples.width);
  const row = Math.floor(
    ((mercY(north) - mercY(latitude)) / (mercY(north) - mercY(south))) * samples.height,
  );
  return row * samples.width + column;
}

const WORLDCOVER_CLASSES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100].map((value) => ({
  value,
  label: `Class ${value}`,
  color: "#102030",
}));

test("the painted palette has a colour for every WorldCover class", () => {
  const painted = Object.keys(CLASS_PALETTES.painted).map(Number);

  assert.deepEqual(painted, WORLDCOVER_CLASSES.map(({ value }) => value));
});

test("class colours come from the named palette and fall back to the layer's own", () => {
  const classes = [...WORLDCOVER_CLASSES, { value: 110, label: "New", color: "#ff0000" }];

  assert.deepEqual(classColors(classes, "painted").get(10), [0x45, 0x6d, 0x3b]);
  assert.deepEqual(classColors(classes, "painted").get(110), [255, 0, 0]);
  assert.deepEqual(classColors(classes, "unknown").get(10), [0x10, 0x20, 0x30]);
  assert.deepEqual(classColors(classes).get(10), [0x10, 0x20, 0x30]);
});

test("paintClasses colours known classes and leaves fill and unknown values transparent", () => {
  const colors = new Map([[10, [1, 2, 3]]]);
  const rgba = paintClasses(Float32Array.of(10, NaN, 99), table([0, 1, 2]), colors);

  assert.deepEqual([...rgba], [1, 2, 3, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
});
