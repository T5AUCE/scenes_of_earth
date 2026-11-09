/** Dev-only frame and fetch readout shown under the backend badge. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { fetchStats } from "./merging-store";

const FPS_WINDOW_MS = 1000;
const WORST_WINDOW_MS = 5 * 1000;
const REFRESH_MS = 500;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

const DEV_STATS_CLASS = "has-dev-stats";
const LONGTASK_ENTRY = "longtask";

const RELIEF_SUFFIX = "-relief";
const CONTOUR_SUFFIX = "-contours";
/** The Liberty basemap source, whose loads the readout groups as basemap. */
const BASEMAP_SOURCE_ID = "openmaptiles";

/** The map surface the dev badge reads. Tile listeners stay optional for tests. */
export type DevStatsMap = Pick<MapLibreMap, "getZoom">
  & Partial<Pick<MapLibreMap, "on" | "off" | "isSourceLoaded" | "getStyle">>;

/** One per-step tile layer in the dev readout. */
export type TileLayerKey = "terrain" | "basemap" | "contours";

/** Settle time and request count for one tile layer after a zoom step. */
export interface TileStepStats {
  settleMs: number | null;
  requests: number;
}

/** Per-layer settle times after the last zoom step. The badge shows them only in dev. */
export interface TileSettleSnapshot {
  terrain: TileStepStats;
  basemap: TileStepStats;
  contours: TileStepStats;
}

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
  map: DevStatsMap,
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
  private longtasks = 0;
  private observer: PerformanceObserver | null = null;
  private readonly settle: TileSettleTracker;

  constructor(
    private readonly element: HTMLElement,
    private readonly map: DevStatsMap,
  ) {
    this.settle = new TileSettleTracker(map);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.element.hidden = false;
    document.body.classList.add(DEV_STATS_CLASS);
    this.startLongtasks();
    this.settle.start();
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    cancelAnimationFrame(this.frameId);
    this.stopLongtasks();
    this.settle.stop();
    this.element.hidden = true;
    document.body.classList.remove(DEV_STATS_CLASS);
  }

  private readonly tick = (nowMs: number): void => {
    if (!this.isRunning) return;
    recordFrame(this.stamps, nowMs);
    if (nowMs - this.renderedMs >= REFRESH_MS) {
      this.renderedMs = nowMs;
      const base = snapshot(this.stamps, nowMs, this.map, this.longtasks);
      const text = formatDevStats({ ...base, tiles: this.settle.snapshot() });
      renderDevStats(this.element, text);
    }
    this.frameId = requestAnimationFrame(this.tick);
  };

  private startLongtasks(): void {
    try {
      if (typeof PerformanceObserver === "undefined") return;
      const observer = new PerformanceObserver((entries) => {
        this.longtasks += entries.getEntries().length;
      });
      observer.observe({ entryTypes: [LONGTASK_ENTRY] });
      this.observer = observer;
    } catch {
      this.observer = null;
    }
  }

  private stopLongtasks(): void {
    try {
      this.observer?.disconnect();
    } catch {
      // A missing observer must not keep the badge visible.
    }
    this.observer = null;
  }
}

/**
 * Track per-layer settle times across one camera gesture for the dev readout. The step
 * opens on movestart and stays open through sourcedata and idle, so zoomend and moveend
 * never discard requests or settle times mid-gesture. The tracker stays idle until
 * started, so production builds without the badge keep no listeners and no cost.
 */
export class TileSettleTracker {
  private stepStartMs: number | null = null;
  private readonly layers: Record<TileLayerKey, TileStepStats> = {
    terrain: { settleMs: null, requests: 0 },
    basemap: { settleMs: null, requests: 0 },
    contours: { settleMs: null, requests: 0 },
  };
  private readonly seenSources: Record<TileLayerKey, Set<string>> = {
    terrain: new Set(),
    basemap: new Set(),
    contours: new Set(),
  };
  private stopListening: () => void = () => {};

