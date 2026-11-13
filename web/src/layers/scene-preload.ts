/** Preload sources for one scene: the DEM pyramid, the contour traces and the basemap. */
import {
  CONTOUR_OVERZOOM,
  contourOptionsVersion,
  demParentsForTile,
  demParentsForTiles,
  levelsForZoom,
  type ContourLadder,
  type WarmTile,
} from "../contour-ladder";
import { BASEMAP_SOURCE_ID, basemapDescriptor, scenePyramidTiles } from "../render/tile-viewport";
import { convertValue } from "../units";
import type { Bbox } from "../types";
import type { PreloadSource, PreloadTask } from "./tile-prefetch";

// Tile budgets are global, so a big scene gets coarser levels instead of more downloads.
export const DEM_PRELOAD_TILES = 96;
export const BASEMAP_PRELOAD_TILES = 150;
export const CONTOUR_PRELOAD_TILES = 96;
/** The deepest basemap zoom preload fetches. Deeper detail still streams while zooming. */
export const BASEMAP_PRELOAD_MAX_ZOOM = 12;

export const DEM_PRELOAD_LANES = 3;
// OpenFreeMap asks for at most four parallel requests.
export const BASEMAP_PRELOAD_LANES = 3;
// A trace runs in the contour worker, so one lane keeps it from queueing behind itself.
export const CONTOUR_PRELOAD_LANES = 1;

export const DEM_PRELOAD_ID = "dem";
export const CONTOUR_PRELOAD_ID = "contours";
export const BASEMAP_PRELOAD_ID = "basemap";

// Mapterhorn webp tiles measure 165-192 KB at z8-10 and less at the flat deep levels.
const DEM_TILE_EST_BYTES = 192 * 1024;
const BASEMAP_TILE_EST_BYTES = 64 * 1024;
// The plugin materializes one pixel of padding before tracing, matching the overlay.
const CONTOUR_BUFFER_PX = 1;
// Traces never run deeper than this zoom, matching the overlay ceiling.
const CONTOUR_PLAN_MAX_ZOOM = 12;

/** The DEM manager subset preload fetches and traces through. */
export interface DemFetcher {
  fetchTile?(z: number, x: number, y: number, abort: AbortController): Promise<unknown>;
  fetchContourTile?(
    z: number,
    x: number,
    y: number,
    options: unknown,
    abort: AbortController,
  ): Promise<unknown>;
}

/** What the DEM source needs to list and download a scene's elevation tiles. */
export interface DemPreloadOptions {
  template: string;
  maxzoom: number;
  bbox: Bbox;
  reliefSourceId: string;
  fetcher: DemFetcher | null;
}

/** The contour plan that preload reads again on every plan, so a unit change takes effect. */
export interface ContourPlan {
  ladder: ContourLadder;
  maxzoom: number;
  elevationUnit: string;
}

/** What the contour source needs to trace the scene's tiles ahead of the camera. */
export interface ContourPreloadOptions {
  lineSourceId: string;
  plan: () => ContourPlan;
  bbox: Bbox;
  demMaxzoom: number;
  fetcher: DemFetcher | null;
  demTemplate?: string;
}

type BasemapMap = Parameters<typeof basemapDescriptor>[0];

/**
 * Route preload through the DEM manager that the contour worker also reads. One download then
 * fills the worker's tile cache for tracing and the store for the hillshade, instead of two.
 */
export function demFetcherFor(dem: { manager?: unknown }): DemFetcher | null {
  return (dem as { manager?: DemFetcher }).manager ?? null;
}

/** Elevation tiles for relief and contour parents, from one level above the fitted zoom down. */
export function demPreloadSource(options: DemPreloadOptions): PreloadSource {
  const urlToTile = new Map<string, WarmTile>();
  return {
    id: DEM_PRELOAD_ID,
    layer: "terrain",
    lanes: DEM_PRELOAD_LANES,
    tasks: (fittedZoom) => {
      const tiles = demPlanTiles(options.bbox, options.maxzoom, fittedZoom);
      urlToTile.clear();
      for (const tile of tiles) urlToTile.set(tileUrl(options.template, tile), tile);
      return tiles.map((tile) => demTask(options, tile));
    },
    visibleKey: (sourceId, tile) => {
      return sourceId === options.reliefSourceId ? tileUrl(options.template, tile) : null;
    },
    loadShared: (key) => {
      const tile = urlToTile.get(key);
      if (!tile) return undefined;
      return () => fetchDemBlob(options.fetcher, tile, key, new AbortController(), undefined);
    },
  };
}

