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
} = await import("./map.ts").finally(() => hooks.deregister());

test("the tile cache cap covers both desktop viewports", () => {
  assert.equal(MAX_TILE_CACHE_ZOOM_LEVELS, 8);
  assert.equal(outOfViewSlots(1280, 800), 96);
  assert.equal(outOfViewSlots(1920, 1080), 160);
  assert.equal(MAX_TILE_CACHE_SIZE, outOfViewSlots(1920, 1080));
});

/** Mirror MapLibre's per-source out-of-view slots for one viewport at 512 px tiles. */
function outOfViewSlots(widthPx: number, heightPx: number): number {
  return (Math.ceil(widthPx / TILE_SIZE_PX) + 1)
    * (Math.ceil(heightPx / TILE_SIZE_PX) + 1)
    * MAX_TILE_CACHE_ZOOM_LEVELS;
}
