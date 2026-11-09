import assert from "node:assert/strict";
import { test } from "node:test";

import {
  basemapDescriptor,
  BASEMAP_MAXZOOM,
  BASEMAP_SOURCE_ID,
  inverseMercatorY,
  longitudeDelta,
  mercatorY,
  predictDestinationCenter,
  targetViewportBounds,
  tileRangeKey,
  tileInScene,
  viewportBoundsForCenter,
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

test("the destination prediction extrapolates the centre without moving", () => {
  const centre = predictDestinationCenter(0, 0, 2, 1, 0.5);

  assert.equal(centre.lng, 1);
  assert.equal(centre.lat, 0.5);
});

test("the explicit centre viewport matches the map helper for the same centre", () => {
  const map = fakeMap(8, 0, 0, 40, 20);
  const bounds = targetViewportBounds(map, 9)!;
  const current = { west: -20, south: -10, east: 20, north: 10 };
  const explicit = viewportBoundsForCenter(current, 0, 0, 8, 9);

  assert.equal(explicit.west, bounds.west);
  assert.equal(explicit.east, bounds.east);
});

test("the basemap descriptor prefers the loaded source over the style", () => {
  const template = "https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf";
  const live = {
    getSource: (id: string) => id === BASEMAP_SOURCE_ID ? { tiles: [template], maxzoom: 14 } : null,
    getStyle: () => ({ sources: {} }),
  };
  const inline = {
    getSource: () => null,
    getStyle: () => ({ sources: { [BASEMAP_SOURCE_ID]: { tiles: [template] } } }),
  };

  assert.deepEqual(basemapDescriptor(live), { template, maxzoom: 14 });
  assert.deepEqual(basemapDescriptor(inline), { template, maxzoom: BASEMAP_MAXZOOM });
  assert.equal(basemapDescriptor({ getSource: () => null }), null);
});

test("a shifted centre moves the vertical midpoint to the predicted latitude", () => {
  const current = { west: -1, south: -1, east: 1, north: 1 };
  const still = viewportBoundsForCenter(current, 0, 0, 8, 8);
  const north = viewportBoundsForCenter(current, 0, 10, 8, 8);

  assert.ok(Math.abs(still.south + still.north) < 1e-6);
  assert.ok(north.south > 8 && north.north > 10);
  assert.ok(north.south < 10 && north.north < 12);
  assert.equal(north.west, still.west);
  assert.ok(Math.abs(north.east - north.west - (still.east - still.west)) < 1e-9);
});

test("high latitudes stay finite around the predicted centre", () => {
  const current = { west: -1, south: 83.5, east: 1, north: 84.5 };
  const polar = viewportBoundsForCenter(current, 0, 84, 8, 8);

  assert.ok(Number.isFinite(polar.south) && Number.isFinite(polar.north));
  assert.ok(polar.north <= 85.05112878 + 1e-9);
  assert.ok(polar.south < 84 && 84 < polar.north);
});

test("longitude deltas wrap the dateline instead of spanning the world", () => {
  assert.equal(longitudeDelta(179, -179), 2);
  assert.equal(longitudeDelta(-179, 179), -2);
  assert.equal(longitudeDelta(10, 11), 1);
  assert.equal(longitudeDelta(10, 10), 0);
});

test("tile range keys ignore sub-tile pans but move with the covered tiles", () => {
  const bounds = { west: 0.3, south: 5.3, east: 0.4, north: 5.4 };
  const nudged = { west: 0.31, south: 5.31, east: 0.41, north: 5.41 };
  const shifted = { west: 5, south: 5.3, east: 5.1, north: 5.4 };

  assert.equal(tileRangeKey(bounds, 9), tileRangeKey(nudged, 9));
  assert.notEqual(tileRangeKey(bounds, 9), tileRangeKey(shifted, 9));
  assert.notEqual(tileRangeKey(bounds, 9), tileRangeKey(bounds, 10));
});

test("tile range keys clamp rows at the polar limit", () => {
  const polar = { west: 0, south: 80, east: 1, north: 89 };

  assert.match(tileRangeKey(polar, 4), /:0-\d+$/);
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
