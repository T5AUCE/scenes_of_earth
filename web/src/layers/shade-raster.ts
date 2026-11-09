/** Draw terrain shading as raster tiles shaded in a worker, so each tile fades in. */
import { addProtocol } from "maplibre-gl";
import type { Map as MapLibreMap, RasterTileSource } from "maplibre-gl";

import { warmTilesForZoom, type WarmTile } from "../contour-ladder";
import { subscribeGesture } from "../gesture-quality";
import { prefersReducedMotion } from "../reduced-motion";
import { targetViewportBounds, tileInScene } from "../render/tile-viewport";
import type { Bbox, TerrainTiles } from "../types";
import type { ShadeTileId } from "../workers/shade-tile";
import type { ShadeWorkerRequest, ShadeWorkerResponse } from "../workers/shade-worker";

const PROTOCOL = "soeshade";
const FADE_DURATION_MS = 250;
// A slider drag changes strength faster than the worker can reshade every visible tile.
const RETILE_INTERVAL_MS = 200;

// The prefetch never delays a visible tile, so it runs few shadings at a time and no flings.
export const PREFETCH_MAX_IN_FLIGHT = 4;
export const PREFETCH_MAX_TILES = 12;
const PREFETCH_FLING_ZOOM_PER_SEC = 3;
const SWITCH_ZOOM_OFFSET = 0.5;

/** The worker side of a shade request, so tests can stand in for a real worker. */
export interface ShadeWorker {
  postMessage(request: ShadeWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ShadeWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface ShadeRasterOptions {
  id: string;
  tiles: TerrainTiles;
  maxzoom: number;
  /** Source bounds, empty when the area crosses the antimeridian. */
  bounds: { bounds?: Bbox };
  bbox: Bbox;
  strength: number;
  beforeId: string;
  createWorker?: () => ShadeWorker;
}

type PendingShade = { resolve: (bitmap: ImageBitmap) => void; reject: (error: Error) => void };

/** Send tiles to one lazily started shading worker and match its answers to requests. */
export class ShadeClient {
  private readonly createWorker: () => ShadeWorker;
  private readonly pending = new Map<number, PendingShade>();
  private worker: ShadeWorker | null = null;
  private nextId = 0;

  constructor(createWorker: () => ShadeWorker) {
    this.createWorker = createWorker;
  }

  shade(
    tile: ShadeTileId,
    strength: number,
    demUrl: string,
    signal: AbortSignal,
  ): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }

      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      signal.addEventListener("abort", () => this.cancel(id), { once: true });
      this.startedWorker().postMessage({ type: "shade", id, tile, strength, demUrl });
    });
  }

  /** Stop the worker and fail what it still owed, which frees its decoded tiles. */
  destroy(): void {
    this.terminate(abortError());
  }

  private cancel(id: number): void {
    const request = this.pending.get(id);
    if (!request) return;

    this.pending.delete(id);
    this.worker?.postMessage({ type: "cancel", id });
    request.reject(abortError());
  }

  private startedWorker(): ShadeWorker {
    if (this.worker) return this.worker;

    const worker = this.createWorker();
    worker.onmessage = (event) => this.settle(event.data);
    worker.onerror = () => this.terminate(new Error("The terrain shading worker failed"));
    this.worker = worker;
    return worker;
  }

  private terminate(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) request.reject(error);
  }

  private settle(response: ShadeWorkerResponse): void {
    const request = this.pending.get(response.id);
    this.pending.delete(response.id);
    if ("bitmap" in response) {
      if (request) request.resolve(response.bitmap);
      else response.bitmap.close();
    } else {
      request?.reject(new Error(response.error));
    }
  }
}

function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

const instances = new Map<number, ShadeRaster>();
let nextInstanceId = 0;
let protocolAdded = false;

/** Terrain shading raster layer whose tiles come from the shading worker. */
export class ShadeRaster {
  private readonly map: MapLibreMap;
  private readonly id: string;
  private readonly instanceId: number;
  private readonly demUrl: string;
  private readonly client: ShadeClient;
  private readonly prefetch: ShadePrefetch;
  private readonly canvas: HTMLCanvasElement | null;
  private strength: number;
  private tilesVersion = 0;
  private lastRetileMs = performance.now();
  private retileTimer: ReturnType<typeof setTimeout> | null = null;
  private contextLost = false;

