import * as zarr from "zarrita";

import {
  LOOKAHEAD_MIN,
  PRIME_STEPS,
  READS_IN_FLIGHT_PAUSED,
  READS_IN_FLIGHT_PLAYING,
} from "./playback";
import type { ArrayDoc, LayerDoc } from "./types";

/** An opened bundle store, as returned by openStore. */
export type Store = Awaited<ReturnType<typeof openStore>>;

type OpenedArray = Awaited<ReturnType<typeof openArray>>;

type FetchOptions = Parameters<zarr.AsyncReadable["get"]>[1];

type StepSlices = ArrayLike<number> & { subarray(start: number, end: number): ArrayLike<number> };

type Encoding = Pick<ArrayDoc, "scale_factor" | "add_offset" | "fill">;

export const STEP_CACHE_BYTES = 32 * 1024 * 1024;
export const STEP_CACHE_MAX = 48;
const NORMAL_READ_STEPS = 2; // cache entries kept free for the shown and the incoming step
const MIN_CACHE_STEPS = LOOKAHEAD_MIN + NORMAL_READ_STEPS;

export const BATCH_MAX_STEPS = 12; // one shard of a time series holds this many steps
const REQUEST_MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_GAP_BYTES = 64 * 1024; // chunks closer than this share one request

// An opened array keeps the shard indexes it has read, so it is opened once per path.
const openedArrays = new WeakMap<object, Map<string, Promise<OpenedArray>>>();

/** Opens a bundle's Zarr v3 store; suffix ranges read a shard index without a HEAD first. */
export function openStore(href: string) {
  return bundleStore(new zarr.FetchStore(href, { useSuffixRequest: true }));
}

/** Wraps a fetching store so chunk reads of the same tick share requests. */
export function bundleStore(fetching: zarr.AsyncReadable) {
  const merging = mergingStore(fetching);
  return zarr.withMaybeConsolidatedMetadata(merging, { format: "v3" });
}

/** Reads a selection of one array from the bundle's Zarr store. */
export async function readArray(store: Store, path: string, selection: (number | null)[]) {
  const array = await openedArray(store, path);
  const chunk = await zarr.get(array, selection);
  return chunk.data as ArrayLike<number>;
}

/** Reads consecutive steps of a time series, one array per step, in as few requests as possible. */
export async function readSteps(store: Store, path: string, first: number, count: number) {
  const array = await openedArray(store, path);
  const chunk = await zarr.get(array, [zarr.slice(first, first + count), null, null]);
  const values = chunk.data as unknown as StepSlices;
  const size = values.length / count;

  return Array.from({ length: count }, (_, offset) => {
    return values.subarray(offset * size, (offset + 1) * size);
  });
}

/** Reads the layer's whole inside-the-area mask. */
export async function readMask(store: Store, layer: LayerDoc) {
  const raw = await readArray(store, layer.mask.path, [null, null]);
  return Uint8Array.from(raw, (value) => value === 1 ? 1 : 0);
}

/** The layer's array for a role; throws when the layer has none. */
export function arrayDoc(layer: LayerDoc, role: string) {
  const doc = layer.arrays[role];
  if (!doc) throw new Error(`Layer "${layer.id}" has no "${role}" array`);

  return doc;
}

/** Applies scale factor and offset; fill values become NaN. */
export function decode(raw: ArrayLike<number>, doc: Encoding) {
  const values = new Float32Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    const isFill = raw[index] === doc.fill;
    values[index] = isFill ? NaN : raw[index] * doc.scale_factor + doc.add_offset;
  }
  return values;
}

/**
 * Steps a layer keeps decoded, sized by bytes so large grids stay small. Even a grid too large for
 * the budget keeps the entries the shown step, the incoming step and a minimal lookahead need.
 */
