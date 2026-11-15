import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { DEM_TILE_SIZE_PX, edgeStrips } from "../workers/dem-decode.ts";
import type { DemWorkerRequest, DemWorkerResponse } from "../workers/dem-worker.ts";
import type { WantedTile } from "./dem-plan.ts";
import {
  acquireDemPool,
  createGlTextureStore,
  demPoolHas,
  demPoolStats,
  DemPool,
  MAX_FETCHES,
  releaseDemPool,
  TEXTURE_BYTES,
  TEXTURE_SIZE_PX,
  type DemTexture,
  type DemTextureStore,
  type DemWorkerPort,
} from "./dem-pool.ts";

const SIZE_PX = DEM_TILE_SIZE_PX;
const URL_TEMPLATE = "https://dem/{z}/{x}/{y}.png";
const ZOOM = 6;

class FakeWorker implements DemWorkerPort {
  requests: DemWorkerRequest[] = [];

  constructor(private readonly log: DemWorkerRequest[]) {}
  terminated = false;
  private handler: (response: DemWorkerResponse) => void = () => {};

  post(request: DemWorkerRequest) {
    this.requests.push(request);
    this.log.push(request);
  }

  onResponse(handler: (response: DemWorkerResponse) => void) {
    this.handler = handler;
  }

  terminate() {
    this.terminated = true;
  }

  reply(response: DemWorkerResponse) {
    this.handler(response);
  }
}

interface Patch {
  texture: DemTexture;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Float32Array;
}

class FakeStore implements DemTextureStore {
  created: { texture: DemTexture; data: Float32Array }[] = [];
  patches: Patch[] = [];
  removed: DemTexture[] = [];
  linear = true;

  constructor(private readonly keepData = false) {}

  create(data: Float32Array) {
    const texture = {};
    this.created.push({ texture, data: this.keepData ? data.slice() : data });

    return texture;
  }

  patch(
    texture: DemTexture,
    x: number,
    y: number,
    width: number,
    height: number,
    data: Float32Array,
  ) {
    this.patches.push({ texture, x, y, width, height, data: data.slice() });
  }

  remove(texture: DemTexture) {
    this.removed.push(texture);
  }
}

function setup(options: { keepData?: boolean; store?: FakeStore | null } = {}) {
  const workers: FakeWorker[] = [];
  const log: DemWorkerRequest[] = [];
  const store = options.store === undefined ? new FakeStore(options.keepData) : options.store;
  let time = 0;
  let changes = 0;

  const pool = new DemPool({
    tileUrl: URL_TEMPLATE,
    store,
    createWorker: () => {
      const worker = new FakeWorker(log);
      workers.push(worker);

      return worker;
    },
    onChange: () => changes++,
    now: () => time,
  });

  return {
    pool,
    store,
    workers,
    changes: () => changes,
    advance: (ms: number) => {
      time += ms;
    },
    loads: () => log.filter((request) => request.type === "load"),
    cancels: () => log.filter((request) => request.type === "cancel"),
  };
}

const flatTile = new Float32Array(SIZE_PX * SIZE_PX);
const flatStrips = edgeStrips(flatTile);

function tile(x: number, y = 0, tier: WantedTile["tier"] = "view", z = ZOOM): WantedTile {
  return { z, x, y, tier };
}

function keyOf(wanted: WantedTile) {
  return (4 ** wanted.z - 1) / 3 + wanted.x + wanted.y * 2 ** wanted.z;
}

/** Answer the pending load of a tile on whichever worker holds it. */
function land(
  harness: ReturnType<typeof setup>,
  wanted: WantedTile,
  heights = flatTile,
  strips = flatStrips,
) {
  const url = URL_TEMPLATE.replace("{z}", String(wanted.z))
    .replace("{x}", String(wanted.x))
    .replace("{y}", String(wanted.y));
  const worker = harness.workers.find((candidate) =>
    candidate.requests.some((request) => request.type === "load" && request.url === url),
  );

  assert.ok(worker, `no load posted for ${url}`);

  const sent = worker.requests.find((request) => request.type === "load" && request.url === url)!;
  worker.reply({ kind: "tile", id: sent.id, heights, strips, decodeMs: 4 });
}

function failWith(
  harness: ReturnType<typeof setup>,
  wanted: WantedTile,
  kind: "missing" | "error",
) {
  const load = harness
    .loads()
    .find(
      (request) =>
        request.type === "load" && request.url.endsWith(`/${wanted.z}/${wanted.x}/${wanted.y}.png`),
    )!;
  const worker = harness.workers.find((candidate) => candidate.requests.includes(load))!;
  worker.reply(kind === "missing" ? { kind, id: load.id } : { kind, id: load.id, message: "down" });
}

test("a tile asked for on every frame loads once", () => {
  const harness = setup();

  harness.pool.update([tile(1)]);
  harness.pool.update([tile(1)]);

  assert.equal(harness.loads().length, 1);

  const [request] = harness.loads();

  assert.equal(request.type === "load" && request.url, "https://dem/6/1/0.png");
});

