import * as zarr from "zarrita";

import { LOOKAHEAD_MIN } from "./playback";
import type { ArrayDoc, LayerDoc } from "./types";

/** An opened bundle store, as returned by openStore. */
export type Store = Awaited<ReturnType<typeof openStore>>;

type OpenedArray = Awaited<ReturnType<typeof openArray>>;

type Encoding = Pick<ArrayDoc, "scale_factor" | "add_offset" | "fill">;

export const STEP_CACHE_BYTES = 32 * 1024 * 1024;
export const STEP_CACHE_MAX = 48;
const READS_IN_FLIGHT = 2;

// An opened array keeps the shard indexes it has read, so it is opened once per path.
const openedArrays = new WeakMap<object, Map<string, Promise<OpenedArray>>>();

/** Opens a bundle's Zarr v3 store; suffix ranges read a shard index without a HEAD first. */
export function openStore(href: string) {
  const store = new zarr.FetchStore(href, { useSuffixRequest: true });
  return zarr.withMaybeConsolidatedMetadata(store, { format: "v3" });
}

/** Reads a selection of one array from the bundle's Zarr store. */
export async function readArray(store: Store, path: string, selection: (number | null)[]) {
  const array = await openedArray(store, path);
  const chunk = await zarr.get(array, selection);
  return chunk.data as ArrayLike<number>;
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

/** Steps a layer keeps decoded, sized by bytes so large grids stay small. */
export function stepCacheLimit(nx: number, ny: number, lookahead: number): number {
  if (!(nx > 0) || !(ny > 0)) return STEP_CACHE_MAX;

  const bytesPerStep = nx * ny * 4;
  const fitting = Math.floor(STEP_CACHE_BYTES / bytesPerStep);
  const minimum = lookahead + 2;

  return Math.min(Math.max(fitting, minimum), STEP_CACHE_MAX);
}

/** Decoded steps of one layer; every renderer of the layer shares one reader. */
export interface StepReader {
  /** Reads a step; a prefetch passes false so it queues behind what the map is drawing. */
  read(step: number, isUrgent?: boolean): Promise<Float32Array>;
  /** Keeps room for the steps the clock warms this many positions ahead. */
  keep(lookahead: number): void;
  /** Lets every prefetched step be evicted, because the clock no longer waits for them. */
  release(): void;
}

/** Reads steps through a cache and a queue that runs at most two reads at once. */
export function createStepReader(
  grid: { nx: number; ny: number },
  load: (step: number) => Promise<Float32Array>,
): StepReader {
  const queue = new ReadQueue(READS_IN_FLIGHT);
  const cache = cacheByIndex(
    stepCacheLimit(grid.nx, grid.ny, LOOKAHEAD_MIN),
    (step) => queue.run(step, () => load(step)),
  );

  return {
    read(step, isUrgent = true) {
      const loaded = cache.read(step, !isUrgent);
      if (isUrgent) queue.promote(step);
      return loaded;
    },
    keep(lookahead) {
      cache.resize(stepCacheLimit(grid.nx, grid.ny, lookahead));
    },
    release() {
      cache.release();
    },
  };
}

/**
 * Keeps the most recently used results. A held result is one a prefetch warmed for the clock; it
 * outlasts unheld results until a normal read takes it. Holds are limited so that two entries
 * always stay free for normal reads, which lets abandoned holds give way to newer ones. A failed
 * load is dropped so it can be retried.
 */
export function cacheByIndex<T>(limit: number, load: (index: number) => Promise<T>) {
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
        entry = load(index);
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

/** Runs queued reads in order with a cap on how many are in flight. */
class ReadQueue {
  private active = 0;
  private readonly waiting: { key: number; start: () => void }[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  run<T>(key: number, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.waiting.shift()?.start();
          });
      };
      if (this.active < this.limit) start();
      else this.waiting.push({ key, start });
    });
  }

  /** Moves a waiting read to the front because the map now needs it. */
  promote(key: number) {
    const index = this.waiting.findIndex((read) => read.key === key);
    if (index > 0) this.waiting.unshift(...this.waiting.splice(index, 1));
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
