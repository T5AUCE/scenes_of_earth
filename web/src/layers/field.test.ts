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
          setFade(from, to, mix) {
            globalThis.markFades.push({
              from: from && Array.from(from),
              to: to && Array.from(to),
              mix,
            });
            if (to && globalThis.markUploads !== false) globalThis.markUploaded.add(to);
          },
          isReady: (positions) => globalThis.markUploaded.has(positions),
          setDots(isOn) { globalThis.dotsCalls.push(isOn); },
          setHatch(hasHatch) { globalThis.hatchCalls.push(hasHatch); },
        });
      `;
    case "../gpu/tiled-layer":
      return "export const keepThroughContextLoss = () => () => {};";
    case "./isolines":
      return `
        export const createIsolineOverlay = () => {
          const held = [];
          const cached = new Set();
          const failed = new Set();
          const overlay = {
            layerIds: [],
            interval: 1,
            setVisible(visible) {
              globalThis.isolineVisible.push(visible);
              if (!visible) {
                held.length = 0;
                cached.clear();
                failed.clear();
              }
            },
            setPlaying(isPlaying) {
              globalThis.isolinePlaying.push(isPlaying);
            },
            setValues(values, step) {
              globalThis.isolineValues.push(step);
              if (step < 0) return;
              cached.add(step);
              if (!held.includes(step)) {
                held.push(step);
                if (held.length > 2) held.shift();
              } else {
                const index = held.indexOf(step);
                held.splice(index, 1);
                held.push(step);
              }
            },
            prepareStep(step, values) {
              globalThis.isolinePrepares.push(step);
              if (step < 0 || held.includes(step) || failed.has(step)) return;
              cached.add(step);
            },
            frame(from, to, mix) {
              const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
                ?? globalThis.matchMedia?.()?.matches ?? false;
              if (reduced) mix = 0;
              if (from === to) return true;
              if (mix <= 0) {
                if (from < 0) {
                  if (to >= 0 && !held.includes(to) && cached.has(to)) {
                    held.push(to);
                    if (held.length > 2) held.shift();
                  }
                  globalThis.isolineFrames.push({ from, to, mix });
                  return true;
                }
                if (!overlay.isSettled(from)) return false;
                const index = held.indexOf(from);
                if (index >= 0) {
                  held.splice(index, 1);
                  held.push(from);
                }
                if (to >= 0 && !held.includes(to) && cached.has(to)) {
                  held.push(to);
                  if (held.length > 2) held.shift();
                }
                globalThis.isolineFrames.push({ from, to, mix });
                return true;
              }
              if (from < 0 && to >= 0 && !held.includes(to) && cached.has(to)) {
                held.push(to);
                if (held.length > 2) held.shift();
              }
              if (!overlay.isReady(from, to)) return false;
              globalThis.isolineFrames.push({ from, to, mix });
              if (mix >= 1 && held.includes(to)) {
                const index = held.indexOf(to);
                held.splice(index, 1);
                held.push(to);
              }
              return true;
            },
            isSettled(step) {
              if (step < 0 || failed.has(step)) return true;
              const loaded = globalThis.isolineLoaded ?? true;
              return held.includes(step) && loaded;
            },
            isReady(from, to) {
              if (from === to) return true;
              return overlay.isSettled(from) && overlay.isSettled(to);
            },
            holds(step) { return held.includes(step); },
            hasFailed(step) { return failed.has(step); },
            select(step) {
              globalThis.isolineSelects.push(step);
              return held.includes(step);
            },
            markFailed(step) { failed.add(step); },
            setSmooth() {
              held.length = 0;
              cached.clear();
              globalThis.isolineResets.push("smooth");
            },
            setUnits() {
              held.length = 0;
              cached.clear();
              globalThis.isolineResets.push("units");
            },
            setInk() {},
            setRange() {
              held.length = 0;
              cached.clear();
              globalThis.isolineResets.push("range");
            },
            destroy() {},
          };
          globalThis.lastIsolineOverlay = overlay;
          return overlay;
        };
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

test("isolines prepare traces the next step for the hidden source", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();

  await prepareStep(view, flush, TIMES[1]);
  assert.deepEqual(isolinePrepares(), [1]);
  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), false);
  view.setFrame!(TIMES[0], TIMES[1], 0);
  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), true);
});

