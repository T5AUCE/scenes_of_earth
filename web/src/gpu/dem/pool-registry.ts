/** Share DEM pools between layers and retain them while a lost map context is restored. */
import { TEXTURE_SIZE_PX } from "./halo";
import type { WantedTile } from "./plan";
import { DemPool, type DemPoolStats, type DemTextureStore, type DemWorkerPort } from "./pool";
import type { DemWorkerResponse } from "./worker";

interface PoolEntry {
  pool: DemPool;
  refs: number;
  gl: WebGL2RenderingContext | null;
  lost: boolean;
  dispose: () => void;
}

/** The part of a MapLibre map the registry uses. */
export interface DemPoolMap {
  getCanvas(): EventTarget;
  triggerRepaint(): void;
  on(type: "render", listener: () => void): unknown;
  off(type: "render", listener: () => void): unknown;
}

/** The map and tile source of a shared pool, with optional test substitutes. */
export interface AcquireDemPoolOptions {
  map: DemPoolMap;
  gl: WebGL2RenderingContext;
  tileUrl: string;
  createStore?: (gl: WebGL2RenderingContext) => DemTextureStore;
  createWorker?: () => DemWorkerPort;
  now?: () => number;
}

// Layers removed by a context loss return shortly, so the pool waits for them.
const LOST_CONTEXT_GRACE_MS = 30 * 1000;

const pools = new WeakMap<DemPoolMap, Map<string, PoolEntry>>();
// One pool per tile URL lets background downloads and measurements read it without the map.
const poolsByUrl = new Map<string, DemPool>();

/** Get the map's pool for a tile URL, creating it on first use; pair with `releaseDemPool`. */
export function acquireDemPool(options: AcquireDemPoolOptions): DemPool {
  const { map, gl, tileUrl } = options;
  const createStore = options.createStore ?? createGlTextureStore;
  let entry = pools.get(map)?.get(tileUrl);

  if (!entry) entry = createEntry(options, createStore);

  entry.refs++;

  if (entry.gl !== gl) {
    entry.gl = gl;
    entry.pool.useStore(createStore(gl));
  }

  return entry.pool;
}

function createEntry(
  options: AcquireDemPoolOptions,
  createStore: (gl: WebGL2RenderingContext) => DemTextureStore,
): PoolEntry {
  const { map, gl, tileUrl } = options;
  const canvas = map.getCanvas();
  const pool = new DemPool({
    tileUrl,
    store: createStore(gl),
    createWorker: options.createWorker ?? createDemWorker,
    now: options.now,
    onChange: () => map.triggerRepaint(),
  });

  const onLost = () => {
    entry.lost = true;
    entry.gl = null;
    pool.loseContext();
  };
  const onRestored = () => {
    entry.lost = false;
  };
  const onRender = () => pool.endMapFrame();

  const entry: PoolEntry = {
    pool,
    refs: 0,
    gl,
    lost: false,
    dispose: () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      map.off("render", onRender);
    },
  };

  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  map.on("render", onRender);

  const mapPools = pools.get(map) ?? new Map<string, PoolEntry>();
  mapPools.set(tileUrl, entry);
  pools.set(map, mapPools);
  poolsByUrl.set(tileUrl, pool);

  return entry;
}

/** End one layer's use of a pool; the last release stops its workers. */
export function releaseDemPool(map: DemPoolMap, tileUrl: string): void {
  const entry = pools.get(map)?.get(tileUrl);
  if (!entry || --entry.refs > 0) return;

  // A release that runs before the lost event still sees a lost context here.
  const glLost = entry.gl?.isContextLost?.() ?? false;

  if (entry.lost || glLost) {
    setTimeout(() => destroyIfUnused(map, tileUrl, entry), LOST_CONTEXT_GRACE_MS);
  } else destroyEntry(map, tileUrl, entry);
}

function destroyIfUnused(map: DemPoolMap, tileUrl: string, entry: PoolEntry): void {
  if (entry.refs > 0 || pools.get(map)?.get(tileUrl) !== entry) return;

  destroyEntry(map, tileUrl, entry);
}

function destroyEntry(map: DemPoolMap, tileUrl: string, entry: PoolEntry): void {
  entry.dispose();
  entry.pool.destroy();
  pools.get(map)?.delete(tileUrl);

  if (poolsByUrl.get(tileUrl) === entry.pool) poolsByUrl.delete(tileUrl);
}

