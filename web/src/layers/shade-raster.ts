/** Shade DEM tiles in workers into a fading raster layer with a pinned base in memory. */
import { addProtocol } from "maplibre-gl";
import type { Map as MapLibreMap, RasterTileSource } from "maplibre-gl";

import { warmTilesForZoom, type WarmTile } from "../contour-ladder";
import { prefersReducedMotion } from "../reduced-motion";
import {
  clipViewportToBbox,
  scenePyramidTiles,
  targetViewportBounds,
  tileInScene,
  type DwellViewport,
  type ViewportMap,
} from "../render/tile-viewport";
import type { Bbox, TerrainTiles } from "../types";
import type { ShadeTileId } from "../workers/shade-tile";
import {
  BACKGROUND_SHADE_LANE,
  DEMAND_SHADE_LANE,
  SHADE_POOL_LANES,
  ShadeWorkerPool,
} from "../workers/shade-queue";
import type { ShadeWorkerRequest, ShadeWorkerResponse } from "../workers/shade-worker";

const PROTOCOL = "soeshade";
const FADE_DURATION_MS = 250;
// A slider drag shades faster than one worker answers, so drags thin to one trailing reload.
const RETILE_INTERVAL_MS = 200;

// The fitted level and the next one stay pinned: at most 48 tiles of about 1 MiB each.
export const PINNED_SHADE_TILES_MAX = 48;
// The unpinned store holds one dwell's speculative set of 24 ancestors plus 12 children.
// The extra bitmaps use about 36 MiB on desktop.
export const ANCESTOR_SHADE_TILES_MAX = 36;

// Warming the visible tiles first keeps one strength step to a single cross-fade.
const VISIBLE_SHADE_WARM_MAX = 12;
// Ancestors are covered level by level without letting one dwell flood the worker.
const ANCESTOR_SHADE_WARM_PER_LEVEL = 12;
const ANCESTOR_SHADE_WARM_MAX = 24;
// The next child level warms centre-first, so a zoom-in finds its middle ready.
const CHILD_SHADE_WARM_MAX = 12;

// Raster tiles round the zoom, so the prefetch looks half a level ahead of the switch.
const RASTER_SWITCH_ZOOM = 0.5;

// An idle callback that never runs still warms the base within a couple of seconds.
const IDLE_WARM_TIMEOUT_MS = 2000;

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
  lanes?: number;
  scheduleIdle?: IdleShadeScheduler;
}

/** Deferred shade work, so tests can run the idle queue by hand. */
export type IdleShadeScheduler = (work: () => void) => void;

/** An idle callback with a timeout, so an unseen tab still warms the base. */
type IdleShade = (work: () => void, options?: { timeout: number }) => void;

type WarmingShade = {
  job: Promise<ImageBitmap>;
  abort: AbortController;
  strength: number;
  pinned: boolean;
  lane: number;
  generation: number;
  priority: number;
};

const instances = new Map<number, ShadeRaster>();
let nextInstanceId = 0;
let protocolAdded = false;

/** Terrain shading raster layer whose tiles come from the shading workers. */
export class ShadeRaster {
  private readonly map: MapLibreMap;
  private readonly id: string;
  private readonly instanceId: number;
  private readonly demUrl: string;
  private readonly bbox: Bbox;
  private readonly maxzoom: number;
  private readonly client: ShadeClient;
  private readonly store = new ShadeBitmapStore();
  private readonly warming = new Map<string, WarmingShade>();
  private readonly scheduleIdle: IdleShadeScheduler;
  private readonly canvas: HTMLCanvasElement | null;
  private baseZoom: number;
  private cachedBaseKeys: Set<string> | null = null;
  private dwellGeneration = 0;
  private strength: number;
  private tilesVersion = 0;
  private lastRetileMs = performance.now();
  // The first drag shades at once even when the clock just started, so later inputs coalesce.
  private lastDispatchMs = -RETILE_INTERVAL_MS;
  private strengthGeneration = 0;
  private retileTimer: ReturnType<typeof setTimeout> | null = null;
  private shadeTimer: ReturnType<typeof setTimeout> | null = null;
  private contextLost = false;
  private destroyed = false;

