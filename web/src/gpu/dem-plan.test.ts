import assert from "node:assert/strict";
import { test } from "node:test";

import type { Bbox } from "../types.ts";
import {
  DEFAULT_BLEND_WINDOW,
  demLevels,
  pinnedBase,
  planDemTiles,
  type DemPlanRequest,
} from "./dem-plan.ts";

const WINDOW = 0.1;
const KENYA_LIKE: Bbox = [34, -4.7, 41.9, 5.1];
const ANTIMERIDIAN: Bbox = [170, -10, 190, 10];

const worldX = (longitude: number) => (longitude + 180) / 360;
const worldY = (latitude: number) =>
  (1
    - Math.log(Math.tan((latitude * Math.PI) / 180) + 1 / Math.cos((latitude * Math.PI) / 180))
      / Math.PI)
  / 2;

// A view a few tiles wide around a point, at the tile size of the given level.
function request(overrides: Partial<DemPlanRequest> & { zoom: number }): DemPlanRequest {
  const half = 1.5 / 2 ** Math.round(overrides.zoom);
  const centre = { x: worldX(38), y: worldY(0) };

  return {
    view: {
      west: centre.x - half,
      east: centre.x + half,
      north: centre.y - half,
      south: centre.y + half,
    },
    bbox: KENYA_LIKE,
    fitLevel: 5,
    maxZoom: 12,
    blendWindow: WINDOW,
    ...overrides,
  };
}

const keyOf = (tile: { z: number; x: number; y: number }) => `${tile.z}/${tile.x}/${tile.y}`;

test("sharp level is the rounded zoom within the fit level and the max zoom", () => {
  assert.equal(demLevels(7.4, 5, 12, WINDOW).sharp, 7);
  assert.equal(demLevels(7.6, 5, 12, WINDOW).sharp, 8);
  assert.equal(demLevels(3, 5, 12, WINDOW).sharp, 5);
  assert.equal(demLevels(14.2, 5, 12, WINDOW).sharp, 12);
  assert.equal(demLevels(14.2, 5, 9, WINDOW).sharp, 9);
});

test("blend share climbs across the window around the half-zoom switch", () => {
  assert.equal(demLevels(7.4, 5, 12, WINDOW).fineShare, 0);
  assert.ok(Math.abs(demLevels(7.5, 5, 12, WINDOW).fineShare - 0.5) < 1e-9);
  assert.ok(Math.abs(demLevels(7.55, 5, 12, WINDOW).fineShare - 0.75) < 1e-9);
  assert.equal(demLevels(7.6, 5, 12, WINDOW).fineShare, 1);
  assert.deepEqual(
    [demLevels(7.5, 5, 12, WINDOW).lower, demLevels(7.5, 5, 12, WINDOW).fine],
    [7, 8],
  );
});

test("a zero window switches at once and ties go to the finer level", () => {
  assert.equal(demLevels(7.49, 5, 12, 0).fineShare, 0);
  assert.equal(demLevels(7.5, 5, 12, 0).fineShare, 1);
  assert.equal(demLevels(7.5, 5, 12, 0).sharp, 8);
});

test("share is 1 when the clamps make the two levels equal", () => {
  assert.equal(demLevels(12.5, 5, 12, WINDOW).fineShare, 1);
  assert.equal(demLevels(4.5, 5, 12, WINDOW).fineShare, 1);
  assert.equal(demLevels(4.5, 5, 12, WINDOW).lower, 5);
});

test("pinned base is the fit level over the scene while it needs at most 48 tiles", () => {
  const base = pinnedBase(KENYA_LIKE, 5);

  assert.equal(base.zoom, 5);
  assert.ok(base.tiles.length > 0 && base.tiles.length <= 48);
  assert.ok(base.tiles.every((tile) => tile.z === 5 && tile.tier === "pinned"));
});

test("pinned base moves one level coarser above 48 tiles", () => {
  const base = pinnedBase(KENYA_LIKE, 9);
  assert.equal(base.zoom, 8);
  assert.ok(base.tiles.every((tile) => tile.z === 8));
});

