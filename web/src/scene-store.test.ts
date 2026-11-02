import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultSlice } from "./charts/state.ts";
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

test("chart defaults seed from metadata with rainfall preferred as main", () => {
  const store = createSceneStore(chartLayers(), display());

  assert.deepEqual(
    store.getSnapshot().charts.definitions.map((definition) => definition.id),
    ["chirps:time_series", "era5:time_series", "terrain:distribution"],
  );
  assert.equal(store.getSnapshot().charts.mainChartId, "chirps:time_series");
});

test("an all-unavailable scene keeps an empty slice with no main", () => {
  const store = createSceneStore(LAYERS, display());

  assert.deepEqual(store.getSnapshot().charts.definitions, []);
  assert.equal(store.getSnapshot().charts.mainChartId, null);
});

test("a provided slice is kept while a missing main falls back deterministically", () => {
  const layers = chartLayers();
  const stored = {
    version: 1 as const,
    definitions: [
      {
        id: "custom",
        title: "Custom",
        source: { layerId: "era5", shape: "time_series" as const },
        chartType: "line" as const,
        options: {},
      },
    ],
    mainChartId: "custom",
  };
  const store = createSceneStore(layers, display(), null);
  assert.equal(store.getSnapshot().charts.mainChartId, "chirps:time_series");

  const kept = createSceneStore(layers, display(), stored);
  assert.deepEqual(kept.getSnapshot().charts, stored);

  const invalid = createSceneStore(layers, display(), { ...stored, mainChartId: "missing" });
  assert.equal(invalid.getSnapshot().charts.mainChartId, "chirps:time_series");

  const emptyForAvailable = { version: 1 as const, definitions: [], mainChartId: null };
  const emptyFallback = createSceneStore(layers, display(), emptyForAvailable);
  assert.equal(emptyFallback.getSnapshot().charts.mainChartId, "chirps:time_series");

  const nullMain = { ...stored, mainChartId: null };
  const nullFallback = createSceneStore(layers, display(), nullMain);
  assert.equal(nullFallback.getSnapshot().charts.mainChartId, "chirps:time_series");
});

test("deleting the main chart falls back to the first remaining definition", () => {
  const layers = chartLayers();
  const defaults = defaultSlice(layers);
  const reordered = {
    version: 1 as const,
    definitions: [defaults.definitions[1], defaults.definitions[0], defaults.definitions[2]],
    mainChartId: defaults.definitions[2].id,
  };
  const store = createSceneStore(layers, display(), reordered);
  assert.equal(store.getSnapshot().charts.mainChartId, reordered.mainChartId);

  store.dispatch({ kind: "deleteChart", id: reordered.mainChartId });
  assert.deepEqual(
    store.getSnapshot().charts.definitions.map((definition) => definition.id),
    [defaults.definitions[1].id, defaults.definitions[0].id],
  );
  assert.equal(store.getSnapshot().charts.mainChartId, defaults.definitions[1].id);
});

test("chart ingress copies nested inputs so later mutations stay local", () => {
  const layers = chartLayers();
  const initial = {
    version: 1 as const,
    definitions: [
      {
        id: "custom",
        title: "Custom",
        source: { layerId: "era5", shape: "time_series" as const },
        chartType: "line" as const,
        options: { yRange: [0, 100] as [number, number] },
      },
    ],
    mainChartId: "custom",
  };
  const store = createSceneStore(layers, display(), initial);
  const before = store.getSnapshot();
  initial.definitions[0].options.yRange![0] = -99;
  initial.definitions[0].source.layerId = "mutated";

  assert.deepEqual(store.getSnapshot().charts.definitions[0].options.yRange, [0, 100]);
  assert.equal(store.getSnapshot().charts.definitions[0].source.layerId, "era5");
  assert.equal(before.charts.definitions[0].source.layerId, "era5");

  const definition = {
    id: "extra",
    title: "Extra",
    source: { layerId: "era5", shape: "time_series" as const },
    chartType: "line" as const,
    options: { yRange: [0, 50] as [number, number] },
  };
  store.dispatch({ kind: "saveChart", definition });
  const saved = store.getSnapshot();
  definition.options.yRange![0] = -99;

  assert.deepEqual(saved.charts.definitions[1].options.yRange, [0, 50]);
  assert.deepEqual(store.getSnapshot().charts.definitions[1].options.yRange, [0, 50]);
});

test("saves validate against canonical source tables and references", () => {
  const layers = chartLayers();
  const store = createSceneStore(layers, display());
  const rainId = store.getSnapshot().charts.definitions[0].id;

  const clippedRain = {
    id: rainId,
    title: "Rain",
    source: { layerId: "chirps", shape: "time_series" as const },
    chartType: "bar" as const,
    options: { yRange: [0, 1] as [number, number] },
  };
  assert.throws(() => store.dispatch({ kind: "saveChart", definition: clippedRain }));

  const terrainId = store.getSnapshot().charts.definitions[2].id;
  const clippedTerrain = {
    id: terrainId,
    title: "Terrain",
    source: { layerId: "terrain", shape: "distribution" as const },
    chartType: "area" as const,
    options: { showReferences: true, yRange: [0, 1] as [number, number] },
  };
  assert.throws(() => store.dispatch({ kind: "saveChart", definition: clippedTerrain }));

  const hiddenTerrain = {
    ...clippedTerrain,
    options: { showReferences: false, yRange: [0, 1] as [number, number] },
  };
  assert.throws(() => store.dispatch({ kind: "saveChart", definition: hiddenTerrain }));

  const switchedRain = {
    ...clippedRain,
    options: { displayUnit: "in/month", yRange: [0, 1] as [number, number] },
  };
  assert.throws(() => store.dispatch({ kind: "saveChart", definition: switchedRain }));
  assert.equal(store.getSnapshot().charts.definitions.length, 3);
});

