import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import { assertSameNode } from "../testing/dom-assert.ts";
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
  assertSameNode(host.querySelector(".chart-unavailable"), null);

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
  const mark = () =>
    host.querySelector("rect")?.getAttribute("fill")
    ?? host.querySelector("polyline, polygon")?.getAttribute("stroke");
  const before = mark();
  await act(async () => {
    store.dispatch({
      kind: "display",
      update: (display) => {
        display.layers.rain = { palette: "cividis" };
      },
    });
  });
  const after = mark();
  assert.notEqual(before, after);
  await act(async () => {
    root.unmount();
  });
});

test("cards hide long notes while the Notes action requests detail focus", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartGallery } = await import("./chart-gallery.tsx");

  const rain = rainLayer();
  rain.area_series!.fallback_fraction = rain.time!.values.map(() => 0.123456789);
  rain.fallback_sources = [{ name: "ERA5" }] as LayerDoc["fallback_sources"];
  const layers = [rain, tempLayer(), terrainLayer()];
  const store = createSceneStore(layers, display());
  const opened: { id: string; notes?: boolean }[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartGallery
        scene={makeScene(layers)}
        store={store}
        currentTime={null}
        onOpenDetail={(id, focusNotes) => opened.push({ id, notes: focusNotes })}
        onEdit={() => {}}
        onNew={() => {}}
      />,
    );
  });
  const cards = [...host.querySelectorAll(".gallery-card")];
  for (const card of cards) {
    const text = card.textContent ?? "";
    assert.equal(text.includes("Hollow marks"), false);
    assert.equal(text.includes("area-weighted"), false);
    assert.equal(text.includes("quantile heights"), false);
    assert.doesNotMatch(text, /ERA5|filled from|12\.346%|12\.3456789/);
    assertSameNode(card.querySelector(".chart-notes"), null);
  }
  const terrainCard = cards.find(
    (card) => (card as HTMLElement).dataset.chartId === "terrain:distribution",
  )!;
  const notesButton = terrainCard.querySelector(".chart-notes-button") as HTMLButtonElement;
  assert.equal(
    notesButton.getAttribute("aria-label"),
    "Notes for Terrain distribution; opens chart detail",
  );
  await act(async () => {
    notesButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(opened, [{ id: "terrain:distribution", notes: true }]);
  const rainCard = cards.find(
    (card) => (card as HTMLElement).dataset.chartId === "rain:time_series",
  )!;
  const rainNotes = rainCard.querySelector(".chart-notes-button") as HTMLButtonElement;
  assert.ok(rainNotes);
  for (const key of ["Enter", " "]) {
    rainNotes.focus();
    assertSameNode(document.activeElement, rainNotes);
    await act(async () => {
      rainNotes.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
      rainNotes.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true }));
      // Happy DOM needs the native button activation supplied explicitly.
      rainNotes.click();
    });
  }
  assert.deepEqual(opened, [
    { id: "terrain:distribution", notes: true },
    { id: "rain:time_series", notes: true },
    { id: "rain:time_series", notes: true },
  ]);
  const tempCard = cards.find(
    (card) => (card as HTMLElement).dataset.chartId === "temp:time_series",
  )!;
  assertSameNode(tempCard.querySelector(".chart-notes-button"), null);
  await act(async () => {
    root.unmount();
  });
});

test("temperature keeps readable paint across all chart types", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartGallery } = await import("./chart-gallery.tsx");
  const { fieldGradient } = await import("../render/palettes.ts");
  const { paletteInkFor } = await import("./paint.ts");

  const layers = [tempLayer()];
  layers[0].style.palette = "climate";
  const store = createSceneStore(layers, display());
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartGallery
        scene={makeScene(layers)}
        store={store}
        currentTime={null}
        onOpenDetail={() => {}}
        onEdit={() => {}}
        onNew={() => {}}
      />,
    );
  });
  for (const chartType of ["line", "bar", "area"] as const) {
    const definition = store.getSnapshot().charts.definitions[0];
    await act(async () => {
      store.dispatch({ kind: "saveChart", definition: { ...definition, chartType } });
    });
    const selector = chartType === "line"
      ? '.chart-lines polyline:not([aria-hidden="true"])'
      : chartType === "bar" ? ".chart-bars rect" : ".chart-areas polygon";
    const attribute = chartType === "line" ? "stroke" : "fill";
    for (const palette of ["climate", "blue-red"]) {
      await act(async () => {
        store.dispatch({
          kind: "display",
          update: (display) => {
            display.layers.temp = { palette };
          },
        });
      });
      const expected = paletteInkFor(fieldGradient(palette)!, "#1a3658");
      assert.equal(host.querySelector(selector)?.getAttribute(attribute), expected);
      assert.notEqual(expected, "#f7f7f7");
    }
    await act(async () => {
      store.dispatch({
        kind: "display",
        update: (display) => {
          display.layers.temp = { ink: "white" };
        },
      });
    });
    const whiteMark = host.querySelector(selector)!;
    assert.equal(whiteMark.getAttribute(attribute), "#ffffff");
    if (chartType === "line") {
      const under = host.querySelector('.chart-lines polyline[aria-hidden="true"]')!;
      assert.equal(under.getAttribute("stroke"), "#1a3658");
    } else {
      assert.equal(whiteMark.getAttribute("stroke"), "#1a3658");
    }
  }
  await act(async () => {
    root.unmount();
  });
});

test("choosing main confirms without leaving the gallery", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartGallery } = await import("./chart-gallery.tsx");

  const layers = [rainLayer(), tempLayer()];
  const store = createSceneStore(layers, display());
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartGallery
        scene={makeScene(layers)}
        store={store}
        currentTime={null}
        onOpenDetail={() => {}}
        onEdit={() => {}}
        onNew={() => {}}
      />,
    );
  });
  const mainButton = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Use as main" && !button.disabled,
  ) as HTMLButtonElement;
  mainButton.focus();
  await act(async () => {
    mainButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const statuses = [...host.querySelectorAll('[role="status"]')].map(
    (node) => node.textContent ?? "",
  );
  assert.ok(
    statuses.some((text) => /is now the main chart in the scene panel's Charts tab/.test(text)),
  );
  assertSameNode(document.activeElement, mainButton);
  assert.ok(host.querySelector(".gallery-grid"));
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
