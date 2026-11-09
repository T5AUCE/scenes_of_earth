import { convertValue } from "./units";
import type { TerrainStats } from "./types";

/** Contour heights in metres. Each divides the next, so a coarser line is also a finer line. */
export const INTERVAL_CHAIN_M = [10, 50, 100, 500, 1000, 2000];

/** Contour heights in feet, US-topo style; at about 6 m, 20 ft keeps lines as sparse as metres. */
export const INTERVAL_CHAIN_FT = [20, 100, 500, 1000, 5000];

/**
 * The entry zoom of every contour height, the same at each zoom everywhere because the user
 * forbids terrain or latitude adaptation. Values sit close to the previous mid-relief Kenya
 * ladder, so the 20 ft step stays beyond the z12 cap while metres keep their 10 m floor.
 */
export const ENTRY_ZOOM_M: Record<number, number> = {
  2000: 5,
  1000: 6,
  500: 7,
  100: 9,
  50: 10,
  10: 12,
};

/** The entry zoom of every feet height. The 20 ft step never enters at or below the z12 cap. */
export const ENTRY_ZOOM_FT: Record<number, number> = {
  5000: 5,
  1000: 7,
  500: 8,
  100: 11,
};

/** Contour tiles are traced from DEM tiles one zoom coarser, so their ceiling is one above. */
export const CONTOUR_OVERZOOM = 1;
/** Zoom levels a tier takes to reach full opacity after it first shows. */
export const FADE_SPAN_ZOOM = 1.5;

/** Add the next finer labelled height where bold lines sit far apart; the M5 trial asked for it. */
export const LABEL_SPARSE_FALLBACK = true;

const MIN_BOLD_LEVELS = 3;
const MAX_CONTOUR_ZOOM = 12;

/** A height step with the zoom where it starts to show and the zoom where it is first traced. */
export interface LadderTier {
  interval: number;
  entryZoom: number;
  traceZoom: number;
}

/** A scene's contour plan, which stays the same at every visit. */
export interface ContourLadder {
  tiers: LadderTier[]; // coarsest first
  boldInterval: number;
  labelTiers: { interval: number; entryZoom: number }[]; // coarsest first
  /** Finest traced height by tile zoom; a zoom without an entry uses the next lower one. */
  thresholds: Record<number, number>;
}

interface LadderOptions {
  maxZoom?: number;
  labelSparseFallback?: boolean;
  elevationUnit?: string;
}

/**
 * Plan the contours from one global zoom table, so every scene traces the same heights at the
 * same zooms and derived products stay keyable by table and units rather than scene identity.
 */
export function contourLadder(
  stats: TerrainStats,
  {
    maxZoom = MAX_CONTOUR_ZOOM,
    labelSparseFallback = LABEL_SPARSE_FALLBACK,
    elevationUnit = "m",
  }: LadderOptions = {},
): ContourLadder {
  maxZoom = Math.min(MAX_CONTOUR_ZOOM, maxZoom);
  const chain = elevationUnit === "ft" ? INTERVAL_CHAIN_FT : INTERVAL_CHAIN_M;
  const entries = elevationUnit === "ft" ? ENTRY_ZOOM_FT : ENTRY_ZOOM_M;
  const tiers = [...chain].reverse().flatMap((interval) => {
    const entryZoom = entries[interval];
    return entryZoom === undefined || entryZoom > maxZoom
      ? []
      : [{ interval, entryZoom, traceZoom: Math.max(entryZoom - 2, 0) }];
  });
  const boldInterval = boldIntervalFor(stats, tiers, elevationUnit);

  return {
    tiers,
    boldInterval,
    labelTiers: labelTiersFor(tiers, boldInterval, {
      maxZoom,
      labelSparseFallback,
      elevationUnit,
    }),
    thresholds: thresholdsFor(tiers, maxZoom),
  };
}

