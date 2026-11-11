import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }

    return next(specifier, context);
  },
});
const {
  MAX_TILE_CACHE_SIZE,
  MAX_TILE_CACHE_ZOOM_LEVELS,
  TILE_SIZE_PX,
  warmHiddenRaster,
} = await import("./map.ts").finally(() => hooks.deregister());

test("the tile cache cap covers both desktop viewports", () => {
  assert.equal(MAX_TILE_CACHE_ZOOM_LEVELS, 8);
  assert.equal(outOfViewSlots(1280, 800), 96);
  assert.equal(outOfViewSlots(1920, 1080), 160);
  assert.equal(MAX_TILE_CACHE_SIZE, outOfViewSlots(1920, 1080));
});

test("warming prepares the real source even when it already reports loaded", async () => {
  const map = fakeRasterMap(true);
  await warmHiddenRaster(map as never, "blend-series");

  assert.deepEqual(map.zoomWrites[0], [0, 24]);
  assert.deepEqual(map.zoomWrites.at(-1), [5, 12]);
  assert.equal(map.repaints, 1);
});

test("an aborted warming settles at once with cancellation", async () => {
  const map = fakeRasterMap(false);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(warmHiddenRaster(map as never, "blend-series", controller.signal), (
    error: unknown,
  ) => (error as Error).name === "AbortError");
  assert.equal(map.repaints, 0);
});

function fakeRasterMap(isLoaded: boolean) {
  const zoomWrites: [number, number][] = [];
  return {
    zoomWrites,
    repaints: 0,
    getLayer: () => ({ minzoom: 5, maxzoom: 12 }),
    isSourceLoaded: () => isLoaded,
    getPaintProperty: () => 0.8,
    setPaintProperty() {},
    setLayerZoomRange(_id: string, minzoom: number, maxzoom: number) {
      zoomWrites.push([minzoom, maxzoom]);
    },
    triggerRepaint() {
      this.repaints += 1;
    },
  };
}

/** Mirror MapLibre's per-source out-of-view slots for one viewport at 512 px tiles. */
function outOfViewSlots(widthPx: number, heightPx: number): number {
  return (Math.ceil(widthPx / TILE_SIZE_PX) + 1)
    * (Math.ceil(heightPx / TILE_SIZE_PX) + 1)
    * MAX_TILE_CACHE_ZOOM_LEVELS;
}
