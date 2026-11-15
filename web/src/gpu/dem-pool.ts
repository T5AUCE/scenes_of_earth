/**
 * Decoded DEM tiles as R32F textures shared by the relief and contour layers. The pool fetches
 * and decodes in workers, keeps the tile edges so neighbours can fill each other's halo, and
 * uploads from a call the layer makes inside `render`.
 */
import { DEM_TILE_SIZE_PX, STRIP_WIDTH_PX, stripOf, type StripSide } from "../workers/dem-decode";
import type { DemWorkerRequest, DemWorkerResponse } from "../workers/dem-worker";
import type { WantedTile } from "./dem-plan";

/** A texture handle the pool hands to the layer; only the store knows what it is. */
export type DemTexture = object;

/** The GL work the pool needs, so tests can run without WebGL. */
export interface DemTextureStore {
  /** True when the context filters R32F linearly, so the shader can sample directly. */
  readonly linear: boolean;
  /** Upload a full padded tile, `TEXTURE_SIZE_PX` square. */
  create(data: Float32Array): DemTexture;
  patch(
    texture: DemTexture,
    x: number,
    y: number,
    width: number,
    height: number,
    data: Float32Array,
  ): void;
  remove(texture: DemTexture): void;
}

/** The part of a Worker the pool uses. */
export interface DemWorkerPort {
  post(request: DemWorkerRequest): void;
  onResponse(handler: (response: DemWorkerResponse) => void): void;
  terminate(): void;
}

export interface DemPoolOptions {
  /** A url template with `{z}`, `{x}` and `{y}`. */
  tileUrl: string;
  /** Null while there is no GL context, so no loads start until `useStore` provides one. */
  store: DemTextureStore | null;
  createWorker: () => DemWorkerPort;
  /** Called when a tile lands, so the layer can repaint. */
  onChange: () => void;
  now?: () => number;
}

/** Counts for dev-stats, read on demand. */
export interface DemPoolStats {
  textures: number;
  pinnedTextures: number;
  textureBytes: number;
  texturesPerZoom: Record<number, number>;
  inflight: number;
  queueDepth: number;
  awaitingUpload: number;
  strips: number;
  failures: number;
  requests: number;
  loaded: number;
  uploaded: number;
  cancelled: number;
  lastDecodeMs: number;
  meanDecodeMs: number;
}

/** The side length of a texture: the tile plus a halo on every side. */
export const TEXTURE_SIZE_PX = DEM_TILE_SIZE_PX + 2 * STRIP_WIDTH_PX;
/** The bytes of one R32F texture. */
export const TEXTURE_BYTES = TEXTURE_SIZE_PX ** 2 * Float32Array.BYTES_PER_ELEMENT;

const WORKER_COUNT = 2;
// Tiles arrive over HTTP/2, so this many requests share one connection.
export const MAX_FETCHES = 16;
// Coarse tiles fetch at most this many at once, so the view always keeps its slots.
const MAX_COARSE_FETCHES = 2;
// Uploads stop after this much main-thread time or this many tiles, whichever comes first.
const UPLOAD_BUDGET_MS = 4;
const MAX_UPLOADS_PER_FRAME = 8;
const UNPINNED_TEXTURE_LIMIT = 96;
const TEXTURE_BYTES_LIMIT = 150 * 1024 * 1024;

// A tile draws with a replicated edge once it has waited this long for its neighbours.
const DRAWABLE_CAP_MS = 300;

const STRIPS_MEMO_LIMIT = 1024;
const FAILURES_MEMO_LIMIT = 512;
const ERROR_RETRY_MS = 5 * 1000;
const NEVER_RETRY = Infinity;

/** One tile side with its neighbour offset and the halo and strip that fill it. */
interface Edge {
  dx: number;
  dy: number;
  halo: { x: number; y: number; width: number; height: number };
  neighbourStrip: StripSide;
}

const HALO_OFFSET_PX = DEM_TILE_SIZE_PX + STRIP_WIDTH_PX;

// EDGES keeps edges in this index order so each sits next to its opposite.
const NORTH = 0;
const SOUTH = 1;
const WEST = 2;
const EAST = 3;

