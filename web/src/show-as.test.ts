import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

import type { LayerDoc } from "./types.ts";

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
const {
  choose,
  displacedOwner,
  formatShowAs,
  loadStoredShowAs,
  parseShowAs,
  showAsOptions,
  storeShowAs,
  toggle,
} = await import("./show-as.ts");
const { allocate, BLEND } = await import("./layers/allocate.ts");
const {
  formatDisplayParams,
  NO_TOKENS,
  resolveDisplay,
} = await import("./display-state.ts").finally(() => hooks.deregister());

const RAIN = layer("rain", ["ramp", "dots", "isolines", "chroma"]);
const TEMP = layer("temp", ["ramp", "isolines", "warmth"]);
const LAND = layer("land", ["fill"], "categorical");
const TERRAIN = layer("terrain", ["shade"], "terrain", ["contours"]);
const LAYERS = [RAIN, TEMP, LAND];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("choosing colour clears the other explicit colour", () => {
  const next = choose(state({ rain: "colour" }), "temp", "colour", LAYERS);

  assert.deepEqual(next.showAs, { temp: "colour" });
});

test("choosing colour on a half ends the blend and restores both halves", () => {
  const next = choose(state({ blend: "colour" }, ["rain", "temp"]), "temp", "colour", LAYERS);

  assert.deepEqual(next.showAs, { temp: "colour" });
  assert.deepEqual([...next.off], []);
});

test("choosing blend switches both halves off", () => {
  const next = choose(state(), BLEND, "colour", LAYERS);

  assert.deepEqual(next.showAs, { blend: "colour" });
  assert.deepEqual([...next.off], ["rain", "temp"]);
});

test("choosing dots on the owner passes colour to auto", () => {
  const next = choose(state({ rain: "colour" }), "rain", "dots", LAYERS);
  const allocation = allocate([RAIN, TEMP], on("rain", "temp"), next.showAs);

  assert.deepEqual(next.showAs, { rain: "dots" });
  assert.equal(allocation.owner, "temp");
  assert.equal(allocation.draws.get("rain"), "dots");
});

test("toggling an explicit owner off and on restores it", () => {
  const start = state({ temp: "colour" });
  const off = toggle(start, "temp", false, LAYERS);
  const restored = toggle(off, "temp", true, LAYERS);

  assert.equal(off.showAs.temp, "colour");
  assert.ok(off.off.has("temp"));
  assert.equal(allocate([RAIN, TEMP], on("rain"), off.showAs).owner, "rain");
  assert.equal(allocate([RAIN, TEMP], on("rain", "temp"), restored.showAs).owner, "temp");
});

test("turning a blend half on ends the blend and restores both halves", () => {
  const next = toggle(state({ blend: "colour" }, ["rain", "temp"]), "temp", true, LAYERS);

  assert.deepEqual(next.showAs, { temp: "colour" });
  assert.deepEqual([...next.off], []);
});

test("turning a sticky colour back on restores its ownership", () => {
  const shared = state({ rain: "colour", temp: "colour" }, ["rain"]);
  const restored = toggle(shared, "rain", true, [TEMP, RAIN]);
  const allocation = allocate([TEMP, RAIN], on("rain", "temp"), restored.showAs);

  assert.deepEqual(restored.showAs, { rain: "colour" });
  assert.deepEqual([...restored.off], []);
  assert.equal(allocation.owner, "rain");
});

test("displacedOwner names the old owner only for a colour choice", () => {
  const before = allocate([RAIN, TEMP], on("rain", "temp"), { rain: "colour" });
  const after = allocate([RAIN, TEMP], on("rain", "temp"), { temp: "colour" });

  assert.equal(
    displacedOwner(
      before,
      after,
      { kind: "choose", unit: "temp", draw: "colour" },
    ),
    "rain",
  );
  assert.equal(
    displacedOwner(
      before,
      after,
      { kind: "choose", unit: "temp", draw: "isolines" },
    ),
    null,
  );
  assert.equal(
    displacedOwner(
      before,
      before,
      { kind: "toggle", unit: "temp", on: true },
    ),
    null,
  );
});

