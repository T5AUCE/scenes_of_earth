import assert from "node:assert/strict";
import { test } from "node:test";

import type { SceneDisplay } from "./display-state.ts";
import { createSceneStore } from "./scene-store.ts";
import type { LayerDisplay, LayerDoc } from "./types.ts";

const RAIN = layer("rain", ["ramp", "dots"]);
const TEMP = layer("temp", ["ramp", "isolines"]);
const LAYERS = [RAIN, TEMP];

test("the snapshot stays the same until something is dispatched", () => {
  const store = createSceneStore(LAYERS, display());
  const snapshot = store.getSnapshot();

  assert.equal(store.getSnapshot(), snapshot);
  assert.deepEqual([...snapshot.on], ["rain", "temp"]);
  assert.equal(snapshot.allocation.owner, "temp");
  assert.equal(snapshot.allocation.draws.get("rain"), "dots");
  assert.equal(snapshot.allocation.draws.get("temp"), "colour");
});

test("choosing colour re-derives the allocation and leaves the old snapshot untouched", () => {
  const store = createSceneStore(LAYERS, display());
  const before = store.getSnapshot();

  store.dispatch({ kind: "choose", unit: "rain", draw: "colour" });
  const after = store.getSnapshot();

  assert.notEqual(after, before);
  assert.deepEqual(after.display.showAs, { rain: "colour" });
  assert.equal(after.allocation.owner, "rain");
  assert.deepEqual(before.display.showAs, {});
  assert.equal(before.allocation.owner, "temp");
});

test("toggling a layer changes the visible units and the allocation", () => {
  const store = createSceneStore(LAYERS, display());

  store.dispatch({ kind: "toggle", unit: "temp", on: false });
  const snapshot = store.getSnapshot();

  assert.equal(snapshot.on.has("temp"), false);
  assert.equal(snapshot.display.off.has("temp"), true);
  assert.equal(snapshot.allocation.owner, "rain");
});

test("clearing forgets a unit's explicit Show as choice", () => {
  const store = createSceneStore(LAYERS, display());
  store.dispatch({ kind: "choose", unit: "rain", draw: "colour" });

  store.dispatch({ kind: "clear", unit: "rain" });

  assert.deepEqual(store.getSnapshot().display.showAs, {});
  assert.equal(store.getSnapshot().allocation.owner, "temp");
});

test("a display update changes a copy of the layer entries", () => {
  const temperature: LayerDisplay = { palette: "thermal" };
  const store = createSceneStore(LAYERS, { ...display(), layers: { temp: temperature } });
  const before = store.getSnapshot();

  store.dispatch({
    kind: "display",
    update: (next) => {
      next.layers.temp = { ...next.layers.temp, ink: "#000000" };
    },
  });
  const after = store.getSnapshot();

  assert.deepEqual(before.display.layers.temp, { palette: "thermal" });
  assert.deepEqual(after.display.layers.temp, { palette: "thermal", ink: "#000000" });
});

test("a range tuple is copied for every snapshot and for the initial display", () => {
  const initial: SceneDisplay = {
    ...display(),
    layers: { temp: { range: [0, 10] } },
  };
  const store = createSceneStore(LAYERS, initial);
  const before = store.getSnapshot();

  store.dispatch({ kind: "clear", unit: "rain" });
  const after = store.getSnapshot();
  after.display.layers.temp!.range![0] = -5;
  initial.layers.temp!.range![0] = -99;

  assert.deepEqual(after.display.layers.temp!.range, [-5, 10]);
  assert.deepEqual(before.display.layers.temp!.range, [0, 10]);
  assert.deepEqual(initial.layers.temp!.range, [-99, 10]);
  assert.deepEqual(store.getSnapshot().display.layers.temp!.range, [-5, 10]);
});

test("an in-place layer update does not reach an earlier snapshot", () => {
  const store = createSceneStore(LAYERS, {
    ...display(),
    layers: { temp: { palette: "thermal" } },
  });
  const before = store.getSnapshot();

  store.dispatch({
    kind: "display",
    update: (next) => {
      next.layers.temp!.palette = "viridis";
    },
  });

  assert.equal(before.display.layers.temp!.palette, "thermal");
  assert.equal(store.getSnapshot().display.layers.temp!.palette, "viridis");
});

test("listeners fire once per dispatch and stop after unsubscribing", () => {
  const store = createSceneStore(LAYERS, display());
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);

  store.dispatch({ kind: "clear", unit: "rain" });
  assert.equal(calls, 1);

  unsubscribe();
  store.dispatch({ kind: "clear", unit: "rain" });
  assert.equal(calls, 1);
});

test("a multi-part master toggle notifies once with the combined off set", () => {
  const terrain = {
    id: "terrain",
    style: { kind: "terrain", encodings: ["shade"], parts: ["contours"] },
  } as unknown as LayerDoc;
  const store = createSceneStore([terrain], display());
  let calls = 0;
  store.subscribe(() => calls++);

  store.dispatch({ kind: "toggleMany", units: ["terrain", "terrain.contours"], on: false });

  assert.equal(calls, 1);
  assert.deepEqual([...store.getSnapshot().display.off], ["terrain", "terrain.contours"]);
  assert.deepEqual([...store.getSnapshot().on], []);
});

function display(): SceneDisplay {
  return { layers: {}, off: new Set(), showAs: {} };
}

function layer(id: string, encodings: string[]): LayerDoc {
  return {
    id,
    style: { kind: "field", encodings },
  } as unknown as LayerDoc;
}
