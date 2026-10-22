import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Isoline,
  isolineInterval,
  isolineLevels,
  sampleSmoothField,
  toLngLat,
  traceIsolines,
} from "./isolines.ts";

const PEAK_SIZE = 25;
const PEAK_WIDTH = 12;
const PEAK_LEVELS = [2, 3, 4];
const SADDLE_SIZE = 21;
const SADDLE_LEVELS = [-1, 1];
const MAX_TURN_DEG = 25;
const MAX_ERROR_SHARE = 0.02;
const SAMPLE_STEPS = 16;
const MIN_CLOSED_LOOP_SPAN_CELLS = 0.25;

test("the interval keeps a scene at twelve isotherm levels or fewer", () => {
  for (const [low, high] of [[5, 29], [-12, 10], [0, 50], [-60, 60], [-100, 100]]) {
    const interval = isolineInterval([low, high]);
    assert.ok(isolineLevels(low, high, interval).length <= 12);
  }
  assert.equal(isolineInterval([2, 13]), 1);
  assert.equal(isolineInterval([-60, 60]), 20);
});

test("levels sit on interval multiples and round stably", () => {
  assert.deepEqual(isolineLevels(-1, 2, 0.5), [-1, -0.5, 0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(isolineLevels(5, 29, 2), [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28]);
});

test("adjacent segments chain into one open polyline", () => {
  assert.deepEqual(
    traceIsolines([2, 2, 2, 0, 0, 0], 3, 2, [1]),
    [
      {
        value: 1,
        coordinates: [[0, 0.5], [1, 0.5], [2, 0.5]],
      },
    ],
  );
});

test("an exact-level ridge does not retrace a segment", () => {
  const lines = traceIsolines([0, 0, 0, 1, 1, 1, 0, 0, 0], 3, 3, [1]);

  assert.deepEqual(lines, [{ value: 1, coordinates: [[0, 1], [1, 1], [2, 1]] }]);
});

test("a cell with a no-data corner produces no segments", () => {
  assert.deepEqual(traceIsolines([1, 0, NaN, 0], 2, 2, [0.5]), []);
});

test("a finite native strip beside no-data keeps its raw endpoints", () => {
  const values = [0, 1, NaN, 0, 1, NaN];
  const raw = traceIsolines(values, 3, 2, [0.9]);
  const smooth = traceIsolines(values, 3, 2, [0.9], true);

  assert.equal(smooth.length, 1);
  assert.deepEqual(openEndpoints(raw), [[0.9, 0], [0.9, 1]]);
  assert.deepEqual(openEndpoints(smooth), openEndpoints(raw));
});

test("native centres and finite edges survive a no-data neighbour", () => {
  const values = [0, 1, 2, 1, 2, NaN, 2, 3, 4];

  assert.equal(sampleSmoothField(values, 3, 3, 1, 1), 2);
  assert.equal(sampleSmoothField(values, 3, 3, 1, 0.5), 1.5);
  assert.ok(Number.isNaN(sampleSmoothField(values, 3, 3, 1.5, 0.5)));
  assert.ok(Number.isNaN(sampleSmoothField(values, 3, 3, 1.5, 1.5)));
});

test("saddle cells produce a deterministic pair of segments", () => {
  const values = [4, 0, 0, 2];

  assert.deepEqual(traceIsolines(values, 2, 2, [1.2]), traceIsolines(values, 2, 2, [1.2]));
  assert.equal(traceIsolines(values, 2, 2, [1.2]).length, 2);
  assert.equal(traceIsolines(values, 2, 2, [1.4]).length, 2);
});

test("different levels never cross", () => {
  for (const { values, size, levels } of smoothCases()) {
    assertNoLevelCrossings(traceIsolines(values, size, size, levels, true));
  }
  assertNoLevelCrossings(traceIsolines(saddleField(21, 10), 21, 21, [0.5, 1.5, 2.5], true));
});

test("rounding keeps a smooth peak and saddle below the turning threshold", () => {
  for (const { values, size, levels } of smoothCases()) {
    const turning = maximumTurnDegrees(traceIsolines(values, size, size, levels, true));
    assert.ok(turning < MAX_TURN_DEG, `lines turned ${turning.toFixed(1)} degrees`);
  }
});

test("the worst field error stays below two percent of the level interval", () => {
  const cases = [
    { ...smoothCases()[0], interval: 1, sample: samplePeak },
    { ...smoothCases()[1], interval: 2, sample: sampleSaddle },
  ];
  for (const { values, size, levels, interval, sample } of cases) {
    const lines = traceIsolines(values, size, size, levels, true);
    let worst = 0;
    for (const { value, coordinates } of lines) {
      worst = Math.max(worst, maximumFieldError(coordinates, value, sample));
    }
    assert.ok(worst < MAX_ERROR_SHARE * interval, `worst error was ${worst}`);
  }
});

test("data-ring lines reach the grid outline", () => {
  const lines = traceIsolines(ringField(), 5, 5, [0.5], true);

  assert.equal(lines.length, 1);
  const ends = [lines[0].coordinates[0], lines[0].coordinates.at(-1)!]
    .sort(([left], [right]) => left - right);
  assert.deepEqual(ends, [[0, 2.5], [4, 2.5]]);
});

test("open-line endpoints stay fixed by rounding", () => {
  const lines = traceIsolines([2, 2, 2, 0, 0, 0], 3, 2, [1], true);

  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].coordinates[0], lines[0].coordinates.at(-1)], [[0, 0.5], [2, 0.5]]);
});

