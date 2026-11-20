/** Preload the DEM pyramid and basemap sources for one scene. */
import { CONTOUR_OVERZOOM, warmTilesForZoom, type WarmTile } from "../contour-ladder";
import { demPoolHas } from "../gpu/dem/pool-registry";
import {
  BASEMAP_SOURCE_ID,
  DWELL_ANCESTOR_TILES_PER_LEVEL,
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
/** How many zoom levels above the resting zoom the basemap keeps loaded for zooming out. */
export const BASEMAP_ANCESTOR_LEVELS = 3;

const BASEMAP_ANCESTOR_TIMEOUT_MS = 5 * 1000;
const BASEMAP_TILE_EVENTS = ["sourcedata", "sourcedataabort", "error"];

export const DEM_PRELOAD_LANES = 3;
// OpenFreeMap asks for at most four parallel requests.
export const BASEMAP_PRELOAD_LANES = 3;

export const DEM_PRELOAD_ID = "dem";
export const BASEMAP_PRELOAD_ID = "basemap";

type BasemapMap = Parameters<typeof basemapDescriptor>[0];

/** The parts of MapLibre's tile manager for the basemap source that ancestor loading calls. */
interface BasemapTileManager {
  getIds?: () => string[];
  getTileByID?: (id: string) => { tileID?: BasemapTileId } | undefined;
  _addTile?: (tileID: BasemapTileId) => BasemapTile | null | undefined;
  _removeTile?: (id: number) => void;
}

interface BasemapTileId {
  key?: number;
  overscaledZ: number;
  canonical?: WarmTile & { z: number };
  scaledTo?: (zoom: number) => BasemapTileId | undefined;
}

interface BasemapTile {
  state?: string;
}

interface BasemapTileEvent {
  tile?: unknown;
}

/** A coarser tile together with the id the tile manager needs to load it. */
interface AncestorEntry {
  tile: WarmTile;
  tileId: BasemapTileId;
}

type DownloadTile = (tile: WarmTile, signal: AbortSignal) => Promise<unknown>;

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

/** Vector basemap tiles from the fitted zoom to about z12, with the coarser levels kept loaded. */
export function basemapPreloadSource(map: BasemapMap, bbox: Bbox): PreloadSource {
  const loader = new BasemapAncestorLoader(map);

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

      const loadable = loader.find(ancestorTilesForBbox(viewport, bbox, currentZoom));
      const loaded = new Set(loadable.map(({ tile }) => tileUrl(basemap.template, tile)));
      const downloads = toBasemapTasks(
        basemap,
        dwellTilesForBbox(viewport, bbox, fittedZoom, currentZoom),
      ).filter((task) => !loaded.has(task.key));
      if (loadable.length === 0) return downloads;

      const download: DownloadTile = (tile, signal) => {
        return downloadBlob(tileUrl(basemap.template, tile), signal);
      };

      return [loader.start(loadable, download), ...downloads];
    },
    close: () => loader.stop(),
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

function ancestorLevels(currentZoom: number): number[] {
  const current = Math.floor(currentZoom);
  const levels: number[] = [];

  for (let zoom = current - 1; zoom >= Math.max(0, current - BASEMAP_ANCESTOR_LEVELS); zoom -= 1) {
    levels.push(zoom);
  }

  return levels;
}

function ancestorTilesForBbox(
  viewport: DwellViewport,
  bbox: Bbox,
  currentZoom: number,
): WarmTile[] {
  const clipped = clipViewportToBbox(viewport, bbox);
  if (clipped === null) return [];

  return ancestorLevels(currentZoom)
    .flatMap((zoom) => {
      return warmTilesForZoom(
        clipped.west,
        clipped.south,
        clipped.east,
        clipped.north,
        zoom,
        DWELL_ANCESTOR_TILES_PER_LEVEL,
      );
    })
    .filter((tile) => tileInScene(tile, bbox));
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

/** Loads the coarser basemap tiles into the map's own tile cache one at a time, so a zoom out finds them parsed. */
class BasemapAncestorLoader {
  private runCount = 0;
  private current: AbortController | null = null;

  constructor(private readonly map: BasemapMap) {}

  /** The tiles the map's tile manager can load itself, which leaves the rest to ordinary downloads. */
  find(tiles: WarmTile[]): AncestorEntry[] {
    try {
      const manager = basemapTileManager(this.map);
      if (!manager?._addTile) return [];

      return tiles.flatMap((tile) => {
        const tileId = liveAncestorId(manager, tile);
        return tileId ? [{ tile, tileId }] : [];
      });
    } catch {
      return [];
    }
  }

  /**
   * Starts loading the entries now and replaces an earlier run. The warmer runs entry downloads
   * before dwell tasks, so waiting for a launch would leave the load behind the whole entry backlog.
   * The returned task only lets the warmer's abort stop the run.
   */
  start(entries: AncestorEntry[], download: DownloadTile): PreloadTask {
    this.runCount += 1;
    this.stop();

    const own = new AbortController();
    this.current = own;

    const loading = this.loadInOrder(entries, own.signal, download);

    // Each dwell needs a new key because a finished key would be skipped as already warmed.
    return {
      key: `${BASEMAP_PRELOAD_ID}-ancestors-${this.runCount}`,
      run: (abort) => {
        abort.signal.addEventListener("abort", () => own.abort(), { once: true });
        return loading;
      },
    };
  }

  stop(): void {
    this.current?.abort();
    this.current = null;
  }

  private async loadInOrder(
    entries: AncestorEntry[],
    signal: AbortSignal,
    download: DownloadTile,
  ): Promise<undefined> {
    const moved = new AbortController();
    const stop = AbortSignal.any([signal, moved.signal]);
    const events = mapEvents(this.map);
    const onMoveStart = (): void => moved.abort();

    events.on("movestart", onMoveStart);

    try {
      for (const entry of entries) {
        if (stop.aborted) return;

        await this.loadTile(entry, stop, download);
      }
    } finally {
      events.off("movestart", onMoveStart);
    }
  }

  private async loadTile(
    { tile, tileId }: AncestorEntry,
    stop: AbortSignal,
    download: DownloadTile,
  ): Promise<void> {
    let manager: BasemapTileManager;
    let loading: BasemapTile | null | undefined;
    let isOwned: boolean;

    try {
      manager = basemapTileManager(this.map)!;
      isOwned = manager.getTileByID!(String(tileId.key)) === undefined;
      loading = manager._addTile!(tileId);
    } catch {
      await download(tile, stop).catch(() => undefined);
      return;
    }

    if (loading?.state !== "loading") return;

    await waitForTileEvent(this.map, loading, stop);

    // A tile still loading was cancelled or timed out, and only a tile added here is ours to drop.
    if (isOwned && loading.state === "loading") releaseTile(manager, tileId);
  }
}

// Older MapLibre versions call the manager map a source cache.
function basemapTileManager(map: BasemapMap): BasemapTileManager | null {
  const style = (map as { style?: Record<string, Record<string, BasemapTileManager> | undefined> })
    .style;

  return (
    style?.tileManagers?.[BASEMAP_SOURCE_ID] ?? style?.sourceCaches?.[BASEMAP_SOURCE_ID] ?? null
  );
}

// A tile id is only built from a shown tile, because MapLibre offers no public way to make one.
function liveAncestorId(manager: BasemapTileManager, tile: WarmTile): BasemapTileId | null {
  for (const id of manager.getIds?.() ?? []) {
    const shown = manager.getTileByID?.(id)?.tileID;
    const ancestor = shown && shown.overscaledZ >= tile.z ? shown.scaledTo?.(tile.z) : undefined;
    const canonical = ancestor?.canonical;

    if (canonical?.z === tile.z && canonical.x === tile.x && canonical.y === tile.y) {
      return ancestor!;
    }
  }

  return null;
}

function releaseTile(manager: BasemapTileManager, tileId: BasemapTileId): void {
  try {
    manager._removeTile?.(tileId.key!);
  } catch {
    // The tile manager drops unused tiles on its own, so a failed release only delays that.
  }
}

function mapEvents(map: BasemapMap) {
  return map as unknown as {
    on: (type: string, listener: (event: BasemapTileEvent) => void) => void;
    off: (type: string, listener: (event: BasemapTileEvent) => void) => void;
  };
}

// The timeout frees the loader when MapLibre drops a tile without announcing it.
function waitForTileEvent(map: BasemapMap, tile: BasemapTile, stop: AbortSignal): Promise<void> {
  const events = mapEvents(map);

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      stop.removeEventListener("abort", finish);

      for (const type of BASEMAP_TILE_EVENTS) events.off(type, onEvent);

      resolve();
    };
    const onEvent = (event: BasemapTileEvent): void => {
      if (event.tile === tile) finish();
    };
    const timer = setTimeout(finish, BASEMAP_ANCESTOR_TIMEOUT_MS);

    stop.addEventListener("abort", finish, { once: true });

    for (const type of BASEMAP_TILE_EVENTS) events.on(type, onEvent);
  });
}

// Low priority keeps these requests behind the visible ones in the browser's own queue.
async function downloadBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal, priority: "low" });
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);

  return response.blob();
}
