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
  DENSITY_STEP_LOG2,
  DOT_RADIUS_RATIO,
  EDGE_PX,
  HALO_WIDTH_PX,
  HATCH_BYTE,
  HIGH_ZOOM_FADE_END_ZOOM,
  HIGH_ZOOM_FADE_SPAN_ZOOM,
  MAX_DOT_RADIUS_PX,
  MAX_LEVEL,
  MAX_RADIUS_SCALE,
  MIN_DOT_RADIUS_PX,
  MIN_LEVEL,
  MAX_DENSITY_RATIO,
  MIN_DENSITY_LOG2,
  MIN_DENSITY_RATIO,
  MIN_SPACING_PX,
  NO_DATA_BYTE,
  POSITION_JITTER_RATIO,
  SIZE_JITTER_RATIO,
  VALUE_RADIUS_EXPONENT,
  aimedSpacingPx,
  areaNoise,
  blockMeans,
  clampDensity,
  containedRadiusPx,
  cellSidesPx,
  cellSizePx,
  dotAppearance,
  dotLattice,
  dotRadiusPx,
  hasHatchedCells,
  highZoomDotOpacity,
  isHatched,
  levelFor,
  levelRadiusPx,
  levelSpacingPx,
  markBytes,
  maxDotRadiusPx,
  positionBytes,
  quantiseDensity,
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

test("level_keeps_spacing_between_one_and_two_aimed_spacings", () => {
  for (let cellPx = 0.4; cellPx < 800; cellPx *= 1.07) {
    const { level, fade } = levelFor(cellPx);
    const spacingPx = cellPx / 2 ** level;
    assert.ok(fade >= 0 && fade <= 1);
    if (level > MIN_LEVEL && level < MAX_LEVEL) {
      const inRange = spacingPx >= MIN_SPACING_PX && spacingPx < 2 * MIN_SPACING_PX;
      assert.ok(inRange, `${cellPx} ${level}`);
    }
  }
  assert.ok(levelFor(1.4 * MIN_SPACING_PX).fade > 0);
  assert.ok(levelFor(MIN_SPACING_PX * 2 ** 0.9).fade > 0.3);
  assert.equal(levelFor(MIN_SPACING_PX * 2 ** (MAX_LEVEL + 0.9)).fade, 0);
});

