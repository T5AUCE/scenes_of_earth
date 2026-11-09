import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inverseMercatorY,
  mercatorY,
  targetViewportBounds,
  tileInScene,
  type ViewportMap,
} from "./tile-viewport.ts";

const BBOX: [number, number, number, number] = [-15, -15, 15, 15];

test("the target viewport keeps the centre and halves the span per level", () => {
  const bounds = targetViewportBounds(fakeMap(8, 0, 0, 40, 20), 9)!;

  assert.equal(bounds.west, -10);
  assert.equal(bounds.east, 10);
  assert.ok(Math.abs(bounds.north + bounds.south) < 1e-9);
  assert.ok(bounds.north - bounds.south < 20);
});

test("the raster switch offset looks half a level ahead of the contour one", () => {
  const map = fakeMap(8, 0, 0, 40, 20);
  const contour = targetViewportBounds(map, 9)!;
  const raster = targetViewportBounds(map, 9, 0.5)!;

  assert.ok(raster.east - raster.west > contour.east - contour.west);
  assert.equal(raster.east - raster.west, (contour.east - contour.west) * Math.SQRT2);
  assert.equal((raster.west + raster.east) / 2, 0);
});

test("the target viewport unwraps a range that crosses the antimeridian", () => {
  const bounds = targetViewportBounds(fakeMap(8, 180, 0, 20, 20), 9)!;

  assert.equal(bounds.west, 175);
  assert.equal(bounds.east, 185);
});

test("tiles inside, outside and on the wrapped copy report correctly", () => {
  assert.equal(tileInScene({ z: 2, x: 1, y: 1 }, BBOX), true);
  assert.equal(tileInScene({ z: 2, x: 0, y: 0 }, BBOX), false);
  assert.equal(tileInScene({ z: 2, x: 3, y: 3 }, BBOX), false);
  assert.equal(tileInScene({ z: 2, x: 0, y: 1 }, [170, -10, 190, 10]), true);
});

test("the mercator pair round-trips without clamping the contour span", () => {
  assert.ok(Math.abs(inverseMercatorY(mercatorY(20)) - 20) < 1e-9);
  assert.notEqual(mercatorY(90), mercatorY(85.05112878));
});

test("a missing or zero-size canvas yields no viewport", () => {
  assert.equal(targetViewportBounds(zeroCanvasMap(), 9), null);
  assert.equal(targetViewportBounds(noCanvasMap(), 9), null);
});

test("the contour viewport keeps the earlier unclamped span above the limit", () => {
  const map = fakeMap(8, 0, 80, 40, 20);
  const contour = targetViewportBounds(map, 9)!;
  const clamped = targetViewportBounds(map, 9, 0, { clampLatitude: true })!;

  assert.notEqual(contour.north, clamped.north);
  assert.notEqual(contour.south, clamped.south);
});

function fakeMap(
  zoom: number,
  lng: number,
  lat: number,
  spanLng: number,
  spanLat: number,
  canvas = { clientWidth: 1280, clientHeight: 800 },
): ViewportMap {
  const map = {
    getZoom: () => zoom,
    getCenter: () => ({ lng, lat }),
    getCanvas: () => canvas,
    getBounds: () => ({
      getWest: () => lng - spanLng / 2,
      getEast: () => lng + spanLng / 2,
      getSouth: () => lat - spanLat / 2,
      getNorth: () => lat + spanLat / 2,
    }),
  };
  return map as unknown as ViewportMap;
}

function zeroCanvasMap(): ViewportMap {
  return fakeMap(8, 0, 0, 40, 20, { clientWidth: 0, clientHeight: 0 });
}

function noCanvasMap(): ViewportMap {
  const map = {
    getZoom: () => 8,
    getCenter: () => ({ lng: 0, lat: 0 }),
    getBounds: () => ({
      getWest: () => -20,
      getEast: () => 20,
      getSouth: () => -10,
      getNorth: () => 10,
    }),
  };
  return map as unknown as ViewportMap;
}
