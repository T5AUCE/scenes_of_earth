import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addInlandWater,
  addOceanCover,
  INLAND_WATER_ID,
  OCEAN_COVER_ID,
  refreshOceanCover,
  removeInlandWater,
  removeOceanCover,
} from "./geology-water.ts";

const WATER_PAINT = { "fill-color": "rgb(158,189,255)" };
const WATER_FILTER = ["!=", ["get", "brunnel"], "tunnel"];

function makeMap(layers: string[] = ["background", "water", "fill-anchor"]) {
  const order = [...layers];
  const specs = new Map<string, Record<string, unknown>>();
  let addedSources = 0;

  return {
    getLayersOrder: () => [...order],
    getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
    getSource: (id: string) => (id === "openmaptiles" ? {} : undefined),
    getStyle: () => ({
      layers: [
        {
          id: "water",
          type: "fill",
          source: "openmaptiles",
          "source-layer": "water",
          filter: WATER_FILTER,
          paint: WATER_PAINT,
        },
      ],
    }),
    addLayer: (spec: { id: string }, beforeId?: string) => {
      specs.set(spec.id, spec);
      const index = beforeId ? order.indexOf(beforeId) : order.length;
      order.splice(index < 0 ? order.length : index, 0, spec.id);
    },
    addSource: () => {
      addedSources += 1;
    },
    addedSources: () => addedSources,
    removeLayer: (id: string) => {
      order.splice(order.indexOf(id), 1);
    },
    removeSource: (_id: string) => {
      throw new Error("the water copy must never remove its source");
    },
    specs,
  };
}

test("the inland cover sits before its anchor with the basemap paint and no ocean", () => {
  const map = makeMap(["geology-classes", "cover-classes", "fill-anchor", "outline"]);

  assert.equal(addInlandWater(map as never, "fill-anchor"), true);

  assert.deepEqual(map.getLayersOrder(), [
    "geology-classes",
    "cover-classes",
    INLAND_WATER_ID,
    "fill-anchor",
    "outline",
  ]);

  const spec = map.specs.get(INLAND_WATER_ID)!;

  assert.equal(spec.source, "openmaptiles");
  assert.equal(spec["source-layer"], "water");
  assert.deepEqual(spec.paint, WATER_PAINT);
  assert.deepEqual(spec.filter, ["all", WATER_FILTER, ["!=", ["get", "class"], "ocean"]]);
  assert.equal(map.getSource("openmaptiles") !== undefined, true);
  assert.equal(map.addedSources(), 0);
});

test("the inland cover sits above geology alone and above land cover alone", () => {
  const geologyOnly = makeMap(["geology-classes", "fill-anchor"]);

  assert.equal(addInlandWater(geologyOnly as never, "fill-anchor"), true);
  assert.deepEqual(geologyOnly.getLayersOrder(), [
    "geology-classes",
    INLAND_WATER_ID,
    "fill-anchor",
  ]);
  assert.equal(geologyOnly.addedSources(), 0);

  const coverOnly = makeMap(["cover-classes", "fill-anchor"]);

  assert.equal(addInlandWater(coverOnly as never, "fill-anchor"), true);
  assert.deepEqual(coverOnly.getLayersOrder(), ["cover-classes", INLAND_WATER_ID, "fill-anchor"]);
  assert.equal(coverOnly.addedSources(), 0);
});

test("a second inland cover adds no layer and no source", () => {
  const map = makeMap(["geology-classes", "cover-classes", "fill-anchor"]);

  assert.equal(addInlandWater(map as never, "fill-anchor"), true);
  assert.equal(addInlandWater(map as never, "fill-anchor"), true);
  assert.deepEqual(map.getLayersOrder(), [
    "geology-classes",
    "cover-classes",
    INLAND_WATER_ID,
    "fill-anchor",
  ]);
  assert.equal(map.addedSources(), 0);
});

test("the inland cover reuses the basemap water but leaves the sea to the ocean cover", () => {
  const map = makeMap(["cover-classes", "fill-anchor"]);

  assert.equal(addInlandWater(map as never, "fill-anchor"), true);

  const spec = map.specs.get(INLAND_WATER_ID)!;

  // The copy paints only non-ocean basemap water so islands and outside water stay visible.
  assert.equal(spec["source-layer"], "water");
  assert.deepEqual(spec.filter, ["all", WATER_FILTER, ["!=", ["get", "class"], "ocean"]]);
  assert.deepEqual(spec.paint, WATER_PAINT);
  assert.ok(
    map.getLayersOrder().indexOf(INLAND_WATER_ID) > map.getLayersOrder().indexOf("cover-classes"),
  );
});

