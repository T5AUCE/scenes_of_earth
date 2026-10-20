import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

import type { DisplayTokens, LayerDoc } from "./types.ts";

const stateUrl = new URL("./display-state.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== stateUrl || !specifier.startsWith("./")) {
      return next(specifier, context);
    }

    return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
  },
});
const {
  DEFAULT_EDGES,
  formatDisplayParams,
  loadStoredPalettes,
  loadStoredEdges,
  NO_TOKENS,
  rangeDecimals,
  recordMenuChange,
  resolveDisplay,
  setLayerDisplay,
  storePalette,
  storeEdges,
} = await import("./display-state.ts").finally(() => hooks.deregister());

const LAYERS = [
  {
    id: "chirps_monthly",
    style: { kind: "field", palette: "ink-blue" },
    arrays: { value: { scale_factor: 0.1 } },
  },
  {
    id: "esa_worldcover",
    style: { kind: "categorical", palette: "painted" },
    arrays: {},
  },
  {
    id: "terrain",
    style: { kind: "terrain", parts: ["contours"] },
    arrays: {},
  },
] as unknown as LayerDoc[];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("the link beats storage and storage beats the bundle's defaults", () => {
  const stored = { chirps_monthly: "batlow", terrain: "grey" };
  const tokens = { ...NO_TOKENS, pal: "chirps_monthly:cividis" };
  const { display, dropped } = resolveDisplay(LAYERS, tokens, stored);

  assert.equal(dropped, false);
  assert.deepEqual(display.layers, {
    chirps_monthly: { palette: "cividis" },
    terrain: { palette: "grey" },
  });
});

test("opening a link saves nothing", () => {
  const writes: string[] = [];
  useStorage({ setItem: (key: string) => writes.push(key) });

  resolveDisplay(LAYERS, { pal: "chirps_monthly:batlow", range: "", off: "terrain" }, {});

  assert.deepEqual(writes, []);
});

test("storage errors fall back to the defaults", () => {
  useStorage({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });

  assert.deepEqual(loadStoredPalettes(), {});
  assert.doesNotThrow(() => storePalette("chirps_monthly", "batlow"));
});

test("stored palettes are written and forgotten by layer", () => {
  const items = useStorage();

  storePalette("chirps_monthly", "batlow");
  storePalette("terrain", "grey");
  storePalette("chirps_monthly", null);

  assert.deepEqual(loadStoredPalettes(), { terrain: "grey" });
  assert.equal(items.size, 1);
});

test("unknown layers, palettes and reversed ranges are dropped", () => {
  const tokens: DisplayTokens = {
    pal: "nowhere:batlow,chirps_monthly:nope,chirps_monthly:custom-12345g-000000,terrain:batlow,x",
    range: "chirps_monthly:10:5,chirps_monthly:a:b,chirps_monthly::9,esa_worldcover:0:9,t:1:2",
    off: "chirps_monthly,terrain.nothing",
  };
  const { display, dropped } = resolveDisplay(LAYERS, tokens, {});

  assert.equal(dropped, true);
  assert.deepEqual(display.layers, {});
  assert.deepEqual([...display.off], ["chirps_monthly"]);
});

test("a custom gradient needs two to five six-digit colours", () => {
  const resolve = (palette: string) =>
    resolveDisplay(LAYERS, { ...NO_TOKENS, pal: `chirps_monthly:${palette}` }, {});

  assert.equal(resolve("custom-1a2b3c-88cc44-ffeedd").dropped, false);
  assert.equal(resolve("custom-1a2b3c").dropped, true);
  assert.equal(resolve("custom-1a2b3c-88cc44-ffeedd-000000-111111-222222").dropped, true);
  assert.equal(resolve("custom-1a2b3c-88cc4").dropped, true);
  assert.equal(resolve("custom-1A2B3C-88CC44").dropped, true);
});

test("the last entry for a layer wins and ranges are rounded to the data's precision", () => {
  const tokens = {
    pal: "chirps_monthly:batlow,chirps_monthly:cividis",
    range: "chirps_monthly:0.04:250.26",
    off: "",
  };
  const { display } = resolveDisplay(LAYERS, tokens, {});

  assert.deepEqual(display.layers.chirps_monthly, { palette: "cividis", range: [0, 250.3] });
});

test("every layer with a menu names its palette but ranges and off parts only when set", () => {
  const { display } = resolveDisplay(LAYERS, {
    pal: "chirps_monthly:ink-blue,esa_worldcover:painted",
    range: "",
    off: "",
  }, {});

  assert.equal(
    formatDisplayParams(display, LAYERS),
    "&pal=chirps_monthly:ink-blue,esa_worldcover:painted,terrain:brown",
  );
});

test("palettes, ranges and off parts round trip through the link text", () => {
  const tokens = {
    pal: "chirps_monthly:custom-1a2b3c-88cc44,esa_worldcover:esa,terrain:grey",
    range: "chirps_monthly:0:250",
    off: "terrain.contours,esa_worldcover",
  };
  const { display } = resolveDisplay(LAYERS, tokens, {});
  const text = formatDisplayParams(display, LAYERS);

  assert.equal(
    text,
    "&pal=chirps_monthly:custom-1a2b3c-88cc44,esa_worldcover:esa,terrain:grey"
      + "&range=chirps_monthly:0:250&off=esa_worldcover,terrain.contours",
  );
});

test("changing a layer back to its defaults removes it from the display", () => {
  const { display } = resolveDisplay(LAYERS, { ...NO_TOKENS, pal: "terrain:grey" }, {});

  setLayerDisplay(display, "terrain", {});

  assert.deepEqual(display.layers, {});
});

