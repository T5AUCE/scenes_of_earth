/** The HTTP-cache warmer: lanes, order, dwell caps and the dev readout. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beginWarmer,
  formatWarmerPart,
  isWarmerEnabled,
  noteWarmerRequest,
  setWarmerEnabled,
  setWarmerProgress,
  warmerSnapshot,
} from "../dev-stats.ts";
import { DWELL_REQUEST_CAP } from "../render/tile-viewport.ts";
import {
  TileWarmer,
  WARMER_LANES,
  type WarmerMap,
} from "./tile-warmer.ts";
import type { PreloadSource, PreloadTask } from "./tile-prefetch.ts";

test("entry warms three at once in registration order", async () => {
  const map = fakeMap();
  const warmer = new TileWarmer(map);
  try {
    const dem = fakeSource("dem", ["d0", "d1", "d2", "d3"], { layer: "terrain" });
    const contours = fakeSource("contours", ["c0"], { layer: "contours", after: "dem" });
    warmer.add(dem.source);
    warmer.add(contours.source);
    warmer.start(8);
    await settled();

    assert.deepEqual([...dem.runs.keys()], ["d0", "d1", "d2"]);
    assert.equal(contours.runs.size, 0);
    dem.finish("d0");
    await settled();

    assert.deepEqual([...dem.runs.keys()], ["d0", "d1", "d2", "d3"]);
    dem.finish("d1");
    dem.finish("d2");
    dem.finish("d3");
    await settled();

    assert.deepEqual([...contours.runs.keys()], ["c0"]);
  } finally {
    warmer.destroy();
  }
});

test("a gated trace runs while the gate holds only deeper work", async () => {
  const map = fakeMap();
  const warmer = new TileWarmer(map);
  try {
    const gates = new Map<string, (blob: Blob | undefined) => void>();
    const gated = (key: string) => new Promise<Blob | undefined>((resolve) => {
      gates.set(key, resolve);
    });
    warmer.add({
      id: "dem",
      layer: "terrain",
      lanes: 2,
      tasks: () => [
        { key: "dem-8", zoom: 8, run: () => gated("dem-8") },
        { key: "dem-12", zoom: 12, run: () => gated("dem-12") },
      ],
    } satisfies PreloadSource);
    warmer.add({
      id: "contours",
      layer: "contours",
      lanes: 1,
      after: "dem",
      tasks: () => [{ key: "trace-8", zoom: 8, run: () => gated("trace-8") }],
    } satisfies PreloadSource);
    warmer.start(8);
    await settled();

    assert.equal(gates.has("trace-8"), false);
    gates.get("dem-8")!(undefined);
    await settled();

    assert.equal(gates.has("trace-8"), true);
  } finally {
    warmer.destroy();
  }
});

test("a trace without ready parents drops instead of running", async () => {
  const map = fakeMap();
  const warmer = new TileWarmer(map);
  try {
    const feed = fakeSource("contours", ["trace-0"], { layer: "contours" });
    const original = feed.source.tasks;
    feed.source.tasks = () => [{
      key: "trace-0",
      zoom: 9,
      needs: ["missing-parent"],
      run: original()[0].run,
    }];
    warmer.add(feed.source);
    warmer.start(9);
    await settled();

    assert.equal(feed.runs.size, 0);
    assert.deepEqual(warmer.progress(), { done: 0, total: 0, bytes: 0 });
  } finally {
    warmer.destroy();
  }
});

test("a missing tile is remembered while other failures warm again on dwell", async () => {
  const map = fakeMap(8);
  const warmer = new TileWarmer(map);
  try {
    const feed = fakeSource("dem", ["ocean", "flaky"], { layer: "terrain" });
    const dwellWarmed: string[] = [];
    feed.source.dwell = () => ["ocean", "flaky"].map((key) => ({
      key,
      zoom: 8,
      run: () => {
        dwellWarmed.push(key);
        return Promise.resolve(undefined);
      },
    }));
    warmer.add(feed.source);
    warmer.start(8);
    await settled();
    feed.fail("ocean", "Bad response: 404 for https://tiles.example.test/ocean");
    feed.fail("flaky", "Bad response: 503 for https://tiles.example.test/flaky");
    await settled();

    warmer.noteLanded();
    map.emit("moveend", {});
    await settled();

    assert.deepEqual(dwellWarmed, ["flaky"]);
  } finally {
    warmer.destroy();
  }
});

test("a dwell warms the resting viewport once landed and stays in the cap", async () => {
  const map = fakeMap(8);
  const warmer = new TileWarmer(map);
  try {
    const seen: string[] = [];
    warmer.add({
      id: "dem",
      layer: "terrain",
      lanes: 3,
      tasks: () => [],
      dwell: (_viewport, _fitted, _current) => {
        return Array.from({ length: 200 }, (_, index) => {
          const key = `dwell-${index}`;
          return {
            key,
            zoom: 9,
            run: () => {
              seen.push(key);
              return Promise.resolve(undefined);
            },
          } satisfies PreloadTask;
        });
      },
    } satisfies PreloadSource);
    warmer.start(5);
    await settled();
    map.emit("moveend", {});
    await settled();

    assert.equal(seen.length, 0);
    warmer.noteLanded();
    map.emit("moveend", {});
    await idle(warmer);

    assert.ok(seen.length > 0 && seen.length <= DWELL_REQUEST_CAP);
    assert.deepEqual(warmer.progress(), {
      done: seen.length,
      total: seen.length,
      bytes: 0,
    });
  } finally {
    warmer.destroy();
  }
});

test("destroying aborts running work and switches the readout off", async () => {
  const map = fakeMap();
  const warmer = new TileWarmer(map);
  assert.equal(isWarmerEnabled(), true);

  const feed = fakeSource("dem", ["d0", "d1"], { layer: "terrain" });
  warmer.add(feed.source);
  warmer.start(8);
  await settled();
  warmer.destroy();
  await settled();

  assert.deepEqual(feed.aborted, ["d0", "d1"]);
  assert.equal(isWarmerEnabled(), false);
  assert.deepEqual(warmerSnapshot().progress, { done: 0, total: 0 });
});

test("replacing a source aborts its work and warms the replacement", async () => {
  const map = fakeMap();
  const warmer = new TileWarmer(map);
  try {
    const first = fakeSource("dem", ["old"], { layer: "terrain" });
    warmer.add(first.source);
    warmer.start(8);
    await settled();

    const second = fakeSource("dem", ["new"], { layer: "terrain" });
    warmer.add(second.source);
    await settled();

    assert.deepEqual(first.aborted, ["old"]);
    assert.deepEqual([...second.runs.keys()], ["new"]);
  } finally {
    warmer.destroy();
  }
});

test("a second dwell replaces the first dwell instead of piling up", async () => {
  const map = fakeMap(8);
  const warmer = new TileWarmer(map);
  try {
    let pan = 0;
    const aborted: string[] = [];
    warmer.add({
      id: "dem",
      layer: "terrain",
      lanes: 3,
      tasks: () => [],
      dwell: () => {
        return Array.from({ length: 200 }, (_, index) => {
          const key = `p${pan}-${index}`;
          return {
            key,
            zoom: 9,
            run: (abort: AbortController) => new Promise<undefined>((_resolve, reject) => {
              abort.signal.addEventListener("abort", () => {
                aborted.push(key);
                reject(new Error("aborted"));
              });
            }),
          } satisfies PreloadTask;
        });
      },
    } satisfies PreloadSource);
    warmer.start(5);
    warmer.noteLanded();
    map.emit("moveend", {});
    await settled();

    assert.equal(warmer.progress().total, DWELL_REQUEST_CAP);
    pan = 1;
    map.emit("moveend", {});
    await settled();

    assert.ok(warmer.progress().total <= DWELL_REQUEST_CAP);
    assert.ok(aborted.length > 0);
    assert.ok(aborted.every((key) => key.startsWith("p0-")));
  } finally {
    warmer.destroy();
  }
});

test("a stale rejection never settles a replacement job with the same key", async () => {
  const map = fakeMap();
  const warmer = new TileWarmer(map);
  try {
    const firstResolvers: Array<(value: undefined) => void> = [];
    const secondResolvers: Array<(value: undefined) => void> = [];
    const make = (resolvers: Array<(value: undefined) => void>): PreloadSource => ({
      id: "dem",
      layer: "terrain",
      lanes: 3,
      tasks: () => [{
        key: "same",
        zoom: 8,
        run: (abort: AbortController) => new Promise<undefined>((resolve, reject) => {
          resolvers.push(resolve);
          abort.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      }],
    });
    warmer.add(make(firstResolvers));
    warmer.start(8);
    await settled();

    assert.equal(firstResolvers.length, 1);
    warmer.add(make(secondResolvers));
    await settled();

    assert.equal(secondResolvers.length, 1);
    secondResolvers[0]?.(undefined);
    await settled();

    assert.deepEqual(warmer.progress(), { done: 1, total: 1, bytes: 0 });
    assert.equal(warmer.isSettled(), true);
  } finally {
    warmer.destroy();
  }
});

test("the dwell cap is shared round-robin so basemap warms on the first dwell", async () => {
  const map = fakeMap(8);
  const warmer = new TileWarmer(map);
  try {
    const seen = new Map<string, string[]>();
    const dwellFor = (id: string) => () => {
      return Array.from({ length: 200 }, (_, index) => {
        const key = `${id}-${index}`;
        return {
          key,
          zoom: 9,
          run: () => {
            const entries = seen.get(id) ?? [];
            entries.push(key);
            seen.set(id, entries);
            return Promise.resolve(undefined);
          },
        } satisfies PreloadTask;
      });
    };
    warmer.add({
      id: "dem",
      layer: "terrain",
      lanes: 3,
      tasks: () => [],
      dwell: dwellFor("dem"),
    } satisfies PreloadSource);
    warmer.add({
      id: "basemap",
      layer: "basemap",
      lanes: 3,
      tasks: () => [],
      dwell: dwellFor("basemap"),
    } satisfies PreloadSource);
    warmer.start(5);
    warmer.noteLanded();
    map.emit("moveend", {});
    await idle(warmer);

    assert.equal(warmer.progress().total, DWELL_REQUEST_CAP);
    assert.ok((seen.get("dem")?.length ?? 0) > 0);
    assert.ok((seen.get("basemap")?.length ?? 0) > 0);
  } finally {
    warmer.destroy();
  }
});

test("dwell launches round-robin while DEM tasks stay pending", async () => {
  const map = fakeMap(8);
  const warmer = new TileWarmer(map);
  try {
    const launched: string[] = [];
    const dwellFor = (id: string) => () => {
      return Array.from({ length: 10 }, (_, index) => {
        const key = `${id}-${index}`;
        return {
          key,
          zoom: 9,
          run: (abort: AbortController) => new Promise<undefined>((_resolve, reject) => {
            launched.push(key);
            abort.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        } satisfies PreloadTask;
      });
    };
    warmer.add({
      id: "dem",
      layer: "terrain",
      lanes: 3,
      tasks: () => [],
      dwell: dwellFor("dem"),
    } satisfies PreloadSource);
    warmer.add({
      id: "basemap",
      layer: "basemap",
      lanes: 3,
      tasks: () => [],
      dwell: dwellFor("basemap"),
    } satisfies PreloadSource);
    warmer.start(5);
    warmer.noteLanded();
    map.emit("moveend", {});
    await settled();

    assert.equal(launched.length, WARMER_LANES);
    assert.ok(launched.some((key) => key.startsWith("basemap-")));
  } finally {
    warmer.destroy();
  }
});

test("a source with one lane runs one at a time inside the global lanes", async () => {
  const map = fakeMap();
  const warmer = new TileWarmer(map);
  try {
    const feed = fakeSource("contours", ["t0", "t1", "t2"], { layer: "contours" });
    feed.source.lanes = 1;
    warmer.add(feed.source);
    warmer.start(8);
    await settled();

    assert.deepEqual([...feed.runs.keys()], ["t0"]);
    feed.finish("t0");
    await settled();

    assert.deepEqual([...feed.runs.keys()], ["t0", "t1"]);
  } finally {
    warmer.destroy();
  }
});

test("launches count per layer in the dev readout without held bytes", async () => {
  const map = fakeMap();
  const warmer = new TileWarmer(map);
  try {
    assert.deepEqual(warmerSnapshot(), {
      progress: { done: 0, total: 0 },
      counts: { terrain: 0, basemap: 0, contours: 0 },
    });
    warmer.add(fakeSource("dem", ["d0"], { layer: "terrain" }).source);
    warmer.add(fakeSource("basemap", ["b0"], { layer: "basemap" }).source);
    warmer.start(8);
    await settled();

    assert.deepEqual(warmerSnapshot().counts, { terrain: 1, basemap: 1, contours: 0 });
    assert.equal(
      formatWarmerPart(warmerSnapshot()),
      "warmer 0/2 tiles terrain 1 basemap 1 contours 0",
    );
  } finally {
    warmer.destroy();
  }
});

test("warmer counters reset per scene and format the badge part", () => {
  setWarmerEnabled(true);
  try {
    beginWarmer();
    noteWarmerRequest("terrain");
    noteWarmerRequest("contours");
    setWarmerProgress(3, 9);

    assert.deepEqual(warmerSnapshot(), {
      progress: { done: 3, total: 9 },
      counts: { terrain: 1, basemap: 0, contours: 1 },
    });
    assert.equal(
      formatWarmerPart(warmerSnapshot()),
      "warmer 3/9 tiles terrain 1 basemap 0 contours 1",
    );
    beginWarmer();

    assert.deepEqual(warmerSnapshot().counts, { terrain: 0, basemap: 0, contours: 0 });
  } finally {
    setWarmerEnabled(false);
  }
});

test("the warmer holds at most three lanes", () => {
  assert.equal(WARMER_LANES, 3);
});

interface Run {
  resolve(blob: Blob | undefined): void;
  reject(error: Error): void;
}

function fakeSource(
  id: string,
  keys: string[],
  options: { layer: PreloadSource["layer"]; after?: string },
) {
  const runs = new Map<string, Run>();
  const aborted: string[] = [];
  const source: PreloadSource = {
    id,
    layer: options.layer,
    lanes: 3,
    after: options.after,
    tasks: () => keys.map((key) => ({
      key,
      run: (abort: AbortController) => new Promise<Blob | undefined>((resolve, reject) => {
        runs.set(key, { resolve, reject });
        abort.signal.addEventListener("abort", () => {
          aborted.push(key);
          reject(new Error("aborted"));
        });
      }),
    })),
  };
  return {
    runs,
    aborted,
    source,
    finish(key: string) {
      runs.get(key)!.resolve(undefined);
    },
    fail(key: string, message: string) {
      runs.get(key)!.reject(new Error(message));
    },
  };
}

function fakeMap(zoom = 8) {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const map = {
    on: (type: string, listener: (event: object) => void) => {
      const entries = listeners.get(type) ?? new Set<(event: object) => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off: (type: string, listener: (event: object) => void) => {
      listeners.get(type)?.delete(listener);
    },
    getZoom: () => zoom,
    getCenter: () => ({ lng: 0, lat: 0 }),
    getBounds: () => ({
      getWest: () => -20,
      getSouth: () => -10,
      getEast: () => 20,
      getNorth: () => 10,
    }),
    emit: (type: string, event: object) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
  return map as unknown as WarmerMap & { emit(type: string, event: object): void };
}

/** Let resolved fakes reach the warmer before the test asserts. */
async function settled(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}

/** Wait until the warmer drains, polling with microtasks only. */
async function idle(warmer: TileWarmer): Promise<void> {
  for (let round = 0; round < 500; round += 1) {
    await settled();
    if (warmer.isSettled()) {
      await settled();
      if (warmer.isSettled()) return;
    }
  }
}
