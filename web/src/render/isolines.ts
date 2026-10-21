/** Trace marching-squares isolines and choose stable intervals for temperature displays. */
import type { GridDoc } from "../types";

/** A traced isoline in fractional cell coordinates, where whole numbers are cell centres. */
export interface Isoline {
  value: number;
  coordinates: [number, number][];
}

type Point = [number, number];
type Segment = [Point, Point];
type Edge = "top" | "right" | "bottom" | "left";
type Corners = [number, number, number, number];
type FieldSampler = (x: number, y: number) => number;

interface ScalarField {
  values: ArrayLike<number>;
  nx: number;
  ny: number;
}

interface SmoothField extends ScalarField {
  modes: Uint8Array;
  coefficients: Float64Array;
  edgeClamps: Uint8Array;
}

interface CellTrace {
  sample?: FieldSampler;
  crossings?: Map<number, Point>;
  crossingWidth?: number;
  level: number;
  segments: Segment[];
  seen: Set<string>;
}

/** Every fifth line is bold. */
export const BOLD_ISOTHERM_MULTIPLE = 5;

/** The casing width as a multiple of the line width, which keeps their dashes aligned. */
export const ISOTHERM_CASING_RATIO = 1.6;
/** Dash and gap lengths in multiples of the line width, shared by a line and its casing. */
export const ISOTHERM_DASH_PATTERN = [3, 2];

const FIRST_ISOTHERM_INTERVAL_DEG = 0.5;
const INTERVAL_MULTIPLIERS = [1, 2, 5];
const MAX_ISOTHERM_LEVELS = 12;
const LEVEL_DIGITS = 6;
const COORDINATE_SCALE = 1e6;
const REFINEMENT_FACTOR = 4;
// Bounds the extra cells spent on steep fields whose chords keep missing the bound.
const MAX_SUBDIVISION_DEPTH = 4;
const CHORD_ERROR_DEG = 0.05;
const MAX_CROSSING_ITERATIONS = 28;
const CROSSING_BISECTION_PERIOD = 4;
const CROSSING_VALUE_TOLERANCE_DEG = 1e-10;
// Integer edge keys avoid coordinate strings in the crossing cache's hot path.
const SUBDIVISION_SCALE = REFINEMENT_FACTOR * 2 ** MAX_SUBDIVISION_DEPTH;
const CROSSING_KEY_STRIDE = 2 * 2 ** MAX_SUBDIVISION_DEPTH + 2;
const EMPTY_EDGES: [Edge, Edge][] = [];
const EDGE_FLAGS: Record<Edge, number> = { top: 1, bottom: 2, left: 4, right: 8 };

const CASE_EDGES: Record<number, [Edge, Edge][]> = {
  1: [["left", "top"]],
  2: [["top", "right"]],
  3: [["left", "right"]],
  4: [["right", "bottom"]],
  6: [["top", "bottom"]],
  7: [["left", "bottom"]],
  8: [["bottom", "left"]],
  9: [["top", "bottom"]],
  11: [["right", "bottom"]],
  12: [["left", "right"]],
  13: [["top", "right"]],
  14: [["left", "top"]],
};

const SADDLE_5_HIGH: [Edge, Edge][] = [["top", "right"], ["bottom", "left"]];
const SADDLE_5_LOW: [Edge, Edge][] = [["left", "top"], ["right", "bottom"]];
const SADDLE_10_HIGH: [Edge, Edge][] = [["left", "top"], ["right", "bottom"]];
const SADDLE_10_LOW: [Edge, Edge][] = [["top", "right"], ["bottom", "left"]];

/** The smallest fixed interval that keeps the scene at twelve isotherm levels or fewer. */
export function isolineInterval(stops: readonly number[]): number {
  const low = stops[0];
  const high = stops[stops.length - 1];
  let interval = FIRST_ISOTHERM_INTERVAL_DEG;
  while (isolineLevels(low, high, interval).length > MAX_ISOTHERM_LEVELS) {
    interval = nextNiceInterval(interval);
  }
  return interval;
}

/** The next 1-2-5 step above an interval, so the ladder never runs out. */
function nextNiceInterval(interval: number): number {
  const decade = 10 ** Math.floor(Math.log10(interval));
  const multiplier = interval / decade;
  const next = INTERVAL_MULTIPLIERS.find((candidate) => candidate > multiplier);
  return next === undefined ? 10 * decade : next * decade;
}