  constructor(map: MapLibreMap, options: ShadeRasterOptions) {
    this.map = map;
    this.id = options.id;
    this.demUrl = options.tiles.url;
    this.bbox = options.bbox;
    this.maxzoom = options.maxzoom;
    this.strength = options.strength;
    this.scheduleIdle = options.scheduleIdle ?? scheduleIdleShade;
    this.client = new ShadeClient(options.createWorker ?? startShadeWorker, options.lanes);
    this.baseZoom = baseZoomFor(map, options.maxzoom);
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
    this.canvas = typeof map.getCanvas === "function" ? map.getCanvas() : null;
    // A bare test double answers getCanvas without listener methods, so only real canvases listen.
    if (typeof this.canvas?.addEventListener === "function") {
      this.canvas.addEventListener("webglcontextlost", this.onContextLost);
      this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    }
    map.on("moveend", this.onMoveEnd);
    this.warmBase();
  }

  /**
   * Reshade with a new strength. The latest value wins while visible-first work starts at
   * most once per interval, and MapLibre holds each tile's old image until its new one fades in.
   */
  setStrength(strength: number): void {
    if (strength === this.strength || this.destroyed) return;

    this.strength = strength;
    this.strengthGeneration += 1;
    this.cancelWarming();
    // A lost context keeps only the requested strength, and the restore rebuilds from it.
    if (this.contextLost) return;
    this.dispatchVisible();
    this.scheduleRetile();
  }

  /**
   * Refit the pinned base after landing establishes the camera. The constructor only sees
   * the zoom at mount time, so the scene calls this with the fitted zoom once it lands.
   */
  setBaseZoom(zoom: number): void {
    const fitted = Math.min(Math.max(Math.floor(zoom), 0), this.maxzoom);
    if (fitted === this.baseZoom || this.destroyed) return;

    this.baseZoom = fitted;
    this.cachedBaseKeys = null;
    const base = this.baseKeys();
    this.store.demoteExcept(base);
    this.cancelObsoleteWarming(base);
    if (this.contextLost) return;
    this.warmBase();
  }

  /** Shade a tile with the current strength, preferring a stored or warming bitmap. */
  shadeTile(tile: ShadeTileId, signal: AbortSignal): Promise<ImageBitmap> {
    // A lost or destroyed layer answers nothing, even when the bitmap is already settled.
    if (this.contextLost || this.destroyed) return Promise.reject(abortError());

    const cached = this.store.get(tile, this.strength);
    if (cached) return Promise.resolve(cached);

    const key = tileKey(tile);
    const warming = this.warming.get(key);
    if (warming && warming.strength === this.strength) {
      // Demand never waits behind preshading, so a visible tile leaves the background lane.
      if (warming.lane === DEMAND_SHADE_LANE) return detachOnAbort(warming.job, signal);
      if (this.warming.get(key) === warming) this.warming.delete(key);
      warming.abort.abort();
      return this.shadeNow(tile, signal);
    }

    return this.shadeNow(tile, signal);
  }

