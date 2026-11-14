import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKGROUND_SHADE_LANE,
  DEM_CACHE_TILES,
  DEMAND_SHADE_LANE,
  DemCache,
  MAX_CONCURRENT_SHADE_JOBS,
  ShadeQueue,
  ShadeWorkerPool,
  type ShadePoolRequest,
  type ShadeWorkerHandle,
} from "./shade-queue.ts";

test("jobs that need the same tile share one load", async () => {
  const fetch = deferredFetch();
  const cache = new DemCache(fetch.load);
  const first = cache.load("https://example.test/1.webp", 1);
  const second = cache.load("https://example.test/1.webp", 2);

  assert.equal(fetch.calls.length, 1);
  fetch.resolve("https://example.test/1.webp", new Float32Array([3]));

  assert.equal(await first, await second);
  assert.deepEqual([...(await first)!], [3]);
});

test("idle tiles evict oldest-first while a pinned tile stays", async () => {
  const fetch = immediateFetch();
  const cache = new DemCache(fetch.load, 3);
  await cache.load("a", 1);
  await cache.load("b", 2);
  await cache.load("c", 3);
  // Touch b so a is the oldest idle tile, then pin c with a second owner.
  await cache.load("b", 2);
  await cache.load("c", 4);
  cache.release(1);
  cache.release(2);
  cache.release(3);

  await cache.load("d", 4);
  cache.release(4);
  await cache.load("a", 5);

  assert.equal(fetch.calls.filter((url) => url === "a").length, 2);
  assert.equal(fetch.calls.filter((url) => url === "b").length, 1);
  assert.equal(fetch.calls.filter((url) => url === "c").length, 1);
  cache.release(5);
});

test("a pinned tile survives eviction pressure and unpins on release", async () => {
  const fetch = immediateFetch();
  const cache = new DemCache(fetch.load, 2);
  await cache.load("a", 1);
  await cache.load("b", 2);

  await cache.load("c", 3);

  assert.equal(fetch.calls.length, 3);
  cache.release(1);
  await cache.load("d", 4);
  await cache.load("a", 5);

  assert.equal(fetch.calls.filter((url) => url === "a").length, 2);
  assert.equal(fetch.calls.filter((url) => url === "b").length, 1);
  cache.release(2);
  cache.release(3);
  cache.release(4);
  cache.release(5);
});

test("releasing an over-cap pinned set trims the idle entries", async () => {
  const fetch = immediateFetch();
  const cache = new DemCache(fetch.load, 2);
  await cache.load("a", 1);
  await cache.load("b", 2);
  await cache.load("c", 3);

  assert.equal(fetch.calls.length, 3);
  cache.release(1);
  cache.release(2);
  cache.release(3);

  await cache.load("b", 4);
  await cache.load("c", 4);
  assert.equal(fetch.calls.filter((url) => url === "b").length, 1);
  assert.equal(fetch.calls.filter((url) => url === "c").length, 1);

  await cache.load("a", 4);
  assert.equal(fetch.calls.filter((url) => url === "a").length, 2);
  cache.release(4);
});

test("letting go of the last owner aborts an unshared load", async () => {
  const fetch = deferredFetch();
  const cache = new DemCache(fetch.load);
  const loading = cache.load("https://example.test/1.webp", 1);

  cache.release(1);

  assert.equal(fetch.signals.get("https://example.test/1.webp")?.aborted, true);
  await assert.rejects(loading, { name: "AbortError" });
});

test("a shared load survives until its last owner lets go", () => {
  const fetch = deferredFetch();
  const cache = new DemCache(fetch.load);
  cache.load("https://example.test/1.webp", 1).catch(() => {});
  cache.load("https://example.test/1.webp", 2).catch(() => {});

  cache.release(1);

  assert.equal(fetch.signals.get("https://example.test/1.webp")?.aborted, false);
  cache.release(2);
  assert.equal(fetch.signals.get("https://example.test/1.webp")?.aborted, true);
});

test("a failed load is not cached but a missing tile is", async () => {
  let attempts = 0;
  const cache = new DemCache(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Bad response: 500 for https://example.test/1.webp");
    return null;
  });
  await assert.rejects(cache.load("https://example.test/1.webp", 1));

  cache.release(1);
  assert.equal(await cache.load("https://example.test/1.webp", 1), null);
  assert.equal(await cache.load("https://example.test/1.webp", 2), null);
  assert.equal(attempts, 2);
  cache.release(1);
  cache.release(2);
});

