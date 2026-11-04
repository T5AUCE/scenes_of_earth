import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Window } from "happy-dom";

import { createStepReader } from "./data.ts";
import { PLAY_SPEED_KEY } from "./playback.ts";
import {
  createTimeline,
  formatTime,
  latestOnly,
  scrubberTimes,
  stepAt,
  type TimelineOptions,
  unionTimes,
} from "./timeline.ts";
import type { LayerView } from "./types.ts";

const monthly = ["2020-01-01", "2020-02-01", "2020-03-01"];
const monthlyEnd = "2020-04-01";
const FRAME_MS = 16;
const SETTLE_STEP_MS = 100;
const quarter = ["2020-01-01", "2020-02-01", "2020-03-01"];
const sixMonths = [...quarter, "2020-04-01", "2020-05-01", "2020-06-01"];
const seventySix = Array.from({ length: 76 }, (_, index) => {
  return `2020-${String(index + 1).padStart(2, "0")}-01`;
});
const sixteenDay = ["2020-01-01", "2020-01-17", "2020-02-02", "2020-02-18"];

test("union of a monthly and a 16-day axis is sorted without duplicates", () => {
  assert.deepEqual(unionTimes([monthly, sixteenDay]), [
    "2020-01-01",
    "2020-01-17",
    "2020-02-01",
    "2020-02-02",
    "2020-02-18",
    "2020-03-01",
  ]);
});

test("a layer holds its last step until the next one starts", () => {
  assert.equal(stepAt(monthly, monthlyEnd, "2020-02-01"), 1);
  assert.equal(stepAt(monthly, monthlyEnd, "2020-02-18"), 1);
  assert.equal(stepAt(sixteenDay, "2020-03-05", "2020-02-01"), 1);
});

test("a five-year step holds until its period ends", () => {
  const fiveYearly = ["2015-01-01", "2020-01-01"];

  assert.equal(stepAt(fiveYearly, "2025-01-01", "2024-12-31"), 1);
  assert.equal(stepAt(fiveYearly, "2025-01-01", "2025-01-01"), -1);
});

test("a time outside the axis gives no step", () => {
  assert.equal(stepAt(monthly, monthlyEnd, "2019-12-31"), -1);
  assert.equal(stepAt(monthly, monthlyEnd, "2020-04-01"), -1);
  assert.equal(stepAt([], "2020-01-01", "2020-01-01"), -1);
});

test("the scrubber starts at the period start when a coarse layer began earlier", () => {
  const fiveYearly = ["2015-01-01", "2020-01-01"];
  const period = { start: "2019-01-01", end: "2021-01-01" };
  const monthlyRain = ["2019-01-01", "2019-02-01", "2019-03-01"];

  assert.deepEqual(scrubberTimes([fiveYearly, monthlyRain], period), [
    "2019-01-01",
    "2019-02-01",
    "2019-03-01",
    "2020-01-01",
  ]);
});

test("labels show only as much date as the finest step needs", () => {
  assert.equal(formatTime("2020-02-01", ["P1M"]), "2020-02");
  assert.equal(formatTime("2020-02-01", ["P1M", "P16D"]), "2020-02-01");
  assert.equal(formatTime("2020-01-01", ["P5Y"]), "2020");
});

test("while a step is loading, only the latest later step is loaded", async () => {
  const loaded: number[] = [];
  let finishFirst: () => void = () => {};
  const draw = latestOnly(async (step: number) => {
    loaded.push(step);
    if (step === 0) await new Promise<void>((resolve) => (finishFirst = resolve));
  });

  const firstRun = draw(0);
  draw(1);
  draw(2);
  draw(3);
  finishFirst();
  await firstRun;

  assert.deepEqual(loaded, [0, 3]);
});

test("steps given one after another are each loaded", async () => {
  const loaded: number[] = [];
  const draw = latestOnly(async (step: number) => {
    loaded.push(step);
  });

  await draw(1);
  await draw(2);

  assert.deepEqual(loaded, [1, 2]);
});

test("play fires only when the shown step changes", (context) => {
  const playing: boolean[] = [];
  const { browser, shown, timeline } = mount(
    context,
    quarter,
    {
      onPlayingChange: (active) => playing.push(active),
    },
  );

  playButton(timeline.element).click();
  assert.deepEqual(playing, [true]);

  browser.advance(100);
  assert.deepEqual(shown, []);
  browser.advance(1100);
  assert.deepEqual(shown, ["2020-02-01"]);
  assert.deepEqual(playing, [true]);

  playButton(timeline.element).click();
  assert.deepEqual(playing, [true, false]);
});

