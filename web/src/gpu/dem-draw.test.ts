import assert from "node:assert/strict";
import { test } from "node:test";

import { createDemHarness, SCENE_BBOX } from "./dem-draw-harness.test.ts";
import {
  ARRIVAL_FADE_MS,
  ArrivalFades,
  DemDraw,
  resolveSources,
  sourceUv,
  type FadeOf,
} from "./dem-draw.ts";
import type { PlacedTile, TileId } from "./dem-plan.ts";

const FINE_ZOOM = 7;

function quadOf(selfWeight: number, ancestorZooms = [6, 5]): PlacedTile {
  return {
    z: FINE_ZOOM,
    x: 40,
    y: 22,
    wrappedX: 40,
    selfWeight,
    parentWeight: 1 - selfWeight,
    ancestors: ancestorZooms.map((z) => ({
      z,
      x: 40 >> (FINE_ZOOM - z),
      y: 22 >> (FINE_ZOOM - z),
    })),
  };
}

/** A fade lookup from a table of zoom to fade, where a missing zoom is not ready. */
function fades(byZoom: Record<number, number>): FadeOf {
  return (tile: TileId) => byZoom[tile.z] ?? null;
}

function weightsByZoom(sources: ReturnType<typeof resolveSources>) {
  return Object.fromEntries(sources.map((source) => [source.tile.z, source.weight]));
}

test("a ready tile outside a blend draws alone at full weight", () => {
  const sources = resolveSources(quadOf(1), fades({ 7: 1, 6: 1, 5: 1 }));

  assert.deepEqual(weightsByZoom(sources), { 7: 1 });
});

test("an arriving tile fades in over its nearest ready ancestor", () => {
  const sources = resolveSources(quadOf(1), fades({ 7: 0.4, 6: 1 }));

  assert.deepEqual(weightsByZoom(sources), { 7: 0.4, 6: 0.6 });
});

test("three fading sources keep the two largest and scale them to sum to one", () => {
  const sources = resolveSources(quadOf(1), fades({ 7: 0.5, 6: 0.5, 5: 1 }));

  assert.equal(sources.length, 2);
  assert.equal(sources[0].tile.z, 7);
  assert.ok(Math.abs(sources[0].weight - 2 / 3) < 1e-12);
  assert.ok(Math.abs(sources[1].weight - 1 / 3) < 1e-12);
});

test("a missing fine tile mid-blend hands its weight to the lower level", () => {
  const sources = resolveSources(quadOf(0.6), fades({ 6: 1, 5: 1 }));

  assert.deepEqual(weightsByZoom(sources), { 6: 1 });
});

test("a missing fine tile and lower level fall back to the older ancestor", () => {
  const sources = resolveSources(quadOf(0.6), fades({ 5: 1 }));

  assert.deepEqual(weightsByZoom(sources), { 5: 1 });
});

test("a blend between two ready levels keeps both weights", () => {
  const sources = resolveSources(quadOf(0.7), fades({ 7: 1, 6: 1 }));

  assert.equal(sources.length, 2);
  assert.ok(Math.abs(weightsByZoom(sources)[7] - 0.7) < 1e-12);
  assert.ok(Math.abs(weightsByZoom(sources)[6] - 0.3) < 1e-12);
});

test("nothing ready draws nothing", () => {
  assert.deepEqual(resolveSources(quadOf(0.6), fades({})), []);
  assert.deepEqual(resolveSources(quadOf(1), fades({})), []);
});

test("a tile with nothing under it fades in over the basemap", () => {
  const sources = resolveSources(quadOf(1), fades({ 7: 0.5 }));

  assert.deepEqual(weightsByZoom(sources), { 7: 0.5 });
});

test("a fade and a blend at once keep the two largest weights and sum to one", () => {
  const sources = resolveSources(quadOf(0.5), fades({ 7: 0.5, 6: 0.5, 5: 1 }));

  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((source) => source.tile.z).sort(), [5, 6]);
  assert.ok(Math.abs(sources[0].weight - 0.5) < 1e-12);
  assert.ok(Math.abs(sources[1].weight - 0.5) < 1e-12);
});