test("at most MAX_FETCHES fetches run and the best-ranked tiles go first", () => {
  const harness = setup();
  const wanted = Array.from({ length: MAX_FETCHES + 4 }, (_, index) => tile(index));

  harness.pool.update(wanted);

  const urls = harness.loads().map((request) => request.type === "load" && request.url);

  assert.deepEqual(
    urls,
    wanted.slice(0, MAX_FETCHES).map((entry) => `https://dem/6/${entry.x}/0.png`),
  );
  assert.deepEqual(
    harness.workers.map((worker) => worker.requests.length),
    [MAX_FETCHES / 2, MAX_FETCHES / 2],
  );
  assert.equal(harness.pool.stats().queueDepth, 4);
});

test("a landed tile frees a slot for the next one", () => {
  const harness = setup();
  const wanted = Array.from({ length: MAX_FETCHES + 1 }, (_, index) => tile(index));
  harness.pool.update(wanted);

  assert.equal(harness.loads().length, MAX_FETCHES);
  assert.equal(harness.pool.stats().queueDepth, 1);

  land(harness, wanted[0]);

  assert.equal(harness.loads().length, MAX_FETCHES + 1);
  assert.equal(harness.pool.stats().inflight, MAX_FETCHES);
  assert.equal(harness.pool.stats().queueDepth, 0);
  assert.equal(harness.changes(), 1);
});

test("loads nobody wants any more are cancelled", () => {
  const harness = setup();
  harness.pool.update([tile(1), tile(2)]);

  harness.pool.update([tile(2)]);

  assert.deepEqual(
    harness.cancels().map((request) => request.id),
    [keyOf(tile(1))],
  );
  assert.equal(harness.pool.stats().inflight, 1);
  assert.equal(harness.pool.stats().cancelled, 1);
});

test("look-ahead loads are cancelled when the pan turns away", () => {
  const harness = setup();

  harness.pool.update([tile(1), tile(2, 0, "lookahead")]);
  harness.pool.update([tile(1)]);

  assert.deepEqual(
    harness.cancels().map((request) => request.id),
    [keyOf(tile(2, 0, "lookahead"))],
  );
  assert.equal(harness.pool.stats().inflight, 1);
  assert.equal(harness.pool.stats().cancelled, 1);
});

test("a cancelled tile that is wanted again is requested again", () => {
  const harness = setup();
  harness.pool.update([tile(1)]);
  harness.pool.update([]);

  harness.pool.update([tile(1)]);

  assert.equal(harness.loads().length, 2);
});

test("a reply for a cancelled load changes nothing", () => {
  const harness = setup();
  harness.pool.update([tile(1)]);
  harness.pool.update([]);

  harness.workers[0].reply({
    kind: "tile",
    id: keyOf(tile(1)),
    heights: flatTile,
    strips: flatStrips,
    decodeMs: 4,
  });

  assert.equal(harness.changes(), 0);
  assert.equal(harness.pool.stats().cancelled, 1);
  assert.equal(harness.pool.stats().awaitingUpload, 0);
  assert.equal(harness.pool.uploadPending(), 0);
});

test("a missing tile is not requested again", () => {
  const harness = setup();
  harness.pool.update([tile(1)]);
  failWith(harness, tile(1), "missing");

  harness.advance(60 * 60 * 1000);
  harness.pool.update([tile(1)]);

  assert.equal(harness.loads().length, 1);
});

test("a failed fetch is retried only after the retry delay", () => {
  const harness = setup();
  harness.pool.update([tile(1)]);
  failWith(harness, tile(1), "error");

  harness.pool.update([tile(1)]);

  assert.equal(harness.loads().length, 1);

  harness.advance(5000);
  harness.pool.update([tile(1)]);

  assert.equal(harness.loads().length, 2);
});

test("the memo of missing tiles stays bounded", () => {
  const harness = setup();

  for (let index = 0; index < 600; index++) {
    const entry = tile(index % 64, Math.floor(index / 64));
    harness.pool.update([entry]);
    failWith(harness, entry, "missing");
  }

  assert.equal(harness.pool.stats().failures, 512);
});

test("uploads run only inside uploadPending and at most eight per frame", () => {
  const harness = setup();
  const wanted = Array.from({ length: 10 }, (_, index) => tile(index));
  harness.pool.update(wanted);

  for (const entry of wanted) land(harness, entry);

  assert.equal(harness.store!.created.length, 0);

  assert.equal(harness.pool.uploadPending(), 8);

  harness.pool.update(wanted);

  assert.equal(harness.pool.uploadPending(), 2);

  assert.equal(harness.store!.created.length, 10);
  assert.equal(harness.pool.stats().awaitingUpload, 0);
  assert.ok(harness.pool.texture(tile(9)));
});

test("uploads stop at the millisecond budget and continue on the next frame", () => {
  const harness = setup();
  const store = harness.store!;
  const created = store.create.bind(store);
  store.create = (data) => {
    harness.advance(2);
    return created(data);
  };

  const wanted = [tile(0), tile(1), tile(2), tile(3)];
  harness.pool.update(wanted);

  for (const entry of wanted) land(harness, entry);

  assert.equal(harness.pool.uploadPending(), 2);

  harness.pool.update(wanted);

  assert.equal(harness.pool.uploadPending(), 2);
  assert.equal(harness.store!.created.length, 4);
});

