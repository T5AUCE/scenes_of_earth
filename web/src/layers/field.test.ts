import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { LayerContext, LayerDoc } from "../types.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    const source = mockModule(specifier);
    if (source && context.parentURL?.endsWith("/src/layers/field.ts")) {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    if (context.parentURL?.includes("/src/") && specifier.startsWith(".")) {
      const extension = specifier.endsWith(".ts") ? "" : ".ts";
      return next(new URL(`${specifier}${extension}`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { createSeriesView } = await import("./field.ts").finally(() => hooks.deregister());

function mockModule(specifier: string) {
  switch (specifier) {
    case "../data":
      return `
        export const arrayDoc = () => ({ path: "value" });
        export const decode = () => null;
        export const readArray = async () => null;
        export const readSteps = async () => [];
        export const readMask = async () => globalThis.fieldMask;
        export const createStepReader = () => ({
          prime: () => {},
          release: () => {},
          setPlaying: () => {},
          maxLookahead: () => 4,
          read: (step) => new Promise((resolve, reject) => {
            const isFailing = globalThis.failedSteps.has(step);
            globalThis.pendingReads.push(() => {
              if (isFailing) reject(new Error("read failed"));
              else resolve(globalThis.stepValues[step]);
            });
          }),
        });
      `;
    case "../html":
      return `
        export const makeHtmlElement = () => ({
          shown: null,
          replaceChildren(element) { this.shown = element; },
        });
      `;
    case "../legend":
      return `
        const element = () => ({ children: [], append(child) { this.children.push(child); } });
        export const createZoomWatch = () => ({ setActive() {} });
        export const dotLegend = element;
        export const gradientLegend = element;
        export const isothermLegend = element;
        export const hatchLegend = () => "hatch";
      `;
    case "../map":
      return `
        export const addImagePair = () => {};
        export const maxTextureSize = () => 64;
        export const removeLayerAndSource = () => {};
        export const setImage = () => {};
        export const setPairOpacities = (map, ids, opacities) => {
          globalThis.capturedOpacities.push([...opacities]);
        };
      `;
    case "../gpu/field-marks-layer":
      return `
        export const createFieldMarksLayer = () => ({
          layer: {},
          setHalo() {},
          setDensity() {},
          setInk() {},
          setMask() {},
          setPositions(positions) { globalThis.markPositions.push(Array.from(positions)); },
          setDots() {},
          setHatch(hasHatch) { globalThis.hatchCalls.push(hasHatch); },
        });
      `;
    case "../gpu/tiled-layer":
      return "export const keepThroughContextLoss = () => () => {};";
    case "./isolines":
      return `
        export const createIsolineOverlay = () => ({
          layerIds: [],
          interval: 1,
          setVisible() {},
          setValues() {},
          setSmooth() {},
          setUnits() {},
          setInk() {},
          setRange() {},
          destroy() {},
        });
      `;
    default:
      return null;
  }
}

const TIMES = ["2026-08-01", "2026-09-01", "2026-10-01"];
const HAS_NO_DATA = [Number.NaN, 1, 2, 3];
const COMPLETE = [1, 2, 3, 4];

test("the no-data hatch switches to the step that shows more at the midpoint", async () => {
  const { view, hatch, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  await showFirstStep(view, flush);
  assert.equal(hatch(), false);

  view.setFrame!(TIMES[0], TIMES[1], 0.25);
  assert.equal(hatch(), false);
  view.setFrame!(TIMES[0], TIMES[1], 0.75);
  assert.equal(hatch(), true);
  assert.equal(legendHatch(view), true);
  view.setFrame!(TIMES[0], TIMES[1], 0.25);
  assert.equal(hatch(), false);
  assert.equal(legendHatch(view), false);
});

test("the cached hatch is applied without repainting or rereading a step", async () => {
  const { view, images, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  await showFirstStep(view, flush);
  const created = images();

  for (const mix of [0.2, 0.4, 0.6, 0.8]) view.setFrame!(TIMES[0], TIMES[1], mix);

  assert.equal(images(), created);
  assert.equal(pendingReads.length, 0);
});

test("a step outside the axis drops the hatch at the midpoint", async () => {
  const { view, hatch, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE], "2026-10-01");
  view.show("colour");
  view.setTime(TIMES[1]);
  await flush();
  assert.equal(hatch(), true);

  view.setFrame!(TIMES[1], TIMES[2], 0.75);

  assert.equal(hatch(), false);
});

test("switching to dots and back resets the hatch to the shown step", async () => {
  const { view, hatch, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  await showFirstStep(view, flush);
  view.setFrame!(TIMES[0], TIMES[1], 0.75);
  assert.equal(hatch(), true);

  view.show("dots");
  await flush();
  view.show("colour");
  await flush();

  assert.equal(hatch(), false);
  assert.equal(legendHatch(view), false);
});

test("a palette change drops the cached hatch and redraws the shown step", async () => {
  const { view, hatch, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  await showFirstStep(view, flush);
  view.setFrame!(TIMES[0], TIMES[1], 0.75);
  assert.equal(hatch(), true);

  view.menu!.setPalette("climate");
  view.setFrame!(TIMES[0], TIMES[1], 0.75);
  assert.equal(hatch(), true);
  await flush();

  assert.equal(hatch(), false);
});

test("a pause at the next step shows its cached hatch before the read returns", async () => {
  const { view, hatch, opacities, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  await showFirstStep(view, flush);
  view.setFrame!(TIMES[0], TIMES[1], 0.4);

  view.setTime(TIMES[1]);

  assert.deepEqual(opacities().at(-1), [0, 0.8]);
  assert.equal(hatch(), true);
  await flush();
});

test("a failing incoming read lets the fade move on and the draw reports it", async () => {
  const { view, opacities, reports, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  await showFirstStep(view, flush, false);
  failedSteps.add(1);

  view.setFrame!(TIMES[0], TIMES[1], 0);
  await flush();
  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), true);
  assert.equal(reports.length, 0);

  view.setFrame!(TIMES[0], TIMES[1], 0.5);
  assert.deepEqual(opacities().at(-1), [0.8, 0]);
  view.setFrame!(TIMES[1], TIMES[2], 0);
  await flush();

  assert.equal(reports.length, 1);
  assert.deepEqual(opacities().at(-1), [0, 0]);
});

test("after a failed step reports, the next good step fades in from nothing", async () => {
  const { view, opacities, reports, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  await showFirstStep(view, flush, false);
  failedSteps.add(1);
  view.setFrame!(TIMES[0], TIMES[1], 0);
  await flush();
  view.setFrame!(TIMES[1], TIMES[2], 0);
  await flush();
  assert.equal(reports.length, 1);

  view.setFrame!(TIMES[1], TIMES[2], 0);
  await flush();
  assert.equal(view.isFrameReady!(TIMES[1], TIMES[2]), true);
  view.setFrame!(TIMES[1], TIMES[2], 0.5);

  assert.deepEqual(opacities().at(-1)!.toSorted(), [0, 0.4]);
});

test("a reverse scrub keeps each retained image's hatch through a hide and show", async () => {
  const { view, hatch, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  view.show("colour");
  view.setTime(TIMES[2]);
  await flush();
  view.setTime(TIMES[1]);
  await flush();
  view.setFrame!(TIMES[1], TIMES[2], 0);
  await flush();
  view.show("dots");
  view.show("colour");
  const reads = pendingReads.length;

  view.setFrame!(TIMES[1], TIMES[2], 0.25);
  assert.equal(hatch(), true);
  assert.equal(legendHatch(view), true);
  view.setFrame!(TIMES[1], TIMES[2], 0.75);

  assert.equal(hatch(), false);
  assert.equal(legendHatch(view), false);
  assert.equal(pendingReads.length, reads);
  await flush();
});

test("repeated frames never paint an image themselves", async () => {
  const { view, images, flush } = mountField([COMPLETE, COMPLETE, COMPLETE]);
  await showFirstStep(view, flush);
  const created = imageDataCount;
  const painted = images();

  for (const mix of [0, 0.3, 0.6, 0.9]) view.setFrame!(TIMES[1], TIMES[2], mix);

  assert.equal(imageDataCount, created);
  assert.equal(images(), painted);
});

test("a pause shows the painted step before its decoded read returns", async () => {
  const { view, opacities, flush } = mountField([COMPLETE, COMPLETE, COMPLETE]);
  await showFirstStep(view, flush);
  view.setFrame!(TIMES[0], TIMES[1], 0.5);

  view.setTime(TIMES[1]);

  assert.deepEqual(opacities().at(-1), [0, 0.8]);
  await flush();
});

const failedSteps = new Set<number>();
const pendingReads: (() => void)[] = [];
let imageDataCount = 0;

function legendHatch(view: ReturnType<typeof createSeriesView>) {
  const { children } = (view.legend() as unknown as { shown: { children: unknown[] } }).shown;

  return children.includes("hatch");
}

async function showFirstStep(
  view: ReturnType<typeof createSeriesView>,
  flush: () => Promise<void>,
  armNext = true,
) {
  view.show("colour");
  view.setFrame!(TIMES[0], TIMES[1], 0);
  await flush();
  if (!armNext) return;

  view.setFrame!(TIMES[0], TIMES[1], 0);
  await flush();
}

function mountField(steps: number[][], end = "2026-11-01") {
  const reports: unknown[] = [];
  failedSteps.clear();
  pendingReads.length = 0;
  imageDataCount = 0;
  Object.assign(globalThis, {
    failedSteps,
    pendingReads,
    stepValues: steps.map((values) => Float32Array.from(values)),
    fieldMask: Uint8Array.of(1, 1, 1, 1),
    hatchCalls: [],
    markPositions: [],
    capturedOpacities: [],
    ImageData: class {
      constructor() {
        imageDataCount += 1;
      }
    },
  });
  const layer = {
    id: "rain",
    title: "Rainfall",
    units: "mm",
    grid: { bbox: [0, 0, 2, 2], nx: 2, ny: 2, res: 1 },
    style: { palette: "ink-blue", stops: [0, 10], encodings: ["ramp", "dots"] },
    time: { step: "P1M", values: TIMES, end, method: null },
    arrays: {},
  } as unknown as LayerDoc;
  const view = createSeriesView({
    map: { setPaintProperty() {}, addLayer() {}, getZoom: () => 3 },
    store: Promise.resolve({}),
    layer,
    shift: 0,
    slots: {},
    changeDisplay() {},
    report: (error: unknown) => {
      reports.push(error);
      return () => {};
    },
  } as unknown as LayerContext);
  const captured = globalThis as unknown as {
    hatchCalls: boolean[];
    capturedOpacities: [number, number][];
    markPositions: number[][];
  };

  return {
    view,
    reports,
    hatch: () => captured.hatchCalls.at(-1),
    opacities: () => captured.capturedOpacities,
    images: () => imageDataCount,
    async flush() {
      for (let round = 0; round < 3; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        pendingReads.splice(0).forEach((resolve) => resolve());
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}
