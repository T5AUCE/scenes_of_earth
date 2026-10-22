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
    if (context.parentURL?.includes("/src/") && specifier.startsWith(".")) {
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
        export const addImageLayer = () => {};
        export const removeLayerAndSource = () => {};
        export const maxTextureSize = () => 64;
        export const setImage = (map, id, image) => {
          (globalThis.capturedImages ??= []).push(image);
        };
      `;
    case "./field":
      return `
        export const fieldReader = () => () => new Promise((resolve) => {
          globalThis.pendingReads.push(() => resolve(Float32Array.of(1, 1, 1, 1)));
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
