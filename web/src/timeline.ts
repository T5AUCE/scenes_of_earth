/** Scrub and play through scene times with pacing, speed and prefetch gating. */
import {
  easePaceMs,
  labelIndexFor,
  loadPlaySpeed,
  LoadMeter,
  lookaheadFor,
  loopMsFor,
  lumpFor,
  PACE_SLOWED_RATIO,
  PLAY_SPEEDS,
  type Playhead,
  playheadAt,
  rescalePosition,
  STALL_LOADING_MS,
  stepMsFor,
  storePlaySpeed,
  sustainedStepMs,
} from "./playback";
import { prefersReducedMotion, watchReducedMotion } from "./reduced-motion";
import type { LayerView } from "./types";

const YEAR_CHARS = 4; // "YYYY"
const MONTH_CHARS = 7; // "YYYY-MM"
const FRAME_FALLBACK_MS = 16;
const LONGEST_PACE_FRAME_MS = 100; // a stalled tab must not swing the pace in one frame

/** Extra inputs the scene passes so play can warm steps and report its state. */
export interface TimelineOptions {
  views?: LayerView[];
  /** Which views the viewer sees now; play waits only for these. Without it all are seen. */
  visibility?: {
    isVisible(view: LayerView): boolean;
    subscribe(listener: () => void): () => void;
  };
  onPlayingChange?: (playing: boolean) => void;
}

/** The steps of several time axes, sorted and without duplicates. */
export const unionTimes = (axes: string[][]) => [...new Set(axes.flat())].sort();

/**
 * The scrubber's positions: the steps of all axes inside the period, plus its start, so a coarse
 * layer that began earlier still has a position where the period begins.
 */
export function scrubberTimes(axes: string[][], period: { start: string; end: string }) {
  const inside = axes.flat().filter((time) => time >= period.start && time < period.end);
  return unionTimes([inside, [period.start]]);
}

/**
 * Index of the last value at or before time, or -1 when time lies outside the axis. The last
 * step holds until `end`, the day after its period.
 */
export function stepAt(values: string[], end: string, time: string) {
  const isOutsideAxis = !values.length || time < values[0] || time >= end;
  if (isOutsideAxis) return -1;

  let index = 0;
  while (index + 1 < values.length && values[index + 1] <= time) index++;
  return index;
}

/** Shows only as much of the date as the finest step needs. */
export function formatTime(time: string, steps: string[]) {
  if (steps.some((step) => step.endsWith("D") || step.endsWith("W"))) return time;
  if (steps.some((step) => step.endsWith("M"))) return time.slice(0, MONTH_CHARS);
  return time.slice(0, YEAR_CHARS);
}

/** Only the latest queued value runs, so scrubbing skips stale steps; task must catch errors. */
export function latestOnly<T>(task: (value: T) => Promise<void>) {
  let waiting: { value: T } | null = null;
  let isRunning = false;

  return async (value: T) => {
    waiting = { value };
    if (isRunning) return;

    isRunning = true;
    try {
      while (waiting) {
        const { value: latest } = waiting;
        waiting = null;
        await task(latest);
      }
    } finally {
      isRunning = false;
    }
  };
}

/** A play button, slider, label and speed control that step through the times. */
export function createTimeline(
  times: string[],
  steps: string[],
  onChange: (time: string, isFrame: boolean) => void,
  options?: TimelineOptions,
) {
  const controls = createControls(times.length);
  const clock = new PlaybackClock(times, steps, onChange, controls, options);
  controls.play.onclick = () => clock.toggle();
  controls.slider.oninput = () => clock.select(Number(controls.slider.value));
  controls.speedSelect.onchange = () => clock.setSpeed(Number(controls.speedSelect.value));
  clock.showFirst();

  return {
    element: controls.element,
    times,
    destroy: () => clock.destroy(),

    get isPlaying() {
      return clock.isPlaying;
    },

    goTo(time: string) {
      const index = times.indexOf(time);
      if (index >= 0) clock.select(index);
    },

    // Stops at both ends; only play wraps around.
    move(delta: number) {
      clock.select(clock.shownIndex + delta);
    },
  };
}

interface Controls {
  element: HTMLDivElement;
  play: HTMLButtonElement;
  slider: HTMLInputElement;
  label: HTMLSpanElement;
  speedSelect: HTMLSelectElement;
}