export function stepCacheLimit(nx: number, ny: number): number {
  if (!(nx > 0) || !(ny > 0)) return STEP_CACHE_MAX;

  const bytesPerStep = nx * ny * 4;
  const fitting = Math.floor(STEP_CACHE_BYTES / bytesPerStep);

  return Math.min(Math.max(fitting, MIN_CACHE_STEPS), STEP_CACHE_MAX);
}

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
  const cache = cacheByIndex(
    cacheLimit,
    (step, isHeld) => loader.enqueue(step, isHeld),
  );

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
  let capacity = limit;

  const evict = (inserted: number) => {
    while (held.size > Math.max(capacity - 2, 0)) held.delete(held.values().next().value!);
    while (entries.size > capacity) {
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

    resize(next: number) {
      capacity = next;
      evict(-1);
    },

    release() {
      held.clear();
    },
  };
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

/** A caller's byte range of a shard, settled with exactly those bytes. */
interface WantedRange {
  offset: number;
  length: number;
  resolve(bytes: Uint8Array | undefined): void;
  reject(error: unknown): void;
}

interface RangeGroup {
  start: number;
  end: number;
  wanted: WantedRange[];
}

/**
 * Lets the byte ranges asked for one shard in the same tick travel in one covering request, which
 * matters because every request costs a round trip and a bill. Reads that are not byte ranges
 * pass through unchanged.
 */
export function mergingStore(
  fetching: zarr.AsyncReadable,
  maxBytes = REQUEST_MAX_BYTES,
): zarr.AsyncReadable {
  const getRange = fetching.getRange!.bind(fetching);
  const waiting = new Map<string, WantedRange[]>();

  const flush = (key: zarr.AbsolutePath, options: FetchOptions) => {
    const wanted = waiting.get(key)!;
    waiting.delete(key);
    for (const group of groupRanges(wanted, maxBytes)) {
      void fetchGroup(getRange, key, group, options);
    }
  };

  return {
    get(key, options) {
      return fetching.get(key, options);
    },
    getRange(key, range, options) {
      if (!("offset" in range)) {
        return getRange(key, range, options);
      }

      return new Promise((resolve, reject) => {
        const wanted = { offset: range.offset, length: range.length, resolve, reject };
        const existing = waiting.get(key);
        if (existing) {
          existing.push(wanted);
          return;
        }

        waiting.set(key, [wanted]);
        setTimeout(() => flush(key, options), 0);
      });
    },
  };
}

/** Joins ranges that touch or nearly touch while a covering request stays under the byte cap. */
function groupRanges(wanted: WantedRange[], maxBytes: number): RangeGroup[] {
  const groups: RangeGroup[] = [];
  const byOffset = [...wanted].sort((first, second) => first.offset - second.offset);
  for (const range of byOffset) {
    const end = range.offset + range.length;
    const group = groups.at(-1);
    const isNear = group !== undefined && range.offset - group.end <= REQUEST_GAP_BYTES;
    if (group && isNear && Math.max(end, group.end) - group.start <= maxBytes) {
      group.end = Math.max(end, group.end);
      group.wanted.push(range);
    } else {
      groups.push({ start: range.offset, end, wanted: [range] });
    }
  }
  return groups;
}

async function fetchGroup(
  getRange: NonNullable<zarr.AsyncReadable["getRange"]>,
  key: zarr.AbsolutePath,
  group: RangeGroup,
  options: FetchOptions,
) {
  const length = group.end - group.start;
  try {
    const bytes = await getRange(key, { offset: group.start, length }, options);
    for (const range of group.wanted) {
      // A copy keeps the bytes aligned at the start of their own buffer for the codecs.
      const from = range.offset - group.start;
      range.resolve(bytes?.slice(from, from + range.length));
    }
  } catch (error) {
    group.wanted.forEach((range) => range.reject(error));
  }
}

function openedArray(store: Store, path: string) {
  const arrays = openedArrays.get(store) ?? new Map<string, Promise<OpenedArray>>();
  openedArrays.set(store, arrays);

  if (!arrays.has(path)) {
    const opening = openArray(store, path);
    // A failed open is dropped so it can be retried.
    opening.catch(() => arrays.delete(path));
    arrays.set(path, opening);
  }
  return arrays.get(path)!;
}

function openArray(store: Store, path: string) {
  return zarr.open.v3(zarr.root(store).resolve(path), { kind: "array" });
}