test("pinned base of a scene across the antimeridian holds wrapped tiles from both sides", () => {
  const base = pinnedBase(ANTIMERIDIAN, 4);
  const columns = new Set(base.tiles.map((tile) => tile.x));

  assert.ok(columns.has(15) && columns.has(0));
  assert.equal(new Set(base.tiles.map(keyOf)).size, base.tiles.length);
});

test("wanted tiles come in tier order with pinned first and no repeats", () => {
  const { wanted } = planDemTiles(request({ zoom: 7.5 }));
  const order = ["pinned", "view", "partner", "parent", "ring", "coarse"];
  const ranks = wanted.map((tile) => order.indexOf(tile.tier));

  assert.deepEqual(
    ranks,
    [...ranks].sort((left, right) => left - right),
  );
  assert.equal(new Set(wanted.map(keyOf)).size, wanted.length);
  assert.equal(wanted[0].tier, "pinned");
});

test("view tiles sit at the sharp level and start at the centre", () => {
  const { wanted, levels } = planDemTiles(request({ zoom: 7.2 }));
  const view = wanted.filter((tile) => tile.tier === "view");

  assert.ok(view.length > 1);
  assert.ok(view.every((tile) => tile.z === levels.sharp));

  const count = 2 ** levels.sharp;
  const distance = (tile: { x: number; y: number }) =>
    (tile.x + 0.5 - worldX(38) * count) ** 2 + (tile.y + 0.5 - worldY(0) * count) ** 2;
  const distances = view.map(distance);

  assert.deepEqual(
    distances,
    [...distances].sort((left, right) => left - right),
  );
});

test("no partner is wanted outside the blend window", () => {
  const { wanted, quads } = planDemTiles(request({ zoom: 7.3 }));
  assert.equal(wanted.filter((tile) => tile.tier === "partner").length, 0);
  assert.ok(quads.every((quad) => quad.z === 7 && quad.selfWeight === 1));
});

test("inside the window the finer level is the partner of a lower sharp level", () => {
  const { wanted, quads, levels } = planDemTiles(request({ zoom: 7.48 }));

  assert.equal(levels.sharp, 7);

  const partners = wanted.filter((tile) => tile.tier === "partner");

  assert.ok(partners.length > 0 && partners.every((tile) => tile.z === 8));
  assert.ok(quads.every((quad) => quad.z === 8));
  assert.ok(quads.every((quad) => Math.abs(quad.selfWeight + quad.parentWeight - 1) < 1e-9));
  assert.ok(quads[0].selfWeight < 0.5);
});

test("inside the window the lower level is the partner of a finer sharp level", () => {
  const { wanted, quads, levels } = planDemTiles(request({ zoom: 7.52 }));

  assert.equal(levels.sharp, 8);

  const partners = wanted.filter((tile) => tile.tier === "partner");

  assert.ok(partners.length > 0 && partners.every((tile) => tile.z === 7));
  assert.ok(quads[0].selfWeight > 0.5);
});

test("parents cover the view one level below the sharp level", () => {
  const { wanted } = planDemTiles(request({ zoom: 7.3 }));
  const parents = wanted.filter((tile) => tile.tier === "parent");
  assert.ok(parents.length > 0 && parents.every((tile) => tile.z === 6));
});

test("ring tiles are the one-tile border of the view and lean towards the heading", () => {
  const plain = planDemTiles(request({ zoom: 9.3 }));
  const view = plain.wanted.filter((tile) => tile.tier === "view");
  const ring = plain.wanted.filter((tile) => tile.tier === "ring");
  const viewKeys = new Set(view.map(keyOf));

  const columns = view.map((tile) => tile.x);
  const rows = view.map((tile) => tile.y);
  const [minX, maxX] = [Math.min(...columns), Math.max(...columns)];
  const [minY, maxY] = [Math.min(...rows), Math.max(...rows)];

  assert.ok(ring.length > 0 && ring.every((tile) => !viewKeys.has(keyOf(tile))));
  assert.ok(ring.every((tile) => tile.x >= minX - 1 && tile.x <= maxX + 1));
  assert.ok(ring.every((tile) => tile.y >= minY - 1 && tile.y <= maxY + 1));

  const first = (heading: { x: number; y: number }) =>
    planDemTiles(request({ zoom: 9.3, heading })).wanted.find((tile) => tile.tier === "ring")!;

  assert.equal(first({ x: 1, y: 0 }).x, maxX + 1);
  assert.equal(first({ x: -1, y: 0 }).x, minX - 1);
  assert.equal(first({ x: 0, y: -1 }).y, minY - 1);
  assert.equal(first({ x: 0, y: 1 }).y, maxY + 1);
});

