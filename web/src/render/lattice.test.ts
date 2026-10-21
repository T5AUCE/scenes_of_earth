import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/render/lattice.ts") && specifier.startsWith("./")) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const {
  AREA_JITTER_RATIO,
  DOT_RADIUS_RATIO,
  EDGE_PX,
  HALO_WIDTH_PX,
  HATCH_BYTE,
  MAX_DOT_RADIUS_PX,
  MAX_LEVEL,
  MAX_RADIUS_SCALE,
  MIN_DOT_RADIUS_PX,
  MIN_LEVEL,
  NO_DATA_BYTE,
  POSITION_JITTER_RATIO,
  SIZE_JITTER_RATIO,
  aimedSpacingPx,
  areaNoise,
  blockMeans,
  containedRadiusPx,
  cellSizePx,
  dotAppearance,
  dotRadiusPx,
  hasHatchedCells,
  isHatched,
  levelFor,
  markBytes,
  maxDotRadiusPx,
  positionBytes,
  siteNoise,
  slotPosition,
} = await import("./lattice.ts").finally(() => hooks.deregister());

test("sites_nest_across_levels", () => {
  for (let level = 0; level < MAX_LEVEL; level++) {
    for (const slot of [0, 1, 3, 5]) {
      assert.equal(slotPosition(2 * slot, level + 1), slotPosition(slot, level));
    }
  }
});

test("level_keeps_spacing_between_40_and_80_px", () => {
  for (let cellPx = 0.4; cellPx < 800; cellPx *= 1.07) {
    const { level, fade } = levelFor(cellPx);
    const spacingPx = cellPx / 2 ** level;
    assert.ok(fade >= 0 && fade <= 1);
    if (level > MIN_LEVEL && level < MAX_LEVEL) {
      assert.ok(spacingPx >= 40 && spacingPx < 80, `${cellPx} ${level}`);
    }
  }
  assert.equal(levelFor(56).fade, 0);
  assert.ok(levelFor(40 * 2 ** 0.9).fade > 0.3);
  assert.equal(levelFor(40 * 2 ** (MAX_LEVEL + 0.9)).fade, 0);
});

test("dots sit closer together when zoomed out and keep their size", () => {
  assert.equal(aimedSpacingPx(4), 10);
  assert.equal(aimedSpacingPx(6), 10);
  assert.equal(aimedSpacingPx(10), 40);
  assert.equal(aimedSpacingPx(14), 40);
  assert.ok(Math.abs(aimedSpacingPx(8) - 20) < 1e-9);
  assert.equal(maxDotRadiusPx(10, 10), maxDotRadiusPx(40, 40));
  assert.equal(levelFor(40, 10).level, levelFor(160, 40).level);
});

test("the dot level stops rising at its maximum", () => {
  assert.equal(levelFor(40 * 2 ** 6.9).level, MAX_LEVEL);
  assert.equal(levelFor(40 * 2 ** 10).level, MAX_LEVEL);
  assert.equal(levelFor(40 * 2 ** 10).fade, 0);
});

test("block_means_ignore_no_data", () => {
  const none = NO_DATA_BYTE;
  const positions = Uint8Array.of(
    10,
    20,
    none,
    none,
    7,
    30,
    none,
    none,
    none,
    9,
    1,
    2,
    3,
    4,
    5,
  );
  const { means, width, height } = blockMeans(positions, 5, 3, 2);

  assert.deepEqual([width, height], [3, 2]);
  assert.deepEqual(Array.from(means), [20, none, 8, 2, 4, 5]);
});

test("positionBytes stores NaN as no data and clamps outside the stops", () => {
  const bytes = positionBytes([NaN, -5, 0, 2, 4, 99], [0, 2, 4]);
  assert.deepEqual(Array.from(bytes), [NO_DATA_BYTE, 0, 0, 127, 253, 253]);
});