function createControls(count: number): Controls {
  const element = document.createElement("div");
  element.className = "timeline";

  const play = document.createElement("button");
  play.textContent = "Play";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(Math.max(count - 1, 0));
  slider.value = "0";

  const label = document.createElement("span");

  const speedSelect = document.createElement("select");
  for (const speed of PLAY_SPEEDS) {
    const option = document.createElement("option");
    option.value = String(speed);
    option.textContent = `${speed}×`;
    speedSelect.append(option);
  }
  const speedLabel = document.createElement("label");
  speedLabel.textContent = "Playback speed";
  speedLabel.append(speedSelect);

  element.append(play, slider, label, speedLabel);

  return { element, play, slider, label, speedSelect };
}

/** Advances the playhead of one timeline by frames and waits for data it is about to show. */
class PlaybackClock {
  private readonly times: string[];
  private readonly steps: string[];
  private readonly onChange: (time: string, isFrame: boolean) => void;
  private readonly views: LayerView[];
  private readonly onPlayingChange?: (playing: boolean) => void;
  private readonly controls: Controls;
  private readonly window: PrefetchWindow;
  private readonly stopReducedMotion: () => void;
  private readonly stopVisibility: () => void;
  private speed = loadPlaySpeed();
  private stepMs: number;
  private paceMs: number; // the step duration in effect, slower than stepMs while loading lags
  private lookahead: number;
  private shown = -1;
  private playing = false;
  private alive = true;
  private reducedMotion = prefersReducedMotion();
  private playheadMs = 0;
  private lastFrameMs = 0;
  private frameId: number | undefined;
  private stallStartMs: number | null = null;
  private isBuffering = false;

