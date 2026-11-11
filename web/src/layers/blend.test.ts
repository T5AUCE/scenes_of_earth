import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { LayerDoc } from "../types.ts";
import { differingPeriodNote, missingStepNote } from "./allocate.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    const source = mockModule(specifier);
    if (source && context.parentURL?.endsWith("/src/layers/blend.ts")) {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    if (context.parentURL?.includes("/web/src/") && specifier.startsWith(".")) {
      const extension = specifier.endsWith(".ts") ? "" : ".ts";
      return next(new URL(`${specifier}${extension}`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { createBlendView } = await import("./blend.ts").finally(() => hooks.deregister());

function mockModule(specifier: string) {
  switch (specifier) {
    case "../html":
      return `
        export const makeHtmlElement = (tag, text = "") => ({
          tag,
          textContent: text,
          hidden: false,
          className: "",
          replaceChildren() {},
        });
      `;
    case "../legend":
      return `
        export const bivariateLegend = (...args) => {
          globalThis.capturedLegend = args;
          return {};
        };
      `;
    case "../map":
      return `
        export const addImagePair = () => {};
        export const setPairOpacities = (map, ids, opacities) => {
          (globalThis.capturedOpacities ??= []).push([...opacities]);
        };
        export const removeLayerAndSource = () => {};
        export const maxTextureSize = () => 64;
        export const setImage = (map, id, image) => {
          (globalThis.capturedImages ??= []).push(image);
        };
        export const warmHiddenRaster = async () => {
          (globalThis.warmedIds ??= []).push("warmed");
        };
      `;
    case "./field":
      return `
        export const fieldReader = () => ({
          prime: () => {},
          read: (step) => new Promise((resolve, reject) => {
            const isFailing = globalThis.failedSteps?.has(step);
            globalThis.pendingReads.push(() => {
              if (isFailing) reject(new Error("read failed"));
              else resolve(Float32Array.of(1, 1, 1, 1));
            });
          }),
        });
      `;
    default:
      return null;
  }
}

test("a half without a step hides the blend with a note that names it", () => {
  const halves = [
    { title: "Rainfall", step: 4 },
    { title: "Temperature", step: -1 },
  ];

  assert.equal(
    missingStepNote(halves, "2026-09"),
    "No temperature for 2026-09; the blend shows steps where both exist.",
  );
});

test("the note names both halves when neither has a step", () => {
  const halves = [
    { title: "Rainfall", step: -1 },
    { title: "Temperature", step: -1 },
  ];

  assert.match(missingStepNote(halves, "2010-01")!, /^No rainfall or temperature for 2010-01/);
});

test("a blend with a step in both halves has no note", () => {
  const halves = [
    { title: "Rainfall", step: 0 },
    { title: "Temperature", step: 12 },
  ];

  assert.equal(missingStepNote(halves, "2020-05"), null);
});

test("halves showing different periods are named with their own period", () => {
  const halves = [
    { title: "Rainfall", period: "2026-09-14" },
    { title: "Temperature", period: "2026-09" },
  ];

  assert.equal(
    differingPeriodNote(halves),
    "The blend pairs rainfall for 2026-09-14 with temperature for 2026-09.",
  );
});

test("halves showing the same period need no note", () => {
  const halves = [
    { title: "Rainfall", period: "2026-09" },
    { title: "Temperature", period: "2026-09" },
  ];

  assert.equal(differingPeriodNote(halves), null);
});

test("a queued missing-step note stays hidden once the blend is switched off", async () => {
  const pendingReads: (() => void)[] = [];
  Object.assign(globalThis, { pendingReads, ImageData: class {} });
  const view = createBlendView(
    [
      layerOf("rain", ["2026-08-01", "2026-09-01"], "2026-10-01"),
      layerOf("temperature", ["2026-08-01"], "2026-09-01"),
    ],
    {
      map: { setPaintProperty() {} },
      store: Promise.resolve({}),
      shift: 0,
      slots: {},
      report: () => assert.fail("no read should fail"),
      rangeOf: () => null,
      unitsOf: (id: string) => layerOf(id, [], "").units,
    } as unknown as Parameters<typeof createBlendView>[1],
  );

  view.show("colour");
  view.setTime("2026-08-01");
  view.setTime("2026-09-01");
  view.show(null);
  pendingReads.forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(view.parts[0].note.hidden, true);
});

test("prepare decodes both halves without drawing", async () => {
  const pendingReads: (() => void)[] = [];
  Object.assign(globalThis, { pendingReads, ImageData: class {} });
  const view = createBlendView(
    [
      layerOf("rain", ["2026-08-01", "2026-09-01"], "2026-10-01"),
      layerOf("temperature", ["2026-08-01", "2026-09-01"], "2026-10-01"),
    ],
    {
      map: { setPaintProperty() {} },
      store: Promise.resolve({}),
      shift: 0,
      slots: {},
      report: () => assert.fail("no read should fail"),
      rangeOf: () => null,
      unitsOf: (id: string) => layerOf(id, [], "").units,
    } as unknown as Parameters<typeof createBlendView>[1],
  );

  const warming = view.prepare!("2026-09-01");
  assert.equal(pendingReads.length, 2);
  pendingReads.forEach((resolve) => resolve());
  await warming;
  await new Promise((resolve) => setImmediate(resolve));
});

test("prepare outside both axes reads nothing", async () => {
  const pendingReads: (() => void)[] = [];
  Object.assign(globalThis, { pendingReads, ImageData: class {} });
  const view = createBlendView(
    [
      layerOf("rain", ["2026-08-01"], "2026-09-01"),
      layerOf("temperature", ["2026-08-01"], "2026-09-01"),
    ],
    {
      map: { setPaintProperty() {} },
      store: Promise.resolve({}),
      shift: 0,
      slots: {},
      report: () => {},
      rangeOf: () => null,
      unitsOf: (id: string) => layerOf(id, [], "").units,
    } as unknown as Parameters<typeof createBlendView>[1],
  );

  await view.prepare!("2020-01-01");

  assert.equal(pendingReads.length, 0);
});

test("the blend legend converts stops and units to the chosen display units", () => {
  Object.assign(globalThis, { ImageData: class {} });
  const rain = {
    ...layerOf("rain", ["2026-08-01"], "2026-09-01"),
    title: "Rainfall",
    units: "mm/month",
    style: { stops: [0, 254] },
  } as unknown as LayerDoc;
  const temperature = {
    ...layerOf("temperature", ["2026-08-01"], "2026-09-01"),
    title: "Temperature",
    units: "°C",
    style: { stops: [0, 10] },
  } as unknown as LayerDoc;
  createBlendView([rain, temperature], {
    map: { setPaintProperty() {} },
    store: Promise.resolve({}),
    shift: 0,
    slots: {},
    report: () => {},
    rangeOf: () => null,
    unitsOf: (id: string) => (id === "rain" ? "in/month" : "°F"),
  } as unknown as Parameters<typeof createBlendView>[1]);

  const [, rainAxis, temperatureAxis] = (globalThis as { capturedLegend: unknown[] })
    .capturedLegend as [{}, { units: string; stops: number[] }, { units: string; stops: number[] }];

  assert.equal(rainAxis.units, "in/month");
  assert.deepEqual(rainAxis.stops, [0, 10]);
  assert.equal(temperatureAxis.units, "°F");
  assert.deepEqual(temperatureAxis.stops, [32, 50]);
});

test("switching display units keeps the painted colours while the legend follows", async () => {
  Object.assign(globalThis, {
    ImageData: class {
      data: Uint8ClampedArray;
      constructor(data: Uint8ClampedArray) {
        this.data = Uint8ClampedArray.from(data);
      }
    },
    capturedImages: [],
    pendingReads: [],
  });
  const rain = {
    ...layerOf("rain", ["2026-08-01"], "2026-09-01"),
    title: "Rainfall",
    units: "mm/month",
    style: { stops: [0, 254] },
  } as unknown as LayerDoc;
  const temperature = {
    ...layerOf("temperature", ["2026-08-01"], "2026-09-01"),
    title: "Temperature",
    units: "°C",
    style: { stops: [0, 10] },
  } as unknown as LayerDoc;
  const displayUnits: Record<string, string> = { rain: "mm/month", temperature: "°C" };
  const view = createBlendView([rain, temperature], {
    map: { setPaintProperty() {} },
    store: Promise.resolve({}),
    shift: 0,
    slots: {},
    report: () => {},
    rangeOf: () => null,
    unitsOf: (id: string) => displayUnits[id],
  } as unknown as Parameters<typeof createBlendView>[1]);

  view.show("colour");
  view.setTime("2026-08-01");
  (globalThis as { pendingReads: (() => void)[] }).pendingReads.forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));
  const before = (globalThis as { capturedImages: { data: Uint8ClampedArray }[] })
    .capturedImages.map(({ data }) => Array.from(data));

  displayUnits.rain = "in/month";
  displayUnits.temperature = "°F";
  view.restyle();
  const after = (globalThis as { capturedImages: { data: Uint8ClampedArray }[] })
    .capturedImages.map(({ data }) => Array.from(data));

  assert.ok(before.length > 0);
  assert.deepEqual(after.at(-1), before.at(-1));
  const [, rainAxis, temperatureAxis] = (globalThis as { capturedLegend: unknown[] })
    .capturedLegend as [{}, { units: string; stops: number[] }, { units: string; stops: number[] }];
  assert.equal(rainAxis.units, "in/month");
  assert.deepEqual(rainAxis.stops, [0, 10]);
  assert.equal(temperatureAxis.units, "°F");
  assert.deepEqual(temperatureAxis.stops, [32, 50]);
});

const FADE_TIMES = ["2026-08-01", "2026-09-01", "2026-10-01"];

test("a fade drives both layers and the incoming image takes over after it", async () => {
  const { view, opacities, images, flush } = mountFadingBlend();
  await showFirstStep(view, flush);
  assert.equal(images().length, 2);

  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0.5);
  const [outgoing, incoming] = opacities().at(-1)!;
  assert.ok(Math.abs(incoming - 0.4) < 1e-12);
  assert.ok(Math.abs((1 - outgoing) * (1 - incoming) - 0.2) < 1e-12);

  view.setFrame!(FADE_TIMES[1], FADE_TIMES[2], 0);
  await flush();
  assert.deepEqual(opacities().at(-1), [0, 0.8]);
  assert.equal(images().length, 2);

  view.setFrame!(FADE_TIMES[1], FADE_TIMES[2], 0);
  await flush();
  assert.equal(images().length, 3);
});

test("a fade waits until the next blend image is painted", async () => {
  const { view, flush } = mountFadingBlend();
  view.show("colour");
  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0);
  await flush();
  assert.equal(view.isFrameReady!(FADE_TIMES[0], FADE_TIMES[1]), false);

  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0);
  await flush();

  assert.equal(view.isFrameReady!(FADE_TIMES[0], FADE_TIMES[1]), true);
});

