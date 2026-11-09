import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contourMaxZoomSetting,
  gestureFlags,
  isGestureActive,
  maxPixelRatioSetting,
  prefetchEnabled,
  subscribeGesture,
} from "./gesture-quality.ts";

test("freeze defaults to on while the shader paths need an explicit opt-in", () => {
  assert.deepEqual(gestureFlags(""), {
    freezeLabels: true,
    fastClass: false,
    fastHatch: false,
    bake: false,
  });
  assert.deepEqual(gestureFlags("?freezeLabels=0"), {
    freezeLabels: false,
    fastClass: false,
    fastHatch: false,
    bake: false,
  });
  assert.deepEqual(gestureFlags("?fastClass=1&fastHatch=1"), {
    freezeLabels: true,
    fastClass: true,
    fastHatch: true,
    bake: false,
  });
  assert.deepEqual(gestureFlags("?fastClass=0"), {
    freezeLabels: true,
    fastClass: false,
    fastHatch: false,
    bake: false,
  });
  assert.deepEqual(gestureFlags("?bake=1"), {
    freezeLabels: true,
    fastClass: false,
    fastHatch: false,
    bake: true,
  });
  assert.deepEqual(gestureFlags("?bake=0"), {
    freezeLabels: true,
    fastClass: false,
    fastHatch: false,
    bake: false,
  });
});

test("a measurement cap outside normal device ratios keeps the default", () => {
  assert.equal(maxPixelRatioSetting(""), undefined);
  assert.equal(maxPixelRatioSetting("?maxPixelRatio=1.5"), 1.5);
  assert.equal(maxPixelRatioSetting("?maxPixelRatio=0.1"), undefined);
  assert.equal(maxPixelRatioSetting("?maxPixelRatio=8"), undefined);
  assert.equal(maxPixelRatioSetting("?maxPixelRatio=lots"), undefined);
});

test("a tiling cap outside the zoom range keeps the default tiling", () => {
  assert.equal(contourMaxZoomSetting(""), undefined);
  assert.equal(contourMaxZoomSetting("?contourMaxZoom=11"), 11);
  assert.equal(contourMaxZoomSetting("?contourMaxZoom=11.9"), 11);
  assert.equal(contourMaxZoomSetting("?contourMaxZoom=99"), undefined);
  assert.equal(contourMaxZoomSetting("?contourMaxZoom=deep"), undefined);
});

test("prefetch stays off unless its parameter opts in", () => {
  assert.equal(prefetchEnabled(""), false);
  assert.equal(prefetchEnabled("?prefetch=0"), false);
  assert.equal(prefetchEnabled("?prefetch=1"), true);
  assert.equal(prefetchEnabled("?prefetch=off"), false);
});

test("nested gestures notify once and a stray moveend is ignored", () => {
  const map = fakeMap();
  const calls: string[] = [];
  subscribeGesture(map, { onStart: () => calls.push("start"), onEnd: () => calls.push("end") });

  map.emit("moveend");
  map.emit("movestart");
  map.emit("movestart");
  assert.deepEqual(calls, ["start"]);
  assert.equal(isGestureActive(map), true);

  map.emit("moveend");
  assert.deepEqual(calls, ["start"]);
  map.emit("moveend");
  assert.deepEqual(calls, ["start", "end"]);
  assert.equal(isGestureActive(map), false);
});

test("a late subscriber starts at once and leaving mid-gesture restores it", () => {
  const map = fakeMap();
  const calls: string[] = [];
  const stopFirst = subscribeGesture(map, {
    onStart: () => calls.push("first start"),
    onEnd: () => calls.push("first end"),
  });

  map.emit("movestart");
  const stopLate = subscribeGesture(map, {
    onStart: () => calls.push("late start"),
    onEnd: () => calls.push("late end"),
  });
  assert.deepEqual(calls, ["first start", "late start"]);

  stopLate();
  assert.deepEqual(calls, ["first start", "late start", "late end"]);

  map.emit("moveend");
  assert.deepEqual(calls, ["first start", "late start", "late end", "first end"]);
  stopFirst();
});

test("the last unsubscribe removes the shared listeners", () => {
  const map = fakeMap();
  const stop = subscribeGesture(map, { onStart() {}, onEnd() {} });

  assert.equal(map.listenerCount("movestart"), 1);
  assert.equal(map.listenerCount("moveend"), 1);
  stop();

  assert.equal(map.listenerCount("movestart"), 0);
  assert.equal(map.listenerCount("moveend"), 0);
  assert.equal(isGestureActive(map), false);
});

test("a map without event methods subscribes to nothing", () => {
  const stop = subscribeGesture({}, { onStart() {}, onEnd() {} });

  assert.doesNotThrow(stop);
});

function fakeMap() {
  const listeners = new Map<string, Set<() => void>>();

  return {
    on(type: string, listener: () => void) {
      const entries = listeners.get(type) ?? new Set<() => void>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}
