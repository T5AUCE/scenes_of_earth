import assert from "node:assert/strict";
import { test } from "node:test";

import {
  areaKm2,
  creditEntries,
  extraCreditLines,
  formatCellSize,
  noticeCount,
} from "./scene-info.ts";
import type { Scene } from "./types.ts";

const KILOMETERS_PER_DEGREE = 111.32;
const AREA_TOLERANCE_KM2 = 1e-6;

function makeScene(overrides: Partial<Scene["area"]> = {}) {
  const source = { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" };

  return {
    area: {
      boundary: null,
      bbox: [0, -1, 1, 1],
      geometry_href: "area.geojson",
      clipped_to_coverage: false,
      ...overrides,
    },
    layers: [
      { grid: { res: 0.1 }, mask: { cells_inside: 100 }, source },
      {
        grid: { res: 0.01 },
        mask: { cells_inside: 10_000 },
        source: { ...source, name: "Terrain" },
      },
    ],
    notices: { limits: ["Coarse terrain."] },
    credits: { lines: ["Rain credit", "Data: synthetic"] },
  } as unknown as Scene;
}

test("the area comes from the finest layer's cells at the bbox centre latitude", () => {
  const cellKm = 0.01 * KILOMETERS_PER_DEGREE;

  assert.ok(Math.abs(areaKm2(makeScene()) - 10_000 * cellKm ** 2) < AREA_TOLERANCE_KM2);
});

test("cell sizes show metres below a kilometre and kilometres above", () => {
  assert.equal(formatCellSize(0.00135135), "150 m");
  assert.equal(formatCellSize(0.05), "5.6 km");
});

test("a drawn polygon has no boundary credit", () => {
  assert.equal(creditEntries(makeScene()).length, 2);
});

test("a named area credits its boundary source after the layers", () => {
  const boundary = {
    source: "geoBoundaries",
    licence: "CC BY 4.0",
    attribution: "Boundary credit",
  };
  const entries = creditEntries(makeScene({ boundary } as Partial<Scene["area"]>));

  assert.equal(entries.length, 3);
  assert.equal(entries[2].isBoundary, true);
  assert.equal(entries[2].name, "Area boundaries (geoBoundaries)");
});

test("credit lines without a listed source are kept", () => {
  assert.deepEqual(extraCreditLines(makeScene()), ["Data: synthetic"]);
});

test("a clipped area counts as one more notice", () => {
  assert.equal(noticeCount(makeScene()), 1);
  assert.equal(noticeCount(makeScene({ clipped_to_coverage: true })), 2);
});