test("setting a time during a fade shows one image at full opacity", async () => {
  const { view, opacities, images, flush } = mountFadingBlend();
  await showFirstStep(view, flush);
  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0.5);
  const painted = images().length;

  view.setTime(FADE_TIMES[0]);
  await flush();

  assert.deepEqual(opacities().at(-1), [0.8, 0]);
  assert.equal(images().length, painted);
});

test("a range change during a fade repaints one image and drops the other", async () => {
  const { view, opacities, images, flush } = mountFadingBlend();
  await showFirstStep(view, flush);
  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0.5);
  const painted = images().length;

  view.restyle();
  await flush();

  assert.equal(images().length, painted + 1);
  assert.deepEqual(opacities().at(-1), [0.8, 0]);
  assert.equal(view.isFrameReady!(FADE_TIMES[0], FADE_TIMES[1]), false);
});

test("a failing incoming read lets the fade move on and the draw reports it", async () => {
  const { view, opacities, flush, reports } = mountFadingBlend();
  await showFirstStep(view, flush, false);
  failedSteps.add(1);

  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0);
  await flush();
  assert.equal(view.isFrameReady!(FADE_TIMES[0], FADE_TIMES[1]), true);
  assert.equal(reports.length, 0);

  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0.5);
  assert.deepEqual(opacities().at(-1), [0.8, 0]);

  view.setFrame!(FADE_TIMES[1], FADE_TIMES[2], 0);
  await flush();
  assert.equal(reports.length, 1);
  assert.deepEqual(opacities().at(-1), [0, 0]);
});

