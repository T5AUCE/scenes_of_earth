import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutlineState } from "../display-state.ts";
import { outlineWidthRamp } from "../display-state.ts";
import type { AreaFeature } from "../types.ts";
import {
  addBorders,
  applyBorders,
  BORDER_DISPUTED_ID,
  BORDER_LAYER_IDS,
  BORDER_LINE_ID,
  BORDER_SOURCE_ID,
  borderLines,
  bordersMounted,
  removeBorders,
} from "./borders.ts";

const OUTLINE: OutlineState = { shown: true, color: "white", widthPx: 2 };

// Ring 0 is polygon 0's exterior, ring 1 its hole, and ring 2 is polygon 1's exterior.
const FIRST_EXTERIOR = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const FIRST_HOLE = [
  [2, 2],
  [2, 4],
  [4, 4],
  [4, 2],
  [2, 2],
];
const SECOND_EXTERIOR = [
  [20, 0],
  [30, 0],
  [30, 10],
  [20, 10],
  [20, 0],
];

test("runs slice the right ring of a multi-polygon with holes", () => {
  const lines = borderLines(
    landFeature([
      [0, 1, 2, 0],
      [1, 0, 2, 0],
      [2, 2, 4, 0],
    ]),
    0,
  )!;

  assert.deepEqual(
    lines.features.map((feature) => feature.geometry.coordinates),
    [
      [
        [10, 0],
        [10, 10],
      ],
      [
        [2, 2],
        [2, 4],
        [4, 4],
      ],
      [
        [30, 10],
        [20, 10],
        [20, 0],
      ],
    ],
  );
});

test("runs meeting at the ring start join into one line", () => {
  const lines = borderLines(
    landFeature([
      [0, 0, 1, 0],
      [0, 3, 4, 0],
    ]),
    0,
  )!;

  assert.equal(lines.features.length, 1);
  assert.deepEqual(lines.features[0].geometry.coordinates, [
    [0, 10],
    [0, 0],
    [10, 0],
  ]);
});

test("runs meeting at a concave ring start join into one line", () => {
  const concave: AreaFeature = {
    type: "Feature",
    properties: {
      border_runs: [
        [0, 0, 1, 0],
        [0, 5, 6, 0],
      ],
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [5, 5],
          [5, 10],
          [0, 10],
          [0, 0],
          [10, 0],
          [10, 5],
          [5, 5],
        ],
      ],
    },
  };
  const lines = borderLines(concave, 0)!;

  assert.equal(lines.features.length, 1);
  assert.deepEqual(lines.features[0].geometry.coordinates, [
    [10, 5],
    [5, 5],
    [5, 10],
  ]);
});

test("runs of different kinds meeting at the ring start stay separate", () => {
  const lines = borderLines(
    landFeature([
      [0, 0, 1, 0],
      [0, 3, 4, 1],
    ]),
    0,
  )!;

  assert.equal(lines.features.length, 2);
  assert.deepEqual(
    lines.features.map((feature) => feature.properties.disputed),
    [0, 1],
  );
});

test("disputed runs carry the flag that the dashed layer filters on", () => {
  const lines = borderLines(
    landFeature([
      [0, 0, 1, 0],
      [0, 1, 2, 1],
    ]),
    0,
  )!;

  assert.deepEqual(
    lines.features.map((feature) => feature.properties.disputed),
    [0, 1],
  );
});

test("the antimeridian shift moves the sliced vertices like the mask rings", () => {
  const lines = borderLines(landFeature([[2, 0, 1, 0]]), -360)!;

  assert.deepEqual(lines.features[0].geometry.coordinates, [
    [-340, 0],
    [-330, 0],
  ]);
});

test("a scene without runs has no border lines and an empty list has none to draw", () => {
  assert.equal(borderLines(landFeature(undefined), 0), null);
  assert.deepEqual(borderLines(landFeature([]), 0)!.features, []);
});

test("a run that points outside its ring is skipped", () => {
  const lines = borderLines(
    landFeature([
      [9, 0, 1, 0],
      [0, 4, 4, 0],
      [0, 0, 1, 0],
    ]),
    0,
  )!;

  assert.equal(lines.features.length, 1);
});

