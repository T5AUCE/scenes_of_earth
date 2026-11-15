import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { reliefExaggeration, RELIEF_STRENGTH } from "../layers/relief.ts";
import { createDemHarness, SCENE_BBOX } from "./dem-draw-harness.test.ts";
import { ARRIVAL_FADE_MS } from "./dem-draw.ts";
import { addReliefLayer, type ReliefHandle } from "./relief-layer.ts";

const ZOOM = 8;

function setup(options: { linear?: boolean } = {}) {
  const harness = createDemHarness(options);
  const handle = addReliefLayer(
    {
      map: harness.map,
      id: "terrain-relief",
      tileUrl: "https://dem/{z}/{x}/{y}.png",
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

  return { harness, handle };
}

function render(harness: ReturnType<typeof createDemHarness>) {
  const layer = harness.map.getLayer("terrain-relief") as unknown as {
    render(gl: WebGL2RenderingContext, input: unknown): void;
  };
  layer.render(harness.gl, harness.input);
  harness.endFrame();
}

async function renderFrames(harness: ReturnType<typeof createDemHarness>, frames = 12) {
  for (let frame = 0; frame < frames; frame++) {
    render(harness);
    await harness.landLoads();
  }
}

function finish(harness: ReturnType<typeof createDemHarness>, handle: ReliefHandle) {
  handle.destroy();
  assert.equal(harness.map.getLayer("terrain-relief"), undefined);
}

test("the layer sits at the shade slot and links its program when added", () => {
  const { harness, handle } = setup();

  assert.ok(harness.map.getLayer("terrain-relief"));
  assert.equal(harness.failures.length, 0);

  finish(harness, handle);
});

test("the first frames request tiles and draw nothing until they land", () => {
  const { harness, handle } = setup();

  render(harness);

  assert.ok(harness.workers.some((worker) => worker.requests.length > 0));
  assert.equal(harness.draws.length, 0);

  finish(harness, handle);
});

test("landed tiles draw with the level's slope scale and the strength's exaggeration", async () => {
  const { harness, handle } = setup();
  await renderFrames(harness);
  harness.advance(ARRIVAL_FADE_MS);
  harness.draws.length = 0;

  render(harness);

  assert.ok(harness.draws.length > 0);

  const exaggeration = reliefExaggeration(ZOOM, RELIEF_STRENGTH.initial);

  for (const call of harness.draws) {
    assert.equal(call.uniforms.get("uExaggeration"), exaggeration);

    const [first, second] = call.uniforms.get("uSlopeScale") as number[];

    assert.ok(first > 0);
    assert.equal(second, 0);
  }

  finish(harness, handle);
});

test("the strength is only a uniform and asks for a repaint", async () => {
  const { harness, handle } = setup();
  await renderFrames(harness);
  harness.advance(ARRIVAL_FADE_MS);

  const loadsBefore = harness.workers.flatMap((worker) => worker.requests).length;
  const repaintsBefore = harness.repaints();

  handle.setStrength(3 * 0.75);
  render(harness);

  assert.ok(harness.repaints() > repaintsBefore);
  assert.equal(harness.uniforms.get("uExaggeration"), reliefExaggeration(ZOOM, 2.25));
  assert.equal(harness.workers.flatMap((worker) => worker.requests).length, loadsBefore);

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

test("a refit of the base zoom asks for a repaint without touching the pool", () => {
  const { harness, handle } = setup();
  const before = harness.repaints();

  handle.setBaseZoom(ZOOM + 1);

  assert.ok(harness.repaints() > before);

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

test("a context loss and restore keeps the pool and the layer's visibility", async () => {
  const { harness, handle } = setup();
  await renderFrames(harness);

  const texturesBefore = harness.created().length;
  harness.map.setLayoutProperty("terrain-relief", "visibility", "none");
  mock.timers.enable({ apis: ["setTimeout"] });

  harness.setContextLost(true);
  harness.dispatch("webglcontextlost");

  assert.equal(harness.map.getLayer("terrain-relief"), undefined);
  assert.equal(
    harness.workers.some((worker) => worker.terminated),
    false,
  );

  mock.timers.reset();
  harness.setContextLost(false);
  harness.dispatch("webglcontextrestored");

  assert.ok(harness.map.getLayer("terrain-relief"));
  assert.equal(harness.map.getLayoutProperty("terrain-relief", "visibility"), "none");

  await renderFrames(harness);

  assert.ok(harness.created().length > texturesBefore);
  assert.equal(
    harness.workers.some((worker) => worker.terminated),
    false,
  );
  assert.equal(harness.failures.length, 0);

  finish(harness, handle);

  assert.ok(harness.workers.every((worker) => worker.terminated));
});

test("removing the layer frees its program and geometry and stops the workers", () => {
  const { harness, handle } = setup();

  handle.destroy();

  assert.equal(harness.deleted.programs.length, 1);
  assert.equal(harness.deleted.arrays.length, 1);
  assert.equal(harness.deleted.buffers.length, 1);
  assert.ok(harness.workers.every((worker) => worker.terminated));
});

test("prepare warms the program with one draw that writes no pixel and keeps the GL state", () => {
  const { harness, handle } = setup();
  const { gl, glState } = harness;
  const sentinel = { texture: true };

  for (const [capability, isOn] of [
    [1, true],
    [2, false],
    [3, true],
    [4, false],
  ] as const) {
    glState.switches.set(capability, isOn);
  }

  glState.program = { foreign: "program" };
  glState.vertexArray = { foreign: "array" };
  gl.activeTexture(gl.TEXTURE0 + 2);
  gl.bindTexture(gl.TEXTURE_2D, sentinel);

  const before = structuredClone({ ...glState, switches: [...glState.switches] });

  handle.prepare();

  assert.equal(harness.draws.length, 1);
  assert.deepEqual(harness.draws[0].colorMask, [false, false, false, false]);
  assert.equal(harness.draws[0].isScissored, true);
  assert.deepEqual(structuredClone({ ...glState, switches: [...glState.switches] }), before);
  assert.equal(harness.boundTextures.get(2), sentinel);
  assert.equal(gl.getParameter(gl.ACTIVE_TEXTURE), gl.TEXTURE0 + 2);

  finish(harness, handle);
});

test("prepare warm-draws only once", () => {
  const { harness, handle } = setup();

  handle.prepare();
  handle.prepare();

  assert.equal(harness.draws.length, 1);

  finish(harness, handle);
});

test("prepare loads the pinned tiles and reports when none are left", async () => {
  const { harness, handle } = setup();

  assert.equal(handle.prepare(), false);

  harness.endFrame();

  const requested = harness.workers
    .flatMap((worker) => worker.requests)
    .filter((request) => request.type === "load");

  assert.ok(requested.length > 0);

  await harness.landLoads();

  for (let step = 0; step < 10; step++) {
    harness.endFrame();
    if (handle.prepare()) break;

    await harness.landLoads();
  }

  harness.endFrame();

  assert.equal(handle.prepare(), true);
  assert.equal(harness.created().length, requested.length);

  finish(harness, handle);
});

test("tiles prepared a fade ago draw at full weight on the first visible frame", async () => {
  const { harness, handle } = setup();
  await harness.landLoads();

  for (let step = 0; step < 10; step++) {
    harness.endFrame();
    if (handle.prepare()) break;

    await harness.landLoads();
  }

  harness.advance(ARRIVAL_FADE_MS);
  harness.draws.length = 0;

  render(harness);

  assert.ok(harness.draws.length > 0);

  for (const call of harness.draws) assert.deepEqual(call.uniforms.get("uWeights"), [1, 0]);

  finish(harness, handle);
});

test("prepare asks for another frame while uploads wait and settles for a failed layer", async () => {
  const failed = setup({ linear: false });

  assert.equal(failed.handle.prepare(), true);
  assert.equal(failed.harness.draws.length, 0);

  finish(failed.harness, failed.handle);

  const { harness, handle } = setup();
  handle.prepare();
  await harness.landLoads();

  const before = harness.repaints();

  handle.prepare();

  assert.ok(harness.repaints() > before);

  finish(harness, handle);
});