test("after a failed step reports, the next good step fades in from nothing", async () => {
  const { view, opacities, flush, reports } = mountFadingBlend();
  await showFirstStep(view, flush, false);
  failedSteps.add(1);
  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0);
  await flush();
  view.setFrame!(FADE_TIMES[1], FADE_TIMES[2], 0);
  await flush();
  assert.equal(reports.length, 1);

  view.setFrame!(FADE_TIMES[1], FADE_TIMES[2], 0);
  await flush();
  assert.equal(view.isFrameReady!(FADE_TIMES[1], FADE_TIMES[2]), true);
  view.setFrame!(FADE_TIMES[1], FADE_TIMES[2], 0.5);

  assert.deepEqual(opacities().at(-1)!.toSorted(), [0, 0.4]);
});

test("repeated frames never paint the image themselves", async () => {
  const { view, images, flush } = mountFadingBlend();
  await showFirstStep(view, flush);
  const painted = images().length;
  const created = imageDataCount;

  for (const mix of [0, 0.2, 0.4, 0.6, 0.8]) view.setFrame!(FADE_TIMES[1], FADE_TIMES[2], mix);

  assert.equal(images().length, painted);
  assert.equal(imageDataCount, created);
});

test("a pause shows the painted image before its decoded read returns", async () => {
  const { view, opacities, flush } = mountFadingBlend();
  await showFirstStep(view, flush);
  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0.5);

  view.setTime(FADE_TIMES[1]);

  assert.deepEqual(opacities().at(-1), [0, 0.8]);
  await flush();
});