test("hatch_marks_only_in_area_no_data_cells", () => {
  const mask = Uint8Array.of(1, 1, 0, 0, 1, 1);
  const positions = Uint8Array.of(0, NO_DATA_BYTE, NO_DATA_BYTE, 40, 253, NO_DATA_BYTE);

  assert.deepEqual(
    Array.from(markBytes(positions, mask)),
    [0, HATCH_BYTE, NO_DATA_BYTE, NO_DATA_BYTE, 253, HATCH_BYTE],
  );
  assert.deepEqual(
    [isHatched(true, NO_DATA_BYTE), isHatched(false, NO_DATA_BYTE), isHatched(true, 0)],
    [true, false, false],
  );
  assert.equal(hasHatchedCells(positions, mask), true);
  assert.equal(hasHatchedCells(Uint8Array.of(0, NO_DATA_BYTE), Uint8Array.of(1, 0)), false);

  const hatchedCells = Uint8Array.of(HATCH_BYTE, HATCH_BYTE, HATCH_BYTE, HATCH_BYTE);
  const mixedCells = Uint8Array.of(HATCH_BYTE, HATCH_BYTE, HATCH_BYTE, NO_DATA_BYTE);
  assert.equal(blockMeans(hatchedCells, 2, 2, 2).means[0], HATCH_BYTE);
  assert.equal(blockMeans(mixedCells, 2, 2, 2).means[0], NO_DATA_BYTE);
});

test("a cell's size on screen follows the zoom and stretches with latitude", () => {
  const cell = { width: 0.05, height: 0.05 };
  const equator = cellSizePx(10, cell, 0);

  assert.ok(Math.abs(equator - (512 * 1024 * 0.05) / 360) < 1e-9);
  assert.ok(Math.abs(cellSizePx(11, cell, 0) / equator - 2) < 1e-9);
  assert.ok(Math.abs(cellSizePx(10, cell, 60) / equator - Math.SQRT2) < 1e-9);
});

test("the dot radius stops growing once the level reaches its maximum", () => {
  const cell = { width: 0.05, height: 0.05 };
  const radiusPx = (zoom: number) => {
    const cellPx = cellSizePx(zoom, cell, 0);
    return maxDotRadiusPx(cellPx / 2 ** levelFor(cellPx).level);
  };

  assert.ok(radiusPx(15) < MAX_DOT_RADIUS_PX);
  assert.equal(radiusPx(17), MAX_DOT_RADIUS_PX);
});

test("the zoom cap on the largest dot radius is 9.6 css px", () => {
  assert.ok(Math.abs(MAX_DOT_RADIUS_PX - 9.6) < 1e-9);
  assert.equal(maxDotRadiusPx(200), MAX_DOT_RADIUS_PX);
  assert.equal(maxDotRadiusPx(40), DOT_RADIUS_RATIO * 40);
});

test("full value inks 2 percent of a site", () => {
  assert.ok(Math.abs(Math.PI * DOT_RADIUS_RATIO ** 2 - 0.02) < 0.001);
});

test("dot area is proportional to the value", () => {
  const areaAt = (position: number) => dotRadiusPx(position, 4, 0) ** 2;

  assert.equal(dotRadiusPx(0, 4, 0), 0);
  assert.ok(Math.abs(areaAt(0.5) * 2 - areaAt(1)) < 1e-9);
  assert.ok(Math.abs(areaAt(0.25) * 4 - areaAt(1)) < 1e-9);
});

test("a dot below the minimum radius fades by area instead of shrinking", () => {
  assert.deepEqual(dotAppearance(2), { radiusPx: 2, opacity: 1 });
  assert.deepEqual(dotAppearance(MIN_DOT_RADIUS_PX), { radiusPx: MIN_DOT_RADIUS_PX, opacity: 1 });

  const faint = dotAppearance(MIN_DOT_RADIUS_PX / 2);
  assert.equal(faint.radiusPx, MIN_DOT_RADIUS_PX);
  assert.equal(faint.opacity, 0.25);
  assert.equal(dotAppearance(0).opacity, 0);
});

test("site noise is deterministic and spans -1 to 1", () => {
  assert.deepEqual(siteNoise(37, 91), siteNoise(37, 91));
  assert.notDeepEqual(siteNoise(37, 91), siteNoise(91, 37));

  const values = sampleNoise().flatMap(({ x, y }) => [x, y]);
  const lowest = values.reduce((low, value) => Math.min(low, value), 1);
  const highest = values.reduce((high, value) => Math.max(high, value), -1);
  assert.ok(lowest >= -1 && lowest < -0.95);
  assert.ok(highest <= 1 && highest > 0.95);
});

