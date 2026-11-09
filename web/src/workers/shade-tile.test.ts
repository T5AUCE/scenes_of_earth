import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeHeights, shadeTile, type LoadHeights, type ShadeTileId } from "./shade-tile.ts";

const SIZE_PX = 8;
const STRENGTH = 2;
const ZOOM = 8;
// Large because a test tile has 8 pixels where a real one has 512, which shrinks every slope.
const SLOPE_M_PER_PX = 8000;

test("terrarium bytes decode to metres", () => {
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 1, 128, 255, 127, 255, 255, 255]);

  assert.deepEqual([...decodeHeights(rgba)], [0, 1.5, -1 / 256]);
});

test("flat ground shades fully transparent", async () => {
  const pixels = await shadeTile({ z: ZOOM, x: 100, y: 100 }, STRENGTH, plane(0, 0));

  assert.ok(pixels.every((value) => value === 0));
});

test("shading is neutral grey on slopes", async () => {
  const pixels = await shadeTile({ z: ZOOM, x: 100, y: 100 }, STRENGTH, plane(SLOPE_M_PER_PX, 5));

  for (let offset = 0; offset < pixels.length; offset += 4) {
    assert.equal(pixels[offset], pixels[offset + 1]);
    assert.equal(pixels[offset + 1], pixels[offset + 2]);
  }
  assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0));
});

test("the north-west facing slope is lighter than the south-east one", async () => {
  const tile = { z: ZOOM, x: 100, y: 100 };
  const lit = await shadeTile(tile, STRENGTH, plane(SLOPE_M_PER_PX, SLOPE_M_PER_PX));
  const dark = await shadeTile(tile, STRENGTH, plane(-SLOPE_M_PER_PX, -SLOPE_M_PER_PX));
  const centre = (SIZE_PX / 2 * SIZE_PX + SIZE_PX / 2) * 4;

  assert.ok(lit[centre] > dark[centre]);
});

test("zero strength shades even a steep slope fully transparent", async () => {
  const pixels = await shadeTile({ z: ZOOM, x: 100, y: 100 }, 0, plane(SLOPE_M_PER_PX, 0));

  assert.ok(pixels.every((value) => value === 0));
});

test("a tile edge is shaded like its interior when the neighbour exists", async () => {
  const pixels = await shadeTile({ z: ZOOM, x: 100, y: 100 }, STRENGTH, plane(SLOPE_M_PER_PX, 0));

  for (let row = 0; row < SIZE_PX; row++) {
    const first = row * SIZE_PX * 4;
    const last = first + (SIZE_PX - 1) * 4;
    assert.deepEqual([...pixels.subarray(first, first + 4)], [...pixels.subarray(last, last + 4)]);
  }
});

test("a missing neighbour repeats the edge, which flattens the edge slope", async () => {
  const loadWithoutRight: LoadHeights = async (tile) =>
    tile.x === 101 ? null : plane(SLOPE_M_PER_PX, 0)(tile);

  const pixels = await shadeTile({ z: ZOOM, x: 100, y: 100 }, STRENGTH, loadWithoutRight);
  const middle = (SIZE_PX * SIZE_PX / 2 + 2) * 4;
  const edge = (SIZE_PX * SIZE_PX / 2 + SIZE_PX - 1) * 4;

  assert.notDeepEqual(
    [...pixels.subarray(edge, edge + 4)],
    [...pixels.subarray(middle, middle + 4)],
  );
});

test("a missing tile is reported as a 404", async () => {
  const loadNothing: LoadHeights = async () => null;

  await assert.rejects(
    shadeTile({ z: ZOOM, x: 1, y: 1 }, STRENGTH, loadNothing),
    /^Error: Bad response: 404/,
  );
});

test("neighbours wrap around the antimeridian and stop at the poles", async () => {
  const requested: ShadeTileId[] = [];
  const load: LoadHeights = async (tile) => {
    requested.push(tile);
    return new Float32Array(SIZE_PX * SIZE_PX);
  };

  await shadeTile({ z: 2, x: 0, y: 0 }, STRENGTH, load);

  assert.equal(requested.length, 6);
  assert.ok(requested.some((tile) => tile.x === 3));
  assert.ok(requested.every((tile) => tile.y >= 0));
});

test("the same terrain shades steeper at high latitude", async () => {
  const slope = plane(SLOPE_M_PER_PX, 0);
  const equator = await shadeTile({ z: 3, x: 4, y: 3 }, STRENGTH, slope);
  const north = await shadeTile({ z: 3, x: 4, y: 0 }, STRENGTH, slope);
  const centre = (SIZE_PX * SIZE_PX / 2 + SIZE_PX / 2) * 4 + 3;

  assert.notEqual(north[centre], equator[centre]);
});

/** Terrain rising by the given metres per pixel eastward and southward across every tile. */
function plane(eastM: number, southM: number): LoadHeights {
  return async (tile) => {
    const heights = new Float32Array(SIZE_PX * SIZE_PX);
    for (let row = 0; row < SIZE_PX; row++) {
      for (let column = 0; column < SIZE_PX; column++) {
        const globalColumn = tile.x * SIZE_PX + column;
        const globalRow = tile.y * SIZE_PX + row;
        heights[row * SIZE_PX + column] = eastM * globalColumn + southM * globalRow;
      }
    }
    return heights;
  };
}