test("the speed control is labelled and remembered", (context) => {
  const { browser, shown, timeline } = mount(context, quarter);
  const select = speedSelect(timeline.element);

  assert.equal(selectLabel(timeline.element), "Playback speed");
  assert.deepEqual(speedValues(select), ["0.5", "1", "2", "4"]);
  assert.equal(select.value, "1");

  playButton(timeline.element).click();
  chooseSpeed(timeline.element, "2");
  assert.equal(browser.storage.get(PLAY_SPEED_KEY), "2");
  assert.deepEqual(shown, []);
});

test("a speed change partway through a hold scales the time left", (context) => {
  const { browser, shown, timeline } = mount(context, quarter);
  playButton(timeline.element).click();
  browser.advance(600);

  chooseSpeed(timeline.element, "2");
  browser.advance(250);
  assert.deepEqual(shown, []);
  browser.advance(30);

  assert.deepEqual(shown, ["2020-02-01"]);
});

test("a speed change during a fade keeps the fade phase", (context) => {
  const { browser, shown, timeline } = mount(context, quarter);
  playButton(timeline.element).click();
  browser.advance(1000);
  assert.deepEqual(shown, []);

  chooseSpeed(timeline.element, "4");
  browser.advance(48);

  assert.deepEqual(shown, ["2020-02-01"]);
});

test("a blocked store keeps the visit speed without throwing", (context) => {
  const browser = installTimelineBrowser(
    context,
    {
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    },
  );
  const timeline = createTimeline(["2020-01-01", "2020-02-01"], ["P1M"], () => {});
  context.after(() => timeline.destroy());
  browser.attach(timeline.element);
  const select = speedSelect(timeline.element);

  assert.equal(select.value, "1");
  chooseSpeed(timeline.element, "4");
  assert.equal(select.value, "4");
});

test("a stall holds the step and marks the label loading", async (context) => {
  const view = fakeView(quarter);
  const { browser, shown, timeline } = mount(context, quarter, { views: [view] });
  view.block("2020-02-01");

  playButton(timeline.element).click();
  browser.advance(1200);
  assert.deepEqual(shown, []);
  assert.equal(labelOf(timeline.element).textContent, "2020-01");

  browser.advance(400);
  assert.deepEqual(shown, []);
  assert.equal(labelOf(timeline.element).classList.contains("loading"), true);

  view.unblock("2020-02-01");
  await settle();
  browser.advance(16);
  assert.deepEqual(shown, ["2020-02-01"]);
  assert.equal(labelOf(timeline.element).classList.contains("loading"), false);
});

test("a blocked step is waited for and the ready one after it cannot overtake", async (context) => {
  const view = fakeView(quarter);
  const { browser, shown, timeline } = mount(context, quarter, { views: [view] });
  view.block("2020-02-01");

  playButton(timeline.element).click();
  browser.advance(10 * 1000);
  assert.deepEqual(shown, []);

  view.unblock("2020-02-01");
  await settle();
  browser.advance(32);
  assert.deepEqual(shown, ["2020-02-01"]);

  browser.advance(1500);
  assert.deepEqual(shown, ["2020-02-01", "2020-03-01"]);
});

test("a step that left the window is prepared again on the next loop", async (context) => {
  const view = fakeView(sixMonths);
  const { browser, timeline } = mount(context, sixMonths, { views: [view] });

  playButton(timeline.element).click();
  await advanceSettling(browser, 10500);

  assert.equal(view.calls.filter((time) => time === "2020-03-01").length, 2);
});

test("replaying after a scrub waits for steps that were prepared before", async (context) => {
  const view = fakeView(quarter);
  const { browser, shown, timeline } = mount(context, quarter, { views: [view] });
  playButton(timeline.element).click();
  browser.advance(100);
  playButton(timeline.element).click();
  view.calls.length = 0;
  view.block("2020-02-01");

  playButton(timeline.element).click();
  browser.advance(3000);

  assert.ok(view.calls.includes("2020-02-01"));
  assert.deepEqual(shown, []);
});

test("play waits only for views the viewer can see", async (context) => {
  const shownView = fakeView(quarter);
  const hiddenView = fakeView(quarter);
  hiddenView.block("2020-02-01");
  const visibility = fakeVisibility([shownView]);
  const { browser, shown, timeline } = mount(
    context,
    quarter,
    {
      views: [shownView, hiddenView],
      visibility,
    },
  );

  playButton(timeline.element).click();
  await advanceSettling(browser, 1200);

  assert.deepEqual(shown, ["2020-02-01"]);
  assert.deepEqual(hiddenView.calls, []);
});

