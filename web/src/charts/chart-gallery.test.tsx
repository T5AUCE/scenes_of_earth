import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import type { LayerDoc, Scene } from "../types.ts";

test("the gallery shows saved previews with a deterministic main", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartGallery } = await import("./chart-gallery.tsx");

  const layers = [rainLayer(), tempLayer(), terrainLayer()];
  const store = createSceneStore(layers, display());
  const opened: string[] = [];
  const edited: string[] = [];
  let created = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartGallery
        scene={makeScene(layers)}
        store={store}
        currentTime="2019-02-01"
        onOpenDetail={(id) => opened.push(id)}
        onEdit={(id) => edited.push(id)}
        onNew={() => created++}
      />,
    );
  });
  assert.ok(host.textContent?.includes("Rain over time"));
  assert.ok(host.textContent?.includes("Main"));
  assert.equal(host.querySelectorAll(".gallery-card").length, 3);
  assert.equal(host.querySelector(".chart-unavailable"), null);

  const mainButton = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Use as main" && !button.disabled,
  )!;
  await act(async () => {
    mainButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.notEqual(store.getSnapshot().charts.mainChartId, "rain:time_series");

  await act(async () => {
    const reset = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Reset charts",
    )!;
    reset.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(store.getSnapshot().charts.mainChartId, "rain:time_series");

  const open = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Open",
  )!;
  await act(async () => {
    open.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(opened.length, 1);

  const edit = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(edited.length, 1);
  assert.equal(created, 0);

  const createdButton = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "+ New chart",
  )!;
  await act(async () => {
    createdButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(created, 1);
  await act(async () => {
    root.unmount();
  });
});

test("the gallery keeps labelled unavailable tiles and disables creation", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartGallery } = await import("./chart-gallery.tsx");

  const rainOnly = [rainLayer()];
  const store = createSceneStore(rainOnly, display());
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartGallery
        scene={makeScene(rainOnly)}
        store={store}
        currentTime={null}
        onOpenDetail={() => {}}
        onEdit={() => {}}
        onNew={() => {}}
      />,
    );
  });
  assert.ok(host.textContent?.includes("No temperature series"));
  assert.ok(host.textContent?.includes("No elevation distribution"));
  assert.equal(host.querySelectorAll(".chart-unavailable").length, 2);
  assert.equal(
    (host.querySelector("button") as HTMLButtonElement).disabled,
    false,
  );
  await act(async () => {
    root.unmount();
  });

  const empty: LayerDoc[] = [categoricalLayer()];
  const emptyStore = createSceneStore(empty, display());
  const second = document.createElement("div");
  document.body.append(second);
  const secondRoot = createRoot(second);
  await act(async () => {
    secondRoot.render(
      <ChartGallery
        scene={makeScene(empty)}
        store={emptyStore}
        currentTime={null}
        onOpenDetail={() => {}}
        onEdit={() => {}}
        onNew={() => {}}
      />,
    );
  });
  const creation = [...second.querySelectorAll("button")].find(
    (button) => button.textContent === "+ New chart",
  ) as HTMLButtonElement;
  assert.equal(creation.disabled, true);
  assert.match(second.textContent ?? "", /no chartable layer/);
  await act(async () => {
    secondRoot.unmount();
  });
});

test("follow ink tracks effective palette and sync notice shows", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartGallery } = await import("./chart-gallery.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartGallery
        scene={makeScene(layers)}
        store={store}
        currentTime="2019-02-01"
        syncNotice="The share link is too long."
        onOpenDetail={() => {}}
        onEdit={() => {}}
        onNew={() => {}}
      />,
    );
  });
  assert.match(host.textContent ?? "", /too long/);
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

function tempLayer(): LayerDoc {
  const values = monthlyValues(30);

  return {
    id: "temp",
    title: "Temperature",
    units: "°C",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1M", values, end: "2021-07-01", method: "mean" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map(() => 20),
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

function categoricalLayer(): LayerDoc {
  return {
    id: "landcover",
    title: "Land cover",
    units: "class",
    style: { kind: "categorical", encodings: ["fill"] },
    time: null,
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
