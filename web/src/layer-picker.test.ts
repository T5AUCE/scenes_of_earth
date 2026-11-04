import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { Window } from "happy-dom";

import { commonRange, loadLayerChoices } from "./layer-picker.ts";
import { createMonthSelect } from "./month-select.ts";
import type { MonthSelect } from "./month-select.ts";
import type { LayersResponse } from "./types.ts";

test("month range is the overlap of the checked layers only", () => {
  const rain = { step: "P1M", first: "1981-01", last: "2026-08" };
  const temperature = { step: "P1M", first: "2016-01", last: "2026-06" };

  assert.deepEqual(commonRange([rain]), { first: "1981-01", last: "2026-08" });
  assert.deepEqual(commonRange([rain, temperature]), { first: "2016-01", last: "2026-06" });
});

test("no checked time axis leaves the range unset", () => {
  assert.equal(commonRange([]), null);
});

test("the range defaults to six months ending at the last month", async (context) => {
  const { start, end } = await monthControls(context);

  assert.equal(start.min, "1981-01");
  assert.equal(end.max, "2026-08");
  assert.equal(end.value, "2026-08");
  assert.equal(start.value, "2026-03");
});

test("moving From past To pulls To along, and back again", async (context) => {
  const { start, end } = await monthControls(context);

  end.value = "2026-01";
  end.dispatchEvent(new Event("change"));
  assert.equal(start.value, "2026-01");

  start.value = "2026-04";
  start.dispatchEvent(new Event("change"));
  assert.equal(end.value, "2026-04");
});

test("checking a narrower layer clamps From to the full original date", async (context) => {
  const { layerBox, start } = await monthControls(context);

  start.value = "1981-12";
  toggleLayer(layerBox, "temperature", true);

  assert.equal(start.value, "2016-01");
});

test("checking a narrower layer clamps To to the range end", async (context) => {
  const { layerBox, start, end } = await monthControls(context);

  end.value = "2026-08";
  toggleLayer(layerBox, "temperature", true);

  assert.equal(end.value, "2026-06");
  assert.equal(start.value, "2026-03");
});

test("unchecking to a wider range keeps the picked months", async (context) => {
  const { layerBox, start, end } = await monthControls(context);

  start.value = "1981-12";
  toggleLayer(layerBox, "temperature", true);
  toggleLayer(layerBox, "temperature", false);

  assert.equal(start.min, "1981-01");
  assert.equal(end.max, "2026-08");
  assert.equal(start.value, "2016-01");
  assert.equal(end.value, "2026-06");
});

async function monthControls(
  context: TestContext,
): Promise<{ layerBox: HTMLElement; start: MonthSelect; end: MonthSelect }> {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  context.mock.method(globalThis, "fetch", async () => Response.json(rainAndTemperature()));

  const layerBox = document.createElement("fieldset");
  const start = createMonthSelect("From month", "From year");
  const end = createMonthSelect("To month", "To year");
  await loadLayerChoices({ layerBox, start, end });
  return { layerBox, start, end };
}

function toggleLayer(layerBox: HTMLElement, id: string, checked: boolean): void {
  const box = layerBox.querySelector<HTMLInputElement>(`input[value="${id}"]`);
  assert.ok(box);
  box.checked = checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

function rainAndTemperature(): LayersResponse {
  return {
    request_step: "P1M",
    default: ["rain"],
    layers: [
      {
        id: "rain",
        title: "Rainfall",
        units: "mm/month",
        kind: "field",
        time_varying: true,
        coverage: [0, 0, 1, 1],
        time: { step: "P1M", first: "1981-01", last: "2026-08" },
      },
      {
        id: "temperature",
        title: "Temperature",
        units: "°C",
        kind: "field",
        time_varying: true,
        coverage: [0, 0, 1, 1],
        time: { step: "P1M", first: "2016-01", last: "2026-06" },
      },
    ],
  };
}

function installBrowser(window: Window): void {
  const names = ["Node", "Element", "HTMLElement", "DocumentFragment", "Event"] as const;
  for (const name of names) defineGlobal(name, window[name]);
  defineGlobal("document", window.document);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
