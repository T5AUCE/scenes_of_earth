import type { CreditDoc, Scene } from "./types";

const METERS_PER_DEGREE = 111_320;
const METERS_PER_KILOMETER = 1000;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const CELL_SIZE_ROUNDING_M = 10;

/** A credited source; isBoundary marks the area boundary's source. */
export interface CreditEntry extends CreditDoc {
  isBoundary: boolean;
}

/** Approximate: cells inside the finest layer's mask, at the latitude of the bbox centre. */
export function areaKm2(scene: Scene) {
  const finest = scene.layers.reduce(
    (best, layer) => (layer.grid.res < best.grid.res ? layer : best),
  );
  const [, south, , north] = scene.area.bbox;
  const centreLatitude = (south + north) / 2;

  const cellKm = (finest.grid.res * METERS_PER_DEGREE) / METERS_PER_KILOMETER;
  const cellKm2 = cellKm ** 2 * Math.cos(centreLatitude / DEGREES_PER_RADIAN);

  return finest.mask.cells_inside * cellKm2;
}

/** A cell size in metres, or in kilometres from 1 km up. */
export function formatCellSize(resolutionDegrees: number) {
  const meters = resolutionDegrees * METERS_PER_DEGREE;
  if (meters >= METERS_PER_KILOMETER) {
    return `${Number((meters / METERS_PER_KILOMETER).toPrecision(2))} km`;
  }

  return `${Math.round(meters / CELL_SIZE_ROUNDING_M) * CELL_SIZE_ROUNDING_M} m`;
}

/** One entry per source that the bundle credits: each layer, then the area boundary. */
export function creditEntries(scene: Scene): CreditEntry[] {
  const layerEntries = scene.layers.map((layer) => ({ ...layer.source, isBoundary: false }));

  const { boundary } = scene.area;
  if (!boundary) return layerEntries;

  const name = `Area boundaries (${boundary.source})`;
  const boundaryEntry = { ...boundary, name, isBoundary: true };

  return [...layerEntries, boundaryEntry];
}

/** Lines in credits.lines that no listed source accounts for, e.g. the synthetic-data note. */
export function extraCreditLines(scene: Scene) {
  const attributions = new Set(creditEntries(scene).map((entry) => entry.attribution));
  return scene.credits.lines.filter((line) => !attributions.has(line));
}

/** The notices to show, counting a clipped area as one. */
export const noticeCount = (scene: Scene) =>
  scene.notices.limits.length + (scene.area.clipped_to_coverage ? 1 : 0);
