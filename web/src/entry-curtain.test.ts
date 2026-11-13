import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { Window } from "happy-dom";

import type { Map as MapLibreMap } from "maplibre-gl";

import { REVEAL_MS, revealUnderCurtain } from "./entry-curtain.ts";
import { assertSameNode } from "./testing/dom-assert.ts";

const FADE_AND_GRACE_MS = REVEAL_MS + 100;
const SETTLE_LIMIT_MS = 200;

class FakeMap {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  repaints = 0;
  private readonly listeners = new Map<string, { listener: () => void; once: boolean }[]>();

  constructor(document: Document) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 8;
    this.canvas.height = 4;
    this.container = document.createElement("div");
  }

  getCanvas() {
    return this.canvas;
  }

  getCanvasContainer() {
    return this.container;
  }

  triggerRepaint() {
    this.repaints += 1;
  }

  on(type: string, listener: () => void) {
    this.add(type, listener, false);
  }

  once(type: string, listener: () => void) {
    this.add(type, listener, true);
  }

  off(type: string, listener: () => void) {
    const kept = (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener);
    this.listeners.set(type, kept);
  }

  emit(type: string) {
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) this.off(type, entry.listener);
      entry.listener();
    }
  }

  count(type: string) {
    return (this.listeners.get(type) ?? []).length;
  }

  private add(type: string, listener: () => void, once: boolean) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { listener, once }]);
  }
}

const events: string[] = [];
let window: Window;
let map: FakeMap;
let reducedMotion = false;

beforeEach((context) => {
  events.length = 0;
  reducedMotion = false;
  window = new Window();
  Object.assign(globalThis, {
    document: window.document,
    matchMedia: () => ({ matches: reducedMotion }),
  });
  window.HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => events.push("copy"),
  })) as never;
  map = new FakeMap(window.document as unknown as Document);
  context.mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "matchMedia");
});

function start() {
  return revealUnderCurtain(
    map as unknown as MapLibreMap,
    () => events.push("stage"),
    () => events.push("fade"),
    () => events.push("end"),
  );
}

function picture() {
  return map.container.querySelector("canvas.entry-curtain");
}

test("the copy is made inside the render event and the scene is staged right after it", () => {
  start();

  assert.equal(map.repaints, 1);
  assert.equal(picture(), null);
  assert.deepEqual(events, []);

  map.emit("render");

  assert.deepEqual(events, ["copy", "stage"]);
  assertSameNode(picture(), map.container.lastElementChild);
  assert.equal(picture()?.classList.contains("fading"), false);
});

test("the curtain fades when the staged scene is idle and leaves when its fade ends", async () => {
  const reveal = start();
  map.emit("render");
  map.emit("idle");

  assert.deepEqual(events, ["copy", "stage", "fade"]);
  assert.equal(picture()?.classList.contains("fading"), true);
  assert.equal((picture() as HTMLElement).style.transitionDuration, `${REVEAL_MS}ms`);

  picture()!.dispatchEvent(new window.Event("transitionend"));
  await reveal.done;

  assert.deepEqual(events, ["copy", "stage", "fade", "end"]);
  assert.equal(picture(), null);
  assert.equal(map.count("resize"), 0);
  assert.equal(map.count("idle"), 0);
});

test("a slow tile cannot keep the staged scene hidden past the settle limit", (context) => {
  start();
  map.emit("render");
  context.mock.timers.tick(SETTLE_LIMIT_MS - 1);

  assert.deepEqual(events, ["copy", "stage"]);

  context.mock.timers.tick(1);

  assert.deepEqual(events, ["copy", "stage", "fade"]);
  assert.equal(map.count("idle"), 0);
  assert.ok(!events.includes("end"));
});

test("a fade that never reports its end still removes the picture", async (context) => {
  const reveal = start();
  map.emit("render");
  map.emit("idle");
  context.mock.timers.tick(FADE_AND_GRACE_MS);
  await reveal.done;

  assert.deepEqual(events, ["copy", "stage", "fade", "end"]);
  assert.equal(picture(), null);
});

test("a resize drops the picture at once and still finishes the reveal", async () => {
  const reveal = start();
  map.emit("render");
  map.emit("resize");
  await reveal.done;

  assert.deepEqual(events, ["copy", "stage", "fade", "end"]);
  assert.equal(picture(), null);
  assert.equal(map.count("idle"), 0);
});

test("a resize before the first render stages without any picture", async () => {
  const reveal = start();
  map.emit("resize");
  await reveal.done;

  assert.deepEqual(events, ["stage", "fade", "end"]);
  assert.equal(picture(), null);
  assert.equal(map.count("render"), 0);
});

test("a lost context before the first render stages without any picture", async () => {
  const reveal = start();
  map.canvas.dispatchEvent(new window.Event("webglcontextlost"));
  await reveal.done;

  assert.deepEqual(events, ["stage", "fade", "end"]);
  assert.equal(picture(), null);
  assert.equal(map.count("render"), 0);
});

test("a retired curtain never stages or starts the next phase", async () => {
  const reveal = start();
  reveal.retire();
  await reveal.done;
  map.emit("render");
  map.emit("idle");

  assert.deepEqual(events, []);
  assert.equal(picture(), null);
  assert.equal(map.count("render"), 0);
});

test("retiring after the cover drops the picture without fading", async () => {
  const reveal = start();
  map.emit("render");
  reveal.retire();
  await reveal.done;

  assert.deepEqual(events, ["copy", "stage"]);
  map.emit("idle");

  assert.deepEqual(events, ["copy", "stage"]);
  assert.equal(picture(), null);
});

test("a lost graphics context drops the picture and still finishes the reveal", async () => {
  const reveal = start();
  map.emit("render");
  map.canvas.dispatchEvent(new window.Event("webglcontextlost"));
  await reveal.done;

  assert.deepEqual(events, ["copy", "stage", "fade", "end"]);
  assert.equal(picture(), null);
});

test("cancelling before the first render stages the scene without any picture", async () => {
  const reveal = start();
  reveal.cancel();
  await reveal.done;
  map.emit("render");

  assert.deepEqual(events, ["stage", "fade", "end"]);
  assert.equal(picture(), null);
  assert.equal(map.count("render"), 0);
});

test("cancelling twice runs every step once", async () => {
  const reveal = start();
  map.emit("render");
  reveal.cancel();
  reveal.cancel();
  await reveal.done;

  assert.deepEqual(events, ["copy", "stage", "fade", "end"]);
});

test("reduced motion makes no picture and runs every step at once", async () => {
  reducedMotion = true;
  const reveal = start();
  await reveal.done;

  assert.deepEqual(events, ["stage", "fade", "end"]);
  assert.equal(map.repaints, 0);
  assert.equal(picture(), null);
});