  constructor(map: MapLibreMap, options: ShadeRasterOptions) {
    this.map = map;
    this.id = options.id;
    this.demUrl = options.tiles.url;
    this.strength = options.strength;
    this.client = new ShadeClient(options.createWorker ?? startShadeWorker);
    this.instanceId = nextInstanceId++;
    instances.set(this.instanceId, this);
    if (!protocolAdded) {
      addProtocol(PROTOCOL, serveShadeTile);
      protocolAdded = true;
    }
    map.addSource(this.id, {
      type: "raster",
      tiles: [this.tileUrl()],
      tileSize: options.tiles.tile_size,
      maxzoom: options.maxzoom,
      attribution: options.tiles.source.attribution,
      ...options.bounds,
    });
    map.addLayer(
      {
        id: this.id,
        type: "raster",
        source: this.id,
        paint: { "raster-fade-duration": prefersReducedMotion() ? 0 : FADE_DURATION_MS },
      },
      options.beforeId,
    );
    this.prefetch = new ShadePrefetch(map, this, options.maxzoom, options.bbox);
    this.canvas = typeof map.getCanvas === "function" ? map.getCanvas() : null;
    this.canvas?.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas?.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  /**
   * Reshade with a new strength. MapLibre keeps showing a tile's old image while the tiles
   * reload, so the swap never flashes, and drags are thinned so the worker keeps up.
   */
  setStrength(strength: number): void {
    if (strength === this.strength) return;

    this.strength = strength;
    this.prefetch.clear();
    if (this.retileTimer !== null) return;

    const wait = Math.max(0, this.lastRetileMs + RETILE_INTERVAL_MS - performance.now());
    this.retileTimer = setTimeout(() => this.retile(), wait);
  }

  /** Shade a tile with the current strength, preferring one the prefetch already made. */
  shadeTile(tile: ShadeTileId, signal: AbortSignal): Promise<ImageBitmap> {
    return this.prefetch.take(tile, signal) ?? this.shadeNow(tile, signal);
  }

  shadeNow(tile: ShadeTileId, signal: AbortSignal): Promise<ImageBitmap> {
    if (this.contextLost) return Promise.reject(abortError());
    return this.client.shade(tile, this.strength, this.demUrl, signal);
  }

  destroy(): void {
    if (this.retileTimer !== null) clearTimeout(this.retileTimer);
    this.canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.prefetch.destroy();
    this.client.destroy();
    instances.delete(this.instanceId);
    removeRaster(this.map, this.id);
  }

  // A lost context drops the GL state MapLibre rebuilds, so pause shading until it restores
  // and let the lazily started worker come back on the next tile.
  private readonly onContextLost = (): void => {
    this.contextLost = true;
    if (this.retileTimer !== null) {
      clearTimeout(this.retileTimer);
      this.retileTimer = null;
    }
    this.prefetch.reset();
    this.client.destroy();
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.prefetch.reset();
  };

  private retile(): void {
    this.retileTimer = null;
    this.lastRetileMs = performance.now();
    this.tilesVersion += 1;
    const source = this.map.getSource(this.id) as RasterTileSource | undefined;
    source?.setTiles([this.tileUrl()]);
  }

  private tileUrl(): string {
    return `${PROTOCOL}://${this.instanceId}/${this.tilesVersion}/{z}/{x}/{y}`;
  }
}

function startShadeWorker(): ShadeWorker {
  return new Worker(new URL("../workers/shade-worker.ts", import.meta.url), { type: "module" });
}

function removeRaster(map: MapLibreMap, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

const SHADE_URL = new RegExp(`^${PROTOCOL}://(\\d+)/\\d+/(\\d+)/(\\d+)/(\\d+)$`);

/** Answer MapLibre's tile requests for the shade protocol with worker-made bitmaps. */
async function serveShadeTile(
  parameters: { url: string },
  abortController: AbortController,
): Promise<{ data: ImageBitmap }> {
  const match = SHADE_URL.exec(parameters.url);
  const instance = match && instances.get(Number(match[1]));
  if (!match || !instance) throw abortError();

  const [z, x, y] = match.slice(2).map(Number);
  return { data: await instance.shadeTile({ z, x, y }, abortController.signal) };
}

type PrefetchEntry = {
  bitmap: Promise<ImageBitmap>;
  abort: AbortController;
  settled: boolean;
  handedOff: boolean;
};

/**
 * Shade the next integer zoom while the camera zooms in, so its tiles are ready when MapLibre
 * asks and fade in over the stretched parent. It runs few shadings at a time, aborts them on
 * reversal, pan, a fling or exit, and holds a bounded set of finished tiles until taken.
 */
export class ShadePrefetch {
  private readonly map: MapLibreMap;
  private readonly raster: ShadeRaster;
  private readonly maxzoom: number;
  private readonly bbox: Bbox;
  private readonly tiles = new Map<string, PrefetchEntry>();
  private readonly consumed = new Set<string>();
  private readonly stopListening: () => void;
  private lastZoom: number | null = null;
  private lastTarget: number | null = null;
  private lastTimeMs = 0;
  private zoomingIn = false;
  private isGesturing = false;

  constructor(
    map: MapLibreMap,
    raster: ShadeRaster,
    maxzoom: number,
    bbox: Bbox,
    clock: () => number = () => performance.now(),
  ) {
    this.map = map;
    this.raster = raster;
    this.maxzoom = maxzoom;
    this.bbox = bbox;
    const zoomed = () => {
      this.trackDirection(map.getZoom(), clock());
      this.consider();
    };
    const moved = () => this.consider();
    // A pan can begin while the zoom gesture stays active, so it needs its own reset.
    const dragged = () => this.reset();
    map.on("zoom", zoomed);
    map.on("move", moved);
    map.on("dragstart", dragged);
    const stopGesture = subscribeGesture(map, {
      onStart: () => {
        this.isGesturing = true;
        this.reset();
      },
      onEnd: () => {
        this.isGesturing = false;
        this.reset();
      },
    });
    this.stopListening = () => {
      map.off("zoom", zoomed);
      map.off("move", moved);
      map.off("dragstart", dragged);
      stopGesture();
    };
  }

  /**
   * Hand over a finished or running tile, which the caller then owns. A running job stays in
   * the prefetch until it settles, and the caller's own abort cancels it through its signal.
   */
  take(tile: ShadeTileId, signal: AbortSignal): Promise<ImageBitmap> | undefined {
    const key = tileKey(tile);
    const entry = this.tiles.get(key);
    if (!entry) return undefined;
    this.consumed.add(key);
    entry.handedOff = true;
    if (entry.settled) this.tiles.delete(key);
    else if (signal.aborted) entry.abort.abort();
    else signal.addEventListener("abort", () => entry.abort.abort(), { once: true });
    return entry.bitmap;
  }

  /** Drop every tile, because they were shaded for a strength that no longer applies. */
  clear(): void {
    this.reset();
  }

  /**
   * Forget the gesture: abort owned work, close finished bitmaps and drop the zoom tracking,
   * so a later pan never resumes a stale zoom-in. Tiles handed to MapLibre are only forgotten
   * because their owner still aborts and settles them.
   */
  reset(): void {
    for (const [key, entry] of this.tiles) {
      if (entry.handedOff) this.tiles.delete(key);
      else this.drop(key, entry);
    }
    this.consumed.clear();
    this.lastZoom = null;
    this.lastTarget = null;
    this.zoomingIn = false;
  }

  destroy(): void {
    this.reset();
    this.stopListening();
  }

  private consider(): void {
    const target = Math.floor(this.map.getZoom()) + 1;
    if (target !== this.lastTarget) {
      this.consumed.clear();
      this.lastTarget = target;
    }
    if (!this.zoomingIn || !this.isGesturing || target > this.maxzoom) {
      this.abortRunning(new Set());
      return;
    }

    const wanted = this.wantedTiles(target);
    this.abortRunning(new Set(wanted.map(tileKey)));
    for (const tile of wanted) {
      if (this.runningCount() >= PREFETCH_MAX_IN_FLIGHT) return;
      const key = tileKey(tile);
      if (!this.tiles.has(key) && !this.consumed.has(key)) this.start(tile);
    }
  }

  private wantedTiles(target: number): WarmTile[] {
    const bounds = targetViewportBounds(
      this.map,
      target,
      SWITCH_ZOOM_OFFSET,
      { clampLatitude: true },
    );
    if (!bounds) return [];

    return warmTilesForZoom(
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north,
      target,
      PREFETCH_MAX_TILES,
    ).filter((tile) => tileInScene(tile, this.bbox));
  }

  private start(tile: WarmTile): void {
    const key = tileKey(tile);
    const abort = new AbortController();
    const entry: PrefetchEntry = {
      bitmap: this.raster.shadeNow(tile, abort.signal),
      abort,
      settled: false,
      handedOff: false,
    };
    this.tiles.set(key, entry);
    entry.bitmap.then(
      () => {
        entry.settled = true;
        if (entry.handedOff) {
          if (this.tiles.get(key) === entry) this.tiles.delete(key);
        } else this.evictOldest();
      },
      () => {
        if (this.tiles.get(key) === entry) this.tiles.delete(key);
      },
    );
  }

  private evictOldest(): void {
    while (this.tiles.size > PREFETCH_MAX_TILES) {
      const oldest = [...this.tiles].find(([, entry]) => !entry.handedOff);
      if (!oldest) return;
      this.drop(oldest[0], oldest[1]);
    }
  }

  private abortRunning(keep: ReadonlySet<string>): void {
    for (const [key, entry] of this.tiles) {
      if (!entry.settled && !entry.handedOff && !keep.has(key)) this.drop(key, entry);
    }
  }

  private drop(key: string, entry: PrefetchEntry): void {
    this.tiles.delete(key);
    entry.abort.abort();
    entry.bitmap.then((bitmap) => bitmap.close(), () => {});
  }

  private runningCount(): number {
    return [...this.tiles.values()].filter((entry) => !entry.settled).length;
  }

  private trackDirection(zoom: number, nowMs: number): void {
    if (this.lastZoom !== null && zoom < this.lastZoom) {
      this.zoomingIn = false;
    } else if (this.lastZoom !== null && zoom > this.lastZoom) {
      const elapsedMs = Math.max(1, nowMs - this.lastTimeMs);
      this.zoomingIn = (zoom - this.lastZoom) / elapsedMs * 1000 <= PREFETCH_FLING_ZOOM_PER_SEC;
    }
    this.lastZoom = zoom;
    this.lastTimeMs = nowMs;
  }
}

function tileKey(tile: ShadeTileId): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}