test("tiles outside the scene are never wanted or drawn", () => {
  const wide = request({ zoom: 7.3 });
  const half = 40 / 2 ** 7;
  wide.view = { west: worldX(38) - half, east: worldX(38) + half, north: 0.4, south: 0.6 };

  const { wanted, quads } = planDemTiles(wide);
  const count = 2 ** 7;
  const westEdge = Math.floor(worldX(KENYA_LIKE[0]) * count);
  const eastEdge = Math.floor(worldX(KENYA_LIKE[2]) * count);
  const columns = wanted.filter((tile) => tile.z === 7).map((tile) => tile.x);

  assert.ok(columns.every((x) => x >= westEdge && x <= eastEdge));
  assert.ok(quads.every((quad) => quad.x >= westEdge && quad.x <= eastEdge));
});

test("quads keep an unwrapped x while textures use the wrapped key", () => {
  const shifted = request({ zoom: 7.3 });
  shifted.view = {
    west: shifted.view.west + 1,
    east: shifted.view.east + 1,
    north: shifted.view.north,
    south: shifted.view.south,
  };

  const { quads, wanted } = planDemTiles(shifted);
  const count = 2 ** 7;

  assert.ok(quads.length > 0);
  assert.ok(quads.every((quad) => quad.x >= count && quad.wrappedX === quad.x - count));
  assert.ok(wanted.every((tile) => tile.x >= 0 && tile.x < count));
});

test("a view across the antimeridian wants tiles from both ends of the world", () => {
  const half = 3 / 2 ** 6;
  const { wanted, quads } = planDemTiles({
    zoom: 6,
    view: { west: 1 - half, east: 1 + half, north: 0.45, south: 0.55 },
    bbox: ANTIMERIDIAN,
    fitLevel: 4,
    maxZoom: 12,
    blendWindow: WINDOW,
  });
  const columns = new Set(wanted.filter((tile) => tile.tier === "view").map((tile) => tile.x));

  assert.ok(columns.has(63) && columns.has(0));
  assert.ok(quads.some((quad) => quad.x >= 64) && quads.some((quad) => quad.x < 64));
});

test("ancestor chains run from the parent down to the pinned level", () => {
  const { quads, baseZoom } = planDemTiles(request({ zoom: 8 }));
  const quad = quads[0];

  assert.equal(baseZoom, 5);
  assert.deepEqual(
    quad.ancestors.map((tile) => tile.z),
    [7, 6, 5],
  );
  assert.deepEqual(
    quad.ancestors.map((tile) => [tile.x, tile.y]),
    [1, 2, 3].map((up) => [quad.wrappedX >> up, quad.y >> up]),
  );
});

test("the pinned level has no ancestors to fall back on", () => {
  const { quads } = planDemTiles(request({ zoom: 5 }));
  assert.ok(quads.length > 0 && quads.every((quad) => quad.ancestors.length === 0));
});

test("the default blend window applies when the request names none", () => {
  const withDefault = planDemTiles(request({ zoom: 7.52, blendWindow: undefined }));
  const share = demLevels(7.52, 5, 12, DEFAULT_BLEND_WINDOW).fineShare;
  assert.equal(withDefault.levels.fineShare, share);
});

test("a window wider than half a zoom is limited so the share has no jump at whole zooms", () => {
  const below = demLevels(6.999, 5, 12, 1).fineShare;
  const above = 1 - demLevels(7.001, 5, 12, 1).fineShare;
  assert.ok(Math.abs(below - above) < 0.01);
});

test("chains end at a pinned level one coarser than the fit level", () => {
  const { quads, baseZoom } = planDemTiles(request({ zoom: 10, fitLevel: 9 }));

  assert.equal(baseZoom, 8);
  assert.ok(quads.length > 0);
  assert.deepEqual(
    quads[0].ancestors.map((tile) => tile.z),
    [9, 8],
  );
});

