import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import { assertSameNode } from "../testing/dom-assert.ts";
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

test("a time close-up downloads its layer means in source units with cleanup", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
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
        currentTime={null}
        onBack={() => {}}
        onEdit={() => {}}
      />,
    );
  });
  const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
  assert.ok(buttons.includes("Area means (CSV)"));
  assert.equal(buttons.includes("By month (CSV)"), false);
  assert.equal(buttons.includes("Elevation distribution (CSV)"), false);

  const download = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Area means (CSV)",
  )!;
  await act(async () => {
    download.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(downloads.blobs.length, 1);
  const content = await downloads.blobs[0].text();
  assert.equal(
    downloads.anchors.at(-1)?.download,
    "test-scene_2019-01-01_2021-07-01_area-means.csv",
  );
  assert.ok(content.includes("rain_mean [mm/month]"));
  assert.equal(downloads.revoked.length, 1);
  assert.equal(document.body.contains(downloads.anchors[0]), false);
  await act(async () => {
    root.unmount();
  });
});

test("a seasonal close-up downloads by-month rows without other exports", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  store.dispatch({
    kind: "saveChart",
    definition: {
      id: "rain-bymonth",
      title: "Rain by month",
      source: { layerId: "rain", shape: "seasonal_cycle" },
      chartType: "bar",
      options: {},
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartDetail
        scene={makeScene(layers)}
        store={store}
        definitionId="rain-bymonth"
        currentTime={null}
        onBack={() => {}}
        onEdit={() => {}}
      />,
    );
  });
  const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
  assert.ok(buttons.includes("By month (CSV)"));
  assert.equal(buttons.includes("Area means (CSV)"), false);
  assert.equal(buttons.includes("Elevation distribution (CSV)"), false);

  const download = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "By month (CSV)",
  )!;
  await act(async () => {
    download.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(downloads.blobs.length, 1);
  const content = await downloads.blobs[0].text();
  assert.ok(downloads.anchors.at(-1)?.download.endsWith("_by-month.csv"));
  assert.ok(content.includes("sample_count"));
  assert.equal(downloads.revoked.length, 1);
  assert.equal(document.body.contains(downloads.anchors[0]), false);
  await act(async () => {
    root.unmount();
  });
});

test("a distribution close-up downloads exact elevation stats", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const layers = [rainLayer(), terrainLayer()];
  const store = createSceneStore(layers, display());
  const second = store.getSnapshot().charts.definitions[1].id;
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
        onBack={() => {}}
        onEdit={() => {}}
      />,
    );
  });
  const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
  assert.ok(buttons.includes("Elevation distribution (CSV)"));
  assert.equal(buttons.includes("Area means (CSV)"), false);
  assert.equal(buttons.includes("By month (CSV)"), false);

  const download = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Elevation distribution (CSV)",
  )!;
  await act(async () => {
    download.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const content = await downloads.blobs[0].text();
  assert.ok(content.includes("share_of_valid_area_below_pct,elevation [m]"));
  assert.ok(content.includes("# Mean elevation: 500 m."));
  assert.ok(content.includes("# Median elevation: 500 m."));
  assert.equal(downloads.revoked.length, 1);
  await act(async () => {
    root.unmount();
  });
});

test("close-up downloads keep source units after a viewer unit switch", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const layers = [rainLayer()];
  const store = createSceneStore(layers, display());
  const main = store.getSnapshot().charts.mainChartId!;
  await act(async () => {
    store.dispatch({
      kind: "display",
      update: (display) => {
        display.layers.rain = { units: "in/month" };
      },
    });
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChartDetail
        scene={makeScene(layers)}
        store={store}
        definitionId={main}
        currentTime={null}
        onBack={() => {}}
        onEdit={() => {}}
      />,
    );
  });
  const download = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Area means (CSV)",
  )!;
  await act(async () => {
    download.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const content = await downloads.blobs[0].text();
  assert.ok(content.includes("rain_mean [mm/month]"));
  assert.equal(content.includes("in/month"), false);
  await act(async () => {
    root.unmount();
  });
});