test("displacedOwner ignores blend halves switched off by choosing blend", () => {
  const chosen = allocate([RAIN, TEMP], on("rain", "temp"), { temp: "colour" });
  const blended = allocate([RAIN, TEMP], on(), { blend: "colour" });

  assert.equal(
    displacedOwner(
      chosen,
      blended,
      { kind: "choose", unit: BLEND, draw: "colour" },
    ),
    null,
  );
  assert.equal(
    displacedOwner(
      blended,
      chosen,
      { kind: "choose", unit: "temp", draw: "colour" },
    ),
    BLEND,
  );
});

test("displacedOwner keeps a still-on owner displaced by the blend", () => {
  const layers = [LAND, RAIN, TEMP];
  const before = allocate(layers, on("land", "rain", "temp"), { land: "colour" });
  const blended = allocate(layers, on("land"), { blend: "colour" });

  assert.equal(before.owner, "land");
  assert.equal(blended.owner, BLEND);
  assert.equal(
    displacedOwner(
      before,
      blended,
      { kind: "choose", unit: BLEND, draw: "colour" },
    ),
    "land",
  );
});

test("parse drops unknown units and draws outside the options", () => {
  const parsed = parseShowAs(
    "nowhere:dots,rain:shade,terrain:contours,temp:isolines",
    [RAIN, TEMP, TERRAIN],
  );

  assert.deepEqual(parsed.showAs, { temp: "isolines" });
  assert.equal(parsed.dropped, true);
});

test("the last colour entry in a link wins", () => {
  const parsed = parseShowAs("rain:colour,temp:colour", [RAIN, TEMP]);

  assert.deepEqual(parsed.showAs, { temp: "colour" });
  assert.equal(parsed.dropped, false);
});

test("a later entry for the same unit replaces its colour ownership", () => {
  const parsed = parseShowAs("temp:colour,temp:isolines,rain:colour", [RAIN, TEMP]);

  assert.deepEqual(parsed.showAs, { temp: "isolines", rain: "colour" });
  assert.equal(parsed.dropped, false);
});

test("an off colour entry does not compete for ownership", () => {
  const parsed = parseShowAs("rain:colour,temp:colour", [RAIN, TEMP], on("rain"));

  assert.deepEqual(parsed.showAs, { rain: "colour", temp: "colour" });
});

test("format writes every on unit's effective draw and the blend owner", () => {
  const plain = { showAs: {}, off: new Set<string>() };
  const allocation = allocate([RAIN, TEMP], on("rain", "temp"), plain.showAs);
  const blended = state({ blend: "colour" }, ["rain", "temp"]);
  const blendAllocation = allocate([RAIN, TEMP], on("rain", "temp"), blended.showAs);
  const land = state({ rain: "dots", temp: "isolines" });
  const landAllocation = allocate([RAIN, TEMP, LAND], on("rain", "temp", "land"), land.showAs);

  assert.deepEqual(formatShowAs(plain, [RAIN, TEMP], allocation), [
    "rain:dots",
    "temp:colour",
  ]);
  assert.deepEqual(formatShowAs(blended, [RAIN, TEMP], blendAllocation), ["blend:colour"]);
  assert.deepEqual(
    formatShowAs(land, [RAIN, TEMP, LAND], landAllocation),
    ["rain:dots", "temp:isolines", "land:colour"],
  );
});

test("an off sticky colour round trips in either layer order", () => {
  for (const layers of [[RAIN, TEMP], [TEMP, RAIN]]) {
    const sender = state({ rain: "colour" }, ["rain"]);
    const senderAllocation = allocate(layers, on("temp"), sender.showAs);
    const params = new URLSearchParams(
      formatDisplayParams(
        { layers: {}, off: new Set(sender.off), showAs: sender.showAs },
        layers,
      ),
    );
    const { display } = resolveDisplay(
      layers,
      {
        ...NO_TOKENS,
        as: params.get("as") ?? "",
        off: params.get("off") ?? "",
      },
      {},
      { blend: "colour", temp: "dots" },
    );
    const receiverAllocation = allocate(layers, on("temp"), display.showAs);
    const toggled = toggle(
      { showAs: display.showAs, off: display.off },
      "rain",
      true,
      layers,
    );
    const toggledAllocation = allocate(layers, on("rain", "temp"), toggled.showAs);

    assert.deepEqual(display.showAs, { rain: "colour", temp: "colour" });
    assert.deepEqual([...display.off], ["rain"]);
    assert.equal(receiverAllocation.owner, senderAllocation.owner);
    assert.equal(receiverAllocation.owner, "temp");
    assert.equal(toggledAllocation.owner, "rain");
    assert.equal(toggledAllocation.draws.get("temp"), "isolines");
  }
});