test("the lines draw from one unsimplified source with a dashed disputed layer", () => {
  const map = makeMap();
  const lines = borderLines(landFeature([[0, 0, 1, 0]]), 0)!;

  addBorders(map as never, lines, { ...OUTLINE, widthPx: 1.5 }, "outline");

  assert.deepEqual(map.sources.get(BORDER_SOURCE_ID), {
    type: "geojson",
    data: lines,
    tolerance: 0,
  });
  assert.deepEqual(map.specs.get(BORDER_LINE_ID)!.filter, ["!=", ["get", "disputed"], 1]);
  assert.deepEqual(map.specs.get(BORDER_DISPUTED_ID)!.filter, ["==", ["get", "disputed"], 1]);
  assert.deepEqual(map.specs.get(BORDER_DISPUTED_ID)!.paint, { "line-dasharray": [0.5, 1] });
  assert.deepEqual(map.order, ["background", BORDER_LINE_ID, BORDER_DISPUTED_ID, "outline"]);
  assert.deepEqual(map.paints.get(BORDER_LINE_ID)?.slice(-3), [
    ["line-color", "#ffffff"],
    ["line-width", outlineWidthRamp(1.5, 2)],
    ["line-opacity", 1],
  ]);
});

test("an outline change repaints both border lines", () => {
  const map = makeMap();

  addBorders(map as never, borderLines(landFeature([]), 0)!, OUTLINE, "outline");
  applyBorders(map as never, { shown: false, color: "#123456", widthPx: 3 });

  for (const id of BORDER_LAYER_IDS) {
    assert.deepEqual(map.layouts.get(id)?.at(-1), ["visibility", "none"]);
    assert.deepEqual(map.paints.get(id)?.slice(-3), [
      ["line-color", "#123456"],
      ["line-width", outlineWidthRamp(3, 2)],
      ["line-opacity", 1],
    ]);
  }
});

test("a second add repaints the mounted lines instead of doubling them", () => {
  const map = makeMap();
  const lines = borderLines(landFeature([]), 0)!;

  addBorders(map as never, lines, OUTLINE, "outline");
  addBorders(map as never, lines, { ...OUTLINE, widthPx: 3 }, "outline");

  assert.deepEqual(map.order, ["background", BORDER_LINE_ID, BORDER_DISPUTED_ID, "outline"]);
  assert.deepEqual(map.paints.get(BORDER_LINE_ID)?.at(-2), ["line-width", outlineWidthRamp(3, 2)]);
});

test("the mount check follows the lines and removal drops the source too", () => {
  const map = makeMap();

  assert.equal(bordersMounted(map as never), false);
  addBorders(map as never, borderLines(landFeature([]), 0)!, OUTLINE, "outline");
  assert.equal(bordersMounted(map as never), true);

  removeBorders(map as never);
  removeBorders(map as never);

  assert.equal(bordersMounted(map as never), false);
  assert.deepEqual(map.order, ["background", "outline"]);
  assert.equal(map.sources.size, 0);
});

function landFeature(runs: number[][] | undefined): AreaFeature {
  return {
    type: "Feature",
    properties: runs ? { border_runs: runs } : {},
    geometry: {
      type: "MultiPolygon",
      coordinates: [[FIRST_EXTERIOR, FIRST_HOLE], [SECOND_EXTERIOR]],
    },
  };
}

function makeMap() {
  const order = ["background", "outline"];
  const specs = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, unknown>();
  const paints = new Map<string, [string, unknown][]>();
  const layouts = new Map<string, [string, unknown][]>();

  return {
    order,
    specs,
    sources,
    paints,
    layouts,
    getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, source: unknown) => {
      sources.set(id, source);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    addLayer: (spec: Record<string, unknown> & { id: string }, beforeId?: string) => {
      specs.set(spec.id, spec);
      order.splice(beforeId === undefined ? order.length : order.indexOf(beforeId), 0, spec.id);
    },
    removeLayer: (id: string) => {
      order.splice(order.indexOf(id), 1);
      specs.delete(id);
    },
    setPaintProperty: (id: string, name: string, value: unknown) => {
      paints.set(id, [...(paints.get(id) ?? []), [name, value]]);
    },
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      layouts.set(id, [...(layouts.get(id) ?? []), [name, value]]);
    },
  };
}
