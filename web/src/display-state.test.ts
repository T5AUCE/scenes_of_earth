import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

import { BLEND } from "./layers/allocate.ts";
import { inkPaint } from "./render/palettes.ts";
import type { DisplayTokens, LayerDoc } from "./types.ts";

const resolvedParents = ["./display-state.ts", "./render/lattice.ts"].map(
  (path) => new URL(path, import.meta.url).href,
);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!resolvedParents.includes(context.parentURL ?? "") || !specifier.startsWith("./")) {
      return next(specifier, context);
    }

    return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
  },
});
const {
  applyColourAction,
  DEFAULT_EDGES,
  densityControl,
  formatDisplayParams,
  loadStoredInks,
  loadStoredPalettes,
  loadStoredEdges,
  loadStoredPick,
  loadStoredDensities,
  NO_TOKENS,
  rangeDecimals,
  recordMenuChange,
  resolveDisplay,
  setLayerDisplay,
  shouldStorePick,
  storeInk,
  storePalette,
  storeEdges,
  storePick,
  storeDensity,
} = await import("./display-state.ts");
const {
  DENSITY_STEP_LOG2,
  MAX_DENSITY_RATIO,
  MIN_DENSITY_RATIO,
  quantiseDensity,
} = await import("./render/lattice.ts").finally(() => hooks.deregister());

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

  const tokens = {
    pal: "chirps_monthly:batlow",
    range: "",
    off: "terrain",
    colour: "",
    ink: "",
    dens: "",
  };
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

  assert.ok(
    formatDisplayParams(display, COLOUR_LAYERS)
      .endsWith("&colour=chirps_monthly&dens=chirps_monthly:1"),
  );

  const single = resolveDisplay([TEMPERATURE], NO_TOKENS, {});
  assert.equal(formatDisplayParams(single.display, [TEMPERATURE]).includes("colour="), false);
});

test("a blend link drops the halves from off and restores them on open", () => {
  const { display } = resolveDisplay(COLOUR_LAYERS, { ...NO_TOKENS, colour: BLEND }, {});
  const text = formatDisplayParams(display, COLOUR_LAYERS);

  assert.equal(display.colour, BLEND);
  assert.deepEqual([...display.off], ["chirps_monthly", "era5land_temperature"]);
  assert.ok(text.endsWith("&colour=blend&dens=chirps_monthly:1"));
  assert.equal(text.includes("off="), false);

  const pair = [LAYERS[0], TEMPERATURE];
  const pairOnly = resolveDisplay(pair, { ...NO_TOKENS, colour: BLEND }, {});
  assert.ok(
    formatDisplayParams(pairOnly.display, pair).endsWith("&colour=blend&dens=chirps_monthly:1"),
  );
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
    ink: "",
    dens: "",
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
    ink: "",
    dens: "",
  };
  const { display } = resolveDisplay(LAYERS, tokens, {});

  assert.deepEqual(display.layers.chirps_monthly, { palette: "cividis", range: [0, 250.3] });
});

test("every layer with a menu names its palette but ranges and off parts only when set", () => {
  const { display } = resolveDisplay(
    LAYERS,
    {
      pal: "chirps_monthly:ink-blue,esa_worldcover:painted",
      range: "",
      off: "",
      colour: "",
      ink: "",
      dens: "",
    },
    {},
  );

  assert.equal(
    formatDisplayParams(display, LAYERS),
    "&pal=chirps_monthly:ink-blue,esa_worldcover:painted,terrain:brown"
      + "&colour=chirps_monthly&dens=chirps_monthly:1",
  );
});