// Each edge sits next to its opposite, so `index ^ 1` is the edge that faces back.
const EDGES: Edge[] = [
  {
    dx: 0,
    dy: -1,
    halo: { x: STRIP_WIDTH_PX, y: 0, width: DEM_TILE_SIZE_PX, height: STRIP_WIDTH_PX },
    neighbourStrip: "bottom",
  },
  {
    dx: 0,
    dy: 1,
    halo: { x: STRIP_WIDTH_PX, y: HALO_OFFSET_PX, width: DEM_TILE_SIZE_PX, height: STRIP_WIDTH_PX },
    neighbourStrip: "top",
  },
  {
    dx: -1,
    dy: 0,
    halo: { x: 0, y: STRIP_WIDTH_PX, width: STRIP_WIDTH_PX, height: DEM_TILE_SIZE_PX },
    neighbourStrip: "right",
  },
  {
    dx: 1,
    dy: 0,
    halo: { x: HALO_OFFSET_PX, y: STRIP_WIDTH_PX, width: STRIP_WIDTH_PX, height: DEM_TILE_SIZE_PX },
    neighbourStrip: "left",
  },
];

/** One tile corner with its diagonal neighbour offset and its 2x2 halo rect. */
interface Corner {
  dx: number;
  dy: number;
  halo: { x: number; y: number; width: number; height: number };
}

// Corners in facing pairs like EDGES, so `index ^ 1` is the corner that faces back.
const CORNERS: Corner[] = [
  { dx: -1, dy: -1, halo: { x: 0, y: 0, width: STRIP_WIDTH_PX, height: STRIP_WIDTH_PX } },
  {
    dx: 1,
    dy: 1,
    halo: { x: HALO_OFFSET_PX, y: HALO_OFFSET_PX, width: STRIP_WIDTH_PX, height: STRIP_WIDTH_PX },
  },
  {
    dx: 1,
    dy: -1,
    halo: { x: HALO_OFFSET_PX, y: 0, width: STRIP_WIDTH_PX, height: STRIP_WIDTH_PX },
  },
  {
    dx: -1,
    dy: 1,
    halo: { x: 0, y: HALO_OFFSET_PX, width: STRIP_WIDTH_PX, height: STRIP_WIDTH_PX },
  },
];

interface TextureEntry {
  z: number;
  x: number;
  y: number;
  texture: DemTexture;
  lastUsedFrame: number;
  pinned: boolean;
  uploadedAt: number;
  /** When the tile first had every neighbour it waits for, or null while it still waits. */
  drawableAt: number | null;
}

interface Job {
  tile: WantedTile;
  worker: number;
}

/** A neighbour's strip waiting to be written into a halo that was filled by replication. */
type HaloPatch =
  | { target: number; source: number; edge: number }
  | { target: number; source: number; corner: number };

/**
 * The textures of one tile url. Layers call `syncFrame` once per map frame and repaint again
 * while `needsRepaint` holds, so capped uploads and the drawable wait end.
 */
export class DemPool {
  private readonly tileUrl: string;
  private readonly onChange: () => void;
  private readonly now: () => number;
  private readonly workers: DemWorkerPort[];
  private readonly workerLoads: number[];
  private store: DemTextureStore | null;
  private frame = 0;
  private isMapFrameOpen = false;
  private wantedList: readonly WantedTile[] = [];
  private readonly wanted = new Map<number, WantedTile>();
  private readonly textures = new Map<number, TextureEntry>();
  // CPU heights live here from decode until upload and are dropped afterwards.
  private readonly pending = new Map<number, Float32Array>();
  private readonly strips = new Map<number, Float32Array>();
  // The retry time of each failed tile, which is never for a tile the server does not have.
  private readonly failures = new Map<number, number>();
  private readonly jobs = new Map<number, Job>();
  private readonly patches: HaloPatch[] = [];
  private readonly scratch = new Float32Array(TEXTURE_SIZE_PX ** 2);
  private requests = 0;
  private loaded = 0;
  private uploaded = 0;
  private cancelled = 0;
  private lastDecodeMs = 0;
  private totalDecodeMs = 0;

  constructor(options: DemPoolOptions) {
    this.tileUrl = options.tileUrl;
    this.store = options.store;
    this.onChange = options.onChange;
    this.now = options.now ?? (() => performance.now());

    this.workerLoads = new Array<number>(WORKER_COUNT).fill(0);
    this.workers = this.workerLoads.map(() => {
      const worker = options.createWorker();
      worker.onResponse((response) => this.handleResponse(response));

      return worker;
    });
  }

  /**
   * Update and upload for a map frame. Every layer that draws or prepares from this pool calls
   * it, but only the first call of a frame works, so the budget holds however many layers
   * there are.
   */
  syncFrame(wanted: readonly WantedTile[]): void {
    if (this.isMapFrameOpen) return;

    this.isMapFrameOpen = true;
    this.update(wanted);
    this.uploadPending();
  }

  /** Let the next `syncFrame` work; the map calls this when it finishes drawing a frame. */
  endMapFrame(): void {
    this.isMapFrameOpen = false;
  }

