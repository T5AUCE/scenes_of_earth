import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  decodeHeights,
  DEM_TILE_SIZE_PX,
  edgeStrips,
  loadDemTile,
  stripOf,
} from "./dem-decode.ts";

const SIZE_PX = DEM_TILE_SIZE_PX;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("terrarium bytes decode to metres", () => {
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 1, 128, 255, 127, 255, 255, 255]);

  assert.deepEqual([...decodeHeights(rgba)], [0, 1.5, -1 / 256]);
});

test("edge strips hold the two outermost rows and columns of each side", () => {
  const heights = Float32Array.from({ length: SIZE_PX * SIZE_PX }, (_, index) => index);
  const strips = edgeStrips(heights);
  const at = (row: number, column: number) => row * SIZE_PX + column;

  assert.equal(strips.byteLength, 16 * 1024);
  assert.deepEqual([...stripOf(strips, "top").subarray(0, 2)], [0, 1]);
  assert.equal(stripOf(strips, "top")[SIZE_PX], at(1, 0));
  assert.equal(stripOf(strips, "bottom")[0], at(SIZE_PX - 2, 0));
  assert.equal(stripOf(strips, "bottom")[2 * SIZE_PX - 1], at(SIZE_PX - 1, SIZE_PX - 1));
  assert.deepEqual(
    [...stripOf(strips, "left").subarray(0, 4)],
    [at(0, 0), at(0, 1), at(1, 0), at(1, 1)],
  );
  assert.deepEqual(
    [...stripOf(strips, "right").subarray(2 * 7, 2 * 7 + 2)],
    [at(7, SIZE_PX - 2), at(7, SIZE_PX - 1)],
  );
});

test("a 404 means the tile does not exist", async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });

  assert.equal(await loadDemTile("https://dem/1/2/3.png", new AbortController().signal), null);
});

test("any other failed response throws with the url", async () => {
  globalThis.fetch = async () => new Response(null, { status: 500 });

  await assert.rejects(
    loadDemTile("https://dem/1/2/3.png", new AbortController().signal),
    /Bad response: 500 for https:\/\/dem\/1\/2\/3\.png/,
  );
});
