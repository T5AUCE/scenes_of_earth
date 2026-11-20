/** Plain HTTP-cache warmer that fetches tile URLs ahead of the camera. */
import {
  beginWarmer,
  noteDwellWarmerRequest,
  setWarmerEnabled,
  setWarmerEntryProgress,
} from "../dev-stats";
import { DWELL_REQUEST_CAP, type DwellViewport } from "../render/tile-viewport";
import type { PreloadMap, PreloadSource, PreloadTask } from "./tile-prefetch";

/** Concurrent warmer fetches, kept low so visible tiles stay first in the browser queue. */
export const WARMER_LANES = 3;
/** Warmed and missing keys remembered, so ocean tiles are not refetched every dwell. */
export const MAX_WARMER_KEYS = 2000;

/** Dwell fallback delay, long enough for the visible tiles to claim the network first. */
export const DWELL_IDLE_FALLBACK_MS = 400;

/** The map surface the warmer listens to and reads the resting viewport from. */
export type WarmerMap = PreloadMap & {
  getZoom?: () => number;
  getBounds?: () => {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  };
};

interface WarmerSourceState {
  source: PreloadSource;
  queue: PreloadTask[];
  dwellQueue: PreloadTask[];
  total: number;
  done: number;
  entryTotal: number;
  entryDone: number;
}

interface WarmerActive {
  abort: AbortController;
  sourceId: string;
  zoom?: number;
  settled: boolean;
  dwell: boolean;
}

/** A bounded key set that forgets its oldest key, so the dwell memo never grows. */
class WarmerKeySet {
  private readonly keys = new Set<string>();

  constructor(private readonly limit: number) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    this.keys.delete(key);
    this.keys.add(key);

    if (this.keys.size <= this.limit) return;

    const oldest = this.keys.values().next();

    if (!oldest.done) this.keys.delete(oldest.value);
  }

  clear(): void {
    this.keys.clear();
  }
}

/**
 * Fetch scene tile URLs so the browser HTTP cache holds them before the camera needs
 * them. MapLibre then loads them as normal. Each task reads its response to a Blob
 * so the cache entry completes while the warmer drops the returned value. A missing
 * memo keeps ocean tiles from refetching every dwell. Basemap and direct DEM
 * downloads run at low priority so visible requests stay first. DEM tiles through
 * the worker manager reuse its own queue. Entry warms the scene pyramid once.
 * Each moveend after landing arms one dwell that runs on the first idle or after
 * a short fallback delay, so playback without idle still warms. Re-arming replaces
 * the pending trigger, and a new gesture or destroy cancels it. Each dwell replaces
 * the previous dwell with the resting viewport inside a shared cap. The cap and
 * the launches are shared round-robin across sources
 * so every source warms on the first dwell. Each source keeps ancestors first, then
 * nearest the viewport centre first within a level. Entry never waits on it.
 */
export class TileWarmer {
  private readonly sources = new Map<string, WarmerSourceState>();
  private readonly active = new Map<string, WarmerActive>();
  private readonly warmed = new WarmerKeySet(MAX_WARMER_KEYS);
  private readonly missing = new WarmerKeySet(MAX_WARMER_KEYS);
  private readonly wakeListeners = new Set<() => void>();
  private readonly stopListening: () => void;
  private fittedZoom: number | null = null;
  private isLanded = false;
  private destroyed = false;
  private dwellArmed = false;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onDwellIdle = () => this.fireDwell();
  private readonly onDwellMoveEnd = () => this.armDwell();
  private readonly onDwellMoveStart = () => this.cancelDwell();

  constructor(private readonly map: WarmerMap) {
    setWarmerEnabled(true);
    beginWarmer();

    map.on("idle", this.onDwellIdle);
    map.on("moveend", this.onDwellMoveEnd);
    map.on("movestart", this.onDwellMoveStart);
    this.stopListening = () => {
      map.off("idle", this.onDwellIdle);
      map.off("moveend", this.onDwellMoveEnd);
      map.off("movestart", this.onDwellMoveStart);
    };
  }

