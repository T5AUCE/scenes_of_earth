import assert from "node:assert/strict";
import { test } from "node:test";

import { decode } from "../data.ts";
import {
  COLOR_CHANNELS,
  legendTicks,
  lut,
  paintColormap,
  paintHillshade,
  RGBA_CHANNELS,
  stopPosition,
} from "./colormap.ts";

const table = (src: number[]) => ({ width: src.length, height: 1, src: Int32Array.from(src) });
const alphaOf = (rgba: Uint8ClampedArray) =>
  [...rgba].filter((_, index) => index % RGBA_CHANNELS === COLOR_CHANNELS);

test("NaN cells are transparent", () => {
  const rgba = paintColormap(Float32Array.of(5, NaN), table([0, 1]), lut("ink-blue"), [0, 10]);

  assert.deepEqual(alphaOf(rgba), [255, 0]);
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

test("flat hillshade is transparent, shadows black and highlights white", () => {
  const rgba = paintHillshade(Float32Array.of(180, 0, 255, 90), table([0, 1, 2, 3]));

  assert.equal(rgba[3], 0);
  assert.deepEqual([...rgba.slice(4, 8)], [0, 0, 0, 255]);
  assert.deepEqual([...rgba.slice(8, 12)], [255, 255, 255, 255]);
  assert.deepEqual([...rgba.slice(12, 16)], [0, 0, 0, 128]);
});

test("masked hillshade cells are transparent", () => {
  const doc = { scale_factor: 1, add_offset: 0, fill: 255 };
  const shade = decode(Uint8Array.of(0, 255, 254), doc);

  const rgba = paintHillshade(shade, table([0, 1, 2]));

  assert.deepEqual(alphaOf(rgba), [255, 0, 252]);
});
