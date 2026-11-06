import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addGeologyWater,
  GEOLOGY_WATER_ID,
  removeGeologyWater,
} from "./geology-water.ts";

const WATER_PAINT = { "fill-color": "rgb(158,189,255)" };
const WATER_FILTER = ["!=", ["get", "brunnel"], "tunnel"];

function makeMap(layers: string[] = ["background", "water", "fill-anchor"]) {
  const order = [...layers];
  const specs = new Map<string, Record<string, unknown>>();
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
      specs.set(spec.id, spec as Record<string, unknown>);
      const index = beforeId ? order.indexOf(beforeId) : order.length;
      order.splice(index < 0 ? order.length : index, 0, spec.id);
    },
    removeLayer: (id: string) => {
      order.splice(order.indexOf(id), 1);
    },
    removeSource: (_id: string) => {
      throw new Error("the water copy must never remove its source");
    },
    specs,
  };
}

test("the water copy sits between geology and the rest with the basemap paint", () => {
  const map = makeMap(["geology-classes", "fill-anchor", "outline"]);
  assert.equal(addGeologyWater(map as never, "fill-anchor"), true);

  map.addLayer({ id: "cover-classes" } as never, "fill-anchor");
  assert.deepEqual(map.getLayersOrder(), [
    "geology-classes",
    GEOLOGY_WATER_ID,
    "cover-classes",
    "fill-anchor",
    "outline",
  ]);

  const spec = map.specs.get(GEOLOGY_WATER_ID)!;
  assert.equal(spec.source, "openmaptiles");
  assert.equal(spec["source-layer"], "water");
  assert.deepEqual(spec.paint, WATER_PAINT);
  assert.deepEqual(spec.filter, WATER_FILTER);
  assert.equal(map.getSource("openmaptiles") !== undefined, true);
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
