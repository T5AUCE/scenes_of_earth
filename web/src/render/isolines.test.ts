import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import type { GridDoc, LayerContext } from "../types";
import {
  ISOTHERM_CASING_RATIO,
  ISOTHERM_DASH_PATTERN,
  type Isoline,
  isolineInterval,
  isolineLevels,
  toLngLat,
  traceIsolines,
} from "./isolines.ts";
import { inkPaint } from "./palettes.ts";

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
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
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
});

test("the overlay defaults to smooth tracing and caches each step and mode", async () => {
  const { createIsolineOverlay } = await importOverlay();
  const { map, data } = fakeMap();
  const grid = {
    bbox: [0, 0, 1, 1] as [number, number, number, number],
    nx: 3,
    ny: 3,
    res: 1,
  };
  const layer = { id: "temperature", grid, style: { stops: KENYA_STOPS } };
  const range: [number, number] = [20, 24];
  const context = {
    map,
    layer,
    shift: 0,
    display: { range },
  } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  const values = [0, 30, 0, 30, 0, 30, 0, 30, 0];
  const counted = countingValues(values);
  const levels = isolineLevels(range[0], range[1], isolineInterval(range));
  const expectedSmooth = tracedCoordinates(values, grid, levels, true);
  const expectedRaw = tracedCoordinates(values, grid, levels, false);

  overlay.setValues(counted.values, 0);
  const smoothReads = counted.reads();
  assert.ok(smoothReads > 0);
  assert.deepEqual(overlayCoordinates(data()), expectedSmooth);
  assert.notDeepEqual(overlayCoordinates(data()), expectedRaw);

  overlay.setValues(counted.values, 0);
  assert.equal(counted.reads(), smoothReads);

  overlay.setSmooth(false);
  overlay.setValues(counted.values, 0);
  const rawReads = counted.reads();
  assert.ok(rawReads > smoothReads);
  assert.deepEqual(overlayCoordinates(data()), expectedRaw);

  overlay.setSmooth(true);
  overlay.setValues(counted.values, 0);
  assert.equal(counted.reads(), rawReads);
  assert.deepEqual(overlayCoordinates(data()), expectedSmooth);

  overlay.setValues(counted.values, 1);
  assert.ok(counted.reads() > rawReads);
});

test("changing the display interval retraces the same step", async () => {
  const { createIsolineOverlay } = await importOverlay();
  const { map, data } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 3, ny: 3, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = {
    map,
    layer,
    shift: 0,
    display: { range: [20, 24] },
  } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  const counted = countingValues([0, 30, 0, 30, 0, 30, 0, 30, 0]);

  overlay.setValues(counted.values, 0);
  const initialReads = counted.reads();
  const initial = overlayLevels(data());
  const initialInterval = overlay.interval;

  overlay.setRange([10, 30]);
  overlay.setValues(counted.values, 0);
  const changed = overlayLevels(data());

  assert.equal(initialInterval, 0.5);
  assert.equal(overlay.interval, 2);
  assert.ok(counted.reads() > initialReads);
  assert.ok(initial.every((level) => level >= 20 && level <= 24));
  assert.ok(changed.every((level) => level >= 10 && level <= 30 && level % 2 === 0));
  assert.ok(changed.includes(10));
});

test("the isotherm overlays validate in MapLibre", async () => {
  const { createIsolineOverlay } = await importOverlay();
  const { map, layers, sources } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = { map, layer, shift: 0, display: null } as unknown as LayerContext;
  createIsolineOverlay(context, inkPaint("charcoal"));
  const errors = validateStyleMin({
    version: 8,
    glyphs: "https://example.test/{fontstack}/{range}.pbf",
    sources: {
      basemap: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      ...Object.fromEntries(sources),
    },
    layers,
  });

  assert.deepEqual(errors.map((error) => error.message), []);
});

