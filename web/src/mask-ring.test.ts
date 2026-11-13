import assert from "node:assert/strict";
import { test } from "node:test";

import { GeoJSONVT } from "@maplibre/geojson-vt";
import earcut from "earcut";

import { maskRing } from "./mask-ring.ts";

type Ring = number[][];

// These are the options MapLibre's GeoJSON source gives its tiler.
const EXTENT_UNITS = 8192;
const TILE_SIZE_PX = 512;
const BUFFER_UNITS = (128 * EXTENT_UNITS) / TILE_SIZE_PX;

const MAX_TILE_ZOOM = 8;
const SAMPLES_PER_SIDE = 32;
const MAX_WRONG_FRACTION = 0.02;

const GRID_LIMIT_UNITS = 2 ** 14;

test("mask ring keeps every island vertex", () => {
  const islands = [square(0, 0, 1), square(5, 5, 2)];

  const ring = maskRing(islands);

  for (const vertex of islands.flat()) {
    assert.ok(ring.some(([x, y]) => x === vertex[0] && y === vertex[1]));
  }
});

test("mask ring is closed and its slits run opposite to the world winding", () => {
  const island = square(5, 5, 2);

  const ring = maskRing([island]);

  const [west, south] = [ring[0][0], ring[0][1]];
  assert.deepEqual(ring[ring.length - 1], [west, south]);
  const winding = Math.sign(signedArea(ring));
  const withoutIsland = Math.sign(signedArea(ring.slice(0, 4).concat([ring[0]])));
  assert.equal(winding, withoutIsland);
});

test("mask ring joins islands by slits that enclose no area", () => {
  const islands = [square(0, 0, 1), square(5, 5, 2)];

  const ring = maskRing(islands);

  const worldArea = Math.abs(signedArea(ring)) / 2;
  const cutArea = islands.reduce((sum, island) => sum + Math.abs(signedArea(island)) / 2, 0);
  const world = 360 * 2 * 85.051129;
  assert.ok(Math.abs(worldArea - (world - cutArea)) < 1e-6);
});

test("mask ring is centred on the islands and spans the map's latitudes", () => {
  const ring = maskRing([square(100, 10, 20)]);

  const longitudes = ring.map(([x]) => x);
  const latitudes = ring.map(([, y]) => y);
  assert.equal(longitudes.reduce((a, b) => Math.min(a, b)), -70);
  assert.equal(longitudes.reduce((a, b) => Math.max(a, b)), 290);
  assert.equal(latitudes.reduce((a, b) => Math.max(a, b)), 85.051129);
});

test("mask ring handles a country with many thousands of vertices", () => {
  const island = Array.from({ length: 300_000 }, (_, step) => {
    const angle = (step / 300_000) * 2 * Math.PI;
    return [Math.cos(angle), Math.sin(angle)];
  });
  island.push(island[0]);

  const ring = maskRing([island, square(20, 20, 1)]);

  assert.equal(ring.length, 4 + (300_000 + 3) + (4 + 3) + 1);
});

test("mask ring rejects an island it cannot reach from the north", () => {
  assert.throws(() => maskRing([square(0, 84, 1.5)]), /no ring above/);
});

test("mask tiles never fill over sliver islands around a mainland", () => {
  assertNoOverfilledTiles(mainlandWithSlivers());
});

test("mask tiles never fill over slivers around an outline crossing the antimeridian", () => {
  assertNoOverfilledTiles(outlineAcrossAntimeridian());
});

// Lists slivers first so MapLibre reads the flipped winding that breaks the old mask.
const mainlandWithSlivers = () => [
  ...slivers(50, 7, [0, 40], 7),
  roughOutline([-0.3, 40], 4, 0.05, 3),
];

const outlineAcrossAntimeridian = () => [
  ...slivers(60, 11, [179, -20], 4),
  roughOutline([179, -20], 3, 0.002, 5),
];

const square = (west: number, south: number, size: number): Ring => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];

function slivers(count: number, seed: number, centre: number[], distance: number): Ring[] {
  const next = random(seed);
  return Array.from({ length: count }, () => {
    const length = 10 ** (-4 + 3 * next());
    const angle = 2 * Math.PI * next();
    const x = centre[0] + (distance + 2 * next()) * Math.cos(angle);
    const y = centre[1] + (distance + 2 * next()) * Math.sin(angle);
    return [[x, y], [x + length, y + length * 0.4], [x + length * 0.7, y + length * 0.3], [x, y]];
  });
}

function roughOutline(centre: number[], radius: number, noise: number, seed: number): Ring {
  const next = random(seed);
  const ring = Array.from({ length: 400 }, (_, step) => {
    const angle = (step / 400) * 2 * Math.PI;
    const wobble = radius + noise * (next() - 0.5) + 0.2 * radius * Math.sin(5 * angle);
    return [wobble * Math.cos(angle) + centre[0], wobble * Math.sin(angle) + centre[1]];
  });

  return [...ring, ring[0]];
}

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

function assertNoOverfilledTiles(areaRings: Ring[]) {
  const mask = {
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates: [[maskRing(areaRings)]] },
  };
  const tiler = new GeoJSONVT(mask, {
    maxZoom: 18,
    buffer: BUFFER_UNITS,
    tolerance: 0,
    extent: EXTENT_UNITS,
    lineMetrics: false,
    generateId: false,
    updateable: true,
  });

  const wrong: string[] = [];
  for (let zoom = 0; zoom <= MAX_TILE_ZOOM; zoom++) {
    for (const [x, y] of tilesOverArea(areaRings, zoom)) {
      const fraction = wrongFraction(tiler, areaRings, zoom, x, y);
      if (fraction > MAX_WRONG_FRACTION) wrong.push(`${zoom}/${x}/${y} ${fraction.toFixed(3)}`);
    }
  }

  assert.deepEqual(wrong, []);
}