  constructor(
    times: string[],
    steps: string[],
    onChange: (time: string, isFrame: boolean) => void,
    controls: Controls,
    options?: TimelineOptions,
  ) {
    this.times = times;
    this.steps = steps;
    this.onChange = onChange;
    this.views = options?.views ?? [];
    this.controls = controls;
    this.onPlayingChange = options?.onPlayingChange;
    this.stepMs = stepMsFor(times.length, this.speed);
    this.paceMs = this.stepMs;
    this.lookahead = lookaheadFor(this.stepMs);
    this.window = new PrefetchWindow(times, this.views, options?.visibility);
    controls.speedSelect.value = String(this.speed);
    this.stopReducedMotion = watchReducedMotion((reduced) => {
      this.reducedMotion = reduced;
    });
    const stopViewWatch = options?.visibility?.subscribe(() => this.viewsChanged()) ?? (() => {});
    const onTabChange = () => this.viewsChanged();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onTabChange);
    }
    this.stopVisibility = () => {
      stopViewWatch();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onTabChange);
      }
    };
  }

  get isPlaying() {
    return this.playing;
  }

  get shownIndex() {
    return this.shown;
  }

  showFirst() {
    if (this.times.length > 0) this.show(0);
  }

  toggle() {
    if (this.playing) {
      this.pause();
      return;
    }

    if (this.shown < 0 && this.times.length > 0) this.show(0);
    this.start();
  }

  select(index: number) {
    const clamped = Math.min(Math.max(index, 0), this.times.length - 1);
    this.playheadMs = clamped * this.stepMs;
    this.paceMs = this.stepMs;
    this.endStall();
    // Drawing while still playing holds the link until the pause writes it once.
    if (clamped !== this.shown) this.show(clamped);
    else if (this.playing) this.settleViews();
    this.stopPlaying();
  }

  setSpeed(speed: number) {
    if (!PLAY_SPEEDS.includes(speed)) return;

    const previousPaceMs = this.paceMs;
    this.speed = speed;
    storePlaySpeed(speed);
    this.stepMs = stepMsFor(this.times.length, speed);
    this.paceMs = this.stepMs;
    this.lookahead = lookaheadFor(this.stepMs);
    this.playheadMs = rescalePosition(
      this.playheadMs,
      previousPaceMs,
      this.paceMs,
      this.times.length,
    );
    this.lastFrameMs = nowMs();
    this.warm();
  }

  destroy() {
    if (!this.alive) return;

    this.alive = false;
    cancelFrame(this.frameId);
    this.frameId = undefined;
    this.stopReducedMotion();
    this.stopVisibility();
    this.window.clear();
    this.controls.play.textContent = "Play";
  }

  private start() {
    if (this.playing || !this.alive || this.times.length <= 1) return;

    this.lastFrameMs = nowMs();
    this.isBuffering = true;
    this.window.setPlaying(true);
    this.setPlaying(true);
    this.warm();
    this.frameId = scheduleFrame(this.tick);
  }

  private pause() {
    // Snapping keeps the label's step so the next play resumes from its hold.
    this.playheadMs = Math.max(this.shown, 0) * this.stepMs;
    this.endStall();
    this.stopPlaying();
    this.settleViews();
  }

  private stopPlaying() {
    this.isBuffering = false;
    this.paceMs = this.stepMs;
    if (!this.playing) return;

    cancelFrame(this.frameId);
    this.frameId = undefined;
    this.window.clear();
    this.setPlaying(false);
  }

  private tick = (frameMs: number) => {
    if (!this.playing || !this.alive) return;

    if (this.isBuffering && !this.hasStartBuffer(frameMs)) {
      this.lastFrameMs = frameMs;
      this.frameId = scheduleFrame(this.tick);
      return;
    }

    const frameElapsedMs = Math.max(frameMs - this.lastFrameMs, 0);
    this.adaptPace(Math.min(frameElapsedMs, LONGEST_PACE_FRAME_MS));
    // A long frame must not carry the playhead over a step that was never shown.
    const elapsedMs = Math.min(frameElapsedMs, this.paceMs / 2);
    this.lastFrameMs = frameMs;
    const loopMs = loopMsFor(this.paceMs, this.times.length);
    const candidateMs = (this.playheadMs + elapsedMs) % loopMs;
    const frame = playheadAt(candidateMs, this.paceMs, this.times.length, this.reducedMotion);
    const desired = labelIndexFor(frame);

    const isLabelBlocked = desired !== this.shown && !this.window.isReady(desired);
    const isFadeBlocked = !isLabelBlocked && !this.isFadeReady(frame);
    if (isLabelBlocked || isFadeBlocked) {
      this.stall(frameMs);
      // Holding at no mix still lets the views start painting the step they fade to.
      if (isFadeBlocked) this.drawFrame(frame.index, frame.next, 0);
    } else {
      this.playheadMs = candidateMs;
      this.endStall();
      this.markSlowed();
      this.drawFrame(frame.index, frame.next, frame.mix);
      if (desired !== this.shown) this.advanceTo(desired);
    }
    this.frameId = scheduleFrame(this.tick);
  };

  // Slowing to what loading sustains replaces bursts and stalls with a steady, slower rate.
  private adaptPace(elapsedMs: number) {
    const targetMs = sustainedStepMs(this.stepMs, this.window.loadStepMs());
    const nextMs = easePaceMs(this.paceMs, targetMs, elapsedMs);
    this.playheadMs = rescalePosition(this.playheadMs, this.paceMs, nextMs, this.times.length);
    this.paceMs = nextMs;
  }

  private markSlowed() {
    const isSlowed = this.paceMs > this.stepMs * PACE_SLOWED_RATIO;
    this.controls.label.classList.toggle("loading", isSlowed);
  }

  // Only the immediate next step is awaited, so a cold start does not wait for the whole window.
  private hasStartBuffer(frameMs: number) {
    const next = (Math.max(this.shown, 0) + 1) % this.times.length;
    if (!this.window.isReady(next)) {
      this.stall(frameMs);
      return false;
    }

    this.isBuffering = false;
    this.endStall();
    return true;
  }

  // The playhead stays where it is, so the hold lasts until the data is ready.
  private stall(frameMs: number) {
    this.stallStartMs ??= frameMs;
    if (frameMs - this.stallStartMs > STALL_LOADING_MS) {
      this.controls.label.classList.add("loading");
    }
    this.warm();
  }

  private endStall() {
    this.stallStartMs = null;
    this.controls.label.classList.remove("loading");
  }

  private advanceTo(index: number) {
    this.show(index, true);
    this.warm();
  }

  private frameViews() {
    return this.views.filter((view) => view.setFrame);
  }

  private isFadeReady(frame: Playhead) {
    if (frame.mix <= 0) return true;

    const time = this.times[frame.index];
    const next = this.times[frame.next];
    return this.frameViews().every(
      (view) => !this.window.isVisible(view) || view.isFrameReady?.(time, next) !== false,
    );
  }

  private drawFrame(index: number, next: number, mix: number) {
    for (const view of this.frameViews()) view.setFrame!(this.times[index], this.times[next], mix);
  }

  // Pausing or jumping shows the label's step alone, which cannot wait for the next frame.
  private settleViews() {
    if (this.shown < 0) return;

    for (const view of this.frameViews()) view.setTime(this.times[this.shown]);
  }

  private viewsChanged() {
    this.window.syncCounting();
    this.warm();
  }

  private warm() {
    if (this.playing) this.window.refresh(Math.max(this.shown, 0), this.lookahead);
  }

  private show(index: number, isFrame = false) {
    if (!this.alive || index === this.shown) return;

    const { slider, label } = this.controls;
    this.shown = index;
    slider.value = String(index);
    label.textContent = formatTime(this.times[index], this.steps);
    this.onChange(this.times[index], isFrame);
  }

  private setPlaying(playing: boolean) {
    if (!this.alive || playing === this.playing) return;

    this.playing = playing;
    this.controls.play.textContent = playing ? "Pause" : "Play";
    this.onPlayingChange?.(playing);
  }
}