test("changing the ink repaints the lines, casing and labels with the matching halo", async () => {
  const { createIsolineOverlay } = await importOverlay();
  const { map, layers } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = { map, layer, shift: 0, display: null } as unknown as LayerContext;
  const overlay = createIsolineOverlay(context, inkPaint("charcoal"));
  const paintOf = (suffix: string) => layers.find(({ id }) => id.endsWith(suffix))!.paint!;

  assert.equal(paintOf("-lines")["line-color"], "rgb(49, 63, 77)");
  assert.equal(paintOf("-casing")["line-color"], "rgb(246, 239, 227)");

  overlay.setInk(inkPaint("white"));

  assert.equal(paintOf("-lines")["line-color"], "rgb(255, 255, 255)");
  assert.equal(paintOf("-casing")["line-color"], "rgb(31, 31, 31)");
  assert.equal(paintOf("-labels")["text-halo-color"], "rgb(31, 31, 31)");
});

test("the casing dashes line up with the isotherms in screen pixels at every zoom", async () => {
  const { createIsolineOverlay } = await importOverlay();
  const { map, layers } = fakeMap();
  const layer = {
    id: "temperature",
    grid: { bbox: [0, 0, 1, 1], nx: 2, ny: 2, res: 1 },
    style: { stops: KENYA_STOPS },
  };
  const context = { map, layer, shift: 0, display: null } as unknown as LayerContext;
  createIsolineOverlay(context, inkPaint("charcoal"));
  const paintOf = (suffix: string) => layers.find(({ id }) => id.endsWith(suffix))!.paint!;
  const line = paintOf("-lines");
  const casing = paintOf("-casing");
  const lineDashes = line["line-dasharray"] as number[];
  const casingDashes = casing["line-dasharray"] as number[];

  assert.deepEqual(lineDashes, ISOTHERM_DASH_PATTERN);
  for (const zoom of [0, 5, 8, 14, 18, 22]) {
    for (const isBold of [false, true]) {
      const linePx = widthAt(line["line-width"] as unknown[], zoom, isBold);
      const casingPx = widthAt(casing["line-width"] as unknown[], zoom, isBold);
      assert.ok(approximately(casingPx, linePx * ISOTHERM_CASING_RATIO), `${zoom} width`);

      const lineDashPx = lineDashes.map((length) => length * linePx);
      const casingDashPx = casingDashes.map((length) => length * casingPx);
      lineDashPx.forEach((length, index) => {
        assert.ok(approximately(casingDashPx[index], length), `${zoom} dash ${index}`);
      });
    }
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
    coordinates: [
      [0, 0.5],
      [1, 0.5],
      [2, 0.5],
    ],
  });
});

