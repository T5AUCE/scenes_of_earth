import { convertValue } from "./units";
import type { TerrainStats } from "./types";

/** Contour heights in metres. Each divides the next, so a coarser line is also a finer line. */
export const INTERVAL_CHAIN_M = [10, 50, 100, 500, 1000, 2000];

/** Contour heights in feet, US-topo style; at about 6 m, 20 ft keeps lines as sparse as metres. */
export const INTERVAL_CHAIN_FT = [20, 100, 500, 1000, 5000];

/** Contour tiles are traced from DEM tiles one zoom coarser, so their ceiling is one above. */
export const CONTOUR_OVERZOOM = 1;
/** Zoom levels a tier takes to reach full opacity after it first shows. */
export const FADE_SPAN_ZOOM = 0.75;

/** Add the next finer labelled height where bold lines sit far apart; the M5 trial asked for it. */
export const LABEL_SPARSE_FALLBACK = true;

const MIN_LINE_GAP_PX = 5;
const MIN_BOLD_LEVELS = 3;
const SCREEN_HEIGHT_PX = 800;
const MAX_CONTOUR_ZOOM = 12;

const WORLD_CIRCUMFERENCE_M = 40_075_016.686;
const WORLD_WIDTH_ZOOM0_PX = 512;

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
 * Plan the contours of a scene from its elevation statistics. A height step shows once its lines
 * would sit at least MIN_LINE_GAP_PX apart on the scene's steep slopes, so steep scenes get finer
 * lines later and flat ones sooner.
 */
export function contourLadder(
  stats: TerrainStats,
  centreLatitudeDeg: number,
  {
    maxZoom = MAX_CONTOUR_ZOOM,
    labelSparseFallback = LABEL_SPARSE_FALLBACK,
    elevationUnit = "m",
  }: LadderOptions = {},
): ContourLadder {
  maxZoom = Math.min(MAX_CONTOUR_ZOOM, maxZoom);
  const chain = elevationUnit === "ft" ? INTERVAL_CHAIN_FT : INTERVAL_CHAIN_M;
  const requiredInterval = (zoom: number) =>
    MIN_LINE_GAP_PX * heightPerPixel(stats.slope_p90_deg, zoom, centreLatitudeDeg, elevationUnit);
  const tiers = [...chain].reverse().flatMap((interval) => {
    const entryZoom = firstZoomWhere((zoom) => requiredInterval(zoom) <= interval, maxZoom);
    return entryZoom === null
      ? []
      : [{ interval, entryZoom, traceZoom: Math.max(entryZoom - 1, 0) }];
  });
  const boldInterval = boldIntervalFor(stats, tiers, elevationUnit);

  return {
    tiers,
    boldInterval,
    labelTiers: labelTiersFor(stats, centreLatitudeDeg, tiers, boldInterval, {
      maxZoom,
      labelSparseFallback,
      elevationUnit,
    }),
    thresholds: thresholdsFor(tiers, maxZoom),
  };
}

function heightPerPixel(
  slopeDeg: number,
  zoom: number,
  latitudeDeg: number,
  elevationUnit = "m",
) {
  const metres = metresPerPixel(zoom, latitudeDeg) * Math.tan((slopeDeg * Math.PI) / 180);
  return convertValue(metres, "m", elevationUnit);
}

function firstZoomWhere(isTrue: (zoom: number) => boolean, maxZoom: number) {
  for (let zoom = 0; zoom <= maxZoom; zoom += 1) {
    if (isTrue(zoom)) return zoom;
  }
  return null;
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
  stats: TerrainStats,
  latitudeDeg: number,
  tiers: LadderTier[],
  boldInterval: number,
  { maxZoom, labelSparseFallback, elevationUnit }: Required<LadderOptions>,
) {
  const boldIndex = tiers.findIndex((tier) => tier.interval === boldInterval);
  if (boldIndex === -1) return [];

  const labelTiers = [{ interval: boldInterval, entryZoom: tiers[boldIndex].entryZoom }];
  const finer = tiers[boldIndex + 1];
  if (!labelSparseFallback || !finer) return labelTiers;

  const sparseZoom = firstZoomWhere((zoom) => {
    const gapPx = boldInterval
      / heightPerPixel(stats.slope_p50_deg, zoom, latitudeDeg, elevationUnit);
    return gapPx > SCREEN_HEIGHT_PX;
  }, maxZoom);
  if (sparseZoom === null) return labelTiers;

  const entryZoom = Math.max(sparseZoom, finer.entryZoom);
  return [...labelTiers, { interval: finer.interval, entryZoom }];
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

/** The ground size of one screen pixel at a zoom and latitude. */
export function metresPerPixel(zoom: number, latitudeDeg: number) {
  const equatorMetres = WORLD_CIRCUMFERENCE_M * Math.cos((latitudeDeg * Math.PI) / 180);
  return equatorMetres / (WORLD_WIDTH_ZOOM0_PX * 2 ** zoom);
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
