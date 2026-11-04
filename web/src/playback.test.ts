import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { cacheByIndex, createStepReader, stepCacheLimit } from "./data.ts";
import {
  labelIndexFor,
  loadPlaySpeed,
  lookaheadFor,
  loopMsFor,
  PLAY_SPEED_KEY,
  playheadAt,
  rescalePosition,
  stepMsFor,
  storePlaySpeed,
} from "./playback.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("a 12-step series paces to an 18 s loop", () => {
  assert.equal(stepMsFor(12, 1), 1500);
});

test("a 76-step series paces near 237 ms a step", () => {
  assert.ok(Math.abs(stepMsFor(76, 1) - 18000 / 76) < 1);
});

test("a 312-step series clamps to the fastest cruise", () => {
  assert.equal(stepMsFor(312, 1), 150);
});

test("speed scales the cruise while the 60 ms floor holds", () => {
  assert.equal(stepMsFor(12, 2), 750);
  assert.equal(stepMsFor(12, 0.5), 3000);
  assert.equal(stepMsFor(312, 4), 60);
});

test("lookahead covers two seconds of play", () => {
  assert.equal(lookaheadFor(1500), 2);
  assert.equal(lookaheadFor(237), 9);
  assert.equal(lookaheadFor(150), 12);
});

test("the playhead holds the step before fading", () => {
  const stepMs = 1000;
  assert.deepEqual(playheadAt(100, stepMs, 4), { index: 0, next: 1, mix: 0 });
  assert.deepEqual(playheadAt(499, stepMs, 4).mix, 0);
});

test("the fade midpoint weighs both steps equally", () => {
  const stepMs = 1000;
  const frame = playheadAt(750, stepMs, 4);

  assert.equal(frame.index, 0);
  assert.equal(frame.next, 1);
  assert.equal(frame.mix, 0.5);
  assert.equal(labelIndexFor(frame), 1);
});

test("the label stays behind until the fade midpoint", () => {
  const stepMs = 1000;
  assert.equal(labelIndexFor(playheadAt(600, stepMs, 4)), 0);
  assert.equal(labelIndexFor(playheadAt(900, stepMs, 4)), 1);
});

test("the last step holds longer then cuts without fading", () => {
  const stepMs = 400;
  const count = 3;
  const lastStart = (count - 1) * stepMs;

  assert.deepEqual(playheadAt(lastStart + 100, stepMs, count), {
    index: 2,
    next: 0,
    mix: 0,
  });
  assert.deepEqual(playheadAt(lastStart + 999, stepMs, count).index, 2);
  assert.deepEqual(playheadAt(lastStart + 1000, stepMs, count), {
    index: 0,
    next: 1,
    mix: 0,
  });
});

test("reduced motion never fades", () => {
  const frame = playheadAt(750, 1000, 4, true);

  assert.deepEqual(frame, { index: 0, next: 1, mix: 0 });
  assert.equal(labelIndexFor(frame), 0);
});

test("a tiny grid keeps the full cache while a huge one shrinks by bytes", () => {
  assert.equal(stepCacheLimit(10, 10, 2), 48);
  assert.equal(stepCacheLimit(800, 800, 9), 13);
  assert.equal(stepCacheLimit(800, 800, 12), 14);
});

test("a 76-step 800 by 800 layer at 4x keeps room for the 12-step lookahead", () => {
  const lookahead = lookaheadFor(stepMsFor(76, 4));

  assert.equal(lookahead, 12);
  assert.equal(stepCacheLimit(800, 800, lookahead), 14);
});

test("shrinking the cache drops the oldest steps", async () => {
  const loaded: number[] = [];
  const cache = cacheByIndex(
    3,
    async (index) => {
      loaded.push(index);
    },
  );
  [0, 1, 2].forEach((index) => cache.read(index));

  cache.resize(2);
  cache.read(0);
  cache.read(2);

  assert.deepEqual(loaded, [0, 1, 2, 0]);
});

test("a warmed step outlasts drawn steps until the map reads it", async () => {
  const loaded: number[] = [];
  const cache = cacheByIndex(
    4,
    async (index) => {
      loaded.push(index);
    },
  );
  cache.read(1, true);
  [0, 2, 3, 4, 5].forEach((index) => cache.read(index));

  cache.read(1);

  assert.deepEqual(loaded, [1, 0, 2, 3, 4, 5]);
});

