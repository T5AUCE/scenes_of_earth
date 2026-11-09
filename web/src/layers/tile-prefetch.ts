/** Bounded destination-aware tile preparation shared by DEM, contours and basemap. */
import type { Map as MapLibreMap } from "maplibre-gl";

import {
  CONTOUR_OVERZOOM,
  contourOptionsVersion,
  demParentsForTile,
  demParentsForTiles,
  levelsForZoom,
  warmTilesForZoom,
  type ContourLadder,
  type WarmTile,
} from "../contour-ladder";
import { subscribeGesture } from "../gesture-quality";
import {
  longitudeDelta,
  predictDestinationCenter,
  tileInScene,
  tileRangeKey,
  viewportBoundsForCenter,
  type BasemapDescriptor,
  type ViewportMap,
} from "../render/tile-viewport";
import {
  noteSpeculativeHit,
  noteSpeculativeMiss,
  noteSpeculativeWasted,
  type TileLayerKey,
} from "../dev-stats";
import { convertValue } from "../units";
import type { Bbox } from "../types";

/** Candidate tiles kept per source, so one viewport never warms a pyramid. */
export const PREFETCH_MAX_PER_SOURCE = 12;
/** Extra upstream requests started per prediction, covering DEM and basemap warming. */
export const PREFETCH_MAX_HTTP_PER_PREDICTION = 24;
/** DEM and basemap fetches running at once, leaving headroom for visible tiles. */
export const PREFETCH_NETWORK_LANES = 2;
/** Contour traces running at once, so speculation never crowds the visible trace. */
export const PREFETCH_TRACE_LANES = 1;
/** Bytes the scheduler may cause the manager to hold before new work waits. */
export const SPECULATIVE_BUDGET_BYTES = 48 * 1024 * 1024;
/** Bounded memo size for missing and already consumed tiles. */
export const MAX_MEMO_TILES = 2000;

// A 512 square float DEM dominates the budget, while PBFs stay small.
const DEM_TILE_EST_BYTES = 1024 * 1024;
const CONTOUR_TILE_EST_BYTES = 32 * 1024;
const BASEMAP_TILE_EST_BYTES = 128 * 1024;
// A traced parent stays decoded as a padded float grid in the manager's parsed cache.
const DECODED_DEM_BYTES = 4 * 514 * 514;
// Sequential revalidation can still leave two misses in the smallest cache.
const TRACE_WORKER_RESERVE_REQUESTS = 2;
// The worker fetches up to four parents at once, so a trace holds every speculation DEM lane.
const TRACE_DEM_RESERVE_LANES = 2;

// Half a second ahead covers a fast zoom step without fetching a pyramid.
const PREDICTION_HORIZON_SECS = 0.5;
const MIN_ZOOM_VELOCITY_PER_SEC = 0.5;
const MIN_PAN_DEG_PER_SEC = 0.05;
// Predictions never exceed the highest consumer ceiling below.
const MAX_RAW_ZOOM = 24;
// The plugin materializes one pixel of padding before tracing, matching the overlay.
const CONTOUR_BUFFER_PX = 1;

const LAYER_FOR_KIND: Record<JobKind, TileLayerKey> = {
  dem: "terrain",
  trace: "contours",
  basemap: "basemap",
};

/** What the scheduler reads from the contour overlay on every prediction. */
export interface ContourPrefetchPlan {
  sourceId: string;
  ladder: ContourLadder;
  maxzoom: number;
  reliefMaxzoom: number;
  elevationUnit: string;
  enabled: boolean;
  bbox: Bbox;
}

/** Source ids the scheduler treats as visible work that outranks speculation. */
export interface TilePrefetchWiring {
  reliefSourceId: string;
  basemapSourceId: string;
}

/** The map surface the scheduler predicts from and warms for. */
export type TilePrefetchMap = ViewportMap
  & Pick<MapLibreMap, "on" | "off">
  & Partial<Pick<MapLibreMap, "isSourceLoaded">>;

/**
 * The DEM manager subset the scheduler warms through. Routing DEM warming through the
 * manager shares its URL-keyed tile cache with the contour worker's own downloads and
 * reference-counts cancellation, instead of racing it with a separate HTTP warmer.
 */
export interface DemFetcher {
  fetchTile?(z: number, x: number, y: number, abort: AbortController): Promise<unknown>;
  fetchContourTile?(
    z: number,
    x: number,
    y: number,
    options: unknown,
    cancel: AbortController,
  ): Promise<unknown>;
}