  /** Take this frame's wanted list: cancel what nobody wants and start the best missing loads. */
  update(wanted: readonly WantedTile[]): void {
    this.frame++;
    this.wantedList = wanted;
    this.wanted.clear();

    for (const tile of wanted) {
      const key = tileKey(tile);
      if (!this.wanted.has(key)) this.wanted.set(key, tile);
    }

    this.markTextures();
    this.cancelUnwanted();
    this.dropUnwantedHeights();
    this.fillFetchSlots();
    this.latchDrawable();
  }

  /** Upload decoded tiles and patch halos; call inside `render`, before binding for the draw. */
  uploadPending(): number {
    const store = this.store;
    if (!store) return 0;

    this.applyHaloPatches(store);

    const start = this.now();
    let uploads = this.uploadTier(store, start, true, 0);
    uploads = this.uploadTier(store, start, false, uploads);
    this.latchDrawable();

    return uploads;
  }

  private uploadTier(
    store: DemTextureStore,
    start: number,
    isFirstTier: boolean,
    uploads: number,
  ): number {
    for (const tile of this.wantedList) {
      if (uploads >= MAX_UPLOADS_PER_FRAME || this.pending.size === 0) break;
      if (uploads > 0 && this.now() - start >= UPLOAD_BUDGET_MS) break;

      const isFirst = tile.tier === "pinned" || tile.tier === "view";
      if (isFirst !== isFirstTier) continue;

      const key = tileKey(tile);
      const heights = this.pending.get(key);

      if (heights && this.uploadTile(store, tile, key, heights)) uploads++;
    }

    return uploads;
  }

  /**
   * Whether the layer should repaint again after this frame. Uploads stop at the per-frame
   * time and count budget while drawable waits on the 300 ms cap, so the pool asks for the
   * frames that finish them.
   */
  needsRepaint(): boolean {
    if (!this.store) return false;

    const now = this.now();

    for (const tile of this.wantedList) {
      const key = tileKey(tile);
      if (this.pending.has(key) && this.hasRoom()) return true;

      const entry = this.textures.get(key);
      if (entry?.drawableAt === null && now - entry.uploadedAt < DRAWABLE_CAP_MS) return true;
    }

    return false;
  }

  /** The texture of a tile, or null until it is uploaded. */
  texture(tile: Pick<WantedTile, "z" | "x" | "y">): DemTexture | null {
    return this.textures.get(tileKey(tile))?.texture ?? null;
  }

  /**
   * Whether a tile can draw without a visible seam: once every wanted neighbour that is not in
   * the ring or the look-ahead has landed or failed, it stays drawable while neighbours change
   * around it.
   */
  isDrawable(tile: Pick<WantedTile, "z" | "x" | "y">): boolean {
    return this.drawableForMs(tile) !== null;
  }

  /**
   * Whether every pinned and view tile of the last wanted list can draw. The ring and the
   * look-ahead stay out because they only look ahead, so their refills never hold a gesture open.
   */
  areViewTilesDrawable(): boolean {
    for (const tile of this.wantedList) {
      if (tile.tier !== "view" && tile.tier !== "pinned") continue;
      if (!this.isDrawable(tile)) return false;
    }

    return true;
  }

  /** Whether the pool holds a tile or already fetches it, so the warmer skips it. */
  has(tile: Pick<WantedTile, "z" | "x" | "y">): boolean {
    const key = tileKey(tile);
    return this.textures.has(key) || this.pending.has(key) || this.jobs.has(key);
  }

  /** How long a tile has been able to draw, or null while it cannot or has no texture. */
  drawableForMs(tile: Pick<WantedTile, "z" | "x" | "y">): number | null {
    const entry = this.textures.get(tileKey(tile));
    if (!entry) return null;

    const now = this.now();

    if (entry.drawableAt !== null) return now - entry.drawableAt;

    const cappedAt = entry.uploadedAt + DRAWABLE_CAP_MS;

    return now >= cappedAt ? now - cappedAt : null;
  }

  /** Forget every texture handle because the GL context is gone; strips and memos stay. */
  loseContext(): void {
    this.store = null;
    this.textures.clear();
    this.patches.length = 0;
  }

  /** Continue in a new GL context and reload the wanted tiles, pinned ones first. */
  useStore(store: DemTextureStore): void {
    this.loseContext();
    this.store = store;
    this.fillFetchSlots();
  }