test("hiding the blocked view releases play at once", (context) => {
  const blockedView = fakeView(quarter);
  blockedView.block("2020-02-01");
  const visibility = fakeVisibility([blockedView]);
  const { browser, shown, timeline } = mount(
    context,
    quarter,
    {
      views: [blockedView],
      visibility,
    },
  );
  playButton(timeline.element).click();
  browser.advance(3000);
  assert.deepEqual(shown, []);

  visibility.hide(blockedView);
  browser.advance(16);

  assert.deepEqual(shown, ["2020-02-01"]);
});

test("a view shown during play is prepared for the coming steps", (context) => {
  const lateView = fakeView(quarter);
  const visibility = fakeVisibility([]);
  const { browser, timeline } = mount(context, quarter, { views: [lateView], visibility });
  playButton(timeline.element).click();
  browser.advance(100);
  assert.deepEqual(lateView.calls, []);

  visibility.show(lateView);

  assert.deepEqual(lateView.calls, ["2020-02-01", "2020-03-01"]);
});

test("the whole lookahead is requested nearest first and wraps past the end", (context) => {
  const view = fakeView(seventySix);
  const { timeline } = mount(context, seventySix, { views: [view] });
  timeline.goTo(seventySix[74]);

  playButton(timeline.element).click();

  assert.deepEqual(view.calls, [75, 0, 1, 2, 3, 4, 5, 6, 7].map((index) => seventySix[index]));
  assert.deepEqual(new Set(view.lookaheads), new Set([9]));
});

test("faster play tells the layers to keep a longer lookahead", (context) => {
  const view = fakeView(seventySix);
  const { timeline } = mount(context, seventySix, { views: [view] });
  chooseSpeed(timeline.element, "4");

  playButton(timeline.element).click();

  assert.equal(view.calls.length, 12);
  assert.deepEqual(new Set(view.lookaheads), new Set([12]));
});

test("a scrub during a stall draws instantly and stops play", (context) => {
  const view = fakeView(quarter);
  const playing: boolean[] = [];
  const { browser, shown, timeline } = mount(
    context,
    quarter,
    {
      views: [view],
      onPlayingChange: (active) => playing.push(active),
    },
  );
  view.block("2020-02-01");

  playButton(timeline.element).click();
  browser.advance(1200);
  assert.deepEqual(shown, []);

  timeline.move(2);
  assert.deepEqual(shown, ["2020-03-01"]);
  assert.deepEqual(playing, [true, false]);
  assert.equal(timeline.isPlaying, false);
});

test("destroy drops a pending prepare without drawing late", async (context) => {
  const view = fakeView(quarter);
  const { browser, shown, timeline } = mount(context, quarter, { views: [view] });
  view.block("2020-02-01");

  playButton(timeline.element).click();
  browser.advance(1200);
  assert.deepEqual(shown, []);

  timeline.destroy();
  view.unblock("2020-02-01");
  await settle();
  browser.advance(1000);
  assert.deepEqual(shown, []);
});

test("play never reaches a step whose prepared data was evicted from the real reader", async (context) => {
  const view = readerView(seventySix);
  const { browser, shown, timeline } = mount(context, seventySix, { views: [view] });
  chooseSpeed(timeline.element, "4");

  playButton(timeline.element).click();
  await advanceSettling(browser, 1500);

  assert.ok(shown.length > 6);
  assert.deepEqual([...view.loads.values()].filter((count) => count > 1), []);
});

test("pausing, scrubbing and destroying release the views' prefetched steps", (context) => {
  const view = fakeView(quarter);
  const { timeline } = mount(context, quarter, { views: [view] });

  playButton(timeline.element).click();
  assert.equal(view.releases, 0);
  playButton(timeline.element).click();
  assert.equal(view.releases, 1);

  playButton(timeline.element).click();
  timeline.goTo(quarter[2]);
  assert.equal(view.releases, 2);

  playButton(timeline.element).click();
  timeline.destroy();
  assert.equal(view.releases, 3);
});

function mount(
  context: { after(hook: () => void): void },
  times: string[],
  options: TimelineOptions = {},
) {
  const browser = installTimelineBrowser(context, {});
  const shown: string[] = [];
  const timeline = createTimeline(
    times,
    ["P1M"],
    (time) => {
      shown.push(time);
      options.views?.forEach((view) => view.setTime(time));
    },
    options,
  );
  context.after(() => timeline.destroy());
  browser.attach(timeline.element);
  shown.length = 0;

  return { browser, shown, timeline };
}

async function advanceSettling(browser: { advance(ms: number): void }, ms: number) {
  for (let left = ms; left > 0; left -= SETTLE_STEP_MS) {
    browser.advance(Math.min(left, SETTLE_STEP_MS));
    await settle();
  }
}