test("holds left behind by a pause give way so normal reads load once", async () => {
  const loads = new Map<number, number>();
  const cache = cacheByIndex(
    3,
    async (index) => {
      loads.set(index, (loads.get(index) ?? 0) + 1);
    },
  );
  [1, 2, 3].forEach((index) => cache.read(index, true));

  [20, 21, 22, 23].forEach((index) => {
    cache.read(index);
    cache.read(index);
  });

  assert.deepEqual([20, 21, 22, 23].map((index) => loads.get(index)), [1, 1, 1, 1]);
});

test("releasing holds makes abandoned prefetches evictable at once", async () => {
  const loaded: number[] = [];
  const cache = cacheByIndex(
    4,
    async (index) => {
      loaded.push(index);
    },
  );
  [1, 2].forEach((index) => cache.read(index, true));
  cache.release();

  [3, 4, 5].forEach((index) => cache.read(index));
  [1, 2].forEach((index) => cache.read(index));

  assert.deepEqual(loaded, [1, 2, 3, 4, 5, 1, 2]);
});

test("a read never evicts the entry it just inserted", async () => {
  const loaded: number[] = [];
  const cache = cacheByIndex(
    1,
    async (index) => {
      loaded.push(index);
    },
  );

  cache.read(1);
  cache.read(2);
  cache.read(2);

  assert.deepEqual(loaded, [1, 2]);
});

test("reads from draws, blends and prepares share two slots", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load);

  const drawn = reader.read(0);
  const warmed = [1, 2, 3, 4].map((step) => reader.read(step, false));
  assert.deepEqual(reads.started, [0, 1]);

  reads.finish(0);
  await drawn;
  await flush();
  assert.deepEqual(reads.started, [0, 1, 2]);
  assert.equal(reads.peak, 2);

  for (const step of [1, 2, 3, 4]) {
    reads.finish(step);
    await flush();
  }
  await Promise.all(warmed);
  assert.deepEqual(reads.started, [0, 1, 2, 3, 4]);
  assert.equal(reads.peak, 2);
});

test("a waiting step the map needs jumps ahead of other prefetches", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load);
  reader.read(0, false);
  reader.read(1, false);
  reader.read(2, false);
  reader.read(3, false);

  const drawn = reader.read(3);
  reads.finish(0);
  await flush();

  assert.deepEqual(reads.started, [0, 1, 3]);
  reads.finish(3);
  await drawn;
});

test("a failed read frees its slot for the next one", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load);
  const failing = [0, 1].map((step) => reader.read(step, false).catch(() => "failed"));
  reader.read(2, false);

  reads.fail(0);
  await failing[0];
  await flush();

  assert.deepEqual(reads.started, [0, 1, 2]);
});

test("moving to another speed keeps the place in the step", () => {
  assert.equal(rescalePosition(600, 1500, 750, 3), 300);
  assert.equal(rescalePosition(0, 1500, 750, 3), 0);
});

test("a speed change in the last hold keeps its share of the hold", () => {
  const stepMs = 1500;
  const hold = loopMsFor(stepMs, 3) - 2 * stepMs;

  assert.equal(hold, 1500);
  assert.equal(rescalePosition(2 * stepMs + 750, stepMs, 750, 3), 2 * 750 + 750 * (1000 / 1500));
});

test("a blocked store keeps the default speed without throwing", () => {
  useStorage({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });

  assert.equal(loadPlaySpeed(), 1);
  storePlaySpeed(2);
  assert.equal(loadPlaySpeed(), 1);
});

test("the remembered speed survives for the next visit", () => {
  const items = useStorage();

  storePlaySpeed(4);
  assert.equal(items.get(PLAY_SPEED_KEY), "4");
  assert.equal(loadPlaySpeed(), 4);
});

function useStorage(overrides: object = {}) {
  const items = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
      ...overrides,
    },
  });
  return items;
}

function fakeReads() {
  const waiting = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const reads = {
    started: [] as number[],
    active: 0,
    peak: 0,
    load(step: number) {
      reads.started.push(step);
      reads.active += 1;
      reads.peak = Math.max(reads.peak, reads.active);
      return new Promise<Float32Array>((resolve, reject) => {
        waiting.set(step, {
          resolve: () => {
            reads.active -= 1;
            resolve(new Float32Array(1));
          },
          reject: (error) => {
            reads.active -= 1;
            reject(error);
          },
        });
      });
    },
    finish(step: number) {
      waiting.get(step)?.resolve();
    },
    fail(step: number) {
      waiting.get(step)?.reject(new Error("failed"));
    },
  };
  return reads;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
