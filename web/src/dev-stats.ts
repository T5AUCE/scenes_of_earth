/** Dev-only frame and fetch readout shown under the backend badge. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { fetchStats } from "./merging-store";

const FPS_WINDOW_MS = 1000;
const WORST_WINDOW_MS = 5 * 1000;
const REFRESH_MS = 500;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

const DEV_STATS_CLASS = "has-dev-stats";

/** Opening start and open-to-drawn time for the current scene. */
export const sceneLoadStats = { startMs: 0, loadMs: null as number | null };

/** Decide whether the dev readout may run for this build and address. */
export function shouldShowDevStats(dev: boolean, search: string): boolean {
  if (dev) return true;
  return hasDebugParam(search);
}

function hasDebugParam(search: string): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(query).has("debug");
}

/** Remember when the scene opened so the readout can time its first draw. */
export function noteSceneOpen(nowMs: number): void {
  sceneLoadStats.startMs = nowMs;
  sceneLoadStats.loadMs = null;
}

/** Remember when the layers drew so the readout shows the open-to-drawn time. */
export function noteSceneReady(nowMs: number): void {
  sceneLoadStats.loadMs = nowMs - sceneLoadStats.startMs;
}

// One badge means one loop, so the gate keeps the running one.
let activeLoop: DevStatsLoop | null = null;

/** Show the badge when this build and address allow dev output. */
export function startDevStatsWhenEnabled(
  element: HTMLElement | null,
  map: Pick<MapLibreMap, "getZoom">,
): () => void {
  if (element === null) return () => {};
  if (!shouldShowDevStats(import.meta.env.DEV, location.search)) return () => {};
  if (activeLoop) {
    const running = activeLoop;

    return () => stopActiveLoop(running);
  }
  const loop = new DevStatsLoop(element, map);
  activeLoop = loop;
  loop.start();

  return () => stopActiveLoop(loop);
}

function stopActiveLoop(loop: DevStatsLoop): void {
  loop.stop();
  if (activeLoop === loop) activeLoop = null;
}

/** One badge loop that ignores a second start and hides the badge on stop. */
export class DevStatsLoop {
  private frameId = 0;
  private renderedMs = 0;
  private readonly stamps: number[] = [];
  private isRunning = false;

  constructor(
    private readonly element: HTMLElement,
    private readonly map: Pick<MapLibreMap, "getZoom">,
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.element.hidden = false;
    document.body.classList.add(DEV_STATS_CLASS);
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    cancelAnimationFrame(this.frameId);
    this.element.hidden = true;
    document.body.classList.remove(DEV_STATS_CLASS);
  }

  private readonly tick = (nowMs: number): void => {
    if (!this.isRunning) return;
    recordFrame(this.stamps, nowMs);
    if (nowMs - this.renderedMs >= REFRESH_MS) {
      this.renderedMs = nowMs;
      renderDevStats(this.element, formatDevStats(snapshot(this.stamps, nowMs, this.map)));
    }
    this.frameId = requestAnimationFrame(this.tick);
  };
}

/** Start the frame loop and refresh the badge about twice a second. */
export function startDevStats(element: HTMLElement, map: Pick<MapLibreMap, "getZoom">): () => void {
  const loop = new DevStatsLoop(element, map);
  loop.start();

  return () => loop.stop();
}

function recordFrame(stamps: number[], nowMs: number): void {
  stamps.push(nowMs);
  const kept = pruneStamps(stamps, nowMs);
  stamps.length = 0;
  stamps.push(...kept);
}

function snapshot(
  stamps: readonly number[],
  nowMs: number,
  map: Pick<MapLibreMap, "getZoom">,
): DevStatsSnapshot {
  return {
    fps: framesPerSecond(stamps, nowMs),
    worstMs: worstFrameMs(stamps),
    zoom: map.getZoom(),
    loadMs: sceneLoadStats.loadMs,
    requests: fetchStats.requests,
    bytes: fetchStats.bytes,
  };
}

/** Keep only the stamps of the last five seconds. */
export function pruneStamps(stamps: readonly number[], nowMs: number): number[] {
  const cutoffMs = nowMs - WORST_WINDOW_MS;
  return stamps.filter((stamp) => stamp >= cutoffMs);
}

/** Count the stamps of the last second as the rolling frames per second. */
export function framesPerSecond(stamps: readonly number[], nowMs: number): number {
  const cutoffMs = nowMs - FPS_WINDOW_MS;
  let count = 0;
  for (const stamp of stamps) {
    if (stamp >= cutoffMs) count += 1;
  }
  return count;
}

/** Find the longest gap between consecutive stamps as the worst frame time. */
export function worstFrameMs(stamps: readonly number[]): number {
  let worstMs = 0;
  for (let index = 1; index < stamps.length; index++) {
    worstMs = Math.max(worstMs, stamps[index] - stamps[index - 1]);
  }
  return worstMs;
}

/** The numbers shown in the badge. */
export interface DevStatsSnapshot {
  fps: number;
  worstMs: number;
  zoom: number;
  loadMs: number | null;
  requests: number;
  bytes: number;
}

/** Build the compact badge line from one snapshot. */
export function formatDevStats(snapshot: DevStatsSnapshot): string {
  const load = snapshot.loadMs === null ? "—" : `${Math.round(snapshot.loadMs)} ms`;
  return `${snapshot.fps} fps · worst ${snapshot.worstMs.toFixed(0)} ms`
    + ` · z ${snapshot.zoom.toFixed(1)} · load ${load}`
    + ` · ${snapshot.requests} req ${formatBytes(snapshot.bytes)}`;
}

/** Format a byte count for the badge. */
export function formatBytes(byteCount: number): string {
  if (byteCount < BYTES_PER_KB) return `${byteCount} B`;
  if (byteCount < BYTES_PER_MB) return `${(byteCount / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(byteCount / BYTES_PER_MB).toFixed(1)} MB`;
}

/** Write the badge without forcing layout when the text did not change. */
export function renderDevStats(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