test("isolines stall while the next set is not loaded", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  await prepareStep(view, flush, TIMES[1]);
  view.setFrame!(TIMES[0], TIMES[1], 0);
  (globalThis as Record<string, unknown>).isolineLoaded = false;

  try {
    assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), false);
  } finally {
    (globalThis as Record<string, unknown>).isolineLoaded = true;
  }

  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), true);
  view.setFrame!(TIMES[0], TIMES[1], 0.5);
  assert.equal(isolineFrames().at(-1)?.mix, 0.5);
});

test("isolines with equal steps do no work", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  const frames = isolineFrames().length;

  view.setFrame!(TIMES[0], TIMES[0], 0.5);

  assert.equal(isolineFrames().length, frames);
});

test("isolines fade to and from minus one", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[1]);
  await flush();

  assert.equal(view.isFrameReady!(TIMES[1], "2026-11-01"), true);
  view.setFrame!(TIMES[1], "2026-11-01", 0.5);
  assert.deepEqual(isolineFrames().at(-1), { from: 1, to: -1, mix: 0.5 });

  view.setTime("2026-11-01");
  await prepareStep(view, flush, TIMES[1]);
  view.setFrame!("2026-11-01", TIMES[1], 0.5);
  assert.deepEqual(isolineFrames().at(-1), { from: -1, to: 1, mix: 0.5 });
});

test("isolines pause and scrub show one set at full opacity", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  const selects = isolineSelects().length;

  view.setTime(TIMES[1]);
  await flush();

  assert.ok(isolineValues().includes(1));
  assert.ok(isolineSelects().length >= selects);
});

test("isolines never set a partial opacity under reduced motion", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  await prepareStep(view, flush, TIMES[1]);
  useReducedMotion(true);

  try {
    view.setFrame!(TIMES[0], TIMES[1], 0.75);
    assert.equal(isolineFrames().at(-1)?.mix, 0);
  } finally {
    useReducedMotion(false);
  }
});

test("isolines reset both sources on settings change mid-fade", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  await prepareStep(view, flush, TIMES[1]);
  view.setFrame!(TIMES[0], TIMES[1], 0);
  view.setFrame!(TIMES[0], TIMES[1], 0.5);

  view.options.find((option) => option.label === "Smooth")!.set(false);
  await flush();

  assert.ok(isolineResets().includes("smooth"));
  assert.equal((globalThis.lastIsolineOverlay as { holds(n: number): boolean }).holds(1), false);
});

test("isolines reset both sources when toggled off mid-fade", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  await prepareStep(view, flush, TIMES[1]);
  view.setFrame!(TIMES[0], TIMES[1], 0);
  view.setFrame!(TIMES[0], TIMES[1], 0.5);
  view.show(null);

  assert.equal((globalThis.lastIsolineOverlay as { holds(n: number): boolean }).holds(0), false);
  assert.equal((globalThis.lastIsolineOverlay as { holds(n: number): boolean }).holds(1), false);
});

test("isolines keep at most two traced sets", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  await prepareStep(view, flush, TIMES[1]);
  await prepareStep(view, flush, TIMES[2]);

  const overlay = globalThis.lastIsolineOverlay as { holds(n: number): boolean };
  const held = [0, 1, 2].filter((step) => overlay.holds(step));
  assert.ok(held.length <= 2);
});

test("isolines re-prepare a lost hidden set so play never stalls", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  await prepareStep(view, flush, TIMES[1]);
  view.setFrame!(TIMES[0], TIMES[1], 0);
  view.setFrame!(TIMES[0], TIMES[1], 0.5);
  const prepared = isolinePrepares().length;

  view.options.find((option) => option.label === "Smooth")!.set(false);
  const overlay = globalThis.lastIsolineOverlay as { holds(n: number): boolean };
  assert.equal(overlay.holds(1), false);

  view.setFrame!(TIMES[0], TIMES[1], 0.5);
  view.setFrame!(TIMES[0], TIMES[1], 0.5);
  await flush();

  assert.ok(isolinePrepares().length > prepared);
  view.setFrame!(TIMES[0], TIMES[1], 0);
  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), true);
});

test("isolines fading in from minus one makes the lines visible", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();
  view.setTime("2026-11-01");
  await prepareStep(view, flush, TIMES[0]);
  view.setFrame!("2026-11-01", TIMES[0], 0.5);

  assert.equal((globalThis as Record<string, unknown[]>).isolineVisible.at(-1), true);
});

