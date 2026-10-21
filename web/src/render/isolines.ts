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

interface ScalarField {
  values: ArrayLike<number>;
  nx: number;
  ny: number;
}

interface CellTrace {
  field: ScalarField;
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
 * With refine, every fully finite quad is bilinearly subdivided, and any chord that bows
 * away from the native bilinear surface is subdivided further.
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

  const refined = refineField(values, nx, ny, REFINEMENT_FACTOR);
  const native = { values, nx, ny };
  const scale = 1 / REFINEMENT_FACTOR;
  return levels.flatMap((level) => traceRefinedLevel(refined, native, level, scale));
}

function traceLevel(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  level: number,
): Isoline[] {
  const trace: CellTrace = {
    field: { values, nx, ny },
    level,
    segments: [],
    seen: new Set(),
  };
  for (let row = 0; row + 1 < ny; row++) {
    for (let column = 0; column + 1 < nx; column++) {
      const corners = cellCorners(values, nx, column, row);
      if (corners.some((value) => !Number.isFinite(value))) continue;

      addCellSegments(trace, column, row, 1, corners, cellEdges(corners, level));
    }
  }
  return chainSegments(trace.segments, level);
}

function traceRefinedLevel(
  refined: ScalarField,
  native: ScalarField,
  level: number,
  scale: number,
): Isoline[] {
  const trace: CellTrace = { field: native, level, segments: [], seen: new Set() };
  for (let row = 0; row + 1 < refined.ny; row++) {
    for (let column = 0; column + 1 < refined.nx; column++) {
      const corners = cellCorners(refined.values, refined.nx, column, row);
      if (corners.some((value) => !Number.isFinite(value))) continue;

      collectCellSegments(trace, column * scale, row * scale, scale, corners, 0);
    }
  }
  return chainSegments(trace.segments, level);
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

  // A finite cell can still bow away from the native surface between its crossings.
  if (depth < MAX_SUBDIVISION_DEPTH && needsSubdivision(trace, x, y, size, corners, edges)) {
    subdivideCell(trace, x, y, size, corners, depth + 1);
    return;
  }
  addCellSegments(trace, x, y, size, corners, edges);
}

function needsSubdivision(
  { field, level }: CellTrace,
  x: number,
  y: number,
  size: number,
  corners: Corners,
  edges: readonly [Edge, Edge][],
): boolean {
  return edges.some(([from, to]) => {
    const start = cellPoint(x, y, size, edgePoint(from, 0, 0, corners, level));
    const end = cellPoint(x, y, size, edgePoint(to, 0, 0, corners, level));
    return midpointErrorDegrees(field, start, end, level) > CHORD_ERROR_DEG;
  });
}