/** Every multiple of interval from low through high, rounded for stable labels. */
export function isolineLevels(low: number, high: number, interval: number): number[] {
  const first = Math.ceil(low / interval);
  const last = Math.floor(high / interval);
  const levels: number[] = [];
  for (let multiple = first; multiple <= last; multiple++) {
    levels.push(Number((multiple * interval).toPrecision(LEVEL_DIGITS)));
  }
  return levels;
}

/**
 * Trace each level through a row-major grid with marching squares. A cell with any no-data
 * corner is skipped, and adjacent segments share endpoints so they chain into polylines.
 * With refine, every fully finite quad is subdivided four times per axis with a clamped
 * bicubic field, and any chord that bows away from that field is subdivided further.
 */
export function traceIsolines(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  levels: readonly number[],
  refine = false,
): Isoline[] {
  if (!refine || nx < 2 || ny < 2) {
    return levels.flatMap((level) => traceLevel(values, nx, ny, level));
  }

  const sample = createSmoothSampler(values, nx, ny);
  const refined = refineField(sample, nx, ny);
  const scale = 1 / REFINEMENT_FACTOR;
  return traceRefinedLevels(refined, sample, levels, scale);
}

function traceLevel(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  level: number,
): Isoline[] {
  const trace: CellTrace = {
    level,
    segments: [],
    seen: new Set(),
  };
  // Reuse one corner array per level so the hot loop does not allocate per cell.
  const corners: Corners = [0, 0, 0, 0];
  for (let row = 0; row + 1 < ny; row++) {
    for (let column = 0; column + 1 < nx; column++) {
      const top = row * nx + column;
      corners[0] = values[top];
      corners[1] = values[top + 1];
      corners[2] = values[top + nx + 1];
      corners[3] = values[top + nx];
      if (!Number.isFinite(corners[0]) || !Number.isFinite(corners[1])
        || !Number.isFinite(corners[2]) || !Number.isFinite(corners[3])) continue;

      const segments = cellSegments(trace, column, row, 1, corners, cellEdges(corners, level));
      appendSegments(trace, segments);
    }
  }
  return chainSegments(trace.segments, level);
}

function traceRefinedLevels(
  refined: ScalarField,
  sample: FieldSampler,
  levels: readonly number[],
  scale: number,
): Isoline[] {
  const traces: CellTrace[] = levels.map((level) => ({
    sample,
    crossings: new Map(),
    crossingWidth: (refined.nx - 1) * 2 ** MAX_SUBDIVISION_DEPTH + 1,
    level,
    segments: [],
    seen: new Set(),
  }));
  const corners: Corners = [0, 0, 0, 0];
  const factor = REFINEMENT_FACTOR;
  for (let row = 0; row + factor < refined.ny; row += factor) {
    for (let column = 0; column + factor < refined.nx; column += factor) {
      const top = row * refined.nx + column;
      corners[0] = refined.values[top];
      corners[1] = refined.values[top + factor];
      corners[2] = refined.values[top + factor * refined.nx + factor];
      corners[3] = refined.values[top + factor * refined.nx];
      if (!Number.isFinite(corners[0]) || !Number.isFinite(corners[1])
        || !Number.isFinite(corners[2]) || !Number.isFinite(corners[3])) continue;

      const low = Math.min(corners[0], corners[1], corners[2], corners[3]);
      const high = Math.max(corners[0], corners[1], corners[2], corners[3]);
      for (const trace of traces) {
        if (trace.level <= low || trace.level > high) continue;
        traceRefinedQuad(trace, refined, column, row, scale);
      }
    }
  }
  return traces.flatMap((trace) => chainSegments(trace.segments, trace.level));
}

function traceRefinedQuad(
  trace: CellTrace,
  refined: ScalarField,
  column: number,
  row: number,
  scale: number,
) {
  const corners: Corners = [0, 0, 0, 0];
  for (let localRow = row; localRow < row + REFINEMENT_FACTOR; localRow++) {
    for (let localColumn = column; localColumn < column + REFINEMENT_FACTOR; localColumn++) {
      const top = localRow * refined.nx + localColumn;
      corners[0] = refined.values[top];
      corners[1] = refined.values[top + 1];
      corners[2] = refined.values[top + refined.nx + 1];
      corners[3] = refined.values[top + refined.nx];
      collectCellSegments(trace, localColumn * scale, localRow * scale, scale, corners, 0);
    }
  }
}