/** Contour traces for the same pyramid, run once the elevation tiles they read are in. */
export function contourPreloadSource(options: ContourPreloadOptions): PreloadSource {
  return {
    id: CONTOUR_PRELOAD_ID,
    layer: "contours",
    lanes: CONTOUR_PRELOAD_LANES,
    after: DEM_PRELOAD_ID,
    tasks: (fittedZoom) => contourTasks(options, fittedZoom),
    visibleKey: (sourceId, tile) => {
      if (sourceId !== options.lineSourceId) return null;
      return contourCandidate(options.plan(), tile)?.key ?? null;
    },
  };
}

/** Vector basemap tiles from the fitted zoom to about z12. */
export function basemapPreloadSource(map: BasemapMap, bbox: Bbox): PreloadSource {
  // Visible loads are keyed by the template that the last plan resolved.
  let template: string | null = null;
  return {
    id: BASEMAP_PRELOAD_ID,
    layer: "basemap",
    lanes: BASEMAP_PRELOAD_LANES,
    tasks(fittedZoom) {
      const basemap = basemapDescriptor(map);
      template = basemap?.template ?? null;
      if (!basemap) return [];
      const lastZoom = Math.min(basemap.maxzoom, BASEMAP_PRELOAD_MAX_ZOOM);
      const firstZoom = Math.min(Math.floor(fittedZoom), lastZoom);
      return scenePyramidTiles(bbox, firstZoom, lastZoom, BASEMAP_PRELOAD_TILES)
        .map((tile) => downloadTask(
          tileUrl(basemap.template, tile),
          BASEMAP_TILE_EST_BYTES,
          tile.z,
        ));
    },
    visibleKey: (sourceId, tile) => {
      return template !== null && sourceId === BASEMAP_SOURCE_ID ? tileUrl(template, tile) : null;
    },
    // The live template is the identity so only a replacement replans.
    revisionKey: () => basemapDescriptor(map)?.template ?? null,
  };
}