test("the queue runs a bounded set at once and drains in arrival order", () => {
  const started: number[] = [];
  const queue = new ShadeQueue(2);
  queue.add(1, () => void started.push(1));
  queue.add(2, () => void started.push(2));
  queue.add(3, () => void started.push(3));

  assert.deepEqual(started, [1, 2]);
  queue.finish();
  assert.deepEqual(started, [1, 2, 3]);
  queue.finish();
  queue.finish();
  queue.add(4, () => void started.push(4));
  assert.deepEqual(started, [1, 2, 3, 4]);
});

test("a cancelled queued job never starts and frees no lane", () => {
  const started: number[] = [];
  const queue = new ShadeQueue(1);
  queue.add(1, () => void started.push(1));
  queue.add(2, () => void started.push(2));

  assert.equal(queue.cancel(2), true);
  assert.equal(queue.cancel(1), false);
  queue.finish();

  assert.deepEqual(started, [1]);
  queue.add(3, () => void started.push(3));
  assert.deepEqual(started, [1, 3]);
});

test("the default queue width bounds the worker lanes", () => {
  const started: number[] = [];
  const queue = new ShadeQueue();
  for (let id = 1; id <= MAX_CONCURRENT_SHADE_JOBS + 1; id += 1) {
    queue.add(id, () => void started.push(id));
  }

  assert.equal(started.length, MAX_CONCURRENT_SHADE_JOBS);
});

function immediateFetch() {
  const calls: string[] = [];
  return {
    calls,
    load: async (url: string) => {
      calls.push(url);
      return new Float32Array([calls.length]);
    },
  };
}