function chooseSpeed(element: HTMLElement, value: string) {
  const select = speedSelect(element);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function fakeVisibility(initial: LayerView[]) {
  const visible = new Set(initial);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    isVisible: (view: LayerView) => visible.has(view),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hide(view: LayerView) {
      visible.delete(view);
      notify();
    },
    show(view: LayerView) {
      visible.add(view);
      notify();
    },
  };
}

function fakeView(times: string[]) {
  const gates = new Map<string, { wait: Promise<void>; release: () => void }>();
  const view = {
    calls: [] as string[],
    releases: 0,
    lookaheads: [] as number[],
    time: { step: "P1M", values: times, end: "2030-01-01", method: null },
    parts: [],
    options: [],
    setTime() {},
    legend() {
      return null;
    },
    destroy() {},
    block(time: string) {
      if (gates.has(time)) return;

      let release!: () => void;
      const wait = new Promise<void>((done) => {
        release = done;
      });
      gates.set(time, { wait, release });
    },
    unblock(time: string) {
      gates.get(time)?.release();
      gates.delete(time);
    },
    release() {
      view.releases += 1;
    },
    async prepare(time: string, lookahead: number) {
      view.calls.push(time);
      view.lookaheads.push(lookahead);
      await gates.get(time)?.wait;
    },
  } as unknown as LayerView & {
    calls: string[];
    releases: number;
    lookaheads: number[];
    block(time: string): void;
    unblock(time: string): void;
  };
  return view;
}

function readerView(times: string[]) {
  const loads = new Map<number, number>();
  const reader = createStepReader(
    { nx: 800, ny: 800 },
    async (step) => {
      loads.set(step, (loads.get(step) ?? 0) + 1);
      return new Float32Array(1);
    },
  );
  const view = {
    loads,
    time: { step: "P1M", values: times, end: "2030-01-01", method: null },
    parts: [],
    options: [],
    setTime(time: string) {
      void reader.read(times.indexOf(time));
    },
    legend() {
      return null;
    },
    destroy() {},
    release() {
      reader.release();
    },
    async prepare(time: string, lookahead: number) {
      reader.keep(lookahead);
      await reader.read(times.indexOf(time), false);
    },
  } as unknown as LayerView & { loads: Map<number, number> };
  return view;
}

function installTimelineBrowser(
  context: { after(hook: () => void): void },
  options: { storage?: object },
) {
  const window = new Window({ url: "http://localhost/" });
  context.after(() => window.happyDOM.abort());
  const names = ["Node", "Element", "HTMLElement", "DocumentFragment", "Event"] as const;
  const previous = new Map<string, unknown>();
  for (const name of names) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true });
  }
  previous.set("document", (globalThis as Record<string, unknown>).document);
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });

  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
    ...options.storage,
  };
  previous.set("localStorage", (globalThis as Record<string, unknown>).localStorage);
  Object.assign(globalThis, { localStorage: storage });

  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  previous.set("matchMedia", (globalThis as Record<string, unknown>).matchMedia);
  Object.assign(globalThis, { matchMedia: () => media });

  let now = 0;
  const callbacks = new Map<number, (time: number) => void>();
  let nextId = 1;
  const globalRecord = globalThis as Record<string, unknown>;
  previous.set("requestAnimationFrame", globalRecord.requestAnimationFrame);
  previous.set("cancelAnimationFrame", globalRecord.cancelAnimationFrame);
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: (time: number) => void) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      callbacks.delete(id);
    },
  });
  const originalNow = performance.now.bind(performance);
  performance.now = () => now;

  context.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, { value, configurable: true });
    }
    performance.now = originalNow;
  });

  return {
    storage: items,
    attach(element: HTMLElement) {
      window.document.body.append(element);
    },
    advance(ms: number) {
      for (let left = ms; left > 0; left -= FRAME_MS) {
        now += Math.min(left, FRAME_MS);
        const waiting = [...callbacks.values()];
        callbacks.clear();
        for (const callback of waiting) callback(now);
      }
    },
  };
}

function playButton(element: HTMLElement) {
  const button = element.querySelector("button");
  assert.ok(button);
  return button;
}

function speedSelect(element: HTMLElement) {
  const select = element.querySelector("select");
  assert.ok(select);
  return select;
}

function selectLabel(element: HTMLElement) {
  const wrapping = element.querySelector("label");
  assert.ok(wrapping);
  return (wrapping.firstChild as Text).textContent;
}

function speedValues(select: HTMLSelectElement) {
  return [...select.options].map((option) => option.value);
}

function labelOf(element: HTMLElement) {
  const label = element.querySelector("span");
  assert.ok(label);
  return label;
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}