test("closed loops stay closed after rounding", () => {
  const lines = traceIsolines(peakedField(), PEAK_SIZE, PEAK_SIZE, [4], true);

  assert.ok(lines.length > 0);
  for (const { coordinates } of lines) {
    assert.ok(isClosed(coordinates));
    assert.deepEqual(coordinates[0], coordinates.at(-1));
  }
});

test("a plateau junction stays a fixed anchor on every rounded trail", () => {
  // An exact-level ridge and spur meet at a T junction, and a loop returns to the ridge.
  const values = [
    0,
    0,
    1,
    0,
    0,
    2,
    0,
    1,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    0,
    1,
    1,
    2,
    0,
    0,
    1,
    1,
    0,
    0,
  ];
  const lines = traceIsolines(values, 5, 5, [1], true);

  assert.equal(junctionMeetingCount(lines, [2, 1.75]), 3);
  assert.equal(junctionMeetingCount(lines, [1.75, 2]), 4);
});

test("a junction loop chained from an interior segment stays fixed", () => {
  const values = [
    0,
    0,
    0,
    0,
    0,
    2,
    1,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    1,
    0,
  ];
  const lines = traceIsolines(values, 4, 4, [1], true);

  assert.equal(junctionMeetingCount(lines, [2, 1.75]), 3);
});

test("sub-cell closed loops are dropped while open and long thin lines stay", () => {
  const spike = [0, 0, 0, 0, 5, 0, 0, 0, 0];

  assert.equal(traceIsolines(spike, 3, 3, [4.9]).length, 1);
  assert.deepEqual(traceIsolines(spike, 3, 3, [4.9], true), []);
  const larger = traceIsolines(spike, 3, 3, [4], true);
  assert.equal(larger.length, 1);
  assert.ok(loopSpan(larger[0]) >= MIN_CLOSED_LOOP_SPAN_CELLS);

  const thin = traceIsolines(ridgeField(), 7, 5, [4.9], true);
  assert.equal(thin.length, 1);
  assert.ok(loopSpan(thin[0]) > 1);
  assert.equal(traceIsolines([2, 2, 2, 0, 0, 0], 3, 2, [1], true).length, 1);
});

test("refinement never enters a cell with a no-data corner", () => {
  const values = [
    0,
    1,
    2,
    3,
    4,
    1,
    2,
    NaN,
    4,
    5,
    2,
    3,
    4,
    5,
    6,
    3,
    4,
    5,
    6,
    7,
    4,
    5,
    6,
    7,
    8,
  ];
  const lines = traceIsolines(values, 5, 5, [2.5, 4.5], true);
  const blocked = cellsWithNoData(values, 5, 5);

  assert.ok(lines.length > 0);
  for (const { coordinates } of lines) {
    for (let index = 1; index < coordinates.length; index++) {
      for (const along of [0.25, 0.5, 0.75]) {
        const [x, y] = alongSegment(coordinates[index - 1], coordinates[index], along);
        assert.ok(
          !blocked.some(
            ([column, row]) => x > column && x < column + 1 && y > row && y < row + 1,
          ),
        );
      }
    }
  }
});

test("a synthetic fallback boundary keeps a continuous bicubic edge", () => {
  const size = 7;
  const values = quadraticField(size);
  values[0] = NaN;

  for (const row of [1.25, 1.5, 1.75]) {
    const edge = sampleSmoothField(values, size, size, 2, row);
    assert.ok(Math.abs(sampleSmoothField(values, size, size, 2 - 1e-8, row) - edge) < 1e-6);
    assert.ok(Math.abs(sampleSmoothField(values, size, size, 2 + 1e-8, row) - edge) < 1e-6);
    assert.ok(Math.abs(edge - bilinearAt(values, size, 2, row)) < 1e-9);
  }
});