  shadeNow(tile: ShadeTileId, signal: AbortSignal): Promise<ImageBitmap> {
    if (this.contextLost || this.destroyed) return Promise.reject(abortError());
    const strength = this.strength;
    // Visible demand outranks every speculative tile, so it survives the next trim.
    const priority = tile.z * 2 + 1;
    return this.client.shade(tile, strength, this.demUrl, signal).then((bitmap) => {
      if (this.destroyed || this.contextLost || strength !== this.strength) {
        bitmap.close();
        throw abortError();
      }
      // Stamp the result with the current dwell, so a filled dwell never buries it.
      // The base may have refit while the worker shaded, so the pin follows the new base.
      this.store.put(
        tile,
        strength,
        bitmap,
        this.baseKeys().has(tileKey(tile)),
        this.dwellGeneration,
        priority,
      );
      return bitmap;
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retileTimer !== null) clearTimeout(this.retileTimer);
    this.retileTimer = null;
    if (this.shadeTimer !== null) clearTimeout(this.shadeTimer);
    this.shadeTimer = null;
    this.map.off("moveend", this.onMoveEnd);
    // The constructor only listens on real canvases, so removal skips bare test doubles too.
    if (typeof this.canvas?.removeEventListener === "function") {
      this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
      this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    }
    this.cancelWarming();
    this.client.destroy();
    this.store.clear();
    instances.delete(this.instanceId);
    removeRaster(this.map, this.id);
  }

  /** Shade the pinned base levels on idle, so a zoom-out answers within a frame. */
  private warmBase(): void {
    this.scheduleIdle(() => {
      if (this.destroyed || this.contextLost) return;
      for (const tile of this.baseTiles()) {
        this.warmOne(tile, true, BACKGROUND_SHADE_LANE, this.dwellGeneration, 0);
      }
    });
  }

  /** Reconcile one dwell's speculative set, so outstanding background work stays bounded. */
  private warmAncestors(): void {
    if (this.destroyed || this.contextLost) return;
    const rounded = this.rasterZoom();
    if (rounded === null) return;
    this.dwellGeneration += 1;
    const generation = this.dwellGeneration;
    const ancestors = this.ancestorTiles();
    const children = this.childTiles();
    const wanted = new Map<string, number>();
    for (const tile of ancestors) wanted.set(tileKey(tile), tile.z * 2);
    // Children rank below the nearest ancestor, so a zoom-out survives first.
    const childPriority = (rounded - 1) * 2 - 1;
    for (const tile of children) wanted.set(tileKey(tile), childPriority);
    for (const tile of [...ancestors, ...children]) {
      const priority = wanted.get(tileKey(tile));
      if (priority !== undefined) {
        this.store.refresh(tile, this.strength, generation, priority);
      }
    }
    this.cancelOutsideWanted(wanted, generation);
    for (const tile of ancestors) {
      this.warmOne(tile, false, BACKGROUND_SHADE_LANE, generation, tile.z * 2);
    }
    for (const tile of children) {
      this.warmOne(tile, false, BACKGROUND_SHADE_LANE, generation, childPriority);
    }
  }

  /** Cancel stale speculative warming outside the wanted set and refresh what remains. */
  private cancelOutsideWanted(wanted: Map<string, number>, generation: number): void {
    for (const [key, entry] of this.warming) {
      if (entry.lane !== BACKGROUND_SHADE_LANE || entry.pinned) continue;
      const priority = wanted.get(key);
      if (priority === undefined) {
        this.warming.delete(key);
        entry.abort.abort();
      } else {
        entry.generation = generation;
        entry.priority = priority;
      }
    }
  }

  /** Shade one tile unless it is already stored or warming. */
  private warmOne(
    tile: WarmTile,
    pinned: boolean,
    lane: number = BACKGROUND_SHADE_LANE,
    generation: number = this.dwellGeneration,
    priority: number = 0,
  ): void {
    if (this.destroyed || this.contextLost) return;
    const key = tileKey(tile);
    const keepPinned = pinned || this.baseKeys().has(key);
    const ongoing = this.warming.get(key);
    if (this.store.has(tile, this.strength)) {
      if (keepPinned) this.store.promote(tile);
      if (ongoing && keepPinned) ongoing.pinned = true;
      return;
    }
    if (ongoing) {
      if (keepPinned) ongoing.pinned = true;
      return;
    }

    const strength = this.strength;
    const abort = new AbortController();
    const job = this.client.shade(tile, strength, this.demUrl, abort.signal, lane);
    this.warming.set(key, { job, abort, strength, pinned: keepPinned, lane, generation, priority });
    job.then(
      (bitmap) => this.keepWarming(key, tile, strength, bitmap, job),
      () => {
        if (this.warming.get(key)?.job === job) this.warming.delete(key);
      },
    );
  }

  private keepWarming(
    key: string,
    tile: WarmTile,
    strength: number,
    bitmap: ImageBitmap,
    job: Promise<ImageBitmap>,
  ): void {
    const ongoing = this.warming.get(key);
    if (!ongoing || ongoing.job !== job) {
      bitmap.close();
      return;
    }
    const generation = ongoing.generation;
    const priority = ongoing.priority;
    this.warming.delete(key);
    if (strength === this.strength && !this.destroyed && !this.contextLost) {
      // A refit may have moved the base while the worker shaded, so the pin follows it.
      this.store.put(tile, strength, bitmap, this.baseKeys().has(key), generation, priority);
    } else {
      bitmap.close();
    }
  }

  /** Abort obsolete base warming and upgrade warming that joined the base on refit. */
  private cancelObsoleteWarming(valid: Set<string>): void {
    for (const [key, entry] of this.warming) {
      if (entry.pinned && !valid.has(key)) {
        this.warming.delete(key);
        entry.abort.abort();
      } else if (!entry.pinned && valid.has(key)) {
        entry.pinned = true;
      }
    }
  }

  /** Abort background shadings, whose rejections clean up after themselves. */
  private cancelWarming(): void {
    const warming = [...this.warming.values()];
    this.warming.clear();
    for (const entry of warming) entry.abort.abort();
  }

  /** Start visible-first work now when the cadence allows, else trail the latest value. */
  private dispatchVisible(): void {
    if (this.shadeTimer !== null) return;
    const wait = this.lastDispatchMs + RETILE_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      this.dispatchNow();
      return;
    }
    this.shadeTimer = setTimeout(() => {
      this.shadeTimer = null;
      if (this.destroyed || this.contextLost) return;
      this.dispatchNow();
    }, wait);
  }