test("the period note follows the step that shows more", async () => {
  const { view, flush } = mountFadingBlend(
    ["2026-08-01", "2026-09-01"],
    ["2026-08-01", "2026-09-15"],
  );
  await showFirstStep(view, flush);
  const note = view.parts[0].note;
  assert.equal(note.hidden, true);

  view.setFrame!("2026-08-01", "2026-09-01", 0.25);
  assert.equal(note.hidden, true);
  view.setFrame!("2026-08-01", "2026-09-01", 0.75);
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /^The blend pairs rain for/);
  view.setFrame!("2026-08-01", "2026-09-01", 0.25);
  assert.equal(note.hidden, true);
});

test("the missing-step note appears at the midpoint when a half ends", async () => {
  const { view, flush } = mountFadingBlend(FADE_TIMES, FADE_TIMES, "2026-10-01");
  await showFirstStep(view, flush);
  const note = view.parts[0].note;

  view.setFrame!("2026-09-01", "2026-10-01", 0.25);
  assert.equal(note.hidden, true);
  view.setFrame!("2026-09-01", "2026-10-01", 0.75);

  assert.match(note.textContent, /^No temperature for/);
});

test("entry warms the real source even when the image is already held", async () => {
  const { view, flush } = mountFadingBlend();
  await showFirstStep(view, flush);
  Object.assign(globalThis, { warmedIds: [] });
  const warming = view.prepareEntry!(FADE_TIMES[0]);
  await flush();
  await warming;

  assert.ok((globalThis as { warmedIds: unknown[] }).warmedIds.length > 0);
});

test("a scrub during an ordinary paint never publishes the older time", async () => {
  const { view, flush, reports } = mountFadingBlend();
  view.show("colour");
  view.setTime(FADE_TIMES[0]);
  view.setTime(FADE_TIMES[1]);
  await flush();

  assert.equal(reports.length, 0);
  assert.equal(view.isFrameReady!(FADE_TIMES[1], FADE_TIMES[2]), false);
});

const failedSteps = new Set<number>();
let imageDataCount = 0;

async function showFirstStep(
  view: ReturnType<typeof createBlendView>,
  flush: () => Promise<void>,
  armNext = true,
) {
  view.show("colour");
  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0);
  await flush();
  if (!armNext) return;

  view.setFrame!(FADE_TIMES[0], FADE_TIMES[1], 0);
  await flush();
}

function mountFadingBlend(
  rainTimes = FADE_TIMES,
  temperatureTimes = FADE_TIMES,
  temperatureEnd = "2026-11-01",
) {
  const pendingReads: (() => void)[] = [];
  const reports: unknown[] = [];
  failedSteps.clear();
  imageDataCount = 0;
  Object.assign(globalThis, {
    pendingReads,
    failedSteps,
    capturedImages: [],
    capturedOpacities: [],
    ImageData: class {
      constructor() {
        imageDataCount += 1;
      }
    },
  });
  const view = createBlendView(
    [
      layerOf("rain", rainTimes, "2026-11-01"),
      layerOf("temperature", temperatureTimes, temperatureEnd),
    ],
    {
      map: { setPaintProperty() {} },
      store: Promise.resolve({}),
      shift: 0,
      slots: {},
      report: (error: unknown) => reports.push(error),
      rangeOf: () => null,
      unitsOf: (id: string) => layerOf(id, [], "").units,
    } as unknown as Parameters<typeof createBlendView>[1],
  );
  const captured = globalThis as unknown as {
    capturedImages: unknown[];
    capturedOpacities: [number, number][];
  };

  return {
    view,
    reports,
    images: () => captured.capturedImages,
    opacities: () => captured.capturedOpacities,
    async flush() {
      for (let round = 0; round < 3; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        pendingReads.splice(0).forEach((resolve) => resolve());
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}

function layerOf(id: string, values: string[], end: string) {
  return {
    id,
    title: id,
    units: "",
    grid: { bbox: [0, 0, 2, 2], nx: 2, ny: 2, res: 1 },
    style: { stops: [0, 1] },
    time: { step: "P1M", values, end, method: null },
    arrays: {},
  } as unknown as LayerDoc;
}
