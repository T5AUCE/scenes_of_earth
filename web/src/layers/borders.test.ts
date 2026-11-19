import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutlineState } from "../display-state.ts";
import type { Scene } from "../types.ts";
import {
  addBorders,
  applyBorders,
  BORDER_DISPUTED_ID,
  BORDER_LAYER_IDS,
  BORDER_LINE_ID,
  BORDER_LOW_ID,
  borderCopyMounted,
  removeBorders,
} from "./borders.ts";

const OUTLINE: OutlineState = { shown: true, color: "white", widthPx: 2 };
const AREA = {
  bbox: [0, 0, 1, 1],
  geometry_href: "area.geojson",
  borders_href: "borders.geojson",
  border_level: 6,
  border_min_zoom: 9,
  clipped_to_coverage: true,
} as Scene["area"];

test("the border copies reuse the basemap boundary from the area's switch zoom", () => {
  const map = makeMap();

  assert.equal(addBorders(map as never, AREA, OUTLINE, "soe-area-outline", "outline-anchor"), true);

  const line = map.specs.get(BORDER_LINE_ID)!;
  const disputed = map.specs.get(BORDER_DISPUTED_ID)!;
  const low = map.specs.get(BORDER_LOW_ID)!;

  assert.equal(line.source, "openmaptiles");
  assert.equal(line["source-layer"], "boundary");
  assert.equal(line.minzoom, 9);
  assert.equal(line.maxzoom, undefined);
  assert.deepEqual(line.filter, [
    "all",
    ["<=", ["get", "admin_level"], 6],
    ["!=", ["get", "maritime"], 1],
    ["!=", ["get", "disputed"], 1],
  ]);

  assert.equal(disputed.source, "openmaptiles");
  assert.equal(disputed.minzoom, 9);
  assert.deepEqual(disputed.filter, [
    "all",
    ["<=", ["get", "admin_level"], 6],
    ["!=", ["get", "maritime"], 1],
    ["==", ["get", "disputed"], 1],
  ]);

  assert.equal(low.source, "soe-area-outline");
  assert.equal(low["source-layer"], undefined);
  assert.equal(low.minzoom, undefined);
  assert.equal(low.maxzoom, 9);
  assert.equal(low.filter, undefined);
});

test("every admin level filters its own lines and switches at the given zoom", () => {
  for (const [level, minZoom] of [
    [4, 5],
    [6, 9],
    [8, 11],
    [10, 12],
  ]) {
    const map = makeMap();
    const area = withArea({ border_level: level, border_min_zoom: minZoom });

    assert.equal(addBorders(map as never, area, OUTLINE, "soe-area-outline", undefined), true);

    for (const id of [BORDER_LINE_ID, BORDER_DISPUTED_ID]) {
      const spec = map.specs.get(id)!;
      const filter = spec.filter as unknown[];

      assert.deepEqual(filter[1], ["<=", ["get", "admin_level"], level]);
      assert.equal(spec.minzoom, minZoom);
    }

    assert.equal(map.specs.get(BORDER_LOW_ID)!.maxzoom, minZoom);
  }
});

test("the copies paint at twice the outline width with Liberty's disputed dashes", () => {
  const map = makeMap();

  addBorders(map as never, AREA, { ...OUTLINE, widthPx: 1.5 }, "soe-area-outline", undefined);

  const linePaint = map.specs.get(BORDER_LINE_ID)!.paint as Record<string, unknown>;
  const disputedPaint = map.specs.get(BORDER_DISPUTED_ID)!.paint as Record<string, unknown>;
  const lowPaint = map.specs.get(BORDER_LOW_ID)!.paint as Record<string, unknown>;
  const lowDashes = lowPaint["line-dasharray"] as unknown[];

  assert.deepEqual(linePaint, { "line-color": "#ffffff", "line-width": 3, "line-opacity": 1 });
  assert.deepEqual(disputedPaint["line-dasharray"], [0.5, 1]);
  assert.deepEqual(lowDashes, [
    "case",
    ["==", ["get", "disputed"], true],
    ["literal", [0.5, 1]],
    ["literal", [1, 0]],
  ]);

  // The bundle writes disputed as a boolean, so the low layer must dash boolean features.
  assert.deepEqual(dashFor(lowDashes, { disputed: true }), [0.5, 1]);
  assert.deepEqual(dashFor(lowDashes, { disputed: false }), [1, 0]);
});

test("an outline change repaints all three copies", () => {
  const map = makeMap();

  addBorders(map as never, AREA, OUTLINE, "soe-area-outline", undefined);
  applyBorders(map as never, { shown: false, color: "#123456", widthPx: 3 });

  for (const id of BORDER_LAYER_IDS) {
    assert.deepEqual(map.layouts.get(id)?.at(-1), ["visibility", "none"]);
    assert.deepEqual(map.paints.get(id)?.slice(-2), [
      ["line-color", "#123456"],
      ["line-width", 6],
    ]);
  }
});