test("view and pinned tiles upload before lower tiers whatever the list order", () => {
  const harness = setup({ keepData: true });
  const store = harness.store!;
  const created = store.create.bind(store);
  store.create = (data) => {
    harness.advance(10);
    return created(data);
  };

  const ring = tile(0, 0, "ring");
  const view = tile(1);
  const pinned = tile(2, 0, "pinned");
  harness.pool.update([ring, view, pinned]);

  const heights = (value: number) => new Float32Array(SIZE_PX * SIZE_PX).fill(value);
  land(harness, ring, heights(1), edgeStrips(heights(1)));
  land(harness, view, heights(2), edgeStrips(heights(2)));
  land(harness, pinned, heights(3), edgeStrips(heights(3)));

  assert.equal(harness.pool.uploadPending(), 1);

  const centre = 2 * TEXTURE_SIZE_PX + 2;

  assert.equal(store.created[0].data[centre], 2);

  harness.pool.update([ring, view, pinned]);

  assert.equal(harness.pool.uploadPending(), 1);
  assert.equal(store.created[1].data[centre], 3);
});

test("layers sharing a map frame upload at most eight tiles between them", () => {
  const harness = setup();
  const wanted = Array.from({ length: 10 }, (_, index) => tile(index));
  harness.pool.update(wanted);

  for (const entry of wanted) land(harness, entry);

  harness.pool.syncFrame(wanted);
  harness.pool.syncFrame(wanted);

  assert.equal(harness.store!.created.length, 8);
  assert.equal(harness.pool.needsRepaint(), true);

  harness.pool.endMapFrame();
  harness.pool.syncFrame(wanted);

  assert.equal(harness.store!.created.length, 10);
});

test("the map finishing a frame lets the shared pool work on the next one", () => {
  const { map, options, workers } = poolFixture();
  const pool = acquireDemPool(options);

  pool.syncFrame([tile(1)]);
  pool.syncFrame([tile(2)]);

  assert.equal(workers.flatMap((worker) => worker.requests).length, 1);

  map.fireRender();
  pool.syncFrame([tile(2)]);

  assert.equal(workers.flatMap((worker) => worker.requests).length, 3);

  releaseDemPool(map, URL_TEMPLATE);
});

test("a tile reports how long it has been able to draw", () => {
  const harness = setup();
  const centre = tile(5, 5);
  harness.pool.update([centre]);
  land(harness, centre);
  harness.pool.uploadPending();

  harness.advance(40);

  assert.equal(harness.pool.drawableForMs(centre), 40);
  assert.equal(harness.pool.drawableForMs(tile(9, 9)), null);
});

test("a tile waiting on neighbours is drawable for no time until the cap passes", () => {
  const harness = setup();
  const centre = tile(5, 5);
  harness.pool.update([centre, tile(6, 5)]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.drawableForMs(centre), null);

  harness.advance(350);

  assert.equal(harness.pool.drawableForMs(centre), 50);
});

test("needsRepaint asks for the frames that finish the budgeted uploads", () => {
  const harness = setup();
  const wanted = Array.from({ length: 10 }, (_, index) => tile(index));
  harness.pool.update(wanted);

  for (const entry of wanted) land(harness, entry);

  harness.pool.uploadPending();

  assert.equal(harness.pool.needsRepaint(), true);

  harness.pool.update(wanted);
  harness.pool.uploadPending();

  assert.equal(harness.pool.needsRepaint(), false);
});

test("needsRepaint asks for frames while a tile waits out the drawable cap", () => {
  const harness = setup();
  const centre = tile(5, 5);
  const wanted = [centre, tile(6, 5)];

  harness.pool.update(wanted);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.needsRepaint(), true);

  harness.advance(300);
  harness.pool.update(wanted);

  assert.equal(harness.pool.needsRepaint(), false);
});

test("a decoded tile that nobody wants any more is dropped before upload", () => {
  const harness = setup();
  harness.pool.update([tile(1)]);
  land(harness, tile(1));

  harness.pool.update([tile(2)]);

  assert.equal(harness.pool.stats().awaitingUpload, 0);
  assert.equal(harness.pool.uploadPending(), 0);
});

test("a decoded look-ahead tile nobody wants is dropped before upload", () => {
  const harness = setup();

  harness.pool.update([tile(2, 0, "lookahead")]);
  land(harness, tile(2, 0, "lookahead"));
  harness.pool.update([tile(1)]);

  assert.equal(harness.pool.stats().awaitingUpload, 0);
  assert.equal(harness.pool.uploadPending(), 0);
});

test("a tile waiting to upload is not requested again", () => {
  const harness = setup();
  harness.pool.update([tile(1)]);
  land(harness, tile(1));

  harness.pool.update([tile(1)]);

  assert.equal(harness.loads().length, 1);
});