/** Warm one versioned basemap URL so later visible reads hit the HTTP cache. */
export type HttpWarmer = (url: string, signal: AbortSignal) => Promise<unknown>;

/**
 * Count speculation outcomes for the dev readout. A hit is the first visible request that
 * found a tile already warm or in flight. A miss is a visible request nothing had prepared.
 * Wasted work was cancelled, forgotten unused under the budget, or left over at destroy.
 */
export interface PrefetchTelemetry {
  hit(source: TileLayerKey): void;
  miss(source: TileLayerKey): void;
  wasted(source: TileLayerKey): void;
}

type JobKind = "dem" | "trace" | "basemap";

interface Job {
  kind: JobKind;
  key: string;
  abort: AbortController;
  generation: number;
  reservedBytes: number;
  cancelled: boolean;
  settled: boolean;
  reused: boolean;
}

type ParentState = "ready" | "wait" | "drop";

interface Destination {
  raw: number;
  lng: number;
  lat: number;
}

/** The zoom each consumer requests at for a destination, with its own rounding and ceiling. */
interface ConsumerZooms {
  contour: number;
  relief: number[];
  basemap: number;
}

interface ContourCandidate {
  key: string;
  tile: WarmTile;
  options: Record<string, unknown>;
  parents: WarmTile[];
}

/** The contour, DEM and basemap candidates for one destination. */
interface WantedTiles {
  contour: ContourCandidate[];
  dem: WarmTile[];
  basemap: string[];
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
 * Warm the predicted destination viewport and directional pan neighbours through the real
 * DEM manager cache and versioned basemap URLs, never per frame. Visible demand promotes
 * matching jobs and never waits on speculation, while speculation keeps a small always-on
 * share of two network lanes and one trace lane so it runs during movement. Every key
 * holds tile coordinates plus versioned options instead of scene identity, so a long-term
 * CDN cache serves any scene.
 *
 * The byte ledger counts what this scheduler caused the manager to hold. The manager offers
 * no eviction API, so admission only refuses new work at the budget and never forgets an
 * entry the manager still owns. Only basemap entries leave early, because their bodies
 * are not kept by the manager. A result larger than its reservation is counted as measured.
 */
export class TilePrefetchScheduler {
  private readonly map: TilePrefetchMap;
  private readonly plan: () => ContourPrefetchPlan | null;
  private readonly demTemplate: string;
  private readonly demFetcher: DemFetcher | null;
  private readonly wiring: TilePrefetchWiring;
  private readonly basemapSource: () => BasemapDescriptor | null;
  private readonly httpWarmer: HttpWarmer;
  private readonly clock: () => number;
  private readonly telemetry: PrefetchTelemetry;
  private readonly budgetBytes: number;
  private readonly stopListening: () => void;
  // A cancelled job leaves this map but keeps its lane and reservation until it settles.
  private readonly active = new Map<string, Job>();
  private readonly warmed = new Map<string, { kind: JobKind; bytes: number }>();
  // Decoded parents stay in the manager's parsed cache, so their bytes are never released.
  private readonly decoded = new Set<string>();
  private readonly consumed = new BoundedKeySet(MAX_MEMO_TILES);
  private readonly missing = new BoundedKeySet(MAX_MEMO_TILES);
  private demQueue: WarmTile[] = [];
  private traceQueue: ContourCandidate[] = [];
  private basemapQueue: string[] = [];
  private basemap: BasemapDescriptor | null | undefined;
  private generation = 0;
  private networkLanes = 0;
  private demLanes = 0;
  private traceLanes = 0;
  private speculativeBytes = 0;
  private peakSpeculativeBytes = 0;
  private planCount = 0;
  private lastSignature: string | null = null;
  private startedForPrediction = 0;
  private lastZoom: number | null = null;
  private lastLng = 0;
  private lastLat = 0;
  private lastTimeMs = 0;
  private zoomVelocityPerSec = 0;
  private lngVelocityPerSec = 0;
  private latVelocityPerSec = 0;
  private destroyed = false;

