import assert from "node:assert/strict";
import { test } from "node:test";

import { contourLadder } from "../contour-ladder.ts";
import { RELIEF_STRENGTH } from "../layers/relief.ts";
import { CONTOUR_COLORS } from "../render/palettes.ts";
import type { TerrainStats } from "../types.ts";
import { addContourLineLayer, type ContourLineHandle } from "./contour-line-layer.ts";
import { CONTOUR_OPACITY } from "./contour-shaders.ts";
import { ARRIVAL_FADE_MS } from "./dem-draw.ts";
import { createDemHarness, SCENE_BBOX } from "./dem-draw-harness.test.ts";
import { addReliefLayer } from "./relief-layer.ts";

const ZOOM = 8;
const BROWN = CONTOUR_COLORS[0].color;
const TILE_URL = "https://dem/{z}/{x}/{y}.png";
const STATS: TerrainStats = {
  min: 1,
  max: 820,
  mean: 100,
  p2: 6,
  p98: 700,
  slope_p50_deg: 5,
  slope_p90_deg: 10,
  cell_m: 500,
};
const METRES_PER_FOOT = 0.3048;

type Harness = ReturnType<typeof createDemHarness>;

test("the layer links its program when added and fails nothing", () => {
  const { harness, handle } = setup();

  assert.ok(harness.map.getLayer("terrain-contour-lines"));
  assert.equal(harness.failures.length, 0);
  finish(harness, handle);
});

test("landed tiles draw with the ladder, the colour and the pixel ratio", async () => {
  const { harness, handle } = setup({ pixelRatio: 2 });
  await renderFrames(harness);
  harness.advance(ARRIVAL_FADE_MS);
  harness.draws.length = 0;

  render(harness);

  assert.ok(harness.draws.length > 0);
  const [red, green, blue] = [0x5b, 0x46, 0x36].map((channel) => channel / 255);
  for (const call of harness.draws) {
    assert.deepEqual(call.uniforms.get("uIntervals"), [2000, 1000, 500, 100, 50, 10]);
    assert.deepEqual(call.uniforms.get("uColour"), [red, green, blue]);
    assert.equal(call.uniforms.get("uPixelRatio"), 2);
  }
  finish(harness, handle);
});

test("the tier opacities follow the zoom's fade from each entry zoom", async () => {
  const { harness, handle } = setup();
  await renderFrames(harness);
  harness.advance(ARRIVAL_FADE_MS);

  render(harness);

  const alphas = harness.uniforms.get("uTierAlpha") as number[];
  // At zoom 8 the 2000 m tier entered at 5 is full, the 500 m tier entered at 7 is two thirds.
  assert.ok(Math.abs(alphas[0] - CONTOUR_OPACITY) < 1e-6);
  assert.ok(Math.abs(alphas[2] - CONTOUR_OPACITY * (8 - 7) / 1.5) < 1e-6);
  assert.deepEqual(alphas.slice(3), [0, 0, 0]);
  finish(harness, handle);
});

test("before the first tier enters nothing is requested or drawn", () => {
  const { harness, handle } = setup();
  harness.setZoom(4);

  render(harness);

  assert.equal(harness.workers.flatMap((worker) => worker.requests).length, 0);
  assert.equal(harness.draws.length, 0);
  finish(harness, handle);
});

test("a new ladder and unit only change uniforms and ask for a repaint", async () => {
  const { harness, handle } = setup();
  await renderFrames(harness);
  harness.advance(ARRIVAL_FADE_MS);
  const loadsBefore = harness.workers.flatMap((worker) => worker.requests).length;
  const repaintsBefore = harness.repaints();

  handle.setLadder(contourLadder(STATS, { elevationUnit: "ft" }), "ft");
  render(harness);

  assert.ok(harness.repaints() > repaintsBefore);
  const intervals = harness.uniforms.get("uIntervals") as number[];
  assert.ok(Math.abs(intervals[0] - 5000 * METRES_PER_FOOT) < 1e-3);
  assert.equal(harness.workers.flatMap((worker) => worker.requests).length, loadsBefore);
  finish(harness, handle);
});

test("a new colour reaches the next draw", async () => {
  const { harness, handle } = setup();
  await renderFrames(harness);
  harness.advance(ARRIVAL_FADE_MS);

  handle.setColor(CONTOUR_COLORS[2].color);
  render(harness);

  const channel = 0x1f / 255;
  assert.deepEqual(harness.uniforms.get("uColour"), [channel, channel, channel]);
  finish(harness, handle);
});

test("the layer repaints while tiles fade in and stops once they have", async () => {
  const { harness, handle } = setup();
  await renderFrames(harness);
  const duringFade = harness.repaints();

  render(harness);
  assert.ok(harness.repaints() > duringFade);
  harness.advance(ARRIVAL_FADE_MS);
  render(harness);
  const settled = harness.repaints();
  render(harness);

  assert.equal(harness.repaints(), settled);
  finish(harness, handle);
});

test("a context without float linear filtering fails the layer and draws nothing", async () => {
  const { harness, handle } = setup({ linear: false });

  render(harness);
  await Promise.resolve();

  assert.equal(harness.failures.length, 1);
  assert.match(harness.failures[0].message, /linear filtering/);
  assert.equal(harness.draws.length, 0);
  finish(harness, handle);
});

test("relief and contours share one pool and its workers", async () => {
  const single = setup();
  const workersOfOne = single.harness.workers.length;
  finish(single.harness, single.handle);
  const harness = createHarness();
  const relief = addRelief(harness);
  const lines = addLines(harness);

  assert.equal(harness.workers.length, workersOfOne);
  await renderFrames(harness);
  render(harness, "terrain-relief");
  harness.advance(ARRIVAL_FADE_MS);
  harness.draws.length = 0;
  render(harness, "terrain-relief");
  const reliefDraws = harness.draws.length;
  render(harness, "terrain-contour-lines");

  assert.ok(reliefDraws > 0);
  assert.ok(harness.draws.length > reliefDraws);
  lines.destroy();
  assert.ok(harness.workers.every((worker) => !worker.terminated));
  relief.destroy();
  assert.ok(harness.workers.every((worker) => worker.terminated));
});