  stats(): DemPoolStats {
    const texturesPerZoom: Record<number, number> = {};
    let pinnedTextures = 0;

    for (const entry of this.textures.values()) {
      texturesPerZoom[entry.z] = (texturesPerZoom[entry.z] ?? 0) + 1;
      if (entry.pinned) pinnedTextures++;
    }

    return {
      textures: this.textures.size,
      pinnedTextures,
      textureBytes: this.textures.size * TEXTURE_BYTES,
      texturesPerZoom,
      inflight: this.jobs.size,
      queueDepth: this.queueDepth(),
      awaitingUpload: this.pending.size,
      strips: this.strips.size,
      failures: this.failures.size,
      requests: this.requests,
      loaded: this.loaded,
      uploaded: this.uploaded,
      cancelled: this.cancelled,
      lastDecodeMs: this.lastDecodeMs,
      meanDecodeMs: this.loaded === 0 ? 0 : this.totalDecodeMs / this.loaded,
    };
  }

  /** Stop the workers and free every texture. */
  destroy(): void {
    for (const worker of this.workers) worker.terminate();

    for (const entry of this.textures.values()) this.store?.remove(entry.texture);

    this.textures.clear();
    this.jobs.clear();
    this.pending.clear();
    this.strips.clear();
    this.patches.length = 0;
  }

  private markTextures(): void {
    for (const [key, entry] of this.textures) {
      const tile = this.wanted.get(key);
      entry.pinned = tile?.tier === "pinned";
      if (tile) entry.lastUsedFrame = this.frame;
    }
  }

  private cancelUnwanted(): void {
    for (const [key, job] of this.jobs) {
      if (this.wanted.has(key)) continue;

      this.workers[job.worker].post({ type: "cancel", id: key });
      this.workerLoads[job.worker]--;
      this.jobs.delete(key);
      this.cancelled++;
    }
  }

  private dropUnwantedHeights(): void {
    for (const key of this.pending.keys()) {
      if (!this.wanted.has(key)) this.pending.delete(key);
    }
  }

  private fillFetchSlots(): void {
    if (!this.store) return;

    let coarseJobs = this.coarseJobCount();

    for (const tile of this.wantedList) {
      if (this.jobs.size >= MAX_FETCHES) return;
      // Coarse tiles wait while the view still needs work, so they never take its fetch slots.
      if (tile.tier === "coarse" && (this.hasHigherWork() || coarseJobs >= MAX_COARSE_FETCHES)) {
        return;
      }

      const key = tileKey(tile);
      if (this.needsLoad(key)) {
        this.startJob(tile, key);
        if (tile.tier === "coarse") coarseJobs++;
      }
    }
  }

  private hasHigherWork(): boolean {
    for (const tile of this.wantedList) {
      if (tile.tier === "coarse") continue;

      const key = tileKey(tile);
      if (this.jobs.has(key) || this.pending.has(key) || this.needsLoad(key)) return true;
    }

    return false;
  }

  private coarseJobCount(): number {
    let count = 0;

    for (const job of this.jobs.values()) {
      if (job.tile.tier === "coarse") count++;
    }

    return count;
  }

  private queueDepth(): number {
    const missing = new Set<number>();
    for (const tile of this.wantedList) {
      const key = tileKey(tile);
      if (!this.jobs.has(key) && this.needsLoad(key)) missing.add(key);
    }

    return missing.size;
  }

  private needsLoad(key: number): boolean {
    return (
      !this.textures.has(key)
      && !this.pending.has(key)
      && !this.jobs.has(key)
      && !this.hasFailed(key)
    );
  }

  private startJob(tile: WantedTile, key: number): void {
    const worker = this.workerLoads.indexOf(Math.min(...this.workerLoads));
    const url = this.tileUrl
      .replace("{z}", String(tile.z))
      .replace("{x}", String(tile.x))
      .replace("{y}", String(tile.y));

    this.workers[worker].post({ type: "load", id: key, url });
    this.workerLoads[worker]++;
    this.jobs.set(key, { tile, worker });
    this.requests++;
  }

  private handleResponse(response: DemWorkerResponse): void {
    const job = this.jobs.get(response.id);
    if (!job) return;

    this.jobs.delete(response.id);
    this.workerLoads[job.worker]--;

    if (response.kind === "tile") this.land(job.tile, response);
    else this.remember(this.failures, response.id, FAILURES_MEMO_LIMIT, this.retryTime(response));

    this.onChange();
    this.fillFetchSlots();
  }

  private retryTime(response: DemWorkerResponse): number {
    return response.kind === "missing" ? NEVER_RETRY : this.now() + ERROR_RETRY_MS;
  }