  /** Shade the viewport then rewarm the base, both at the latest strength. */
  private dispatchNow(): void {
    this.warmVisible();
    this.rebuildBase();
  }

  /** Shade the viewport at the latest strength, so a drag shades at most twice per window. */
  private warmVisible(): void {
    this.lastDispatchMs = performance.now();
    for (const tile of this.visibleTiles()) {
      this.warmOne(tile, false, DEMAND_SHADE_LANE, this.dwellGeneration, tile.z * 2 + 1);
    }
  }

  /** Rewarm the whole pinned base in the background once the visible pass has started. */
  private rebuildBase(): void {
    const generation = this.strengthGeneration;
    const dwell = this.dwellGeneration;
    this.scheduleIdle(() => {
      if (this.destroyed || this.contextLost || generation !== this.strengthGeneration) return;
      for (const tile of this.baseTiles()) {
        this.warmOne(tile, true, BACKGROUND_SHADE_LANE, dwell, 0);
      }
    });
  }

  /** Thin the source reload to one per interval while the strength settles. */
  private scheduleRetile(): void {
    if (this.retileTimer !== null) return;
    const wait = Math.max(0, this.lastRetileMs + RETILE_INTERVAL_MS - performance.now());
    this.retileTimer = setTimeout(() => this.retile(), wait);
  }

  /** The fitted level and the next one over the scene, centre-first and capped. */
  private baseTiles(): WarmTile[] {
    return scenePyramidTiles(
      this.bbox,
      this.baseZoom,
      Math.min(this.baseZoom + 1, this.maxzoom),
      PINNED_SHADE_TILES_MAX,
    );
  }

  /** The pinned base identities, so demand and ancestor inserts keep their classification. */
  private baseKeys(): Set<string> {
    if (!this.cachedBaseKeys) {
      this.cachedBaseKeys = new Set(this.baseTiles().map((tile) => tileKey(tile)));
    }
    return this.cachedBaseKeys;
  }

  /** The tiles covering the viewport at the raster zoom, centre-first and capped. */
  private visibleTiles(): WarmTile[] {
    if (typeof this.map.getBounds !== "function") return [];
    const zoom = this.rasterZoom();
    if (zoom === null) return [];
    const bounds = this.map.getBounds();
    return warmTilesForZoom(
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
      zoom,
      VISIBLE_SHADE_WARM_MAX,
    ).filter((tile) => tileInScene(tile, this.bbox));
  }

