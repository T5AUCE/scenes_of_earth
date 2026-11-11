/** Bounded scene-entry download scheduler that fills an in-memory tile store. */
import { addProtocol } from "maplibre-gl";
import type { Map as MapLibreMap, RequestParameters } from "maplibre-gl";

import type { WarmTile } from "../contour-ladder";
import {
  beginPreload,
  notePreloadHit,
  notePreloadMiss,
  setPreloadProgress,
  type TileLayerKey,
} from "../dev-stats";

/** Bytes the store and the running downloads may hold together before new work is dropped. */
export const PRELOAD_BUDGET_BYTES = 24 * 1024 * 1024;
/** Bounded memo size for missing and already counted tiles. */
export const MAX_MEMO_TILES = 2000;

/** How long optional entry preload may run before unfinished work is dropped. */
export const PRELOAD_ENTRY_BUDGET_MS = 5 * 1000;

const STORE_PROTOCOL = "soetile";

/** One unit of preload work, such as a tile download or a contour trace. */
export interface PreloadTask {
  /** Dedupes the task. A download uses its tile URL, which is also its store key. */
  key: string;
  /** Bytes reserved against the budget while the task runs. */
  estimatedBytes: number;
  /** Do the work and resolve with the downloaded body, or nothing when it lives elsewhere. */
  run(abort: AbortController): Promise<Blob | undefined>;
  /** Store keys that must already be prepared before this task may launch. */
  needs?: string[];
}

/** A pluggable kind of preload, such as the DEM pyramid, the basemap or the contour traces. */
export interface PreloadSource {
  id: string;
  /** The dev readout layer that credits this source's hit rate. */
  layer: TileLayerKey;
  /** Tasks running at once, which keeps preload from crowding visible requests. */
  lanes: number;
  /** Another source whose tasks must finish before this one starts. */
  after?: string;
  /** The tasks for a scene fitted at this zoom, in priority order and inside the budget. */
  tasks(fittedZoom: number): PreloadTask[];
  /** The task key a visible tile load would use, or null for another source's load. */
  visibleKey(sourceId: string, tile: WarmTile): string | null;
  /**
   * The style-owned identity this source resolves, or null while unresolved. A change aborts
   * the source's generation and frees its store, while a source without one never resets.
   */
  revisionKey?(): string | null;
  /** A shared visible download for this key through the source's own cache when possible. */
  loadShared?(key: string): (() => Promise<Blob | undefined>) | undefined;
}

/** The map surface the scheduler listens to and rewrites tile requests on. */
export type PreloadMap = Pick<MapLibreMap, "on" | "off" | "setTransformRequest">;

/**
 * Count preload outcomes for the dev readout. A hit is the first visible load of a tile that
 * preload had finished or still had in flight. A miss is a first visible load nothing prepared.
 * Only loads after the camera lands count, because the flight in passes through zooms that
 * preload never plans.
 */
export interface PreloadTelemetry {
  begin(): void;
  progress(done: number, total: number, bytes: number): void;
  hit(layer: TileLayerKey): void;
  miss(layer: TileLayerKey): void;
}

interface SourceState {
  source: PreloadSource;
  queue: PreloadTask[];
  total: number;
  done: number;
}

interface Job {
  key: string;
  state: SourceState;
  abort: AbortController;
  download: Promise<Blob | undefined>;
  reservedBytes: number;
  cancelled: boolean;
  settled: boolean;
}

/** A key set that forgets its oldest key at the cap, so memos never grow forever. */
export class BoundedKeySet {
  private readonly keys = new Set<string>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get size(): number {
    return this.keys.size;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    this.keys.delete(key);
    this.keys.add(key);
    if (this.keys.size <= this.limit) return;
    const oldest = this.keys.values().next();
    if (!oldest.done) this.keys.delete(oldest.value);
  }

  clear(): void {
    this.keys.clear();
  }
}

/**
 * Downloaded tile bodies keyed by URL rather than scene, so any scene or a later shared
 * mirror reads the same entries. A visible read of a tile that is still downloading waits
 * for that download instead of starting a second one. Retained bodies and outstanding
 * reservations share one budget, so a completion that would overflow the combined total
 * is discarded while the network fallback stays available.
 */