test("editing only the range of a link-opened scene writes no storage", () => {
  const items = useStorage();
  const tokens = { ...NO_TOKENS, pal: "chirps_monthly:cividis" };
  const { display } = resolveDisplay(LAYERS, tokens, {});
  const menu = {
    palette: "cividis",
    defaultPalette: "ink-blue",
    range: { value: [0, 90] as [number, number] },
  };

  recordMenuChange(display, "chirps_monthly", menu, "range");

  assert.equal(items.size, 0);
  assert.deepEqual(display.layers.chirps_monthly, { palette: "cividis", range: [0, 90] });
});

test("choosing a palette remembers it and choosing the default forgets it", () => {
  useStorage();
  const { display } = resolveDisplay(LAYERS, NO_TOKENS, {});
  const menu = { palette: "batlow", defaultPalette: "ink-blue" };

  recordMenuChange(display, "chirps_monthly", menu, "palette");
  assert.deepEqual(loadStoredPalettes(), { chirps_monthly: "batlow" });

  recordMenuChange(display, "chirps_monthly", { ...menu, palette: "ink-blue" }, "palette");
  assert.deepEqual(loadStoredPalettes(), {});
  assert.deepEqual(display.layers, {});
});

test("range decimals follow the scale factor, else the span of the area's values", () => {
  const unscaled = (min: number, max: number) => ({
    id: "x",
    style: { kind: "field" },
    arrays: { value: {} },
    stats: { min, max },
  }) as unknown as LayerDoc;

  assert.equal(rangeDecimals(LAYERS[0]), 1);
  assert.equal(rangeDecimals(unscaled(0, 1)), 2);
  assert.equal(rangeDecimals(unscaled(-20, 40)), 1);
  assert.equal(rangeDecimals(unscaled(0, 5000)), 0);
  assert.equal(rangeDecimals(unscaled(3, 3)), 0);
});

function useStorage(overrides: object = {}) {
  const items = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      ...overrides,
    },
  });
  return items;
}

test("edge settings default to quarter rounding with no softness or outline", () => {
  useStorage();

  assert.deepEqual(loadStoredEdges("esa_worldcover"), {
    rounding: 0.25,
    softnessCells: 0,
    outline: false,
  });
});

test("edges persist by dataset independently of palettes and share links", () => {
  useStorage();
  const edges = { rounding: 0.6, softnessCells: 1, outline: true };
  storePalette("esa_worldcover", "esa");
  storeEdges("esa_worldcover", edges);
  const { display } = resolveDisplay(LAYERS, NO_TOKENS, loadStoredPalettes());

  assert.deepEqual(loadStoredEdges("esa_worldcover"), edges);
  assert.deepEqual(loadStoredEdges("other"), DEFAULT_EDGES);
  assert.deepEqual(loadStoredPalettes(), { esa_worldcover: "esa" });
  assert.equal(formatDisplayParams(display, LAYERS).includes("rounding"), false);
  assert.equal(formatDisplayParams(display, LAYERS).includes("edges"), false);
  storeEdges("esa_worldcover", { ...DEFAULT_EDGES });
  assert.deepEqual(loadStoredEdges("esa_worldcover"), DEFAULT_EDGES);
});

test("legacy pixel softness resets to zero but keeps the other edge choices", () => {
  const items = useStorage();
  const load = (value: object) => {
    items.set("soe.edges.v1", JSON.stringify({ esa_worldcover: value }));
    return loadStoredEdges("esa_worldcover");
  };

  assert.deepEqual(load({ rounding: 0.4, softnessPx: 0.5, outline: true }), {
    rounding: 0.4,
    softnessCells: 0,
    outline: true,
  });
  assert.deepEqual(load({ rounding: 0.25, softnessPx: 1.5, outline: false }), {
    rounding: 0.25,
    softnessCells: 0,
    outline: false,
  });
  assert.deepEqual(load({ rounding: 0.25, softnessCells: 0.75, softnessPx: 1.5, outline: false }), {
    rounding: 0.25,
    softnessCells: 0.75,
    outline: false,
  });
  assert.deepEqual(load({ rounding: 0.25, softnessPx: 1.6, outline: false }), DEFAULT_EDGES);
});

test("invalid or blocked edge storage uses defaults without preventing changes", () => {
  const items = useStorage();
  for (const value of [
    null,
    [],
    { rounding: 0.65, softnessCells: 0, outline: false },
    { rounding: 0.25, softnessCells: -1, outline: false },
    { rounding: 0.25, softnessCells: 1.5, outline: false },
    { rounding: "0.25", softnessCells: 0, outline: false },
    { rounding: 0.25, softnessCells: "0", outline: false },
    { rounding: 0.25, softnessCells: 0, outline: "false" },
    { rounding: 0.25, softnessPx: -1, outline: false },
    { rounding: 0.25, softnessPx: 1.6, outline: false },
    { rounding: 0.25, softnessPx: "0", outline: false },
  ]) {
    items.set("soe.edges.v1", JSON.stringify({ esa_worldcover: value }));
    assert.deepEqual(loadStoredEdges("esa_worldcover"), DEFAULT_EDGES);
  }
  items.set("soe.edges.v1", "broken JSON");
  assert.deepEqual(loadStoredEdges("esa_worldcover"), DEFAULT_EDGES);
  useStorage({
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  });
  assert.deepEqual(loadStoredEdges("esa_worldcover"), DEFAULT_EDGES);
  assert.doesNotThrow(() => storeEdges("esa_worldcover", { ...DEFAULT_EDGES }));
});