  constructor(
    private readonly map: DevStatsMap,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  start(): void {
    if (typeof this.map.on !== "function" || typeof this.map.off !== "function") return;
    const gestureStart = (): void => this.beginStep(this.clock());
    const zoomStart = (): void => {
      // A programmatic zoom opens a step only outside a gesture, so mid-gesture zooms keep counts.
      if (this.stepStartMs === null) this.beginStep(this.clock());
    };
    // Each source load reaches the map as both dataloading and sourcedataloading.
    const loading = (event: unknown): void => this.noteRequest(event);
    const loaded = (event: unknown): void => this.noteLoaded(event);
    const drained = (): void => this.settleLoaded(this.clock());
    this.map.on("movestart", gestureStart);
    this.map.on("zoomstart", zoomStart);
    this.map.on("sourcedataloading", loading);
    this.map.on("sourcedata", loaded);
    this.map.on("moveend", drained);
    this.map.on("idle", drained);
    this.stopListening = (): void => {
      this.map.off?.("movestart", gestureStart);
      this.map.off?.("zoomstart", zoomStart);
      this.map.off?.("sourcedataloading", loading);
      this.map.off?.("sourcedata", loaded);
      this.map.off?.("moveend", drained);
      this.map.off?.("idle", drained);
    };
  }

  stop(): void {
    this.stopListening();
    this.stopListening = (): void => {};
  }

  /** Copy the current per-layer counts so the badge never mutates tracker state. */
  snapshot(): TileSettleSnapshot {
    return {
      terrain: { ...this.layers.terrain },
      basemap: { ...this.layers.basemap },
      contours: { ...this.layers.contours },
    };
  }

  private beginStep(nowMs: number): void {
    this.stepStartMs = nowMs;
    for (const key of ["terrain", "basemap", "contours"] as const) {
      this.layers[key] = { settleMs: null, requests: 0 };
      this.seenSources[key].clear();
    }
    this.seedSeenSources();
  }

  private seedSeenSources(): void {
    // Cached tiles emit no loads, so the gesture starts from the style sources.
    for (const sourceId of styleSourceIds(this.map)) {
      const layer = layerForSource(sourceId);
      if (layer) this.seenSources[layer].add(sourceId);
    }
  }

  private noteRequest(event: unknown): void {
    if (this.stepStartMs === null) return;
    const sourceId = sourceIdOf(event);
    const layer = layerForSource(sourceId);
    if (!layer || !sourceId) return;
    this.layers[layer].requests += 1;
    this.seenSources[layer].add(sourceId);
    // A later load reopens the layer so the second wave times its own settle.
    if (this.layers[layer].settleMs !== null) this.layers[layer].settleMs = null;
  }

  private noteLoaded(event: unknown): void {
    if (this.stepStartMs === null) return;
    const sourceId = sourceIdOf(event);
    const layer = layerForSource(sourceId);
    if (!layer || this.layers[layer].settleMs !== null) return;
    const eventSourceId = eventLoaded(event) ? sourceId : undefined;
    if (eventSourceId === undefined && !sourceLoaded(this.map, sourceId)) return;
    // One sibling may settle while another still loads, so wait for every tracked source.
    if (!allSourcesLoaded(this.map, this.seenSources[layer], eventSourceId)) return;
    this.layers[layer].settleMs = this.clock() - this.stepStartMs;
  }

  /**
   * Settle every requested layer whose sources already report loaded. A cached
   * gesture emits no loads, so its end time is the settle time.
   */
  private settleLoaded(nowMs: number): void {
    const startMs = this.stepStartMs;
    if (startMs === null) return;
    for (const key of ["terrain", "basemap", "contours"] as const) {
      if (this.layers[key].settleMs !== null) continue;
      if (this.seenSources[key].size === 0) {
        this.layers[key].settleMs = nowMs - startMs;
        continue;
      }
      if (allSourcesLoaded(this.map, this.seenSources[key])) {
        this.layers[key].settleMs = nowMs - startMs;
      }
    }
  }
}

/** Map a source id to its dev-readout layer. Scene data and helpers map to null. */
export function layerForSource(sourceId: string | undefined): TileLayerKey | null {
  if (!sourceId) return null;
  if (sourceId === BASEMAP_SOURCE_ID) return "basemap";
  if (sourceId.endsWith(RELIEF_SUFFIX)) return "terrain";
  if (sourceId.endsWith(CONTOUR_SUFFIX)) return "contours";
  return null;
}

function sourceIdOf(event: unknown): string | undefined {
  const sourceId = (event as { sourceId?: unknown }).sourceId;
  return typeof sourceId === "string" ? sourceId : undefined;
}

function eventLoaded(event: unknown): boolean {
  return (event as { isSourceLoaded?: unknown }).isSourceLoaded === true;
}

function sourceLoaded(map: DevStatsMap, sourceId: string | undefined): boolean {
  if (!sourceId || typeof map.isSourceLoaded !== "function") return false;
  try {
    return map.isSourceLoaded(sourceId);
  } catch {
    return false;
  }
}

function allSourcesLoaded(
  map: DevStatsMap,
  sourceIds: ReadonlySet<string>,
  loadedId?: string,
): boolean {
  for (const sourceId of sourceIds) {
    if (sourceId === loadedId) continue;
    if (!sourceLoaded(map, sourceId)) return false;
  }
  return true;
}

function styleSourceIds(map: DevStatsMap): string[] {
  try {
    const sources = map.getStyle?.()?.sources;
    if (!sources) return [];
    return Object.keys(sources);
  } catch {
    return [];
  }
}

/** Start the frame loop and refresh the badge about twice a second. */
export function startDevStats(element: HTMLElement, map: DevStatsMap): () => void {
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
  map: DevStatsMap,
  longtasks: number,
): DevStatsSnapshot {
  const gpu = readGpuSnapshot();
  return {
    fps: framesPerSecond(stamps, nowMs),
    worstMs: worstFrameMs(stamps),
    zoom: map.getZoom(),
    loadMs: sceneLoadStats.loadMs,
    requests: fetchStats.requests,
    bytes: fetchStats.bytes,
    gpuMs: gpu.msByLayer,
    gpuUnavailable: gpu.unavailable,
    bake: readBakeSnapshot(),
    longtasks,
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
  /** Last per-custom-layer GPU milliseconds from disjoint timer queries. */
  gpuMs: Record<string, number>;
  /** Whether the timer extension is absent, so the badge shows n/a. */
  gpuUnavailable: boolean;
  /** One-time band-bake time and retained bytes by layer, absent without `?bake=1`. */
  bake?: Record<string, BakeStats>;
  /** Count of main-thread tasks over 50 ms since the loop started. */
  longtasks: number;
  /** Per-layer settle times after the last zoom step, present only while tracking. */
  tiles?: TileSettleSnapshot;
}

/** One layer's band-bake cost for the dev readout. */
export interface BakeStats {
  /** CPU milliseconds spent baking the band, excluding idle gaps between chunks. */
  ms: number;
  /** Retained CPU band bytes for the grid. */
  cpuBytes: number;
  /** Uploaded GPU band bytes across tile windows, including halo duplication. */
  gpuBytes: number;
}

/** Build the compact badge line from one snapshot. */
export function formatDevStats(snapshot: DevStatsSnapshot): string {
  const load = snapshot.loadMs === null ? "—" : `${Math.round(snapshot.loadMs)} ms`;
  return `${snapshot.fps} fps · worst ${snapshot.worstMs.toFixed(0)} ms`
    + ` · z ${snapshot.zoom.toFixed(1)} · load ${load}`
    + ` · ${snapshot.requests} req ${formatBytes(snapshot.bytes)}`
    + ` · ${formatGpuPart(snapshot.gpuMs, snapshot.gpuUnavailable)}`
    + formatBakeSuffix(snapshot.bake)
    + formatTileSuffix(snapshot.tiles)
    + ` · ${snapshot.longtasks} long`;
}

/** Build the badge's GPU part from the last per-layer timings. */
export function formatGpuPart(msByLayer: Record<string, number>, unavailable: boolean): string {
  const names = Object.keys(msByLayer).sort();
  if (names.length === 0 || unavailable) return "gpu n/a";
  return `gpu ${names.map((name) => `${name} ${msByLayer[name].toFixed(1)} ms`).join(" ")}`;
}

/** Build the badge's bake suffix, empty when no layer baked a band. */
export function formatBakePart(bake?: Record<string, BakeStats>): string {
  const names = Object.keys(bake ?? {}).sort();
  if (names.length === 0) return "bake n/a";
  return `bake ${names.map((name) => {
    const stats = bake![name];
    return `${name} ${stats.ms.toFixed(1)} ms ${formatBytes(stats.cpuBytes + stats.gpuBytes)}`;
  }).join(" ")}`;
}

/** The bake suffix for the badge line, empty when no layer baked a band. */
function formatBakeSuffix(bake?: Record<string, BakeStats>): string {
  if (!bake || Object.keys(bake).length === 0) return "";
  return ` · ${formatBakePart(bake)}`;
}

/** Build the badge's tile-settle part from the last zoom step. */
export function formatTileSettlePart(tiles: TileSettleSnapshot): string {
  return `tiles ${formatTileLayer("terrain", tiles.terrain)}`
    + ` ${formatTileLayer("basemap", tiles.basemap)}`
    + ` ${formatTileLayer("contours", tiles.contours)}`;
}

/** The tile suffix for the badge line. It stays empty until the first zoom step settles. */
function formatTileSuffix(tiles?: TileSettleSnapshot): string {
  if (!tiles) return "";
  return ` · ${formatTileSettlePart(tiles)}`;
}

function formatTileLayer(name: string, stats: TileStepStats): string {
  const settle = stats.settleMs === null ? "—" : `${Math.round(stats.settleMs)} ms`;
  return `${name} ${settle} ${stats.requests} req`;
}

/** Read the timer-query timings without creating extension work when disabled. */
function readGpuSnapshot(): { msByLayer: Record<string, number>; unavailable: boolean } {
  try {
    const scope = globalThis as unknown as {
      __gpuMs?: Record<string, number>;
      __gpuUnavailable?: boolean;
    };
    const msByLayer = { ...(scope.__gpuMs ?? {}) };
    return { msByLayer, unavailable: scope.__gpuUnavailable ?? false };
  } catch {
    return { msByLayer: {}, unavailable: false };
  }
}

/** Read the band-bake costs without creating work when the bake never ran. */
function readBakeSnapshot(): Record<string, BakeStats> | undefined {
  try {
    const scope = globalThis as unknown as {
      __bakeStats?: Record<string, BakeStats>;
    };
    if (!scope.__bakeStats || Object.keys(scope.__bakeStats).length === 0) return undefined;
    return { ...scope.__bakeStats };
  } catch {
    return undefined;
  }
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