  private land(tile: WantedTile, response: Extract<DemWorkerResponse, { kind: "tile" }>): void {
    const key = tileKey(tile);
    const hadStrips = this.strips.has(key);
    this.remember(this.strips, key, STRIPS_MEMO_LIMIT, response.strips);
    this.pending.set(key, response.heights);

    this.loaded++;
    this.lastDecodeMs = response.decodeMs;
    this.totalDecodeMs += response.decodeMs;

    // A tile re-decoded after eviction already gave its edges to the neighbours that exist.
    if (!hadStrips) this.queueHaloPatches(tile, key);
  }

  /** Keeps a bounded memo in insertion order so the oldest entry leaves first. */
  private remember<T>(memo: Map<number, T>, key: number, limit: number, value: T): void {
    memo.delete(key);
    memo.set(key, value);
    if (memo.size > limit) memo.delete(memo.keys().next().value!);
  }

  private hasFailed(key: number): boolean {
    const retryAt = this.failures.get(key);
    if (retryAt === undefined) return false;
    if (retryAt > this.now()) return true;

    this.failures.delete(key);

    return false;
  }

  private queueHaloPatches(tile: WantedTile, key: number): void {
    EDGES.forEach((edge, index) => {
      const target = neighbourKey(tile, edge);
      if (this.textures.has(target)) this.patches.push({ target, source: key, edge: index ^ 1 });
    });

    CORNERS.forEach((corner, index) => {
      const target = neighbourKey(tile, corner);
      if (this.textures.has(target)) {
        this.patches.push({ target, source: key, corner: index ^ 1 });
      }
    });
  }

  private applyHaloPatches(store: DemTextureStore): void {
    for (const patch of this.patches) {
      const entry = this.textures.get(patch.target);
      const strips = this.strips.get(patch.source);
      if (!entry || !strips) continue;

      if ("corner" in patch) {
        const { halo } = CORNERS[patch.corner];
        const data = diagonalCorner(strips, CORNERS[patch.corner ^ 1]);
        store.patch(entry.texture, halo.x, halo.y, halo.width, halo.height, data);
      } else {
        const { halo, neighbourStrip } = EDGES[patch.edge];
        store.patch(
          entry.texture,
          halo.x,
          halo.y,
          halo.width,
          halo.height,
          stripOf(strips, neighbourStrip),
        );
      }
    }

    this.patches.length = 0;
  }

  private uploadTile(
    store: DemTextureStore,
    tile: WantedTile,
    key: number,
    heights: Float32Array,
  ): boolean {
    if (!this.makeRoom()) return false;

    const neighbourStrips = EDGES.map((edge) => {
      const strips = this.strips.get(neighbourKey(tile, edge));
      return strips ? stripOf(strips, edge.neighbourStrip) : null;
    });
    const cornerData = CORNERS.map((corner, index) => {
      const strips = this.strips.get(neighbourKey(tile, corner));
      return strips ? diagonalCorner(strips, CORNERS[index ^ 1]) : null;
    });
    fillPaddedTile(this.scratch, heights, neighbourStrips, cornerData);

    const uploadedAt = this.now();
    this.textures.set(key, {
      z: tile.z,
      x: tile.x,
      y: tile.y,
      texture: store.create(this.scratch),
      lastUsedFrame: this.frame,
      pinned: tile.tier === "pinned",
      uploadedAt,
      drawableAt: this.settledNow(tile, uploadedAt) ? uploadedAt : null,
    });
    this.pending.delete(key);
    this.uploaded++;

    return true;
  }

  /** Evict least recently used unpinned textures until one more fits; false when none can. */
  private makeRoom(): boolean {
    while (this.unpinnedCount() >= UNPINNED_TEXTURE_LIMIT || !this.fitsBytes()) {
      const victim = this.leastRecentlyUsed();
      if (victim === null) break;

      this.store?.remove(this.textures.get(victim)!.texture);
      this.textures.delete(victim);
    }

    return this.fitsBytes();
  }

  private fitsBytes(): boolean {
    return (this.textures.size + 1) * TEXTURE_BYTES <= TEXTURE_BYTES_LIMIT;
  }

  private unpinnedCount(): number {
    let count = 0;
    for (const entry of this.textures.values()) if (!entry.pinned) count++;

    return count;
  }

  // Textures wanted this frame stay, because the layer is about to draw them.
  private leastRecentlyUsed(): number | null {
    let oldest: number | null = null;
    let oldestFrame = this.frame;

    for (const [key, entry] of this.textures) {
      if (entry.pinned || entry.lastUsedFrame >= oldestFrame) continue;

      oldest = key;
      oldestFrame = entry.lastUsedFrame;
    }

    return oldest;
  }

  private isNeighbourSettled(key: number): boolean {
    const wanted = this.wanted.get(key);
    if (key < 0 || !wanted || wanted.tier === "ring" || wanted.tier === "lookahead") return true;

    return this.strips.has(key) || this.hasFailed(key);
  }