function collectCellSegments(
  trace: CellTrace,
  x: number,
  y: number,
  size: number,
  corners: Corners,
  depth: number,
) {
  const edges = cellEdges(corners, trace.level);
  if (edges.length === 0) return;

  const segments = cellSegments(trace, x, y, size, corners, edges);
  // A finite cell can still bow away from the smoothed surface between its crossings.
  if (depth < MAX_SUBDIVISION_DEPTH && segments.some(([start, end]) =>
    chordErrorDegrees(trace.sample!, start, end, trace.level) > CHORD_ERROR_DEG,
  )) {
    subdivideCell(trace, x, y, size, corners, depth + 1);
    return;
  }
  appendSegments(trace, segments);
}

function subdivideCell(
  trace: CellTrace,
  x: number,
  y: number,
  size: number,
  [topLeft, topRight, bottomRight, bottomLeft]: Corners,
  depth: number,
) {
  const half = size / 2;
  const sample = trace.sample!;
  const topMiddle = sample(x + half, y);
  const rightMiddle = sample(x + size, y + half);
  const bottomMiddle = sample(x + half, y + size);
  const leftMiddle = sample(x, y + half);
  const centre = sample(x + half, y + half);

  collectCellSegments(trace, x, y, half, [topLeft, topMiddle, centre, leftMiddle], depth);
  collectCellSegments(
    trace,
    x + half,
    y,
    half,
    [topMiddle, topRight, rightMiddle, centre],
    depth,
  );
  collectCellSegments(
    trace,
    x + half,
    y + half,
    half,
    [centre, rightMiddle, bottomRight, bottomMiddle],
    depth,
  );
  collectCellSegments(
    trace,
    x,
    y + half,
    half,
    [leftMiddle, centre, bottomMiddle, bottomLeft],
    depth,
  );
}

function cellSegments(
  trace: CellTrace,
  x: number,
  y: number,
  size: number,
  corners: Corners,
  edges: readonly [Edge, Edge][],
): Segment[] {
  return edges.map(([from, to]) => [
    crossingPoint(trace, from, x, y, size, corners),
    crossingPoint(trace, to, x, y, size, corners),
  ]);
}

function appendSegments(trace: CellTrace, segments: Segment[]) {
  for (const [start, end] of segments) {
    if (pointKey(start) === pointKey(end)) continue;

    const key = segmentKey(start, end);
    if (trace.seen.has(key)) continue;

    trace.seen.add(key);
    trace.segments.push([start, end]);
  }
}

function crossingPoint(
  { sample, crossings, crossingWidth, level }: CellTrace,
  edge: Edge,
  x: number,
  y: number,
  size: number,
  corners: Corners,
): Point {
  const linear = cellPoint(x, y, size, edgePoint(edge, 0, 0, corners, level));
  if (!sample) return linear;

  const horizontal = edge === "top" || edge === "bottom";
  const start: Point = [edge === "right" ? x + size : x, edge === "bottom" ? y + size : y];
  const end: Point = [start[0] + (horizontal ? size : 0), start[1] + (horizontal ? 0 : size)];
  const startIndex = Math.round(start[0] * SUBDIVISION_SCALE)
    + Math.round(start[1] * SUBDIVISION_SCALE) * crossingWidth!;
  const key = startIndex * CROSSING_KEY_STRIDE
    + Math.round(size * SUBDIVISION_SCALE) * 2 + (horizontal ? 0 : 1);
  const cached = crossings!.get(key);
  if (cached) return cached;

  const point = solveCrossing(sample, start, end, linear, level);
  crossings!.set(key, point);
  return point;
}

function cellPoint(x: number, y: number, size: number, [across, down]: Point): Point {
  return [x + across * size, y + down * size];
}

function solveCrossing(
  sample: FieldSampler,
  start: Point,
  end: Point,
  linear: Point,
  level: number,
): Point {
  const horizontal = start[1] === end[1];
  const axis = horizontal ? 0 : 1;
  const size = end[axis] - start[axis];
  let low = 0;
  let high = 1;
  let startValue = sample(...start);
  let endValue = sample(...end);
  if (startValue === level) return start;
  if (endValue === level) return end;

  // Solve the shared field rather than a cell's chord so unequal subdivisions still join.
  let point = linear;
  for (let iteration = 0; iteration < MAX_CROSSING_ITERATIONS; iteration++) {
    const value = sample(...point);
    if (Math.abs(value - level) <= CROSSING_VALUE_TOLERANCE_DEG) return point;
    const along = (point[axis] - start[axis]) / size;
    if ((value < level) === (startValue < level)) {
      low = along;
      startValue = value;
    } else {
      high = along;
      endValue = value;
    }
    const middle = iteration % CROSSING_BISECTION_PERIOD === CROSSING_BISECTION_PERIOD - 1
      ? (low + high) / 2
      : low + (high - low) * (level - startValue) / (endValue - startValue);
    point = [
      start[0] + (end[0] - start[0]) * middle,
      start[1] + (end[1] - start[1]) * middle,
    ];
  }
  return point;
}