test("palettes, ranges and off parts round trip through the link text", () => {
  const tokens = {
    pal: "chirps_monthly:custom-1a2b3c-88cc44,esa_worldcover:esa,terrain:grey",
    range: "chirps_monthly:0:250",
    off: "terrain.contours,esa_worldcover",
    colour: "",
    ink: "",
    dens: "",
  };
  const { display } = resolveDisplay(LAYERS, tokens, {});
  const text = formatDisplayParams(display, LAYERS);

  assert.equal(
    text,
    "&pal=chirps_monthly:custom-1a2b3c-88cc44,esa_worldcover:esa,terrain:grey"
      + "&range=chirps_monthly:0:250&off=esa_worldcover,terrain.contours"
      + "&colour=chirps_monthly&dens=chirps_monthly:1",
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
  assert.ok(
    formatDisplayParams(display, COLOUR_LAYERS)
      .endsWith("&colour=chirps_monthly&dens=chirps_monthly:1"),
  );
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
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
  assert.deepEqual(loadStoredEdges("esa_worldcover"), DEFAULT_EDGES);
  assert.doesNotThrow(() => storeEdges("esa_worldcover", { ...DEFAULT_EDGES }));
});

test("inks round trip through the link text and only non-default inks are written", () => {
  const tokens = {
    ...NO_TOKENS,
    ink: "chirps_monthly:deep-red,era5land_temperature:1a2b3c",
  };
  const { display, dropped } = resolveDisplay(COLOUR_LAYERS, tokens, {}, null, {});

  assert.equal(dropped, false);
  assert.deepEqual(display.layers.chirps_monthly, { ink: "deep-red" });
  assert.deepEqual(display.layers.era5land_temperature, { ink: "#1a2b3c" });
  assert.match(
    formatDisplayParams(display, COLOUR_LAYERS),
    /&ink=chirps_monthly:deep-red,era5land_temperature:1a2b3c/,
  );

  const defaults = resolveDisplay(
    COLOUR_LAYERS,
    { ...NO_TOKENS, ink: "chirps_monthly:navy,era5land_temperature:charcoal" },
    {},
    null,
    {},
  );
  assert.ok(!formatDisplayParams(defaults.display, COLOUR_LAYERS).includes("&ink="));
});

test("unknown or invalid inks are ignored", () => {
  const tokens = {
    ...NO_TOKENS,
    ink: "chirps_monthly:pink,chirps_monthly:12345,chirps_monthly:#1a2b3c,"
      + "chirps_monthly:1A2B3C,nowhere:navy,terrain:navy,esa_worldcover:black,x",
  };
  const { display, dropped } = resolveDisplay(LAYERS, tokens, {}, null, {});

  assert.equal(dropped, true);
  assert.deepEqual(display.layers, {});
});

test("a linked ink beats a remembered one and a remembered one beats the default", () => {
  const stored = { chirps_monthly: "brown", era5land_temperature: "#102030", terrain: "black" };
  const remembered = resolveDisplay(COLOUR_LAYERS, NO_TOKENS, {}, null, stored);
  const linked = resolveDisplay(
    COLOUR_LAYERS,
    { ...NO_TOKENS, ink: "chirps_monthly:white" },
    {},
    null,
    stored,
  );

  assert.deepEqual(remembered.display.layers.chirps_monthly, { ink: "brown" });
  assert.deepEqual(remembered.display.layers.era5land_temperature, { ink: "#102030" });
  assert.equal(remembered.display.layers.terrain, undefined);
  assert.deepEqual(linked.display.layers.chirps_monthly, { ink: "white" });
});

test("a remembered ink that is no longer valid is ignored", () => {
  const { display } = resolveDisplay(LAYERS, NO_TOKENS, {}, null, { chirps_monthly: "pink" });

  assert.deepEqual(display.layers, {});
});

test("stored ink values that are not strings are ignored", () => {
  const items = useStorage();
  items.set("soe.ink.v1", JSON.stringify({
    chirps_monthly: ["#ffffff"],
    era5land_temperature: { toString: null },
    terrain: 7,
    esa_worldcover: null,
  }));

  const stored = loadStoredInks();
  const { display, dropped } = resolveDisplay(COLOUR_LAYERS, NO_TOKENS, {}, null, stored);
  const text = formatDisplayParams(display, COLOUR_LAYERS);

  assert.deepEqual(stored, {});
  assert.equal(dropped, false);
  assert.deepEqual(display.layers, {});
  assert.ok(!text.includes("&ink="));
});

test("the resolver reads no ambient ink storage unless the caller loads it", () => {
  const items = useStorage();
  items.set("soe.ink.v1", JSON.stringify({ chirps_monthly: "white" }));

  const implicit = resolveDisplay(LAYERS, NO_TOKENS, {});
  const explicit = resolveDisplay(LAYERS, NO_TOKENS, {}, null, {});
  const applied = resolveDisplay(LAYERS, NO_TOKENS, {}, null, loadStoredInks());

  assert.deepEqual(implicit.display.layers, {});
  assert.deepEqual(explicit.display.layers, {});
  assert.deepEqual(applied.display.layers.chirps_monthly, { ink: "white" });
});

test("an ink choice keeps the range and is remembered by layer", () => {
  useStorage();
  const tokens = { ...NO_TOKENS, range: "chirps_monthly:0:250" };
  const { display } = resolveDisplay(LAYERS, tokens, {}, null, {});
  const menu = {
    palette: "ink-blue",
    defaultPalette: "ink-blue",
    range: { value: [0, 250] as [number, number] },
    ink: { value: "#102030", defaultInk: "navy" },
  };

  recordMenuChange(display, "chirps_monthly", menu, "ink");

  assert.deepEqual(display.layers.chirps_monthly, { range: [0, 250], ink: "#102030" });
  assert.deepEqual(loadStoredInks(), { chirps_monthly: "#102030" });

  const reset = { ...menu, ink: { ...menu.ink, value: "navy" } };
  recordMenuChange(display, "chirps_monthly", reset, "ink");

  assert.deepEqual(loadStoredInks(), {});
  assert.deepEqual(display.layers.chirps_monthly, { range: [0, 250] });
});

test("stored inks are written by layer and storage errors fall back to none", () => {
  useStorage();
  storeInk("chirps_monthly", "white");
  assert.deepEqual(loadStoredInks(), { chirps_monthly: "white" });

  useStorage({
    getItem: () => {
      throw new Error("blocked");
    },
  });
  assert.deepEqual(loadStoredInks(), {});
});

test("a dark ink gets a light halo and a light ink a dark one", () => {
  const light = [246, 239, 227];
  const dark = [31, 31, 31];

  for (const ink of ["navy", "charcoal", "black", "brown", "deep-red", "#102030"]) {
    assert.deepEqual(inkPaint(ink).halo, light, ink);
  }
  for (const ink of ["white", "#f0f0f0", "#ffe08a"]) {
    assert.deepEqual(inkPaint(ink).halo, dark, ink);
  }
  assert.deepEqual(inkPaint("navy").ink, [26, 54, 88]);
});

test("density links carry the normalised density including the explicit default", () => {
  const tokens = { ...NO_TOKENS, dens: "chirps_monthly:1.5" };
  const { display, dropped } = resolveDisplay(LAYERS, tokens, {});

  assert.equal(dropped, false);
  assert.deepEqual(display.layers.chirps_monthly, { density: MAX_DENSITY_RATIO });
  assert.ok(
    formatDisplayParams(display, LAYERS).includes(`&dens=chirps_monthly:${MAX_DENSITY_RATIO}`),
  );

  const defaults = resolveDisplay(LAYERS, { ...NO_TOKENS, dens: "chirps_monthly:1" }, {});
  assert.equal(defaults.dropped, false);
  assert.deepEqual(defaults.display.layers, {});
  assert.ok(formatDisplayParams(defaults.display, LAYERS).includes("&dens=chirps_monthly:1"));
});

test("default and reset density links beat receiver storage without saving", () => {
  const items = useStorage();
  const oldPreference = JSON.stringify({ chirps_monthly: 2 });
  items.set("soe.density.v1", oldPreference);
  const stored = loadStoredDensities();
  const defaultSender = resolveDisplay(COLOUR_LAYERS, NO_TOKENS, {}).display;
  const resetSender = resolveDisplay(
    COLOUR_LAYERS,
    { ...NO_TOKENS, dens: "chirps_monthly:2" },
    {},
  ).display;
  setLayerDisplay(resetSender, "chirps_monthly", { density: undefined });

  for (const sender of [defaultSender, resetSender]) {
    const link = new URLSearchParams(formatDisplayParams(sender, COLOUR_LAYERS));
    const receiver = resolveDisplay(
      COLOUR_LAYERS,
      { ...NO_TOKENS, dens: link.get("dens")! },
      {},
      null,
      {},
      stored,
    );

    assert.deepEqual(receiver.display.layers, {});
    assert.equal(receiver.dropped, false);
    assert.equal(link.get("dens"), "chirps_monthly:1");
    assert.deepEqual(loadStoredDensities(), stored);
    assert.equal(items.get("soe.density.v1"), oldPreference);
    assert.equal(items.size, 1);
    assert.doesNotMatch(link.get("dens")!, /temperature|terrain|worldcover/);
  }
});

test("a density outside the slider's range is clamped to its ends", () => {
  const densityOf = (text: string) =>
    resolveDisplay(LAYERS, { ...NO_TOKENS, dens: `chirps_monthly:${text}` }, {})
      .display.layers.chirps_monthly?.density;

  assert.equal(densityOf("5"), MAX_DENSITY_RATIO);
  assert.equal(densityOf("0.1"), MIN_DENSITY_RATIO);
  assert.equal(densityOf("-3"), MIN_DENSITY_RATIO);
  assert.equal(densityOf("1.2345"), 2 ** 0.25);
});

test("a linked density reaches the control on the slider's step", () => {
  const { display } = resolveDisplay(
    LAYERS,
    { ...NO_TOKENS, dens: "chirps_monthly:1.23" },
    {},
  );
  const calls: number[] = [];
  const control = densityControl(
    () => display.layers.chirps_monthly!.density!,
    (density) => calls.push(density),
  );

  assert.equal(control.value, 0.25);
  assert.equal((control.value - control.min) / control.step, 14);
  control.set(control.value);
  assert.deepEqual(calls, [2 ** 0.25]);
});

test("the logarithmic control has sixteen equal ratio steps and the default on a step", () => {
  let density = 1;
  const control = densityControl(() => density, (next) => {
    density = next;
  });
  const steps = (control.max - control.min) / control.step;

  assert.equal(steps, 16);
  assert.equal(control.value, 0);
  assert.equal((control.value - control.min) / control.step, 12);
  for (let step = 0; step <= steps; step++) {
    control.set(control.min + step * control.step);
    assert.equal(density, 2 ** (control.min + step * DENSITY_STEP_LOG2));
    assert.equal(control.value, control.min + step * control.step);
  }
  control.set(-20);
  assert.equal(density, MIN_DENSITY_RATIO);
  control.set(20);
  assert.equal(density, MAX_DENSITY_RATIO);
});

test("densities are remembered by layer, with the link winning for the visit", () => {
  const items = useStorage();
  storeDensity("chirps_monthly", 1.5);
  storeDensity("era5land_temperature", 0.75);

  assert.deepEqual(loadStoredDensities(), {
    chirps_monthly: MAX_DENSITY_RATIO,
    era5land_temperature: quantiseDensity(0.75),
  });

  const remembered = resolveDisplay(LAYERS, NO_TOKENS, {}, null, {}, loadStoredDensities());
  const linked = resolveDisplay(
    LAYERS,
    { ...NO_TOKENS, dens: "chirps_monthly:2" },
    {},
    null,
    {},
    loadStoredDensities(),
  );

  assert.deepEqual(remembered.display.layers.chirps_monthly, { density: MAX_DENSITY_RATIO });
  assert.deepEqual(linked.display.layers.chirps_monthly, { density: MAX_DENSITY_RATIO });
  assert.equal(items.size, 1);
});

test("old stored densities clamp while invalid or blocked storage falls back to defaults", () => {
  const items = useStorage();
  items.set("soe.density.v1", JSON.stringify({
    chirps_monthly: 3,
    era5land_temperature: "1.5",
    terrain: -1,
  }));
  assert.deepEqual(loadStoredDensities(), {
    chirps_monthly: MAX_DENSITY_RATIO,
    terrain: MIN_DENSITY_RATIO,
  });

  items.set("soe.density.v1", JSON.stringify({ chirps_monthly: 1.23 }));
  assert.deepEqual(loadStoredDensities(), { chirps_monthly: 2 ** 0.25 });

  useStorage({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
  assert.deepEqual(loadStoredDensities(), {});
  assert.doesNotThrow(() => storeDensity("chirps_monthly", 1.5));
});

test("forgetting a stored density removes it", () => {
  useStorage();
  storeDensity("chirps_monthly", 1.5);
  storeDensity("chirps_monthly", null);

  assert.deepEqual(loadStoredDensities(), {});
});

test("invalid densities and layers without dots fall back to the default", () => {
  const tokens = {
    ...NO_TOKENS,
    dens: "chirps_monthly:abc,chirps_monthly:,chirps_monthly:Infinity,chirps_monthly:1:2,"
      + "nowhere:1.5,terrain:1.5,esa_worldcover:1.5,x",
  };
  const { display, dropped } = resolveDisplay(LAYERS, tokens, {});
  const noDots = resolveDisplay(
    COLOUR_LAYERS,
    { ...NO_TOKENS, dens: "era5land_temperature:1.5" },
    {},
  );

  assert.equal(dropped, true);
  assert.deepEqual(display.layers, {});
  assert.equal(noDots.dropped, true);
  assert.deepEqual(noDots.display.layers, {});
});

test("the last density for a layer wins, even when it is the default", () => {
  const tokens = { ...NO_TOKENS, dens: "chirps_monthly:1.5,chirps_monthly:1" };

  assert.deepEqual(resolveDisplay(LAYERS, tokens, {}).display.layers, {});
});

test("a menu change keeps the layer's density", () => {
  useStorage();
  const { display } = resolveDisplay(LAYERS, { ...NO_TOKENS, dens: "chirps_monthly:1.5" }, {});
  const menu = { palette: "cividis", defaultPalette: "ink-blue" };

  recordMenuChange(display, "chirps_monthly", menu, "palette");

  assert.deepEqual(display.layers.chirps_monthly, {
    palette: "cividis",
    density: MAX_DENSITY_RATIO,
  });
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