  private latchDrawable(): void {
    for (const entry of this.textures.values()) {
      if (entry.drawableAt === null && this.settledNow(entry, entry.uploadedAt)) {
        entry.drawableAt = this.now();
      }
    }
  }

  private settledNow(tile: Pick<WantedTile, "z" | "x" | "y">, uploadedAt: number): boolean {
    if (this.now() - uploadedAt >= DRAWABLE_CAP_MS) return true;

    return EDGES.every((edge) => this.isNeighbourSettled(neighbourKey(tile, edge)));
  }

  /** Whether one more texture fits after evicting the textures this frame may drop. */
  private hasRoom(): boolean {
    let evictable = 0;
    for (const entry of this.textures.values()) {
      if (!entry.pinned && entry.lastUsedFrame < this.frame) evictable++;
    }

    return (this.textures.size - evictable + 1) * TEXTURE_BYTES <= TEXTURE_BYTES_LIMIT;
  }
}

/** The pool a map shares for one tile url, with the layers that use it counted. */
interface PoolEntry {
  pool: DemPool;
  refs: number;
  gl: WebGL2RenderingContext | null;
  lost: boolean;
  dispose: () => void;
}

/** The part of a MapLibre map the registry uses. */
export interface DemPoolMap {
  getCanvas(): EventTarget;
  triggerRepaint(): void;
  on(type: "render", listener: () => void): unknown;
  off(type: "render", listener: () => void): unknown;
}

export interface AcquireDemPoolOptions {
  map: DemPoolMap;
  gl: WebGL2RenderingContext;
  tileUrl: string;
  createStore?: (gl: WebGL2RenderingContext) => DemTextureStore;
  createWorker?: () => DemWorkerPort;
  now?: () => number;
}

// Layers removed by a context loss come back within moments, so the pool waits this long for them.
const LOST_CONTEXT_GRACE_MS = 30 * 1000;

const pools = new WeakMap<DemPoolMap, Map<string, PoolEntry>>();

// One pool per tile url, so the warmer and the trial read it without the map.
const poolsByUrl = new Map<string, DemPool>();

/** Whether the url's pool holds a tile or already fetches it, so the warmer skips it. */
export function demPoolHas(tileUrl: string, tile: Pick<WantedTile, "z" | "x" | "y">): boolean {
  return poolsByUrl.get(tileUrl)?.has(tile) ?? false;
}

/** The stats of the url's pool, or the summed stats when no url is given. */
export function demPoolStats(tileUrl?: string): DemPoolStats | null {
  if (tileUrl) return poolsByUrl.get(tileUrl)?.stats() ?? null;

  const live = [...poolsByUrl.values()];
  if (live.length === 0) return null;
  if (live.length === 1) return live[0].stats();

  return sumPoolStats(live.map((pool) => pool.stats()));
}

/** Whether the pools hold every pinned and view tile they want, null without a pool. */
export function demPoolViewReady(tileUrl?: string): boolean | null {
  if (tileUrl) return poolsByUrl.get(tileUrl)?.areViewTilesDrawable() ?? null;

  const live = [...poolsByUrl.values()];
  if (live.length === 0) return null;

  return live.every((pool) => pool.areViewTilesDrawable());
}

/** Get the map's pool for a tile url, creating it on first use; pair with `releaseDemPool`. */
export function acquireDemPool(options: AcquireDemPoolOptions): DemPool {
  const { map, gl, tileUrl } = options;
  const createStore = options.createStore ?? createGlTextureStore;
  let entry = pools.get(map)?.get(tileUrl);

  if (!entry) entry = createEntry(options, createStore);

  entry.refs++;

  if (entry.gl !== gl) {
    entry.gl = gl;
    entry.pool.useStore(createStore(gl));
  }

  return entry.pool;
}

/** End one layer's use of a pool; the last release stops its workers. */
export function releaseDemPool(map: DemPoolMap, tileUrl: string): void {
  const entry = pools.get(map)?.get(tileUrl);
  if (!entry || --entry.refs > 0) return;

  // A release that runs before the lost event still sees a lost context here.
  const glLost = entry.gl?.isContextLost?.() ?? false;

  if (entry.lost || glLost) {
    setTimeout(() => destroyIfUnused(map, tileUrl, entry), LOST_CONTEXT_GRACE_MS);
  } else destroyEntry(map, tileUrl, entry);
}