export class TileStore {
  private readonly blobs = new Map<string, Blob>();
  private readonly loading = new Map<string, Promise<Blob | undefined>>();
  private readonly flights = new Map<string, Promise<Blob | undefined>>();
  private readonly absent = new Map<string, Error>();
  private readonly limitBytes: number;
  private heldBytes = 0;
  private reservedBytes = 0;

  constructor(limitBytes: number = Number.POSITIVE_INFINITY) {
    this.limitBytes = limitBytes;
  }

  get bytes(): number {
    return this.heldBytes;
  }

  get reserved(): number {
    return this.reservedBytes;
  }

  /** Track a scheduler reservation while its download runs. */
  reserve(bytes: number): void {
    this.reservedBytes += bytes;
  }

  /** Release a scheduler reservation once its download settles. */
  release(bytes: number): void {
    this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
  }

  has(key: string): boolean {
    return this.blobs.has(key) || this.loading.has(key);
  }

  /** The stored 404 for a key that failed, so joined readers never fetch it again. */
  absentError(key: string): Error | undefined {
    return this.absent.get(key);
  }

  /** The finished body, or a promise of it that still rejects for joined readers on failure. */
  read(key: string): Blob | Promise<Blob | undefined> | undefined {
    return this.blobs.get(key) ?? this.loading.get(key);
  }

  /**
   * Join an in-flight fetch for this key or start it. Visible and preload readers share the
   * one download whichever of them arrives first, and the entry leaves once it settles.
   */
  share(key: string, load: () => Promise<Blob | undefined>): Promise<Blob | undefined> {
    const flying = this.flights.get(key);
    if (flying) return flying;
    const flight = load().then(
      (blob) => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
        return blob;
      },
      (error: unknown) => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
        throw error;
      },
    );
    this.flights.set(key, flight);
    return flight;
  }

  /**
   * Keep the body of a download once it finishes. Only a live owner retains its body, so a
   * completion that arrives after its cancellation or replacement never stores a stale blob,
   * while a newer entry for the same key always wins over the older registration.
   */
  hold(
    key: string,
    download: Promise<Blob | undefined>,
    isLive: () => boolean = alwaysLive,
    reservationBytes = 0,
  ): Promise<Blob | undefined> {
    this.loading.set(key, download);
    download.catch(aboutUnobservedFailure);
    return download.then(
      (blob) => {
        const isCurrent = this.loading.get(key) === download;
        if (isCurrent) this.loading.delete(key);
        if (isCurrent && isLive()) this.keep(key, blob, reservationBytes);
        return blob;
      },
      (error: unknown) => {
        const isCurrent = this.loading.get(key) === download;
        if (isCurrent) this.loading.delete(key);
        if (isCurrent && isLive()) this.rememberAbsent(key, error);
        throw error;
      },
    );
  }

  /** Drop a body and its flights, so a removed generation never shares its download. */
  delete(key: string): void {
    this.loading.delete(key);
    this.flights.delete(key);
    const blob = this.blobs.get(key);
    if (!blob) return;
    this.blobs.delete(key);
    this.heldBytes -= blob.size;
  }

  /** Forget an aborted flight without touching a newer entry, so a replacement starts its own. */
  dropFlight(key: string, flight: Promise<Blob | undefined>): void {
    if (this.flights.get(key) === flight) this.flights.delete(key);
  }

  /** Forget a pending download after its abort, without touching a newer entry for the key. */
  dropPending(key: string, download: Promise<Blob | undefined>): void {
    if (this.loading.get(key) === download) this.loading.delete(key);
  }

  clear(): void {
    this.blobs.clear();
    this.loading.clear();
    this.flights.clear();
    this.absent.clear();
    this.heldBytes = 0;
    this.reservedBytes = 0;
  }

  private keep(key: string, blob: Blob | undefined, reservationBytes = 0): void {
    if (!blob) return;
    const others = this.reservedBytes - reservationBytes;
    if (this.heldBytes + others + blob.size > this.limitBytes) return;
    this.blobs.set(key, blob);
    this.heldBytes += blob.size;
  }

  private rememberAbsent(key: string, error: unknown): void {
    if (!isMissingResponse(error)) return;
    this.absent.delete(key);
    this.absent.set(key, error as Error);
    if (this.absent.size <= MAX_MEMO_TILES) return;
    const oldest = this.absent.keys().next();
    if (!oldest.done) this.absent.delete(oldest.value);
  }
}

function alwaysLive(): boolean {
  return true;
}