test("a linked snapshot ignores stored choices, including a stored blend", () => {
  const layers = [RAIN, TEMP, LAND];
  const sender = state({ rain: "dots", temp: "isolines" });
  const senderAllocation = allocate(layers, on("rain", "temp", "land"), sender.showAs);
  const params = new URLSearchParams(
    formatDisplayParams({ layers: {}, off: new Set(), showAs: sender.showAs }, layers),
  );
  const storedCases = [
    { blend: "colour" },
    { temp: "colour", blend: "colour" },
  ] as Record<string, "colour">[];

  assert.equal(senderAllocation.owner, "land");
  assert.ok(params.get("as")?.includes("land:colour"));

  for (const stored of storedCases) {
    const { display } = resolveDisplay(
      layers,
      { ...NO_TOKENS, as: params.get("as") ?? "" },
      {},
      stored,
    );
    const allocation = allocate(layers, on("rain", "temp", "land"), display.showAs);

    assert.deepEqual(display.showAs, {
      rain: "dots",
      temp: "isolines",
      land: "colour",
    });
    assert.equal(allocation.owner, "land");
    assert.deepEqual(allocation.draws.get("rain"), "dots");
    assert.deepEqual(allocation.draws.get("temp"), "isolines");
  }
});

test("showAsOptions treats the blend as a combined colour unit only", () => {
  assert.deepEqual(showAsOptions("rain", [RAIN, TEMP]), ["colour", "dots"]);
  assert.deepEqual(showAsOptions(BLEND, [RAIN, TEMP]), ["colour"]);
  assert.deepEqual(showAsOptions(BLEND, [RAIN]), []);
  assert.deepEqual(showAsOptions("terrain", [TERRAIN]), []);
});

test("stored choices follow recency and the latest colour wins", () => {
  useStorage();
  storeShowAs("rain", "colour");
  storeShowAs("temp", "dots");
  storeShowAs("temp", "colour");

  assert.deepEqual(Object.keys(loadStoredShowAs()), ["rain", "temp"]);
  const { display } = resolveDisplay([RAIN, TEMP], NO_TOKENS, {}, loadStoredShowAs());

  assert.deepEqual(display.showAs, { temp: "colour" });
});

test("the first write removes the old colour key", () => {
  const items = useStorage();
  items.set("soe.colour.v1", JSON.stringify({ pick: "temp" }));

  storeShowAs("rain", "dots");

  assert.equal(items.has("soe.colour.v1"), false);
  assert.deepEqual(loadStoredShowAs(), { rain: "dots" });
});

test("clearing a stored choice forgets that unit", () => {
  useStorage();
  storeShowAs("rain", "dots");
  storeShowAs("rain", null);

  assert.deepEqual(loadStoredShowAs(), {});
});

test("a failed write keeps the previous stored record", () => {
  const items = useStorage({
    setItem: () => {
      throw new Error("quota");
    },
  });
  const previous = JSON.stringify({ rain: "dots" });
  items.set("soe.showas.v1", previous);

  assert.doesNotThrow(() => storeShowAs("temp", "colour"));

  assert.equal(items.get("soe.showas.v1"), previous);
  assert.deepEqual(loadStoredShowAs(), { rain: "dots" });
});

test("blocked storage falls back to Auto", () => {
  useBlockedStorage();

  assert.deepEqual(loadStoredShowAs(), {});
  assert.doesNotThrow(() => storeShowAs("rain", "colour"));
  const { display } = resolveDisplay([RAIN, TEMP], NO_TOKENS, {}, loadStoredShowAs());
  assert.deepEqual(display.showAs, {});
});

function state(showAs: Record<string, "colour" | "dots" | "isolines"> = {}, off: string[] = []) {
  return { showAs, off: new Set(off) };
}

function layer(id: string, encodings: string[], kind = "field", parts?: string[]) {
  return {
    id,
    style: { kind, encodings, ...(parts && { parts }) },
  } as unknown as LayerDoc;
}

function on(...units: string[]) {
  return new Set(units);
}

function useBlockedStorage() {
  const blocked = () => {
    throw new Error("blocked");
  };
  useStorage({ getItem: blocked, setItem: blocked });
}

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