test("a texture is the tile plus a two pixel halo of its neighbours' edges", () => {
  const harness = setup({ keepData: true });
  const centre = tile(5, 5);
  const northHeights = new Float32Array(SIZE_PX * SIZE_PX).fill(100);
  const westHeights = Float32Array.from({ length: SIZE_PX * SIZE_PX }, (_, index) => index);

  const wanted = [centre, tile(5, 4), tile(4, 5)];
  harness.pool.update(wanted);

  land(harness, tile(5, 4), northHeights, edgeStrips(northHeights));
  land(harness, tile(4, 5), westHeights, edgeStrips(westHeights));
  land(harness, centre, new Float32Array(SIZE_PX * SIZE_PX).fill(7));
  harness.pool.uploadPending();

  const centreData = harness.store!.created.find(
    (entry) => entry.data[TEXTURE_SIZE_PX * 2 + 2] === 7,
  )!.data;

  assert.equal(centreData.length, TEXTURE_SIZE_PX ** 2);
  assert.equal(centreData[2 * TEXTURE_SIZE_PX + 2], 7);
  assert.equal(centreData[1 * TEXTURE_SIZE_PX + 100], 100, "north halo reads the neighbour");
  assert.equal(
    centreData[(2 + 7) * TEXTURE_SIZE_PX + 1],
    7 * SIZE_PX + SIZE_PX - 1,
    "west halo keeps the row and column order",
  );
  assert.equal(centreData[(TEXTURE_SIZE_PX - 1) * TEXTURE_SIZE_PX + 100], 7);
  assert.equal(centreData[0], 7, "corners repeat the corner pixel");
});

test("a neighbour landing later patches the halo of an uploaded texture", () => {
  const harness = setup();
  const centre = tile(5, 5);
  harness.pool.update([centre, tile(5, 6, "view"), tile(4, 5, "view")]);
  land(harness, centre);
  harness.pool.uploadPending();

  const southHeights = Float32Array.from({ length: SIZE_PX * SIZE_PX }, (_, index) => index);
  const westHeights = new Float32Array(SIZE_PX * SIZE_PX).fill(3);

  land(harness, tile(5, 6), southHeights, edgeStrips(southHeights));
  land(harness, tile(4, 5), westHeights, edgeStrips(westHeights));
  harness.pool.update([centre, tile(5, 6, "view"), tile(4, 5, "view")]);
  harness.pool.uploadPending();

  const centreTexture = harness.pool.texture(centre);
  const patches = harness.store!.patches.filter((patch) => patch.texture === centreTexture);
  const rects = patches.map(({ x, y, width, height, data }) => ({
    x,
    y,
    width,
    height,
    first: data[0],
    length: data.length,
  }));

  assert.deepEqual(rects, [
    { x: 2, y: 514, width: SIZE_PX, height: 2, first: 0, length: 2 * SIZE_PX },
    { x: 0, y: 2, width: 2, height: SIZE_PX, first: 3, length: 2 * SIZE_PX },
  ]);
  assert.deepEqual(
    [...patches[0].data],
    [...southHeights.subarray(0, 2 * SIZE_PX)],
    "south patch keeps the row and column order",
  );
});

test("a tile waits for on-screen neighbours and ignores ring tiles", () => {
  const harness = setup();
  const centre = tile(5, 5);
  harness.pool.update([centre, tile(6, 5), tile(4, 5, "ring"), tile(5, 6, "ring")]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.isDrawable(centre), false);

  failWith(harness, tile(6, 5), "missing");
  harness.pool.update([centre, tile(6, 5), tile(4, 5, "ring"), tile(5, 6, "ring")]);

  assert.equal(harness.pool.isDrawable(centre), true);
});

test("a tile stays drawable when a ring neighbour becomes a view tile", () => {
  const harness = setup();
  const centre = tile(5, 5);
  harness.pool.update([centre, tile(6, 5, "ring")]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.isDrawable(centre), true);

  harness.pool.update([centre, tile(6, 5, "view")]);

  assert.equal(harness.pool.isDrawable(centre), true);
});

test("a tile ignores look-ahead neighbours while it waits for on-screen ones", () => {
  const harness = setup();
  const centre = tile(5, 5);

  harness.pool.update([centre, tile(6, 5, "lookahead")]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.isDrawable(centre), true);
});

test("a tile stays drawable when a look-ahead neighbour becomes a view tile", () => {
  const harness = setup();
  const centre = tile(5, 5);

  harness.pool.update([centre, tile(6, 5, "lookahead")]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.isDrawable(centre), true);

  harness.pool.update([centre, tile(6, 5, "view")]);

  assert.equal(harness.pool.isDrawable(centre), true);
});

test("a tile gives up waiting for a neighbour after 300 ms", () => {
  const harness = setup();
  const centre = tile(5, 5);
  harness.pool.update([centre, tile(6, 5)]);
  land(harness, centre);
  harness.pool.uploadPending();

  harness.advance(299);

  assert.equal(harness.pool.isDrawable(centre), false);

  harness.advance(1);

  assert.equal(harness.pool.isDrawable(centre), true);
});