test("a second add repaints the mounted copies instead of doubling them", () => {
  const map = makeMap();
  const added: string[] = [];
  const addLayer = map.addLayer;

  map.addLayer = (spec: { id: string }, beforeId?: string) => {
    added.push(spec.id);
    addLayer(spec, beforeId);
  };

  addBorders(map as never, AREA, OUTLINE, "soe-area-outline", undefined);
  assert.equal(
    addBorders(map as never, AREA, { ...OUTLINE, widthPx: 3 }, "soe-area-outline", undefined),
    true,
  );

  assert.deepEqual(added, BORDER_LAYER_IDS);
  assert.deepEqual(map.paints.get(BORDER_LINE_ID)?.at(-1), ["line-width", 6]);
});

test("a drawn area without a border level keeps the fallback outline", () => {
  for (const area of [
    withArea({ border_level: null, border_min_zoom: null }),
    withArea({ border_level: undefined }),
    withArea({ border_min_zoom: undefined }),
    withArea({ borders_href: undefined }),
  ]) {
    const map = makeMap();

    assert.equal(addBorders(map as never, area, OUTLINE, "soe-area-outline", undefined), false);
    assert.deepEqual(map.specs.size, 0);
  }
});

test("a style without a boundary line keeps the fallback outline", () => {
  const map = makeMap({ boundary: false });

  assert.equal(addBorders(map as never, AREA, OUTLINE, "soe-area-outline", undefined), false);
  assert.deepEqual(map.specs.size, 0);
});

test("a style that cannot be read keeps the fallback outline", () => {
  const map = makeMap();
  map.getStyle = () => {
    throw new Error("style unavailable");
  };

  assert.equal(addBorders(map as never, AREA, OUTLINE, "soe-area-outline", undefined), false);
  assert.deepEqual(map.specs.size, 0);
});

test("the copy stacks in its own order and the mount check follows it", () => {
  const map = makeMap();

  assert.equal(borderCopyMounted(map as never), false);
  addBorders(map as never, AREA, OUTLINE, "soe-area-outline", "outline-anchor");

  assert.equal(borderCopyMounted(map as never), true);
  assert.deepEqual(
    map.order.filter((id) => id !== "boundary_2"),
    ["background", BORDER_LOW_ID, BORDER_LINE_ID, BORDER_DISPUTED_ID, "outline-anchor"],
  );
});

test("removing the copies leaves the basemap source and its layers alone", () => {
  const map = makeMap();

  addBorders(map as never, AREA, OUTLINE, "soe-area-outline", undefined);
  removeBorders(map as never);
  removeBorders(map as never);

  assert.deepEqual(map.order, ["background", "boundary_2", "outline-anchor"]);
  assert.deepEqual(map.specs.size, 0);
  assert.ok(map.getLayer("boundary_2"));
});

function makeMap({ boundary = true } = {}) {
  const order = boundary
    ? ["background", "boundary_2", "outline-anchor"]
    : ["background", "outline-anchor"];
  const specs = new Map<string, Record<string, unknown>>();
  const paints = new Map<string, [string, unknown][]>();
  const layouts = new Map<string, [string, unknown][]>();

  return {
    order,
    specs,
    paints,
    layouts,
    getStyle: () => ({
      layers: [
        ...(boundary
          ? [
              {
                id: "boundary_2",
                type: "line",
                source: "openmaptiles",
                "source-layer": "boundary",
                filter: ["!=", ["get", "brunnel"], "tunnel"],
              },
            ]
          : []),
        { id: "outline-anchor", type: "line" },
      ],
    }),
    getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
    addLayer: (spec: Record<string, unknown> & { id: string }, beforeId?: string) => {
      specs.set(spec.id, spec);
      place(order, spec.id, beforeId);
    },
    removeLayer: (id: string) => {
      const index = order.indexOf(id);
      if (index >= 0) order.splice(index, 1);
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

function place(order: string[], id: string, beforeId?: string) {
  const at = order.indexOf(id);

  if (at >= 0) order.splice(at, 1);

  const anchor = beforeId === undefined ? order.length : order.indexOf(beforeId);
  order.splice(anchor < 0 ? order.length : anchor, 0, id);
}

function withArea(patch: Partial<Scene["area"]>): Scene["area"] {
  return { ...AREA, ...patch };
}

function dashFor(expression: unknown[], properties: Record<string, unknown>): unknown {
  const [, condition, whenTrue, whenFalse] = expression as [
    unknown,
    [string, [string, string], unknown],
    unknown[],
    unknown[],
  ];
  const [operator, left, right] = condition;

  if (operator !== "==" || left[0] !== "get") throw new Error("unsupported dash condition");

  const chosen = properties[left[1]] === right ? whenTrue : whenFalse;

  return chosen[1];
}