function boldIntervalFor(stats: TerrainStats, tiers: LadderTier[], elevationUnit: string) {
  const chain = elevationUnit === "ft" ? INTERVAL_CHAIN_FT : INTERVAL_CHAIN_M;
  const finest = tiers.at(-1)?.interval ?? chain.at(-1)!;
  const coarser = chain.filter((interval) => interval > finest);
  const low = convertValue(stats.p2, "m", elevationUnit);
  const high = convertValue(stats.p98, "m", elevationUnit);
  const spread = coarser.filter(
    (interval) => levelsBetween(low, high, interval) >= MIN_BOLD_LEVELS,
  );

  return spread.at(-1) ?? coarser[0] ?? finest;
}

function levelsBetween(low: number, high: number, interval: number) {
  return Math.max(Math.floor(high / interval) - Math.ceil(low / interval) + 1, 0);
}

function labelTiersFor(
  tiers: LadderTier[],
  boldInterval: number,
  { maxZoom, labelSparseFallback }: Required<LadderOptions>,
) {
  const boldIndex = tiers.findIndex((tier) => tier.interval === boldInterval);
  if (boldIndex === -1) return [];

  const labelTiers = [{ interval: boldInterval, entryZoom: tiers[boldIndex].entryZoom }];
  const finer = tiers[boldIndex + 1];
  if (!labelSparseFallback || !finer) return labelTiers;
  // The finer labels wait for the tiling cap, so they never crowd the mid zooms.
  if (MAX_CONTOUR_ZOOM > maxZoom) return labelTiers;

  return [...labelTiers, { interval: finer.interval, entryZoom: MAX_CONTOUR_ZOOM }];
}

function thresholdsFor(tiers: LadderTier[], maxZoom: number) {
  const thresholds: Record<number, number> = {};
  let traced = Infinity;
  for (let zoom = 0; zoom <= maxZoom; zoom += 1) {
    const finest = Math.min(
      ...tiers.filter((tier) => tier.traceZoom <= zoom).map((tier) => tier.interval),
    );
    if (finest < traced) {
      thresholds[zoom] = finest;
      traced = finest;
    }
  }
  return thresholds;
}

/** The finest height step that shows at a zoom, or null before any does. */
export function finestIntervalAt(ladder: ContourLadder, zoom: number) {
  const shown = ladder.tiers.filter((tier) => tier.entryZoom <= zoom);
  return shown.length === 0 ? null : Math.min(...shown.map((tier) => tier.interval));
}

/** The heights of the label tiers that show at a zoom, coarsest first. */
export function labelIntervalsAt(ladder: ContourLadder, zoom: number) {
  return ladder.labelTiers
    .filter((tier) => tier.entryZoom <= zoom)
    .map((tier) => tier.interval);
}

/**
 * Pick the contour levels MapLibre would request at a zoom, mirroring the protocol threshold
 * lookup so the prefetch traces exactly what the source will ask for.
 */
export function levelsForZoom(thresholds: Record<number, number>, zoom: number): number[] {
  let selected = -Infinity;
  let levels: number[] = [];
  for (const [key, value] of Object.entries(thresholds)) {
    const entry = Number(key);
    if (entry <= zoom && entry > selected) {
      selected = entry;
      levels = [value];
    }
  }
  return levels;
}

/**
 * Version contour cache entries by the global table and request options, never by scene,
 * so derived products stay reusable across datasets on long-term R2 delivery.
 */
export function contourOptionsVersion(
  elevationUnit: string,
  overzoom: number,
  buffer: number,
): string {
  return `contours-v1:${elevationUnit}:over${overzoom}:buf${buffer}`;
}

/** A tile the warm-up may trace ahead, in slippy-map coordinates. */
export interface WarmTile {
  z: number;
  x: number;
  y: number;
}

// Web Mercator stays finite below this latitude, so warmer bounds clamp to it.
const MAX_WARM_LAT_DEG = 85.05112878;

/**
 * List the tiles a zoom needs for a viewport, nearest the centre first so a bounded
 * warm-up traces the middle while the edges can wait. Counts stay small because one
 * viewport spans few tiles, and the caller slices to its own limit.
 */