test("neighbours outside the wanted list do not hold a tile back", () => {
  const harness = setup();
  harness.pool.update([tile(5, 5)]);
  land(harness, tile(5, 5));
  harness.pool.uploadPending();

  assert.equal(harness.pool.isDrawable(tile(5, 5)), true);
});

test("a tile is drawable once its wanted neighbours have landed", () => {
  const harness = setup();
  const centre = tile(5, 5);
  const east = tile(6, 5);

  harness.pool.update([centre, east]);
  land(harness, centre);
  land(harness, east);
  harness.pool.uploadPending();

  assert.equal(harness.pool.isDrawable(centre), true);
  assert.equal(harness.pool.isDrawable(tile(9, 9)), false);
});

test("view readiness needs every view tile while the ring stays out", () => {
  const harness = setup();
  const centre = tile(5, 5);
  const east = tile(6, 5);

  harness.pool.update([centre, east, tile(4, 5, "ring")]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.areViewTilesDrawable(), false);

  land(harness, east);
  harness.pool.uploadPending();

  assert.equal(harness.pool.areViewTilesDrawable(), true);
});

test("view readiness ignores the look-ahead", () => {
  const harness = setup();
  const centre = tile(5, 5);
  const east = tile(6, 5);

  harness.pool.update([centre, east, tile(4, 5, "lookahead")]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.areViewTilesDrawable(), false);

  land(harness, east);
  harness.pool.uploadPending();

  assert.equal(harness.pool.areViewTilesDrawable(), true);
});