/** Whether the URL's pool holds a tile or already fetches it, so background downloads skip it. */
export function demPoolHas(tileUrl: string, tile: Pick<WantedTile, "z" | "x" | "y">): boolean {
  return poolsByUrl.get(tileUrl)?.has(tile) ?? false;
}

/** The stats of the URL's pool, or the summed stats when no URL is given. */
export function demPoolStats(tileUrl?: string): DemPoolStats | null {
  if (tileUrl) return poolsByUrl.get(tileUrl)?.stats() ?? null;

  const live = [...poolsByUrl.values()];
  if (live.length === 0) return null;
  if (live.length === 1) return live[0].stats();

  return sumPoolStats(live.map((pool) => pool.stats()));
}

function sumPoolStats(all: DemPoolStats[]): DemPoolStats {
  const totals = {
    textures: 0,
    pinnedTextures: 0,
    textureBytes: 0,
    inflight: 0,
    queueDepth: 0,
    awaitingUpload: 0,
    strips: 0,
    failures: 0,
    requests: 0,
    loaded: 0,
    uploaded: 0,
    cancelled: 0,
  };
  const keys = Object.keys(totals) as (keyof typeof totals)[];
  const texturesPerZoom: Record<number, number> = {};
  let totalDecodeMs = 0;

  for (const stats of all) {
    for (const key of keys) totals[key] += stats[key];

    for (const [zoom, count] of Object.entries(stats.texturesPerZoom)) {
      texturesPerZoom[Number(zoom)] = (texturesPerZoom[Number(zoom)] ?? 0) + count;
    }

    totalDecodeMs += stats.meanDecodeMs * stats.loaded;
  }

  return {
    ...totals,
    texturesPerZoom,
    lastDecodeMs: Math.max(...all.map((stats) => stats.lastDecodeMs)),
    meanDecodeMs: totals.loaded === 0 ? 0 : totalDecodeMs / totals.loaded,
  };
}

/** Whether the pools hold every required base and view tile, or null without a pool. */
export function demPoolViewReady(tileUrl?: string): boolean | null {
  if (tileUrl) return poolsByUrl.get(tileUrl)?.areViewTilesDrawable() ?? null;

  const live = [...poolsByUrl.values()];
  if (live.length === 0) return null;

  return live.every((pool) => pool.areViewTilesDrawable());
}

try {
  // The trial reads the pool through the page, so these hooks remain available.
  const scope = globalThis as unknown as {
    __getDemPoolStats?: typeof demPoolStats;
    __getDemPoolViewReady?: typeof demPoolViewReady;
  };
  scope.__getDemPoolStats = demPoolStats;
  scope.__getDemPoolViewReady = demPoolViewReady;
} catch {
  // A missing window must not break the pool it would report on.
}

/** Start a DEM worker using a URL the bundler can resolve. */
export function createDemWorker(): DemWorkerPort {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

  return {
    post: (request) => worker.postMessage(request),
    onResponse: (handler) => {
      worker.onmessage = (event: MessageEvent<DemWorkerResponse>) => handler(event.data);
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Store R32F textures in a WebGL2 context. The float-linear extension enables linear filtering.
 * Contexts without it use nearest filtering.
 */
export function createGlTextureStore(gl: WebGL2RenderingContext): DemTextureStore {
  const linear = gl.getExtension("OES_texture_float_linear") !== null;
  const filter = linear ? gl.LINEAR : gl.NEAREST;

  return {
    linear,
    create(data) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Cannot allocate a DEM texture");

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      withPlainUnpack(gl, () => {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.R32F,
          TEXTURE_SIZE_PX,
          TEXTURE_SIZE_PX,
          0,
          gl.RED,
          gl.FLOAT,
          data,
        );
      });

      return texture;
    },
    patch(texture, x, y, width, height, data) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      withPlainUnpack(gl, () => {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RED, gl.FLOAT, data);
      });
    },
    remove: (texture) => gl.deleteTexture(texture),
  };
}

// MapLibre leaves its own image unpack settings behind, which must not touch height data.
function withPlainUnpack(gl: WebGL2RenderingContext, upload: () => void): void {
  const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
  const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
  const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

  upload();

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
}
