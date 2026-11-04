import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { AsyncReadable } from "zarrita";

import {
  BATCH_MAX_STEPS,
  cacheByIndex,
  createStepReader,
  mergingStore,
  STEP_CACHE_BYTES,
  stepCacheLimit,
} from "./data.ts";
import {
  crossfadeOpacities,
  ImageCrossfade,
  labelIndexFor,
  LoadMeter,
  loadPlaySpeed,
  lookaheadFor,
  loopMsFor,
  PLAY_SPEED_KEY,
  playheadAt,
  PRIME_STEPS,
  READS_IN_FLIGHT_PAUSED,
  READS_IN_FLIGHT_PLAYING,
  rescalePosition,
  stepMsFor,
  storePlaySpeed,
  sustainedStepMs,
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

test("lookahead covers three seconds of play", () => {
  assert.equal(lookaheadFor(1500), 2);
  assert.equal(lookaheadFor(237), 13);
  assert.equal(lookaheadFor(150), 20);
  assert.equal(lookaheadFor(60), 24);
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
  assert.equal(stepCacheLimit(10, 10), 48);
  assert.equal(stepCacheLimit(800, 800), 13);
});

test("a grid too large for the budget still keeps the minimum for play", () => {
  assert.equal(stepCacheLimit(4000, 4000), 4);
});

test("a 76-step 800 by 800 layer at 4x stays inside the byte budget", () => {
  const reader = createStepReader({ nx: 800, ny: 800 }, async () => new Float32Array(1));
  const wanted = lookaheadFor(stepMsFor(76, 4));
  const effective = Math.min(wanted, reader.maxLookahead());
  const cachedBytes = (effective + 2) * 800 * 800 * 4;

  assert.equal(wanted, 24);
  assert.equal(effective, 11);
  assert.ok(cachedBytes <= STEP_CACHE_BYTES);
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

test("playing raises the reads in flight and pausing lowers them again", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load);
  const steps = Array.from({ length: 8 }, (_, step) => step);

  steps.slice(0, 5).forEach((step) => reader.read(step, false));
  assert.equal(reads.active, READS_IN_FLIGHT_PAUSED);

  reader.setPlaying(true);
  assert.equal(reads.active, READS_IN_FLIGHT_PLAYING);

  reader.setPlaying(false);
  steps.slice(5).forEach((step) => reader.read(step, false));
  reads.finish(0);
  await flush();
  assert.equal(reads.active, READS_IN_FLIGHT_PLAYING - 1);
  assert.equal(reads.peak, READS_IN_FLIGHT_PLAYING);

  [1, 2, 3].forEach((step) => reads.finish(step));
  await flush();
  assert.equal(reads.active, READS_IN_FLIGHT_PAUSED);
});

test("while playing a step the map needs still jumps the queue", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load);
  reader.setPlaying(true);
  [0, 1, 2, 3, 4, 5, 6].forEach((step) => reader.read(step, false));

  const drawn = reader.read(6);
  reads.finish(0);
  await flush();

  assert.deepEqual(reads.started, [0, 1, 2, 3, 6]);
  reads.finish(6);
  await drawn;
});

test("priming warms the steps after a draw and stops at the last step", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load);

  reader.prime(3, 10);
  assert.deepEqual(reads.started, [4, 5].slice(0, PRIME_STEPS));

  reader.prime(9, 10);
  [4, 5].forEach((step) => reads.finish(step));
  await flush();
  assert.deepEqual(reads.started, [4, 5, 10]);
});

test("a cap of four nearly removes the stalls of a cap of two", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const twoSlots = await simulatedStallMs(false, context.mock.timers);
  const fourSlots = await simulatedStallMs(true, context.mock.timers);

  assert.ok(twoSlots > 200, `two slots stalled only ${twoSlots} ms`);
  assert.ok(fourSlots < 50, `four slots stalled ${fourSlots} ms`);
});

const SIMULATED_STEPS = 44;
const SIMULATED_STEP_MS = 60;
const SIMULATED_LOOKAHEAD = 12;

