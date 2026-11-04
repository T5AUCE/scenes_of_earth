import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import { assertSameNode } from "../testing/dom-assert.ts";
import type { LayerDoc, Scene } from "../types.ts";
import { draftForEdit, draftForNew } from "./chart-editor.tsx";

test("an unchecked new chart keeps the old main", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer(), tempLayer()];
  const store = createSceneStore(layers, display());
  const before = store.getSnapshot().charts.definitions.length;
  const existing = store.getSnapshot().charts.definitions.map((entry) => entry.id);
  const initial = draftForNew(layers, existing)!;
  const saved: string[] = [];
  let cancelled = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={initial}
        isNew={true}
        currentTime="2019-02-01"
        onSave={(id) => saved.push(id)}
        onCancel={() => cancelled++}
      />,
    );
  });
  assert.ok(host.querySelector("svg"));
  assert.ok(host.querySelector("figure"));
  assert.match(host.textContent ?? "", /By month|Over time/);
  const beforeMain = store.getSnapshot().charts.mainChartId;

  const title = host.querySelector('input[type="text"]') as HTMLInputElement;
  await act(async () => {
    setFieldValue(window, title, "Edited title");
  });

  const save = saveButton(host);
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 1);
  assert.equal(store.getSnapshot().charts.definitions.length, before + 1);
  assert.equal(cancelled, 0);
  const stored = store.getSnapshot().charts.definitions.find((entry) => entry.id === saved[0])!;
  assert.equal(stored.title, "Edited title");
  assert.equal(stored.id, initial.id);
  assert.equal(store.getSnapshot().charts.mainChartId, beforeMain);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("clipping ranges block save while hints and table stay visible", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const before = JSON.stringify(store.getSnapshot().charts);
  const initial = draftForEdit(definition);
  const saved: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={{ ...initial, options: { ...initial.options, yRange: [10, 11] } }}
        isNew={false}
        currentTime={null}
        onSave={(id) => saved.push(id)}
        onCancel={() => {}}
      />,
    );
  });
  const save = saveButton(host);
  await act(async () => {
    save.focus();
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 0);
  assert.match(host.textContent ?? "", /baseline|observed/);
  assert.ok(host.querySelector("details"));
  assert.equal(JSON.stringify(store.getSnapshot().charts), before);
  assertSameNode(document.activeElement, save);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("changing the layer commits a cleaned unit with its source", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer(), tempLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const initial = {
    ...draftForEdit(definition),
    options: { ...draftForEdit(definition).options, displayUnit: "in/month" },
  };
  const saved: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={initial}
        isNew={false}
        currentTime={null}
        onSave={(id) => saved.push(id)}
        onCancel={() => {}}
      />,
    );
  });
  const layerSelect = [...host.querySelectorAll("select")][0] as HTMLSelectElement;
  await act(async () => {
    setSelectValue(window, layerSelect, "temp");
  });
  assert.match(host.textContent ?? "", /display unit was reset/);
  const save = saveButton(host);
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 1);
  const stored = store.getSnapshot().charts.definitions.find((entry) => entry.id === saved[0])!;
  assert.equal(stored.source.layerId, "temp");
  assert.equal(stored.options.displayUnit, undefined);
  assert.equal(stored.id, definition.id);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("changing the layer commits a cleaned range with its source", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer(), tempLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const initial = {
    ...draftForEdit(definition),
    options: { ...draftForEdit(definition).options, yRange: [0, 11] as [number, number] },
  };
  const saved: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={initial}
        isNew={false}
        currentTime={null}
        onSave={(id) => saved.push(id)}
        onCancel={() => {}}
      />,
    );
  });
  const layerSelect = [...host.querySelectorAll("select")][0] as HTMLSelectElement;
  await act(async () => {
    setSelectValue(window, layerSelect, "temp");
  });
  assert.match(host.textContent ?? "", /y-range was reset/);
  const save = saveButton(host);
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 1);
  const stored = store.getSnapshot().charts.definitions.find((entry) => entry.id === saved[0])!;
  assert.equal(stored.source.layerId, "temp");
  assert.equal(stored.options.yRange, null);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("changing the table shape commits a seasonal source", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  assert.equal(definition.source.shape, "time_series");
  const saved: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={draftForEdit(definition)}
        isNew={false}
        currentTime={null}
        onSave={(id) => saved.push(id)}
        onCancel={() => {}}
      />,
    );
  });
  const shapeSelect = [...host.querySelectorAll("select")][1] as HTMLSelectElement;
  await act(async () => {
    setSelectValue(window, shapeSelect, "seasonal_cycle");
  });
  assert.match(host.textContent ?? "", /Jan|By month/);
  const save = saveButton(host);
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 1);
  const stored = store.getSnapshot().charts.definitions.find((entry) => entry.id === saved[0])!;
  assert.equal(stored.source.shape, "seasonal_cycle");
  assert.equal(stored.source.layerId, "rain");
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("dirty back asks to save, discard or keep editing", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const before = JSON.stringify(store.getSnapshot().charts);
  const dirties: boolean[] = [];
  let cancelled = 0;
  const saved: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={draftForEdit(definition)}
        isNew={false}
        currentTime={null}
        onSave={(id) => saved.push(id)}
        onCancel={() => cancelled++}
        onDirtyChange={(dirty) => dirties.push(dirty)}
      />,
    );
  });
  assert.ok(dirties.includes(false));

  const title = host.querySelector('input[type="text"]') as HTMLInputElement;
  await act(async () => {
    setFieldValue(window, title, "Dirty title");
  });
  assert.ok(dirties.includes(true));

  const back = backButton(host);
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(host.textContent ?? "", /unsaved changes/);

  const keep = keepButton(host);
  await act(async () => {
    keep.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(cancelled, 0);
  assert.equal(saved.length, 0);
  assert.equal(JSON.stringify(store.getSnapshot().charts), before);

  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const discard = discardButton(host);
  await act(async () => {
    discard.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(cancelled, 1);
  assert.equal(JSON.stringify(store.getSnapshot().charts), before);

  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("every option control renders with live preview and categorical note", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer(), categoricalLayer()];
  const store = createSceneStore([rainLayer()], display());
  const initial = draftForNew([rainLayer()], [])!;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={initial}
        isNew={true}
        currentTime={null}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
  });
  assert.match(host.textContent ?? "", /Series ink/);
  assert.match(host.textContent ?? "", /Display unit/);
  assert.match(host.textContent ?? "", /Y range/);
  assert.match(host.textContent ?? "", /Grid/);
  assert.match(host.textContent ?? "", /Point marks/);
  assert.match(host.textContent ?? "", /Reference lines/);
  assert.match(host.textContent ?? "", /Use as main/);
  assert.match(host.textContent ?? "", /Categorical shares arrive later/);
  assert.ok(host.querySelector("svg"));
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("repeated dirty back keeps pending with focus and keep restores invoking", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const { draftForEdit } = await import("./chart-editor.tsx");
  let cancelled = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={draftForEdit(definition)}
        isNew={false}
        currentTime={null}
        onSave={() => {}}
        onCancel={() => cancelled++}
      />,
    );
  });
  const title = host.querySelector('input[type="text"]') as HTMLInputElement;
  await act(async () => {
    setFieldValue(window, title, "Dirty title");
  });
  const back = backButton(host);
  await act(async () => {
    back.focus();
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const saveConfirm = confirmSaveButton(host);
  assertSameNode(document.activeElement, saveConfirm);
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(cancelled, 0);
  assert.ok(host.querySelector(".editor-confirm"));
  assertSameNode(document.activeElement, saveConfirm);
  const keep = keepButton(host);
  await act(async () => {
    keep.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(document.activeElement, back);
  assert.equal(cancelled, 0);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("checked main moves the main chart to the saved id", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer(), tempLayer()];
  const store = createSceneStore(layers, display());
  const existing = store.getSnapshot().charts.definitions.map((entry) => entry.id);
  const { draftForNew } = await import("./chart-editor.tsx");
  const initial = draftForNew(layers, existing)!;
  const savedIds: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={initial}
        isNew={true}
        currentTime="2019-02-01"
        onSave={(id) => savedIds.push(id)}
        onCancel={() => {}}
      />,
    );
  });
  const title = host.querySelector('input[type="text"]') as HTMLInputElement;
  await act(async () => {
    setFieldValue(window, title, "Main chart");
  });
  const useMain = checkboxFor(host, "Use as main");
  assert.equal(useMain.checked, false);
  await act(async () => {
    useMain.click();
  });
  assert.equal(useMain.checked, true);
  const save = saveButton(host);
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(savedIds.length, 1);
  assert.equal(savedIds[0], initial.id);
  const stored = store.getSnapshot().charts.definitions.find((entry) => entry.id === initial.id)!;
  assert.equal(stored.title, "Main chart");
  assert.equal(store.getSnapshot().charts.mainChartId, initial.id);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("editor footer carries complete basemap attribution", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const { draftForEdit } = await import("./chart-editor.tsx");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={draftForEdit(definition)}
        isNew={false}
        currentTime={null}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
  });
  const footer = host.querySelector(".editor-attribution")?.textContent ?? "";
  assert.match(footer, /OpenFreeMap/);
  assert.match(footer, /OpenMapTiles/);
  assert.match(footer, /OpenStreetMap/);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("complete save stores options preview and invalid stays with focus", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor, draftForEdit } = await import("./chart-editor.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const saved: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={draftForEdit(definition)}
        isNew={false}
        currentTime="2019-02-01"
        onSave={(id) => saved.push(id)}
        onCancel={() => {}}
      />,
    );
  });
  assert.ok(host.querySelector(".chart-cursor"));
  const title = host.querySelector('input[type="text"]') as HTMLInputElement;
  await act(async () => {
    setFieldValue(window, title, "Edited title");
  });
  await act(async () => {
    setSelectValue(window, selectFor(host, "Type"), "line");
  });
  await act(async () => {
    setSelectValue(window, selectFor(host, "Series ink"), "deep-red");
  });
  await act(async () => {
    setSelectValue(window, selectFor(host, "Display unit"), "in/month");
  });
  const automatics = [...host.querySelectorAll('input[type="text"]')].filter(
    (input) => (input as HTMLInputElement).placeholder === "Automatic",
  ) as HTMLInputElement[];
  await act(async () => {
    setFieldValue(window, automatics[0], "Custom X");
  });
  await act(async () => {
    setFieldValue(window, automatics[1], "Custom Y");
  });
  const rangeFieldset = [...host.querySelectorAll("fieldset")].find(
    (fieldset) => (fieldset.querySelector("legend")?.textContent ?? "").includes("Y range"),
  )!;
  const autoBox = rangeFieldset?.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => {
    autoBox.click();
  });
  const numbers = [...host.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
  await act(async () => {
    setFieldValue(window, numbers[0], "0");
  });
  await act(async () => {
    setFieldValue(window, numbers[1], "20");
  });
  await act(async () => {
    checkboxFor(host, "Grid").click();
  });
  await act(async () => {
    checkboxFor(host, "Point marks").click();
  });
  assert.ok(host.querySelector("svg"));
  assert.ok(host.querySelector("polyline"));
  assert.match(host.textContent ?? "", /Custom X/);
  assert.match(host.textContent ?? "", /Custom Y/);
  assert.match(host.textContent ?? "", /0\.393/);
  assertSameNode(host.querySelector(".chart-grid"), null);
  assert.ok(host.querySelectorAll("circle").length >= 1);
  assert.match(host.querySelector("polyline")?.getAttribute("stroke") ?? "", /#7a2430/);
  await act(async () => {
    checkboxFor(host, "Current").click();
  });
  assertSameNode(host.querySelector(".chart-cursor"), null);
  await act(async () => {
    checkboxFor(host, "Reference lines").click();
  });
  const save = saveButton(host);
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 1);
  const stored = store.getSnapshot().charts.definitions.find((entry) => entry.id === saved[0])!;
  assert.equal(stored.title, "Edited title");
  assert.equal(stored.chartType, "line");
  assert.equal(stored.options.ink, "deep-red");
  assert.equal(stored.options.displayUnit, "in/month");
  assert.equal(stored.options.xTitle, "Custom X");
  assert.equal(stored.options.yTitle, "Custom Y");
  assert.deepEqual(stored.options.yRange, [0, 20]);
  assert.equal(stored.options.showGrid, false);
  assert.equal(stored.options.showPoints, true);
  assert.equal(stored.options.showCurrentTime, false);
  assert.equal(stored.options.showReferences, false);
  assert.equal(stored.id, definition.id);
  const beforeInvalid = JSON.stringify(store.getSnapshot().charts);
  const invalidNumbers = [...host.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
  await act(async () => {
    setFieldValue(window, invalidNumbers[0], "11");
  });
  await act(async () => {
    setFieldValue(window, invalidNumbers[1], "12");
  });
  await act(async () => {
    save.focus();
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 1);
  assert.match(host.textContent ?? "", /observed|baseline/);
  assert.equal(title.value, "Edited title");
  assertSameNode(document.activeElement, save);
  assert.equal(JSON.stringify(store.getSnapshot().charts), beforeInvalid);
  await act(async () => {
    const back = backButton(host);
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(host.querySelector(".editor-confirm"));
  const decisionSave = confirmSaveButton(host);
  assertSameNode(document.activeElement, decisionSave);
  await act(async () => {
    decisionSave.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 1);
  assert.match(host.textContent ?? "", /observed|baseline/);
  assert.ok(host.querySelector(".editor-confirm"));
  assertSameNode(document.activeElement, decisionSave);
  assert.equal(JSON.stringify(store.getSnapshot().charts), beforeInvalid);
  assert.equal((host.querySelector('input[type="text"]') as HTMLInputElement).value, "Edited title");
  const retained = [...host.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
  assert.equal(retained[0].value, "11");
  assert.equal(retained[1].value, "12");
  assert.equal(selectFor(host, "Series ink").value, "deep-red");
  assert.equal(selectFor(host, "Display unit").value, "in/month");
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("distribution preview follows references and a different ink", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./chart-editor.tsx");

  const layers = [terrainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  assert.equal(definition.source.shape, "distribution");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={draftForEdit(definition)}
        isNew={false}
        currentTime={null}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
  });
  assert.ok(host.querySelector(".chart-references"));
  assert.match(host.textContent ?? "", /Sea level/);
  await act(async () => {
    setSelectValue(window, selectFor(host, "Series ink"), "deep-red");
  });
  assert.match(host.querySelector("polygon")?.getAttribute("stroke") ?? "", /#7a2430/);
  await act(async () => {
    checkboxFor(host, "Reference lines").click();
  });
  const referenceTexts = [...host.querySelectorAll(".chart-references text")].map(
    (node) => node.textContent ?? "",
  );
  assert.equal(
    referenceTexts.some(
      (text) => text.includes("Mean") || text.includes("Median") || text.includes("Sea level"),
    ),
    false,
  );
  assert.match(host.textContent ?? "", /Sea level/);
  await act(async () => {
    root.unmount();
  });
  host.remove();
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
      reference_values: [{ id: "sea_level", value: 0 }],
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

function selectFor(host: ParentNode, labelText: string): HTMLSelectElement {
  const label = [...host.querySelectorAll("label")].find(
    (entry) => (entry.textContent ?? "").includes(labelText),
  );

  return label?.querySelector("select") as HTMLSelectElement;
}

test("checkbox rows align while types show capitals with lowercase values", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor, draftForEdit } = await import("./chart-editor.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={draftForEdit(definition)}
        isNew={false}
        currentTime={null}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
  });
  const boxes = [...host.querySelectorAll('input[type="checkbox"]')];
  assert.equal(boxes.length, 6);
  for (const box of boxes) {
    const label = box.closest("label")!;
    assert.ok(label.classList.contains("checkbox-row"));
    assert.ok((label.textContent ?? "").trim().length > 0);
  }
  const typeSelect = selectFor(host, "Type");
  const options = [...typeSelect.querySelectorAll("option")];
  assert.deepEqual(options.map((option) => option.value), ["line", "bar", "area"]);
  assert.deepEqual(
    options.map((option) => option.textContent),
    ["Line", "Bar", "Area"],
  );
  await act(async () => {
    root.unmount();
  });
});

test("preview notes follow the draft with exact ranges and no duplicate hints", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor, draftForEdit } = await import("./chart-editor.tsx");

  const rain = rainLayer();
  rain.area_series!.valid_fraction[0] = 0.5;
  const layers = [rain, tempLayer(), terrainLayer()];
  const store = createSceneStore(layers, display());
  const definition = store.getSnapshot().charts.definitions[0];
  const saved: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartEditor
        scene={makeScene(layers)}
        store={store}
        initial={{
          ...draftForEdit(definition),
          options: { ...draftForEdit(definition).options, yRange: [0, 20.123456789] },
        }}
        isNew={false}
        currentTime={null}
        onSave={(id) => saved.push(id)}
        onCancel={() => {}}
      />,
    );
  });
  assertSameNode(host.querySelector(".chart-hint"), null);
  assert.ok(host.querySelector("[data-chart-notes-heading]"));
  const notesText = () => host.querySelector(".chart-notes")?.textContent ?? "";
  assert.match(notesText(), /Hollow marks/);
  assert.doesNotMatch(notesText(), /By month averages|Filled size depends/);
  await act(async () => {
    setSelectValue(window, selectFor(host, "Table"), "seasonal_cycle");
  });
  assert.match(notesText(), /By month averages/);
  await act(async () => {
    setSelectValue(window, selectFor(host, "Layer"), "temp");
  });
  assert.doesNotMatch(notesText(), /Hollow marks/);
  assert.match(notesText(), /By month averages/);
  await act(async () => {
    setSelectValue(window, selectFor(host, "Type"), "line");
  });
  assert.doesNotMatch(notesText(), /Filled size depends/);
  await act(async () => {
    setSelectValue(window, selectFor(host, "Type"), "area");
  });
  assert.match(notesText(), /Filled size depends on the chosen zero/);
  assert.equal(host.querySelectorAll(".chart-notes").length, 1);
  assertSameNode(host.querySelector(".chart-hint"), null);
  const save = saveButton(host);
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(saved.length, 1);
  const stored = store.getSnapshot().charts.definitions.find((entry) => entry.id === saved[0])!;
  assert.deepEqual(stored.source, { layerId: "temp", shape: "seasonal_cycle" });
  assert.equal(stored.chartType, "area");
  assert.deepEqual(stored.options.yRange, [0, 20.123456789]);
  await act(async () => {
    root.unmount();
  });
});

function checkboxFor(host: ParentNode, labelText: string): HTMLInputElement {
  const label = [...host.querySelectorAll("label")].find(
    (entry) => (entry.textContent ?? "").includes(labelText),
  );

  return label?.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

function setFieldValue(window: Window, input: HTMLInputElement, value: string): void {
  const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  native?.set?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function saveButton(host: ParentNode): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Save",
  );
  return button as HTMLButtonElement;
}

function backButton(host: ParentNode): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Back to charts",
  );
  return button as HTMLButtonElement;
}

function confirmSaveButton(host: ParentNode): HTMLButtonElement {
  const button = [...host.querySelectorAll(".editor-confirm button")].find(
    (entry) => entry.textContent === "Save",
  );
  return button as HTMLButtonElement;
}

function keepButton(host: ParentNode): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Keep editing",
  );
  return button as HTMLButtonElement;
}

function discardButton(host: ParentNode): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Discard",
  );
  return button as HTMLButtonElement;
}

function setSelectValue(window: Window, select: HTMLSelectElement, value: string): void {
  const native = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
  native?.set?.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function installBrowser(window: Window): void {
  const names = [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "HTMLSelectElement",
    "HTMLInputElement",
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