/** Fill a tile template with slippy-map coordinates, keyed by URL rather than scene. */
export function tileUrl(template: string, tile: WarmTile): string {
  return template.replace("{z}", String(tile.z)).replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

/** The dedupe key for a contour trace, versioned by table and options rather than scene. */
export function contourCacheKey(tile: WarmTile, options: unknown, version: string): string {
  return `${version}:${tile.z}/${tile.x}/${tile.y}:${stableOptions(options)}`;
}

// The contour tiles read their parents one zoom up, so that level is planned too.
function demPyramid(bbox: Bbox, maxzoom: number, fittedZoom: number): WarmTile[] {
  const firstZoom = Math.min(Math.floor(fittedZoom) - CONTOUR_OVERZOOM, maxzoom);
  return scenePyramidTiles(bbox, firstZoom, maxzoom, DEM_PRELOAD_TILES);
}

/**
 * The DEM tiles a scene preloads: the pyramid plus the deduplicated contour-parent ring,
 * kept to whole levels inside the tile bound. Parents of in-scene contour tiles overlap the
 * scene, so the ring usually adds nothing, but the union keeps worker tracing inside the
 * advertised bound when levels alone would leave edge parents out.
 */
function demPlanTiles(bbox: Bbox, maxzoom: number, fittedZoom: number): WarmTile[] {
  const pyramid = demPyramid(bbox, maxzoom, fittedZoom);
  const known = new Set(pyramid.map(tileKey));
  const ring = demParentsForTiles(contourPlanTiles(bbox, maxzoom, fittedZoom), CONTOUR_OVERZOOM);
  for (const parent of ring) {
    if (!known.has(tileKey(parent))) {
      known.add(tileKey(parent));
      pyramid.push(parent);
    }
  }
  return keepWholeLevels(pyramid, DEM_PRELOAD_TILES);
}

/** The contour tiles a scene may trace, without the ladder so the DEM plan can reserve
 * their parents first. */
function contourPlanTiles(bbox: Bbox, demMaxzoom: number, fittedZoom: number): WarmTile[] {
  const lastZoom = Math.min(CONTOUR_PLAN_MAX_ZOOM, demMaxzoom + CONTOUR_OVERZOOM);
  const firstZoom = Math.min(Math.floor(fittedZoom), lastZoom);
  return scenePyramidTiles(bbox, firstZoom, lastZoom, CONTOUR_PRELOAD_TILES);
}

/**
 * Keep whole levels from the coarsest zoom while each level still fits the tile budget. A
 * level that would overflow is left out entirely, because a partial deeper level would only
 * help the middle of the scene.
 */
function keepWholeLevels(tiles: WarmTile[], maxTiles: number): WarmTile[] {
  const levels = new Map<number, WarmTile[]>();
  for (const tile of tiles) {
    const level = levels.get(tile.z) ?? [];
    level.push(tile);
    levels.set(tile.z, level);
  }
  const kept: WarmTile[] = [];
  for (const zoom of [...levels.keys()].sort((first, second) => first - second)) {
    const level = levels.get(zoom)!;
    if (kept.length + level.length > maxTiles) break;
    kept.push(...level);
  }
  return kept;
}

/** Dedupe DEM tiles by coordinates, so the pyramid and the parent ring merge without repeats. */
function tileKey(tile: WarmTile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function demTask(options: DemPreloadOptions, tile: WarmTile): PreloadTask {
  const url = tileUrl(options.template, tile);
  return {
    key: url,
    estimatedBytes: DEM_TILE_EST_BYTES,
    zoom: tile.z,
    run: (abort) => fetchDemBlob(options.fetcher, tile, url, abort, "low"),
  };
}

function contourTasks(options: ContourPreloadOptions, fittedZoom: number): PreloadTask[] {
  const fetcher = options.fetcher;
  const trace = fetcher?.fetchContourTile;
  const deepest = demPyramid(options.bbox, options.demMaxzoom, fittedZoom).at(-1);
  if (!trace || !deepest) return [];
  const plan = options.plan();
  const lastZoom = Math.min(plan.maxzoom, deepest.z + CONTOUR_OVERZOOM);
  const firstZoom = Math.min(Math.floor(fittedZoom), lastZoom);
  const planned = new Set(demPlanTiles(options.bbox, options.demMaxzoom, fittedZoom).map(tileKey));
  const demTemplate = options.demTemplate
    ?? (fetcher as { demUrlPattern?: string } | null)?.demUrlPattern;
  if (demTemplate === undefined) return [];
  return scenePyramidTiles(options.bbox, firstZoom, lastZoom, CONTOUR_PRELOAD_TILES)
    .flatMap((tile) => {
      const candidate = contourCandidate(plan, tile);
      // Uncovered traces would download unbudgeted parents so only covered tiles run.
      if (!candidate || !isTraceCovered(tile, planned)) return [];
      const parents = demParentsForTile(tile, CONTOUR_OVERZOOM);
      const needs = parents.map((parent) => tileUrl(demTemplate, parent));
      return [{
        key: candidate.key,
        estimatedBytes: parents.length * DEM_TILE_EST_BYTES,
        zoom: tile.z,
        needs,
        run: async (abort: AbortController) => {
          await warmDemParents(fetcher, demTemplate, tile, abort);
          await trace.call(fetcher, tile.z, tile.x, tile.y, candidate.options, abort);
          return undefined;
        },
      }];
    });
}

/** Warm a trace's parents in order, so an evicted manager entry refetches on one lane. */
async function warmDemParents(
  fetcher: DemFetcher | null,
  demTemplate: string | undefined,
  tile: WarmTile,
  abort: AbortController,
): Promise<void> {
  if (demTemplate === undefined) return;
  const cache = managerCacheFor(fetcher);
  if (cache !== null) {
    for (const parent of demParentsForTile(tile, CONTOUR_OVERZOOM)) {
      if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      await fetchDemBlob(fetcher, parent, tileUrl(demTemplate, parent), abort, "low");
    }
    return;
  }
  const fetchTile = fetcher?.fetchTile;
  if (!fetchTile) return;
  for (const parent of demParentsForTile(tile, CONTOUR_OVERZOOM)) {
    if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
    await fetchTile.call(fetcher, parent.z, parent.x, parent.y, abort);
  }
}

type DemPriority = "low" | undefined;

type ManagerTileCache = {
  get(
    key: string,
    supplier: (key: string, abort: AbortController) => Promise<{ data: Blob }>,
    abort: AbortController,
  ): Promise<{ data: Blob }>;
};

/** The manager tile cache when the fetcher shares the worker's own cache. */
function managerCacheFor(fetcher: DemFetcher | null): ManagerTileCache | null {
  const cache = (fetcher as { tileCache?: ManagerTileCache } | null)?.tileCache;
  return cache ?? null;
}

/** Fetch one DEM tile through the shared manager cache when possible. */
async function fetchDemBlob(
  fetcher: DemFetcher | null,
  tile: WarmTile,
  url: string,
  abort: AbortController,
  priority: DemPriority,
): Promise<Blob | undefined> {
  const cache = managerCacheFor(fetcher);
  if (cache) {
    const response = await cache.get(
      url,
      (_key, childAbort) => fetchDemResponse(url, childAbort.signal, priority),
      abort,
    );
    return response?.data instanceof Blob ? response.data : undefined;
  }
  const fetchTile = fetcher?.fetchTile;
  if (fetchTile) {
    const response = await fetchTile.call(fetcher, tile.z, tile.x, tile.y, abort) as
      { data?: unknown } | undefined;
    return response?.data instanceof Blob ? response.data : undefined;
  }
  const direct = await fetchDemResponse(url, abort.signal, priority);
  return direct.data;
}

/** Fetch one DEM response so background work stays behind visible requests. */
async function fetchDemResponse(
  url: string,
  signal: AbortSignal,
  priority: DemPriority,
): Promise<{ data: Blob }> {
  const response = await fetch(
    url,
    priority === undefined ? { signal } : { signal, priority },
  );
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);
  return { data: await response.blob() };
}

/** Whether every DEM parent a contour tile reads already holds a download reservation. */
function isTraceCovered(tile: WarmTile, planned: Set<string>): boolean {
  return demParentsForTile(tile, CONTOUR_OVERZOOM).every((parent) => planned.has(tileKey(parent)));
}

/** The trace a contour tile needs, or null when no level shows at its zoom. */
function contourCandidate(
  plan: ContourPlan,
  tile: WarmTile,
): { key: string; options: Record<string, unknown> } | null {
  const levels = levelsForZoom(plan.ladder.thresholds, tile.z);
  if (levels.length === 0) return null;
  const options = contourRequestOptions(levels, plan.elevationUnit);
  const version = contourOptionsVersion(plan.elevationUnit, CONTOUR_OVERZOOM, CONTOUR_BUFFER_PX);
  return { key: contourCacheKey(tile, options, version), options };
}

/** The protocol options a preloaded trace shares with the visible source cache entries. */
function contourRequestOptions(levels: number[], elevationUnit: string): Record<string, unknown> {
  const options: Record<string, unknown> = {
    levels,
    overzoom: CONTOUR_OVERZOOM,
    buffer: CONTOUR_BUFFER_PX,
  };
  // The DEM holds metres, so feet contours scale elevations before tracing them.
  if (elevationUnit === "ft") options.multiplier = convertValue(1, "m", "ft");
  return options;
}

/** Stable JSON for option dedupe, with sorted keys so key order never splits the cache. */
function stableOptions(options: unknown): string {
  if (options === null || typeof options !== "object") return JSON.stringify(options);
  const entries = Object.entries(options as Record<string, unknown>);
  entries.sort(([first], [second]) => (first < second ? -1 : 1));

  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableOptions(value)}`)}}`;
}

function downloadTask(url: string, estimatedBytes: number, zoom: number): PreloadTask {
  return { key: url, estimatedBytes, zoom, run: (abort) => downloadBlob(url, abort.signal) };
}

// Low priority keeps these requests behind the visible ones in the browser's own queue.
async function downloadBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal, priority: "low" });
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);
  return response.blob();
}