function deferredFetch() {
  const calls: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const resolvers = new Map<string, (values: Float32Array) => void>();
  return {
    calls,
    signals,
    load: (url: string, signal: AbortSignal) => {
      calls.push(url);
      signals.set(url, signal);
      return new Promise<Float32Array>((resolve, reject) => {
        resolvers.set(url, resolve);
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
    resolve: (url: string, values: Float32Array) => resolvers.get(url)?.(values),
  };
}

test("each lane starts its own worker and keeps its messages", () => {
  const workers: StubWorker[] = [];
  const pool = new ShadeWorkerPool(() => {
    workers.push(stubWorker());
    return workers.at(-1)!;
  });
  const responses: unknown[] = [];
  pool.onresponse = (response) => void responses.push(response);

  pool.send(DEMAND_SHADE_LANE, shadeMessage(1));
  pool.send(BACKGROUND_SHADE_LANE, shadeMessage(2));

  assert.equal(workers.length, 2);
  assert.deepEqual(workers[0].sent, [shadeMessage(1)]);
  assert.deepEqual(workers[1].sent, [shadeMessage(2)]);

  workers[1].reply({ id: 2 });
  assert.deepEqual(responses, [{ id: 2 }]);
  pool.terminate();
});

test("a stalled background lane never blocks the demand lane", () => {
  const workers: StubWorker[] = [];
  const pool = new ShadeWorkerPool(() => {
    workers.push(stubWorker());
    return workers.at(-1)!;
  });
  const responses: unknown[] = [];
  pool.onresponse = (response) => void responses.push(response);

  pool.send(BACKGROUND_SHADE_LANE, shadeMessage(2));
  pool.send(DEMAND_SHADE_LANE, shadeMessage(1));

  // The demand worker answers while the background job is still stalled.
  assert.equal(workers.length, 2);
  workers[1].reply({ id: 1 });
  assert.deepEqual(responses, [{ id: 1 }]);
  pool.terminate();
});

test("a cancel reaches only the lane holding the job", () => {
  const workers: StubWorker[] = [];
  const pool = new ShadeWorkerPool(() => {
    workers.push(stubWorker());
    return workers.at(-1)!;
  });

  pool.send(DEMAND_SHADE_LANE, shadeMessage(1));
  pool.send(BACKGROUND_SHADE_LANE, shadeMessage(2));
  pool.cancel(2);
  pool.cancel(7);

  assert.deepEqual(workers[0].sent, [shadeMessage(1)]);
  assert.deepEqual(workers[1].sent, [shadeMessage(2), { id: 2, type: "cancel" }]);
  pool.terminate();
});

test("a failed lane restarts on its next job while the other lane keeps going", () => {
  const workers: StubWorker[] = [];
  const pool = new ShadeWorkerPool(() => {
    workers.push(stubWorker());
    return workers.at(-1)!;
  });
  const failed: number[] = [];
  pool.onlaneerror = (lane) => void failed.push(lane);

  pool.send(DEMAND_SHADE_LANE, shadeMessage(1));
  pool.send(BACKGROUND_SHADE_LANE, shadeMessage(2));
  workers[1].fail();

  assert.deepEqual(failed, [BACKGROUND_SHADE_LANE]);
  assert.equal(workers[1].terminated, true);
  pool.cancel(2);
  pool.send(BACKGROUND_SHADE_LANE, shadeMessage(3));

  assert.equal(workers.length, 3);
  assert.deepEqual(workers[2].sent, [shadeMessage(3)]);
  assert.deepEqual(workers[0].sent, [shadeMessage(1)]);
  pool.terminate();
});

test("terminating the pool stops every lane and forgets its jobs", () => {
  const workers: StubWorker[] = [];
  const pool = new ShadeWorkerPool(() => {
    workers.push(stubWorker());
    return workers.at(-1)!;
  });

  pool.send(DEMAND_SHADE_LANE, shadeMessage(1));
  pool.send(BACKGROUND_SHADE_LANE, shadeMessage(2));
  pool.terminate();

  assert.ok(workers.every((worker) => worker.terminated));
  pool.cancel(1);
  assert.equal(workers.length, 2);
});

test("cancelled queued jobs leave no bookkeeping without worker replies", () => {
  const workers: StubWorker[] = [];
  const pool = new ShadeWorkerPool(() => {
    workers.push(stubWorker());
    return workers.at(-1)!;
  });

  for (let id = 1; id <= 1000; id += 1) {
    pool.send(DEMAND_SHADE_LANE, shadeMessage(id));
  }
  for (let id = 1; id <= 1000; id += 1) {
    pool.cancel(id);
  }

  assert.equal(pendingJobs(pool), 0);
  assert.equal(
    workers[0].sent.filter((message) => message.type === "cancel").length,
    1000,
  );
  pool.cancel(1);
  assert.equal(
    workers[0].sent.filter((message) => message.type === "cancel").length,
    1000,
  );
  pool.terminate();
});

test("two workers keep twelve decoded tiles each for a total of twenty-four", async () => {
  assert.equal(DEM_CACHE_TILES, 12);
  const firstFetch = immediateFetch();
  const secondFetch = immediateFetch();
  const first = new DemCache(firstFetch.load);
  const second = new DemCache(secondFetch.load);

  await holdNeighbourhood(first, 1);
  await holdNeighbourhood(second, 101);
  assert.equal(cacheSize(first), 18);
  assert.equal(cacheSize(second), 18);

  first.release(1);
  second.release(101);
  assert.equal(cacheSize(first), 12);
  assert.equal(cacheSize(second), 12);
  assert.equal(cacheSize(first) + cacheSize(second), 24);
  // Owned neighbourhoods survive while the oldest idle tiles evict first.
  await first.load("a0", 3);
  assert.equal(firstFetch.calls.filter((url) => url === "a0").length, 2);
  await first.load("b0", 3);
  assert.equal(firstFetch.calls.filter((url) => url === "b0").length, 1);
  first.release(2);
  first.release(3);
  second.release(102);
});

/** Nine disjoint tiles owned by one job, so active loads count toward the bound. */
async function holdNeighbourhood(cache: DemCache, owner: number): Promise<void> {
  for (let tile = 0; tile < 9; tile += 1) {
    await cache.load(`a${tile}`, owner);
    await cache.load(`b${tile}`, owner + 1);
  }
}

function cacheSize(cache: DemCache): number {
  return (cache as unknown as { entries: Map<string, unknown> }).entries.size;
}

function pendingJobs(pool: ShadeWorkerPool): number {
  return (pool as unknown as { jobLane: Map<number, number> }).jobLane.size;
}

interface StubWorker extends ShadeWorkerHandle {
  sent: ShadePoolRequest[];
  terminated: boolean;
  reply(response: { id: number }): void;
  fail(): void;
}

const DEM_URL = "https://example.test/{z}/{x}/{y}.webp";

/** One shade request with its tile derived from its id, so lane tests stay distinct. */
function shadeMessage(id: number): ShadePoolRequest {
  return { type: "shade", id, tile: { z: 5, x: id, y: 2 }, strength: 2, demUrl: DEM_URL };
}

function stubWorker(): StubWorker {
  return {
    sent: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(message: ShadePoolRequest) {
      this.sent.push(message);
    },
    terminate() {
      this.terminated = true;
    },
    reply(response: { id: number }) {
      this.onmessage?.({ data: response } as MessageEvent<any>);
    },
    fail() {
      this.onerror?.({} as ErrorEvent);
    },
  };
}