  /** The ancestors over the zoom-out footprint, nearest first so the request cap keeps them. */
  private ancestorTiles(): WarmTile[] {
    const rounded = this.rasterZoom();
    if (rounded === null) return [];
    const seen = new Set<string>(this.baseKeys());
    const warmed: WarmTile[] = [];
    for (let zoom = rounded - 1; zoom >= this.baseZoom; zoom -= 1) {
      if (warmed.length >= ANCESTOR_SHADE_WARM_MAX || zoom < 0) break;
      const viewport = this.viewportForZoom(zoom);
      if (!viewport) continue;
      const level = warmTilesForZoom(
        viewport.west,
        viewport.south,
        viewport.east,
        viewport.north,
        zoom,
        ANCESTOR_SHADE_WARM_PER_LEVEL,
      ).filter((tile) => tileInScene(tile, this.bbox) && !seen.has(tileKey(tile)));
      const room = ANCESTOR_SHADE_WARM_MAX - warmed.length;
      const take = level.slice(0, room);
      for (const tile of take) seen.add(tileKey(tile));
      warmed.push(...take);
    }
    return warmed;
  }

  /** The next child level over the zoom-in footprint, nearest the centre first. */
  private childTiles(): WarmTile[] {
    const rounded = this.rasterZoom();
    if (rounded === null) return [];
    const childZoom = rounded + 1;
    if (childZoom > this.maxzoom) return [];
    const viewport = this.viewportForZoom(childZoom);
    if (!viewport) return [];
    return warmTilesForZoom(
      viewport.west,
      viewport.south,
      viewport.east,
      viewport.north,
      childZoom,
      CHILD_SHADE_WARM_MAX,
    ).filter((tile) => tileInScene(tile, this.bbox) && !this.baseKeys().has(tileKey(tile)));
  }

  /** The raster zoom MapLibre requests, rounding because the source rounds too. */
  private rasterZoom(): number | null {
    if (typeof this.map.getZoom !== "function") return null;
    return Math.min(Math.max(Math.round(this.map.getZoom()), 0), this.maxzoom);
  }

  /** The viewport as seen at another zoom, expanded or shrunk and clipped to the scene. */
  private viewportForZoom(targetZoom: number): DwellViewport | null {
    const predicted = targetViewportBounds(
      this.map as unknown as ViewportMap,
      targetZoom,
      RASTER_SWITCH_ZOOM,
    );
    if (predicted) return clipViewportToBbox(predicted, this.bbox);
    if (typeof this.map.getBounds !== "function") return null;
    const bounds = this.map.getBounds();
    return clipViewportToBbox(
      {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      },
      this.bbox,
    );
  }

  private retile(): void {
    this.retileTimer = null;
    this.lastRetileMs = performance.now();
    this.tilesVersion += 1;
    // A partial test double may omit tile-source reads, so a missing source skips the reload.
    const source = typeof this.map.getSource === "function"
      ? (this.map.getSource(this.id) as RasterTileSource | undefined)
      : undefined;
    source?.setTiles([this.tileUrl()]);
  }

  private tileUrl(): string {
    return `${PROTOCOL}://${this.instanceId}/${this.tilesVersion}/{z}/{x}/{y}`;
  }

  // A lost context drops the GL state MapLibre rebuilds, so shading pauses until it restores.
  private readonly onContextLost = (): void => {
    this.contextLost = true;
    if (this.retileTimer !== null) {
      clearTimeout(this.retileTimer);
      this.retileTimer = null;
    }
    if (this.shadeTimer !== null) {
      clearTimeout(this.shadeTimer);
      this.shadeTimer = null;
    }
    this.cancelWarming();
    this.client.destroy();
    this.store.clear();
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.lastDispatchMs = 0;
    this.warmBase();
    this.retile();
  };

  private readonly onMoveEnd = (): void => {
    this.scheduleIdle(() => this.warmAncestors());
  };
}