  constructor(
    map: TilePrefetchMap,
    plan: () => ContourPrefetchPlan | null,
    dem: { tileTemplate: string; fetcher: DemFetcher | null },
    wiring: TilePrefetchWiring,
    basemap: () => BasemapDescriptor | null,
    httpWarmer: HttpWarmer,
    clock: () => number = () => performance.now(),
    telemetry: PrefetchTelemetry = defaultTelemetry(),
    budgetBytes: number = SPECULATIVE_BUDGET_BYTES,
  ) {
    this.map = map;
    this.plan = plan;
    this.demTemplate = dem.tileTemplate;
    this.demFetcher = dem.fetcher;
    this.wiring = wiring;
    this.basemapSource = basemap;
    this.httpWarmer = httpWarmer;
    this.clock = clock;
    this.telemetry = telemetry;
    this.budgetBytes = budgetBytes;
    // Real camera updates emit move then zoom at the same position, so both funnel
    // through one sampler that ignores the duplicate notification.
    const sampled = () => {
      this.trackVelocity(this.clock());
      this.consider();
    };
    const visibleLoading = (event: object) => this.onVisibleLoading(event);
    const resume = () => this.consider();
    const styleChanged = () => this.resolveBasemap();
    map.on("zoom", sampled);
    map.on("move", sampled);
    map.on("sourcedataloading", visibleLoading);
    map.on("sourcedata", resume);
    map.on("idle", resume);
    map.on("styledata", styleChanged);
    const stopGesture = subscribeGesture(map, {
      onStart: () => {
        if (this.destroyed) return;
        this.cancelAll();
        this.resetVelocity();
      },
      onEnd: () => {
        if (this.destroyed) return;
        this.resetVelocity();
        this.consider();
      },
    });
    this.stopListening = () => {
      map.off("zoom", sampled);
      map.off("move", sampled);
      map.off("sourcedataloading", visibleLoading);
      map.off("sourcedata", resume);
      map.off("idle", resume);
      map.off("styledata", styleChanged);
      stopGesture();
    };
  }

  /** Abort speculative work and forget the prediction, keeping warmed tiles for return pans. */
  reset(): void {
    this.cancelAll();
    this.resetVelocity();
  }

  /** Abort every scheduler-owned job, promoted ones included, and drop the queued prediction. */
  cancelAll(): void {
    this.abortInflight(true);
    this.demQueue = [];
    this.traceQueue = [];
    this.basemapQueue = [];
    this.lastSignature = null;
    this.startedForPrediction = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelAll();
    this.destroyed = true;
    for (const entry of this.warmed.values()) this.telemetry.wasted(LAYER_FOR_KIND[entry.kind]);
    this.warmed.clear();
    this.decoded.clear();
    this.consumed.clear();
    this.missing.clear();
    this.speculativeBytes = 0;
    this.stopListening();
  }

  /** Ledger bytes, entries, peak, memo size and completed plans, for review and tests. */
  speculativeUsage(): {
    bytes: number;
    entries: number;
    peak: number;
    missing: number;
    consumed: number;
    plans: number;
  } {
    return {
      bytes: this.speculativeBytes,
      entries: this.warmed.size,
      peak: this.peakSpeculativeBytes,
      missing: this.missing.size,
      consumed: this.consumed.size,
      plans: this.planCount,
    };
  }

  private consider(): void {
    if (this.destroyed) return;
    const current = this.plan();
    if (!current?.enabled) {
      this.cancelAll();
      return;
    }
    const destination = this.destination();
    if (!destination) return;
    if (this.basemap === undefined) this.resolveBasemap();
    const zooms = consumerZooms(current, this.basemap ?? null, destination.raw);
    const signature = this.coverageSignature(current, zooms, destination);
    if (signature === null) return;
    if (signature !== this.lastSignature) this.replan(current, zooms, destination, signature);
    this.pump(current);
  }

  /** Resolve the basemap, treating a changed source as a new style whose work is stale at once. */
  private resolveBasemap(): void {
    const previous = this.basemap;
    this.basemap = this.basemapSource();
    if (previous === undefined || sameBasemap(previous, this.basemap)) return;
    this.generation += 1;
    this.cancelAll();
  }

  /**
   * Key the tiles every consumer would request, so unchanged coverage skips candidate
   * enumeration while sub-tile pans and duplicate notifications cost a few tile indices.
   */
  private coverageSignature(
    current: ContourPrefetchPlan,
    zooms: ConsumerZooms,
    destination: Destination,
  ): string | null {
    const ranges: string[] = [];
    for (const zoom of new Set([zooms.contour, ...zooms.relief, zooms.basemap])) {
      if (zoom < 0) continue;
      const bounds = destinationBounds(this.map, destination, zoom);
      if (!bounds) return null;
      ranges.push(tileRangeKey(bounds, zoom));
    }
    const levels = levelsForZoom(current.ladder.thresholds, zooms.contour);

    return [
      this.generation,
      current.sourceId,
      current.elevationUnit,
      current.bbox.join(","),
      levels.join(","),
      this.basemap?.template ?? "",
      ...ranges,
    ].join("|");
  }

