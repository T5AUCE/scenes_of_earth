/**
 * The shade worker's bounded job queue and ref-counted DEM cache, with no worker globals so
 * tests can drive the slow-load, eviction and cancellation paths directly.
 */
import type { ShadeTileId } from "./shade-tile";

/** Decoded DEM heights in metres row by row, or null when the tile does not exist. */
export type DemHeights = Float32Array | null;

/** Fetch and decode one DEM tile, stopping early when its signal aborts. */
export type FetchDemHeights = (url: string, signal: AbortSignal) => Promise<DemHeights>;

/** Decoded DEM heights the worker keeps between jobs; 12 per worker, 24 across both lanes. */
export const DEM_CACHE_TILES = 12;

/** Shade jobs the worker runs at once; the rest wait in order until a lane frees or cancels. */
export const MAX_CONCURRENT_SHADE_JOBS = 4;

interface DemEntry {
  heights: Promise<DemHeights>;
  abort: AbortController;
  settled: boolean;
  owners: Set<number>;
}

/**
 * Share one DEM load between every shade job that needs it. A tile stays pinned while a job
 * owns it and only idle tiles are evicted, so the bound covers idle tiles instead of leaking
 * through active jobs, and a load aborts once its last owner lets go.
 */
export class DemCache {
  private readonly entries = new Map<string, DemEntry>();

  constructor(
    private readonly fetchHeights: FetchDemHeights,
    private readonly maxEntries: number = DEM_CACHE_TILES,
  ) {}

  /** Load one tile for an owner, sharing the in-flight or cached load when there is one. */
  load(url: string, owner: number): Promise<DemHeights> {
    const cached = this.entries.get(url);
    if (cached) {
      this.entries.delete(url);
      this.entries.set(url, cached);
      cached.owners.add(owner);
      return cached.heights;
    }

    const abort = new AbortController();
    const entry: DemEntry = {
      heights: Promise.resolve(null),
      abort,
      settled: false,
      owners: new Set([owner]),
    };
    entry.heights = this.fetchHeights(url, abort.signal).then(
      (heights) => {
        entry.settled = true;
        return heights;
      },
      (error: unknown) => {
        if (this.entries.get(url) === entry) this.entries.delete(url);
        throw error;
      },
    );
    this.entries.set(url, entry);
    this.evictIdle();
    return entry.heights;
  }

  /** Release one owner's pins, aborting unneeded loads and trimming idle tiles. */
  release(owner: number): void {
    for (const [url, entry] of this.entries) {
      if (!entry.owners.delete(owner)) continue;
      if (entry.owners.size === 0 && !entry.settled) {
        this.entries.delete(url);
        entry.abort.abort();
      }
    }
    this.evictIdle();
  }

  private evictIdle(): void {
    for (const [url, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry.owners.size === 0) this.entries.delete(url);
    }
  }
}

/**
 * Run at most a few shade jobs at once, queueing the rest in arrival order. A finished job
 * hands its lane to the longest-waiting one, while a queued job that cancels leaves silently.
 */
export class ShadeQueue {
  private running = 0;
  private readonly queued = new Map<number, () => void>();

  constructor(private readonly maxRunning: number = MAX_CONCURRENT_SHADE_JOBS) {}

  /** Start a job at once when a lane is free, else hold it until one frees or it cancels. */
  add(id: number, start: () => void): void {
    if (this.running < this.maxRunning) {
      this.running += 1;
      start();
    } else this.queued.set(id, start);
  }

  /** Free a lane for the longest-waiting job once a running job settles. */
  finish(): void {
    const next = this.queued.entries().next();
    if (next.done) {
      this.running -= 1;
      return;
    }
    this.queued.delete(next.value[0]);
    next.value[1]();
  }

  /** Drop a queued job before it starts; a running job keeps its lane until it settles. */
  cancel(id: number): boolean {
    return this.queued.delete(id);
  }
}

/** Shade workers the pool starts, one per lane so background work never blocks demand. */
export const SHADE_POOL_LANES = 2;

/** Visible tiles and slider re-shades, which must never wait behind preshading. */
export const DEMAND_SHADE_LANE = 0;

/** Pinned and ancestor preshading, which yields its lane on every strength change. */
export const BACKGROUND_SHADE_LANE = 1;

/** A message the pool routes to one lane; request ids stay unique across lanes. */
export type ShadePoolRequest =
  | { type: "shade"; id: number; tile: ShadeTileId; strength: number; demUrl: string }
  | { type: "cancel"; id: number };

/** A worker the pool starts lazily, matching the shade worker's message shape. */
export interface ShadeWorkerHandle {
  postMessage(message: ShadePoolRequest): void;
  terminate(): void;
  // Responses carry bitmaps the pool never reads, so the event stays untyped here.
  onmessage: ((event: MessageEvent<any>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/**
 * Run one shading worker per lane, so background preshading never queues behind a visible
 * tile or a slider re-shade. Lanes start on first use and restart after a lane fails, while
 * the client keeps matching answers to requests by id across every lane.
 */
export class ShadeWorkerPool {
  private readonly workers: (ShadeWorkerHandle | null)[];
  private readonly jobLane = new Map<number, number>();
  onresponse: ((response: unknown) => void) | null = null;
  onlaneerror: ((lane: number) => void) | null = null;

  constructor(
    private readonly createWorker: () => ShadeWorkerHandle,
    private readonly laneCount: number = SHADE_POOL_LANES,
  ) {
    this.workers = Array.from({ length: laneCount }, () => null);
  }

  /** Send a message on one lane, starting its worker when this is its first job. */
  send(lane: number, message: ShadePoolRequest): void {
    const worker = this.laneWorker(lane);
    this.jobLane.set(message.id, lane);
    worker.postMessage(message);
  }

  /** Forward a cancellation to whichever lane still holds the job, if any. */
  cancel(id: number): void {
    const lane = this.jobLane.get(id);
    if (lane === undefined) return;
    this.jobLane.delete(id);
    this.workers[lane]?.postMessage({ id, type: "cancel" });
  }

  /** Stop every lane and forget its jobs, so a scene exit frees both workers. */
  terminate(): void {
    for (let lane = 0; lane < this.workers.length; lane += 1) this.dropLane(lane);
    this.jobLane.clear();
  }

  /** Drop a failed lane so its next job restarts it; the client rejects what it owed. */
  dropLane(lane: number): void {
    this.workers[lane]?.terminate();
    this.workers[lane] = null;
    for (const [id, jobLane] of this.jobLane) {
      if (jobLane === lane) this.jobLane.delete(id);
    }
  }

  private laneWorker(lane: number): ShadeWorkerHandle {
    const running = this.workers[lane];
    if (running) return running;

    const worker = this.createWorker();
    worker.onmessage = (event) => {
      this.jobLane.delete(event.data.id);
      this.onresponse?.(event.data);
    };
    worker.onerror = () => {
      this.dropLane(lane);
      this.onlaneerror?.(lane);
    };
    this.workers[lane] = worker;
    return worker;
  }
}