test("view readiness waits for pinned tiles", () => {
  const harness = setup();
  const pinned = tile(1, 0, "pinned");
  const centre = tile(5, 5);

  harness.pool.update([pinned, centre]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.equal(harness.pool.areViewTilesDrawable(), false);

  land(harness, pinned);
  harness.pool.uploadPending();

  assert.equal(harness.pool.areViewTilesDrawable(), true);
});

test("coarse tiles wait while higher tiers still need fetches or uploads", () => {
  const harness = setup();
  const view = tile(5, 5);
  const coarse = tile(1, 1, "coarse", 5);

  harness.pool.update([view, coarse]);

  assert.equal(harness.loads().length, 1);

  land(harness, view);
  harness.pool.update([view, coarse]);

  assert.equal(harness.loads().length, 1);

  harness.pool.uploadPending();
  harness.pool.update([view, coarse]);

  assert.equal(harness.loads().length, 2);
});

test("at most two coarse tiles fetch at once", () => {
  const harness = setup();
  const view = [tile(1), tile(2)];
  const coarse = [tile(10, 0, "coarse"), tile(11, 0, "coarse"), tile(12, 0, "coarse")];

  harness.pool.update([...view, ...coarse]);

  for (const entry of view) land(harness, entry);

  harness.pool.uploadPending();
  harness.pool.update([...view, ...coarse]);

  assert.equal(harness.loads().length, 4);

  land(harness, coarse[0]);
  land(harness, coarse[1]);
  harness.pool.update([...view, ...coarse]);

  assert.equal(harness.loads().length, 5);
});

test("coarse uploads stay within the unpinned texture limit", () => {
  const harness = setup();
  const view = Array.from({ length: 96 }, (_, index) => tile(index % 64, Math.floor(index / 64)));

  for (let index = 0; index < view.length; index += 2) {
    const pair = view.slice(index, index + 2);
    harness.pool.update(pair);

    for (const entry of pair) land(harness, entry);

    harness.pool.uploadPending();
  }

  assert.equal(harness.pool.stats().textures, 96);

  const coarse = tile(1, 1, "coarse", 5);

  harness.pool.update([view[94], view[95], coarse]);
  land(harness, coarse);
  harness.pool.uploadPending();

  assert.equal(harness.pool.stats().textures, 96);
  assert.ok(harness.pool.texture(coarse));
});

test("neighbours wrap across the antimeridian", () => {
  const harness = setup({ keepData: true });
  const east = tile(63, 5);
  const west = tile(0, 5);
  harness.pool.update([east, west]);

  const westHeights = new Float32Array(SIZE_PX * SIZE_PX).fill(8);
  land(harness, east);
  land(harness, west, westHeights, edgeStrips(westHeights));
  harness.pool.uploadPending();

  assert.equal(harness.pool.isDrawable(east), true);
  assert.equal(harness.pool.stats().textures, 2);

  const eastData = harness.store!.created.find(
    (entry) => entry.data[TEXTURE_SIZE_PX * 2 + 2] === 0,
  )!.data;

  assert.equal(
    eastData[2 * TEXTURE_SIZE_PX + TEXTURE_SIZE_PX - 2],
    8,
    "east halo holds the west tile's value",
  );
});

test("the least recently used unpinned texture goes first once 96 are held", () => {
  const harness = setup();
  const all = Array.from({ length: 98 }, (_, index) => tile(index % 64, Math.floor(index / 64)));

  for (let index = 0; index < all.length; index += 2) {
    const pair = all.slice(index, index + 2);
    harness.pool.update(pair);

    for (const entry of pair) land(harness, entry);

    harness.pool.uploadPending();
  }

  const stats = harness.pool.stats();

  assert.equal(stats.textures, 96);
  assert.equal(harness.store!.removed.length, 2);
  assert.equal(harness.pool.texture(all[0]), null);
  assert.equal(harness.pool.texture(all[1]), null);
  assert.ok(harness.pool.texture(all[97]));
});

test("pinned textures are never evicted and the byte cap still holds", () => {
  const harness = setup();
  const pinned = Array.from({ length: 60 }, (_, index) => tile(index, 0, "pinned"));
  const view = Array.from({ length: 100 }, (_, index) => tile(index, 1));

  for (let index = 0; index < pinned.length; index += 2) {
    harness.pool.update(pinned.slice(index, index + 2));

    for (const entry of pinned.slice(index, index + 2)) land(harness, entry);
    harness.pool.uploadPending();
  }

  for (let index = 0; index < view.length; index += 2) {
    harness.pool.update([...pinned, ...view.slice(index, index + 2)]);

    for (const entry of view.slice(index, index + 2)) land(harness, entry);
    harness.pool.uploadPending();
  }

  const stats = harness.pool.stats();

  assert.equal(stats.pinnedTextures, 60);
  assert.ok(stats.textureBytes <= 150 * 1024 * 1024);
  assert.equal(stats.textureBytes, stats.textures * TEXTURE_BYTES);
  assert.ok(pinned.every((entry) => harness.pool.texture(entry)));
});

test("a tile re-landed after eviction does not queue halo patches again", () => {
  const harness = setup();
  const centre = tile(5, 5);
  const east = tile(6, 5, "pinned");

  harness.pool.update([centre, east]);
  land(harness, centre);
  land(harness, east);
  harness.pool.uploadPending();

  const eastTexture = harness.pool.texture(east);

  const fillers = Array.from({ length: 96 }, (_, index) =>
    tile(index % 64, Math.floor(index / 64)),
  );

  for (let index = 0; index < fillers.length; index += 2) {
    const pair = fillers.slice(index, index + 2);
    harness.pool.update([east, ...pair]);

    for (const entry of pair) land(harness, entry);

    harness.pool.uploadPending();
  }

  assert.equal(harness.pool.texture(centre), null);

  harness.pool.update([centre, east]);
  land(harness, centre);
  harness.pool.uploadPending();

  assert.ok(harness.pool.texture(centre));
  assert.deepEqual(
    harness.store!.patches.filter((patch) => patch.texture === eastTexture),
    [],
  );
});

test("uploadPending keeps a tile pending when no texture can be evicted", () => {
  const harness = setup();
  const pinned = Array.from({ length: 147 }, (_, index) =>
    tile(index % 64, Math.floor(index / 64), "pinned"),
  );

  for (let index = 0; index < pinned.length; index += 2) {
    const pair = pinned.slice(index, index + 2);
    harness.pool.update(pinned);

    for (const entry of pair) land(harness, entry);

    harness.pool.uploadPending();
  }

  assert.equal(harness.pool.stats().textures, 147);

  const extra = tile(0, 3);
  harness.pool.update([...pinned, extra]);
  land(harness, extra);

  assert.equal(harness.pool.uploadPending(), 0);
  assert.equal(harness.pool.stats().awaitingUpload, 1);
  assert.equal(harness.pool.needsRepaint(), false);
});

test("a texture wanted this frame is not evicted to make room", () => {
  const harness = setup();
  const wanted = Array.from({ length: 98 }, (_, index) => tile(index % 64, Math.floor(index / 64)));

  for (let index = 0; index < 96; index += 2) {
    harness.pool.update(wanted.slice(index, index + 2));

    for (const entry of wanted.slice(index, index + 2)) land(harness, entry);
    harness.pool.uploadPending();
  }

  harness.pool.update(wanted.slice(0, 98));
  land(harness, wanted[96]);
  harness.pool.uploadPending();

  assert.equal(harness.store!.removed.length, 0);
  assert.equal(harness.pool.stats().textures, 97);
});

test("losing the context drops handles, keeps strips and reloads pinned tiles first", () => {
  const harness = setup();
  const wanted = [tile(1, 0, "pinned"), tile(2, 0, "pinned"), tile(3, 0, "view")];
  harness.pool.update(wanted);

  for (const entry of wanted) land(harness, entry);

  harness.pool.uploadPending();
  harness.pool.update(wanted);
  harness.pool.uploadPending();

  const before = harness.loads().length;

  harness.pool.loseContext();
  harness.pool.update(wanted);

  assert.equal(harness.loads().length, before, "nothing loads without a context");
  assert.equal(harness.pool.texture(wanted[0]), null);
  assert.equal(harness.store!.removed.length, 0, "the old handles are not deleted");

  const fresh = new FakeStore();
  harness.pool.useStore(fresh);

  const reloaded = harness
    .loads()
    .slice(before)
    .map((request) => request.type === "load" && request.url);

  assert.deepEqual(reloaded, [
    "https://dem/6/1/0.png",
    "https://dem/6/2/0.png",
    "https://dem/6/3/0.png",
  ]);
  assert.equal(harness.pool.stats().strips, 3);
});

test("decoded tiles wait through a context loss and upload to the new store", () => {
  const harness = setup();
  harness.pool.update([tile(1)]);
  land(harness, tile(1));

  harness.pool.loseContext();

  assert.equal(harness.pool.uploadPending(), 0);

  const fresh = new FakeStore();
  harness.pool.useStore(fresh);

  assert.equal(harness.pool.uploadPending(), 1);
  assert.equal(fresh.created.length, 1);
});

test("stats report counts, bytes, queue depth and decode time", () => {
  const harness = setup();
  const wanted = Array.from({ length: 8 }, (_, index) =>
    tile(index, 0, index === 0 ? "pinned" : "view"),
  );

  harness.pool.update(wanted);
  land(harness, wanted[0]);
  land(harness, wanted[1]);
  harness.pool.uploadPending();

  assert.deepEqual(harness.pool.stats(), {
    textures: 2,
    pinnedTextures: 1,
    textureBytes: 2 * TEXTURE_BYTES,
    texturesPerZoom: { [ZOOM]: 2 },
    inflight: 6,
    queueDepth: 0,
    awaitingUpload: 0,
    strips: 2,
    failures: 0,
    requests: 8,
    loaded: 2,
    uploaded: 2,
    cancelled: 0,
    lastDecodeMs: 4,
    meanDecodeMs: 4,
  });
});

test("request starts count every load including missing, failed and cancelled", () => {
  const harness = setup();
  const successful = tile(1);
  const missing = tile(2);
  const failed = tile(3);
  const cancelled = tile(4);

  harness.pool.update([successful, missing, failed, cancelled]);

  assert.equal(harness.pool.stats().requests, 4);
  assert.equal(harness.pool.stats().loaded, 0);

  land(harness, successful);
  failWith(harness, missing, "missing");
  failWith(harness, failed, "error");

  assert.equal(harness.pool.stats().requests, 4);
  assert.equal(harness.pool.stats().loaded, 1);

  harness.pool.update([]);

  assert.equal(harness.pool.stats().requests, 4);
  assert.equal(harness.pool.stats().loaded, 1);
  assert.equal(harness.pool.stats().cancelled, 1);
  assert.equal(harness.pool.stats().failures, 2);
});

test("has reports held, pending and in-flight tiles so the warmer skips them", () => {
  const harness = setup();
  const wanted = tile(1);

  assert.equal(harness.pool.has(wanted), false);

  harness.pool.update([wanted]);

  assert.equal(harness.pool.has(wanted), true);

  land(harness, wanted);

  assert.equal(harness.pool.has(wanted), true);

  harness.pool.uploadPending();

  assert.equal(harness.pool.has(wanted), true);
  assert.equal(harness.pool.has(tile(2)), false);
});

test("demPoolHas and demPoolStats read the shared pool by url", () => {
  const { map, options } = poolFixture();
  const pool = acquireDemPool(options);

  try {
    assert.equal(demPoolHas(URL_TEMPLATE, tile(1)), false);
    assert.equal(demPoolStats(URL_TEMPLATE)?.textures, 0);

    pool.update([tile(1)]);

    assert.equal(demPoolHas(URL_TEMPLATE, tile(1)), true);
    assert.equal(demPoolHas(URL_TEMPLATE, tile(2)), false);
    assert.equal(demPoolStats()?.inflight, 1);
    assert.equal(demPoolStats("https://other/{z}/{x}/{y}.png"), null);
  } finally {
    releaseDemPool(map, URL_TEMPLATE);
  }

  assert.equal(demPoolHas(URL_TEMPLATE, tile(1)), false);
});

test("a pool is shared per map and url and stopped by the last release", () => {
  const { map, options, workers } = poolFixture();

  const first = acquireDemPool(options);
  const second = acquireDemPool(options);
  const other = acquireDemPool({ ...options, tileUrl: "https://other/{z}/{x}/{y}.png" });

  assert.equal(first, second);
  assert.notEqual(first, other);

  releaseDemPool(map, URL_TEMPLATE);

  assert.equal(
    workers.some((worker) => worker.terminated),
    false,
  );

  releaseDemPool(map, URL_TEMPLATE);

  assert.equal(
    workers.slice(0, 2).every((worker) => worker.terminated),
    true,
  );

  releaseDemPool(map, "https://other/{z}/{x}/{y}.png");
});

function renderEvents() {
  const listeners = new Set<() => void>();
  return {
    on: (_type: "render", listener: () => void) => listeners.add(listener),
    off: (_type: "render", listener: () => void) => listeners.delete(listener),
    fireRender: () => listeners.forEach((listener) => listener()),
  };
}

function poolFixture() {
  const canvas = new EventTarget();
  const map = { getCanvas: () => canvas, triggerRepaint: () => {}, ...renderEvents() };
  const workers: FakeWorker[] = [];
  const options = {
    map,
    gl: {} as WebGL2RenderingContext,
    tileUrl: URL_TEMPLATE,
    createStore: () => new FakeStore(),
    createWorker: () => {
      const worker = new FakeWorker([]);
      workers.push(worker);

      return worker;
    },
  };

  return { map, canvas, options, workers };
}

test("a context loss keeps the pool for the layers that come back", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  const { map, canvas, options, workers } = poolFixture();
  const pool = acquireDemPool(options);
  pool.update([tile(1)]);

  canvas.dispatchEvent(new Event("webglcontextlost"));
  releaseDemPool(map, URL_TEMPLATE);
  canvas.dispatchEvent(new Event("webglcontextrestored"));

  const again = acquireDemPool({ ...options, gl: {} as WebGL2RenderingContext });
  mock.timers.tick(30 * 1000);

  assert.equal(again, pool);
  assert.equal(
    workers.some((worker) => worker.terminated),
    false,
  );

  releaseDemPool(map, URL_TEMPLATE);
  mock.timers.reset();
});

