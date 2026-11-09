/**
 * The shade worker's bounded job queue and ref-counted DEM cache, with no worker globals so
 * tests can drive the slow-load, eviction and cancellation paths directly.
 */

/** Decoded DEM heights in metres row by row, or null when the tile does not exist. */
export type DemHeights = Float32Array | null;

/** Fetch and decode one DEM tile, stopping early when its signal aborts. */
export type FetchDemHeights = (url: string, signal: AbortSignal) => Promise<DemHeights>;

/** Decoded DEM tiles the worker keeps between jobs; each holds about 1 MiB. */
export const DEM_CACHE_TILES = 24;

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
