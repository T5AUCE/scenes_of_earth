import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { LayerContext } from "../types";
import {
  isolineInterval,
  isolineLevels,
  toLngLat,
  traceIsolines,
} from "./isolines.ts";

const KENYA_STOPS = [5, 8, 11, 14, 17, 20, 23, 26, 29];

test("the interval keeps a scene at twelve isotherm levels or fewer", () => {
  const spans = [
    [5, 29],
    [-12, 10],
    [0, 50],
    [-30, 20],
    [-60, 60],
    [-100, 100],
  ];

  for (const [low, high] of spans) {
    const interval = isolineInterval([low, high]);
    const levels = isolineLevels(low, high, interval);
    assert.ok(levels.length <= 12, `${low}..${high} gave ${levels.length} levels`);
  }
});

test("the overlay follows the display range and retraces after a change", async () => {
  const { createIsolineOverlay } = await importOverlay();
  const { map, data } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = {
    map,
    layer,
    shift: 0,
    display: { range: [20, 24] },
  } as unknown as LayerContext;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalGetComputedStyle = Object.getOwnPropertyDescriptor(
    globalThis,
    "getComputedStyle",
  );
  Object.assign(globalThis, {
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => "#faf8f3" }),
  });
  try {
    const overlay = createIsolineOverlay(context);
    overlay.setValues([0, 30, 30, 0], 0);
    const initial = overlayLevels(data());
    assert.ok(initial.every((level) => level >= 20 && level <= 24));
    assert.ok(initial.includes(20));
    assert.ok(!initial.includes(6));

    overlay.setRange([10, 14]);
    overlay.setValues([0, 30, 30, 0], 0);
    const changed = overlayLevels(data());
    assert.ok(changed.every((level) => level >= 10 && level <= 14));
    assert.ok(changed.includes(10));
  } finally {
    restoreGlobal("document", originalDocument);
    restoreGlobal("getComputedStyle", originalGetComputedStyle);
  }
});

test("a span at the twelve-level boundary keeps the finer interval", () => {
  const interval = isolineInterval([2, 13]);

  assert.equal(interval, 1);
  assert.equal(isolineLevels(2, 13, interval).length, 12);
});

test("a wide span widens the interval beyond ten degrees", () => {
  assert.equal(isolineInterval([-60, 60]), 20);
});

test("the Kenya span uses two-degree isotherms", () => {
  const interval = isolineInterval(KENYA_STOPS);

  assert.equal(interval, 2);
  assert.deepEqual(isolineLevels(5, 29, interval), [
    6,
    8,
    10,
    12,
    14,
    16,
    18,
    20,
    22,
    24,
    26,
    28,
  ]);
});

test("every level falls on an interval multiple", () => {
  const levels = isolineLevels(-1, 2, 0.5);

  assert.deepEqual(levels, [-1, -0.5, 0, 0.5, 1, 1.5, 2]);
  for (const level of levels) {
    const multiple = level / 0.5;
    assert.ok(Math.abs(multiple - Math.round(multiple)) < 1e-9);
  }
});

test("a cell with a no-data corner produces no segments", () => {
  const values = [1, 0, NaN, 0];

  assert.deepEqual(traceIsolines(values, 2, 2, [0.5]), []);
});

test("adjacent segments chain into one polyline", () => {
  const values = [2, 2, 2, 0, 0, 0];
  const lines = traceIsolines(values, 3, 2, [1]);

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    value: 1,
    coordinates: [[0, 0.5], [1, 0.5], [2, 0.5]],
  });
});

test("an exact-level ridge does not retrace a segment", () => {
  const values = [0, 0, 0, 1, 1, 1, 0, 0, 0];

  assert.deepEqual(traceIsolines(values, 3, 3, [1]), [
    {
      value: 1,
      coordinates: [[0, 1], [1, 1], [2, 1]],
    },
  ]);
});

test("saddle cells resolve consistently", () => {
  const values = [2, 0, 0, 2];
  const first = traceIsolines(values, 2, 2, [1]);
  const second = traceIsolines(values, 2, 2, [1]);

  assert.deepEqual(second, first);
  assert.deepEqual(first.map((line) => line.coordinates), [
    [[0.5, 0], [1, 0.5]],
    [[0.5, 1], [0, 0.5]],
  ]);
});

test("rows map linearly to latitude and take the world shift", () => {
  const grid = { bbox: [34, -5, 42, 5] as [number, number, number, number], nx: 4, ny: 2 };
  const coordinates = toLngLat([[0, 0], [2, 1], [4, 2]], grid, -360);

  assert.deepEqual(coordinates, [
    [-325, 2.5],
    [-321, -2.5],
    [-317, -7.5],
  ]);
  assert.deepEqual(
    toLngLat([[2, 1]], grid, 0),
    [[39, -2.5]],
  );
});

async function importOverlay(): Promise<typeof import("../layers/isolines.ts")> {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.endsWith("/layers/isolines.ts") && specifier.startsWith(".")) {
        return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
      }
      return next(specifier, context);
    },
  });

  return import("../layers/isolines.ts").finally(() => hooks.deregister());
}

function fakeMap() {
  let data: unknown;
  const map = {
    addSource(_id: string, source: { data: unknown }) {
      data = source.data;
    },
    addLayer() {},
    getStyle: () => ({ layers: [] }),
    getSource: () => ({
      setData(next: unknown) {
        data = next;
      },
    }),
    setLayoutProperty() {},
    getLayer: () => ({}),
    removeLayer() {},
    removeSource() {},
  };

  return { map, data: () => data };
}

function overlayLevels(data: unknown) {
  const collection = data as { features: { properties: { label: string } }[] };
  return collection.features.map(({ properties }) => Number.parseFloat(properties.label));
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
