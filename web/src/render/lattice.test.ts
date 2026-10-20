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
  DOT_RADIUS_RATIO,
  HATCH_BYTE,
  MAX_LEVEL,
  MIN_LEVEL,
  NO_DATA_BYTE,
  bayerRank,
  blockMeans,
  cellSizePx,
  cellThreshold,
  crossfadeDot,
  dotCount,
  hasHatchedCells,
  isDotLit,
  isHatched,
  levelFor,
  markBytes,
  positionBytes,
  slotPosition,
} = await import("./lattice.ts").finally(() => hooks.deregister());

/** The (column, row) slots of one cell at a level that a position and threshold light. */
function litSlots(position: number, level: number, threshold: number) {
  const slots = 2 ** Math.max(level, 0);
  const count = dotCount(position, level, threshold);
  const lit = new Set<string>();
  for (let row = 0; row < slots; row++) {
    for (let column = 0; column < slots; column++) {
      if (bayerRank(column, row, Math.max(level, 0)) < count) lit.add(`${column},${row}`);
    }
  }
  return lit;
}

test("dots_nest_across_levels", () => {
  for (const position of [0.05, 0.2, 0.5, 0.8, 1]) {
    for (let level = 0; level < MAX_LEVEL; level++) {
      const coarse = litSlots(position, level, 0.3);
      const fine = litSlots(position, level + 1, 0.3);
      for (const slot of coarse) {
        const [column, row] = slot.split(",").map(Number);
        assert.ok(fine.has(`${2 * column},${2 * row}`), `${position} ${level} ${slot}`);
        assert.equal(slotPosition(2 * column, level + 1), slotPosition(column, level));
      }
    }
  }
});

test("count_is_position_times_slots_on_average", () => {
  for (const level of [0, 1, 2, 3]) {
    const slots = 4 ** level;
    for (const position of [0.1, 0.37, 0.5, 0.83]) {
      let total = 0;
      for (let row = 0; row < 8; row++) {
        for (let column = 0; column < 8; column++) {
          total += dotCount(position, level, cellThreshold(column, row));
        }
      }
      assert.ok(Math.abs(total / 64 - position * slots) < 0.5, `${level} ${position}`);
    }
  }
});

test("empty_at_zero_full_at_one", () => {
  for (let level = MIN_LEVEL; level <= MAX_LEVEL; level++) {
    for (const threshold of [0.008, 0.5, 0.99]) {
      assert.equal(dotCount(0, level, threshold), 0);
      assert.equal(dotCount(1, level, threshold), 4 ** Math.max(level, 0));
    }
  }
});

test("first_slots_form_regular_lattice_across_cells", () => {
  const firstFour = litSlots(0.25, 2, 0.999);
  assert.deepEqual([...firstFour].sort(), ["0,0", "0,2", "2,0", "2,2"]);

  const positions = [0, 2].map((slot) => slotPosition(slot, 2));
  assert.equal(positions[1] - positions[0], 0.5);
  assert.equal(slotPosition(4, 2) - slotPosition(0, 2), 1);
});