/** An unobserved download failure stays silent here because joined readers still see it. */
function aboutUnobservedFailure(): void {}

/**
 * Download a scene's tiles in the background once it is visible. Every source lists its own
 * tasks inside its own fixed budget, and this scheduler runs them on a few low-priority lanes
 * under one global byte budget. Visible requests never wait on it: MapLibre reads a stored
 * tile through the store protocol, joins a download already running, and fetches anything
 * else itself. A replaced or removed source, and the scene exit, abort their work, and a
 * stale completion can never record a result for a newer plan.
 */
export class ScenePreload {
  private readonly map: PreloadMap;
  private readonly telemetry: PreloadTelemetry;
  private readonly budgetBytes: number;
  private readonly store: TileStore;
  private readonly sources = new Map<string, SourceState>();
  private readonly planned = new Set<string>();
  private readonly ownership = new Map<string, Set<string>>();
  private readonly revisions = new Map<string, string | null>();
  private readonly occupied = new Map<string, number>();
  // A cancelled job leaves this map but keeps its lanes and reservation until it settles.
  private readonly active = new Map<string, Job>();
  private readonly ready = new Set<string>();
  private readonly missing = new BoundedKeySet(MAX_MEMO_TILES);
  private readonly counted = new BoundedKeySet(MAX_MEMO_TILES);
  private readonly keyEpochs = new Map<string, number>();
  private readonly wakeListeners = new Set<() => void>();
  private epochCounter = 0;
  private visibleDemands = 0;
  private readonly stopListening: () => void;
  private stopWaitingForLanding: () => void = () => {};
  private reservedBytes = 0;
  private fittedZoom: number | null = null;
  private isLanded = false;
  private isRewriting = false;
  private destroyed = false;

  constructor(
    map: PreloadMap,
    telemetry: PreloadTelemetry = defaultTelemetry(),
    budgetBytes: number = PRELOAD_BUDGET_BYTES,
  ) {
    this.map = map;
    this.telemetry = telemetry;
    this.budgetBytes = budgetBytes;
    this.store = new TileStore(budgetBytes);
    ensureStoreProtocol();
    activeStore = this.store;
    activePreload = this;
    telemetry.begin();
    const visibleLoading = (event: object) => this.countVisibleLoad(event);
    const restyle = () => this.resyncPlans();
    map.on("sourcedataloading", visibleLoading);
    map.on("sourcedata", restyle);
    map.on("styledata", restyle);
    this.stopListening = () => {
      map.off("sourcedataloading", visibleLoading);
      map.off("sourcedata", restyle);
      map.off("styledata", restyle);
    };
  }

  /** Register a source, replacing and aborting an earlier one with the same id. */
  add(source: PreloadSource): void {
    if (this.destroyed) return;
    this.remove(source.id);
    const state: SourceState = { source, queue: [], total: 0, done: 0 };
    this.sources.set(source.id, state);
    if (this.fittedZoom === null) return;
    this.plan(state);
    this.pump();
  }

  /** Forget a source, abort what it still runs and free the bodies only it listed. */
  remove(id: string): void {
    const state = this.sources.get(id);
    if (!state) return;
    this.sources.delete(id);
    for (const job of [...this.active.values()]) {
      if (job.state === state) this.cancelJob(job);
    }
    this.forgetOwned(id);
    this.report();
    this.pump();
  }

  /** Begin downloading for a scene that the camera fits at this zoom. */
  start(fittedZoom: number): void {
    if (this.destroyed || this.fittedZoom !== null) return;
    this.fittedZoom = fittedZoom;
    this.waitForLanding();
    for (const state of this.sources.values()) this.plan(state);
    this.pump();
  }

  /** Abort everything, free the store and hand tile requests back to MapLibre. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const job of [...this.active.values()]) this.cancelJob(job);
    this.sources.clear();
    this.planned.clear();
    this.ownership.clear();
    this.revisions.clear();
    this.occupied.clear();
    this.ready.clear();
    this.missing.clear();
    this.counted.clear();
    this.keyEpochs.clear();
    this.visibleDemands = 0;
    this.store.clear();
    if (activeStore === this.store) activeStore = null;
    if (activePreload === this) activePreload = null;
    if (this.isRewriting) this.map.setTransformRequest(null);
    this.stopListening();
    this.stopWaitingForLanding();
    this.wake();
  }

  /** Tasks finished and planned across all sources, with the bytes the store holds. */
  progress(): { done: number; total: number; bytes: number } {
    let done = 0;
    let total = 0;
    for (const state of this.sources.values()) {
      done += state.done;
      total += state.total;
    }
    return { done, total, bytes: this.store.bytes };
  }