function createEntry(
  options: AcquireDemPoolOptions,
  createStore: (gl: WebGL2RenderingContext) => DemTextureStore,
): PoolEntry {
  const { map, gl, tileUrl } = options;
  const canvas = map.getCanvas();
  const pool = new DemPool({
    tileUrl,
    store: createStore(gl),
    createWorker: options.createWorker ?? createDemWorker,
    now: options.now,
    onChange: () => map.triggerRepaint(),
  });

  const onLost = () => {
    entry.lost = true;
    entry.gl = null;
    pool.loseContext();
  };
  const onRestored = () => {
    entry.lost = false;
  };
  const onRender = () => pool.endMapFrame();

  const entry: PoolEntry = {
    pool,
    refs: 0,
    gl,
    lost: false,
    dispose: () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      map.off("render", onRender);
    },
  };

  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  map.on("render", onRender);

  const mapPools = pools.get(map) ?? new Map<string, PoolEntry>();
  mapPools.set(tileUrl, entry);
  pools.set(map, mapPools);
  poolsByUrl.set(tileUrl, pool);

  return entry;
}

function destroyIfUnused(map: DemPoolMap, tileUrl: string, entry: PoolEntry): void {
  if (entry.refs > 0 || pools.get(map)?.get(tileUrl) !== entry) return;

  destroyEntry(map, tileUrl, entry);
}

function destroyEntry(map: DemPoolMap, tileUrl: string, entry: PoolEntry): void {
  entry.dispose();
  entry.pool.destroy();
  pools.get(map)?.delete(tileUrl);

  if (poolsByUrl.get(tileUrl) === entry.pool) poolsByUrl.delete(tileUrl);
}

function sumPoolStats(all: DemPoolStats[]): DemPoolStats {
  const texturesPerZoom: Record<number, number> = {};
  let loaded = 0;
  let totalDecodeMs = 0;

  for (const stats of all) {
    for (const [zoom, count] of Object.entries(stats.texturesPerZoom)) {
      texturesPerZoom[Number(zoom)] = (texturesPerZoom[Number(zoom)] ?? 0) + count;
    }

    loaded += stats.loaded;
    totalDecodeMs += stats.meanDecodeMs * stats.loaded;
  }

  const summed = (pick: (stats: DemPoolStats) => number): number => {
    return all.reduce((total, stats) => total + pick(stats), 0);
  };

  return {
    textures: summed((stats) => stats.textures),
    pinnedTextures: summed((stats) => stats.pinnedTextures),
    textureBytes: summed((stats) => stats.textureBytes),
    texturesPerZoom,
    inflight: summed((stats) => stats.inflight),
    queueDepth: summed((stats) => stats.queueDepth),
    awaitingUpload: summed((stats) => stats.awaitingUpload),
    strips: summed((stats) => stats.strips),
    failures: summed((stats) => stats.failures),
    requests: summed((stats) => stats.requests),
    loaded,
    uploaded: summed((stats) => stats.uploaded),
    cancelled: summed((stats) => stats.cancelled),
    lastDecodeMs: Math.max(...all.map((stats) => stats.lastDecodeMs)),
    meanDecodeMs: loaded === 0 ? 0 : totalDecodeMs / loaded,
  };
}

try {
  // The trial reads the pool through the page, so it stays a window hook, not an import.
  (globalThis as unknown as { __getDemPoolStats?: typeof demPoolStats }).__getDemPoolStats = (
    tileUrl?: string,
  ) => demPoolStats(tileUrl);
  (
    globalThis as unknown as { __getDemPoolViewReady?: typeof demPoolViewReady }
  ).__getDemPoolViewReady = (tileUrl?: string) => demPoolViewReady(tileUrl);
} catch {
  // A missing window must not break the pool it would report on.
}

/** Start a dem-worker; the bundler picks the file up from this `new URL`. */
export function createDemWorker(): DemWorkerPort {
  const worker = new Worker(new URL("../workers/dem-worker.ts", import.meta.url), {
    type: "module",
  });

  return {
    post: (request) => worker.postMessage(request),
    onResponse: (handler) => {
      worker.onmessage = (event: MessageEvent<DemWorkerResponse>) => handler(event.data);
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Textures in a WebGL2 context. Linear filtering of R32F needs the float-linear
 * extension, so the store falls back to nearest where the context lacks it.
 */
export function createGlTextureStore(gl: WebGL2RenderingContext): DemTextureStore {
  const linear = gl.getExtension("OES_texture_float_linear") !== null;
  const filter = linear ? gl.LINEAR : gl.NEAREST;

  return {
    linear,
    create(data) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Cannot allocate a DEM texture");

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      withPlainUnpack(gl, () => {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.R32F,
          TEXTURE_SIZE_PX,
          TEXTURE_SIZE_PX,
          0,
          gl.RED,
          gl.FLOAT,
          data,
        );
      });

      return texture;
    },
    patch(texture, x, y, width, height, data) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      withPlainUnpack(gl, () => {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RED, gl.FLOAT, data);
      });
    },
    remove: (texture) => gl.deleteTexture(texture),
  };
}