  private replan(
    current: ContourPrefetchPlan,
    zooms: ConsumerZooms,
    destination: Destination,
    signature: string,
  ): void {
    const wanted = wantedTiles(this.map, current, this.basemap ?? null, zooms, destination);
    this.lastSignature = signature;
    this.startedForPrediction = 0;
    this.planCount += 1;
    this.demQueue = wanted.dem;
    this.traceQueue = wanted.contour;
    this.basemapQueue = wanted.basemap;
    this.cancelObsolete(wanted);
  }

  private cancelObsolete(wanted: WantedTiles): void {
    const keys = new Set([
      ...wanted.dem.map((tile) => tileUrl(this.demTemplate, tile)),
      ...wanted.contour.map((candidate) => candidate.key),
      ...wanted.basemap,
    ]);
    for (const job of [...this.active.values()]) {
      if (!keys.has(job.key)) this.cancelJob(job, false);
    }
  }

  private destination(): Destination | null {
    const zoom = this.map.getZoom();
    const center = this.map.getCenter();
    if (!Number.isFinite(zoom) || !Number.isFinite(center.lng) || !Number.isFinite(center.lat)) {
      return null;
    }
    const zoomVelocity = Math.abs(this.zoomVelocityPerSec) < MIN_ZOOM_VELOCITY_PER_SEC
      ? 0
      : this.zoomVelocityPerSec;
    const panning = Math.hypot(this.lngVelocityPerSec, this.latVelocityPerSec)
      >= MIN_PAN_DEG_PER_SEC;
    const lngVelocity = panning ? this.lngVelocityPerSec : 0;
    const latVelocity = panning ? this.latVelocityPerSec : 0;
    const raw = zoom + zoomVelocity * PREDICTION_HORIZON_SECS;

    return {
      raw: Math.min(MAX_RAW_ZOOM, Math.max(0, raw)),
      ...predictDestinationCenter(
        center.lng,
        center.lat,
        lngVelocity,
        latVelocity,
        PREDICTION_HORIZON_SECS,
      ),
    };
  }

  private trackVelocity(nowMs: number): void {
    const zoom = this.map.getZoom();
    const { lng, lat } = this.map.getCenter();
    const first = this.lastZoom === null;
    const unchanged = zoom === this.lastZoom && lng === this.lastLng && lat === this.lastLat;
    const elapsedMs = Math.max(1, nowMs - this.lastTimeMs);
    const zoomDelta = zoom - (this.lastZoom ?? zoom);
    const lngDelta = longitudeDelta(this.lastLng, lng);
    const latDelta = lat - this.lastLat;
    this.lastTimeMs = nowMs;
    // The duplicate of a move-plus-zoom pair carries no new state, so velocity survives it.
    if (first || unchanged) {
      this.lastZoom = zoom;
      this.lastLng = lng;
      this.lastLat = lat;
      return;
    }
    if (this.reversed(zoomDelta, lngDelta, latDelta)) this.cancelAll();
    this.zoomVelocityPerSec = zoomDelta / elapsedMs * 1000;
    this.lngVelocityPerSec = lngDelta / elapsedMs * 1000;
    this.latVelocityPerSec = latDelta / elapsedMs * 1000;
    this.lastZoom = zoom;
    this.lastLng = lng;
    this.lastLat = lat;
  }

  /** Whether the camera turned back, so the old destination prediction is stale. */
  private reversed(zoomDelta: number, lngDelta: number, latDelta: number): boolean {
    if (zoomDelta !== 0) {
      return this.zoomVelocityPerSec !== 0
        && Math.sign(zoomDelta) !== Math.sign(this.zoomVelocityPerSec);
    }
    return this.lngVelocityPerSec * lngDelta + this.latVelocityPerSec * latDelta < 0;
  }

  private resetVelocity(): void {
    this.lastZoom = null;
    this.zoomVelocityPerSec = 0;
    this.lngVelocityPerSec = 0;
    this.latVelocityPerSec = 0;
  }

