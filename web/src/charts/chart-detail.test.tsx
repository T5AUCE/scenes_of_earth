import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import type { LayerDoc, Scene } from "../types.ts";

test("the close-up shows its chart with Back, Edit, main and delete", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const layers = [rainLayer(), terrainLayer()];
  const store = createSceneStore(layers, display());
  const main = store.getSnapshot().charts.mainChartId!;
  const backs: string[] = [];
  const edits: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartDetail
        scene={makeScene(layers)}
        store={store}
        definitionId={main}
        currentTime="2019-02-01"
        onBack={() => backs.push("back")}
        onEdit={(id) => edits.push(id)}
      />,
    );
  });
  assert.match(host.textContent ?? "", /Rain over time/);
  assert.ok(host.querySelector("svg"));
  assert.ok(host.querySelector("details"));

  const useMain = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Use as main",
  ) as HTMLButtonElement;
  assert.equal(useMain.disabled, true);

  const edit = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(edits, [main]);

  const back = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Back to charts",
  )!;
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(backs, ["back"]);
  await act(async () => {
    root.unmount();
  });
});

test("a second chart can become main and deletion returns to the gallery", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const layers = [rainLayer(), terrainLayer()];
  const store = createSceneStore(layers, display());
  const second = store.getSnapshot().charts.definitions[1].id;
  const backs: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartDetail
        scene={makeScene(layers)}
        store={store}
        definitionId={second}
        currentTime={null}
        onBack={() => backs.push("back")}
        onEdit={() => {}}
      />,
    );
  });
  const useMain = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Use as main",
  )!;
  await act(async () => {
    useMain.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(store.getSnapshot().charts.mainChartId, second);

  const remove = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Delete",
  )!;
  await act(async () => {
    remove.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(backs, ["back"]);
  assert.equal(store.getSnapshot().charts.definitions.length, 1);
  await act(async () => {
    root.unmount();
  });
});

test("a missing chart explains itself without crashing", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const backs: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartDetail
        scene={makeScene(layers)}
        store={store}
        definitionId="missing"
        currentTime={null}
        onBack={() => backs.push("back")}
        onEdit={() => {}}
      />,
    );
  });
  assert.match(host.textContent ?? "", /no longer available/);
  const back = host.querySelector("button")!;
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(backs, ["back"]);
  await act(async () => {
    root.unmount();
  });
});

test("detail shows sync notice and follows effective palette", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const main = store.getSnapshot().charts.mainChartId!;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartDetail
        scene={makeScene(layers)}
        store={store}
        definitionId={main}
        currentTime="2019-02-01"
        syncNotice="Charts are kept for this visit only."
        onBack={() => {}}
        onEdit={() => {}}
      />,
    );
  });
  assert.match(host.textContent ?? "", /kept for this visit/);
  const before = host.querySelector("polyline, polygon, rect")?.getAttribute("stroke");
  await act(async () => {
    store.dispatch({
      kind: "display",
      update: (display) => {
        display.layers.rain = { palette: "cividis" };
      },
    });
  });
  const after = host.querySelector("polyline, polygon, rect")?.getAttribute("stroke");
  assert.notEqual(before, after);
  await act(async () => {
    root.unmount();
  });
});

function display() {
  return { layers: {}, off: new Set<string>(), showAs: {} };
}

function makeScene(layers: LayerDoc[]): Scene {
  return {
    id: "test",
    title: "Test scene",
    layers,
  } as unknown as Scene;
}

function rainLayer(): LayerDoc {
  const values = monthlyValues(30);

  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1M", values, end: "2021-07-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map(() => 10),
      valid_fraction: values.map(() => 1),
    },
  } as unknown as LayerDoc;
}

function terrainLayer(): LayerDoc {
  return {
    id: "terrain",
    title: "Terrain",
    units: "m",
    style: { kind: "terrain", encodings: ["shade"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    time: null,
    distribution: {
      statistic: "quantiles",
      weights: "cell_area_inside_outline",
      percent: 1,
      values: Array.from({ length: 101 }, (_, index) => index * 10),
      min: 0,
      max: 1000,
      mean: 500,
      valid_fraction: 0.9,
      reference_values: [],
    },
  } as unknown as LayerDoc;
}

function monthlyValues(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2019, index, 1));
    return date.toISOString().slice(0, 10);
  });
}

function installBrowser(window: Window): void {
  const names = [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "SVGElement",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
  ] as const;
  for (const name of names) defineGlobal(name, window[name]);
  defineGlobal("window", window);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("localStorage", window.localStorage);
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
