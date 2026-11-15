/**
 * Share decoded DEM tiles as R32F textures between relief and contours. Workers fetch and
 * decode each tile. The pool keeps its edges so neighbours can fill each other's halo.
 * Layers upload the ready data inside `render`.
 */
import { stripOf } from "./decode";
import {
  CORNERS,
  EDGES,
  TEXTURE_BYTES,
  TEXTURE_SIZE_PX,
  diagonalCorner,
  fillPaddedTile,
  neighbourKey,
  tileKey,
} from "./halo";
import type { WantedTile } from "./plan";
import type { DemWorkerRequest, DemWorkerResponse } from "./worker";

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