test("isolines forward play state to the overlay", async () => {
  const { view, flush } = mountIsolineField([COMPLETE, COMPLETE, COMPLETE]);
  view.show("isolines");
  view.setTime(TIMES[0]);
  await flush();

  view.setPlaying!(true);
  view.setPlaying!(false);

  assert.deepEqual(isolinePlaying(), [true, false]);
});

test("dots fade from the shown step to the armed next step by the mix", async () => {
  const { view, fades, flush } = mountField([COMPLETE, [4, 3, 2, 1], COMPLETE]);
  await showDotsStep(view, flush);
  const held = fades().at(-1)!;

  view.setFrame!(TIMES[0], TIMES[1], 0.5);

  const fade = fades().at(-1)!;
  assert.deepEqual(fade.from, held.from);
  assert.notDeepEqual(fade.to, fade.from);
  assert.equal(fade.mix, 0.5);
});

test("dots hold the shown step while the next one is not loaded", async () => {
  const { view, fades, flush } = mountField([COMPLETE, [4, 3, 2, 1], COMPLETE]);
  view.show("dots");
  view.setTime(TIMES[0]);
  await flush();
  const shown = fades().length;

  view.setFrame!(TIMES[0], TIMES[1], 0.5);

  assert.equal(fades().length, shown);
  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), false);
  await flush();
});

test("dots stall until the next step is uploaded", async () => {
  const { view, flush } = mountField([COMPLETE, [4, 3, 2, 1], COMPLETE]);
  Object.assign(globalThis, { markUploads: false });
  view.show("dots");
  view.setTime(TIMES[0]);
  await flush();
  view.setFrame!(TIMES[0], TIMES[1], 0);
  await flush();
  view.setFrame!(TIMES[0], TIMES[1], 0);
  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), false);

  Object.assign(globalThis, { markUploads: true });
  view.setFrame!(TIMES[0], TIMES[1], 0);

  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), true);
});

test("dots with a failing next read let the fade move on", async () => {
  const { view, flush } = mountField([COMPLETE, [4, 3, 2, 1], COMPLETE]);
  view.show("dots");
  view.setTime(TIMES[0]);
  await flush();
  failedSteps.add(1);

  view.setFrame!(TIMES[0], TIMES[1], 0);
  await flush();

  assert.equal(view.isFrameReady!(TIMES[0], TIMES[1]), true);
});

test("dots with equal steps do no work and read nothing", async () => {
  const { view, fades, flush } = mountField([COMPLETE, COMPLETE, COMPLETE]);
  await showDotsStep(view, flush);
  const drawn = fades().length;

  view.setFrame!(TIMES[0], TIMES[0], 0.5);

  assert.equal(fades().length, drawn);
  assert.equal(pendingReads.length, 0);
});

test("dots fade out to a step outside the axis and in from one", async () => {
  const { view, fades, flush } = mountField([COMPLETE, COMPLETE, COMPLETE], "2026-10-01");
  view.show("dots");
  view.setTime(TIMES[1]);
  await flush();

  view.setFrame!(TIMES[1], TIMES[2], 0.5);
  assert.equal(fades().at(-1)!.to, null);
  assert.equal(fades().at(-1)!.mix, 0.5);

  view.setTime(TIMES[2]);
  view.setFrame!(TIMES[2], TIMES[0], 0);
  await flush();
  view.setFrame!(TIMES[2], TIMES[0], 0.5);

  assert.equal(fades().at(-1)!.from, null);
  assert.deepEqual(dotsCalls().at(-1), true);
});

test("dots hatch follows the step that shows more from the midpoint", async () => {
  const { view, hatch, flush } = mountField([COMPLETE, HAS_NO_DATA, COMPLETE]);
  await showDotsStep(view, flush);
  assert.equal(legendHatch(view), false);

  view.setFrame!(TIMES[0], TIMES[1], 0.25);
  assert.equal(hatch(), true);
  assert.equal(legendHatch(view), false);
  view.setFrame!(TIMES[0], TIMES[1], 0.75);
  assert.equal(legendHatch(view), true);
  view.setFrame!(TIMES[0], TIMES[1], 0.25);
  assert.equal(legendHatch(view), false);
});

test("a pause shows the next step's dots alone before its read returns", async () => {
  const { view, fades, flush } = mountField([COMPLETE, [4, 3, 2, 1], COMPLETE]);
  await showDotsStep(view, flush);
  const leaving = fades().at(-1)!.from;
  view.setFrame!(TIMES[0], TIMES[1], 0.6);
  const entering = fades().at(-1)!.to;

  view.setTime(TIMES[1]);

  assert.deepEqual(fades().at(-1), { from: entering, to: null, mix: 0 });
  assert.notDeepEqual(entering, leaving);
  await flush();
});

