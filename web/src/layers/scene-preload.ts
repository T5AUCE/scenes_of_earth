/** Preload the DEM pyramid and basemap sources for one scene. */
import { CONTOUR_OVERZOOM, type WarmTile } from "../contour-ladder";
import { demPoolHas } from "../gpu/dem/pool-registry";
import {
  basemapDescriptor,
  clipViewportToBbox,
  dwellWarmTiles,
  scenePyramidTiles,
  tileInScene,
  type BasemapDescriptor,
  type DwellViewport,
} from "../render/tile-viewport";
import type { Bbox } from "../types";
import type { PreloadSource, PreloadTask } from "./tile-prefetch";

// Tile budgets are global, so a big scene gets coarser levels instead of more downloads.
export const DEM_PRELOAD_TILES = 96;
export const BASEMAP_PRELOAD_TILES = 150;
/** The deepest basemap zoom preload fetches. Deeper detail still streams while zooming. */
export const BASEMAP_PRELOAD_MAX_ZOOM = 12;

export const DEM_PRELOAD_LANES = 3;
// OpenFreeMap asks for at most four parallel requests.
export const BASEMAP_PRELOAD_LANES = 3;

export const DEM_PRELOAD_ID = "dem";
export const BASEMAP_PRELOAD_ID = "basemap";

type BasemapMap = Parameters<typeof basemapDescriptor>[0];

/** What the DEM source needs to list and download a scene's elevation tiles. */
export interface DemPreloadOptions {
  template: string;
  maxzoom: number;
  bbox: Bbox;
}

/** Preload elevation tiles for the GPU layers and contour labels around the fitted zoom. */
export function demPreloadSource(options: DemPreloadOptions): PreloadSource {
  return {
    id: DEM_PRELOAD_ID,
    layer: "terrain",
    lanes: DEM_PRELOAD_LANES,
    tasks: (fittedZoom) => {
      return demPlanTiles(options.bbox, options.maxzoom, fittedZoom)
        .filter((tile) => !isPooledTile(options.template, tile))
        .map((tile) => demTask(options, tile));
    },
    dwell: (viewport, fittedZoom, currentZoom) => {
      return dwellTilesForBbox(viewport, options.bbox, fittedZoom, currentZoom)
        .filter((tile) => tile.z <= options.maxzoom)
        .filter((tile) => !isPooledTile(options.template, tile))
        .map((tile) => demTask(options, tile));
    },
  };
}

/** Whether the GPU pool holds a DEM tile or fetches it, so the warmer skips the URL. */
function isPooledTile(template: string, tile: WarmTile): boolean {
  return demPoolHas(template, tile);
}

/** Vector basemap tiles from the fitted zoom to about z12. */
export function basemapPreloadSource(map: BasemapMap, bbox: Bbox): PreloadSource {
  return {
    id: BASEMAP_PRELOAD_ID,
    layer: "basemap",
    lanes: BASEMAP_PRELOAD_LANES,
    tasks(fittedZoom) {
      const basemap = basemapDescriptor(map);
      if (!basemap) return [];

      const firstZoom = Math.min(Math.floor(fittedZoom), basemap.maxzoom, BASEMAP_PRELOAD_MAX_ZOOM);

      return toBasemapTasks(
        basemap,
        scenePyramidTiles(bbox, firstZoom, BASEMAP_PRELOAD_MAX_ZOOM, BASEMAP_PRELOAD_TILES),
      );
    },
    dwell(viewport, fittedZoom, currentZoom) {
      const basemap = basemapDescriptor(map);
      if (!basemap) return [];

      return toBasemapTasks(basemap, dwellTilesForBbox(viewport, bbox, fittedZoom, currentZoom));
    },
  };
}

/** Fill a tile template with slippy-map coordinates, keyed by URL rather than scene. */
export function tileUrl(template: string, tile: WarmTile): string {
  return template
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

/** Plan whole DEM levels to warm the HTTP cache before GPU decoding needs them. */
function demPlanTiles(bbox: Bbox, maxzoom: number, fittedZoom: number): WarmTile[] {
  // Contour labels trace tiles one zoom coarser, so preload includes that level.
  const firstZoom = Math.min(Math.floor(fittedZoom) - CONTOUR_OVERZOOM, maxzoom);
  const tiles = scenePyramidTiles(bbox, firstZoom, maxzoom, DEM_PRELOAD_TILES);
  return keepWholeLevels(tiles, DEM_PRELOAD_TILES);
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

function dwellTilesForBbox(
  viewport: DwellViewport,
  bbox: Bbox,
  fittedZoom: number,
  currentZoom: number,
): WarmTile[] {
  const clipped = clipViewportToBbox(viewport, bbox);
  if (clipped === null) return [];

  return dwellWarmTiles(clipped, fittedZoom, currentZoom).filter((tile) => tileInScene(tile, bbox));
}

function toBasemapTasks(basemap: BasemapDescriptor, tiles: WarmTile[]): PreloadTask[] {
  const lastZoom = Math.min(basemap.maxzoom, BASEMAP_PRELOAD_MAX_ZOOM);
  return tiles
    .filter((tile) => tile.z <= lastZoom)
    .map((tile) => downloadTask(tileUrl(basemap.template, tile), tile.z));
}

function demTask(options: DemPreloadOptions, tile: WarmTile): PreloadTask {
  const url = tileUrl(options.template, tile);
  return {
    key: url,
    zoom: tile.z,
    run: (abort) => {
      return isPooledTile(options.template, tile)
        ? Promise.resolve(undefined)
        : downloadBlob(url, abort.signal);
    },
  };
}

function downloadTask(url: string, zoom: number): PreloadTask {
  return { key: url, zoom, run: (abort) => downloadBlob(url, abort.signal) };
}

// Low priority keeps these requests behind the visible ones in the browser's own queue.
async function downloadBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal, priority: "low" });
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);

  return response.blob();
}
