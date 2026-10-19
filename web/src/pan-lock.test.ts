import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { LngLat, type Map as MapLibreMap, MercatorCoordinate } from "maplibre-gl";

import { clampAround, nearestEquivalent, panLimit } from "./pan-lock.ts";

const FLOAT_TOLERANCE = 1e-12;

const rootUrl = new URL("./", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export {};", shortCircuit: true };
    }
    if (
      context.parentURL?.startsWith(rootUrl)
      && specifier.startsWith(".")
      && !specifier.endsWith(".ts")
    ) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { lockPan } = await import("./map.ts").finally(() => hooks.deregister());

test("at or below the fitted zoom the view cannot move", () => {
  assert.equal(panLimit(0.2, 5, 5), 0);
  assert.equal(panLimit(0.2, 5, 4.7), 0);
});

test("one zoom level in leaves a quarter of the fitted span on each side", () => {
  assert.ok(Math.abs(panLimit(0.2, 5, 6) - 0.05) < FLOAT_TOLERANCE);
});

test("a position is held within the limit around the centre", () => {
  assert.equal(clampAround(10, 4, 2), 6);
  assert.equal(clampAround(-1, 4, 2), 2);
  assert.equal(clampAround(5, 4, 2), 5);
});

test("a value is moved by whole periods to lie nearest the reference", () => {
  assert.equal(nearestEquivalent(-178.5, 181.5, 360), 181.5);
  assert.equal(nearestEquivalent(181.5, -178.5, 360), -178.5);
  assert.equal(nearestEquivalent(30, 35, 360), 30);
});

test("Fiji pan corrections settle after projection round-off at z6.5 and z7.5", () => {
  const fitted = { center: new LngLat(181.5, -17), zoom: 6.23 };
  for (const zoom of [6.5, 7.5]) {
    const map = new TestMap(fitted.center, fitted.zoom);
    const unlock = lockPan(map as unknown as MapLibreMap, fitted);
    map.jumpTo(new LngLat(177.55, -18), zoom);

    assert.equal(map.corrections, 1);
    const centre = MercatorCoordinate.fromLngLat(map.getCenter());
    const fittedCentre = MercatorCoordinate.fromLngLat(fitted.center);
    const fittedWorldPx = 512 * 2 ** fitted.zoom;
    assert.ok(
      Math.abs(centre.x - fittedCentre.x)
        <= panLimit(1280 / fittedWorldPx, fitted.zoom, zoom) + FLOAT_TOLERANCE,
    );
    assert.ok(
      Math.abs(centre.y - fittedCentre.y)
        <= panLimit(800 / fittedWorldPx, fitted.zoom, zoom) + FLOAT_TOLERANCE,
    );
    const settled = map.getCenter();
    map.emitMove();
    assert.equal(map.corrections, 1);
    assert.deepEqual(map.getCenter(), settled);
    unlock();
    assert.equal(map.listeners.size, 0);
  }
});

test("pan locking still restores the fitted centre when zooming back out", () => {
  const fitted = { center: new LngLat(181.5, -17), zoom: 6.23 };
  const map = new TestMap(fitted.center, fitted.zoom);
  const unlock = lockPan(map as unknown as MapLibreMap, fitted);
  map.jumpTo(new LngLat(177.55, -18), 5);

  assert.equal(map.corrections, 1);
  assert.ok(Math.abs(map.getCenter().lng - fitted.center.lng) < FLOAT_TOLERANCE);
  assert.ok(Math.abs(map.getCenter().lat - fitted.center.lat) < FLOAT_TOLERANCE);
  unlock();
});

class TestMap {
  readonly listeners = new Set<() => void>();
  corrections = 0;
  private centre: LngLat;
  private zoom: number;

  constructor(centre: LngLat, zoom: number) {
    this.centre = centre;
    this.zoom = zoom;
  }

  getCanvas() { return { clientWidth: 1280, clientHeight: 800 }; }
  getCenter() { return this.centre; }
  getZoom() { return this.zoom; }
  on(_event: string, listener: () => void) { this.listeners.add(listener); }
  off(_event: string, listener: () => void) { this.listeners.delete(listener); }
  emitMove() { this.listeners.forEach((listener) => listener()); }

  jumpTo(centre: LngLat, zoom: number) {
    this.centre = centre;
    this.zoom = zoom;
    this.emitMove();
  }

  setCenter(centre: LngLat) {
    this.corrections += 1;
    assert.equal(this.corrections, 1, "A pan correction must not recurse");
    this.centre = centre;
    this.emitMove();
  }
}