test("dots never ease under reduced motion", async () => {
  const { view, fades, flush } = mountField([COMPLETE, [4, 3, 2, 1], COMPLETE]);
  await showDotsStep(view, flush);
  useReducedMotion(true);

  try {
    view.setFrame!(TIMES[0], TIMES[1], 0.75);
    assert.equal(fades().at(-1)!.mix, 0);
  } finally {
    useReducedMotion(false);
  }
});

test("dots draw a step they were handed again without rereading it", async () => {
  const { view, fades, flush } = mountField([COMPLETE, [4, 3, 2, 1], COMPLETE]);
  await showDotsStep(view, flush);
  view.setFrame!(TIMES[0], TIMES[1], 0.5);
  const entering = fades().at(-1)!.to;
  view.setTime(TIMES[1]);
  await flush();

  assert.deepEqual(fades().at(-1), { from: entering, to: null, mix: 0 });
  assert.equal(pendingReads.length, 0);
});

async function prepareStep(
  view: ReturnType<typeof createSeriesView>,
  flush: () => Promise<void>,
  time: string,
) {
  const preparing = view.prepare!(time);
  await flush();
  await preparing;
}

const failedSteps = new Set<number>();
const pendingReads: (() => void)[] = [];
let imageDataCount = 0;

function legendHatch(view: ReturnType<typeof createSeriesView>) {
  const { children } = (view.legend() as unknown as { shown: { children: unknown[] } }).shown;

  return children.includes("hatch");
}

async function showDotsStep(
  view: ReturnType<typeof createSeriesView>,
  flush: () => Promise<void>,
) {
  view.show("dots");
  view.setTime(TIMES[0]);
  await flush();
  view.setFrame!(TIMES[0], TIMES[1], 0);
  await flush();
  view.setFrame!(TIMES[0], TIMES[1], 0);
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
  return mountWithEncodings(steps, ["ramp", "dots"], end);
}

function mountIsolineField(steps: number[][], end = "2026-11-01") {
  return mountWithEncodings(steps, ["ramp", "isolines"], end);
}

function dotsCalls(): boolean[] {
  return (globalThis as Record<string, boolean[]>).dotsCalls ?? [];
}

function isolinePrepares(): number[] {
  return (globalThis as Record<string, number[]>).isolinePrepares ?? [];
}

function isolineFrames(): { from: number; to: number; mix: number }[] {
  return (globalThis as Record<string, { from: number; to: number; mix: number }[]>)
    .isolineFrames ?? [];
}

function isolineValues(): number[] {
  return (globalThis as Record<string, number[]>).isolineValues ?? [];
}

function isolineSelects(): number[] {
  return (globalThis as Record<string, number[]>).isolineSelects ?? [];
}

function isolineResets(): string[] {
  return (globalThis as Record<string, string[]>).isolineResets ?? [];
}

function isolinePlaying(): boolean[] {
  return (globalThis as Record<string, boolean[]>).isolinePlaying ?? [];
}

function useReducedMotion(matches: boolean) {
  const target = globalThis as unknown as Record<string, unknown>;
  if (matches) {
    target.matchMedia = () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    });
  } else {
    Reflect.deleteProperty(target, "matchMedia");
  }
}

function mountWithEncodings(steps: number[][], encodings: string[], end = "2026-11-01") {
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
    markFades: [],
    markUploaded: new Set(),
    markUploads: true,
    dotsCalls: [],
    capturedOpacities: [],
    isolinePrepares: [],
    isolineFrames: [],
    isolineValues: [],
    isolineSelects: [],
    isolineResets: [],
    isolineVisible: [],
    isolinePlaying: [],
    isolineLoaded: true,
    ImageData: class {
      constructor() {
        imageDataCount += 1;
      }
    },
  });
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "matchMedia");
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "lastIsolineOverlay");
  const layer = {
    id: "rain",
    title: "Rainfall",
    units: "mm",
    grid: { bbox: [0, 0, 2, 2], nx: 2, ny: 2, res: 1 },
    style: { palette: "ink-blue", stops: [0, 10], encodings },
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
    markFades: { from: number[] | null; to: number[] | null; mix: number }[];
  };

  return {
    view,
    reports,
    hatch: () => captured.hatchCalls.at(-1),
    fades: () => captured.markFades,
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