function subdivideCell(
  trace: CellTrace,
  x: number,
  y: number,
  size: number,
  [topLeft, topRight, bottomRight, bottomLeft]: Corners,
  depth: number,
) {
  const topMiddle = (topLeft + topRight) / 2;
  const rightMiddle = (topRight + bottomRight) / 2;
  const bottomMiddle = (bottomLeft + bottomRight) / 2;
  const leftMiddle = (topLeft + bottomLeft) / 2;
  const centre = (topLeft + topRight + bottomRight + bottomLeft) / 4;
  const half = size / 2;

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

function addCellSegments(
  trace: CellTrace,
  x: number,
  y: number,
  size: number,
  corners: Corners,
  edges: readonly [Edge, Edge][],
) {
  for (const [from, to] of edges) {
    const start = cellPoint(x, y, size, edgePoint(from, 0, 0, corners, trace.level));
    const end = cellPoint(x, y, size, edgePoint(to, 0, 0, corners, trace.level));
    if (pointKey(start) === pointKey(end)) continue;

    const key = segmentKey(start, end);
    if (trace.seen.has(key)) continue;

    trace.seen.add(key);
    trace.segments.push([start, end]);
  }
}

function cellPoint(x: number, y: number, size: number, [across, down]: Point): Point {
  return [x + across * size, y + down * size];
}

function midpointErrorDegrees(
  field: ScalarField,
  start: Point,
  end: Point,
  level: number,
): number {
  const across = (start[0] + end[0]) / 2;
  const down = (start[1] + end[1]) / 2;
  return Math.abs(sampleBilinear(field, across, down) - level);
}

function sampleBilinear({ values, nx, ny }: ScalarField, x: number, y: number): number {
  const column = Math.min(Math.floor(x), nx - 2);
  const row = Math.min(Math.floor(y), ny - 2);
  const top = row * nx + column;
  const across = x - column;
  const down = y - row;
  const topValue = values[top] + (values[top + 1] - values[top]) * across;
  const bottomValue = values[top + nx] + (values[top + nx + 1] - values[top + nx]) * across;
  return topValue + (bottomValue - topValue) * down;
}

function refineField(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  factor: number,
): ScalarField {
  const refinedNx = (nx - 1) * factor + 1;
  const refinedNy = (ny - 1) * factor + 1;
  const refined = new Float32Array(refinedNx * refinedNy).fill(NaN);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      refined[row * factor * refinedNx + column * factor] = values[row * nx + column];
    }
  }

  for (let row = 0; row + 1 < ny; row++) {
    for (let column = 0; column + 1 < nx; column++) {
      const top = row * nx + column;
      if (isFiniteQuad(values, top, nx)) {
        fillRefinedQuad(refined, refinedNx, values, nx, column, row, factor);
      }
    }
  }
  return { values: refined, nx: refinedNx, ny: refinedNy };
}

function isFiniteQuad(values: ArrayLike<number>, top: number, nx: number): boolean {
  return Number.isFinite(values[top])
    && Number.isFinite(values[top + 1])
    && Number.isFinite(values[top + nx])
    && Number.isFinite(values[top + nx + 1]);
}

function fillRefinedQuad(
  refined: Float32Array,
  refinedNx: number,
  values: ArrayLike<number>,
  nx: number,
  column: number,
  row: number,
  factor: number,
) {
  const top = row * nx + column;
  const topLeft = values[top];
  const topRight = values[top + 1];
  const bottomLeft = values[top + nx];
  const bottomRight = values[top + nx + 1];
  const firstRow = row * factor;
  const firstColumn = column * factor;

  for (let localRow = 0; localRow <= factor; localRow++) {
    const down = localRow / factor;
    const left = topLeft + (bottomLeft - topLeft) * down;
    const right = topRight + (bottomRight - topRight) * down;
    const refinedIndex = (firstRow + localRow) * refinedNx + firstColumn;
    for (let localColumn = 0; localColumn <= factor; localColumn++) {
      if (localColumn % factor === 0 && localRow % factor === 0) continue;
      const across = localColumn / factor;
      refined[refinedIndex + localColumn] = left + (right - left) * across;
    }
  }
}

function cellCorners(
  values: ArrayLike<number>,
  nx: number,
  column: number,
  row: number,
): Corners {
  const top = row * nx + column;
  const bottom = top + nx;

  return [values[top], values[top + 1], values[bottom + 1], values[bottom]];
}

function cellEdges([topLeft, topRight, bottomRight, bottomLeft]: Corners, level: number) {
  const above = (value: number) => (value >= level ? 1 : 0);
  const cellCase =
    above(topLeft) + above(topRight) * 2 + above(bottomRight) * 4 + above(bottomLeft) * 8;
  if (cellCase === 5 || cellCase === 10) {
    // An exact tie counts as high so the pairing stays deterministic.
    const joinsHigh = saddleValue(topLeft, topRight, bottomRight, bottomLeft) >= level;
    if (cellCase === 5) return joinsHigh ? SADDLE_5_HIGH : SADDLE_5_LOW;

    return joinsHigh ? SADDLE_10_HIGH : SADDLE_10_LOW;
  }
  return CASE_EDGES[cellCase] ?? [];
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