function chordErrorDegrees(
  sample: FieldSampler,
  start: Point,
  end: Point,
  level: number,
): number {
  let error = 0;
  for (const along of [0.25, 0.5, 0.75]) {
    const across = start[0] + (end[0] - start[0]) * along;
    const down = start[1] + (end[1] - start[1]) * along;
    error = Math.max(error, Math.abs(sample(across, down) - level));
  }
  return error;
}

/**
 * Sample the bicubic field that Smooth traces at fractional grid coordinates. Quads without
 * a full 4x4 neighbourhood use bilinear, so a missing sample is never bridged.
 * Shared edges are bounded consistently so clamping and fallback cannot split a contour.
 */
export function sampleSmoothField(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  x: number,
  y: number,
): number {
  return createSmoothSampler(values, nx, ny)(x, y);
}

function createSmoothSampler(values: ArrayLike<number>, nx: number, ny: number): FieldSampler {
  const field = { values, nx, ny };
  const modes = quadModes(field);
  const coefficients = cubicCoefficients(field, modes);
  const smooth = { ...field, modes, coefficients, edgeClamps: new Uint8Array(modes.length) };
  prepareBoundaries(smooth);
  return (x, y) => sampleSmoothQuad(smooth, x, y);
}

function quadModes(field: ScalarField): Uint8Array {
  const { nx, ny } = field;
  const modes = new Uint8Array(Math.max(0, nx - 1) * Math.max(0, ny - 1));
  for (let row = 0; row + 1 < ny; row++) {
    for (let column = 0; column + 1 < nx; column++) {
      if (hasFullNeighbourhood(field, column, row)) {
        modes[row * (nx - 1) + column] = 1;
      }
    }
  }
  return modes;
}

function hasFullNeighbourhood(
  { values, nx, ny }: ScalarField,
  column: number,
  row: number,
): boolean {
  if (column < 1 || row < 1 || column + 2 >= nx || row + 2 >= ny) return false;

  for (let localRow = row - 1; localRow <= row + 2; localRow++) {
    const start = localRow * nx + column - 1;
    for (let localColumn = 0; localColumn < 4; localColumn++) {
      if (!Number.isFinite(values[start + localColumn])) return false;
    }
  }
  return true;
}

function cubicCoefficients(field: ScalarField, modes: Uint8Array): Float64Array {
  const { values, nx, ny } = field;
  const coefficients = new Float64Array(modes.length * 16);
  const rows = new Float64Array(16);
  for (let row = 1; row + 2 < ny; row++) {
    for (let column = 1; column + 2 < nx; column++) {
      const quad = row * (nx - 1) + column;
      if (!modes[quad]) continue;
      for (let offset = -1; offset <= 2; offset++) {
        const start = (row + offset) * nx + column;
        writeCubicPolynomial(
          rows,
          (offset + 1) * 4,
          1,
          values[start - 1],
          values[start],
          values[start + 1],
          values[start + 2],
        );
      }
      for (let power = 0; power < 4; power++) {
        writeCubicPolynomial(
          coefficients,
          quad * 16 + power,
          4,
          rows[power],
          rows[4 + power],
          rows[8 + power],
          rows[12 + power],
        );
      }
    }
  }
  return coefficients;
}

function writeCubicPolynomial(
  output: Float64Array,
  start: number,
  stride: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number,
) {
  output[start] = p1;
  output[start + stride] = (p2 - p0) / 2;
  output[start + 2 * stride] = p0 - 2.5 * p1 + 2 * p2 - p3 / 2;
  output[start + 3 * stride] = (3 * p1 - 3 * p2 + p3 - p0) / 2;
}