/**
 * The positions the clock is about to show and which visible views have them decoded. Only the
 * current window counts as ready, so a step that left it is prepared again when it returns.
 */
class PrefetchWindow {
  private readonly times: string[];
  private readonly views: LayerView[];
  private readonly visibility: TimelineOptions["visibility"];
  private readonly settled = new Map<string, Map<LayerView, boolean>>();
  private readonly meters = new Map<LayerView, LoadMeter>();
  private generation = 0;

  constructor(times: string[], views: LayerView[], visibility: TimelineOptions["visibility"]) {
    this.times = times;
    this.views = views;
    this.visibility = visibility;
  }

  isVisible(view: LayerView) {
    return this.visibility?.isVisible(view) !== false;
  }

  /** Whether every visible view holds the position, which is true when none can prepare. */
  isReady(index: number) {
    const states = this.settled.get(this.times[index]);

    return this.visibleViews().every((view) => states?.get(view) === true);
  }

  /** The slowest visible view's loading time per step, or null before it has been measured. */
  loadStepMs(): number | null {
    const measured = this.visibleViews().map((view) => this.meters.get(view)?.stepMs() ?? null);
    if (measured.length === 0 || measured.includes(null)) return null;

    return Math.max(...(measured as number[]));
  }

  /**
   * Keeps the positions after `base` prepared, nearest first, for the views that show now. Missing
   * positions are requested in lumps, because one lump of consecutive steps shares its shard reads.
   */
  refresh(base: number, lookahead: number) {
    const views = this.visibleViews();
    const limits = views.map((view) => view.maxLookahead?.() ?? lookahead);
    const reach = Math.min(lookahead, ...limits);
    const count = Math.min(reach, this.times.length - 1);
    const wanted = Array.from(
      { length: count },
      (_, offset) => this.times[(base + offset + 1) % this.times.length],
    );
    for (const time of this.settled.keys()) {
      if (!wanted.includes(time)) this.settled.delete(time);
    }

    const missing = wanted.filter(
      (time) => views.some((view) => !this.settled.get(time)?.has(view)),
    );
    const isNextMissing = missing.includes(wanted[0]);
    if (!isNextMissing && missing.length < lumpFor(count)) return;

    for (const time of wanted) {
      for (const view of views) this.prepare(view, time);
    }
  }

  /** Keeps hidden tabs and views out of the loading time, which they cannot measure. */
  syncCounting() {
    const isTabShown = typeof document === "undefined" || document.visibilityState !== "hidden";
    for (const [view, meter] of this.meters) {
      const isViewShown = this.isVisible(view);
      meter.setCounting(isTabShown && isViewShown, nowMs());
    }
  }

  /** Lets the views read more steps at once while the clock plays. */
  setPlaying(isPlaying: boolean) {
    this.views.forEach((view) => view.setPlaying?.(isPlaying));
  }

  clear() {
    this.generation += 1;
    this.settled.clear();
    this.meters.clear();
    this.views.forEach((view) => view.release?.());
    this.setPlaying(false);
  }

  private visibleViews() {
    return this.views.filter((view) => view.prepare && this.isVisible(view));
  }

  private prepare(view: LayerView, time: string) {
    const states = this.settled.get(time) ?? new Map<LayerView, boolean>();
    this.settled.set(time, states);
    if (states.has(view)) return;

    const ticket = this.generation;
    const meter = this.meters.get(view) ?? new LoadMeter();
    this.meters.set(view, meter);
    this.syncCounting();
    states.set(view, false);
    meter.begin(nowMs());
    // A failed prepare must not stall play forever because the draw reports it later.
    view.prepare!(time).catch(() => {}).then(() => {
      meter.finish(nowMs());
      if (ticket === this.generation && this.settled.get(time) === states) {
        states.set(view, true);
      }
    });
  }
}

function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {
    // A blocked clock falls back to the date below.
  }
  return Date.now();
}

function scheduleFrame(callback: (time: number) => void): number {
  try {
    const frame = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    if (typeof frame === "function") {
      return (frame as typeof requestAnimationFrame).call(globalThis, callback);
    }
  } catch {
    // A blocked scheduler falls back to a timer below.
  }
  return Number(setTimeout(() => callback(nowMs()), FRAME_FALLBACK_MS));
}

function cancelFrame(id: number | undefined): void {
  if (id === undefined) return;

  try {
    const cancel = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    if (typeof cancel === "function") {
      (cancel as typeof cancelAnimationFrame).call(globalThis, id);
      return;
    }
  } catch {
    // A blocked scheduler falls through to clearing the timer.
  }
  clearTimeout(id);
}