type PendingShade = {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
  lane: number;
};

/** Send tiles to one shading worker per lane and match every answer to its request. */
export class ShadeClient {
  private readonly pool: ShadeWorkerPool;
  private readonly pending = new Map<number, PendingShade>();
  private nextId = 0;

  constructor(createWorker: () => ShadeWorker, lanes: number = SHADE_POOL_LANES) {
    this.pool = new ShadeWorkerPool(createWorker, lanes);
    this.pool.onresponse = (response) => this.settle(response as ShadeWorkerResponse);
    this.pool.onlaneerror = (lane) => this.failLane(lane);
  }

  shade(
    tile: ShadeTileId,
    strength: number,
    demUrl: string,
    signal: AbortSignal,
    lane: number = DEMAND_SHADE_LANE,
  ): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }

      const id = this.nextId++;
      this.pool.send(lane, { type: "shade", id, tile, strength, demUrl });
      this.pending.set(id, { resolve, reject, lane });
      signal.addEventListener("abort", () => this.cancel(id), { once: true });
    });
  }

  /** Stop every worker and fail what each still owed, which frees its decoded tiles. */
  destroy(): void {
    this.pool.terminate();
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) request.reject(abortError());
  }

  private cancel(id: number): void {
    const request = this.pending.get(id);
    if (!request) return;

    this.pending.delete(id);
    this.pool.cancel(id);
    request.reject(abortError());
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

  private failLane(lane: number): void {
    const error = new Error("The terrain shading worker failed");
    for (const [id, request] of this.pending) {
      if (request.lane !== lane) continue;
      this.pending.delete(id);
      request.reject(error);
    }
  }
}

type ShadeBitmapEntry = {
  bitmap: ImageBitmap;
  strength: number;
  pinned: boolean;
  generation: number;
  priority: number;
};

/**
 * Shaded bitmaps for the current strength: the fitted levels stay pinned while one dwell's
 * speculative set cycles beside them. Eviction drops the oldest dwell first. Children go
 * before the nearest ancestors, so the zoom-out footprint survives. Every replacement,
 * eviction and clear closes the bitmap it drops, and the scene exit clears the whole store.
 */
export class ShadeBitmapStore {
  private readonly entries = new Map<string, ShadeBitmapEntry>();

  constructor(
    private readonly pinnedMax: number = PINNED_SHADE_TILES_MAX,
    private readonly ancestorMax: number = ANCESTOR_SHADE_TILES_MAX,
  ) {}

  /** Return the bitmap for a tile at one strength, refreshing its LRU position. */
  get(tile: ShadeTileId, strength: number): ImageBitmap | undefined {
    const key = tileKey(tile);
    const entry = this.entries.get(key);
    if (!entry || entry.strength !== strength) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.bitmap;
  }

  /** Whether a tile is already stored at one strength. */
  has(tile: ShadeTileId, strength: number): boolean {
    return this.get(tile, strength) !== undefined;
  }

  /** Store a bitmap, closing what it replaces and trimming past the caps. */
  put(
    tile: ShadeTileId,
    strength: number,
    bitmap: ImageBitmap,
    pinned: boolean,
    generation = 0,
    priority = 0,
  ): void {
    const key = tileKey(tile);
    const previous = this.entries.get(key);
    // A demand completion must never demote a pinned base entry at the same strength.
    const keepPinned = pinned || (previous?.strength === strength && previous?.pinned === true);
    if (previous) {
      this.entries.delete(key);
      previous.bitmap.close();
    }
    // The caller keeps its bitmap, so an immediate trim must never close the return.
    this.entries.set(key, { bitmap, strength, pinned: keepPinned, generation, priority });
    this.trim(false, this.ancestorMax, key);
    this.trim(true, this.pinnedMax, key);
  }

  /** Keep a stored tile pinned, so an earlier demand insert joins the base. */
  promote(tile: ShadeTileId): void {
    const key = tileKey(tile);
    const entry = this.entries.get(key);
    if (!entry || entry.pinned) return;
    this.entries.delete(key);
    this.entries.set(key, { ...entry, pinned: true });
  }

