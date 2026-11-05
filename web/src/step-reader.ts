/** Decoded step reads of one layer through a byte-sized cache and a queue of reads in flight. */
import {
  LOOKAHEAD_MIN,
  PRIME_STEPS,
  READS_IN_FLIGHT_PAUSED,
  READS_IN_FLIGHT_PLAYING,
} from "./playback";

export const STEP_CACHE_BYTES = 32 * 1024 * 1024;
export const STEP_CACHE_MAX = 48;
const NORMAL_READ_STEPS = 2; // cache entries kept free for the shown and the incoming step
const MIN_CACHE_STEPS = LOOKAHEAD_MIN + NORMAL_READ_STEPS;

export const BATCH_MAX_STEPS = 12; // one shard of a time series holds this many steps

/** Decoded steps of one layer; every renderer of the layer shares one reader. */
export interface StepReader {
  /** Reads a step; a prefetch passes false so it queues behind what the map is drawing. */
  read(step: number, isUrgent?: boolean): Promise<Float32Array>;
  /** Warms the steps just after one that was drawn, up to the series' last step. */
  prime(drawn: number, lastStep: number): void;
  /** How many positions ahead the cache can hold without evicting the steps the clock awaits. */
  maxLookahead(): number;
  /** Lets every prefetched step be evicted, because the clock no longer waits for them. */
  release(): void;
  /** Allows more reads at once while the clock plays, and fewer again when it stops. */
  setPlaying(isPlaying: boolean): void;
}

/** Decodes `count` consecutive steps from `first` with one read. */
export type LoadSteps = (first: number, count: number) => Promise<Float32Array[]>;

/**
 * Reads steps through a cache and a queue whose reads in flight depend on playing or not. With
 * `loadSteps`, queued prefetches of consecutive steps join the read of the first one.
 */
export function createStepReader(
  grid: { nx: number; ny: number },
  load: (step: number) => Promise<Float32Array>,
  loadSteps?: LoadSteps,
): StepReader {
  const loader = new StepLoader(load, loadSteps);
  const cacheLimit = stepCacheLimit(grid.nx, grid.ny);
  const cache = cacheByIndex(cacheLimit, (step, isHeld) => loader.enqueue(step, isHeld));

  return {
    read(step, isUrgent = true) {
      const loaded = cache.read(step, !isUrgent);
      if (isUrgent) loader.queue.promote(step);
      return loaded;
    },
    prime(drawn, lastStep) {
      const last = Math.min(drawn + PRIME_STEPS, lastStep);
      for (let step = drawn + 1; step <= last; step++) {
        cache.read(step, true).catch(() => {});
      }
    },
    maxLookahead() {
      return cacheLimit - NORMAL_READ_STEPS;
    },
    release() {
      cache.release();
    },
    setPlaying(isPlaying) {
      loader.queue.setLimit(isPlaying ? READS_IN_FLIGHT_PLAYING : READS_IN_FLIGHT_PAUSED);
    },
  };
}

/** Queues step reads and lets waiting prefetches ride along with the read that starts first. */
class StepLoader {
  readonly queue = new ReadQueue(READS_IN_FLIGHT_PAUSED);
  private readonly load: (step: number) => Promise<Float32Array>;
  private readonly loadSteps: LoadSteps | undefined;

  constructor(load: (step: number) => Promise<Float32Array>, loadSteps: LoadSteps | undefined) {
    this.load = load;
    this.loadSteps = loadSteps;
  }

  enqueue(step: number, isHeld: boolean): Promise<Float32Array> {
    // An urgent draw reads alone so it never waits for the steps of a larger read.
    const isBatchable = isHeld && this.loadSteps !== undefined;

    return this.queue.run(step, (canBatch) => this.read(step, canBatch), isBatchable);
  }

  private async read(step: number, canBatch: boolean): Promise<Float32Array> {
    const joined = canBatch ? this.queue.takeFollowers(step, BATCH_MAX_STEPS - 1) : [];
    const stepCount = joined.length + 1;

    try {
      if (stepCount === 1) return await this.load(step);

      const arrays = await this.loadSteps!(step, stepCount);
      joined.forEach((read, index) => read.resolve(arrays[index + 1]));
      return arrays[0];
    } catch (error) {
      joined.forEach((read) => read.reject(error));
      throw error;
    }
  }
}