  /** Whether every planned task has settled, so failures and drops never block entry. */
  isSettled(): boolean {
    const { done, total } = this.progress();
    return done >= total;
  }

  /**
   * Wait until every planned task settles. Dropped budgets and failed downloads count as
   * settled because they still record a result, so only an abort keeps this waiting.
   */
  async settled(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (this.destroyed) throw new DOMException("Aborted", "AbortError");
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (this.isSettled()) return;
      await this.waitForWake(signal);
    }
  }

  /** Drop queued work and abort running work after the entry budget expires. */
  expireEntryBudget(): void {
    if (this.destroyed) return;
    for (const state of this.sources.values()) {
      if (state.queue.length > 0) {
        state.total -= state.queue.length;
        state.queue = [];
      }
    }
    for (const job of [...this.active.values()]) this.expireJob(job);
    this.report();
  }

  /** Wait for the next progress report or expiry instead of polling on a timer. */
  private waitForWake(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        this.wakeListeners.delete(onWake);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const onWake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.wakeListeners.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // The flight keeps the map rendering, so the first idle after it starts is the landing.
  private waitForLanding(): void {
    const landed = () => {
      this.isLanded = true;
      this.map.off("idle", landed);
    };
    this.map.on("idle", landed);
    this.stopWaitingForLanding = () => this.map.off("idle", landed);
  }

  private plan(state: SourceState): void {
    const tasks = state.source.tasks(this.fittedZoom!);
    if (state.source.revisionKey) this.revisions.set(state.source.id, state.source.revisionKey());
    const owned = new Set<string>();
    for (const task of tasks) {
      if (!this.planned.has(task.key)) this.keyEpochs.set(task.key, (this.epochCounter += 1));
      owned.add(task.key);
      this.planned.add(task.key);
    }
    this.ownership.set(state.source.id, owned);
    state.queue = tasks.filter((task) => !this.isPrepared(task.key));
    state.total = tasks.length;
    state.done = tasks.length - state.queue.length;
    this.rewriteStoredRequests();
    this.report();
  }

  /** Start queued tasks while lanes and budget allow, source by source in registration order. */
  private pump(): void {
    if (this.destroyed || this.fittedZoom === null) return;
    for (const state of this.sources.values()) this.fill(state);
  }

  private fill(state: SourceState): void {
    if (this.visibleDemands > 0) {
      this.report();
      return;
    }
    if (this.isWaiting(state)) return;
    while (this.freeLanes(state.source) > 0 && state.queue.length > 0) {
      const task = state.queue[0];
      if (this.isPrepared(task.key)) {
        state.queue.shift();
        state.done += 1;
        continue;
      }
      if (task.needs !== undefined && !task.needs.every((need) => this.isPrepared(need))) {
        state.queue.shift();
        state.total -= 1;
        continue;
      }
      if (!this.admit(task.estimatedBytes)) {
        // The budget is spent, so the rest of this source's plan is dropped.
        state.total -= state.queue.length;
        state.queue = [];
        break;
      }
      state.queue.shift();
      this.launch(state, task);
    }
    this.report();
  }

  private freeLanes(source: PreloadSource): number {
    return source.lanes - (this.occupied.get(source.id) ?? 0);
  }

  private occupy(id: string, delta: number): void {
    this.occupied.set(id, Math.max(0, (this.occupied.get(id) ?? 0) + delta));
  }

  private isWaiting(state: SourceState): boolean {
    const gate = this.sources.get(state.source.after ?? "");
    return gate !== undefined
      && (gate.queue.length > 0 || (this.occupied.get(gate.source.id) ?? 0) > 0);
  }

  private admit(bytes: number): boolean {
    return this.store.bytes + this.reservedBytes + bytes <= this.budgetBytes;
  }

  private launch(state: SourceState, task: PreloadTask): void {
    const abort = new AbortController();
    const flight = this.store.share(task.key, () => runPreloadTask(task, abort));
    const job: Job = {
      key: task.key,
      state,
      abort,
      download: flight,
      reservedBytes: task.estimatedBytes,
      cancelled: false,
      settled: false,
    };
    this.reservedBytes += job.reservedBytes;
    this.store.reserve(job.reservedBytes);
    this.occupy(state.source.id, 1);
    this.active.set(job.key, job);
    // The hold rejection is observed here because settlement already listens on the flight.
    this.store.hold(job.key, flight, () => this.isJobLive(job), job.reservedBytes).then(
      () => undefined,
      () => undefined,
    );
    flight.then(
      () => this.settle(job, null),
      (error: unknown) => this.settle(job, { error }),
    );
  }

  /**
   * Settle one job exactly once, whatever its state. Only a current, uncancelled job may
   * record a result, so a stale completion can never mark a replacement plan's tile.
   */
  private settle(job: Job, failure: { error: unknown } | null): void {
    if (job.settled) return;
    job.settled = true;
    this.reservedBytes -= job.reservedBytes;
    this.store.release(job.reservedBytes);
    this.occupy(job.state.source.id, -1);
    if (this.active.get(job.key) === job) this.active.delete(job.key);
    if (this.destroyed) return;
    if (!job.cancelled && this.sources.get(job.state.source.id) === job.state) {
      job.state.done += 1;
      this.record(job.key, failure);
    }
    this.report();
    this.pump();
  }

  private record(key: string, failure: { error: unknown } | null): void {
    if (failure === null) this.ready.add(key);
    else if (isMissingResponse(failure.error)) this.missing.add(key);
  }

  private cancelJob(job: Job): void {
    if (job.cancelled) return;
    job.cancelled = true;
    if (this.active.get(job.key) === job) this.active.delete(job.key);
    this.store.dropFlight(job.key, job.download);
    this.store.dropPending(job.key, job.download);
    job.abort.abort();
  }

  /** Abort one running job and count it as settled so the entry budget ends promptly. */
  private expireJob(job: Job): void {
    if (job.settled) return;
    job.settled = true;
    job.cancelled = true;
    if (this.active.get(job.key) === job) this.active.delete(job.key);
    this.reservedBytes -= job.reservedBytes;
    this.store.release(job.reservedBytes);
    this.occupy(job.state.source.id, -1);
    this.store.dropFlight(job.key, job.download);
    this.store.dropPending(job.key, job.download);
    job.abort.abort();
    if (this.sources.get(job.state.source.id) === job.state) job.state.done += 1;
  }

  /** Whether a job still owns its key, so late completions cannot retain stale bodies. */
  private isJobLive(job: Job): boolean {
    return !job.cancelled
      && !this.destroyed
      && this.active.get(job.key) === job
      && this.sources.get(job.state.source.id) === job.state;
  }

  /** Move a visibly demanded task to the front of its queue, ahead of background order. */
  prioritizeVisible(key: string): void {
    if (this.destroyed || this.fittedZoom === null) return;
    for (const state of this.sources.values()) {
      const index = state.queue.findIndex((task) => task.key === key);
      if (index > 0) {
        const [task] = state.queue.splice(index, 1);
        state.queue.unshift(task);
        this.pump();
      }
    }
  }

  /** Whether this URL still belongs to a planned generation, so visible holds stay owned. */
  hasPlanned(key: string): boolean {
    return this.planned.has(key);
  }

  /** The current generation of a planned key, or null while unplanned. */
  epochFor(key: string): number | null {
    if (!this.planned.has(key)) return null;
    return this.keyEpochs.get(key) ?? null;
  }

  /** Whether a captured generation still owns its key, so stale holds never retain. */
  isLiveEpoch(key: string, epoch: number): boolean {
    return this.planned.has(key) && this.keyEpochs.get(key) === epoch;
  }

  /** Pause background launches while a visible download needs the network. */
  beginVisibleDemand(): void {
    this.visibleDemands += 1;
  }

  /** Resume background launches after a visible download settles. */
  endVisibleDemand(): void {
    this.visibleDemands = Math.max(0, this.visibleDemands - 1);
    this.pump();
  }

  /** A manager-backed loader for this key when a participating source shares one. */
  findSharedLoader(key: string): (() => Promise<Blob | undefined>) | undefined {
    for (const { source } of this.sources.values()) {
      const loader = source.loadShared?.(key);
      if (loader !== undefined) return loader;
    }
    return undefined;
  }

  /** Replan sources whose style-owned identity changed, waking ones that resolved late. */
  private resyncPlans(): void {
    if (this.destroyed) return;
    for (const state of [...this.sources.values()]) {
      const fingerprint = state.source.revisionKey?.();
      if (fingerprint === undefined) continue;
      if (this.revisions.get(state.source.id) === fingerprint) continue;
      if (this.fittedZoom === null) {
        this.revisions.set(state.source.id, fingerprint);
        continue;
      }
      this.resetSource(state);
    }
  }

  /** Replan a source whose style identity changed, freeing the old generation first. */
  private resetSource(state: SourceState): void {
    for (const job of [...this.active.values()]) {
      if (job.state === state) this.cancelJob(job);
    }
    this.forgetOwned(state.source.id);
    this.plan(state);
    this.pump();
  }

  /** Drop one source's planned keys and bodies that no other source still lists. */
  private forgetOwned(id: string): void {
    for (const key of this.ownership.get(id) ?? []) {
      if (!this.isOwnedElsewhere(key, id)) this.forgetKey(key);
    }
    this.ownership.delete(id);
    this.revisions.delete(id);
  }

  private isOwnedElsewhere(key: string, except: string): boolean {
    for (const [id, owned] of this.ownership) {
      if (id !== except && owned.has(key)) return true;
    }
    return false;
  }

  private forgetKey(key: string): void {
    this.store.delete(key);
    this.ready.delete(key);
    this.planned.delete(key);
  }

  /** Route participating tile requests through the store protocol, from the first plan on. */
  private rewriteStoredRequests(): void {
    if (this.isRewriting) return;
    this.isRewriting = true;
    this.map.setTransformRequest((url: string, type?: string): RequestParameters | undefined => {
      return type === "Tile" && this.planned.has(url)
        ? { url: `${STORE_PROTOCOL}://${url}` }
        : undefined;
    });
  }

  /** Credit the first visible load of a tile, which preload either prepared or missed. */
  private countVisibleLoad(event: object): void {
    const { sourceId, tile } = event as {
      sourceId?: unknown;
      tile?: { tileID?: { canonical?: WarmTile } };
    };
    const canonical = tile?.tileID?.canonical;
    if (!this.isLanded || typeof sourceId !== "string" || !canonical) return;
    for (const { source } of this.sources.values()) {
      const key = source.visibleKey(sourceId, canonical);
      if (key !== null) this.countDemand(source.layer, key);
    }
  }

  private countDemand(layer: TileLayerKey, key: string): void {
    if (this.counted.has(key) || this.missing.has(key)) return;
    this.counted.add(key);
    if (this.ready.has(key) || this.active.has(key)) this.telemetry.hit(layer);
    else this.telemetry.miss(layer);
  }

  private isPrepared(key: string): boolean {
    return this.active.has(key)
      || this.ready.has(key)
      || this.missing.has(key)
      || this.store.absentError(key) !== undefined
      || this.store.has(key);
  }

  private report(): void {
    const { done, total, bytes } = this.progress();
    this.telemetry.progress(done, total, bytes);
    this.wake();
  }

  /** Resolve the current settled waiters so a new plan or expiry is noticed at once. */
  private wake(): void {
    if (this.wakeListeners.size === 0) return;
    const listeners = [...this.wakeListeners];
    this.wakeListeners.clear();
    for (const listener of listeners) listener();
  }
}

