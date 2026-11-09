import assert from "node:assert/strict";
import { test } from "node:test";

import { DemCache, MAX_CONCURRENT_SHADE_JOBS, ShadeQueue } from "./shade-queue.ts";

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