// MapLibre leaves its own image unpack settings behind, which must not touch height data.
function withPlainUnpack(gl: WebGL2RenderingContext, upload: () => void): void {
  const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
  const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
  const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

  upload();

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
}

/**
 * A number that is unique per tile: tiles of lower zooms come first, then rows, then columns.
 * Used in place of a string so that a frame's lookups allocate nothing.
 */
function tileKey(tile: Pick<WantedTile, "z" | "x" | "y">): number {
  const size = 2 ** tile.z;
  return (size * size - 1) / 3 + tile.y * size + tile.x;
}

/** The key of the same-zoom neighbour across an edge; x wraps and rows past the poles give -1. */
function neighbourKey(
  tile: Pick<WantedTile, "z" | "x" | "y">,
  offset: { dx: number; dy: number },
): number {
  const size = 2 ** tile.z;
  const y = tile.y + offset.dy;
  if (y < 0 || y >= size) return -1;

  return tileKey({ z: tile.z, x: (tile.x + offset.dx + size) % size, y });
}

/**
 * Lay a tile into the padded texture. A halo side comes from the neighbour's strip when it has
 * landed and repeats the tile's own edge pixel otherwise, and corners come from the diagonal
 * neighbour or repeat the corner when it has not landed.
 */
function fillPaddedTile(
  padded: Float32Array,
  heights: Float32Array,
  neighbourStrips: (Float32Array | null)[],
  cornerData: (Float32Array | null)[],
): void {
  const size = DEM_TILE_SIZE_PX;
  const stride = TEXTURE_SIZE_PX;
  const last = size - 1;

  for (let row = 0; row < size; row++) {
    const start = (row + STRIP_WIDTH_PX) * stride;
    padded.set(heights.subarray(row * size, (row + 1) * size), start + STRIP_WIDTH_PX);

    for (let column = 0; column < STRIP_WIDTH_PX; column++) {
      const west = neighbourStrips[WEST]?.[row * STRIP_WIDTH_PX + column] ?? heights[row * size];
      const east =
        neighbourStrips[EAST]?.[row * STRIP_WIDTH_PX + column] ?? heights[row * size + last];
      padded[start + column] = west;
      padded[start + HALO_OFFSET_PX + column] = east;
    }
  }

  for (let line = 0; line < STRIP_WIDTH_PX; line++) {
    const north =
      neighbourStrips[NORTH]?.subarray(line * size, (line + 1) * size) ?? heights.subarray(0, size);
    const south =
      neighbourStrips[SOUTH]?.subarray(line * size, (line + 1) * size)
      ?? heights.subarray(last * size);
    padded.set(north, line * stride + STRIP_WIDTH_PX);
    padded.set(south, (HALO_OFFSET_PX + line) * stride + STRIP_WIDTH_PX);
  }

  fillCorners(padded, heights, cornerData);
}

function fillCorners(
  padded: Float32Array,
  heights: Float32Array,
  cornerData: (Float32Array | null)[],
): void {
  const size = DEM_TILE_SIZE_PX;
  const stride = TEXTURE_SIZE_PX;
  const corners = [
    heights[0],
    heights[size - 1],
    heights[size * (size - 1)],
    heights[size * size - 1],
  ];
  // Each corner falls back to the tile's own corner pixel in CORNERS order.
  const fallbacks = [corners[0], corners[3], corners[1], corners[2]];
  CORNERS.forEach((corner, index) => {
    const data = cornerData[index];

    for (let line = 0; line < STRIP_WIDTH_PX; line++) {
      for (let column = 0; column < STRIP_WIDTH_PX; column++) {
        padded[(corner.halo.y + line) * stride + corner.halo.x + column] = data
          ? data[line * STRIP_WIDTH_PX + column]
          : fallbacks[index];
      }
    }
  });
}

/** The 2x2 pixels of a tile's corner, read from the top or bottom strip that holds them. */
function diagonalCorner(strips: Float32Array, corner: Corner): Float32Array {
  const side = stripOf(strips, corner.dy < 0 ? "top" : "bottom");
  const first = corner.dx < 0 ? 0 : DEM_TILE_SIZE_PX - STRIP_WIDTH_PX;

  return Float32Array.of(
    side[first],
    side[first + 1],
    side[DEM_TILE_SIZE_PX + first],
    side[DEM_TILE_SIZE_PX + first + 1],
  );
}
