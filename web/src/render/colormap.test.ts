import assert from "node:assert/strict";
import { test } from "node:test";

import { decode } from "../data.ts";
import type { Bbox } from "../types.ts";
import {
  COLOR_CHANNELS,
  evenStops,
  inSrgbGamut,
  legendTicks,
  lut,
  lut2d,
  LUT2D_SIZE,
  oklchToRgb,
  paintBivariate,
  paintClasses,
  paintColormap,
  RGBA_CHANNELS,
  rgbToOklch,
  stopPosition,
  stopsForRange,
} from "./colormap.ts";
import { crossSampleTable, mercY, sampleTable, type SampleTable } from "./mercator.ts";
import {
  CLASS_PALETTES,
  classColors,
  customPalette,
  FIELD_PALETTES,
  fieldGradient,
  oklchGrid,
  RAIN_TEMPERATURE_GRID,
} from "./palettes.ts";

const gradient = (name: string) => fieldGradient(name)!;
const table = (src: number[]) => ({ width: src.length, height: 1, src: Int32Array.from(src) });
const alphaOf = (rgba: Uint8ClampedArray) =>
  [...rgba].filter((_, index) => index % RGBA_CHANNELS === COLOR_CHANNELS);

test("NaN cells are transparent", () => {
  const colors = lut(gradient("ink-blue"));
  const rgba = paintColormap(Float32Array.of(5, NaN), table([0, 1]), colors, [0, 10]);

  assert.deepEqual(alphaOf(rgba), [255, 0]);
});

test("Fiji rainfall covers the point whose nearest sample falls south of its finite cell", () => {
  const grid = { bbox: [177, -19.2, 181.65, -12.45] as Bbox, nx: 93, ny: 135 };
  const samples = sampleTable(grid, undefined, { preserveCoverage: true });
  const pixel = pixelAt(samples, grid.bbox, 179.225, -16.691719876);
  const values = new Float32Array(grid.nx * grid.ny).fill(NaN);
  values[84 * grid.nx + 44] = 384.7;
  const colors = lut(gradient("ink-blue"));
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
  const colors = lut(gradient("climate"));
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
  const colors = lut(gradient("climate"));
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
  const colors = lut(gradient("climate"));
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
  const rgba = paintColormap(values, samples, lut(gradient("climate")), [0, 10]);

  assert.deepEqual(rgba.slice(0, RGBA_CHANNELS), new Uint8ClampedArray(RGBA_CHANNELS));
  assert.deepEqual(alphaOf(rgba), [0, 255, 255, 0]);
});

test("a field boundary east of 180 keeps its source column when filling a footprint", () => {
  const grid = { bbox: [177, -19.2, 181.65, -12.45] as Bbox, nx: 93, ny: 135 };
  const samples = sampleTable(grid, undefined, { preserveCoverage: true });
  const pixel = pixelAt(samples, grid.bbox, 180.725, -17.01);
  const values = new Float32Array(grid.nx * grid.ny).fill(NaN);
  values[91 * grid.nx + 74] = 10;
  const rgba = paintColormap(values, samples, lut(gradient("ink-blue")), [0, 10]);

  assert.equal(samples.src[pixel], 90 * grid.nx + 74);
  assert.equal(alphaOf(rgba)[pixel], 255);
});

test("climate palette runs from slate blue to terracotta", () => {
  const colors = lut(gradient("climate"));
  const [firstRed, , firstBlue] = colors.slice(0, COLOR_CHANNELS);
  const [lastRed, , lastBlue] = colors.slice(-RGBA_CHANNELS);

  assert.ok(firstBlue > firstRed);
  assert.ok(lastRed > lastBlue);
});