function prepareBoundaries(field: SmoothField) {
  const { nx, ny, modes } = field;
  const polynomial = new Float64Array(4);
  for (let row = 1; row + 2 < ny; row++) {
    for (let column = 1; column + 2 < nx; column++) {
      const quad = row * (nx - 1) + column;
      if (!modes[quad]) continue;
      prepareBoundary(field, quad, "top", modes[quad - (nx - 1)], polynomial);
      prepareBoundary(field, quad, "bottom", modes[quad + (nx - 1)], polynomial);
      prepareBoundary(field, quad, "left", modes[quad - 1], polynomial);
      prepareBoundary(field, quad, "right", modes[quad + 1], polynomial);
    }
  }
}

function prepareBoundary(
  { coefficients, edgeClamps }: SmoothField,
  quad: number,
  edge: Edge,
  neighbour: number,
  polynomial: Float64Array,
) {
  const horizontal = edge === "top" || edge === "bottom";
  const stride = horizontal ? 1 : 4;
  const inward = horizontal ? 4 : 1;
  const near = edge === "top" || edge === "left";
  for (let power = 0; power < 4; power++) {
    const index = quad * 16 + power * stride;
    polynomial[power] = near ? coefficients[index]
      : coefficients[index] + coefficients[index + inward]
        + coefficients[index + 2 * inward] + coefficients[index + 3 * inward];
  }
  if (neighbour) {
    if (polynomialOvershoots(polynomial)) edgeClamps[quad] |= EDGE_FLAGS[edge];
    return;
  }

  // A bilinear neighbour fixes the shared edge, without changing the opposite edge.
  for (let power = 1; power < 4; power++) {
    const delta = power === 1 ? polynomial[2] + polynomial[3] : -polynomial[power];
    const index = quad * 16 + power * stride;
    if (near) coefficients[index] += delta;
    coefficients[index + 2 * inward] += (near ? -3 : 3) * delta;
    coefficients[index + 3 * inward] += (near ? 2 : -2) * delta;
  }
}

function polynomialOvershoots(polynomial: Float64Array): boolean {
  const [constant, linear, quadratic, cubic] = polynomial;
  const end = constant + linear + quadratic + cubic;
  const low = Math.min(constant, end);
  const high = Math.max(constant, end);
  const discriminant = quadratic * quadratic - 3 * cubic * linear;
  if (cubic === 0) return polynomialOutsideRange(polynomial, -linear / (2 * quadratic), low, high);
  if (discriminant < 0) return false;

  const root = Math.sqrt(discriminant);
  return polynomialOutsideRange(polynomial, (-quadratic - root) / (3 * cubic), low, high)
    || polynomialOutsideRange(polynomial, (-quadratic + root) / (3 * cubic), low, high);
}

function polynomialOutsideRange(
  polynomial: Float64Array,
  along: number,
  low: number,
  high: number,
): boolean {
  if (!(along > 0 && along < 1)) return false;

  const value = polynomialValue(polynomial, 0, along);
  return value < low || value > high;
}

function sampleSmoothQuad(
  field: SmoothField,
  x: number,
  y: number,
): number {
  const { values, nx, ny, modes } = field;
  if (x < 0 || y < 0 || x > nx - 1 || y > ny - 1 || nx < 2 || ny < 2) return NaN;
  if (Number.isInteger(x) && Number.isInteger(y)) return values[y * nx + x];

  const column = Math.max(0, Math.min(Math.floor(x), nx - 2));
  const row = Math.max(0, Math.min(Math.floor(y), ny - 2));
  const across = x - column;
  const down = y - row;
  if (Number.isInteger(y)) return sampleEdge(field, column, y, across, true);
  if (Number.isInteger(x)) return sampleEdge(field, x, row, down, false);
  return interpolateQuad(field, column, row, across, down, modes[row * (nx - 1) + column] === 1);
}

function sampleEdge(
  field: SmoothField,
  column: number,
  row: number,
  along: number,
  horizontal: boolean,
): number {
  const { values, nx, modes } = field;
  const start = row * nx + column;
  const stride = horizontal ? 1 : nx;
  const first = values[start];
  const last = values[start + stride];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return NaN;

  const quad = row * (nx - 1) + column;
  const before = horizontal ? quad - (nx - 1) : quad - 1;
  const bothBicubic = (horizontal ? row > 0 && row < field.ny - 1 : column > 0 && column < nx - 1)
    && modes[before] === 1 && modes[quad] === 1;
  if (!bothBicubic) return first + (last - first) * along;

  const value = catmullRom(values[start - stride], first, last, values[start + 2 * stride], along);
  return Math.min(Math.max(first, last), Math.max(Math.min(first, last), value));
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, along: number): number {
  const squared = along * along;
  const cubed = squared * along;
  return 0.5 * (
    2 * p1
    + (p2 - p0) * along
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * squared
    + (3 * p1 - 3 * p2 + p3 - p0) * cubed
  );
}