test("dots sit closer together when zoomed out and keep their size", () => {
  assert.equal(aimedSpacingPx(4), 15);
  assert.equal(aimedSpacingPx(6), 15);
  assert.ok(Math.abs(aimedSpacingPx(10) - 30) < 1e-9);
  assert.ok(Math.abs(aimedSpacingPx(14) - 30) < 1e-9);
  assert.ok(Math.abs(aimedSpacingPx(8) - Math.sqrt(15 * 30)) < 1e-9);
  assert.equal(maxDotRadiusPx(15, 0, 15), maxDotRadiusPx(30, 0, 30));
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

test("ring cells produce neither dots nor hatch marks even with a raw mask", () => {
  const positions = Uint8Array.of(100, NO_DATA_BYTE, 100, NO_DATA_BYTE, 100, NO_DATA_BYTE);
  const mask = Uint8Array.of(2, 2, 0, 0, 1, 1);

  assert.deepEqual(
    Array.from(markBytes(positions, mask)),
    [NO_DATA_BYTE, NO_DATA_BYTE, NO_DATA_BYTE, NO_DATA_BYTE, 100, HATCH_BYTE],
  );
  assert.equal(hasHatchedCells(positions.subarray(0, 4), mask.subarray(0, 4)), false);
  assert.equal(hasHatchedCells(positions, mask), true);
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
    const { level } = levelFor(cellPx);
    return maxDotRadiusPx(cellPx / 2 ** level, level);
  };

  assert.ok(radiusPx(15) < MAX_DOT_RADIUS_PX);
  assert.equal(radiusPx(18), MAX_DOT_RADIUS_PX);
});

test("the zoom cap on the largest dot radius is three times the full radius", () => {
  assert.ok(Math.abs(MAX_DOT_RADIUS_PX - 3 * DOT_RADIUS_RATIO * MIN_SPACING_PX) < 1e-9);
  assert.equal(maxDotRadiusPx(200, 0), MAX_DOT_RADIUS_PX);
  assert.ok(Math.abs(maxDotRadiusPx(40, 0) - DOT_RADIUS_RATIO * 40) < 1e-9);
});

test("full value inks about 2.5 percent of a site", () => {
  assert.ok(Math.abs(Math.PI * DOT_RADIUS_RATIO ** 2 - 0.0254) < 0.001);
});

test("a quarter value gives a dot 35 percent as wide as the full value", () => {
  const radiusAt = (position: number) => dotRadiusPx(position, 4, 0);

  assert.equal(VALUE_RADIUS_EXPONENT, 0.75);
  assert.equal(radiusAt(0), 0);
  assert.equal(radiusAt(1), 4);
  assert.ok(Math.abs(radiusAt(0.25) / radiusAt(1) - 0.35) < 0.005);
  assert.ok(Math.abs(radiusAt(0.5) / radiusAt(1) - 0.5 ** 0.75) < 1e-9);
});

test("density clamps to its range", () => {
  assert.equal(clampDensity(0.1), MIN_DENSITY_RATIO);
  assert.equal(clampDensity(9), MAX_DENSITY_RATIO);
  assert.equal(clampDensity(1.3), 1.3);
});

test("density normalisation uses equal log steps with exact range ends and default", () => {
  assert.equal(MIN_DENSITY_RATIO, 2 ** -1.5);
  assert.equal(MAX_DENSITY_RATIO, Math.SQRT2);
  assert.equal(quantiseDensity(0.25), MIN_DENSITY_RATIO);
  assert.equal(quantiseDensity(4), MAX_DENSITY_RATIO);
  assert.equal(quantiseDensity(1), 1);
  for (let step = 0; step <= 16; step++) {
    const density = 2 ** (MIN_DENSITY_LOG2 + step * DENSITY_STEP_LOG2);
    assert.equal(quantiseDensity(density), density);
    assert.equal(quantiseDensity(quantiseDensity(density)), density);
  }
});

test("every log step changes drawn spacing at typical zooms before containment", () => {
  const cell = { width: 0.05, height: 0.05 };
  for (const latitude of [0, 60]) {
    for (const zoom of [6, 8, 10, 12]) {
      let previousPx = Infinity;
      for (let step = 0; step <= 16; step++) {
        const density = 2 ** (MIN_DENSITY_LOG2 + step * DENSITY_STEP_LOG2);
        const frame = dotLattice(cell, latitude, zoom, density, 2);
        const spacingPx = cellSizePx(zoom, cell, latitude)
          / (2 ** frame.level * Math.sqrt(1 + 3 * frame.fade));

        assert.equal(frame.density, density);
        assert.ok(spacingPx < previousPx, `${latitude} ${zoom} ${density}`);
        previousPx = spacingPx;
      }
    }
  }
});

test("high-latitude containment reduces density instead of clipping either active level", () => {
  const cell = { width: 0.05, height: 0.05 };
  let reduced = false;
  for (const latitude of [45, 50, 55, 60]) {
    for (const zoom of [5, 5.3, 6, 8, 10, 12]) {
      for (const pixelRatio of [1, 2]) {
        for (let step = 0; step <= 16; step++) {
          const requested = 2 ** (MIN_DENSITY_LOG2 + step * DENSITY_STEP_LOG2);
          const frame = dotLattice(cell, latitude, zoom, requested, pixelRatio);
          const { sidesPx, level, fade, aimedPx, density } = frame;
          const cellPx = Math.sqrt(sidesPx.width * sidesPx.height);
          reduced ||= density < requested;
          assert.ok(density <= requested);
          for (let active = level; active <= level + (fade > 0 ? 1 : 0); active++) {
            const radiusPx = maxDotRadiusPx(cellPx / 2 ** active, active, aimedPx, density);
            const drawnPx = levelRadiusPx(sidesPx, active, aimedPx, pixelRatio, density);
            assert.ok(
              Math.abs(drawnPx - radiusPx) < 1e-9,
              `${latitude} ${zoom} DPR ${pixelRatio} requested ${requested} level ${active}`,
            );
          }
        }
      }
    }
  }
  assert.equal(reduced, true);
});

test("density scales the dot spacing and radius but not the share of a surface they ink", () => {
  const cellPx = 120;
  const zoom = 8;
  for (const density of [0.5, 0.8, 1.3, 2]) {
    const aimedPx = aimedSpacingPx(zoom, density);
    const { level } = levelFor(cellPx, aimedPx);
    const spacingPx = cellPx / 2 ** level;
    const radiusPx = maxDotRadiusPx(spacingPx, level, aimedPx, density);
    const baseline = aimedSpacingPx(zoom);

    assert.ok(Math.abs(aimedPx - baseline / density) < 1e-9);
    assert.ok(Math.abs(radiusPx / spacingPx - DOT_RADIUS_RATIO * MIN_SPACING_PX / baseline) < 1e-9);
  }
});

test("a density of two puts a level more dots a side and shrinks the zoom cap to half", () => {
  const sparse = levelFor(100, aimedSpacingPx(8));
  const dense = levelFor(100, aimedSpacingPx(8, 2));

  assert.equal(dense.level, sparse.level + 1);
  assert.ok(Math.abs(dense.fade - sparse.fade) < 1e-9);
  assert.ok(Math.abs(maxDotRadiusPx(1000, 0, 30, 2) * 2 - MAX_DOT_RADIUS_PX) < 1e-9);
});

test("a lattice at its maximum level keeps the same dot radius at every density", () => {
  const spacingPx = 100;
  const baseAimedPx = 20;
  const radii = [0.5, 0.75, 1, 1.5, 2].map((density) =>
    maxDotRadiusPx(spacingPx, MAX_LEVEL, baseAimedPx / density, density)
  );
  const expectedPx = Math.min(
    DOT_RADIUS_RATIO * MIN_SPACING_PX * (spacingPx / baseAimedPx),
    MAX_DOT_RADIUS_PX,
  );

  for (const radiusPx of radii) assert.equal(radiusPx, expectedPx);
});

test("a dot below the minimum radius fades by area instead of shrinking", () => {
  assert.deepEqual(dotAppearance(2), { radiusPx: 2, opacity: 1 });
  assert.deepEqual(dotAppearance(MIN_DOT_RADIUS_PX), { radiusPx: MIN_DOT_RADIUS_PX, opacity: 1 });

  const faint = dotAppearance(MIN_DOT_RADIUS_PX / 2);
  assert.equal(faint.radiusPx, MIN_DOT_RADIUS_PX);
  assert.equal(faint.opacity, 0.25);
  assert.equal(dotAppearance(0).opacity, 0);
});

test("dots keep full opacity below the high-zoom fade", () => {
  assert.equal(highZoomDotOpacity(HIGH_ZOOM_FADE_END_ZOOM - 1, 1), 1);
  assert.equal(highZoomDotOpacity(HIGH_ZOOM_FADE_END_ZOOM - HIGH_ZOOM_FADE_SPAN_ZOOM, 1), 1);
  assert.equal(highZoomDotOpacity(15, 2), 1);
  assert.equal(highZoomDotOpacity(16.4, 0.5), 1);
});

test("dots are gone at and beyond the high-zoom fade end", () => {
  assert.equal(highZoomDotOpacity(HIGH_ZOOM_FADE_END_ZOOM, 1), 0);
  assert.equal(highZoomDotOpacity(HIGH_ZOOM_FADE_END_ZOOM + 1, 1), 0);
  assert.equal(highZoomDotOpacity(HIGH_ZOOM_FADE_END_ZOOM - 1, 2), 0);
  assert.equal(highZoomDotOpacity(20, 2), 0);
});

test("dots fade smoothly and monotonically through the high-zoom range", () => {
  const start = HIGH_ZOOM_FADE_END_ZOOM - HIGH_ZOOM_FADE_SPAN_ZOOM;
  const middle = start + HIGH_ZOOM_FADE_SPAN_ZOOM / 2;
  let previous = 1;
  for (let zoom = start; zoom <= HIGH_ZOOM_FADE_END_ZOOM; zoom += 0.01) {
    const opacity = highZoomDotOpacity(zoom, 1);
    assert.ok(opacity >= 0 && opacity <= 1);
    assert.ok(opacity <= previous + 1e-12, `zoom ${zoom}`);
    previous = opacity;
  }
  assert.ok(Math.abs(highZoomDotOpacity(middle, 1) - 0.5) < 1e-9);
});

test("a doubled pixel ratio moves the high-zoom fade one zoom earlier", () => {
  const startAtDpr2 = HIGH_ZOOM_FADE_END_ZOOM - 1 - HIGH_ZOOM_FADE_SPAN_ZOOM;
  const middleAtDpr2 = startAtDpr2 + HIGH_ZOOM_FADE_SPAN_ZOOM / 2;
  assert.ok(Math.abs(highZoomDotOpacity(middleAtDpr2, 2) - 0.5) < 1e-9);
  for (const step of [-0.5, 0, 0.1, 0.25, 0.4, 0.5, 1]) {
    const zoom = startAtDpr2 + step;
    assert.ok(
      Math.abs(highZoomDotOpacity(zoom, 2) - highZoomDotOpacity(zoom + 1, 1)) < 1e-12,
      `zoom ${zoom}`,
    );
  }
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
        const expected = 0.4 ** (2 * VALUE_RADIUS_EXPONENT) * maxRadiusPx ** 2
          * columns.length * rows.length;
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
        maxDotRadiusPx(geometricPx, 0),
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

test("cell sides stretch the height by Mercator and keep the geometric mean", () => {
  const cellDegrees = { width: 0.05, height: 0.05 };
  const equator = cellSidesPx(5, cellDegrees, 0);
  const north = cellSidesPx(5, cellDegrees, 60);
  const meanPx = Math.sqrt(north.width * north.height);

  assert.ok(Math.abs(equator.width - equator.height) < 1e-9);
  assert.ok(Math.abs(north.height / north.width - 2) < 1e-9);
  assert.ok(Math.abs(meanPx - cellSizePx(5, cellDegrees, 60)) < 1e-9);
});

test("level spacing halves along both axes per level", () => {
  const spacing = levelSpacingPx({ width: 32, height: 64 }, 2);

  assert.deepEqual(spacing, { x: 8, y: 16 });
});

test("the level radius follows the shorter axis and leaves room for the device-px halo", () => {
  const sidesPx = { width: 8, height: 16 };
  const zoomCapPx = maxDotRadiusPx(Math.sqrt(sidesPx.width * sidesPx.height), 0, 15);
  const edgeAndHaloPx = EDGE_PX + HALO_WIDTH_PX;
  const limitAt = (ratio: number) =>
    (sidesPx.width * ratio * (0.5 - POSITION_JITTER_RATIO) - edgeAndHaloPx)
    / MAX_RADIUS_SCALE
    / ratio;

  assert.ok(Math.abs(levelRadiusPx(sidesPx, 0, 15, 1) - limitAt(1)) < 1e-9);
  assert.ok(levelRadiusPx(sidesPx, 0, 15, 1) < zoomCapPx);
  assert.ok(levelRadiusPx(sidesPx, 0, 15, 2) > levelRadiusPx(sidesPx, 0, 15, 1));
  assert.ok(Math.abs(levelRadiusPx(sidesPx, 0, 15, 2) - Math.min(limitAt(2), zoomCapPx)) < 1e-9);
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