test("a release before the lost event still waits for the layers", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  const canvas = new EventTarget();
  const map = { getCanvas: () => canvas, triggerRepaint: () => {}, ...renderEvents() };
  const workers: FakeWorker[] = [];
  const options = {
    map,
    gl: { isContextLost: () => true } as unknown as WebGL2RenderingContext,
    tileUrl: URL_TEMPLATE,
    createStore: () => new FakeStore(),
    createWorker: () => {
      const worker = new FakeWorker([]);
      workers.push(worker);

      return worker;
    },
  };
  acquireDemPool(options);

  releaseDemPool(map, URL_TEMPLATE);

  assert.equal(
    workers.some((worker) => worker.terminated),
    false,
  );

  mock.timers.tick(30 * 1000);

  assert.equal(
    workers.every((worker) => worker.terminated),
    true,
  );

  mock.timers.reset();
});

test("a pool nobody comes back for is stopped after a context loss", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  const { map, canvas, options, workers } = poolFixture();
  acquireDemPool(options);

  canvas.dispatchEvent(new Event("webglcontextlost"));
  releaseDemPool(map, URL_TEMPLATE);

  assert.equal(
    workers.some((worker) => worker.terminated),
    false,
  );

  mock.timers.tick(30 * 1000);

  assert.equal(
    workers.every((worker) => worker.terminated),
    true,
  );

  mock.timers.reset();
});