test("adjacent finite bicubic quads share one clamp range", () => {
  // This crop exposes a clamp seam because the lower quad's maximum is below the shared cubic edge.
  const values = [
    24.0,
    27.7,
    26.7,
    24.6,
    20.1,
    26.3,
    26.0,
    23.4,
    19.0,
    26.1,
    25.9,
    23.4,
    20.2,
    26.0,
    25.2,
    24.0,
    21.7,
    26.2,
    24.2,
    24.3,
  ];

  const upper = sampleSmoothField(values, 4, 5, 1.375, 2 - 1e-8);
  const lower = sampleSmoothField(values, 4, 5, 1.375, 2 + 1e-8);

  assert.ok(Math.abs(upper - 26.660742) < 1e-6);
  assert.ok(Math.abs(upper - lower) < 1e-6);
});

test("tracing is deterministic in both modes", () => {
  const values = saddleField();
  for (const refine of [false, true]) {
    assert.deepEqual(
      traceIsolines(values, 21, 21, SADDLE_LEVELS, refine),
      traceIsolines(values, 21, 21, SADDLE_LEVELS, refine),
    );
  }
});

test("rows map to latitude at cell centres and take the world shift", () => {
  const grid = { bbox: [34, -5, 42, 5] as [number, number, number, number], nx: 4, ny: 2 };

  assert.deepEqual(
    toLngLat([[0, 0], [2, 1], [4, 2]], grid, -360),
    [
      [-325, 2.5],
      [-321, -2.5],
      [-317, -7.5],
    ],
  );
  assert.deepEqual(toLngLat([[2, 1]], grid, 0), [[39, -2.5]]);
});

function smoothCases(): { values: number[]; size: number; levels: number[] }[] {
  return [
    { values: peakedField(), size: PEAK_SIZE, levels: PEAK_LEVELS },
    { values: saddleField(), size: SADDLE_SIZE, levels: SADDLE_LEVELS },
  ];
}

function peakedField(): number[] {
  const centre = (PEAK_SIZE - 1) / 2;
  return Array.from({ length: PEAK_SIZE ** 2 }, (_, index) => {
    const column = index % PEAK_SIZE;
    const row = Math.floor(index / PEAK_SIZE);
    return 5 * Math.exp(-(((column - centre) ** 2 + (row - centre) ** 2) / PEAK_WIDTH));
  });
}

function samplePeak([x, y]: [number, number]): number {
  const centre = (PEAK_SIZE - 1) / 2;
  return 5 * Math.exp(-(((x - centre) ** 2 + (y - centre) ** 2) / PEAK_WIDTH));
}

function saddleField(size = SADDLE_SIZE, scale = 5): number[] {
  const centre = (size - 1) / 2;
  return Array.from({ length: size ** 2 }, (_, index) => {
    const column = index % size;
    const row = Math.floor(index / size);
    return ((column - centre) ** 2 - (row - centre) ** 2) / scale;
  });
}

function sampleSaddle([x, y]: [number, number]): number {
  const centre = (SADDLE_SIZE - 1) / 2;
  return ((x - centre) ** 2 - (y - centre) ** 2) / 5;
}

function ringField(): number[] {
  return Array.from({ length: 25 }, (_, index) => {
    const row = Math.floor(index / 5);
    const column = index % 5;
    const corner = (row === 0 || row === 4) && (column === 0 || column === 4);
    return corner ? NaN : row - 2;
  });
}

function quadraticField(size: number): number[] {
  const centre = (size - 1) / 2;
  return Array.from({ length: size ** 2 }, (_, index) => {
    const column = index % size;
    const row = Math.floor(index / size);
    return 5 - ((column - centre) ** 2 + (row - centre) ** 2);
  });
}

function ridgeField(): number[] {
  return Array.from({ length: 35 }, (_, index) => {
    const row = Math.floor(index / 7);
    const column = index % 7;
    return row === 2 && column >= 1 && column <= 5 ? 5 : 0;
  });
}

function bilinearAt(
  values: ArrayLike<number>,
  nx: number,
  x: number,
  y: number,
): number {
  const ny = values.length / nx;
  const column = Math.min(Math.floor(x), nx - 2);
  const row = Math.min(Math.floor(y), ny - 2);
  const top = row * nx + column;
  const across = x - column;
  const down = y - row;
  const above = values[top] + (values[top + 1] - values[top]) * across;
  const below = values[top + nx] + (values[top + nx + 1] - values[top + nx]) * across;

  return above + (below - above) * down;
}

function maximumFieldError(
  coordinates: readonly [number, number][],
  value: number,
  sample: ([x, y]: [number, number]) => number,
): number {
  let worst = 0;
  for (let index = 1; index < coordinates.length; index++) {
    for (let step = 0; step <= SAMPLE_STEPS; step++) {
      const point = alongSegment(coordinates[index - 1], coordinates[index], step / SAMPLE_STEPS);
      const error = Math.abs(sample(point) - value);
      if (Number.isFinite(error)) worst = Math.max(worst, error);
    }
  }
  return worst;
}