test("saving adds or replaces atomically and honours the main choice", () => {
  const store = createSceneStore(chartLayers(), display());
  const before = store.getSnapshot();
  const edited = { ...before.charts.definitions[0], title: "Edited", chartType: "line" as const };

  store.dispatch({ kind: "saveChart", definition: edited });

  assert.equal(store.getSnapshot().charts.definitions[0].title, "Edited");
  assert.equal(store.getSnapshot().charts.definitions[0].id, before.charts.definitions[0].id);
  assert.equal(store.getSnapshot().charts.mainChartId, before.charts.mainChartId);

  const extra = {
    id: "extra",
    title: "Extra",
    source: { layerId: "era5", shape: "time_series" as const },
    chartType: "bar" as const,
    options: {},
  };
  store.dispatch({ kind: "saveChart", definition: extra, makeMain: true });

  assert.equal(store.getSnapshot().charts.mainChartId, "extra");
  assert.equal(store.getSnapshot().charts.definitions.length, 4);
});

test("invalid chart saves are blocked without touching the slice", () => {
  const store = createSceneStore(chartLayers(), display());
  const before = store.getSnapshot();
  const bad = {
    id: "bad",
    title: "",
    source: { layerId: "nowhere", shape: "time_series" as const },
    chartType: "bar" as const,
    options: {},
  };

  assert.throws(() => store.dispatch({ kind: "saveChart", definition: bad }));
  assert.equal(store.getSnapshot().charts, before.charts);
});

test("deleting the last definition restores its default", () => {
  const single = [chartLayers()[0]];
  const store = createSceneStore(single, display());
  const only = store.getSnapshot().charts.definitions[0].id;

  store.dispatch({ kind: "deleteChart", id: only });

  assert.deepEqual(
    store.getSnapshot().charts.definitions.map((definition) => definition.id),
    ["chirps:time_series"],
  );
  assert.equal(store.getSnapshot().charts.mainChartId, "chirps:time_series");
});

test("set-main and reset keep the nonempty invariant", () => {
  const store = createSceneStore(chartLayers(), display());
  const second = store.getSnapshot().charts.definitions[1].id;

  store.dispatch({ kind: "setMain", id: second });
  assert.equal(store.getSnapshot().charts.mainChartId, second);

  store.dispatch({ kind: "setMain", id: "missing" });
  assert.equal(store.getSnapshot().charts.mainChartId, second);

  store.dispatch({ kind: "resetCharts" });
  assert.equal(store.getSnapshot().charts.mainChartId, "chirps:time_series");
});

test("chart edits keep display, allocation and on identity for map subscribers", () => {
  const store = createSceneStore(chartLayers(), display());
  const before = store.getSnapshot();
  const definition = {
    id: "extra",
    title: "Extra",
    source: { layerId: "era5", shape: "time_series" as const },
    chartType: "line" as const,
    options: {},
  };

  store.dispatch({ kind: "saveChart", definition });

  const after = store.getSnapshot();
  assert.equal(after.display, before.display);
  assert.equal(after.allocation, before.allocation);
  assert.equal(after.on, before.on);
  assert.notEqual(after.charts, before.charts);
});

test("display edits keep the chart slice identity for link subscribers", () => {
  const store = createSceneStore(chartLayers(), display());
  const before = store.getSnapshot();

  store.dispatch({ kind: "clear", unit: "chirps" });

  assert.equal(store.getSnapshot().charts, before.charts);
  assert.notEqual(store.getSnapshot().display, before.display);
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

function chartLayers(): LayerDoc[] {
  const monthly = (id: string, method: string) => {
    const values = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(Date.UTC(2019, index, 1));
      return date.toISOString().slice(0, 10);
    });
    return {
      id,
      title: id,
      units: id === "era5" ? "°C" : "mm/month",
      style: { kind: "field", encodings: ["ramp"] },
      time: { step: "P1M", values, end: "2021-07-01", method },
      area_series: {
        statistic: "mean",
        weights: "cell_area_inside_outline",
        values: values.map(() => 10),
        valid_fraction: values.map(() => 1),
      },
    } as unknown as LayerDoc;
  };
  return [
    monthly("chirps", "sum"),
    monthly("era5", "mean"),
    {
      id: "terrain",
      title: "terrain",
      units: "m",
      style: { kind: "terrain", encodings: ["shade"] },
      grid: { res: 0.000833333333333 },
      time: null,
      distribution: {
        statistic: "quantiles",
        weights: "cell_area_inside_outline",
        percent: 1,
        values: Array.from({ length: 101 }, (_, index) => index),
        min: 0,
        max: 100,
        mean: 50,
        valid_fraction: 1,
        reference_values: [],
      },
    } as unknown as LayerDoc,
  ];
}
