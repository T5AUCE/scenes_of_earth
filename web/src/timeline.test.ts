import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Window } from "happy-dom";

import { bundleStore, decode, readArray, readSteps } from "./data.ts";
import { ImageCrossfade } from "./layers/crossfade.ts";
import { LoadMeter, PLAY_SPEED_KEY } from "./playback.ts";
import { createStepReader } from "./step-reader.ts";
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
const twoHundred = Array.from({ length: 200 }, (_, index) => {
  const month = String((index % 12) + 1).padStart(2, "0");
  return `${2000 + Math.floor(index / 12)}-${month}-01`;
});
const LAGGING_SLOTS = 4;
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
  await advanceSettling(browser, 1200);
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
  await advanceSettling(browser, 1200);
  assert.deepEqual(shown, ["2020-02-01"]);

  await advanceSettling(browser, 1500);
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
  await advanceSettling(browser, 2400);

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
  browser.advance(1200);

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

  const expectedIndices = [75, ...Array.from({ length: 12 }, (_, index) => index)];
  assert.deepEqual(view.calls, expectedIndices.map((index) => seventySix[index]));
});

test("faster play warms a longer lookahead", (context) => {
  const view = fakeView(seventySix);
  const { timeline } = mount(context, seventySix, { views: [view] });
  chooseSpeed(timeline.element, "4");

  playButton(timeline.element).click();

  assert.equal(view.calls.length, 24);
});