test("a source tile is placed on the part of its texture the quad covers", () => {
  const quad = quadOf(1);

  assert.deepEqual(sourceUv(quad, { z: 7, x: 40, y: 22 }), [0, 0, 1]);
  assert.deepEqual(sourceUv(quad, { z: 5, x: 10, y: 5 }), [0, 0.5, 0.25]);
});

test("a quad at a wrapped column samples the wrapped ancestor", () => {
  const quad = { z: 3, wrappedX: 6, y: 5 };

  assert.deepEqual(sourceUv(quad, { z: 1, x: 1, y: 1 }), [0.5, 0.25, 0.25]);
});

/** A pool stand-in that says how long each tile has been able to draw. */
function drawableFor(byTile: Record<string, number | null>) {
  return { drawableForMs: (tile: TileId) => byTile[`${tile.z}/${tile.x}/${tile.y}`] ?? null };
}

test("a texture fades in over the fade time and then stays", () => {
  const drawableMs = { "5/1/1": 0 };
  const fadesOf = new ArrivalFades(drawableFor(drawableMs));
  const tile = { z: 5, x: 1, y: 1 };

  fadesOf.startFrame();

  assert.equal(fadesOf.fadeOf(tile), 0);
  assert.equal(fadesOf.isFading, true);

  drawableMs["5/1/1"] = ARRIVAL_FADE_MS / 2;

  assert.equal(fadesOf.fadeOf(tile), 0.5);

  drawableMs["5/1/1"] = ARRIVAL_FADE_MS * 2;
  fadesOf.startFrame();

  assert.equal(fadesOf.fadeOf(tile), 1);
  assert.equal(fadesOf.isFading, false);
});

test("a tile that cannot draw yet has no fade", () => {
  const fadesOf = new ArrivalFades(drawableFor({}));

  assert.equal(fadesOf.fadeOf({ z: 5, x: 1, y: 1 }), null);
});

test("an ancestor that was ready long before it is needed gives full weight at once", () => {
  const fadesOf = new ArrivalFades(drawableFor({ "6/20/11": 10 * ARRIVAL_FADE_MS }));
  const sources = resolveSources(quadOf(1), (tile) => fadesOf.fadeOf(tile));

  assert.deepEqual(weightsByZoom(sources), { 6: 1 });
  assert.equal(fadesOf.isFading, false);
});

function drawFrame(
  harness: ReturnType<typeof createDemHarness>,
  draw: DemDraw,
  drawQuad: Parameters<DemDraw["draw"]>[2] = () => {},
) {
  const wantsRepaint = draw.draw(
    harness.gl,
    harness.input.defaultProjectionData.mainMatrix,
    drawQuad,
  );
  harness.endFrame();

  return wantsRepaint;
}

/** Draw frames, letting loads land between them, until the pool has uploaded everything. */
async function drawnFrames(harness: ReturnType<typeof createDemHarness>, draw: DemDraw) {
  for (let frame = 0; frame < 12; frame++) {
    drawFrame(harness, draw);
    await harness.landLoads();
  }
}

function setup(fitZoom = 8) {
  const harness = createDemHarness();
  const draw = new DemDraw({
    map: harness.map,
    tileUrl: "https://dem/{z}/{x}/{y}.png",
    bbox: SCENE_BBOX,
    maxZoom: 12,
    fitZoom,
    poolOptions: harness.poolOptions,
  });
  const program = {} as WebGLProgram;
  draw.attach(harness.gl, program);

  return { harness, draw };
}

test("a frame asks the pool for the planned tiles before anything can draw", () => {
  const { harness, draw } = setup();

  const wantsRepaint = drawFrame(harness, draw);

  assert.ok(harness.workers.some((worker) => worker.requests.length > 0));
  assert.equal(harness.draws.length, 0);
  assert.equal(wantsRepaint, false);

  draw.detach(harness.gl);
});

test("landed tiles draw at full weight once their arrival fade is over", async () => {
  const { harness, draw } = setup();
  await drawnFrames(harness, draw);
  harness.draws.length = 0;
  harness.advance(ARRIVAL_FADE_MS);

  const quadWeights: number[][] = [];

  drawFrame(harness, draw, (sources) => {
    quadWeights.push(sources.map((source) => source.weight));
  });

  assert.ok(harness.draws.length > 0);
  assert.deepEqual(
    quadWeights.flat(),
    quadWeights.map(() => 1),
  );
  assert.ok(harness.draws.every((call) => call.textures.get(0) !== undefined));

  draw.detach(harness.gl);
});