let current: ScenePreload | null = null;
let activePreload: ScenePreload | null = null;

/** Start the preload for a scene that is opening, closing the previous one. */
export function openScenePreload(map: PreloadMap): ScenePreload {
  closeScenePreload();
  current = new ScenePreload(map);
  return current;
}

/** The preload of the open scene, which its layers register their sources with. */
export function currentScenePreload(): ScenePreload | null {
  return current;
}

/** Abort the open scene's preload and free what it holds. */
export function closeScenePreload(): void {
  current?.destroy();
  current = null;
}

let activeStore: TileStore | null = null;
let isProtocolAdded = false;

function ensureStoreProtocol(): void {
  if (isProtocolAdded) return;
  isProtocolAdded = true;
  addProtocol(STORE_PROTOCOL, serveStoredTile);
}

/**
 * Suspend background launches while visible protocol work needs the network. Protocol
 * handlers call the remote manager directly and never enter the store broker, so they
 * bracket here instead while preload tracing calls the manager directly and never counts.
 */
export async function withVisibleDemand<T>(work: () => Promise<T>): Promise<T> {
  // The open scene can change while the work runs, so the release must target this owner.
  const owner = activePreload;
  owner?.beginVisibleDemand();
  try {
    return await work();
  } finally {
    owner?.endVisibleDemand();
  }
}