  /** Refresh a stored tile into the current dwell, so still-useful tiles survive. */
  refresh(tile: ShadeTileId, strength: number, generation: number, priority: number): boolean {
    const key = tileKey(tile);
    const entry = this.entries.get(key);
    if (!entry || entry.strength !== strength || entry.pinned) return false;
    this.entries.delete(key);
    this.entries.set(key, { ...entry, generation, priority });
    return true;
  }

  /** Demote stored pins that left the base, so obsolete levels stop counting as pinned. */
  demoteExcept(valid: Set<string>): void {
    for (const [key, entry] of this.entries) {
      if (entry.pinned && !valid.has(key)) entry.pinned = false;
    }
    this.trim(false, this.ancestorMax);
  }

  /** Drop cached bitmaps, closing each so its upload frees. */
  clear(): void {
    for (const entry of this.entries.values()) entry.bitmap.close();
    this.entries.clear();
  }

  /** How many bitmaps the store holds, so tests can bound the memory. */
  get size(): number {
    return this.entries.size;
  }

  private trim(pinned: boolean, max: number, exemptKey?: string): void {
    const matching = [...this.entries].filter(
      ([key, entry]) => entry.pinned === pinned && key !== exemptKey,
    );
    const exempted = exemptKey === undefined ? undefined : this.entries.get(exemptKey);
    const total = matching.length + (exempted?.pinned === pinned ? 1 : 0);
    if (total <= max) return;
    if (!pinned) {
      // The zoom-out footprint survives because old dwells and children trim first.
      matching.sort(
        (left, right) => left[1].generation - right[1].generation
          || left[1].priority - right[1].priority,
      );
    }
    const overflow = matching.slice(0, total - max);
    for (const [key, entry] of overflow) this.drop(key, entry);
  }

  private drop(key: string, entry: ShadeBitmapEntry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    entry.bitmap.close();
  }
}

function startShadeWorker(): ShadeWorker {
  return new Worker(new URL("../workers/shade-worker.ts", import.meta.url), { type: "module" });
}

function removeRaster(map: MapLibreMap, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
  // A bare test double may omit tile-source reads, so only real maps drop the source.
  if (typeof map.getSource === "function" && map.getSource(id)) map.removeSource(id);
}

const SHADE_URL = new RegExp(`^${PROTOCOL}://(\\d+)/(\\d+)/(\\d+)/(\\d+)/(\\d+)$`);

/** Answer MapLibre's tile requests for the shade protocol with worker-made bitmaps. */
async function serveShadeTile(
  parameters: { url: string },
  abortController: AbortController,
): Promise<{ data: ImageBitmap }> {
  const match = SHADE_URL.exec(parameters.url);
  const instance = match && instances.get(Number(match[1]));
  if (!match || !instance) throw abortError();

  const [z, x, y] = match.slice(3).map(Number);
  return { data: await instance.shadeTile({ z, x, y }, abortController.signal) };
}

/**
 * Share a warming bitmap without sharing its ownership: the caller's abort only stops its
 * own wait while the background job still fills the store for the next request.
 */
function detachOnAbort(job: Promise<ImageBitmap>, signal: AbortSignal): Promise<ImageBitmap> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
    job.then(resolve, reject);
  });
}

/**
 * Warm shade work when the browser idles, or on a short timer without idle callbacks.
 */
function scheduleIdleShade(work: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: IdleShade }).requestIdleCallback;
  if (typeof idle === "function") {
    idle.call(globalThis, work, { timeout: IDLE_WARM_TIMEOUT_MS });
    return;
  }
  setTimeout(work, 0);
}

/** The integer zoom the scene fits at, read from the camera resting on the fit. */
function baseZoomFor(map: MapLibreMap, maxzoom: number): number {
  if (typeof map.getZoom !== "function") return maxzoom;
  return Math.min(Math.max(Math.floor(map.getZoom()), 0), maxzoom);
}

function tileKey(tile: ShadeTileId): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}