export function warmTilesForZoom(
  west: number,
  south: number,
  east: number,
  north: number,
  targetZoom: number,
  limit: number,
): WarmTile[] {
  if (limit <= 0) return [];
  const tiles: WarmTile[] = [];
  for (const x of tileColumns(west, east, targetZoom)) {
    for (let y = tileY(north, targetZoom); y <= tileY(south, targetZoom); y += 1) {
      tiles.push({ z: targetZoom, x, y });
    }
  }
  const centre: WarmTile = {
    z: targetZoom,
    x: tileX(wrapCentre(west, east), targetZoom),
    y: tileY((south + north) / 2, targetZoom),
  };
  tiles.sort((left, right) => tileDistance(left, centre) - tileDistance(right, centre));
  return tiles.slice(0, limit);
}

/**
 * List the DEM tiles a contour tile reads through its 3×3 neighbourhood, mapped through the
 * overzoom to at most four parents, so the scheduler warms reusable parents before tracing.
 */
export function demParentsForTile(tile: WarmTile, overzoom: number): WarmTile[] {
  const demZoom = tile.z - overzoom;
  if (demZoom < 0) return [];
  if (overzoom <= 0) return [{ z: tile.z, x: tile.x, y: tile.y }];
  const divisor = 2 ** overzoom;
  const count = 2 ** demZoom;
  const parents = new Map<string, WarmTile>();
  for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
    for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
      const rawX = Math.floor((tile.x + deltaX) / divisor);
      const rawY = Math.floor((tile.y + deltaY) / divisor);
      const parent = {
        z: demZoom,
        x: ((rawX % count) + count) % count,
        y: Math.min(count - 1, Math.max(0, rawY)),
      };
      parents.set(`${parent.z}/${parent.x}/${parent.y}`, parent);
    }
  }
  return [...parents.values()];
}

/** Dedupe the DEM parents of many contour tiles, keeping the reusable set small. */
export function demParentsForTiles(tiles: readonly WarmTile[], overzoom: number): WarmTile[] {
  const parents = new Map<string, WarmTile>();
  for (const tile of tiles) {
    for (const parent of demParentsForTile(tile, overzoom)) {
      parents.set(`${parent.z}/${parent.x}/${parent.y}`, parent);
    }
  }
  return [...parents.values()];
}

/** Columns spanned by a longitude range, wrapping indices past the 180th meridian. */
function tileColumns(west: number, east: number, zoom: number): number[] {
  const count = 2 ** zoom;
  const last = east < west ? east + 360 : east;
  if (last - west >= 360) return Array.from({ length: count }, (_, x) => x);
  // Western and eastern copies unwrap to the same tile indices, so enumerate unwrapped.
  const firstColumn = Math.floor((west + 180) / 360 * count);
  const lastColumn = Math.floor((last + 180) / 360 * count);
  const columns: number[] = [];
  for (let x = firstColumn; x <= lastColumn; x += 1) {
    columns.push(((x % count) + count) % count);
  }
  return columns;
}

/** Middle of a longitude range, unwrapped past 180 when the range crosses it. */
function wrapCentre(west: number, east: number): number {
  return east < west ? (west + east + 360) / 2 : (west + east) / 2;
}

function tileDistance(tile: WarmTile, centre: WarmTile): number {
  const wraparound = Math.min(
    Math.abs(tile.x - centre.x),
    2 ** tile.z - Math.abs(tile.x - centre.x),
  );
  return wraparound ** 2 + (tile.y - centre.y) ** 2;
}

function tileX(longitude: number, zoom: number): number {
  const count = 2 ** zoom;
  const wrapped = ((longitude + 180) % 360 + 360) % 360;
  return Math.min(count - 1, Math.floor(wrapped / 360 * count));
}

function tileY(latitude: number, zoom: number): number {
  const count = 2 ** zoom;
  const clamped = Math.min(MAX_WARM_LAT_DEG, Math.max(-MAX_WARM_LAT_DEG, latitude));
  const radians = clamped * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * count;
  return Math.min(count - 1, Math.max(0, Math.floor(y)));
}
