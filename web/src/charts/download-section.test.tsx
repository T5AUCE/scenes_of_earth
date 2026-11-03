import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import type { LayerDoc, Scene } from "../types.ts";

test("the download section offers area and elevation files with exact labels", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DownloadSection } = await import("./download-section.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DownloadSection scene={makeScene([rainLayer(), terrainLayer()])} />);
  });
  const labels = [...host.querySelectorAll("button")].map((button) => button.textContent);
  assert.ok(labels.includes("Area means (CSV)"));
  assert.ok(labels.includes("Elevation distribution (CSV)"));
  assert.equal(labels.includes("By month (CSV)"), false);
  assert.ok(host.querySelector('section[aria-label="Downloads"]'));
  await act(async () => {
    root.unmount();
  });
});

test("the download section omits files without a source", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DownloadSection } = await import("./download-section.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DownloadSection scene={makeScene([rainLayer()])} />);
  });
  const labels = [...host.querySelectorAll("button")].map((button) => button.textContent);
  assert.ok(labels.includes("Area means (CSV)"));
  assert.equal(labels.includes("Elevation distribution (CSV)"), false);
  await act(async () => {
    root.unmount();
  });

  const second = document.createElement("div");
  document.body.append(second);
  const secondRoot = createRoot(second);
  await act(async () => {
    secondRoot.render(<DownloadSection scene={makeScene([terrainLayer()])} />);
  });
  const secondLabels = [...second.querySelectorAll("button")].map((button) => button.textContent);
  assert.equal(secondLabels.includes("Area means (CSV)"), false);
  assert.ok(secondLabels.includes("Elevation distribution (CSV)"));
  await act(async () => {
    secondRoot.unmount();
  });

  const third = document.createElement("div");
  document.body.append(third);
  const thirdRoot = createRoot(third);
  await act(async () => {
    thirdRoot.render(<DownloadSection scene={makeScene([categoricalLayer()])} />);
  });
  assert.equal(third.querySelector("section"), null);
  await act(async () => {
    thirdRoot.unmount();
  });
});

test("an area download writes source units with attribution and cleans up", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DownloadSection } = await import("./download-section.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DownloadSection scene={makeScene([rainLayer(), terrainLayer()])} />);
  });
  const button = [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Area means (CSV)",
  )!;
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(downloads.blobs.length, 1);
  const content = await downloads.blobs[0].text();
  assert.equal(
    downloads.anchors.at(-1)?.download,
    "test-scene_2019-01-01_2021-07-01_area-means.csv",
  );
  assert.ok(content.includes("rain_mean [mm/month]"));
  assert.ok(content.includes("Rain credit"));
  assert.ok(content.includes("Terms."));
  assert.equal(downloads.revoked.length, 1);
  assert.equal(downloads.anchors.length, 1);
  assert.equal(document.body.contains(downloads.anchors[0]), false);
  await act(async () => {
    root.unmount();
  });
});

test("a failed activation still cleans up its url and anchor", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
  const { downloadCsv } = await import("./csv.ts");

  const anchorClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = () => {
    throw new Error("activation failed");
  };
  try {
    assert.throws(() => downloadCsv("test.csv", "a,b\r\n"), /activation failed/);
  } finally {
    window.HTMLAnchorElement.prototype.click = anchorClick;
  }

  assert.equal(downloads.urls.length, 1);
  assert.deepEqual(downloads.revoked, downloads.urls);
  for (const anchor of downloads.anchors) assert.equal(document.body.contains(anchor), false);
  assert.equal(document.querySelectorAll("a").length, 0);
});

test("repeated downloads and unmount leave nothing behind", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DownloadSection } = await import("./download-section.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DownloadSection scene={makeScene([rainLayer(), terrainLayer()])} />);
  });
  const button = [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Area means (CSV)",
  )!;
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(downloads.urls.length, 2);
  assert.deepEqual(downloads.revoked, downloads.urls);
  for (const anchor of downloads.anchors) assert.equal(document.body.contains(anchor), false);
  assert.equal(host.querySelectorAll("a").length, 0);

  await act(async () => {
    root.unmount();
  });

  assert.deepEqual(downloads.revoked, downloads.urls);
  for (const anchor of downloads.anchors) assert.equal(document.body.contains(anchor), false);
  assert.equal(host.querySelectorAll("a").length, 0);
});

test("an elevation download writes exact stats under a dateless name", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DownloadSection } = await import("./download-section.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DownloadSection scene={makeScene([terrainLayer()])} />);
  });
  const button = [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Elevation distribution (CSV)",
  )!;
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(downloads.blobs.length, 1);
  const content = await downloads.blobs[0].text();
  assert.equal(
    downloads.anchors.at(-1)?.download,
    "test-scene_elevation-distribution.csv",
  );
  assert.ok(content.includes("share_of_valid_area_below_pct,elevation [m]"));
  assert.ok(content.includes("# Mean elevation: 500 m."));
  assert.ok(content.includes("# Reference sea_level: 0 m."));
  assert.equal(downloads.revoked.length, 1);
  assert.equal(document.body.contains(downloads.anchors[0]), false);
  await act(async () => {
    root.unmount();
  });
});

function makeScene(layers: LayerDoc[]): Scene {
  return {
    id: "test",
    title: "Test scene",
    generator: { name: "soe", version: "0.9.0" },
    version: "0.7",
    created: "2026-10-23T00:00:00Z",
    area: {
      boundary: {
        id: "test",
        name: "Test",
        level: "level",
        iso3: null,
        source: "geoBoundaries",
        licence: "CC BY 4.0",
        attribution: "Boundary credit",
      },
      bbox: [0, -1, 1, 1],
      geometry_href: "area.geojson",
      clipped_to_coverage: false,
    },
    period: { start: "2019-01-01", end: "2021-07-01", step: "P1M" },
    layers,
    data: { href: "data.zarr" },
    notices: { limits: [] },
    credits: {
      lines: ["Rain credit", "DEM credit", "Boundary credit"],
      disclaimers: [],
      endorsement: "Endorsement.",
      terms_passthrough: "Terms.",
    },
  } as unknown as Scene;
}

function rainLayer(): LayerDoc {
  const values = monthlyValues(30);

  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
    style: { kind: "field", encodings: ["ramp"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
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
    source: { name: "DEM", licence: "open", attribution: "DEM credit" },
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

function installDownloadCapture(context: { after(hook: () => void): void }) {
  const blobs: Blob[] = [];
  const urls: string[] = [];
  const revoked: string[] = [];
  const anchors: HTMLAnchorElement[] = [];
  const originalCreate = document.createElement.bind(document);
  const originalObjectUrl = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const created = (tag: string) => {
    const element = originalCreate(tag);
    if (tag === "a") anchors.push(element as HTMLAnchorElement);

    return element;
  };
  (document as unknown as Record<string, unknown>).createElement = created;
  (URL as unknown as Record<string, unknown>).createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    const url = `blob:fake-download-${String(blobs.length)}`;
    urls.push(url);

    return url;
  };
  (URL as unknown as Record<string, unknown>).revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  context.after(() => {
    (document as unknown as Record<string, unknown>).createElement = originalCreate;
    URL.createObjectURL = originalObjectUrl;
    URL.revokeObjectURL = originalRevoke;
  });

  return { blobs, urls, revoked, anchors };
}

function installBrowser(window: Window): void {
  const names = [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "HTMLAnchorElement",
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