test("a frame keeps asking for a repaint while tiles fade in", async () => {
  const { harness, draw } = setup();
  await drawnFrames(harness, draw);

  const wantsRepaint = drawFrame(harness, draw);

  assert.equal(wantsRepaint, true);

  harness.advance(ARRIVAL_FADE_MS);

  assert.equal(drawFrame(harness, draw), false);

  draw.detach(harness.gl);
});

test("outside a blend every quad draws from one sampler", async () => {
  const { harness, draw } = setup();
  harness.setZoom(8.7);
  await drawnFrames(harness, draw);
  harness.advance(ARRIVAL_FADE_MS);
  harness.draws.length = 0;

  drawFrame(harness, draw);

  const weights = harness.draws.map((call) => call.uniforms.get("uWeights") as number[]);

  assert.ok(weights.length > 0);
  assert.ok(weights.every(([, second]) => second === 0));
  assert.ok(harness.draws.every((call) => !call.textures.has(1)));

  draw.detach(harness.gl);
});

test("inside a blend a quad mixes two samplers that sum to one", async () => {
  const { harness, draw } = setup();
  harness.setZoom(8.5);
  await drawnFrames(harness, draw);
  harness.advance(ARRIVAL_FADE_MS);
  harness.draws.length = 0;

  drawFrame(harness, draw);

  const weights = harness.draws.map((call) => call.uniforms.get("uWeights") as number[]);

  assert.ok(weights.length > 0);
  assert.ok(weights.every(([first, second]) => second > 0 && Math.abs(first + second - 1) < 1e-9));
  assert.ok(harness.draws.every((call) => call.textures.has(1)));

  draw.detach(harness.gl);
});

test("detach gives back the geometry and stops the pool's workers", () => {
  const { harness, draw } = setup();

  draw.detach(harness.gl);

  assert.equal(harness.deleted.arrays.length, 1);
  assert.equal(harness.deleted.buffers.length, 1);
  assert.ok(harness.workers.every((worker) => worker.terminated));
});

/** The urls the pool has been asked to load, in request order. */
function loadUrls(harness: ReturnType<typeof createDemHarness>): string[] {
  return harness.workers
    .flatMap((worker) => worker.requests)
    .flatMap((request) => (request.type === "load" ? [request.url] : []));
}

test("the pinned base sits at the rounded fitted zoom the planner draws", () => {
  const { harness, draw } = setup(5.59);
  draw.loadBase(harness.gl);

  const urls = loadUrls(harness);

  assert.ok(urls.length > 0);
  assert.ok(urls.every((url) => url.includes("/6/")));

  draw.detach(harness.gl);
});

test("refitting across the half zoom moves the pinned base to the new round level", () => {
  const { harness, draw } = setup(5.4);
  draw.loadBase(harness.gl);

  const before = loadUrls(harness);

  assert.ok(before.length > 0);
  assert.ok(before.every((url) => url.includes("/5/")));

  draw.setFitZoom(5.6);
  harness.endFrame();
  draw.loadBase(harness.gl);

  const fresh = loadUrls(harness).slice(before.length);

  assert.ok(fresh.length > 0);
  assert.ok(fresh.every((url) => url.includes("/6/")));

  draw.detach(harness.gl);
});

test("refitting within the same round level loads nothing new", () => {
  const { harness, draw } = setup(5.4);
  draw.loadBase(harness.gl);

  const before = loadUrls(harness).length;
  draw.setFitZoom(5.1);
  harness.endFrame();
  draw.loadBase(harness.gl);

  assert.equal(loadUrls(harness).length, before);

  draw.detach(harness.gl);
});

test("a tenth below the fit still draws the floor level", () => {
  const { harness, draw } = setup(5.6);
  harness.setZoom(5.5);
  drawFrame(harness, draw);

  const urls = loadUrls(harness);

  assert.ok(urls.some((url) => url.includes("/5/")));
  assert.ok(urls.some((url) => url.includes("/6/")));

  draw.detach(harness.gl);
});