interface WaitingRead {
  key: number;
  isBatchable: boolean;
  start(): void;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Runs queued reads in order with a cap on how many are in flight. */
class ReadQueue {
  private active = 0;
  private readonly waiting: WaitingRead[] = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Runs the task when a slot is free. A batchable read waits one microtask first, so reads queued
   * in the same pass are all waiting when the first one starts and can join it.
   */
  run<T>(
    key: number,
    task: (isBatchable: boolean) => Promise<T>,
    isBatchable = false,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const read: WaitingRead = {
        key,
        isBatchable,
        resolve,
        reject,
        start: () => {
          this.active++;
          task(read.isBatchable)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.startWaiting();
            });
        },
      };
      if (isBatchable) {
        this.waiting.push(read);
        queueMicrotask(() => this.startWaiting());
      } else if (this.active < this.limit) {
        read.start();
      } else {
        this.waiting.push(read);
      }
    });
  }

  private startWaiting() {
    while (this.active < this.limit && this.waiting.length > 0) this.waiting.shift()!.start();
  }

  /** Starts waiting reads at once when the limit grows; running reads are never cut short. */
  setLimit(limit: number) {
    this.limit = limit;
    this.startWaiting();
  }

  /** Moves a waiting read to the front and keeps it alone, because the map now needs it. */
  promote(key: number) {
    const index = this.waiting.findIndex((read) => read.key === key);
    if (index < 0) return;

    const [read] = this.waiting.splice(index, 1);
    read.isBatchable = false;
    this.waiting.unshift(read);
  }

  /** Takes the batchable reads waiting for the steps right after `key`; the caller settles them. */
  takeFollowers(key: number, limit: number): WaitingRead[] {
    const taken: WaitingRead[] = [];
    while (taken.length < limit) {
      const next = key + taken.length + 1;
      const index = this.waiting.findIndex((read) => read.key === next && read.isBatchable);
      if (index < 0) break;

      taken.push(...this.waiting.splice(index, 1));
    }
    return taken;
  }
}

/**
 * Steps a layer keeps decoded, sized by bytes so large grids stay small. Even a grid too large for
 * the budget keeps the entries the shown step, the incoming step and a minimal lookahead need.
 */
export function stepCacheLimit(nx: number, ny: number): number {
  if (!(nx > 0) || !(ny > 0)) return STEP_CACHE_MAX;

  const bytesPerStep = nx * ny * Float32Array.BYTES_PER_ELEMENT;
  const fitting = Math.floor(STEP_CACHE_BYTES / bytesPerStep);

  return Math.min(Math.max(fitting, MIN_CACHE_STEPS), STEP_CACHE_MAX);
}

/**
 * Keeps the most recently used results. A held result is one a prefetch warmed for the clock; it
 * outlasts unheld results until a normal read takes it. Holds are limited so that two entries
 * always stay free for normal reads, which lets abandoned holds give way to newer ones. A failed
 * load is dropped so it can be retried.
 */
export function cacheByIndex<T>(
  limit: number,
  load: (index: number, isHeld: boolean) => Promise<T>,
) {
  const entries = new Map<number, Promise<T>>();
  const held = new Set<number>();

  const evict = (inserted: number) => {
    const maxHeld = Math.max(limit - NORMAL_READ_STEPS, 0);
    while (held.size > maxHeld) held.delete(held.values().next().value!);
    while (entries.size > limit) {
      const candidates = [...entries.keys()].filter((index) => index !== inserted);
      const victim = candidates.find((index) => !held.has(index)) ?? candidates[0];
      entries.delete(victim);
      held.delete(victim);
    }
  };

  return {
    read(index: number, isHeld = false) {
      let entry = entries.get(index);
      if (entry) {
        entries.delete(index);
      } else {
        entry = load(index, isHeld);
        entry.catch(() => {
          entries.delete(index);
          held.delete(index);
        });
      }

      entries.set(index, entry);
      held.delete(index);
      if (isHeld) held.add(index);
      evict(index);

      return entry;
    },

    release() {
      held.clear();
    },
  };
}
