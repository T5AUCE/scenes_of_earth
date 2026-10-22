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

interface ScalarRange {
  low: number;
  high: number;
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

const REFINEMENT_FACTOR = 4;
// Sub-resolution closed features are omitted because they are not readable.
const MIN_CLOSED_LOOP_SPAN_CELLS = 0.25;
const CHAIKIN_PASSES = 2;
const CHAIKIN_FIRST_POINT = 0.25;
const CHAIKIN_SECOND_POINT = 0.75;
const COORDINATE_SCALE = 1e6;

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
const NO_EDGES: [Edge, Edge][] = [];

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
 * Refinement samples a smooth bicubic field four times per axis and rounds each stretch with two
 * Chaikin passes. Every graph vertex that is not a plain degree-two step stays fixed, so trails
 * that meet at a junction keep sharing it, while only an unanchored closed loop wraps.
 */
export function traceIsolines(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  levels: readonly number[],
  refine = false,
): Isoline[] {
  if (levels.length === 0) return [];
  if (!refine || nx < 2 || ny < 2) {
    return traceLevels({ values, nx, ny }, levels, 1, false);
  }

  const field = refineField(values, nx, ny);
  return traceLevels(field, levels, 1 / REFINEMENT_FACTOR, true)
    .filter((line) => keepsLine(line.coordinates));
}

function traceLevels(
  field: ScalarField,
  levels: readonly number[],
  scale: number,
  smooth: boolean,
): Isoline[] {
  const { values, nx, ny } = field;
  const graphs = levels.map(() => new SegmentGraph());
  const corners: Corners = [0, 0, 0, 0];
  for (let row = 0; row + 1 < ny; row++) {
    for (let column = 0; column + 1 < nx; column++) {
      const top = row * nx + column;
      const topLeft = values[top];
      const topRight = values[top + 1];
      const bottomRight = values[top + nx + 1];
      const bottomLeft = values[top + nx];
      if (!Number.isFinite(topLeft) || !Number.isFinite(topRight)
        || !Number.isFinite(bottomRight) || !Number.isFinite(bottomLeft)) continue;

      corners[0] = topLeft;
      corners[1] = topRight;
      corners[2] = bottomRight;
      corners[3] = bottomLeft;
      const low = Math.min(topLeft, topRight, bottomRight, bottomLeft);
      const high = Math.max(topLeft, topRight, bottomRight, bottomLeft);
      for (let index = 0; index < levels.length; index++) {
        const level = levels[index];
        if (level <= low || level > high) continue;
        for (const [from, to] of cellEdges(corners, level)) {
          graphs[index].add(
            edgeCrossing(from, column, row, corners, level),
            edgeCrossing(to, column, row, corners, level),
          );
        }
      }
    }
  }

  return levels.flatMap((level, index) => graphs[index].chain(level, scale, smooth));
}

function cellEdges(corners: Corners, level: number): [Edge, Edge][] {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const cellCase = (topLeft >= level ? 1 : 0)
    + (topRight >= level ? 2 : 0)
    + (bottomRight >= level ? 4 : 0)
    + (bottomLeft >= level ? 8 : 0);
  if (cellCase === 5 || cellCase === 10) {
    // The cell centre picks the pairing, and an exact tie counts as high.
    const centre = (topLeft + topRight + bottomRight + bottomLeft) / 4;
    if (cellCase === 5) return centre >= level ? SADDLE_5_HIGH : SADDLE_5_LOW;

    return centre >= level ? SADDLE_10_HIGH : SADDLE_10_LOW;
  }
  return CASE_EDGES[cellCase] ?? NO_EDGES;
}

function edgeCrossing(
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

function fraction(start: number, end: number, level: number): number {
  return (level - start) / (end - start);
}

class SegmentGraph {
  private readonly points = new Map<string, Point>();
  private readonly segments: Segment[] = [];
  private readonly byEndpoint = new Map<Point, number[]>();

  add(from: Point, to: Point): void {
    const start = this.intern(from);
    const end = this.intern(to);
    if (start === end) return;

    const adjacent = this.byEndpoint.get(start) ?? [];
    if (adjacent.some((index) => this.segments[index].includes(end))) return;
    const index = this.segments.length;
    this.segments.push([start, end]);
    adjacent.push(index);
    this.byEndpoint.set(start, adjacent);
    const incoming = this.byEndpoint.get(end) ?? [];
    incoming.push(index);
    this.byEndpoint.set(end, incoming);
  }

  private intern(point: Point): Point {
    const key = pointKey(point);
    const existing = this.points.get(key);
    if (existing) return existing;

    this.points.set(key, point);
    return point;
  }

  chain(value: number, scale: number, smooth: boolean): Isoline[] {
    const used = new Array<boolean>(this.segments.length).fill(false);
    const lines: Isoline[] = [];
    for (const [index, [start, end]] of this.segments.entries()) {
      if (used[index]) continue;
      used[index] = true;
      const coordinates: Point[] = [start, end];
      coordinates.push(...this.extend(end, used, smooth));
      coordinates.unshift(...this.extend(start, used, smooth).reverse());
      const wraps = isClosed(coordinates) && !this.isAnchor(coordinates[0]);
      const rounded = smooth ? roundCoordinates(coordinates, wraps) : coordinates;
      lines.push({ value, coordinates: rounded.map((point) => scalePoint(point, scale)) });
    }
    return lines;
  }

  private extend(start: Point, used: boolean[], smooth: boolean): Point[] {
    const points: Point[] = [];
    let current = start;
    while (true) {
      if (smooth && this.isAnchor(current)) return points;

      const index = this.byEndpoint.get(current)?.find((candidate) => !used[candidate]);
      if (index === undefined) return points;

      used[index] = true;
      const [nextStart, nextEnd] = this.segments[index];
      current = nextStart === current ? nextEnd : nextStart;
      points.push(current);
    }
  }

  private isAnchor(point: Point): boolean {
    return (this.byEndpoint.get(point)?.length ?? 0) !== 2;
  }
}

function scalePoint([x, y]: Point, scale: number): Point {
  return [x * scale, y * scale];
}

function pointKey([x, y]: Point): string {
  return `${Math.round(x * COORDINATE_SCALE)},${Math.round(y * COORDINATE_SCALE)}`;
}

function roundCoordinates(coordinates: Point[], closed: boolean): Point[] {
  let points = closed ? coordinates.slice(0, -1) : coordinates;
  for (let pass = 0; pass < CHAIKIN_PASSES; pass++) {
    points = chaikinPass(points, closed);
  }
  return points;
}

function chaikinPass(points: Point[], closed: boolean): Point[] {
  const ring = closed ? withoutClosingPoint(points) : points;
  if (ring.length < 2) return ring;

  const rounded: Point[] = closed ? [] : [ring[0]];
  const last = closed ? ring.length : ring.length - 1;
  for (let index = 0; index < last; index++) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    rounded.push(
      mixPoints(start, end, CHAIKIN_FIRST_POINT),
      mixPoints(start, end, CHAIKIN_SECOND_POINT),
    );
  }
  if (closed) rounded.push(rounded[0]);
  else rounded.push(ring[ring.length - 1]);
  return rounded;
}

function withoutClosingPoint(points: readonly Point[]): Point[] {
  if (!isClosed(points)) return [...points];
  return points.slice(0, -1);
}

function isClosed(coordinates: readonly Point[]): boolean {
  if (coordinates.length < 4) return false;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function keepsLine(coordinates: readonly Point[]): boolean {
  if (!isClosed(coordinates)) return true;

  let minColumn = coordinates[0][0];
  let maxColumn = minColumn;
  let minRow = coordinates[0][1];
  let maxRow = minRow;
  for (const [column, row] of coordinates) {
    minColumn = Math.min(minColumn, column);
    maxColumn = Math.max(maxColumn, column);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }
  return Math.max(maxColumn - minColumn, maxRow - minRow) >= MIN_CLOSED_LOOP_SPAN_CELLS;
}

function mixPoints(start: Point, end: Point, along: number): Point {
  return [
    start[0] + (end[0] - start[0]) * along,
    start[1] + (end[1] - start[1]) * along,
  ];
}

function refineField(values: ArrayLike<number>, nx: number, ny: number): ScalarField {
  const refinedNx = (nx - 1) * REFINEMENT_FACTOR + 1;
  const refinedNy = (ny - 1) * REFINEMENT_FACTOR + 1;
  const refined = new Float64Array(refinedNx * refinedNy);
  const support = supportMap(values, nx, ny);
  const range = finiteRange(values);
  for (let row = 0; row < refinedNy; row++) {
    for (let column = 0; column < refinedNx; column++) {
      refined[row * refinedNx + column] = sampleField(
        values,
        nx,
        ny,
        support,
        range,
        column / REFINEMENT_FACTOR,
        row / REFINEMENT_FACTOR,
      );
    }
  }
  return { values: refined, nx: refinedNx, ny: refinedNy };
}

/**
 * Sample the smooth field that refinement traces. A quad without a full finite 4x4
 * neighbourhood uses bilinear, so a missing sample is never bridged. Native coordinates keep
 * their sample values and finite native edges survive beside no-data; unsupported quad
 * interiors return NaN.
 */
export function sampleSmoothField(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  x: number,
  y: number,
): number {
  const support = supportMap(values, nx, ny);
  const range = finiteRange(values);
  return sampleField(values, nx, ny, support, range, x, y);
}

function sampleField(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  support: Uint8Array,
  range: ScalarRange,
  x: number,
  y: number,
): number {
  const column = Math.max(0, Math.min(Math.floor(x), nx - 2));
  const row = Math.max(0, Math.min(Math.floor(y), ny - 2));
  const across = x - column;
  const down = y - row;
  const top = row * nx + column;
  const topLeft = values[top];
  const topRight = values[top + 1];
  const bottomLeft = values[top + nx];
  const bottomRight = values[top + nx + 1];
  if (Number.isInteger(x) && Number.isInteger(y)) return values[y * nx + x];
  if (!Number.isFinite(topLeft) || !Number.isFinite(topRight)
    || !Number.isFinite(bottomLeft) || !Number.isFinite(bottomRight)) {
    if (Number.isInteger(y)) {
      const left = down === 0 ? topLeft : bottomLeft;
      const right = down === 0 ? topRight : bottomRight;
      return left + (right - left) * across;
    }
    if (Number.isInteger(x)) {
      const above = across === 0 ? topLeft : topRight;
      const below = across === 0 ? bottomLeft : bottomRight;
      return above + (below - above) * down;
    }
    return NaN;
  }
  if (!support[row * (nx - 1) + column]) {
    const above = topLeft + (topRight - topLeft) * across;
    const below = bottomLeft + (bottomRight - bottomLeft) * across;
    return above + (below - above) * down;
  }

  return bicubicValue(values, nx, support, range, column, row, across, down);
}

function supportMap(values: ArrayLike<number>, nx: number, ny: number): Uint8Array {
  const support = new Uint8Array((nx - 1) * (ny - 1));
  for (let row = 0; row + 1 < ny; row++) {
    for (let column = 0; column + 1 < nx; column++) {
      if (hasFullSupport(values, nx, ny, column, row)) {
        support[row * (nx - 1) + column] = 1;
      }
    }
  }
  return support;
}

function hasFullSupport(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
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

function finiteRange(values: ArrayLike<number>): ScalarRange {
  let low = Infinity;
  let high = -Infinity;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return { low, high };
}

function bicubicValue(
  values: ArrayLike<number>,
  nx: number,
  support: Uint8Array,
  range: ScalarRange,
  column: number,
  row: number,
  across: number,
  down: number,
): number {
  const top = row * nx + column;
  const quad = row * (nx - 1) + column;
  const p00 = values[top - nx - 1];
  const p01 = values[top - nx];
  const p02 = values[top - nx + 1];
  const p03 = values[top - nx + 2];
  const p10 = values[top - 1];
  const p11 = values[top];
  const p12 = values[top + 1];
  const p13 = values[top + 2];
  const p20 = values[top + nx - 1];
  const p21 = values[top + nx];
  const p22 = values[top + nx + 1];
  const p23 = values[top + nx + 2];
  const p30 = values[top + 2 * nx - 1];
  const p31 = values[top + 2 * nx];
  const p32 = values[top + 2 * nx + 1];
  const p33 = values[top + 2 * nx + 2];

  const first = cubicValue(p00, p01, p02, p03, across);
  const second = cubicValue(p10, p11, p12, p13, across);
  const third = cubicValue(p20, p21, p22, p23, across);
  const fourth = cubicValue(p30, p31, p32, p33, across);
  let value = cubicValue(first, second, third, fourth, down);

  // Adjacent bilinear quads share a linear edge, so taper the difference from that edge.
  const stride = nx - 1;
  if (!support[quad - stride]) {
    const linear = p11 + (p12 - p11) * across;
    value += (1 - down) * (linear - second);
  }
  if (!support[quad + stride]) {
    const linear = p21 + (p22 - p21) * across;
    value += down * (linear - third);
  }
  if (!support[quad - 1]) {
    const linear = p11 + (p21 - p11) * down;
    value += (1 - across) * (linear - cubicValue(p01, p11, p21, p31, down));
  }
  if (!support[quad + 1]) {
    const linear = p12 + (p22 - p12) * down;
    value += across * (linear - cubicValue(p02, p12, p22, p32, down));
  }

  return Math.min(range.high, Math.max(range.low, value));
}

function cubicValue(p0: number, p1: number, p2: number, p3: number, along: number): number {
  const squared = along * along;
  const cubed = squared * along;
  return 0.5 * (
    2 * p1
    + (p2 - p0) * along
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * squared
    + (3 * p1 - 3 * p2 + p3 - p0) * cubed
  );
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