function installDownloadCapture(context: { after(hook: () => void): void }) {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const anchors: HTMLAnchorElement[] = [];
  const originalCreate = document.createElement.bind(document);
  const originalObjectUrl = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  (document as unknown as Record<string, unknown>).createElement = (tag: string) => {
    const element = originalCreate(tag);
    if (tag === "a") anchors.push(element as HTMLAnchorElement);

    return element;
  };
  (URL as unknown as Record<string, unknown>).createObjectURL = (blob: Blob) => {
    blobs.push(blob);

    return "blob:fake-download";
  };
  (URL as unknown as Record<string, unknown>).revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  context.after(() => {
    (document as unknown as Record<string, unknown>).createElement = originalCreate;
    URL.createObjectURL = originalObjectUrl;
    URL.revokeObjectURL = originalRevoke;
  });

  return { blobs, revoked, anchors };
}

function display() {
  return { layers: {}, off: new Set<string>(), showAs: {} };
}

test("the close-up shows notes with rounded fallback and exact tables", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const rain = rainLayer();
  rain.area_series!.values[0] = 10.123456789;
  rain.area_series!.valid_fraction[0] = 0.87654321;
  rain.area_series!.fallback_fraction = rain.time!.values.map(() => 0.123456789);
  rain.fallback_sources = [{ name: "ERA5" }] as LayerDoc["fallback_sources"];
  const layers = [rain];
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
        currentTime="2019-01-01"
        onBack={() => {}}
        onEdit={() => {}}
      />,
    );
  });
  const heading = host.querySelector("[data-chart-notes-heading]")!;
  assert.equal(heading.textContent, "Notes");
  assert.match(heading.parentElement?.textContent ?? "", /filled from ERA5/);
  assert.match(heading.parentElement?.textContent ?? "", /Hollow marks/);
  const tooltip = host.querySelector(".chart-tooltip")?.textContent ?? "";
  assert.match(tooltip, /10\.123 mm\/month/);
  assert.match(tooltip, /valid 87\.654%/);
  assert.match(tooltip, /12\.346% of outline filled from ERA5/);
  assert.doesNotMatch(tooltip, /10\.123456789|87\.654321|12\.3456789/);
  const firstTitle = host.querySelector(".chart-bars rect title")?.textContent ?? "";
  assert.match(firstTitle, /valid 87\.654%/);
  assert.match(firstTitle, /12\.346% of outline filled from ERA5/);
  const summary = host.querySelector("summary")!;
  assert.equal(summary.textContent, "Table (exact values)");
  const exactCells = [...host.querySelectorAll("td")].map((cell) => cell.textContent);
  assert.ok(exactCells.includes("10.123456789"));
  assert.ok(exactCells.includes("0.87654321"));
  assert.ok(exactCells.includes("0.123456789"));
  await act(async () => {
    root.unmount();
  });
});

test("choosing main in the close-up confirms politely", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartDetail } = await import("./chart-detail.tsx");

  const layers = [rainLayer(), terrainLayer()];
  const store = createSceneStore(layers, display());
  const second = store.getSnapshot().charts.definitions[1].id;
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
        onBack={() => {}}
        onEdit={() => {}}
      />,
    );
  });
  const useMain = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Use as main",
  ) as HTMLButtonElement;
  useMain.focus();
  await act(async () => {
    useMain.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(store.getSnapshot().charts.mainChartId, second);
  const statuses = [...host.querySelectorAll('[role="status"]')].map(
    (node) => node.textContent ?? "",
  );
  assert.ok(
    statuses.some((text) => /is now the main chart in the scene panel's Charts tab/.test(text)),
  );
  assertSameNode(document.activeElement, useMain);
  await act(async () => {
    root.unmount();
  });
});

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