test("the GL store uploads R32F with plain unpack settings and patches sub-rectangles", () => {
  const calls: unknown[][] = [];
  const parameters = new Map<number, unknown>([
    [1, true],
    [2, true],
    [3, 8],
  ]);
  const gl = {
    TEXTURE_2D: 10,
    R32F: 11,
    RED: 12,
    FLOAT: 13,
    TEXTURE_MIN_FILTER: 20,
    TEXTURE_MAG_FILTER: 21,
    TEXTURE_WRAP_S: 22,
    TEXTURE_WRAP_T: 23,
    LINEAR: 30,
    NEAREST: 31,
    CLAMP_TO_EDGE: 32,
    UNPACK_FLIP_Y_WEBGL: 1,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 2,
    UNPACK_ALIGNMENT: 3,
    createTexture: () => "texture",
    bindTexture: () => {},
    texParameteri: (...args: unknown[]) => calls.push(["param", ...args]),
    getExtension: () => ({}),
    getParameter: (name: number) => parameters.get(name),
    pixelStorei: (name: number, value: unknown) => calls.push(["unpack", name, value]),
    texImage2D: (...args: unknown[]) =>
      calls.push(["image", ...args.map((arg) => (typeof arg === "object" ? "data" : arg))]),
    texSubImage2D: (...args: unknown[]) => calls.push(["sub", ...args.slice(0, 8)]),
    deleteTexture: (texture: unknown) => calls.push(["delete", texture]),
  } as unknown as WebGL2RenderingContext;
  const store = createGlTextureStore(gl);

  const texture = store.create(new Float32Array(1));
  store.patch(texture, 2, 514, 512, 2, new Float32Array(1));
  store.remove(texture);

  assert.equal(store.linear, true);
  assert.deepEqual(
    calls.filter((call) => call[0] === "param"),
    [
      ["param", 10, 20, 30],
      ["param", 10, 21, 30],
      ["param", 10, 22, 32],
      ["param", 10, 23, 32],
    ],
  );

  const nearest = createGlTextureStore({
    getExtension: () => null,
  } as unknown as WebGL2RenderingContext);

  assert.equal(nearest.linear, false, "contexts without the float-linear extension sample nearest");
  assert.deepEqual(
    calls.filter((call) => call[0] !== "unpack" && call[0] !== "param"),
    [
      ["image", 10, 0, 11, 516, 516, 0, 12, 13, "data"],
      ["sub", 10, 0, 2, 514, 512, 2, 12, 13],
      ["delete", "texture"],
    ],
  );
  assert.deepEqual(calls.filter((call) => call[0] === "unpack").slice(0, 3), [
    ["unpack", 1, false],
    ["unpack", 2, false],
    ["unpack", 3, 4],
  ]);
  assert.deepEqual(calls.filter((call) => call[0] === "unpack").slice(3, 6), [
    ["unpack", 1, true],
    ["unpack", 2, true],
    ["unpack", 3, 8],
  ]);
});