  /** Credit visible demand, which promotes the matching job so it survives re-plans. */
  private onVisibleLoading(event: object): void {
    const { sourceId, tile } = event as {
      sourceId?: unknown;
      tile?: { tileID?: { canonical?: WarmTile } };
    };
    const current = this.plan();
    if (!current || typeof sourceId !== "string") return;
    if (!visibleIds(current, this.wiring).includes(sourceId)) return;
    const canonical = tile?.tileID?.canonical;
    if (canonical) this.noteVisibleDemand(current, sourceId, canonical);
  }

  /**
   * Count the first visible use of a tile that speculation prepared. A job still in flight
   * is marked reused so it can no longer be cancelled, while the manager's reference counts
   * keep the visible request independent of it.
   */
  private noteVisibleDemand(current: ContourPrefetchPlan, sourceId: string, tile: WarmTile): void {
    if (!current.enabled) return;
    const target = this.visibleTarget(current, sourceId, tile);
    if (!target) return;
    const job = this.active.get(target.key);
    if (job) {
      if (job.reused) return;
      job.reused = true;
      this.telemetry.hit(LAYER_FOR_KIND[job.kind]);
      return;
    }
    const entry = this.warmed.get(target.key);
    if (entry) {
      this.consume(target.key, entry.bytes);
      this.telemetry.hit(LAYER_FOR_KIND[entry.kind]);
      return;
    }
    if (!this.consumed.has(target.key)) this.telemetry.miss(LAYER_FOR_KIND[target.kind]);
  }

  private visibleTarget(
    current: ContourPrefetchPlan,
    sourceId: string,
    tile: WarmTile,
  ): { kind: JobKind; key: string } | null {
    if (sourceId === this.wiring.reliefSourceId) {
      return { kind: "dem", key: tileUrl(this.demTemplate, tile) };
    }
    if (sourceId === current.sourceId) {
      const candidate = contourCandidate(current, tile);
      return candidate ? { kind: "trace", key: candidate.key } : null;
    }
    if (sourceId === this.wiring.basemapSourceId && this.basemap) {
      return { kind: "basemap", key: tileUrl(this.basemap.template, tile) };
    }
    return null;
  }

  /** Hand a warmed tile to visible ownership, so it leaves the speculative ledger. */
  private consume(key: string, bytes: number): void {
    this.warmed.delete(key);
    this.addBytes(-bytes);
    this.consumed.add(key);
  }

  /**
   * Abort in-flight jobs for a stale prediction. Promoted jobs survive a re-plan because
   * the manager keeps the visible request alive, while a forced release drops the
   * scheduler's own reference for the same reason.
   */
  private abortInflight(force = false): void {
    for (const job of [...this.active.values()]) this.cancelJob(job, force);
  }

  private cancelJob(job: Job, force = false): void {
    if (job.cancelled || (job.reused && !force)) return;
    job.cancelled = true;
    this.active.delete(job.key);
    job.abort.abort();
    if (!job.reused) this.telemetry.wasted(LAYER_FOR_KIND[job.kind]);
  }

  /** Start queued candidates while lanes and budget allow, even while visible tiles load. */
  private pump(current: ContourPrefetchPlan | null = this.plan()): void {
    if (this.destroyed || !current?.enabled) return;
    this.demQueue = this.drain(this.demQueue, (tile) => this.tryStartDem(tile));
    this.traceQueue = this.drain(this.traceQueue, (candidate) => this.tryStartTrace(candidate));
    this.basemapQueue = this.drain(this.basemapQueue, (url) => this.tryStartBasemap(url));
  }

  /** Run the queue in order, keeping blocked items and stopping at the first full lane. */
  private drain<T>(queue: T[], tryStart: (item: T) => "started" | "drop" | "wait" | "stop"): T[] {
    const kept: T[] = [];
    for (const [index, item] of queue.entries()) {
      const outcome = tryStart(item);
      if (outcome === "wait") kept.push(item);
      if (outcome === "stop") return [...kept, ...queue.slice(index)];
    }
    return kept;
  }