function interpolateQuad(
  field: SmoothField,
  column: number,
  row: number,
  across: number,
  down: number,
  useBicubic: boolean,
): number {
  const { values, nx } = field;
  const top = row * nx + column;
  if (!isFiniteQuad(values, top, nx)) return NaN;
  const topLeft = values[top];
  const topRight = values[top + 1];
  const bottomRight = values[top + nx + 1];
  const bottomLeft = values[top + nx];
  if (!useBicubic) return bilinearQuad(topLeft, topRight, bottomRight, bottomLeft, across, down);

  const value = boundedBicubicValue(field, column, row, across, down);
  const low = Math.min(topLeft, topRight, bottomRight, bottomLeft);
  const high = Math.max(topLeft, topRight, bottomRight, bottomLeft);
  return Math.min(high, Math.max(low, value));
}

function isFiniteQuad(values: ArrayLike<number>, top: number, nx: number): boolean {
  return Number.isFinite(values[top])
    && Number.isFinite(values[top + 1])
    && Number.isFinite(values[top + nx])
    && Number.isFinite(values[top + nx + 1]);
}

function bilinearQuad(
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
  across: number,
  down: number,
): number {
  const top = topLeft + (topRight - topLeft) * across;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * across;
  return top + (bottom - top) * down;
}

function boundedBicubicValue(
  field: SmoothField,
  column: number,
  row: number,
  across: number,
  down: number,
): number {
  const { nx, coefficients, edgeClamps } = field;
  const quad = row * (nx - 1) + column;
  const start = quad * 16;
  const constantRow = polynomialValue(coefficients, start, across);
  const linearRow = polynomialValue(coefficients, start + 4, across);
  const quadraticRow = polynomialValue(coefficients, start + 8, across);
  const cubicRow = polynomialValue(coefficients, start + 12, across);
  const value = constantRow + down * (linearRow + down * (quadraticRow + down * cubicRow));
  const clamps = edgeClamps[quad];
  if (!clamps) return value;

  const left = polynomialColumn(coefficients, start, down);
  const right = polynomialColumn(coefficients, start + 1, down)
    + polynomialColumn(coefficients, start + 2, down)
    + polynomialColumn(coefficients, start + 3, down) + left;
  // Cubic weights preserve the opposite boundary's tangent when an edge needs clamping.
  const topCorrection = clamps & EDGE_FLAGS.top
    ? sampleEdge(field, column, row, across, true) - constantRow : 0;
  const bottomCorrection = clamps & EDGE_FLAGS.bottom
    ? sampleEdge(field, column, row + 1, across, true)
      - (constantRow + linearRow + quadraticRow + cubicRow) : 0;
  const leftCorrection = clamps & EDGE_FLAGS.left
    ? sampleEdge(field, column, row, down, false) - left : 0;
  const rightCorrection = clamps & EDGE_FLAGS.right
    ? sampleEdge(field, column + 1, row, down, false) - right : 0;
  const acrossWeight = across * across * (3 - 2 * across);
  const downWeight = down * down * (3 - 2 * down);
  return value
    + (1 - downWeight) * topCorrection + downWeight * bottomCorrection
    + (1 - acrossWeight) * leftCorrection + acrossWeight * rightCorrection;
}

function polynomialValue(coefficients: Float64Array, start: number, along: number): number {
  return coefficients[start] + along * (coefficients[start + 1]
    + along * (coefficients[start + 2] + along * coefficients[start + 3]));
}

function polynomialColumn(coefficients: Float64Array, start: number, along: number): number {
  return coefficients[start] + along * (coefficients[start + 4]
    + along * (coefficients[start + 8] + along * coefficients[start + 12]));
}

function refineField(sample: FieldSampler, nx: number, ny: number): ScalarField {
  const refinedNx = (nx - 1) * REFINEMENT_FACTOR + 1;
  const refinedNy = (ny - 1) * REFINEMENT_FACTOR + 1;
  const refined = new Float64Array(refinedNx * refinedNy);
  for (let row = 0; row < refinedNy; row++) {
    for (let column = 0; column < refinedNx; column++) {
      refined[row * refinedNx + column] = sample(
        column / REFINEMENT_FACTOR,
        row / REFINEMENT_FACTOR,
      );
    }
  }
  return { values: refined, nx: refinedNx, ny: refinedNy };
}