  /** Register a source, replacing and aborting an earlier one with the same id. */
  add(source: PreloadSource): void {
    if (this.destroyed) return;

    this.remove(source.id);

    const state: WarmerSourceState = {
      source,
      queue: [],
      dwellQueue: [],
      total: 0,
      done: 0,
      entryTotal: 0,
      entryDone: 0,
    };
    this.sources.set(source.id, state);

    if (this.fittedZoom === null) return;

    this.plan(state);
    this.pump();
  }

  /** Forget a source and abort what it still runs. */
  remove(id: string): void {
    const state = this.sources.get(id);
    if (!state) return;

    this.sources.delete(id);
    state.source.close?.();

    for (const [key, job] of [...this.active]) {
      if (job.sourceId === id) this.cancelJob(key, job);
    }

    this.report();
  }

  /** Begin warming for a scene that the camera fits at this zoom. */
  start(fittedZoom: number): void {
    if (this.destroyed || this.fittedZoom !== null) return;

    this.fittedZoom = fittedZoom;

    for (const state of this.sources.values()) this.plan(state);

    this.pump();
  }

  /** Abort everything and stop listening, handing loading back to MapLibre alone. */
  destroy(): void {
    if (this.destroyed) return;

    this.destroyed = true;
    this.cancelDwell();

    for (const [key, job] of [...this.active]) this.cancelJob(key, job);
    for (const state of this.sources.values()) state.source.close?.();

    this.sources.clear();
    this.warmed.clear();
    this.missing.clear();

    this.stopListening();
    setWarmerEntryProgress(0, 0);
    setWarmerEnabled(false);
    this.wake();
  }

  /** Warmed and planned tasks. No bytes are held because each body is dropped after reading. */
  progress(): { done: number; total: number; bytes: number } {
    let done = 0;
    let total = 0;

    for (const state of this.sources.values()) {
      done += state.done;
      total += state.total;
    }

    return { done, total, bytes: 0 };
  }

  /** Whether every planned task has settled, so failures never block anything. */
  isSettled(): boolean {
    const { done, total } = this.progress();
    return done >= total;
  }

  /** Wait until every planned task settles, waking on each report instead of polling. */
  async settled(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (this.destroyed || signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (this.isSettled()) return;

      await this.waitForWake(signal);
    }
  }

  /** Mark the camera landing, so dwells start warming the resting viewport. */
  noteLanded(): void {
    this.isLanded = true;
    this.armDwell();
  }

  /** Arm one dwell run on the first idle or the fallback delay after landing. */
  private armDwell(): void {
    if (this.destroyed || !this.isLanded) return;

    this.cancelDwell();
    this.dwellArmed = true;
    this.dwellTimer = setTimeout(() => this.fireDwell(), DWELL_IDLE_FALLBACK_MS);
  }

  /** Run the armed dwell once, so a late idle cannot launch it twice. */
  private fireDwell(): void {
    if (!this.dwellArmed) return;

    this.cancelDwell();
    this.warmDwell();
  }

  /** Drop the pending dwell trigger and its queued work when a gesture supersedes it. */
  private cancelDwell(): void {
    this.dwellArmed = false;
    if (this.dwellTimer !== null) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }

    this.clearQueuedDwell();
  }

  /** Drop the queued dwell work that a new gesture superseded, keeping entry work. */
  private clearQueuedDwell(): void {
    let dropped = false;

    for (const state of this.sources.values()) {
      if (state.dwellQueue.length === 0) continue;

      state.total -= state.dwellQueue.length;
      state.dwellQueue = [];
      dropped = true;
    }

    if (dropped) this.report();
  }

  /** Wait for the next progress report instead of polling on a timer. */
  private waitForWake(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.wakeListeners.delete(onWake);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const onWake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.wakeListeners.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private plan(state: WarmerSourceState): void {
    const tasks = state.source.tasks(this.fittedZoom!);
    state.queue = tasks.filter((task) => !this.warmed.has(task.key));
    state.dwellQueue = [];
    state.total = tasks.length;
    state.done = tasks.length - state.queue.length;
    state.entryTotal = tasks.length;
    state.entryDone = tasks.length - state.queue.length;

    this.report();
  }

  /** Start queued tasks round-robin, one per source per pass, while lanes allow. */
  private pump(): void {
    if (this.destroyed || this.fittedZoom === null) return;

    while (this.active.size < WARMER_LANES) {
      let progressed = false;

      for (const state of this.sources.values()) {
        if (!this.canLaunch(state)) continue;

        const next = this.nextLaunchable(state);
        if (next === null) continue;

        if (next.dwell) state.dwellQueue.shift();
        else state.queue.shift();

        this.launch(state, next.task, next.dwell);
        progressed = true;

        if (this.active.size >= WARMER_LANES) break;
      }

      if (!progressed) break;
    }

    this.report();
  }

  private canLaunch(state: WarmerSourceState): boolean {
    if (this.active.size >= WARMER_LANES) return false;
    return this.runningFor(state.source.id) < this.laneLimit(state);
  }

  private runningFor(sourceId: string): number {
    let running = 0;
    for (const job of this.active.values()) {
      if (job.sourceId === sourceId) running += 1;
    }

    return running;
  }

  private laneLimit(state: WarmerSourceState): number {
    return Math.min(state.source.lanes, WARMER_LANES);
  }

  private nextLaunchable(state: WarmerSourceState): { task: PreloadTask; dwell: boolean } | null {
    const entry = this.headTask(state, false);
    if (entry === "gated") return null;
    if (entry !== null) return { task: entry, dwell: false };

    const dwell = this.headTask(state, true);
    if (dwell === "gated") return null;
    if (dwell !== null) return { task: dwell, dwell: true };

    return null;
  }

  private headTask(state: WarmerSourceState, dwell: boolean): PreloadTask | "gated" | null {
    const queue = dwell ? state.dwellQueue : state.queue;

    while (queue.length > 0) {
      const task = queue[0];
      if (this.isGated(state, task)) return "gated";

      if (this.isSkipped(task.key)) {
        queue.shift();
        state.done += 1;

        if (!dwell) state.entryDone += 1;

        continue;
      }

      if (task.needs !== undefined && !this.areParentsReady(task.needs)) {
        queue.shift();
        state.total -= 1;

        if (!dwell) state.entryTotal -= 1;

        continue;
      }

      return task;
    }

    return null;
  }

  private isSkipped(key: string): boolean {
    return this.warmed.has(key) || this.missing.has(key) || this.active.has(key);
  }

  private isGated(state: WarmerSourceState, task: PreloadTask): boolean {
    const gate = this.sources.get(state.source.after ?? "");
    if (gate === undefined) return false;

    const zoom = task.zoom ?? Infinity;
    if (gate.queue.some((queued) => isThroughZoom(queued.zoom, zoom))) return true;
    if (gate.dwellQueue.some((queued) => isThroughZoom(queued.zoom, zoom))) return true;

    return [...this.active.values()].some((job) => {
      return job.sourceId === gate.source.id && isThroughZoom(job.zoom, zoom);
    });
  }

  private areParentsReady(needs: string[]): boolean {
    return needs.every((need) => this.warmed.has(need) || this.active.has(need));
  }

  private launch(state: WarmerSourceState, task: PreloadTask, dwell: boolean): void {
    const abort = new AbortController();
    const job: WarmerActive = {
      abort,
      sourceId: state.source.id,
      zoom: task.zoom,
      settled: false,
      dwell,
    };
    this.active.set(task.key, job);

    if (dwell) noteDwellWarmerRequest();

    Promise.resolve()
      .then(() => task.run(abort))
      .then(
        () => this.settle(state, job, task.key, null),
        (error: unknown) => this.settle(state, job, task.key, { error }),
      );
  }

  private settle(
    state: WarmerSourceState,
    job: WarmerActive,
    key: string,
    failure: { error: unknown } | null,
  ): void {
    if (this.active.get(key) !== job) return;
    if (job.settled) return;

    job.settled = true;
    this.active.delete(key);

    if (this.destroyed) return;
    if (this.sources.get(state.source.id) !== state) return;

    state.done += 1;

    if (!job.dwell) state.entryDone += 1;
    if (failure === null) {
      this.warmed.add(key);
    } else if (isMissingResponse(failure.error)) this.missing.add(key);

    this.report();
    this.pump();
  }

  private cancelJob(key: string, job: WarmerActive): void {
    if (job.settled) return;

    job.settled = true;
    this.active.delete(key);
    job.abort.abort();
  }

  /** Warm the resting viewport once per dwell, replacing the previous dwell. */
  private warmDwell(): void {
    if (this.destroyed || !this.isLanded || this.fittedZoom === null) return;

    const viewport = restingViewport(this.map);
    const currentZoom = this.map.getZoom?.();
    if (!viewport || typeof currentZoom !== "number") return;

    const candidates = this.dwellCandidates(viewport, this.fittedZoom, currentZoom);
    this.abortStaleDwell(candidates);

    const planned = this.capDwell(candidates);

    for (const state of this.sources.values()) {
      state.total -= state.dwellQueue.length;
      state.dwellQueue = [];
    }

    for (const { state, task } of planned) {
      state.dwellQueue.push(task);
      state.total += 1;
    }

    this.pump();
  }

  private dwellCandidates(
    viewport: DwellViewport,
    fittedZoom: number,
    currentZoom: number,
  ): Map<WarmerSourceState, PreloadTask[]> {
    const candidates = new Map<WarmerSourceState, PreloadTask[]>();

    for (const state of this.sources.values()) {
      const tasks = state.source.dwell?.(viewport, fittedZoom, currentZoom) ?? [];
      candidates.set(
        state,
        tasks.filter((task) => !this.warmed.has(task.key) && !this.missing.has(task.key)),
      );
    }

    return candidates;
  }

  private abortStaleDwell(candidates: Map<WarmerSourceState, PreloadTask[]>): void {
    for (const [state, tasks] of candidates) {
      const wanted = new Set(tasks.map((task) => task.key));

      for (const [key, job] of [...this.active]) {
        if (job.sourceId !== state.source.id || !job.dwell) continue;
        if (wanted.has(key)) continue;

        this.cancelJob(key, job);
        state.total -= 1;
      }
    }
  }

  private capDwell(
    candidates: Map<WarmerSourceState, PreloadTask[]>,
  ): { state: WarmerSourceState; task: PreloadTask }[] {
    const budget = Math.max(0, DWELL_REQUEST_CAP - this.countActiveDwell());
    const queueable = this.queueableDwell(candidates);
    const planned: { state: WarmerSourceState; task: PreloadTask }[] = [];
    let index = 0;

    while (planned.length < budget) {
      let progressed = false;

      for (const [state, tasks] of queueable) {
        if (index >= tasks.length) continue;

        planned.push({ state, task: tasks[index] });
        progressed = true;

        if (planned.length >= budget) break;
      }

      if (!progressed) break;

      index += 1;
    }

    return planned;
  }

  private countActiveDwell(): number {
    let activeDwell = 0;
    for (const job of this.active.values()) {
      if (job.dwell) activeDwell += 1;
    }

    return activeDwell;
  }

  private queueableDwell(
    candidates: Map<WarmerSourceState, PreloadTask[]>,
  ): Map<WarmerSourceState, PreloadTask[]> {
    const queueable = new Map<WarmerSourceState, PreloadTask[]>();

    for (const [state, tasks] of candidates) {
      queueable.set(
        state,
        tasks.filter((task) => !this.active.has(task.key) && !this.isEntryQueued(task.key)),
      );
    }

    return queueable;
  }

  private isEntryQueued(key: string): boolean {
    for (const state of this.sources.values()) {
      if (state.queue.some((task) => task.key === key)) return true;
    }

    return false;
  }

  private report(): void {
    let done = 0;
    let total = 0;

    for (const state of this.sources.values()) {
      done += state.entryDone;
      total += state.entryTotal;
    }

    setWarmerEntryProgress(done, total);
    this.wake();
  }

  private wake(): void {
    const listeners = [...this.wakeListeners];
    this.wakeListeners.clear();

    for (const listener of listeners) listener();
  }
}

// A trace without a zoom still waits for the gate, so missing zooms never skip the order.
function isThroughZoom(taskZoom: number | undefined, zoom: number): boolean {
  return taskZoom === undefined || taskZoom <= zoom;
}

/** Whether an HTTP failure is a missing ocean tile that should not warm again. */
function isMissingResponse(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  return message.includes("Bad response: 404");
}

/** The resting viewport edges, or null when the map hides its bounds. */
function restingViewport(map: WarmerMap): DwellViewport | null {
  try {
    const bounds = map.getBounds?.();
    if (!bounds) return null;

    return {
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    };
  } catch {
    return null;
  }
}
