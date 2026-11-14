/** Dev-only frame and fetch readout shown under the backend badge. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { fetchStats } from "./merging-store";
import { BASEMAP_SOURCE_ID } from "./render/tile-viewport";

const FPS_WINDOW_MS = 1000;
const WORST_WINDOW_MS = 5 * 1000;
const REFRESH_MS = 500;

// A gesture that never ends still settles, so continuous movement cannot hold the badge open.
const SETTLE_TIMEOUT_MS = 10 * 1000;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

const DEV_STATS_CLASS = "has-dev-stats";
const LONGTASK_ENTRY = "longtask";

const RELIEF_LAYER_SUFFIX = "-relief";
const CONTOUR_LINES_SUFFIX = "-contour-lines";

/** The map surface the dev badge reads. Tile listeners stay optional for tests. */
export type DevStatsMap = Pick<MapLibreMap, "getZoom">
  & Partial<Pick<MapLibreMap, "on" | "off" | "isSourceLoaded" | "getSource" | "getStyle">>;

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

/** Pool activity for one gesture, so terrain and contour settle come from the pool. */
export interface PoolSettleState {
  requests: number;
  viewReady: boolean;
}

/** Opening start and open-to-drawn time for the current scene. */
export const sceneLoadStats = { startMs: 0, loadMs: null as number | null };

/** The wait before the entry flight and the gap from landing to the fade start, in milliseconds. */
export const entryStats = { waitMs: null as number | null, gapMs: null as number | null };

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
  entryStats.waitMs = null;
  entryStats.gapMs = null;
}

/** Remember how long the entry waited for preparation before the flight began. */
export function noteEntryWait(waitMs: number): void {
  entryStats.waitMs = waitMs;
}

