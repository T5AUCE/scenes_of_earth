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

/** The ink shared by isotherm lines and their legend sample. */
export const ISOTHERM_COLOR = "#313f4d";
/** Every fifth line is bold. */
export const BOLD_ISOTHERM_MULTIPLE = 5;

const FIRST_ISOTHERM_INTERVAL_DEG = 0.5;
const INTERVAL_MULTIPLIERS = [1, 2, 5];
const MAX_ISOTHERM_LEVELS = 12;
const LEVEL_DIGITS = 6;
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
 */
export function traceIsolines(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  levels: readonly number[],
): Isoline[] {
  return levels.flatMap((level) => traceLevel(values, nx, ny, level));
}

function traceLevel(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  level: number,
): Isoline[] {
  const segments: Segment[] = [];
  const seenSegments = new Set<string>();
  for (let row = 0; row + 1 < ny; row++) {
    for (let col = 0; col + 1 < nx; col++) {
      const corners = cellCorners(values, nx, col, row);
      if (corners.some((value) => !Number.isFinite(value))) continue;

      for (const [from, to] of cellEdges(corners, level)) {
        const start = edgePoint(from, col, row, corners, level);
        const end = edgePoint(to, col, row, corners, level);
        if (pointKey(start) === pointKey(end)) continue;

        const key = segmentKey(start, end);
        if (seenSegments.has(key)) continue;

        seenSegments.add(key);
        segments.push([start, end]);
      }
    }
  }
  return chainSegments(segments, level);
}

function cellCorners(
  values: ArrayLike<number>,
  nx: number,
  col: number,
  row: number,
): Corners {
  const top = row * nx + col;
  const bottom = top + nx;

  return [values[top], values[top + 1], values[bottom + 1], values[bottom]];
}

function cellEdges([topLeft, topRight, bottomRight, bottomLeft]: Corners, level: number) {
  const above = (value: number) => (value >= level ? 1 : 0);
  const cellCase =
    above(topLeft) + above(topRight) * 2 + above(bottomRight) * 4 + above(bottomLeft) * 8;
  if (cellCase === 5 || cellCase === 10) {
    // Both corner pairings fit, so the cell centre breaks the tie consistently.
    const center = (topLeft + topRight + bottomRight + bottomLeft) / 4;
    if (cellCase === 5) return center >= level ? SADDLE_5_HIGH : SADDLE_5_LOW;

    return center >= level ? SADDLE_10_HIGH : SADDLE_10_LOW;
  }
  return CASE_EDGES[cellCase] ?? [];
}

function edgePoint(
  edge: Edge,
  col: number,
  row: number,
  [topLeft, topRight, bottomRight, bottomLeft]: Corners,
  level: number,
): Point {
  if (edge === "top") return [col + fraction(topLeft, topRight, level), row];
  if (edge === "right") return [col + 1, row + fraction(topRight, bottomRight, level)];
  if (edge === "bottom") return [col + fraction(bottomLeft, bottomRight, level), row + 1];

  return [col, row + fraction(topLeft, bottomLeft, level)];
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
  return coordinates.map(([col, row]) => [
    west + (col + 0.5) * degreesPerColumn + shift,
    north - (row + 0.5) * degreesPerRow,
  ]);
}
