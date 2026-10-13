import assert from "node:assert/strict";
import { test } from "node:test";

import { decode } from "../data.ts";
import {
  COLOR_CHANNELS,
  lut,
  paintColormap,
  paintHillshade,
  RGBA_CHANNELS,
} from "./colormap.ts";

const table = (src: number[]) => ({ width: src.length, height: 1, src: Int32Array.from(src) });
const alphaOf = (rgba: Uint8ClampedArray) =>
  [...rgba].filter((_, index) => index % RGBA_CHANNELS === COLOR_CHANNELS);

test("NaN cells are transparent", () => {
  const rgba = paintColormap(Float32Array.of(5, NaN), table([0, 1]), lut("Blues"), [0, 10]);

  assert.deepEqual(alphaOf(rgba), [255, 0]);
});

test("values outside the domain take the end colours", () => {
  const colors = lut("Blues");
  const rgba = paintColormap(Float32Array.of(-5, 0, 10, 99), table([0, 1, 2, 3]), colors, [0, 10]);

  assert.deepEqual([...rgba.slice(0, 4)], [...rgba.slice(4, 8)]);
  assert.deepEqual([...rgba.slice(8, 12)], [...rgba.slice(12, 16)]);
  assert.deepEqual([...rgba.slice(0, 4)], [...colors.slice(0, 4)]);
  assert.deepEqual([...rgba.slice(8, 12)], [...colors.slice(255 * 4, 256 * 4)]);
});

test("uint16 rain decodes with the scale factor and the fill becomes NaN", () => {
  const doc = { scale_factor: 0.1, add_offset: 0, fill: 65535 };
  const values = decode(Uint16Array.of(0, 1234, 65535), doc);

  assert.ok(Math.abs(values[1] - 123.4) < 0.01);
  assert.ok(Number.isNaN(values[2]));
});

test("flat hillshade is transparent, shadows black and highlights white", () => {
  const rgba = paintHillshade(Uint8Array.of(180, 0, 255, 90), table([0, 1, 2, 3]));

  assert.equal(rgba[3], 0);
  assert.deepEqual([...rgba.slice(4, 8)], [0, 0, 0, 255]);
  assert.deepEqual([...rgba.slice(8, 12)], [255, 255, 255, 255]);
  assert.deepEqual([...rgba.slice(12, 16)], [0, 0, 0, 128]);
});