/** Remember how long staging took between the landing and the start of the fade. */
export function noteEntryGap(gapMs: number): void {
  entryStats.gapMs = gapMs;
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
 * opens on movestart and checks every render for the view tiles, so a drain mid-gesture
 * settles without waiting for moveend while ring refills never hold it open. The tracker
 * stays idle until started, so production builds without the badge keep no listeners.
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
  private poolRequestsAtStart: number | null = null;

  constructor(
    private readonly map: DevStatsMap,
    private readonly clock: () => number = () => performance.now(),
    private readonly poolProbe?: () => PoolSettleState | null,
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
    const rendered = (): void => this.settlePool(this.clock());
    this.map.on("movestart", gestureStart);
    this.map.on("zoomstart", zoomStart);
    this.map.on("sourcedataloading", loading);
    this.map.on("sourcedata", loaded);
    this.map.on("moveend", drained);
    this.map.on("idle", drained);
    this.map.on("render", rendered);
    this.stopListening = (): void => {
      this.map.off?.("movestart", gestureStart);
      this.map.off?.("zoomstart", zoomStart);
      this.map.off?.("sourcedataloading", loading);
      this.map.off?.("sourcedata", loaded);
      this.map.off?.("moveend", drained);
      this.map.off?.("idle", drained);
      this.map.off?.("render", rendered);
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
    this.poolRequestsAtStart = poolSettleState(this.poolProbe)?.requests ?? null;
    // Held tiles settle at once instead of waiting for the next render or moveend.
    this.settlePool(nowMs);
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
   * Settle the basemap when its sources already report loaded. A cached gesture emits no
   * loads, so its end time is the settle time. Terrain and contours have no MapLibre
   * source, so they settle through the pool view readiness instead.
   */
  private settleLoaded(nowMs: number): void {
    const startMs = this.stepStartMs;
    if (startMs === null) return;
    for (const key of ["terrain", "basemap", "contours"] as const) {
      if (this.layers[key].settleMs !== null) continue;
      if (key !== "basemap") continue;
      if (this.seenSources[key].size === 0) {
        this.layers[key].settleMs = nowMs - startMs;
        continue;
      }
      if (allSourcesLoaded(this.map, this.seenSources[key])) {
        this.layers[key].settleMs = nowMs - startMs;
      }
    }
    this.settlePool(nowMs);
  }

  private settlePool(nowMs: number): void {
    const startMs = this.stepStartMs;
    if (startMs === null) return;
    const state = poolSettleState(this.poolProbe);
    if (!state) return;
    if (nowMs - startMs >= SETTLE_TIMEOUT_MS) {
      this.settleGesturePool(nowMs, state.requests);
      return;
    }
    if (!state.viewReady) {
      this.reopenGesturePool();
      return;
    }
    this.settleGesturePool(nowMs, state.requests);
  }

  private reopenGesturePool(): void {
    // A new view wave reopens timing while ring refills keep viewReady true.
    for (const key of ["terrain", "contours"] as const) {
      if (this.layers[key].settleMs !== null) this.layers[key].settleMs = null;
    }
  }

  private settleGesturePool(nowMs: number, requests: number): void {
    const startMs = this.stepStartMs;
    if (startMs === null) return;
    for (const key of ["terrain", "contours"] as const) {
      if (this.layers[key].settleMs !== null) continue;
      this.layers[key].settleMs = nowMs - startMs;
      if (this.poolRequestsAtStart !== null) {
        this.layers[key].requests = requests - this.poolRequestsAtStart;
      }
    }
  }
}

/** Map a source id to its dev-readout layer. Relief and contour lines are custom GPU
 * layers with no MapLibre source, so only the basemap still settles through source events
 * while terrain and contour settle come from the pool view readiness. */
export function layerForSource(sourceId: string | undefined): TileLayerKey | null {
  if (!sourceId) return null;
  if (sourceId === BASEMAP_SOURCE_ID) return "basemap";
  return null;
}

let preloadDisabled = false;

/** Remember whether `?preload=0` disabled preload, so the badge says so. */
export function setPreloadDisabled(disabled: boolean): void {
  preloadDisabled = disabled;
}

/** Whether preload is disabled, so the badge shows off instead of numbers. */
export function isPreloadDisabled(): boolean {
  return preloadDisabled;
}

/** Entry tasks settled out of those planned for the open scene. */
export interface WarmerEntry {
  done: number;
  total: number;
}

/** The badge shows entry progress separately from cumulative dwell launches. */
export interface WarmerSnapshot {
  entry: WarmerEntry;
  dwell: number;
}

let warmerOnFlag = false;
let warmerEntry: WarmerEntry = { done: 0, total: 0 };
let warmerDwell = 0;

/** Remember whether a scene preload runs, so the badge shows its counts. */
export function setWarmerEnabled(enabled: boolean): void {
  warmerOnFlag = enabled;
}

/** Whether a scene preload runs, so the badge shows its counts. */
export function isWarmerEnabled(): boolean {
  return warmerOnFlag;
}

/** Clear the warmer numbers when a scene opens, so the badge shows this scene only. */
export function beginWarmer(): void {
  warmerEntry = { done: 0, total: 0 };
  warmerDwell = 0;
}

/** Count one dwell launch, so resting work stays apart from the entry plan. */
export function noteDwellWarmerRequest(): void {
  warmerDwell += 1;
}

/** Record entry tasks settled out of those planned, excluding every dwell. */
export function setWarmerEntryProgress(done: number, total: number): void {
  warmerEntry = { done, total };
}

/** Copy the warmer numbers so the badge never mutates tracker state. */
export function warmerSnapshot(): WarmerSnapshot {
  return { entry: { ...warmerEntry }, dwell: warmerDwell };
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
  // A removed source counts as loaded because querying it would fire a Map error.
  if (!sourceExists(map, sourceId)) return true;
  try {
    return map.isSourceLoaded(sourceId);
  } catch {
    return false;
  }
}

function sourceExists(map: DevStatsMap, sourceId: string): boolean {
  // Doubles without the API keep the old lookup so existing tests stay honest.
  if (typeof map.getSource !== "function") return true;
  try {
    return map.getSource(sourceId) !== undefined;
  } catch {
    return false;
  }
}

function retireRemovedSources(map: DevStatsMap, sourceIds: Set<string>): void {
  // The style drops its manager before the removal event, so retired IDs must never block.
  for (const sourceId of [...sourceIds]) {
    if (!sourceExists(map, sourceId)) sourceIds.delete(sourceId);
  }
}

function allSourcesLoaded(
  map: DevStatsMap,
  sourceIds: Set<string>,
  loadedId?: string,
): boolean {
  retireRemovedSources(map, sourceIds);
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
    entry: entryStats.waitMs === null ? undefined : { ...entryStats },
    warmer: isWarmerEnabled() ? warmerSnapshot() : undefined,
    pool: readPoolSnapshot(gpu.msByLayer),
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
  /** Warmer progress and request counts, present only while a scene preload runs. */
  warmer?: WarmerSnapshot;
  /** Pool counts, absent without a pool. Terrain and contour settle come from these. */
  pool?: GpuPoolSnapshot;
  /** Pre-flight wait and landing-to-fade gap of the last entry, absent outside an entry. */
  entry?: EntryStats;
}

/** The pool counts the badge shows, with GPU ms when timed. */
export interface GpuPoolSnapshot {
  textures: number;
  textureMB: number;
  inflight: number;
  queued: number;
  requests: number;
  decodeMs: number;
  reliefMs?: number;
  contourMs?: number;
}

/** How long the last entry waited before its flight and between landing and fade start. */
export interface EntryStats {
  waitMs: number | null;
  gapMs: number | null;
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

/** Build the two badge lines from one snapshot, frame and request costs above loading detail. */
export function formatDevStats(snapshot: DevStatsSnapshot): string {
  const load = snapshot.loadMs === null ? "—" : `${Math.round(snapshot.loadMs)} ms`;
  const frame = `${snapshot.fps} fps · worst ${snapshot.worstMs.toFixed(0)} ms`
    + ` · z ${snapshot.zoom.toFixed(1)} · load ${load}`
    + ` · ${snapshot.requests} req ${formatBytes(snapshot.bytes)}`
    + ` · ${formatGpuPart(snapshot.gpuMs, snapshot.gpuUnavailable)}`;
  const loading = formatEntrySuffix(snapshot.entry)
    + formatBakeSuffix(snapshot.bake)
    + formatTileSuffix(snapshot.tiles)
    + formatPreloadSuffix()
    + formatWarmerSuffix(snapshot.warmer)
    + formatPoolSuffix(snapshot.pool)
    + ` · ${snapshot.longtasks} long`;

  return `${frame}\n${loading.slice(" · ".length)}`;
}

/** The entry suffix for the badge line, empty until an entry has waited. */
function formatEntrySuffix(entry?: EntryStats): string {
  if (!entry || entry.waitMs === null) return "";
  const gap = entry.gapMs === null ? "—" : `${Math.round(entry.gapMs)} ms`;

  return ` · entry wait ${Math.round(entry.waitMs)} ms gap ${gap}`;
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

/** The preload suffix for the badge line, shown only when preload is disabled. */
function formatPreloadSuffix(): string {
  if (isPreloadDisabled()) return " · preload off";
  return "";
}

/** Build the badge's warmer part from its entry progress and dwell launches. */
export function formatWarmerPart(warmer: WarmerSnapshot): string {
  const { done, total } = warmer.entry;
  return `warmer entry ${done}/${total} dwell ${warmer.dwell}`;
}

/** The warmer suffix for the badge line. It stays empty unless a scene preload runs. */
function formatWarmerSuffix(warmer?: WarmerSnapshot): string {
  if (!warmer) return "";
  return ` · ${formatWarmerPart(warmer)}`;
}

/** Build the badge's pool part from its counts, with GPU ms when the timer kept them. */
export function formatPoolPart(pool: GpuPoolSnapshot): string {
  const base = `pool ${pool.textures} tex ${pool.textureMB.toFixed(1)} MB`
    + ` inflight ${pool.inflight} queued ${pool.queued}`
    + ` req ${pool.requests} decode ${pool.decodeMs.toFixed(1)} ms`;
  return base + formatPoolGpuSuffix(pool);
}

/** The pool suffix for the badge line. It stays empty without a pool. */
function formatPoolSuffix(pool?: GpuPoolSnapshot): string {
  if (!pool) return "";
  return ` · ${formatPoolPart(pool)}`;
}

/** The relief and contour GPU ms for the pool line, empty when the timer kept neither. */
function formatPoolGpuSuffix(pool: GpuPoolSnapshot): string {
  const relief = pool.reliefMs === undefined ? "" : ` relief ${pool.reliefMs.toFixed(1)} ms`;
  const contour = pool.contourMs === undefined ? "" : ` contour ${pool.contourMs.toFixed(1)} ms`;
  return `${relief}${contour}`;
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

/** Read the pool counts without creating work elsewhere. */
function readPoolSnapshot(msByLayer: Record<string, number>): GpuPoolSnapshot | undefined {
  const stats = readHookPoolStats();
  if (!stats) return undefined;
  return {
    textures: stats.textures,
    textureMB: stats.textureBytes / BYTES_PER_MB,
    inflight: stats.inflight,
    queued: stats.queueDepth,
    requests: stats.requests,
    decodeMs: stats.meanDecodeMs,
    reliefMs: gpuMsFor(msByLayer, RELIEF_LAYER_SUFFIX),
    contourMs: gpuMsFor(msByLayer, CONTOUR_LINES_SUFFIX),
  };
}

/** The pool stats the window hook reports, without importing the pool module. */
interface PoolHookStats {
  textures: number;
  textureBytes: number;
  inflight: number;
  queueDepth: number;
  requests: number;
  meanDecodeMs: number;
}

/** Read the pool settle state through an explicit probe or the window hook. */
function poolSettleState(
  probe?: () => PoolSettleState | null,
): PoolSettleState | null {
  if (probe) return probe();
  const stats = readHookPoolStats();
  if (!stats) return null;
  const viewReady = readHookPoolReady();
  if (viewReady === null) return null;
  return {
    requests: stats.requests,
    viewReady,
  };
}

/** Read the pool stats through the window hook the pool module publishes. */
function readHookPoolStats(): PoolHookStats | null {
  try {
    const scope = globalThis as unknown as {
      __getDemPoolStats?: (tileUrl?: string) => PoolHookStats | null;
    };
    if (typeof scope.__getDemPoolStats !== "function") return null;
    return scope.__getDemPoolStats() ?? null;
  } catch {
    return null;
  }
}

/** Read the view readiness through the window hook the pool module publishes. */
function readHookPoolReady(): boolean | null {
  try {
    const scope = globalThis as unknown as {
      __getDemPoolViewReady?: (tileUrl?: string) => boolean | null;
    };
    if (typeof scope.__getDemPoolViewReady !== "function") return null;
    return scope.__getDemPoolViewReady() ?? null;
  } catch {
    return null;
  }
}

/** The GPU ms of the first layer whose id ends with the suffix, if the timer kept any. */
function gpuMsFor(msByLayer: Record<string, number>, suffix: string): number | undefined {
  for (const [name, ms] of Object.entries(msByLayer)) {
    if (name.endsWith(suffix)) return ms;
  }
  return undefined;
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
