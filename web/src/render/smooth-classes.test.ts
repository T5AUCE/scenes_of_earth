import assert from "node:assert/strict";
import { test } from "node:test";

import type { Bbox } from "../types.ts";
import { paintClassIds } from "./colormap.ts";
import { cellClassIds, smoothClassIds } from "./smooth-classes.ts";
import type { ClassRaster } from "./smooth-classes.ts";

const MAX_TEXTURE_SIZE_PX = 4096;
const MAX_SMOOTH_PIXELS_PX = 8_000_000;

// A grid near the equator, where Mercator rows are almost even.
const gridOf = (nx: number, ny: number) => ({ bbox: [0, 0, nx, ny] as Bbox, nx, ny });
const smooth = (cells: number[], nx: number, ny: number, maxSize = MAX_TEXTURE_SIZE_PX) =>
  smoothClassIds(Uint8Array.from(cells), gridOf(nx, ny), { width: nx, height: ny }, maxSize);
const at = ({ ids, width }: ClassRaster, row: number, column: number) => ids[row * width + column];

test("cellClassIds numbers classes from 1 and leaves fill and unknown values at 0", () => {
  const ids = cellClassIds(Float32Array.of(10, 0, NaN, 30, 99), [10, 30]);

  assert.deepEqual([...ids], [1, 0, 0, 2, 0]);
});

test("smoothing never creates a class that no cell has", () => {
  const raster = smooth([1, 1, 1, 1, 1, 1, 1, 1, 3], 3, 3);

  assert.ok(raster.ids.every((id) => id === 1 || id === 3));
});

test("cells without a class stay transparent and the rest stay painted", () => {
  const raster = smooth([1, 2, 0, 0], 2, 2);

  for (let row = 0; row < raster.height; row++) {
    for (let column = 0; column < raster.width; column++) {
      const isLowerRow = row >= raster.height / 2;
      assert.equal(at(raster, row, column) === 0, isLowerRow);
    }
  }
});

test("a lone cell loses the pixels of its inner corner but keeps the outer ones", () => {
  const raster = smooth([1, 1, 1, 1, 1, 1, 1, 1, 2], 3, 3);

  assert.equal(at(raster, 8, 8), 1);
  assert.equal(at(raster, 11, 11), 2);
});

test("a tie takes the class of the nearest cell", () => {
  const raster = smooth([1, 2], 2, 1, 3);

  assert.equal(raster.width, 3);
  assert.deepEqual([at(raster, 0, 0), at(raster, 0, 1), at(raster, 0, 2)], [1, 2, 2]);
});

test("smoothing downsamples an oversized base to stay within its pixel budget", () => {
  const baseSize = { width: 4096, height: 4096 };
  const raster = smoothClassIds(Uint8Array.of(1), gridOf(1, 1), baseSize, MAX_TEXTURE_SIZE_PX);

  assert.ok(raster.width > 0 && raster.width < baseSize.width);
  assert.ok(raster.height > 0 && raster.height < baseSize.height);
  assert.ok(raster.width * raster.height <= MAX_SMOOTH_PIXELS_PX);
  assert.equal(raster.ids.length, raster.width * raster.height);
});

test("rounding output dimensions cannot exceed the smoothing pixel budget", () => {
  const baseSize = { width: 1000, height: 1001 };
  const raster = smoothClassIds(Uint8Array.of(1), gridOf(1, 1), baseSize, MAX_TEXTURE_SIZE_PX);

  assert.ok(raster.width > baseSize.width);
  assert.ok(raster.height > baseSize.height);
  assert.ok(raster.width * raster.height <= MAX_SMOOTH_PIXELS_PX);
  assert.equal(raster.ids.length, raster.width * raster.height);
});

test("smoothing respects the texture limit along both axes", () => {
  const maxTextureSize = 7;
  const raster = smooth([1, 1, 1, 1, 1, 1], 2, 3, maxTextureSize);

  assert.equal(raster.width, maxTextureSize);
  assert.equal(raster.height, maxTextureSize);
  assert.ok(raster.ids.every((id) => id === 1));
});

test("paintClassIds colours each index and leaves 0 transparent", () => {
  const rgba = paintClassIds(Uint8Array.of(2, 0, 1), [[1, 2, 3], [4, 5, 6]]);

  assert.deepEqual([...rgba], [4, 5, 6, 255, 0, 0, 0, 0, 1, 2, 3, 255]);
});