// A scene that covers exactly the given block of level 4 tiles, inset from the tile edges.
function blockOfLevel4(columns: number, rows: number): Bbox {
  const count = 2 ** 4;
  const inset = 0.05;
  const latitudeOf = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / count))) * 180) / Math.PI;

  return [
    -180 + (inset / count) * 360,
    latitudeOf(6 + rows - inset),
    -180 + ((columns - inset) / count) * 360,
    latitudeOf(6 + inset),
  ];
}

test("the pinned base keeps exactly 48 tiles and moves coarser at 49", () => {
  const kept = pinnedBase(blockOfLevel4(12, 4), 4);

  assert.deepEqual([kept.zoom, kept.tiles.length], [4, 48]);

  const coarser = pinnedBase(blockOfLevel4(7, 7), 4);

  assert.equal(coarser.zoom, 3);
});

test("no parent tier is wanted at the fit level", () => {
  const { wanted } = planDemTiles(request({ zoom: 5 }));
  assert.equal(wanted.filter((tile) => tile.tier === "parent").length, 0);
});

test("coarse tiles keep the four lower levels after the ring", () => {
  const { wanted, levels } = planDemTiles(request({ zoom: 10.3 }));

  assert.equal(levels.sharp, 10);

  const coarse = wanted.filter((tile) => tile.tier === "coarse");

  assert.ok(coarse.length > 0);
  assert.deepEqual(
    [...new Set(coarse.map((tile) => tile.z))].sort((left, right) => left - right),
    [6, 7, 8, 9],
  );

  const lastRing = wanted.map((tile) => tile.tier).lastIndexOf("ring");
  const firstCoarse = wanted.findIndex((tile) => tile.tier === "coarse");

  assert.ok(firstCoarse > lastRing);
});

test("the first coarse level covers more than the parent tier", () => {
  const { wanted } = planDemTiles(request({ zoom: 8.3 }));

  const parents = wanted.filter((tile) => tile.tier === "parent");
  const depthOne = wanted.filter((tile) => tile.tier === "coarse" && tile.z === 7);

  assert.ok(parents.length > 0 && depthOne.length > 0);

  const rows = (tiles: { y: number }[]) => tiles.map((tile) => tile.y);

  assert.ok(Math.min(...rows(depthOne)) < Math.min(...rows(parents)));
  assert.ok(Math.max(...rows(depthOne)) > Math.max(...rows(parents)));
});

test("a zoom-out of one to three levels finds its view tiles already wanted", () => {
  const settled = planDemTiles(request({ zoom: 9.3 }));
  const settledKeys = new Set(settled.wanted.filter((tile) => tile.tier !== "pinned").map(keyOf));

  for (let out = 1; out <= 3; out += 1) {
    const zoomed = planDemTiles(request({ zoom: 9.3 - out }));
    const view = zoomed.wanted.filter((tile) => tile.tier === "view");

    assert.ok(view.length > 0);

    for (const tile of view) {
      assert.ok(settledKeys.has(keyOf(tile)), `zoom-out by ${out} misses ${keyOf(tile)}`);
    }
  }
});

test("a zoom-out of four levels lands on the coarsest coarse tier", () => {
  const settled = planDemTiles(request({ zoom: 10.3 }));
  const coarsest = new Set(
    settled.wanted.filter((tile) => tile.tier === "coarse" && tile.z === 6).map(keyOf),
  );

  const zoomed = planDemTiles(request({ zoom: 6.3 }));
  const view = zoomed.wanted.filter((tile) => tile.tier === "view");

  assert.ok(view.length > 0);

  for (const tile of view) {
    assert.ok(coarsest.has(keyOf(tile)), `zoom-out by 4 misses ${keyOf(tile)}`);
  }
});

test("no coarse tier is wanted at the fit level", () => {
  const { wanted } = planDemTiles(request({ zoom: 5 }));

  assert.equal(wanted.filter((tile) => tile.tier === "coarse").length, 0);
});

test("a view far below the fit zoom plans a bounded number of tiles", () => {
  const plan = planDemTiles({
    zoom: 2,
    view: { west: -1, east: 2, north: 0, south: 1 },
    bbox: KENYA_LIKE,
    fitLevel: 9,
    maxZoom: 12,
    blendWindow: WINDOW,
  });

  assert.ok(plan.wanted.length < 600);
  assert.ok(plan.quads.length < 600);
});