function maximumTurnDegrees(lines: readonly Isoline[]): number {
  let maximum = 0;
  for (const { coordinates } of lines) {
    const closed = isClosed(coordinates);
    for (let index = closed ? 0 : 1; index + 1 < coordinates.length; index++) {
      const before = index > 0 ? coordinates[index - 1] : coordinates[coordinates.length - 2];
      maximum = Math.max(
        maximum,
        angleBetweenDegrees(
          segmentDirection(before, coordinates[index]),
          segmentDirection(coordinates[index], coordinates[index + 1]),
        ),
      );
    }
  }
  return maximum;
}

function isClosed(coordinates: readonly [number, number][]): boolean {
  const first = coordinates[0];
  const last = coordinates.at(-1)!;
  return coordinates.length > 2 && first[0] === last[0] && first[1] === last[1];
}

function samePoint(
  [leftColumn, leftRow]: [number, number],
  [rightColumn, rightRow]: [number, number],
): boolean {
  return leftColumn === rightColumn && leftRow === rightRow;
}

function junctionMeetingCount(
  lines: readonly Isoline[],
  junction: [number, number],
): number {
  let meeting = 0;
  for (const { coordinates } of lines) {
    for (let index = 1; index < coordinates.length; index++) {
      if (samePoint(coordinates[index - 1], junction)
        || samePoint(coordinates[index], junction)) meeting++;
    }
  }
  return meeting;
}

function loopSpan({ coordinates }: Isoline): number {
  const columns = coordinates.map(([column]) => column);
  const rows = coordinates.map(([, row]) => row);
  return Math.max(
    Math.max(...columns) - Math.min(...columns),
    Math.max(...rows) - Math.min(...rows),
  );
}

function openEndpoints(lines: readonly Isoline[]): [number, number][] {
  return lines
    .filter(({ coordinates }) => !isClosed(coordinates))
    .flatMap(({ coordinates }) => [coordinates[0], coordinates.at(-1)!])
    .sort(([leftColumn, leftRow], [rightColumn, rightRow]) =>
      leftColumn - rightColumn || leftRow - rightRow,
    );
}

function assertNoLevelCrossings(lines: readonly Isoline[]): void {
  const segments = lines.flatMap(
    ({ value, coordinates }) =>
      coordinates.slice(1).map((end, index) => ({ value, start: coordinates[index], end })),
  );
  for (let left = 0; left < segments.length; left++) {
    for (let right = left + 1; right < segments.length; right++) {
      if (segments[left].value === segments[right].value) continue;
      assert.ok(!segmentsCross(segments[left], segments[right]), "levels crossed");
    }
  }
}

function segmentsCross(
  left: { start: [number, number]; end: [number, number] },
  right: { start: [number, number]; end: [number, number] },
): boolean {
  if (Math.max(left.start[0], left.end[0]) < Math.min(right.start[0], right.end[0])
    || Math.max(right.start[0], right.end[0]) < Math.min(left.start[0], left.end[0])
    || Math.max(left.start[1], left.end[1]) < Math.min(right.start[1], right.end[1])
    || Math.max(right.start[1], right.end[1]) < Math.min(left.start[1], left.end[1])) return false;

  return orientation(left.start, left.end, right.start)
      * orientation(left.start, left.end, right.end) <= 0
    && orientation(right.start, right.end, left.start)
      * orientation(right.start, right.end, left.end) <= 0;
}

function orientation(
  start: [number, number],
  end: [number, number],
  point: [number, number],
): number {
  return (end[0] - start[0]) * (point[1] - start[1])
    - (end[1] - start[1]) * (point[0] - start[0]);
}

function segmentDirection(
  start: [number, number],
  end: [number, number],
): [number, number] {
  return [end[0] - start[0], end[1] - start[1]];
}

function angleBetweenDegrees(
  left: [number, number],
  right: [number, number],
): number {
  const cosine = (left[0] * right[0] + left[1] * right[1])
    / (Math.hypot(...left) * Math.hypot(...right));
  return Math.acos(Math.min(1, Math.max(-1, cosine))) * 180 / Math.PI;
}

function alongSegment(
  start: [number, number],
  end: [number, number],
  along: number,
): [number, number] {
  return [start[0] + (end[0] - start[0]) * along, start[1] + (end[1] - start[1]) * along];
}

function cellsWithNoData(values: ArrayLike<number>, nx: number, ny: number): [number, number][] {
  const cells: [number, number][] = [];
  for (let row = 0; row + 1 < ny; row++) {
    for (let column = 0; column + 1 < nx; column++) {
      const top = row * nx + column;
      const corners = [values[top], values[top + 1], values[top + nx], values[top + nx + 1]];
      if (corners.some((value) => !Number.isFinite(value))) cells.push([column, row]);
    }
  }
  return cells;
}