test("level_keeps_spacing_between_5_and_10_px", () => {
  for (let cellPx = 0.4; cellPx < 200; cellPx *= 1.07) {
    const { level, fade } = levelFor(cellPx);
    const spacingPx = cellPx / 2 ** level;
    assert.ok(fade >= 0 && fade <= 1);
    if (level > MIN_LEVEL && level < MAX_LEVEL) {
      assert.ok(spacingPx >= 5 && spacingPx < 10, `${cellPx} ${level}`);
    }
  }
  assert.equal(levelFor(7).fade, 0);
  assert.ok(levelFor(5 * 2 ** 0.9).fade > 0.3);
  assert.equal(levelFor(5 * 2 ** 4.9).fade, 0);
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

test("full_density_inks_eighteen_percent", () => {
  assert.ok(Math.abs(Math.PI * DOT_RADIUS_RATIO ** 2 - 0.18) < 0.005);
});

test("a cell's size on screen follows the zoom and stretches with latitude", () => {
  const cell = { width: 0.05, height: 0.05 };
  const equator = cellSizePx(10, cell, 0);

  assert.ok(Math.abs(equator - (512 * 1024 * 0.05) / 360) < 1e-9);
  assert.ok(Math.abs(cellSizePx(11, cell, 0) / equator - 2) < 1e-9);
  assert.ok(Math.abs(cellSizePx(10, cell, 60) / equator - Math.SQRT2) < 1e-9);
});

test("a dot that only the next level lights fades in from nothing", () => {
  const threshold = 0.5078125;
  const radiiPx = { parent: 2, next: 1 };
  const wasLit = isDotLit(64, 0, threshold, 0, 0);
  const willBeLit = isDotLit(64, 1, threshold, 0, 0);

  assert.equal(dotCount(64 / 253, 0, threshold), 0);
  assert.equal(dotCount(64 / 253, 1, threshold), 1);
  assert.deepEqual([wasLit, willBeLit], [false, true]);
  assert.equal(crossfadeDot(wasLit, willBeLit, 0, radiiPx).opacity, 0);
  assert.ok(Math.abs(crossfadeDot(wasLit, willBeLit, 0.25, radiiPx).opacity - 0.25) < 1e-9);
  assert.equal(crossfadeDot(wasLit, willBeLit, 0.25, radiiPx).radiusPx, 1);
  assert.equal(crossfadeDot(wasLit, willBeLit, 1, radiiPx).opacity, 1);
});

test("a block dot that the finer level leaves unlit fades out", () => {
  const radiiPx = { parent: 4, next: 2 };
  const none = NO_DATA_BYTE;
  const { means } = blockMeans(Uint8Array.of(0, 253, 253, 253), 2, 2, 2);
  const threshold = cellThreshold(0, 0);
  const wasLit = isDotLit(means[0], -1, threshold, 0, 0);
  const willBeLit = isDotLit(0, 0, threshold, 0, 0);

  assert.equal(means[0], 190);
  assert.deepEqual([wasLit, willBeLit], [true, false]);
  assert.ok(Math.abs(crossfadeDot(wasLit, willBeLit, 0.2, radiiPx).opacity - 0.8) < 1e-9);
  assert.equal(crossfadeDot(wasLit, willBeLit, 0.5, radiiPx).radiusPx, 3);
  assert.equal(crossfadeDot(wasLit, willBeLit, 1, radiiPx).opacity, 0);
  assert.equal(isDotLit(none, 0, threshold, 0, 0), false);
});

test("dots lit at both levels keep full opacity while they change size", () => {
  const radiiPx = { parent: 3, next: 2 };

  for (const fade of [0, 0.3, 1]) {
    assert.equal(crossfadeDot(true, true, fade, radiiPx).opacity, 1);
    assert.equal(crossfadeDot(false, false, fade, radiiPx).opacity, 0);
  }
  assert.equal(crossfadeDot(true, true, 0, radiiPx).radiusPx, 3);
  assert.equal(crossfadeDot(true, true, 1, radiiPx).radiusPx, 2);
});

test("every dot lit at a level stays lit at the next level", () => {
  for (let level = 0; level < MAX_LEVEL; level++) {
    for (const byte of [0, 20, 100, 127, 200, 253]) {
      for (const threshold of [0.008, 0.3, 0.99]) {
        const slots = 2 ** level;
        for (let row = 0; row < slots; row++) {
          for (let column = 0; column < slots; column++) {
            const wasLit = isDotLit(byte, level, threshold, column, row);
            const willBeLit = isDotLit(byte, level + 1, threshold, 2 * column, 2 * row);
            assert.ok(!wasLit || willBeLit, `${level} ${byte} ${threshold}`);
          }
        }
      }
    }
  }
});

test("a parent dot stays inside its own site at the highest latitude", () => {
  const edgePx = 0.5;
  const cell = { width: 0.05, height: 0.05 };
  const stretch = 2;
  for (let zoom = 8; zoom < 12; zoom += 0.05) {
    const { level, fade } = levelFor(cellSizePx(zoom, cell, 60));
    if (fade === 0) continue;

    const parentSpacingPx = cellSizePx(zoom, cell, 60) / 2 ** level;
    const halfWidthPx = parentSpacingPx / Math.sqrt(stretch) / 2;
    const reachPx = DOT_RADIUS_RATIO * parentSpacingPx + edgePx;
    assert.ok(reachPx <= halfWidthPx, `${zoom} ${reachPx} ${halfWidthPx}`);
  }
});