  private tryStartDem(tile: WarmTile): "started" | "drop" | "stop" {
    const fetch = this.demFetcher?.fetchTile;
    if (!fetch) return "drop";
    const url = tileUrl(this.demTemplate, tile);
    if (this.isPrepared(url)) return "drop";
    if (this.demLanes + 1 > PREFETCH_NETWORK_LANES) return "stop";
    if (!this.networkAvailable() || !this.admit(DEM_TILE_EST_BYTES)) return "stop";
    this.startJob("dem", url, DEM_TILE_EST_BYTES, 1, (abort) => {
      return fetch.call(this.demFetcher, tile.z, tile.x, tile.y, abort);
    });
    return "started";
  }

  private tryStartTrace(candidate: ContourCandidate): "started" | "drop" | "wait" | "stop" {
    const fetch = this.demFetcher?.fetchContourTile;
    if (!fetch) return "drop";
    if (this.isPrepared(candidate.key)) return "drop";
    if (this.traceLanes >= PREFETCH_TRACE_LANES) return "stop";
    const parents = this.parentState(candidate);
    if (parents !== "ready") return parents;
    // Charge the worst case so eviction cannot push a prediction past its bound.
    const allowanceCost = candidate.parents.length + TRACE_WORKER_RESERVE_REQUESTS;
    if (this.startedForPrediction + allowanceCost > PREFETCH_MAX_HTTP_PER_PREDICTION) {
      return "stop";
    }
    if (this.demLanes + TRACE_DEM_RESERVE_LANES > PREFETCH_NETWORK_LANES) return "stop";
    if (!this.networkAvailable()) return "stop";
    const fresh = candidate.parents.map((parent) => tileUrl(this.demTemplate, parent))
      .filter((url) => !this.decoded.has(url));
    // Tracing decodes the parents inside the worker, where the manager keeps them for good.
    const decodedBytes = this.decodedBytes(fresh);
    if (!this.admit(CONTOUR_TILE_EST_BYTES + decodedBytes)) return "stop";
    for (const url of fresh) this.decoded.add(url);
    this.addBytes(decodedBytes);
    this.startJob(
      "trace",
      candidate.key,
      CONTOUR_TILE_EST_BYTES,
      allowanceCost,
      async (abort) => {
        await this.revalidateParents(candidate, abort);
        const { z, x, y } = candidate.tile;
        return fetch.call(this.demFetcher, z, x, y, candidate.options, abort);
      },
    );
    return "started";
  }

  private decodedBytes(urls: readonly string[]): number {
    return urls.length * DECODED_DEM_BYTES;
  }

  /**
   * Touch each parent through the public manager path one at a time, so a parent its cache
   * evicted is refetched under this job's network lane instead of unseen inside the worker.
   */
  private async revalidateParents(
    candidate: ContourCandidate,
    abort: AbortController,
  ): Promise<void> {
    const fetch = this.demFetcher?.fetchTile;
    if (!fetch) return;
    for (const { z, x, y } of candidate.parents) {
      await fetch.call(this.demFetcher, z, x, y, abort);
    }
  }

  private tryStartBasemap(url: string): "started" | "drop" | "stop" {
    if (this.isPrepared(url)) return "drop";
    if (!this.networkAvailable() || !this.admit(BASEMAP_TILE_EST_BYTES)) return "stop";
    this.startJob("basemap", url, BASEMAP_TILE_EST_BYTES, 1, (abort) => {
      return this.httpWarmer(url, abort.signal);
    });
    return "started";
  }

  private isPrepared(key: string): boolean {
    return this.active.has(key) || this.warmed.has(key) || this.consumed.has(key)
      || this.missing.has(key);
  }

  private networkAvailable(): boolean {
    return this.networkLanes < PREFETCH_NETWORK_LANES
      && this.startedForPrediction < PREFETCH_MAX_HTTP_PER_PREDICTION;
  }

  /** A trace with a known-missing parent is dropped, while one with an unseen parent waits. */
  private parentState(candidate: ContourCandidate): ParentState {
    if (!this.demFetcher?.fetchTile) return "ready";
    const urls = candidate.parents.map((parent) => tileUrl(this.demTemplate, parent));
    if (urls.some((url) => this.missing.has(url))) return "drop";
    const seen = urls.every((url) => this.warmed.has(url) || this.consumed.has(url));
    return seen ? "ready" : "wait";
  }

  /** Report whether a reservation fits, forgetting old basemap entries the manager never kept. */
  private admit(bytes: number): boolean {
    while (this.speculativeBytes + bytes > this.budgetBytes) {
      if (!this.forgetOldestBasemap()) return false;
    }
    return true;
  }