/** Plays a cold series at 60 ms a step through slow reads on a virtual clock; sums the stalls. */
async function simulatedStallMs(isPlaying: boolean, timers: { tick(ms: number): void }) {
  const ready = new Set<number>();
  const reader = createStepReader({ nx: 10, ny: 10 }, async (step) => {
    const latencyMs = step % 2 === 0 ? 120 : 150;
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    ready.add(step);
    return new Float32Array(1);
  });
  reader.setPlaying(isPlaying);
  const warm = (shown: number) => {
    const last = Math.min(shown + SIMULATED_LOOKAHEAD, SIMULATED_STEPS - 1);
    for (let step = shown + 1; step <= last; step++) void reader.read(step, false);
  };
  const advanceOneMs = async () => {
    timers.tick(1);
    await flush();
  };

  warm(0);
  while (!ready.has(1)) await advanceOneMs();

  let shown = 1;
  let stallMs = 0;
  let waitedMs = SIMULATED_STEP_MS;
  while (shown < SIMULATED_STEPS - 1) {
    await advanceOneMs();
    waitedMs--;
    if (waitedMs > 0) continue;
    if (!ready.has(shown + 1)) {
      stallMs++;
      continue;
    }

    shown++;
    waitedMs = SIMULATED_STEP_MS;
    warm(shown);
  }
  return stallMs;
}

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

test("one tick of ranges makes one request and each caller gets its bytes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = rangeSource();
  const store = mergingStore(source.store);

  const asked = [
    store.getRange!("/a", { offset: 10, length: 5 }),
    store.getRange!("/a", { offset: 15, length: 5 }),
    store.getRange!("/a", { offset: 40, length: 4 }),
  ];
  context.mock.timers.tick(1);
  const parts = await Promise.all(asked);

  assert.deepEqual(source.requests, [{ key: "/a", offset: 10, length: 34 }]);
  assert.deepEqual(parts.map((part) => [...part!]), [
    [10, 11, 12, 13, 14],
    [15, 16, 17, 18, 19],
    [40, 41, 42, 43],
  ]);
});

test("ranges asked in different ticks or for different shards are not merged", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = rangeSource();
  const store = mergingStore(source.store);

  const first = [
    store.getRange!("/a", { offset: 0, length: 4 }),
    store.getRange!("/b", { offset: 4, length: 4 }),
  ];
  context.mock.timers.tick(1);
  await Promise.all(first);
  const later = store.getRange!("/a", { offset: 4, length: 4 });
  context.mock.timers.tick(1);
  await later;

  assert.deepEqual(source.requests.map(({ key }) => key), ["/a", "/b", "/a"]);
});

test("the byte cap and a wide gap split a merge", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = rangeSource();
  const store = mergingStore(source.store, 20);

  const asked = [0, 10, 20, 200000].map((offset) => {
    return store.getRange!("/a", { offset, length: 10 });
  });
  context.mock.timers.tick(1);
  const parts = await Promise.all(asked);

  assert.deepEqual(source.requests, [
    { key: "/a", offset: 0, length: 20 },
    { key: "/a", offset: 20, length: 10 },
    { key: "/a", offset: 200000, length: 10 },
  ]);
  assert.deepEqual(parts.map((part) => part![0]), [0, 10, 20, 200000 % 256]);
});

test("a suffix read passes through and a failed merge fails every caller", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = rangeSource();
  const store = mergingStore(source.store);

  const tail = await store.getRange!("/a", { suffixLength: 3 });
  assert.deepEqual([...tail!], [299997, 299998, 299999].map((index) => index % 256));

  source.failNext();
  const asked = [0, 4].map((offset) => store.getRange!("/a", { offset, length: 4 }));
  const outcomes = asked.map((request) => request.then(() => "ok", () => "failed"));
  context.mock.timers.tick(1);

  assert.deepEqual(await Promise.all(outcomes), ["failed", "failed"]);
});