test("an exact-level ridge does not retrace a segment", () => {
  const values = [0, 0, 0, 1, 1, 1, 0, 0, 0];

  assert.deepEqual(traceIsolines(values, 3, 3, [1]), [
    {
      value: 1,
      coordinates: [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
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

test("saddle pairings follow the bilinear saddle value on both sides", () => {
  const case5 = [4, 0, 0, 2];
  const case10 = [0, 4, 2, 0];

  assert.deepEqual(edgePairs(traceIsolines(case5, 2, 2, [1.2])), [
    ["bottom", "left"],
    ["right", "top"],
  ]);
  assert.deepEqual(edgePairs(traceIsolines(case5, 2, 2, [1.4])), [
    ["bottom", "right"],
    ["left", "top"],
  ]);
  assert.deepEqual(edgePairs(traceIsolines(case10, 2, 2, [1.2])), [
    ["bottom", "right"],
    ["left", "top"],
  ]);
  assert.deepEqual(edgePairs(traceIsolines(case10, 2, 2, [1.4])), [
    ["bottom", "left"],
    ["right", "top"],
  ]);
});

test("refinement off keeps the native marching-squares output", () => {
  const values = [2, 2, 2, 0, 0, 0];

  assert.deepEqual(traceIsolines(values, 3, 2, [1], false), [
    {
      value: 1,
      coordinates: [
        [0, 0.5],
        [1, 0.5],
        [2, 0.5],
      ],
    },
  ]);
  assert.deepEqual(
    traceIsolines(values, 3, 2, [1]),
    traceIsolines(values, 3, 2, [1], false),
  );
});

test("refined vertices lie on the native bilinear surface", () => {
  const nx = 3;
  const values = [0, 0, 0, 0, 2, 0, 0, 0, 0];
  const level = 1;
  const native = traceIsolines(values, nx, 3, [level]);
  const lines = traceIsolines(values, nx, 3, [level], true);

  assert.ok(lines.length > 0);
  assert.ok(lines[0].coordinates.length > native[0].coordinates.length);
  for (const line of lines) {
    for (const point of line.coordinates) {
      assert.ok(Math.abs(bilinearAt(values, nx, point) - level) < 1e-9);
      assert.ok(point[0] >= 0 && point[0] <= nx - 1);
      assert.ok(point[1] >= 0 && point[1] <= 2);
    }
  }
});

test("refined chords stay within the midpoint error bound", () => {
  const values = [20, 28, 28, 20];
  const level = 21;
  const lines = traceIsolines(values, 2, 2, [level], true);

  assert.ok(lines.length > 0);
  for (const { coordinates } of lines) {
    for (let index = 1; index < coordinates.length; index++) {
      for (const along of [0.25, 0.5, 0.75]) {
        const point = alongSegment(coordinates[index - 1], coordinates[index], along);
        const error = Math.abs(bilinearAt(values, 2, point) - level);
        assert.ok(error <= 0.05 + 1e-6, `${along} along a chord gave ${error}`);
      }
    }
  }
});

test("refined lines never enter a quad with a no-data corner", () => {
  const nx = 4;
  const ny = 3;
  const values = [
    0,
    1,
    2,
    3,
    1,
    2,
    NaN,
    4,
    2,
    3,
    4,
    5,
  ];
  const lines = traceIsolines(values, nx, ny, [2.5], true);

  assert.ok(lines.length > 0);
  assert.ok(lines.some(({ coordinates }) =>
    coordinates.some(([x]) => Math.abs(x - 1) < 1e-9),
  ));
  const noDataCells = cellsWithNoData(values, nx, ny);
  for (const { coordinates } of lines) {
    for (let index = 1; index < coordinates.length; index++) {
      for (const along of [0.25, 0.5, 0.75]) {
        const point = alongSegment(coordinates[index - 1], coordinates[index], along);
        assert.ok(!noDataCells.some(([column, row]) => insideCell(point, column, row)));
      }
    }
  }
});

test("refined lines of adjacent levels never cross", () => {
  const nx = 5;
  const values = [
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
    0,
    4,
  ];
  const lines = traceIsolines(values, nx, 5, [1.2, 2.2], true);
  const segments = lines.flatMap(({ value, coordinates }) =>
    coordinates.slice(1).map((end, index) => ({
      value,
      start: coordinates[index],
      end,
    })),
  );
  const crossings = segments.flatMap((left, index) =>
    segments.slice(index + 1).filter(
      (right) => right.value !== left.value && segmentsCross(left, right),
    ),
  );

  assert.ok(segments.length > 0);
  assert.deepEqual(crossings, []);
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

interface TestSegment {
  value: number;
  start: [number, number];
  end: [number, number];
}

function edgePairs(lines: readonly Isoline[]): string[][] {
  const pairs = lines.flatMap(({ coordinates }) =>
    coordinates.slice(1).map((end, index) => {
      const start = coordinates[index];
      return [edgeName(start), edgeName(end)].sort();
    }),
  );
  return pairs.sort((left, right) => left.join().localeCompare(right.join()));
}

function edgeName([x, y]: [number, number]): string {
  if (y === 0) return "top";
  if (x === 1) return "right";
  if (y === 1) return "bottom";
  if (x === 0) return "left";

  throw new Error(`Point ${x},${y} is not on a cell edge`);
}

function bilinearAt(
  values: ArrayLike<number>,
  nx: number,
  [x, y]: [number, number],
): number {
  const ny = values.length / nx;
  const column = Math.min(Math.floor(x), nx - 2);
  const row = Math.min(Math.floor(y), ny - 2);
  const top = row * nx + column;
  const across = x - column;
  const down = y - row;
  const topValue = values[top] + (values[top + 1] - values[top]) * across;
  const bottomValue = values[top + nx] + (values[top + nx + 1] - values[top + nx]) * across;

  return topValue + (bottomValue - topValue) * down;
}

function cellsWithNoData(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
): [number, number][] {
  const cells: [number, number][] = [];
  for (let row = 0; row + 1 < ny; row++) {
    for (let column = 0; column + 1 < nx; column++) {
      const top = row * nx + column;
      const corners = [values[top], values[top + 1], values[top + nx], values[top + nx + 1]];
      if (corners.some((value) => !Number.isFinite(value))) {
        cells.push([column, row]);
      }
    }
  }
  return cells;
}

function insideCell([x, y]: [number, number], column: number, row: number): boolean {
  return x > column && x < column + 1 && y > row && y < row + 1;
}

function alongSegment(
  start: [number, number],
  end: [number, number],
  along: number,
): [number, number] {
  return [start[0] + (end[0] - start[0]) * along, start[1] + (end[1] - start[1]) * along];
}

function segmentsCross(left: TestSegment, right: TestSegment): boolean {
  const tolerance = 1e-12;
  const leftStart = orientation(left.start, left.end, right.start);
  const leftEnd = orientation(left.start, left.end, right.end);
  const rightStart = orientation(right.start, right.end, left.start);
  const rightEnd = orientation(right.start, right.end, left.end);

  return leftStart * leftEnd < -tolerance && rightStart * rightEnd < -tolerance;
}

function orientation(
  start: [number, number],
  end: [number, number],
  point: [number, number],
): number {
  return (end[0] - start[0]) * (point[1] - start[1])
    - (end[1] - start[1]) * (point[0] - start[0]);
}

function widthAt(expression: readonly unknown[], zoom: number, isBold: boolean): number {
  const stops: [number, number][] = [];
  for (let index = 3; index < expression.length; index += 2) {
    const branch = expression[index + 1] as readonly unknown[];
    stops.push([Number(expression[index]), Number(isBold ? branch[2] : branch[3])]);
  }

  if (zoom <= stops[0][0]) return stops[0][1];
  for (let index = 1; index < stops.length; index++) {
    const [lowZoom, lowWidth] = stops[index - 1];
    const [highZoom, highWidth] = stops[index];
    if (zoom <= highZoom) {
      const along = (zoom - lowZoom) / (highZoom - lowZoom);
      return lowWidth + (highWidth - lowWidth) * along;
    }
  }

  return stops[stops.length - 1][1];
}

function approximately(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

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
  const layers: { id: string; paint?: Record<string, unknown> }[] = [];
  const sources = new Map<string, unknown>();
  const map = {
    addSource(id: string, source: { data: unknown }) {
      data = source.data;
      sources.set(id, source);
    },
    addLayer(layer: { id: string; paint?: Record<string, unknown> }) {
      layers.push(layer);
    },
    getStyle: () => ({ layers: [] }),
    getSource: () => ({
      setData(next: unknown) {
        data = next;
      },
    }),
    setLayoutProperty() {},
    setPaintProperty(id: string, name: string, value: unknown) {
      layers.find((layer) => layer.id === id)!.paint![name] = value;
    },
    getLayer: () => ({}),
    removeLayer() {},
    removeSource() {},
  };

  return { map, layers, sources, data: () => data };
}

function overlayLevels(data: unknown) {
  const collection = data as { features: { properties: { label: string } }[] };
  return collection.features.map(({ properties }) => Number.parseFloat(properties.label));
}

function overlayCoordinates(data: unknown): [number, number][][] {
  const collection = data as {
    features: { geometry: { coordinates: [number, number][] } }[];
  };
  return collection.features.map(({ geometry }) => geometry.coordinates);
}

function tracedCoordinates(
  values: readonly number[],
  grid: Pick<GridDoc, "bbox" | "nx" | "ny">,
  levels: readonly number[],
  refine: boolean,
): [number, number][][] {
  return traceIsolines(values, grid.nx, grid.ny, levels, refine)
    .map(({ coordinates }) => toLngLat(coordinates, grid, 0));
}

function countingValues(values: readonly number[]) {
  let reads = 0;
  const counted = new Proxy([...values], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });

  return { values: counted as ArrayLike<number>, reads: () => reads };
}
