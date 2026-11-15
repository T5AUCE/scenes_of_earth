import assert from "node:assert/strict";
import { test } from "node:test";

import { addGeologyWater, GEOLOGY_WATER_ID, removeGeologyWater } from "./geology-water.ts";

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

test("the water copy sits above geology and land cover with the basemap paint", () => {
  const map = makeMap(["geology-classes", "cover-classes", "fill-anchor", "outline"]);

  assert.equal(addGeologyWater(map as never, "fill-anchor"), true);

  assert.deepEqual(map.getLayersOrder(), [
    "geology-classes",
    "cover-classes",
    GEOLOGY_WATER_ID,
    "fill-anchor",
    "outline",
  ]);

  const spec = map.specs.get(GEOLOGY_WATER_ID)!;

  assert.equal(spec.source, "openmaptiles");
  assert.equal(spec["source-layer"], "water");
  assert.deepEqual(spec.paint, WATER_PAINT);
  assert.deepEqual(spec.filter, WATER_FILTER);
  assert.equal(map.getSource("openmaptiles") !== undefined, true);
  assert.equal(map.addedSources(), 0);
});

test("the water copy sits above geology alone and above land cover alone", () => {
  const geologyOnly = makeMap(["geology-classes", "fill-anchor"]);

  assert.equal(addGeologyWater(geologyOnly as never, "fill-anchor"), true);
  assert.deepEqual(geologyOnly.getLayersOrder(), [
    "geology-classes",
    GEOLOGY_WATER_ID,
    "fill-anchor",
  ]);
  assert.equal(geologyOnly.addedSources(), 0);

  const coverOnly = makeMap(["cover-classes", "fill-anchor"]);

  assert.equal(addGeologyWater(coverOnly as never, "fill-anchor"), true);
  assert.deepEqual(coverOnly.getLayersOrder(), ["cover-classes", GEOLOGY_WATER_ID, "fill-anchor"]);
  assert.equal(coverOnly.addedSources(), 0);
});

test("a second water copy adds no layer and no source", () => {
  const map = makeMap(["geology-classes", "cover-classes", "fill-anchor"]);

  assert.equal(addGeologyWater(map as never, "fill-anchor"), true);
  assert.equal(addGeologyWater(map as never, "fill-anchor"), true);
  assert.deepEqual(map.getLayersOrder(), [
    "geology-classes",
    "cover-classes",
    GEOLOGY_WATER_ID,
    "fill-anchor",
  ]);
  assert.equal(map.addedSources(), 0);
});

test("the water copy reuses the basemap water so islands and outside water stay visible", () => {
  const map = makeMap(["cover-classes", "fill-anchor"]);

  assert.equal(addGeologyWater(map as never, "fill-anchor"), true);

  const spec = map.specs.get(GEOLOGY_WATER_ID)!;

  // The copy paints only basemap water so islands and outside WorldCover water stay visible.
  assert.equal(spec["source-layer"], "water");
  assert.deepEqual(spec.filter, WATER_FILTER);
  assert.deepEqual(spec.paint, WATER_PAINT);
  assert.ok(
    map.getLayersOrder().indexOf(GEOLOGY_WATER_ID) > map.getLayersOrder().indexOf("cover-classes"),
  );
});

test("removing the water copy leaves the basemap source alone", () => {
  const map = makeMap();
  addGeologyWater(map as never, "fill-anchor");
  removeGeologyWater(map as never);

  assert.equal(map.getLayer(GEOLOGY_WATER_ID), undefined);
  assert.ok(map.getSource("openmaptiles"));

  removeGeologyWater(map as never);
});

test("no water in the style means no copy", () => {
  const map = makeMap();
  (map as { getStyle: () => unknown }).getStyle = () => ({ layers: [] });

  assert.equal(addGeologyWater(map as never, "fill-anchor"), false);
  assert.equal(map.getLayer(GEOLOGY_WATER_ID), undefined);
});