test("queued prefetches of consecutive steps share one read and keep their own step", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load, reads.loadSteps);
  reader.setPlaying(true);

  const loaded = [1, 2, 3, 4, 5, 6, 7, 8].map((step) => reader.read(step, false));
  await flush();

  assert.deepEqual(reads.batches, [[1, 8]]);
  assert.deepEqual(reads.started, []);
  const values = await Promise.all(loaded);
  assert.deepEqual(values.map((step) => step[0]), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a shared read stops at one shard of steps", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load, reads.loadSteps);
  reader.setPlaying(true);

  const steps = Array.from({ length: 2 * BATCH_MAX_STEPS + 5 }, (_, index) => index + 1);
  const loaded = steps.map((step) => reader.read(step, false));
  await flush();
  await Promise.all(loaded);

  assert.deepEqual(reads.batches, [
    [1, BATCH_MAX_STEPS],
    [1 + BATCH_MAX_STEPS, BATCH_MAX_STEPS],
    [1 + 2 * BATCH_MAX_STEPS, 5],
  ]);
});

test("an urgent step waiting behind prefetches is read alone and goes first", async () => {
  const reads = fakeReads();
  let openGate!: () => void;
  reads.batchGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load, reads.loadSteps);
  [1, 2, 3, 10, 20, 21, 22].forEach((step) => void reader.read(step, false));
  await flush();
  assert.deepEqual(reads.batches, [[1, 3]]);
  assert.deepEqual(reads.started, [10]);

  const drawn = reader.read(21);
  reads.finish(10);
  await flush();

  assert.deepEqual(reads.started, [10, 21]);
  reads.finish(21);
  assert.equal((await drawn)[0], 21);
  openGate();
  await flush();
  assert.deepEqual(reads.batches, [[1, 3]]);
  assert.deepEqual(reads.started, [10, 21, 20, 22]);
});

test("an urgent step inside a shared read waits for it instead of repeating it", async () => {
  const reads = fakeReads();
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load, reads.loadSteps);
  [1, 2, 3].forEach((step) => void reader.read(step, false));
  await flush();

  const drawn = await reader.read(2);

  assert.equal(drawn[0], 2);
  assert.deepEqual(reads.batches, [[1, 3]]);
  assert.deepEqual(reads.started, []);
});