  private forgetOldestBasemap(): boolean {
    for (const [key, entry] of this.warmed) {
      if (entry.kind !== "basemap") continue;
      this.warmed.delete(key);
      this.addBytes(-entry.bytes);
      this.telemetry.wasted(LAYER_FOR_KIND[entry.kind]);
      return true;
    }
    return false;
  }

  private startJob(
    kind: JobKind,
    key: string,
    reservedBytes: number,
    allowanceCost: number,
    launch: (abort: AbortController) => Promise<unknown>,
  ): void {
    const job: Job = {
      kind,
      key,
      abort: new AbortController(),
      generation: this.generation,
      reservedBytes,
      cancelled: false,
      settled: false,
      reused: false,
    };
    this.addBytes(reservedBytes);
    this.active.set(key, job);
    // A trace holds every speculation DEM lane because its worker can miss all parents at once.
    if (kind === "trace") this.traceLanes += 1;
    if (kind === "dem") this.demLanes += 1;
    if (kind === "trace") this.demLanes += TRACE_DEM_RESERVE_LANES;
    this.networkLanes += 1;
    this.startedForPrediction += allowanceCost;
    new Promise<unknown>((resolve) => resolve(launch(job.abort))).then(
      (data) => this.settle(job, data, null),
      (error: unknown) => this.settle(job, undefined, error),
    );
  }

  /**
   * Settle one job exactly once, whatever its state. Only a current, uncancelled job may
   * record a result, so a stale completion can never remove or mark its replacement.
   */
  private settle(job: Job, data: unknown, error: unknown): void {
    if (job.settled) return;
    job.settled = true;
    this.addBytes(-job.reservedBytes);
    if (job.kind === "trace") this.traceLanes -= 1;
    if (job.kind === "dem") this.demLanes -= 1;
    if (job.kind === "trace") this.demLanes -= TRACE_DEM_RESERVE_LANES;
    this.networkLanes -= 1;
    if (this.active.get(job.key) === job) this.active.delete(job.key);
    if (this.destroyed) return;
    if (!job.cancelled && job.generation === this.generation) {
      if (error !== null) this.rememberFailure(job, error);
      else this.rememberResult(job, data);
    }
    this.pump();
  }

  private rememberFailure(job: Job, error: unknown): void {
    if (isMissingResponse(error)) this.missing.add(job.key);
  }

  private rememberResult(job: Job, data: unknown): void {
    if (job.reused) {
      this.consumed.add(job.key);
      return;
    }
    const bytes = Math.max(1, measuredBytes(data, job.reservedBytes));
    this.warmed.delete(job.key);
    this.warmed.set(job.key, { kind: job.kind, bytes });
    this.addBytes(bytes);
  }