function* tilesOverArea(rings: Ring[], zoom: number) {
  const size = 2 ** zoom;
  const worldX = rings.flat().map(([longitude]) => (longitude + 180) / 360);
  const worldY = rings.flat().map(([, latitude]) => mercatorY(latitude));
  const first = (values: number[]) => Math.floor(values.reduce((a, b) => Math.min(a, b)) * size);
  const last = (values: number[]) => Math.floor(values.reduce((a, b) => Math.max(a, b)) * size);
  for (let x = first(worldX); x <= last(worldX); x++) {
    for (let y = first(worldY); y <= last(worldY); y++) {
      yield [((x % size) + size) % size, y];
    }
  }
}

function wrongFraction(tiler: GeoJSONVT, areaRings: Ring[], zoom: number, x: number, y: number) {
  const tile = tiler.getTile(zoom, x, y);
  const painted = paintSamples(tile ? triangulate(tile.features) : []);
  const size = 2 ** zoom;
  let wrong = 0;
  for (let row = 0; row < SAMPLES_PER_SIDE; row++) {
    for (let column = 0; column < SAMPLES_PER_SIDE; column++) {
      const longitude = ((x + (column + 0.5) / SAMPLES_PER_SIDE) / size) * 360 - 180;
      const latitude = latitudeOf((y + (row + 0.5) / SAMPLES_PER_SIDE) / size);
      const isPainted = painted[row * SAMPLES_PER_SIDE + column] === 1;
      const isArea =
        isInside(areaRings, longitude, latitude) || isInside(areaRings, longitude + 360, latitude);
      if (isPainted === isArea) wrong++;
    }
  }

  return wrong / SAMPLES_PER_SIDE ** 2;
}

// This follows MapLibre's fill bucket, which rounds to the tile grid and splits rings by winding.
function triangulate(features: { type: number; geometry: number[][][] }[]) {
  const triangles: number[][][] = [];
  for (const feature of features) {
    if (feature.type !== 3) continue;

    const rings = feature.geometry.map((ring) =>
      ring.map(([x, y]) => [clampToGrid(Math.round(x)), clampToGrid(Math.round(y))]),
    );
    for (const polygon of splitByWinding(rings)) {
      const flat = polygon.flat(2);
      const holeStarts: number[] = [];
      let vertices = polygon[0].length;
      for (const hole of polygon.slice(1)) {
        holeStarts.push(vertices);
        vertices += hole.length;
      }
      const indices = earcut(flat, holeStarts);
      for (let i = 0; i < indices.length; i += 3) {
        triangles.push(
          [0, 1, 2].map((k) => [flat[indices[i + k] * 2], flat[indices[i + k] * 2 + 1]]),
        );
      }
    }
  }

  return triangles;
}

function splitByWinding(rings: Ring[]): Ring[][] {
  const polygons: Ring[][] = [];
  let firstWinding = 0;
  for (const ring of rings) {
    const winding = Math.sign(signedArea(ring));
    if (winding === 0) continue;

    firstWinding ||= winding;
    if (winding === firstWinding) polygons.push([ring]);
    else polygons[polygons.length - 1].push(ring);
  }

  return polygons;
}

function paintSamples(triangles: number[][][]) {
  const painted = new Uint8Array(SAMPLES_PER_SIDE ** 2);
  const scale = SAMPLES_PER_SIDE / EXTENT_UNITS;
  for (const [a, b, c] of triangles) {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (area === 0) continue;

    const xs = [a[0], b[0], c[0]].map((value) => value * scale);
    const ys = [a[1], b[1], c[1]].map((value) => value * scale);
    const columns = [Math.floor(Math.min(...xs)), Math.ceil(Math.max(...xs))];
    const rows = [Math.floor(Math.min(...ys)), Math.ceil(Math.max(...ys))];
    const lastSample = SAMPLES_PER_SIDE - 1;
    for (let row = Math.max(0, rows[0]); row <= Math.min(lastSample, rows[1]); row++) {
      for (let col = Math.max(0, columns[0]); col <= Math.min(lastSample, columns[1]); col++) {
        const point = [(col + 0.5) / scale, (row + 0.5) / scale];
        if (isInTriangle(point, a, b, c, area)) painted[row * SAMPLES_PER_SIDE + col] = 1;
      }
    }
  }

  return painted;
}

function isInTriangle(point: number[], a: number[], b: number[], c: number[], area: number) {
  const cross = (p: number[], q: number[]) =>
    ((q[0] - p[0]) * (point[1] - p[1]) - (q[1] - p[1]) * (point[0] - p[0])) * Math.sign(area);

  return cross(a, b) >= 0 && cross(b, c) >= 0 && cross(c, a) >= 0;
}

const signedArea = (ring: Ring) => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
  }

  return sum;
};

function isInside(rings: Ring[], longitude: number, latitude: number) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[j];
      if (y1 > latitude === y2 > latitude) continue;

      const crossing = x1 + ((latitude - y1) / (y2 - y1)) * (x2 - x1);
      if (crossing > longitude) inside = !inside;
    }
  }

  return inside;
}

function clampToGrid(value: number) {
  return Math.min(GRID_LIMIT_UNITS - 1, Math.max(-GRID_LIMIT_UNITS, value));
}

const mercatorY = (latitude: number) => {
  const sine = Math.sin((latitude * Math.PI) / 180);
  return 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
};

const latitudeOf = (worldY: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180) / Math.PI;