/** Answer a rewritten tile request from the store, falling back to the network if it vanished. */
export async function serveStoredTile(
  parameters: { url: string },
  abort: AbortController,
): Promise<{ data: ArrayBuffer }> {
  const url = parameters.url.slice(`${STORE_PROTOCOL}://`.length);
  const store = activeStore;
  const owner = activePreload;
  throwIfCallerAborted(abort.signal);
  const entry = store?.read(url);
  if (entry instanceof Blob) {
    throwIfCallerAborted(abort.signal);
    return { data: await joinCallerAbort(entry.arrayBuffer(), abort.signal) };
  }
  if (entry === undefined) {
    const absent = store?.absentError(url);
    if (absent) throw absent;
  }
  throwIfCallerAborted(abort.signal);
  if (!store) return { data: await fetchArrayBuffer(url, abort.signal) };
  owner?.prioritizeVisible(url);
  const epoch = owner?.epochFor(url) ?? null;
  const isVisibleLive = () => {
    if (activePreload !== owner || owner === null) return false;
    if (epoch === null) return true;
    return owner.isLiveEpoch(url, epoch);
  };
  const shared = owner?.findSharedLoader(url);
  const loader = shared ?? (() => downloadVisibleBlob(url));
  // One demand covers the join and the fresh flight that follows, so nothing launches between them.
  owner?.beginVisibleDemand();
  try {
    if (entry !== undefined) {
      try {
        const blob = await joinCallerAbort(entry, abort.signal);
        throwIfCallerAborted(abort.signal);
        if (blob) return { data: await joinCallerAbort(blob.arrayBuffer(), abort.signal) };
      } catch (error: unknown) {
        if (abort.signal.aborted) throw error;
        if (isMissingResponse(error)) throw error;
      }
    }
    const flight = store.share(url, loader);
    void store.hold(url, flight, isVisibleLive).then(
      () => undefined,
      () => undefined,
    );
    let blob: Blob | undefined;
    try {
      blob = await joinCallerAbort(flight, abort.signal);
    } catch (error: unknown) {
      if (abort.signal.aborted) throw error;
      if (isMissingResponse(error)) throw error;
      throwIfCallerAborted(abort.signal);
      const retry = store.share(url, loader);
      void store.hold(url, retry, isVisibleLive).then(
        () => undefined,
        () => undefined,
      );
      const retryBlob = await joinCallerAbort(retry, abort.signal);
      throwIfCallerAborted(abort.signal);
      if (!retryBlob) return { data: await fetchArrayBuffer(url, abort.signal) };
      return { data: await joinCallerAbort(retryBlob.arrayBuffer(), abort.signal) };
    }
    throwIfCallerAborted(abort.signal);
    if (!blob) return { data: await fetchArrayBuffer(url, abort.signal) };
    return { data: await joinCallerAbort(blob.arrayBuffer(), abort.signal) };
  } finally {
    owner?.endVisibleDemand();
  }
}

/** Run a task so a synchronous throw still settles its job instead of escaping the pump. */
function runPreloadTask(task: PreloadTask, abort: AbortController): Promise<Blob | undefined> {
  return new Promise<Blob | undefined>((resolve) => resolve(task.run(abort)));
}

/** Wait for a shared download while letting this reader cancel promptly without aborting it. */
function joinCallerAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

function throwIfCallerAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

/** Fetch a visibly demanded tile at normal priority, keeping background downloads low. */
async function downloadVisibleBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);
  return response.blob();
}

/** Fetch a tile for one caller alone, so its abort never touches a shared download. */
async function fetchArrayBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);
  return response.arrayBuffer();
}

/** Whether an HTTP failure is a missing ocean tile that should not download again. */
function isMissingResponse(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  return message.includes("Bad response: 404");
}

/** The dev-stats telemetry used outside tests. */
function defaultTelemetry(): PreloadTelemetry {
  return {
    begin: beginPreload,
    progress: setPreloadProgress,
    hit: notePreloadHit,
    miss: notePreloadMiss,
  };
}