  private addBytes(delta: number): void {
    this.speculativeBytes = Math.max(0, this.speculativeBytes + delta);
    this.peakSpeculativeBytes = Math.max(this.peakSpeculativeBytes, this.speculativeBytes);
  }
}

/**
 * Pick each consumer's request zoom the way MapLibre does. Vector sources floor the zoom,
 * while raster-dem rounds it, so relief covers both neighbours and every consumer is clamped
 * to its own ceiling rather than filtered away above it.
 */
function consumerZooms(
  current: ContourPrefetchPlan,
  basemap: BasemapDescriptor | null,
  raw: number,
): ConsumerZooms {
  const vector = Math.floor(raw);
  const relief = [Math.floor(raw), Math.round(raw)]
    .map((zoom) => Math.min(zoom, current.reliefMaxzoom));

  return {
    contour: Math.min(vector, current.maxzoom),
    relief: [...new Set(relief)],
    basemap: basemap ? Math.min(vector, basemap.maxzoom) : -1,
  };
}

/**
 * Build per-consumer destination candidates from the predicted viewport, filtered to the
 * scene. Relief warms its own zooms, contours warm their DEM parents first and then trace,
 * and the basemap warms its resolved template up to its own ceiling.
 */
function wantedTiles(
  map: TilePrefetchMap,
  current: ContourPrefetchPlan,
  basemap: BasemapDescriptor | null,
  zooms: ConsumerZooms,
  destination: Destination,
): WantedTiles {
  const tilesAt = (zoom: number) => {
    const bounds = destinationBounds(map, destination, zoom);
    return bounds ? viewportTilesAt(bounds, zoom, current.bbox) : [];
  };
  const contourTiles = tilesAt(zooms.contour);
  const contour = contourTiles.flatMap((tile) => contourCandidate(current, tile) ?? []);
  const parents = demParentsForTiles(contour.map((candidate) => candidate.tile), CONTOUR_OVERZOOM);
  const relief = interleaveAll(zooms.relief.map(tilesAt)).slice(0, PREFETCH_MAX_PER_SOURCE);
  const basemapTiles = basemap && zooms.basemap >= 0
    ? tilesAt(zooms.basemap).slice(0, PREFETCH_MAX_PER_SOURCE)
    : [];

  return {
    contour,
    dem: dedupeTiles([...parents, ...relief]),
    basemap: basemapTiles.map((tile) => tileUrl(basemap!.template, tile)),
  };
}

/** The trace a contour tile needs, or null when no level shows at its zoom. */
function contourCandidate(current: ContourPrefetchPlan, tile: WarmTile): ContourCandidate | null {
  const levels = levelsForZoom(current.ladder.thresholds, tile.z);
  if (levels.length === 0) return null;
  const options = contourRequestOptions(levels, current.elevationUnit);
  const version = contourOptionsVersion(current.elevationUnit, CONTOUR_OVERZOOM, CONTOUR_BUFFER_PX);

  return {
    key: contourCacheKey(tile, options, version),
    tile,
    options,
    parents: demParentsForTile(tile, CONTOUR_OVERZOOM),
  };
}

/** Viewport tiles at one zoom for one bounds, filtered to the scene. */
function viewportTilesAt(
  bounds: { west: number; south: number; east: number; north: number },
  zoom: number,
  bbox: Bbox,
): WarmTile[] {
  return warmTilesForZoom(
    bounds.west,
    bounds.south,
    bounds.east,
    bounds.north,
    zoom,
    PREFETCH_MAX_PER_SOURCE,
  ).filter((tile) => tileInScene(tile, bbox));
}

/** Dedupe tiles by coordinates while keeping the first consumer's order. */
function dedupeTiles(tiles: readonly WarmTile[]): WarmTile[] {
  const seen = new Map<string, WarmTile>();
  for (const tile of tiles) {
    const key = tileKey(tile);
    if (!seen.has(key)) seen.set(key, tile);
  }
  return [...seen.values()];
}

/** Alternate several candidate lists so no zoom starves the others. */
function interleaveAll(lists: readonly (readonly WarmTile[])[]): WarmTile[] {
  const interleaved: WarmTile[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      if (index < list.length) interleaved.push(list[index]);
    }
  }
  return interleaved;
}

/** The destination viewport from the predicted centre, halved per level. */
function destinationBounds(
  map: TilePrefetchMap,
  destination: Destination,
  zoom: number,
): { west: number; south: number; east: number; north: number } | null {
  const canvas = map.getCanvas();
  if (!canvas?.clientWidth || !canvas.clientHeight) return null;
  const bounds = map.getBounds();
  const current = {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };

  return viewportBoundsForCenter(current, destination.lng, destination.lat, map.getZoom(), zoom);
}

/** Visible source ids whose loads promote matching speculative jobs. */
function visibleIds(current: ContourPrefetchPlan, wiring: TilePrefetchWiring): readonly string[] {
  return [wiring.reliefSourceId, current.sourceId, wiring.basemapSourceId];
}

function sameBasemap(left: BasemapDescriptor | null, right: BasemapDescriptor | null): boolean {
  return left?.template === right?.template && left?.maxzoom === right?.maxzoom;
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

/** The protocol options a warmed trace shares with the visible source cache entries. */
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

/** Stable tile key for coverage comparisons. */
export function tileKey(tile: WarmTile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** Measured bytes from a completed body, falling back to the reservation estimate. */
function measuredBytes(data: unknown, estimated: number): number {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  const body = (data as { arrayBuffer?: unknown; data?: unknown } | null)?.arrayBuffer
    ?? (data as { data?: unknown } | null)?.data;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return estimated;
}

/** Whether an HTTP failure is a missing ocean tile that should not warm again. */
function isMissingResponse(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";

  return message.includes("Bad response: 404");
}

/** The dev-stats telemetry used outside tests. */
function defaultTelemetry(): PrefetchTelemetry {
  return {
    hit: (source) => noteSpeculativeHit(source),
    miss: (source) => noteSpeculativeMiss(source),
    wasted: (source) => noteSpeculativeWasted(source),
  };
}
