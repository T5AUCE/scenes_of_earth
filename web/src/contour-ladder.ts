/** Choose contour heights and label spacing from the global zoom tables. */
import type { TerrainStats } from "./types";
import { convertValue } from "./units";

/** Contour heights in metres. Each divides the next, so a coarser line is also a finer line. */
export const INTERVAL_CHAIN_M = [10, 50, 100, 500, 1000, 2000];

/** Contour heights in feet, US-topo style; at about 6 m, 20 ft keeps lines as sparse as metres. */
export const INTERVAL_CHAIN_FT = [20, 100, 500, 1000, 5000];

/**
 * The entry zoom of every contour height stays the same worldwide so zoom alone controls
 * line density. Both finest steps (20 ft and 10 m) start at the z12 cap.
 */
export const ENTRY_ZOOM_M: Record<number, number> = {
  2000: 5,
  1000: 6,
  500: 7,
  100: 9,
  50: 10.5,
  10: 12,
};

/** The entry zoom of every feet height. The 20 ft step starts at the z12 cap like 10 m. */
export const ENTRY_ZOOM_FT: Record<number, number> = { 5000: 5, 1000: 7, 500: 8, 100: 11, 20: 12 };

/** Contour tiles are traced from DEM tiles one zoom coarser, so their ceiling is one above. */
export const CONTOUR_OVERZOOM = 1;
/** Zoom levels a tier takes to reach full opacity after it first shows. */
export const FADE_SPAN_ZOOM = 1;
/** Share of the fade before the legend names a height, so the name matches the lines. */
export const LEGEND_FADE_SHARE = 0.5;

/** Add the next finer labelled height where bold lines are too far apart to locate elevations. */
export const LABEL_SPARSE_FALLBACK = true;

const MIN_BOLD_LEVELS = 3;
export const MAX_CONTOUR_ZOOM = 12;

/** A height step with the zoom where it starts to show. */
export interface LadderTier {
  interval: number;
  entryZoom: number;
}

/** A scene's contour plan, which stays the same at every visit. */
export interface ContourLadder {
  tiers: LadderTier[]; // coarsest first
  boldInterval: number;
  labelTiers: { interval: number; entryZoom: number }[]; // coarsest first
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
    return entryZoom === undefined || entryZoom > maxZoom ? [] : [{ interval, entryZoom }];
  });
  const boldInterval = boldIntervalFor(stats, tiers, elevationUnit);

  return {
    tiers,
    boldInterval,
    labelTiers: labelTiersFor(tiers, boldInterval, { maxZoom, labelSparseFallback, elevationUnit }),
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

/** The finest height step whose fade is half done, else the coarsest entered step, else null. */
export function finestIntervalAt(ladder: ContourLadder, zoom: number) {
  const shown = ladder.tiers.filter(
    (tier) => zoom >= tier.entryZoom + FADE_SPAN_ZOOM * LEGEND_FADE_SHARE,
  );
  if (shown.length > 0) return Math.min(...shown.map((tier) => tier.interval));

  const entered = ladder.tiers.filter((tier) => zoom >= tier.entryZoom);
  return entered.length === 0 ? null : Math.max(...entered.map((tier) => tier.interval));
}

/** The heights of the label tiers that show at a zoom, coarsest first. */
export function labelIntervalsAt(ladder: ContourLadder, zoom: number) {
  return ladder.labelTiers.filter((tier) => tier.entryZoom <= zoom).map((tier) => tier.interval);
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

/** Columns spanned by a longitude range, wrapping indices past the 180th meridian. */
function tileColumns(west: number, east: number, zoom: number): number[] {
  const count = 2 ** zoom;
  const last = east < west ? east + 360 : east;
  if (last - west >= 360) return Array.from({ length: count }, (_, x) => x);

  // Western and eastern copies unwrap to the same tile indices, so enumerate unwrapped.
  const firstColumn = Math.floor(((west + 180) / 360) * count);
  const lastColumn = Math.floor(((last + 180) / 360) * count);
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
  const wrapped = (((longitude + 180) % 360) + 360) % 360;
  return Math.min(count - 1, Math.floor((wrapped / 360) * count));
}

function tileY(latitude: number, zoom: number): number {
  const count = 2 ** zoom;
  const clamped = Math.min(MAX_WARM_LAT_DEG, Math.max(-MAX_WARM_LAT_DEG, latitude));
  const radians = (clamped * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * count;

  return Math.min(count - 1, Math.max(0, Math.floor(y)));
}