test("the inland cover without a basemap filter still skips the ocean class", () => {
  const map = makeMap();
  (map as { getStyle: () => unknown }).getStyle = () => ({
    layers: [
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: WATER_PAINT,
      },
    ],
  });

  assert.equal(addInlandWater(map as never, "fill-anchor"), true);

  const spec = map.specs.get(INLAND_WATER_ID)!;

  assert.deepEqual(spec.filter, ["!=", ["get", "class"], "ocean"]);
  assert.deepEqual(spec.paint, WATER_PAINT);
});

test("removing the inland cover leaves the basemap source alone", () => {
  const map = makeMap();
  addInlandWater(map as never, "fill-anchor");
  removeInlandWater(map as never);

  assert.equal(map.getLayer(INLAND_WATER_ID), undefined);
  assert.ok(map.getSource("openmaptiles"));

  removeInlandWater(map as never);
});

test("no water in the style means no inland cover", () => {
  const map = makeMap();
  (map as { getStyle: () => unknown }).getStyle = () => ({ layers: [] });

  assert.equal(addInlandWater(map as never, "fill-anchor"), false);
  assert.equal(map.getLayer(INLAND_WATER_ID), undefined);
});

test("the ocean copy sits before its anchor in the page colour with an ocean-only filter", () => {
  const map = makeMap(["background", "water", "fill-anchor"]);

  assert.equal(addOceanCover(map as never, "fill-anchor", "#faf8f3"), true);
  assert.deepEqual(map.getLayersOrder(), ["background", "water", OCEAN_COVER_ID, "fill-anchor"]);

  const spec = map.specs.get(OCEAN_COVER_ID)!;

  assert.equal(spec.source, "openmaptiles");
  assert.equal(spec["source-layer"], "water");
  assert.deepEqual(spec.paint, { "fill-color": "#faf8f3", "fill-opacity": 1 });
  assert.deepEqual(spec.filter, ["all", WATER_FILTER, ["==", ["get", "class"], "ocean"]]);
  assert.equal(map.getSource("openmaptiles") !== undefined, true);
  assert.equal(map.addedSources(), 0);
});

test("the ocean copy id keeps the scene clip from filtering it", () => {
  assert.ok(OCEAN_COVER_ID.startsWith("soe-"));
});

test("a second ocean copy adds no layer and no source", () => {
  const map = makeMap(["background", "water", "fill-anchor"]);

  assert.equal(addOceanCover(map as never, "fill-anchor", "#faf8f3"), true);
  assert.equal(addOceanCover(map as never, "fill-anchor", "#faf8f3"), true);
  assert.deepEqual(map.getLayersOrder(), ["background", "water", OCEAN_COVER_ID, "fill-anchor"]);
  assert.equal(map.addedSources(), 0);
});

test("the ocean copy without a basemap filter still paints ocean only", () => {
  const map = makeMap();
  (map as { getStyle: () => unknown }).getStyle = () => ({
    layers: [
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: WATER_PAINT,
      },
    ],
  });

  assert.equal(addOceanCover(map as never, "fill-anchor", "#faf8f3"), true);

  const spec = map.specs.get(OCEAN_COVER_ID)!;

  assert.deepEqual(spec.filter, ["==", ["get", "class"], "ocean"]);
  assert.deepEqual(spec.paint, { "fill-color": "#faf8f3", "fill-opacity": 1 });
});

test("a theme change repaints the ocean copy while a missing layer needs nothing", () => {
  const paints: [string, string, unknown][] = [];
  const map = {
    getLayer: (id: string) => (id === OCEAN_COVER_ID ? {} : undefined),
    setPaintProperty: (id: string, name: string, value: unknown) => {
      paints.push([id, name, value]);
    },
  };

  refreshOceanCover(map as never, "#111111");

  assert.deepEqual(paints, [[OCEAN_COVER_ID, "fill-color", "#111111"]]);

  paints.length = 0;
  const missing = {
    getLayer: () => undefined,
    setPaintProperty: () => {
      throw new Error("a missing ocean copy paints nothing");
    },
  };

  refreshOceanCover(missing as never, "#111111");

  assert.deepEqual(paints, []);
});

test("removing the ocean copy leaves the basemap source alone", () => {
  const map = makeMap();
  addOceanCover(map as never, "fill-anchor", "#faf8f3");
  removeOceanCover(map as never);

  assert.equal(map.getLayer(OCEAN_COVER_ID), undefined);
  assert.ok(map.getSource("openmaptiles"));

  removeOceanCover(map as never);
});

test("no water in the style means no ocean copy", () => {
  const map = makeMap();
  (map as { getStyle: () => unknown }).getStyle = () => ({ layers: [] });

  assert.equal(addOceanCover(map as never, "fill-anchor", "#faf8f3"), false);
  assert.equal(map.getLayer(OCEAN_COVER_ID), undefined);
});