test("a failed shared read fails each step in it and lets them be retried", async () => {
  const reads = fakeReads();
  reads.failBatches = true;
  const reader = createStepReader({ nx: 10, ny: 10 }, reads.load, reads.loadSteps);

  const outcomes = [1, 2, 3].map((step) => {
    return reader.read(step, false).then(() => "ok", () => "failed");
  });
  assert.deepEqual(await Promise.all(outcomes), ["failed", "failed", "failed"]);

  reads.failBatches = false;
  const retried = reader.read(2, false);
  await flush();
  reads.finish(2);
  assert.equal((await retried)[0], 2);
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
    batches: [] as [number, number][],
    failBatches: false,
    batchGate: null as Promise<void> | null,
    active: 0,
    peak: 0,
    async loadSteps(first: number, count: number) {
      reads.batches.push([first, count]);
      await reads.batchGate;
      if (reads.failBatches) throw new Error("failed");

      return Array.from({ length: count }, (_, index) => Float32Array.of(first + index));
    },
    load(step: number) {
      reads.started.push(step);
      reads.active += 1;
      reads.peak = Math.max(reads.peak, reads.active);
      return new Promise<Float32Array>((resolve, reject) => {
        waiting.set(step, {
          resolve: () => {
            reads.active -= 1;
            resolve(Float32Array.of(step));
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

function rangeSource() {
  const bytes = Uint8Array.from({ length: 300000 }, (_, index) => index % 256);
  const requests: { key: string; offset: number; length: number }[] = [];
  let failsNext = false;
  const store: AsyncReadable = {
    async get() {
      return undefined;
    },
    async getRange(key, range) {
      if ("suffixLength" in range) return bytes.slice(bytes.length - range.suffixLength);

      requests.push({ key, offset: range.offset, length: range.length });
      if (failsNext) throw new Error("failed");

      return bytes.slice(range.offset, range.offset + range.length);
    },
  };

  return { store, requests, failNext: () => void (failsNext = true) };
}

const CHOSEN_STEP_MS = 237;

/** Feeds a meter 12-step batches that each land after `batchMs`, returning the clock. */
function feedBatches(meter: LoadMeter, startMs: number, batches: number, batchMs: number): number {
  let nowMs = startMs;
  for (let batch = 0; batch < batches; batch += 1) {
    for (let step = 0; step < 12; step += 1) meter.begin(nowMs);
    nowMs += batchMs;
    for (let step = 0; step < 12; step += 1) meter.finish(nowMs);
  }
  return nowMs;
}

function normalArrivals(meter: LoadMeter): number {
  let nowMs = 0;
  for (let step = 0; step < 40; step += 1) {
    meter.begin(nowMs);
    nowMs += 60;
    meter.finish(nowMs);
  }
  return nowMs;
}

test("pacing recovers within seconds after a five minute stall", () => {
  const meter = new LoadMeter();
  let nowMs = normalArrivals(meter);

  for (let step = 0; step < 12; step += 1) meter.begin(nowMs);
  nowMs += 5 * 60 * 1000;
  for (let step = 0; step < 12; step += 1) meter.finish(nowMs);
  assert.ok(meter.stepMs()! <= 1500);

  feedBatches(meter, nowMs, 12, 265); // about 3 s of playback
  const targetMs = sustainedStepMs(CHOSEN_STEP_MS, meter.stepMs());

  assert.ok(targetMs < CHOSEN_STEP_MS * 1.2, `target ${targetMs} ms`);
});

test("time while the tab or view is hidden does not slow pacing", () => {
  const meter = new LoadMeter();
  let nowMs = normalArrivals(meter);

  for (let step = 0; step < 12; step += 1) meter.begin(nowMs);
  meter.setCounting(false, nowMs);
  nowMs += 5 * 60 * 1000;
  meter.setCounting(true, nowMs);
  for (let step = 0; step < 12; step += 1) meter.finish(nowMs);

  assert.ok(meter.stepMs()! < 100, `load ${meter.stepMs()} ms a step`);
  assert.equal(sustainedStepMs(CHOSEN_STEP_MS, meter.stepMs()), CHOSEN_STEP_MS);
});

const FADE_ALPHA = 0.8;
const FADE_MIXES = [0, 0.25, 0.5, 1];

test("the basemap share stays at 1 - alpha for every mix of a crossfade", () => {
  for (const mix of FADE_MIXES) {
    const { incoming, outgoing } = crossfadeOpacities(FADE_ALPHA, mix);
    const share = (1 - incoming) * (1 - outgoing);
    const outgoingWeight = outgoing * (1 - incoming);

    assert.ok(Math.abs(share - (1 - FADE_ALPHA)) < 1e-12, `mix ${mix}`);
    assert.ok(Math.abs(incoming - FADE_ALPHA * mix) < 1e-12);
    assert.ok(Math.abs(outgoingWeight - FADE_ALPHA * (1 - mix)) < 1e-12);
  }
});

test("a crossfade keeps the basemap share whichever image is on top", () => {
  const { fade, layers } = fadePair();
  fade.show(1, paintOf("one"));
  fade.arm(2, paintOf("two"));
  fade.show(2, paintOf("two"));
  fade.arm(3, paintOf("three"));

  for (const [from, to] of [[2, 3], [3, 2]]) {
    for (const mix of FADE_MIXES) {
      fade.frame(from, to, mix);
      const [bottom, top] = layers.opacities;
      const share = (1 - bottom) * (1 - top);
      assert.ok(Math.abs(share - (1 - FADE_ALPHA)) < 1e-12, `${from} to ${to} at ${mix}`);
    }
  }
});

test("the incoming image ends at full opacity and the outgoing one at none", () => {
  const { fade, layers } = fadePair();
  fade.show(1, paintOf("one"));
  fade.arm(2, paintOf("two"));

  fade.frame(1, 2, 1);

  assert.deepEqual(layers.opacities, [0, FADE_ALPHA]);
});

test("the images swap roles after a fade and the next step is painted into the idle one", () => {
  const { fade, layers } = fadePair();
  fade.show(1, paintOf("one"));
  fade.arm(2, paintOf("two"));
  fade.frame(1, 2, 1);
  layers.images.length = 0;

  assert.equal(fade.frame(2, 3, 0), true);
  fade.arm(3, paintOf("three"));

  assert.deepEqual(layers.opacities, [0, FADE_ALPHA]);
  assert.deepEqual(layers.images, [{ slot: 0, name: "three" }]);
});

test("a step that does not change does no work and sets no opacity again", () => {
  const { fade, layers } = fadePair();
  fade.show(4, paintOf("four"));
  layers.calls = 0;
  layers.images.length = 0;

  for (const mix of FADE_MIXES) fade.frame(4, 4, mix);
  fade.arm(4, paintOf("four"));

  assert.equal(layers.calls, 0);
  assert.deepEqual(layers.images, []);
});

test("a step outside the axis fades out and in through transparent", () => {
  const { fade, layers } = fadePair();
  fade.show(1, paintOf("one"));

  fade.frame(1, null, 0.25);
  assert.deepEqual(layers.opacities, [FADE_ALPHA * 0.75, 0]);
  fade.frame(null, null, 0);
  assert.deepEqual(layers.opacities, [0, 0]);

  fade.arm(2, paintOf("two"));
  fade.frame(null, 2, 0.5);
  assert.deepEqual(layers.opacities, [0, FADE_ALPHA * 0.5]);
});

test("a fade waits on the outgoing image until the incoming one is painted", () => {
  const { fade, layers } = fadePair();
  fade.show(1, paintOf("one"));

  assert.equal(fade.frame(1, 2, 0.5), true);
  assert.deepEqual(layers.opacities, [FADE_ALPHA, 0]);
  assert.equal(fade.frame(5, 6, 0.5), false);
  assert.deepEqual(layers.opacities, [FADE_ALPHA, 0]);
});

test("showing a step alone cancels a fade and a held step needs no paint", () => {
  const { fade, layers } = fadePair();
  fade.show(1, paintOf("one"));
  fade.arm(2, paintOf("two"));
  fade.frame(1, 2, 0.5);
  layers.images.length = 0;

  fade.show(2, paintOf("two"));

  assert.deepEqual(layers.opacities, [0, FADE_ALPHA]);
  assert.deepEqual(layers.images, []);
});

test("a palette change mid-fade repaints one image at full opacity", () => {
  const { fade, layers } = fadePair();
  fade.show(1, paintOf("one"));
  fade.arm(2, paintOf("two"));
  fade.frame(1, 2, 0.5);
  layers.images.length = 0;

  fade.invalidate();
  assert.equal(fade.holds(1), false);
  assert.equal(fade.holds(2), false);
  fade.show(1, paintOf("one again"));

  assert.deepEqual(layers.images, [{ slot: 0, name: "one again" }]);
  assert.deepEqual(layers.opacities, [FADE_ALPHA, 0]);
});

test("a crossfade never paints more than the two images", () => {
  const { fade, layers } = fadePair();
  fade.show(0, paintOf("0"));
  for (let step = 1; step < 20; step += 1) {
    fade.arm(step, paintOf(String(step)));
    fade.frame(step - 1, step, 1);
    fade.frame(step, step + 1, 0);
  }

  assert.deepEqual([...new Set(layers.images.map(({ slot }) => slot))].sort(), [0, 1]);
  assert.equal(fade.holds(18) && fade.holds(19), true);
  assert.equal(fade.holds(0), false);
});

test("preparing a key paints it in an idle moment and never for a held one", async () => {
  const { fade, layers } = fadePair();
  const idle = stubIdle();
  fade.show(1, paintOf("one"));
  layers.images.length = 0;

  fade.prepare(2, async () => paintOf("two"));
  fade.prepare(2, async () => paintOf("again"));
  assert.deepEqual(layers.images, []);
  idle.runAll();
  await flush();

  assert.deepEqual(layers.images, [{ slot: 1, name: "two" }]);
  fade.prepare(2, async () => paintOf("held"));
  fade.prepare(1, async () => paintOf("held"));
  assert.equal(idle.tasks.length, 0);
  idle.restore();
});

test("hiding or invalidating cancels a prepare that has not run", () => {
  const { fade, layers } = fadePair();
  const idle = stubIdle();
  fade.show(1, paintOf("one"));
  fade.prepare(2, async () => paintOf("two"));

  fade.invalidate();
  idle.runAll();

  assert.deepEqual(layers.images, [{ slot: 0, name: "one" }]);
  idle.restore();
});

test("a failed prepare lets a fade proceed once and is not retried", async () => {
  const { fade } = fadePair();
  const idle = stubIdle();
  fade.show(1, paintOf("one"));
  assert.equal(fade.isReady(1, 2), false);

  fade.prepare(2, async () => {
    throw new Error("read failed");
  });
  idle.runAll();
  await flush();
  fade.prepare(2, async () => paintOf("two"));

  assert.equal(fade.isReady(1, 2), true);
  assert.equal(idle.tasks.length, 0);
  idle.restore();
});

test("a failed outgoing step stays failed through a hide and fades the next one in", async () => {
  const { fade, layers } = fadePair();
  const idle = stubIdle();
  fade.show(1, paintOf("one"));
  fade.prepare(2, async () => {
    throw new Error("read failed");
  });
  idle.runAll();
  await flush();
  fade.hide();
  fade.arm(3, paintOf("three"));

  assert.equal(fade.isReady(2, 3), true);
  assert.equal(fade.frame(2, 3, 0.5), true);
  assert.deepEqual([...layers.opacities].sort(), [0, FADE_ALPHA * 0.5]);
  idle.restore();
});

test("a dropped image is reported with its key and invalidating reports both", () => {
  const evicted: number[] = [];
  const layers = fadePair().layers;
  const fade = new ImageCrossfade<number>(FADE_ALPHA, layers, (key) => evicted.push(key));
  fade.show(1, paintOf("one"));
  fade.arm(2, paintOf("two"));
  fade.show(3, paintOf("three"));
  assert.deepEqual(evicted, [1]);

  fade.invalidate();

  assert.deepEqual(evicted.toSorted(), [1, 2, 3]);
});

test("selecting a held key shows it at full opacity without painting", () => {
  const { fade, layers } = fadePair();
  fade.show(1, paintOf("one"));
  fade.arm(2, paintOf("two"));
  fade.frame(1, 2, 0.5);
  layers.images.length = 0;

  assert.equal(fade.select(1), true);
  assert.deepEqual(layers.opacities, [FADE_ALPHA, 0]);
  assert.equal(fade.select(9), false);
  assert.deepEqual(layers.images, []);
});

function stubIdle() {
  const tasks: (() => void)[] = [];
  const target = globalThis as unknown as Record<string, unknown>;
  target.requestIdleCallback = (task: () => void) => tasks.push(task);
  target.cancelIdleCallback = (id: number) => {
    tasks[id - 1] = () => {};
  };

  return {
    tasks,
    runAll() {
      tasks.splice(0).forEach((task) => task());
    },
    restore() {
      Reflect.deleteProperty(target, "requestIdleCallback");
      Reflect.deleteProperty(target, "cancelIdleCallback");
    },
  };
}

function fadePair() {
  const layers = {
    calls: 0,
    opacities: [0, 0] as readonly [number, number],
    images: [] as { slot: number; name: string }[],
    setImage(slot: number, image: ImageData) {
      layers.images.push({ slot, name: (image as unknown as { name: string }).name });
    },
    setOpacities(opacities: readonly [number, number]) {
      layers.calls += 1;
      layers.opacities = opacities;
    },
  };

  return { layers, fade: new ImageCrossfade<number>(FADE_ALPHA, layers) };
}

function paintOf(name: string) {
  return () => ({ name }) as unknown as ImageData;
}
