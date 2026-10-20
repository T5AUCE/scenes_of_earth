import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

import { BLEND } from "./layers/allocate.ts";
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
  applyColourAction,
  DEFAULT_EDGES,
  formatDisplayParams,
  loadStoredPalettes,
  loadStoredEdges,
  loadStoredPick,
  NO_TOKENS,
  rangeDecimals,
  recordMenuChange,
  resolveDisplay,
  setLayerDisplay,
  shouldStorePick,
  storePalette,
  storeEdges,
  storePick,
} = await import("./display-state.ts").finally(() => hooks.deregister());

const LAYERS = [
  {
    id: "chirps_monthly",
    style: {
      kind: "field",
      encodings: ["ramp", "dots", "isolines", "chroma"],
      palette: "ink-blue",
    },
    arrays: { value: { scale_factor: 0.1 } },
  },
  {
    id: "esa_worldcover",
    style: { kind: "categorical", encodings: ["fill"], palette: "painted" },
    arrays: {},
  },
  {
    id: "terrain",
    style: { kind: "terrain", encodings: ["shade"], parts: ["contours"] },
    arrays: {},
  },
] as unknown as LayerDoc[];

const TEMPERATURE = {
  id: "era5land_temperature",
  style: { kind: "field", encodings: ["ramp", "isolines", "warmth"], palette: "climate" },
  arrays: { value: { scale_factor: 0.1 } },
} as unknown as LayerDoc;
const COLOUR_LAYERS = [...LAYERS, TEMPERATURE];
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

  const tokens = { pal: "chirps_monthly:batlow", range: "", off: "terrain", colour: "" };
  resolveDisplay(LAYERS, tokens, {});

  assert.deepEqual(writes, []);
});

test("link colour beats the stored pick, which beats auto", () => {
  const linked = resolveDisplay(
    COLOUR_LAYERS,
    { ...NO_TOKENS, colour: "chirps_monthly" },
    {},
    "era5land_temperature",
  );
  assert.equal(linked.display.colour, "chirps_monthly");

  const remembered = resolveDisplay(COLOUR_LAYERS, NO_TOKENS, {}, "era5land_temperature");
  assert.equal(remembered.display.colour, "era5land_temperature");

  const auto = resolveDisplay(COLOUR_LAYERS, NO_TOKENS, {});
  assert.equal(auto.display.colour, null);
  assert.ok(
    formatDisplayParams(auto.display, COLOUR_LAYERS).includes("&colour=era5land_temperature"),
  );
});

test("a stored pick absent from the scene is ignored", () => {
  const missing = resolveDisplay(COLOUR_LAYERS, NO_TOKENS, {}, "nowhere");
  const noPair = resolveDisplay(LAYERS, NO_TOKENS, {}, BLEND);

  assert.equal(missing.display.colour, null);
  assert.equal(noPair.display.colour, null);
});

test("an old link that switches both blend halves off ignores a stored blend", () => {
  const pair = [LAYERS[0], TEMPERATURE];
  const { display } = resolveDisplay(
    pair,
    { ...NO_TOKENS, off: "chirps_monthly,era5land_temperature" },
    {},
    BLEND,
  );

  assert.equal(display.colour, null);
  assert.deepEqual([...display.off], ["chirps_monthly", "era5land_temperature"]);
  assert.equal(formatDisplayParams(display, pair).includes("colour="), false);
});

test("picking blend turns both halves off", () => {
  const next = applyColourAction(
    { pick: null, off: new Set() },
    { kind: "pick", unit: BLEND },
    COLOUR_LAYERS,
  );

  assert.equal(next.pick, BLEND);
  assert.deepEqual([...next.off], ["chirps_monthly", "era5land_temperature"]);
});

test("switching blend off restores both halves", () => {
  const next = applyColourAction(
    { pick: BLEND, off: new Set(["chirps_monthly", "era5land_temperature"]) },
    { kind: "toggle", unit: BLEND, on: false },
    COLOUR_LAYERS,
  );

  assert.equal(next.pick, null);
  assert.deepEqual([...next.off], []);
});

test("turning a half on ends the blend and leaves the other half off", () => {
  const next = applyColourAction(
    { pick: BLEND, off: new Set(["chirps_monthly", "era5land_temperature"]) },
    { kind: "toggle", unit: "era5land_temperature", on: true },
    COLOUR_LAYERS,
  );

  assert.equal(next.pick, "era5land_temperature");
  assert.deepEqual([...next.off], ["chirps_monthly"]);
});

test("an explicit pick is remembered even when a link had already picked it", () => {
  const linked = resolveDisplay(COLOUR_LAYERS, { ...NO_TOKENS, colour: "chirps_monthly" }, {});
  const state = { pick: linked.display.colour, off: linked.display.off };
  const off = applyColourAction(
    state,
    { kind: "toggle", unit: "chirps_monthly", on: false },
    COLOUR_LAYERS,
  );
  const action = { kind: "pick", unit: "chirps_monthly" } as const;
  const picked = applyColourAction(off, action, COLOUR_LAYERS);

  assert.equal(shouldStorePick(off.pick, action, picked.pick), true);
  const toggle = { kind: "toggle", unit: "chirps_monthly", on: true } as const;
  assert.equal(shouldStorePick(off.pick, toggle, off.pick), false);
});