test("jitter keeps each cell's total ink at its value", () => {
  const maxRadiusPx = 3;
  for (let level = 0; level <= MAX_LEVEL; level++) {
    for (const cellColumn of [-3, 0, 2]) {
      for (const cellRow of [-1, 0, 5]) {
        const columns = ownedSlots(cellColumn, level);
        const rows = ownedSlots(cellRow, level);
        let ink = 0;
        for (const row of rows) {
          for (const column of columns) {
            ink += dotRadiusPx(0.4, maxRadiusPx, areaNoise(column, row, level)) ** 2;
          }
        }
        const expected = 0.4 * maxRadiusPx ** 2 * columns.length * rows.length;
        assert.equal(columns.length, 2 ** level);
        assert.ok(Math.abs(ink / expected - 1) < 1e-9, `${level} ${cellColumn} ${cellRow}`);
      }
    }
  }
});

test("a cell with a single dot site has no size jitter", () => {
  for (const level of [-3, 0]) {
    assert.equal(areaNoise(5, 9, level), 0);
    assert.equal(dotRadiusPx(0.6, 2, areaNoise(5, 9, level)), dotRadiusPx(0.6, 2, 0));
  }
  assert.notEqual(areaNoise(5, 9, 1), 0);
});

test("size jitter changes a radius by at most 20 percent", () => {
  assert.ok(Math.abs(AREA_JITTER_RATIO - 0.36) < 1e-9);
  for (let column = 0; column < 128; column++) {
    for (let row = 0; row < 64; row++) {
      const area = areaNoise(column, row, 3);
      const scale = dotRadiusPx(1, 1, area);
      assert.ok(area >= -1 && area <= 1);
      assert.ok(scale >= 1 - SIZE_JITTER_RATIO - 1e-9 && scale <= MAX_RADIUS_SCALE + 1e-9);
    }
  }
});

test("jittered dots stay in their sub-cell and clear of their neighbours up to 60 degrees", () => {
  for (const latitude of [0, 30, 60]) {
    const stretch = 1 / Math.cos((latitude * Math.PI) / 180);
    for (const geometricPx of [5, 7, 10, 20]) {
      const spacingXPx = geometricPx / Math.sqrt(stretch);
      const spacingYPx = geometricPx * Math.sqrt(stretch);
      const radiusPx = containedRadiusPx(
        spacingXPx,
        spacingYPx,
        maxDotRadiusPx(geometricPx),
        HALO_WIDTH_PX,
      );
      const reachPx = radiusPx * MAX_RADIUS_SCALE + EDGE_PX + HALO_WIDTH_PX;

      assert.ok(POSITION_JITTER_RATIO * spacingXPx + reachPx <= spacingXPx / 2 + 1e-9);
      assert.ok(POSITION_JITTER_RATIO * spacingYPx + reachPx <= spacingYPx / 2 + 1e-9);
    }
  }
});

test("the contained radius keeps the full radius where there is room", () => {
  assert.equal(containedRadiusPx(100, 100, 2.4, HALO_WIDTH_PX), 2.4);
  assert.equal(containedRadiusPx(1, 100, 2.4, 0), 0);
});

test("a site keeps its noise because it is indexed on the finest level", () => {
  const finestIndex = (slot: number, level: number) => slot * 2 ** (MAX_LEVEL - level);

  assert.deepEqual(
    siteNoise(finestIndex(3, 3), finestIndex(2, 3)),
    siteNoise(finestIndex(6, 4), finestIndex(4, 4)),
  );
});

function ownedSlots(cell: number, level: number) {
  const slots = [];
  for (let slot = (cell - 1) * 2 ** level; slot <= (cell + 1) * 2 ** level; slot++) {
    if (Math.floor(slotPosition(slot, level)) === cell) slots.push(slot);
  }
  return slots;
}

function sampleNoise() {
  const sites = [];
  for (let row = 0; row < 256; row++) {
    for (let column = 0; column < 256; column++) sites.push(siteNoise(column, row));
  }
  return sites;
}