test("values outside the stops take the end colours", () => {
  const colors = lut(gradient("ink-blue"));
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

test("even stops span a custom range in equal steps", () => {
  assert.deepEqual(evenStops(0, 8, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(evenStops(-1, 1, 5), [-1, -0.5, 0, 0.5, 1]);
  assert.deepEqual(evenStops(0.1, 0.4, 4), [0.1, 0.2, 0.3, 0.4]);
});

test("every field palette has nine stops that blend into a full table", () => {
  for (const { name } of FIELD_PALETTES) {
    assert.equal(gradient(name).length, 9, name);
    assert.equal(lut(gradient(name)).length, 256 * RGBA_CHANNELS, name);
  }
});

test("a custom gradient blends through its own colours", () => {
  const table = lut(fieldGradient(customPalette(["#000000", "#ffffff"]))!);

  assert.deepEqual([...table.slice(0, RGBA_CHANNELS)], [0, 0, 0, 255]);
  assert.deepEqual([...table.slice(-RGBA_CHANNELS)], [255, 255, 255, 255]);
});

const LAST_LUT2D = LUT2D_SIZE - 1;

const colorAt = (colors: Uint8ClampedArray, row: number, column: number) => {
  const start = (row * LUT2D_SIZE + column) * RGBA_CHANNELS;
  return [...colors.subarray(start, start + COLOR_CHANNELS)];
};

test("the bivariate table's corners match the palette grid", () => {
  const colors = lut2d(RAIN_TEMPERATURE_GRID);
  const last = RAIN_TEMPERATURE_GRID.length - 1;

  assert.deepEqual(colorAt(colors, 0, 0), RAIN_TEMPERATURE_GRID[0][0]);
  assert.deepEqual(colorAt(colors, 0, LAST_LUT2D), RAIN_TEMPERATURE_GRID[0][last]);
  assert.deepEqual(colorAt(colors, LAST_LUT2D, 0), RAIN_TEMPERATURE_GRID[last][0]);
  assert.deepEqual(colorAt(colors, LAST_LUT2D, LAST_LUT2D), RAIN_TEMPERATURE_GRID[last][last]);
});

test("the bivariate table's lightness falls with every wetter row", () => {
  const colors = lut2d(RAIN_TEMPERATURE_GRID);

  for (let column = 0; column < LUT2D_SIZE; column++) {
    for (let row = 1; row < LUT2D_SIZE; row++) {
      const drier = rgbToOklch(colorAt(colors, row - 1, column)).lightness;
      const wetter = rgbToOklch(colorAt(colors, row, column)).lightness;
      assert.ok(wetter < drier, `column ${column} row ${row}`);
    }
  }
});

test("the blend grid keeps the approved dry and wet lightness endpoints", () => {
  const last = RAIN_TEMPERATURE_GRID.length - 1;
  const lightness = (row: number, column: number) =>
    rgbToOklch(RAIN_TEMPERATURE_GRID[row][column]).lightness;
  const chroma = (row: number, column: number) =>
    rgbToOklch(RAIN_TEMPERATURE_GRID[row][column]).chroma;

  assert.ok(Math.abs(lightness(0, 0) - 0.9) < 0.002);
  assert.ok(Math.abs(lightness(0, last) - 0.93) < 0.002);
  assert.ok(Math.abs(lightness(last, 0) - 0.5) < 0.002);
  assert.ok(Math.abs(lightness(last, last) - 0.53) < 0.002);
  assert.ok(Math.abs(chroma(0, 0) - 0.045) < 0.002);
  assert.ok(Math.abs(chroma(last, 0) - 0.12) < 0.002);
  assert.ok(Math.abs(chroma(last, last) - 0.12) < 0.002);
});

test("every blend grid colour lies inside the sRGB gamut", () => {
  for (const row of RAIN_TEMPERATURE_GRID) {
    for (const color of row) {
      assert.equal(color.length, COLOR_CHANNELS);
      assert.ok(color.every((channel) => channel >= 0 && channel <= 255));
    }
  }
});

test("an out-of-gamut grid request keeps its lightness and hue as chroma falls", () => {
  const lightness = 0.7;
  const hue = 30;
  const requestedChroma = 0.4;
  const grid = oklchGrid({
    dry: { lightness, chroma: requestedChroma },
    wet: { lightness, chroma: requestedChroma },
    hues: [hue],
    warmLift: 0,
  });

  assert.ok(!inSrgbGamut(lightness, requestedChroma, hue));

  for (const [color] of grid) {
    const measured = rgbToOklch(color);
    assert.ok(Math.abs(measured.lightness - lightness) < 0.005);
    assert.ok(Math.abs(measured.hue - hue) < 1);
    assert.ok(measured.chroma > 0.1 && measured.chroma < requestedChroma);
  }
});

test("the sRGB gamut check rejects colours with negative or overflowing channels", () => {
  assert.ok(inSrgbGamut(0.6, 0.1, 250));

  const outside = oklchToRgb(0.7, 0.4, 30);
  assert.ok(Math.min(...outside) < 0);
  assert.ok(Math.max(...outside) > 255);
  assert.ok(!inSrgbGamut(0.7, 0.4, 30));
});

test("the rain ramp darkens and gains chroma at every stop", () => {
  const stops = gradient("ink-blue").map(rgbToOklch);

  for (let index = 1; index < stops.length; index++) {
    assert.ok(stops[index].lightness < stops[index - 1].lightness, `stop ${index}`);
    assert.ok(stops[index].chroma > stops[index - 1].chroma, `stop ${index}`);
  }
});

test("a pixel missing either bivariate input stays transparent", () => {
  const colors = lut2d(RAIN_TEMPERATURE_GRID);
  const stops = [0, 10];
  const rain = { values: Float32Array.of(10, NaN, 10), table: table([0, 1, 0]), stops };
  const temperature = { values: Float32Array.of(10, 10), table: table([0, 1, -1]), stops };

  const rgba = paintBivariate(rain, temperature, colors);

  assert.deepEqual(
    [...rgba.subarray(0, RGBA_CHANNELS)],
    [...colorAt(colors, LAST_LUT2D, LAST_LUT2D), 255],
  );
  assert.deepEqual([...rgba.subarray(RGBA_CHANNELS)], new Array(2 * RGBA_CHANNELS).fill(0));
});

test("the blend keeps the Fiji coast pixel whose nearest rainfall cell is empty", () => {
  const rainGrid = { bbox: [177, -19.2, 181.65, -12.45] as Bbox, nx: 93, ny: 135 };
  const temperatureGrid = { bbox: [176.95, -19.25, 181.65, -12.45] as Bbox, nx: 47, ny: 68 };
  const rainTable = sampleTable(rainGrid, undefined, { preserveCoverage: true });
  const temperatureTable = crossSampleTable(rainTable, rainGrid, temperatureGrid);
  const pixel = pixelAt(rainTable, rainGrid.bbox, 179.225, -16.691719876);
  const rainValues = new Float32Array(rainGrid.nx * rainGrid.ny).fill(NaN);
  rainValues[84 * rainGrid.nx + 44] = 384.7;
  const temperatureValues = new Float32Array(temperatureGrid.nx * temperatureGrid.ny).fill(26);

  const rgba = paintBivariate(
    { values: rainValues, table: rainTable, stops: [0, 384.7] },
    { values: temperatureValues, table: temperatureTable, stops: [20, 30] },
    lut2d(RAIN_TEMPERATURE_GRID),
  );

  assert.ok(Number.isNaN(rainValues[rainTable.src[pixel]]));
  assert.equal(alphaOf(rgba)[pixel], 255);
});

test("the blend fills a coarse-grid coast pixel from the finite cell its footprint reaches", () => {
  const rainGrid = { bbox: [0, 0, 4, 4] as Bbox, nx: 8, ny: 8 };
  const temperatureGrid = { bbox: [0.3, 0, 4, 4] as Bbox, nx: 4, ny: 4 };
  const rainTable = sampleTable(rainGrid, undefined, { preserveCoverage: true });
  const temperatureTable = crossSampleTable(rainTable, rainGrid, temperatureGrid);
  const rain = { values: new Float32Array(64).fill(5), table: rainTable, stops: [0, 10] };
  const temperature = {
    values: new Float32Array(16).fill(15),
    table: temperatureTable,
    stops: [10, 20],
  };

  const rgba = paintBivariate(rain, temperature, lut2d(RAIN_TEMPERATURE_GRID));

  assert.equal(temperatureTable.src[0], -1);
  assert.equal(alphaOf(rgba)[0], 255);
});

test("a custom range spreads the stops evenly and no range keeps the fitted ones", () => {
  const fitted = [0, 10, 30];

  assert.deepEqual(stopsForRange(fitted, [0, 20]), [0, 10, 20]);
  assert.equal(stopsForRange(fitted, null), fitted);
});

function pixelAt(samples: SampleTable, bbox: Bbox, longitude: number, latitude: number) {
  const [west, south, east, north] = bbox;
  const column = Math.floor(((longitude - west) / (east - west)) * samples.width);
  const row = Math.floor(
    ((mercY(north) - mercY(latitude)) / (mercY(north) - mercY(south))) * samples.height,
  );
  return row * samples.width + column;
}
