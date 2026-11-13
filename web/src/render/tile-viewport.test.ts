import assert from "node:assert/strict";
import { test } from "node:test";

import {
  basemapDescriptor,
  BASEMAP_MAXZOOM,
  BASEMAP_SOURCE_ID,
  clipViewportToBbox,
  DWELL_REQUEST_CAP,
  dwellWarmTiles,
  inverseMercatorY,
  mercatorY,
  scenePyramidTiles,
  targetViewportBounds,
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

test("a shifted centre moves the vertical midpoint to the given latitude", () => {
  const current = { west: -1, south: -1, east: 1, north: 1 };
  const still = viewportBoundsForCenter(current, 0, 0, 8, 8);
  const north = viewportBoundsForCenter(current, 0, 10, 8, 8);

  assert.ok(Math.abs(still.south + still.north) < 1e-6);
  assert.ok(north.south > 8 && north.north > 10);
  assert.ok(north.south < 10 && north.north < 12);
  assert.equal(north.west, still.west);
  assert.ok(Math.abs(north.east - north.west - (still.east - still.west)) < 1e-9);
});

test("high latitudes stay finite around the given centre", () => {
  const current = { west: -1, south: 83.5, east: 1, north: 84.5 };
  const polar = viewportBoundsForCenter(current, 0, 84, 8, 8);

  assert.ok(Number.isFinite(polar.south) && Number.isFinite(polar.north));
  assert.ok(polar.north <= 85.05112878 + 1e-9);
  assert.ok(polar.south < 84 && 84 < polar.north);
});

test("the scene pyramid lists whole levels coarsest first until the next would overflow", () => {
  const tiles = scenePyramidTiles([10, 10, 12, 12], 5, 12, 40);

  assert.ok(tiles.length > 0 && tiles.length <= 40);
  const zooms = tiles.map((tile) => tile.z);
  assert.deepEqual(zooms, [...zooms].sort((first, second) => first - second));
  assert.ok(tiles.every((tile) => tileInScene(tile, [10, 10, 12, 12])));
  const deepest = Math.max(...zooms);
  const nextLevel = scenePyramidTiles([10, 10, 12, 12], deepest + 1, deepest + 1, 1000);
  assert.ok(tiles.length + nextLevel.length > 40);
});

test("the scene pyramid keeps the tiles nearest the centre first within a level", () => {
  const tiles = scenePyramidTiles([0, 0, 8, 8], 6, 6, 500);
  const centre = tiles[0];

  assert.deepEqual([centre.x, centre.y], [32, 31]);
});

test("the scene pyramid wraps a scene that crosses the antimeridian", () => {
  const tiles = scenePyramidTiles([171, 50, 231, 55], 4, 4, 100);
  const columns = new Set(tiles.map((tile) => tile.x));

  assert.ok(columns.has(15) && columns.has(0) && columns.has(2));
  assert.ok(tiles.every((tile) => tile.x >= 0 && tile.x < 16));
});

test("a first zoom past the last zoom lists nothing", () => {
  const tiles = scenePyramidTiles([10, 10, 10.1, 10.1], 12, 12, 10);

  assert.ok(tiles.length > 0 && tiles.every((tile) => tile.z === 12));
  assert.equal(scenePyramidTiles([10, 10, 12, 12], 13, 12, 10).length, 0);
});

test("a dwell warms ancestors first and stays inside the request cap", () => {
  const viewport = { west: -20, south: -10, east: 20, north: 10 };
  const tiles = dwellWarmTiles(viewport, 5, 9.3);
  const zooms = tiles.map((tile) => tile.z);

  assert.ok(tiles.length > 0 && tiles.length <= DWELL_REQUEST_CAP);
  assert.deepEqual(zooms, [...zooms].sort((first, second) => first - second));
  assert.ok(Math.min(...zooms) >= 5 && Math.max(...zooms) <= 11);
  const ancestors = tiles.filter((tile) => tile.z < 9);
  for (let zoom = 5; zoom < 9; zoom += 1) {
    assert.ok(ancestors.filter((tile) => tile.z === zoom).length <= 12);
  }
  assert.ok(tiles.filter((tile) => tile.z === 10).length <= 48);
  assert.ok(tiles.filter((tile) => tile.z === 11).length <= 16);
});

test("a dwell at the fitted zoom warms only the next two levels", () => {
  const viewport = { west: -20, south: -10, east: 20, north: 10 };
  const tiles = dwellWarmTiles(viewport, 8, 8);

  assert.ok(tiles.length > 0 && tiles.every((tile) => tile.z === 9 || tile.z === 10));
});

test("a dwell after a zoom out warms nothing below the current zoom", () => {
  const viewport = { west: -20, south: -10, east: 20, north: 10 };
  const tiles = dwellWarmTiles(viewport, 9, 6);

  assert.ok(tiles.length > 0 && tiles.every((tile) => tile.z >= 7));
});

test("a level beyond a zero budget is never listed", () => {
  assert.deepEqual(scenePyramidTiles([10, 10, 12, 12], 5, 12, 0), []);
});

test("a clipped viewport keeps the overlap and drops a disjoint one", () => {
  const overlap = clipViewportToBbox(
    { west: 36, south: -2, east: 38, north: 0 },
    [36.5, -1.5, 37.5, -0.5],
  );

  assert.deepEqual(overlap, { west: 36.5, south: -1.5, east: 37.5, north: -0.5 });
  assert.equal(
    clipViewportToBbox({ west: -20, south: -10, east: 20, north: 10 }, [36.5, -1.5, 37.5, -0.5]),
    null,
  );
});

test("a clipped viewport wraps a scene that crosses the antimeridian", () => {
  const overlap = clipViewportToBbox(
    { west: 170, south: 40, east: -170, north: 60 },
    [171, 50, 231, 55],
  );

  assert.deepEqual(overlap, { west: 171, south: 50, east: 190, north: 55 });
  assert.deepEqual(
    clipViewportToBbox({ west: 175, south: -20, east: -175, north: -15 }, [176, -19, 182, -16]),
    { west: 176, south: -19, east: 182, north: -16 },
  );
  assert.deepEqual(
    clipViewportToBbox(
      { west: -179.5, south: -20, east: -178.5, north: -15 },
      [176, -19, 182, -16],
    ),
    { west: -179.5, south: -19, east: -178.5, north: -16 },
  );
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