test("the effective owner is written to the link", () => {
  const auto = resolveDisplay(COLOUR_LAYERS, NO_TOKENS, {});
  const state = { pick: auto.display.colour, off: auto.display.off };
  const picked = applyColourAction(state, { kind: "pick", unit: "chirps_monthly" }, COLOUR_LAYERS);
  const display = { ...auto.display, colour: picked.pick, off: new Set(picked.off) };

  assert.ok(formatDisplayParams(display, COLOUR_LAYERS).endsWith("&colour=chirps_monthly"));

  const single = resolveDisplay([TEMPERATURE], NO_TOKENS, {});
  assert.equal(formatDisplayParams(single.display, [TEMPERATURE]).includes("colour="), false);
});

test("a blend link drops the halves from off and restores them on open", () => {
  const { display } = resolveDisplay(COLOUR_LAYERS, { ...NO_TOKENS, colour: BLEND }, {});
  const text = formatDisplayParams(display, COLOUR_LAYERS);

  assert.equal(display.colour, BLEND);
  assert.deepEqual([...display.off], ["chirps_monthly", "era5land_temperature"]);
  assert.ok(text.endsWith("&colour=blend"));
  assert.equal(text.includes("off="), false);

  const pair = [LAYERS[0], TEMPERATURE];
  const pairOnly = resolveDisplay(pair, { ...NO_TOKENS, colour: BLEND }, {});
  assert.ok(formatDisplayParams(pairOnly.display, pair).endsWith("&colour=blend"));
});

test("a blend link without a pair is dropped with the note", () => {
  const { display, dropped } = resolveDisplay(LAYERS, { ...NO_TOKENS, colour: BLEND }, {});

  assert.equal(dropped, true);
  assert.equal(display.colour, null);
});

test("opening a colour link saves no pick", () => {
  const writes: string[] = [];
  useStorage({
    setItem: (key: string) => writes.push(key),
    removeItem: (key: string) => writes.push(key),
  });

  resolveDisplay(COLOUR_LAYERS, { ...NO_TOKENS, colour: "chirps_monthly" }, {}, "nowhere");

  assert.deepEqual(writes, []);
});

test("the colour pick is remembered by unit", () => {
  useStorage();

  storePick("era5land_temperature");
  assert.equal(loadStoredPick(), "era5land_temperature");

  storePick(null);
  assert.equal(loadStoredPick(), null);
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
    colour: "",
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
    colour: "",
  };
  const { display } = resolveDisplay(LAYERS, tokens, {});

  assert.deepEqual(display.layers.chirps_monthly, { palette: "cividis", range: [0, 250.3] });
});

test("every layer with a menu names its palette but ranges and off parts only when set", () => {
  const { display } = resolveDisplay(LAYERS, {
    pal: "chirps_monthly:ink-blue,esa_worldcover:painted",
    range: "",
    off: "",
    colour: "",
  }, {});

  assert.equal(
    formatDisplayParams(display, LAYERS),
    "&pal=chirps_monthly:ink-blue,esa_worldcover:painted,terrain:brown"
      + "&colour=chirps_monthly",
  );
});

test("palettes, ranges and off parts round trip through the link text", () => {
  const tokens = {
    pal: "chirps_monthly:custom-1a2b3c-88cc44,esa_worldcover:esa,terrain:grey",
    range: "chirps_monthly:0:250",
    off: "terrain.contours,esa_worldcover",
    colour: "",
  };
  const { display } = resolveDisplay(LAYERS, tokens, {});
  const text = formatDisplayParams(display, LAYERS);

  assert.equal(
    text,
    "&pal=chirps_monthly:custom-1a2b3c-88cc44,esa_worldcover:esa,terrain:grey"
      + "&range=chirps_monthly:0:250&off=esa_worldcover,terrain.contours"
      + "&colour=chirps_monthly",
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

test("a menu range change keeps the colour pick", () => {
  useStorage();
  const tokens = { ...NO_TOKENS, colour: "chirps_monthly" };
  const { display } = resolveDisplay(COLOUR_LAYERS, tokens, {});
  const menu = {
    palette: "ink-blue",
    defaultPalette: "ink-blue",
    range: { value: [0, 90] as [number, number] },
  };

  recordMenuChange(display, "chirps_monthly", menu, "range");

  assert.equal(display.colour, "chirps_monthly");
  assert.deepEqual(display.layers.chirps_monthly, { range: [0, 90] });
  assert.ok(formatDisplayParams(display, COLOUR_LAYERS).endsWith("&colour=chirps_monthly"));
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
      removeItem: (key: string) => items.delete(key),
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
