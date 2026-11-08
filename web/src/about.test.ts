import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { Window } from "happy-dom";

import type { Scene } from "./types.ts";

const sourceRoot = new URL("./", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".")) {
      if (specifier.endsWith(".ts")) return next(specifier, context);
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { renderAbout, summaryText } = await import("./about.ts");
hooks.deregister();

test("area weighting describes outline shares without equal-cell claims", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const root = renderAbout(makeScene(), "m", {});

  assert.match(root.textContent ?? "", /area inside the outline/);
  assert.match(root.textContent ?? "", /zero weight/);
  assert.match(root.textContent ?? "", /analysis grid/);
  assert.doesNotMatch(root.textContent ?? "", /equal weight/);
});

test("terrain summaries face live relief and contours", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const root = renderAbout(makeScene(), "ft", { rain: "in/month" });

  assert.match(root.textContent ?? "", /weighted reductions/);
  assert.match(root.textContent ?? "", /live elevation tiles/);
  assert.match(root.textContent ?? "", /height steps chosen from/);
  assert.doesNotMatch(root.textContent ?? "", /never supplies the numbers/);
  assert.doesNotMatch(root.textContent ?? "", /1024/);
  assert.doesNotMatch(root.textContent ?? "", /equal weight/);
  assert.doesNotMatch(root.textContent ?? "", /terrain array/);
  assert.ok((summaryText(makeScene(), "ft") ?? "").includes("mi"));
});

test("geology scenes explain the rock-type scale and seams of their source map", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const plain = renderAbout(makeScene(), "m", {});
  const glim = renderAbout(makeGeologyScene("GLiM Global Lithological Map v1.0"), "m", {});
  const openLandMap = renderAbout(makeGeologyScene("OpenLandMap lithology 250 m"), "m", {});

  assert.doesNotMatch(plain.textContent ?? "", /rock type/);
  assert.match(glim.textContent ?? "", /Rock type layer comes from the Global Lithological Map/);
  assert.match(glim.textContent ?? "", /1:3\.75 million/);
  assert.match(glim.textContent ?? "", /approximate at local scale/);
  assert.match(glim.textContent ?? "", /92 source maps/);
  assert.doesNotMatch(glim.textContent ?? "", /180° longitude/);
  const openLandMapText = openLandMap.textContent ?? "";
  assert.match(openLandMapText, /Rock type layer comes from a global map at about 1:3\.75 million/);
  assert.match(openLandMap.textContent ?? "", /OpenLandMap, from GLiM/);
  assert.match(openLandMap.textContent ?? "", /seams can show/);
  assert.match(openLandMap.textContent ?? "", /180° longitude/);
});

test("geology age scenes explain the scale, era-only share and ICS generalisation", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const age = renderAbout(
    makeGeologyScene("Generalized geology of the world (GSC Open File 5529)", "geology_age"),
    "m",
    {},
  );
  const text = age.textContent ?? "";

  assert.match(text, /Geological age layer comes from the Geological Survey of Canada/);
  assert.match(text, /worldwide fallback/);
  assert.match(text, /1:35 million/);
  assert.match(text, /tens of kilometres/);
  assert.match(text, /only to an era or wider/);
  assert.match(text, /generalised to ICS periods/);
  assert.doesNotMatch(text, /rock type/);
});

test("a scene with partial layer coverage keeps the whole area and says layers cover part", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const scene = makeScene();
  scene.area.clipped_to_coverage = true;
  const root = renderAbout(scene, "m", {});

  assert.match(root.textContent ?? "", /Some layers cover only part of the area/);
  assert.doesNotMatch(root.textContent ?? "", /was clipped/);
});

test("smoothing explains geology Smoothing in plain sentences", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const text = (renderAbout(makeScene(), "m", {}).textContent ?? "");

  assert.match(text, /Smoothing is measured in grid cells/);
  assert.match(text, /staircases become smooth curves/);
});

test("geology scenes draw under water with a short coastal fill for display only", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const plain = renderAbout(makeScene(), "m", {});
  const rock = renderAbout(makeGeologyScene("GLiM Global Lithological Map v1.0"), "m", {});
  const age = renderAbout(
    makeGeologyScene("Generalized geology of the world (GSC Open File 5529)", "geology_age"),
    "m",
    {},
  );

  assert.doesNotMatch(plain.textContent ?? "", /drawn under the map's water/);
  for (const scene of [rock, age]) {
    const text = scene.textContent ?? "";
    assert.match(text, /drawn under the map's water/);
    assert.match(text, /about 2 km/);
    assert.match(text, /one scene cell where cells are larger/);
    assert.match(text, /for display only/);
  }
});

function makeScene(): Scene {
  return {
    id: "test",
    title: "Test scene",
    generator: { name: "soe", version: "0.9.0" },
    version: "0.7",
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
    period: null,
    layers: [
      {
        id: "rain",
        title: "Rainfall",
        units: "mm/month",
        source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
        style: { kind: "field", encodings: ["ramp"] },
        grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
        mask: { path: "mask.zarr", cells_inside: 100 },
        time: null,
        arrays: {},
      },
      {
        id: "terrain",
        title: "Terrain",
        units: "m",
        source: { name: "DEM", licence: "open", attribution: "DEM credit" },
        style: { kind: "terrain", encodings: ["shade"] },
        grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
        mask: { path: "mask.zarr", cells_inside: 100 },
        time: null,
        arrays: {},
        tiles: {
          url: "https://example.test/{z}/{x}/{y}.webp",
          encoding: "terrarium",
          tile_size: 512,
          maxzoom: 11,
          source: { name: "DEM", licence: "open", attribution: "DEM credit" },
        },
        stats: {
          min: 1,
          max: 10,
          mean: 5,
          p2: 1,
          p98: 10,
          slope_p50_deg: 1,
          slope_p90_deg: 2,
          cell_m: 500,
        },
      },
    ],
    data: { href: "data.zarr" },
    notices: { limits: [] },
    credits: {
      lines: ["Rain credit", "DEM credit"],
      disclaimers: [],
      endorsement: "Endorsement.",
      terms_passthrough: "Terms.",
    },
  } as unknown as Scene;
}

function makeGeologyScene(sourceName: string, id = "geology"): Scene {
  const scene = makeScene();
  const geology = {
    id,
    title: "Geology",
    units: "",
    source: { name: sourceName, licence: "CC BY-SA 4.0" },
    style: { kind: "categorical", encodings: ["fill"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    mask: { path: "mask.zarr", cells_inside: 100 },
    time: null,
    arrays: {},
  } as unknown as Scene["layers"][number];
  scene.layers = [...scene.layers, geology];
  return scene;
}

function installBrowser(window: Window): void {
  const names = ["Node", "Element", "HTMLElement", "DocumentFragment", "Event"] as const;
  for (const name of names) defineGlobal(name, window[name]);
  defineGlobal("document", window.document);
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