test("the lookahead never exceeds what a view's cache can hold", (context) => {
  const view = fakeView(seventySix);
  view.maxLookahead = () => 5;
  const { timeline } = mount(context, seventySix, { views: [view] });
  chooseSpeed(timeline.element, "4");

  playButton(timeline.element).click();

  assert.equal(view.calls.length, 5);
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

test(
  "play never reaches a step whose prepared data was evicted from the real reader",
  async (context) => {
    const view = readerView(seventySix);
    const { browser, shown, timeline } = mount(context, seventySix, { views: [view] });
    chooseSpeed(timeline.element, "4");

    playButton(timeline.element).click();
    await advanceSettling(browser, 1500);

    assert.ok(shown.length > 6);
    assert.deepEqual([...view.loads.values()].filter((count) => count > 1), []);
  },
);

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

test("play tells the views to read more at once and pause tells them to read less", (context) => {
  const view = fakeView(quarter);
  const { timeline } = mount(context, quarter, { views: [view] });

  playButton(timeline.element).click();
  assert.deepEqual(view.playing, [true]);

  playButton(timeline.element).click();
  assert.deepEqual(view.playing, [true, false]);

  playButton(timeline.element).click();
  timeline.destroy();
  assert.deepEqual(view.playing, [true, false, true, false]);
});

test("the playhead starts only once the next step is ready", async (context) => {
  const view = fakeView(sixMonths);
  const { browser, shown, timeline } = mount(context, sixMonths, { views: [view] });
  view.block("2020-02-01");

  playButton(timeline.element).click();
  await advanceSettling(browser, 3000);
  assert.deepEqual(shown, []);

  view.unblock("2020-02-01");
  await advanceSettling(browser, 600);
  assert.deepEqual(shown, []);

  await advanceSettling(browser, 700);
  assert.deepEqual(shown, ["2020-02-01"]);
});

test("the start buffer does not wait for steps beyond the next one", async (context) => {
  const view = fakeView(sixMonths);
  const { browser, shown, timeline } = mount(context, sixMonths, { views: [view] });
  view.block("2020-03-01");

  playButton(timeline.element).click();
  await advanceSettling(browser, 1400);

  assert.deepEqual(shown, ["2020-02-01"]);
});

test("a 76-step loop at 4x reads each shard in a few requests", async (context) => {
  const series = shardedSeries(76, 12);
  const view = zarrView(seventySix, series.store);
  const { browser, shown, timeline } = mount(context, seventySix, { views: [view] });
  chooseSpeed(timeline.element, "4");

  playButton(timeline.element).click();
  for (let left = 5000; left > 0; left -= FRAME_MS) {
    browser.advance(FRAME_MS);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }

  assert.equal(shown.at(-1), seventySix.at(-1));
  assert.deepEqual(view.drawn, seventySix.map((_, index) => index));
  const dataRequests = series.requests.filter((request) => request.includes("offset"));
  const indexRequests = series.requests.filter((request) => request.includes("suffix"));
  assert.equal(indexRequests.length, 7);
  // A lump of steps can straddle two shards, so a shard may take two data requests.
  assert.ok(dataRequests.length <= 2 * 7 + 2, `${dataRequests.length} data requests`);
});

test("slow reads slow the pace smoothly instead of bursting and stalling", async (context) => {
  const view = laggingView(twoHundred, { ms: 265 });
  const { browser, timeline } = mount(context, twoHundred, { views: [view] });
  chooseSpeed(timeline.element, "4");

  playButton(timeline.element).click();
  await playFrames(browser, view, 1500);
  await playFrames(browser, view, 6000);

  // The first gap is the cold start buffer, which waits for the first step to load.
  const gaps = view.gapsMs().slice(1);
  assert.ok(gaps.length > 40, `${gaps.length} steps shown`);
  assert.ok(Math.min(...gaps) > 40, `shortest gap ${Math.min(...gaps)} ms`);
  assert.ok(Math.max(...gaps) < 130, `longest gap ${Math.max(...gaps)} ms`);
  assert.equal(labelOf(timeline.element).classList.contains("loading"), false);
});

test("the pace recovers toward the chosen speed when loading catches up", async (context) => {
  const latency = { ms: 265 };
  const view = laggingView(twoHundred, latency);
  const { browser, timeline } = mount(context, twoHundred, { views: [view] });
  chooseSpeed(timeline.element, "4");

  playButton(timeline.element).click();
  await playFrames(browser, view, 6000);
  const slowGaps = view.gapsMs().slice(-20);

  latency.ms = 40;
  await playFrames(browser, view, 6000);
  const fastGaps = view.gapsMs().slice(-20);

  const mean = (gaps: number[]) => gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  assert.ok(mean(slowGaps) > 70 && mean(slowGaps) < 95, `slow mean ${mean(slowGaps)} ms`);
  assert.ok(mean(fastGaps) < 66, `recovered mean ${mean(fastGaps)} ms`);
});

test("loading time counts again only when both tab and view are visible", (context) => {
  const view = fakeView(quarter);
  const visibility = fakeVisibility([view]);
  const playing: boolean[] = [];
  const setCounting = context.mock.method(LoadMeter.prototype, "setCounting");
  const { browser, timeline } = mount(context, quarter, {
    views: [view],
    visibility,
    onPlayingChange: (active) => playing.push(active),
  });
  view.block("2020-02-01");
  playButton(timeline.element).click();
  browser.advance(100);
  const tab = fakeTab(context);

  const counting = () => setCounting.mock.calls.at(-1)?.arguments[0];
  const steps: [() => void, boolean][] = [
    [() => tab.hide(), false],
    [() => visibility.hide(view), false],
    [() => tab.show(), false],
    [() => visibility.show(view), true],
    [() => visibility.hide(view), false],
    [() => tab.hide(), false],
    [() => visibility.show(view), false],
    [() => tab.show(), true],
  ];
  for (const [change, expected] of steps) {
    const before = setCounting.mock.callCount();
    change();
    assert.ok(setCounting.mock.callCount() > before);
    assert.equal(counting(), expected);
  }

  assert.deepEqual(playing, [true]);
});

test("destroy stops both visibility listeners and may repeat", (context) => {
  const view = fakeView(quarter);
  const visibility = fakeVisibility([view]);
  const setCounting = context.mock.method(LoadMeter.prototype, "setCounting");
  const { browser, timeline } = mount(context, quarter, { views: [view], visibility });
  view.block("2020-02-01");
  playButton(timeline.element).click();
  browser.advance(100);
  const tab = fakeTab(context);
  assert.equal(visibility.listenerCount(), 1);
  const removed = context.mock.method(document, "removeEventListener");

  timeline.destroy();
  timeline.destroy();
  const before = setCounting.mock.callCount();
  tab.hide();
  visibility.hide(view);

  assert.equal(visibility.listenerCount(), 0);
  assert.deepEqual(removed.mock.calls.map((call) => call.arguments[0]), ["visibilitychange"]);
  assert.equal(setCounting.mock.callCount(), before);
});

function mount(
  context: { after(hook: () => void): void },
  times: string[],
  options: TimelineOptions = {},
  browserOptions: { reducedMotion?: boolean } = {},
) {
  const browser = installTimelineBrowser(context, browserOptions);
  const shown: string[] = [];
  const timeline = createTimeline(
    times,
    ["P1M"],
    (time, isFrame) => {
      shown.push(time);
      options.views?.forEach((view) => {
        if (!isFrame || !view.setFrame) view.setTime(time);
      });
    },
    options,
  );
  context.after(() => timeline.destroy());
  browser.attach(timeline.element);
  shown.length = 0;

  return { browser, shown, timeline };
}

test("play draws each fade frame and leaves the label flip to the fading view", async (context) => {
  const view = fakeFadingView(quarter);
  const { browser, timeline } = mount(context, quarter, { views: [view] });
  view.setTimes.length = 0;
  playButton(timeline.element).click();
  await advanceSettling(browser, 1400);

  const mixes = view.frames.map(({ mix }) => mix);
  assert.ok(mixes.some((mix) => mix > 0 && mix < 1));
  assert.ok(mixes.every((mix, index) => index === 0 || mix >= mixes[index - 1] || mix === 0));
  assert.deepEqual(view.frames[0], { time: "2020-01-01", next: "2020-02-01", mix: 0 });
  assert.deepEqual(view.setTimes, []);
});

test("a view without setFrame still gets setTime at the label flip", async (context) => {
  const view = fakeFadingView(quarter);
  const plain = fakeView(quarter);
  const setTimes: string[] = [];
  plain.setTime = (time: string) => setTimes.push(time);
  const { browser, timeline } = mount(context, quarter, { views: [view, plain] });
  setTimes.length = 0;
  playButton(timeline.element).click();
  await advanceSettling(browser, 1400);

  assert.deepEqual(setTimes, ["2020-02-01"]);
});

test("reduced motion never gives a view a partial mix", async (context) => {
  const view = fakeFadingView(quarter);
  const { browser, timeline } = mount(
    context,
    quarter,
    { views: [view] },
    { reducedMotion: true },
  );
  playButton(timeline.element).click();
  await advanceSettling(browser, 2500);

  assert.ok(view.frames.length > 0);
  assert.deepEqual(view.frames.filter(({ mix }) => mix !== 0), []);
});

test("pausing mid-fade shows the label's step alone", async (context) => {
  const view = fakeFadingView(quarter);
  const { browser, timeline } = mount(context, quarter, { views: [view] });
  view.setTimes.length = 0;
  playButton(timeline.element).click();
  await advanceSettling(browser, 1400);
  assert.ok(view.frames.at(-1)!.mix > 0.5);

  playButton(timeline.element).click();

  assert.deepEqual(view.setTimes, ["2020-02-01"]);
});

test("jumping to the shown step mid-fade shows it alone", async (context) => {
  const view = fakeFadingView(quarter);
  const { browser, timeline } = mount(context, quarter, { views: [view] });
  view.setTimes.length = 0;
  playButton(timeline.element).click();
  await advanceSettling(browser, 1400);

  timeline.goTo("2020-02-01");

  assert.deepEqual(view.setTimes, ["2020-02-01"]);
});

test("a fade waits while the view has not painted the next step", async (context) => {
  const view = fakeFadingView(quarter);
  view.isReady = false;
  const { browser, shown, timeline } = mount(context, quarter, { views: [view] });
  playButton(timeline.element).click();
  await advanceSettling(browser, 3000);

  assert.deepEqual(shown, []);
  assert.ok(view.frames.every(({ mix }) => mix === 0));

  view.isReady = true;
  await advanceSettling(browser, 1000);

  assert.deepEqual(shown, ["2020-02-01"]);
});

test("playing across a step that failed to paint reaches the next good step", async (context) => {
  const view = fakeCrossfadeView(quarter, "2020-02-01");
  const { browser, shown, timeline } = mount(context, quarter, { views: [view] });
  view.setTime("2020-01-01");
  playButton(timeline.element).click();

  for (let round = 0; round < 80 && !shown.includes("2020-03-01"); round += 1) {
    browser.advance(SETTLE_STEP_MS);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.deepEqual(shown.slice(0, 2), ["2020-02-01", "2020-03-01"]);
});

test("isoline holds survive a two-step lookahead so play never stalls", async (context) => {
  const view = fakeIsolineView(quarter);
  const { browser, shown, timeline } = mount(context, quarter, { views: [view] });
  playButton(timeline.element).click();
  await advanceSettling(browser, 6000);

  assert.ok(shown.includes("2020-02-01"));
  assert.ok(shown.includes("2020-03-01"));
  assert.ok(view.calls.includes("2020-02-01"));
  assert.ok(view.calls.includes("2020-03-01"));
});

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
    listenerCount: () => listeners.size,
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

/** Makes the page's visibility state switchable, announcing each change as a browser does. */
function fakeTab(context: { after(hook: () => void): void }) {
  let state = "visible";
  const page = document;
  Object.defineProperty(page, "visibilityState", { get: () => state, configurable: true });
  context.after(() => Reflect.deleteProperty(page, "visibilityState"));
  const change = (next: string) => {
    state = next;
    page.dispatchEvent(new Event("visibilitychange"));
  };

  return { hide: () => change("hidden"), show: () => change("visible") };
}

function fakeCrossfadeView(times: string[], failing: string) {
  const view = fakeFadingView(times);
  const fade = new ImageCrossfade<string>(0.8, { setImage() {}, setOpacities() {} });
  let shownTime: string | null = null;
  view.setTime = (time: string) => {
    shownTime = time;
    if (time === failing) fade.hide();
    else fade.show(time, () => ({}) as ImageData);
  };
  view.setFrame = (time, next, mix) => {
    if (time !== shownTime) {
      view.setTime(time);
      return;
    }

    fade.frame(time, next, mix);
    fade.prepare(next, async () => {
      if (next === failing) throw new Error("read failed");
      return () => ({}) as ImageData;
    });
  };
  view.isFrameReady = (time, next) => fade.isReady(time, next);
  return view;
}

function fakeFadingView(times: string[]) {
  const view = fakeView(times) as ReturnType<typeof fakeView> & {
    frames: { time: string; next: string; mix: number }[];
    setTimes: string[];
    isReady: boolean;
  };
  view.frames = [];
  view.setTimes = [];
  view.isReady = true;
  view.setTime = (time: string) => view.setTimes.push(time);
  view.setFrame = (time, next, mix) => view.frames.push({ time, next, mix });
  view.isFrameReady = () => view.isReady;
  return view;
}

function fakeIsolineView(times: string[]) {
  const held: number[] = [];
  const cached = new Set<number>();
  const calls: string[] = [];
  type Fade = { time: string; next: string; mix: number; nextStep: number; held: number[] };
  const frames: Fade[] = [];
  const view = {
    calls,
    frames,
    time: { step: "P1M", values: times, end: "2020-04-01", method: null },
    parts: [],
    options: [],
    setTime(time: string) {
      const step = times.indexOf(time);
      if (step < 0) return;
      cached.add(step);
      if (!held.includes(step)) {
        held.push(step);
        if (held.length > 2) held.shift();
      } else {
        held.splice(held.indexOf(step), 1);
        held.push(step);
      }
    },
    async prepare(time: string) {
      calls.push(time);
      const step = times.indexOf(time);
      if (step >= 0) cached.add(step);
    },
    setFrame(time: string, next: string, mix: number) {
      const step = times.indexOf(time);
      const nextStep = times.indexOf(next);
      if (mix <= 0 && step >= 0) {
        if (held.includes(step)) {
          held.splice(held.indexOf(step), 1);
          held.push(step);
        }
        if (nextStep >= 0 && !held.includes(nextStep) && cached.has(nextStep)) {
          held.push(nextStep);
          if (held.length > 2) held.shift();
        }
      }
      frames.push({ time, next, mix, nextStep, held: [...held] });
    },
    isFrameReady(time: string, next: string) {
      const step = times.indexOf(time);
      const nextStep = times.indexOf(next);
      if (step === nextStep) return true;
      const settled = (value: number) => value < 0 || held.includes(value);
      return settled(step) && settled(nextStep);
    },
    legend() {
      return null;
    },
    destroy() {},
  } as unknown as LayerView & { calls: string[]; frames: Fade[] };
  return view;
}

function fakeView(times: string[]) {
  const gates = new Map<string, { wait: Promise<void>; release: () => void }>();
  const view = {
    calls: [] as string[],
    releases: 0,
    playing: [] as boolean[],
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
    setPlaying(isPlaying: boolean) {
      view.playing.push(isPlaying);
    },
    async prepare(time: string) {
      view.calls.push(time);
      await gates.get(time)?.wait;
    },
  } as unknown as LayerView & {
    calls: string[];
    releases: number;
    playing: boolean[];
    block(time: string): void;
    unblock(time: string): void;
  };
  return view;
}

/** A Zarr v3 series of int16 steps in shards, where step N holds the value N in every cell. */
function shardedSeries(stepCount: number, shardSteps: number) {
  const cellBytes = 2 * 2 * 2;
  const shards = new Map<string, Uint8Array>();
  for (let shard = 0; shard * shardSteps < stepCount; shard++) {
    const index = new BigUint64Array(shardSteps * 2).fill(2n ** 64n - 1n);
    const data = new Uint8Array(shardSteps * cellBytes + shardSteps * 16);
    for (let offset = 0; offset < shardSteps && shard * shardSteps + offset < stepCount; offset++) {
      const cells = new Int16Array(4).fill(shard * shardSteps + offset);
      data.set(new Uint8Array(cells.buffer), offset * cellBytes);
      index[2 * offset] = BigInt(offset * cellBytes);
      index[2 * offset + 1] = BigInt(cellBytes);
    }
    data.set(new Uint8Array(index.buffer), shardSteps * cellBytes);
    shards.set(`/a/c/${shard}/0/0`, data);
  }
  const arrayMeta = {
    zarr_format: 3,
    node_type: "array",
    shape: [stepCount, 2, 2],
    data_type: "int16",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [shardSteps, 2, 2] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: 0,
    codecs: [
      {
        name: "sharding_indexed",
        configuration: {
          chunk_shape: [1, 2, 2],
          codecs: [{ name: "bytes", configuration: { endian: "little" } }],
          index_codecs: [{ name: "bytes", configuration: { endian: "little" } }],
          index_location: "end",
        },
      },
    ],
  };
  const documents = new Map<string, unknown>([
    ["/zarr.json", { zarr_format: 3, node_type: "group" }],
    ["/a/zarr.json", arrayMeta],
  ]);
  const requests: string[] = [];
  const store = bundleStore({
    async get(key) {
      requests.push(`get ${key}`);
      const document = documents.get(key);

      return document ? new TextEncoder().encode(JSON.stringify(document)) : undefined;
    },
    async getRange(key, range) {
      const data = shards.get(key);
      if (!data) return undefined;
      if ("suffixLength" in range) {
        requests.push(`suffix ${key}`);
        return data.slice(data.length - range.suffixLength);
      }

      requests.push(`offset ${key} ${range.offset} ${range.length}`);
      return data.slice(range.offset, range.offset + range.length);
    },
  });

  return { store, requests };
}

/** A view that reads steps of the sharded series through a real step reader. */
function zarrView(times: string[], store: ReturnType<typeof bundleStore>) {
  const encoding = { scale_factor: 1, add_offset: 0, fill: -1 };
  const reader = createStepReader(
    { nx: 2, ny: 2 },
    async (step) => decode(await readArray(await store, "a", [step, null, null]), encoding),
    async (first, count) => {
      const steps = await readSteps(await store, "a", first, count);
      return steps.map((raw) => decode(raw, encoding));
    },
  );
  const drawn: number[] = [];
  const view = {
    drawn,
    time: { step: "P1M", values: times, end: "2030-01-01", method: null },
    parts: [],
    options: [],
    setTime(time: string) {
      void reader.read(times.indexOf(time)).then((values) => drawn.push(values[0]));
    },
    legend() {
      return null;
    },
    destroy() {},
    release: () => reader.release(),
    maxLookahead: () => reader.maxLookahead(),
    setPlaying: (isPlaying: boolean) => reader.setPlaying(isPlaying),
    async prepare(time: string) {
      await reader.read(times.indexOf(time), false);
    },
  } as unknown as LayerView & { drawn: number[] };
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
    maxLookahead() {
      return reader.maxLookahead();
    },
    async prepare(time: string) {
      await reader.read(times.indexOf(time), false);
    },
  } as unknown as LayerView & { loads: Map<number, number> };
  return view;
}

/**
 * A view whose reads each take `latency.ms` and run at most four at a time, like the four reads
 * in flight of a real reader; `pump` advances them to the browser's fake clock.
 */
function laggingView(times: string[], latency: { ms: number }) {
  const waiting: (() => void)[] = [];
  const running: { dueMs: number; finish: () => void }[] = [];
  const shownAtMs: number[] = [];
  const pump = () => {
    const now = performance.now();
    for (const read of running.filter((candidate) => candidate.dueMs <= now)) {
      running.splice(running.indexOf(read), 1);
      read.finish();
    }
    while (running.length < LAGGING_SLOTS && waiting.length > 0) {
      running.push({ dueMs: now + latency.ms, finish: waiting.shift()! });
    }
  };
  const view = {
    pump,
    gapsMs: () => shownAtMs.slice(1).map((atMs, index) => atMs - shownAtMs[index]),
    time: { step: "P1M", values: times, end: "2030-01-01", method: null },
    parts: [],
    options: [],
    setTime() {
      shownAtMs.push(performance.now());
    },
    legend() {
      return null;
    },
    destroy() {},
    prepare() {
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
        pump();
      });
    },
  } as unknown as LayerView & { pump(): void; gapsMs(): number[] };
  return view;
}

async function playFrames(
  browser: { advance(ms: number): void },
  view: { pump(): void },
  ms: number,
) {
  for (let left = ms; left > 0; left -= FRAME_MS) {
    browser.advance(FRAME_MS);
    view.pump();
    await settle();
  }
}

function installTimelineBrowser(
  context: { after(hook: () => void): void },
  options: { storage?: object; reducedMotion?: boolean },
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

  const media = {
    matches: options.reducedMotion ?? false,
    addEventListener() {},
    removeEventListener() {},
  };
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