test("relief and contours together upload within the per-frame budget", async () => {
  const harness = createHarness();
  const relief = addRelief(harness);
  const lines = addLines(harness);
  const layers = ["terrain-relief", "terrain-contour-lines"].map((id) =>
    harness.map.getLayer(id) as unknown as {
      render(gl: WebGL2RenderingContext, input: unknown): void;
    });
  let created = 0;

  for (let frame = 0; frame < 12; frame++) {
    for (const layer of layers) layer.render(harness.gl, harness.input);
    harness.endFrame();
    assert.ok(harness.created().length - created <= 8, `frame ${frame}`);
    created = harness.created().length;
    await harness.landLoads();
  }

  assert.ok(created > 2);
  lines.destroy();
  relief.destroy();
});

test("removing the layer frees its program and geometry and stops the workers", () => {
  const { harness, handle } = setup();

  handle.destroy();

  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.arrays.length, 1);
  assert.equal(harness.deleted.buffers.length, 1);
  assert.ok(harness.workers.every((worker) => worker.terminated));
});

test("prepare warms the line program once with a draw that writes no pixel", () => {
  const { harness, handle } = setup();

  handle.prepare();
  handle.prepare();

  assert.equal(harness.draws.length, 1);
  assert.deepEqual(harness.draws[0].colorMask, [false, false, false, false]);
  assert.equal(harness.draws[0].isScissored, true);
  finish(harness, handle);
});

test("relief and contours prepare on one pool and request each pinned tile once", async () => {
  const harness = createHarness();
  const relief = addRelief(harness);
  const lines = addLines(harness);

  relief.prepare();
  lines.prepare();
  harness.endFrame();
  await harness.landLoads();
  for (let step = 0; step < 10; step++) {
    harness.endFrame();
    const isSettled = [relief.prepare(), lines.prepare()].every(Boolean);
    if (isSettled) break;

    await harness.landLoads();
  }
  harness.endFrame();

  const loads = harness.workers.flatMap((worker) => worker.requests)
    .filter((request) => request.type === "load");
  assert.equal(new Set(loads.map((request) => request.id)).size, loads.length);
  assert.equal(harness.created().length, loads.length);
  assert.equal(relief.prepare() && lines.prepare(), true);
  relief.destroy();
  lines.destroy();
});

test("paired prepares share one per-frame budget across both layers", async () => {
  const harness = createHarness();
  const relief = addRelief(harness);
  const lines = addLines(harness);

  relief.prepare();
  harness.endFrame();
  await harness.landLoads();
  harness.endFrame();

  const before = harness.created().length;
  relief.prepare();
  lines.prepare();

  const uploaded = harness.created().length - before;
  assert.ok(uploaded > 2);
  assert.ok(uploaded <= 8);
  harness.endFrame();

  assert.equal(relief.prepare() && lines.prepare(), true);
  relief.destroy();
  lines.destroy();
});

test("prepare settles at once for a layer that cannot draw", () => {
  const { harness, handle } = setup({ linear: false });

  assert.equal(handle.prepare(), true);
  assert.equal(harness.draws.length, 0);
  finish(harness, handle);
});

function setup(options: { linear?: boolean; pixelRatio?: number } = {}) {
  const harness = createHarness(options);
  const handle = addLines(harness);
  return { harness, handle };
}

function createHarness(options: { linear?: boolean; pixelRatio?: number } = {}): Harness {
  const harness = createDemHarness(options);
  Object.assign(harness.gl, {
    uniform1fv: (name: string, values: Float32Array) => harness.uniforms.set(name, [...values]),
  });
  Object.assign(harness.map, { getPixelRatio: () => options.pixelRatio ?? 1 });
  return harness;
}

function addLines(harness: Harness): ContourLineHandle {
  return addContourLineLayer(
    {
      map: harness.map,
      id: "terrain-contour-lines",
      tileUrl: TILE_URL,
      bbox: SCENE_BBOX,
      shift: 0,
      maxZoom: 12,
      fitZoom: ZOOM,
      ladder: contourLadder(STATS),
      elevationUnit: "m",
      color: BROWN,
      onFail: (error) => harness.failures.push(error),
      poolOptions: harness.poolOptions,
    },
    "soe-slot-lines",
  );
}

async function renderFrames(harness: Harness, frames = 12) {
  for (let frame = 0; frame < frames; frame++) {
    render(harness);
    await harness.landLoads();
  }
}

function render(harness: Harness, id = "terrain-contour-lines") {
  const layer = harness.map.getLayer(id) as unknown as {
    render(gl: WebGL2RenderingContext, input: unknown): void;
  };
  layer.render(harness.gl, harness.input);
  harness.endFrame();
}

function finish(harness: Harness, handle: ContourLineHandle) {
  handle.destroy();
  assert.equal(harness.map.getLayer("terrain-contour-lines"), undefined);
}

function addRelief(harness: Harness) {
  return addReliefLayer(
    {
      map: harness.map,
      id: "terrain-relief",
      tileUrl: TILE_URL,
      bbox: SCENE_BBOX,
      shift: 0,
      maxZoom: 12,
      fitZoom: ZOOM,
      strength: RELIEF_STRENGTH.initial,
      onFail: (error) => harness.failures.push(error),
      poolOptions: harness.poolOptions,
    },
    "soe-slot-shade",
  );
}