function cellEdges([topLeft, topRight, bottomRight, bottomLeft]: Corners, level: number) {
  const cellCase = (topLeft >= level ? 1 : 0)
    + (topRight >= level ? 2 : 0)
    + (bottomRight >= level ? 4 : 0)
    + (bottomLeft >= level ? 8 : 0);
  if (cellCase === 5 || cellCase === 10) {
    // An exact tie counts as high so the pairing stays deterministic.
    const joinsHigh = saddleValue(topLeft, topRight, bottomRight, bottomLeft) >= level;
    if (cellCase === 5) return joinsHigh ? SADDLE_5_HIGH : SADDLE_5_LOW;

    return joinsHigh ? SADDLE_10_HIGH : SADDLE_10_LOW;
  }
  return CASE_EDGES[cellCase] ?? EMPTY_EDGES;
}

function saddleValue(
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
): number {
  return (topLeft * bottomRight - topRight * bottomLeft)
    / (topLeft + bottomRight - topRight - bottomLeft);
}

function edgePoint(
  edge: Edge,
  column: number,
  row: number,
  [topLeft, topRight, bottomRight, bottomLeft]: Corners,
  level: number,
): Point {
  if (edge === "top") return [column + fraction(topLeft, topRight, level), row];
  if (edge === "right") return [column + 1, row + fraction(topRight, bottomRight, level)];
  if (edge === "bottom") return [column + fraction(bottomLeft, bottomRight, level), row + 1];

  return [column, row + fraction(topLeft, bottomLeft, level)];
}

function fraction(start: number, end: number, level: number) {
  return (level - start) / (end - start);
}

function chainSegments(segments: Segment[], value: number): Isoline[] {
  const byEndpoint = new Map<string, number[]>();
  segments.forEach(([start, end], index) => {
    addSegment(byEndpoint, pointKey(start), index);
    addSegment(byEndpoint, pointKey(end), index);
  });

  const used = new Array<boolean>(segments.length).fill(false);
  const lines: Isoline[] = [];
  for (const [index, [start, end]] of segments.entries()) {
    if (used[index]) continue;

    used[index] = true;
    const coordinates: Point[] = [start, end];
    coordinates.push(...extendPolyline(end, segments, used, byEndpoint));
    coordinates.unshift(...extendPolyline(start, segments, used, byEndpoint).reverse());
    lines.push({ value, coordinates });
  }
  return lines;
}

function addSegment(byEndpoint: Map<string, number[]>, key: string, index: number) {
  const indexes = byEndpoint.get(key);
  if (indexes) indexes.push(index);
  else byEndpoint.set(key, [index]);
}

function extendPolyline(
  start: Point,
  segments: Segment[],
  used: boolean[],
  byEndpoint: Map<string, number[]>,
): Point[] {
  const points: Point[] = [];
  let current = start;
  while (true) {
    const key = pointKey(current);
    const nextIndex = byEndpoint.get(key)?.find((index) => !used[index]);
    if (nextIndex === undefined) return points;

    used[nextIndex] = true;
    const [nextStart, nextEnd] = segments[nextIndex];
    current = pointKey(nextStart) === key ? nextEnd : nextStart;
    points.push(current);
  }
}

function segmentKey(start: Point, end: Point): string {
  const startKey = pointKey(start);
  const endKey = pointKey(end);
  return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
}

function pointKey([x, y]: Point) {
  return `${Math.round(x * COORDINATE_SCALE)},${Math.round(y * COORDINATE_SCALE)}`;
}

/** Convert fractional cell coordinates to [longitude, latitude], moved east by shift. */
export function toLngLat(
  coordinates: readonly Point[],
  { bbox, nx, ny }: Pick<GridDoc, "bbox" | "nx" | "ny">,
  shift: number,
): Point[] {
  const [west, south, east, north] = bbox;
  const degreesPerColumn = (east - west) / nx;
  const degreesPerRow = (north - south) / ny;

  // Values sample cell centres, which sit half a cell inside the grid bbox.
  return coordinates.map(([column, row]) => [
    west + (column + 0.5) * degreesPerColumn + shift,
    north - (row + 0.5) * degreesPerRow,
  ]);
}
