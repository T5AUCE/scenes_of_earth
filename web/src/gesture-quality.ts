/** Read zoom-performance URL flags in one place and share one camera-gesture subscription. */
import type { Map as MapLibreMap } from "maplibre-gl";

// A capped ratio below half or above three times stays outside normal device ratios.
const MIN_GESTURE_PIXEL_RATIO = 0.5;
const MAX_GESTURE_PIXEL_RATIO = 3;
const MAX_GESTURE_ZOOM = 24;

/**
 * Which optional render paths apply while the camera moves or idles. Label freezing defaults to
 * on because it keeps the rest pixels identical, while the shader fast paths and the band bake
 * default to off because they visibly flatten the map or add memory without a measured benefit.
 */
export interface GestureQualityFlags {
  freezeLabels: boolean;
  fastClass: boolean;
  fastHatch: boolean;
  /** Bake wide windows into band textures when `?bake=1` opts in. */
  bake: boolean;
}

/**
 * Read the gesture and bake flags from the address bar. Label freezing stays on unless
 * its parameter is exactly "0", while the shader fast paths and the band bake need an
 * explicit "1", so the zoom trial enables one path per variant with e.g. `?fastClass=1`
 * while the default run keeps the map faithful.
 */
export function gestureFlags(search: string): GestureQualityFlags {
  return {
    freezeLabels: flagEnabled(search, "freezeLabels"),
    fastClass: flagOptIn(search, "fastClass"),
    fastHatch: flagOptIn(search, "fastHatch"),
    bake: flagOptIn(search, "bake"),
  };
}

/**
 * Read whether the scene preload runs. It stays on unless its parameter is exactly "0", which
 * lets a trial compare a scene with and without the background downloads.
 */
export function preloadEnabled(search: string): boolean {
  return flagEnabled(search, "preload");
}

/**
 * Read whether terrain shading is drawn as fading raster tiles shaded in a worker, which needs
 * an explicit `?shadeFade=1` because its look and cost are still being compared with the hillshade.
 */
export function shadeFadeEnabled(search: string): boolean {
  return flagOptIn(search, "shadeFade");
}

/**
 * Read the measurement-only pixel-ratio cap from the address bar. Returns undefined when
 * absent so the map keeps its default ratio.
 */
export function maxPixelRatioSetting(search: string): number | undefined {
  const value = Number(new URLSearchParams(search).get("maxPixelRatio"));
  const inRange = value >= MIN_GESTURE_PIXEL_RATIO && value <= MAX_GESTURE_PIXEL_RATIO;
  if (!Number.isFinite(value) || !inRange) return undefined;
  return value;
}

/**
 * Read the measurement-only contour and hillshade tiling cap from the address bar. Returns
 * undefined when absent so tiling keeps its default zooms.
 */
export function contourMaxZoomSetting(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("contourMaxZoom");
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_GESTURE_ZOOM) return undefined;
  return Math.floor(value);
}

function flagEnabled(search: string, name: string): boolean {
  return new URLSearchParams(search).get(name) !== "0";
}

function flagOptIn(search: string, name: string): boolean {
  return new URLSearchParams(search).get(name) === "1";
}

/** The address bar query for flag reads, empty outside a browser. */
export function addressSearch(): string {
  try {
    return typeof location === "undefined" ? "" : location.search;
  } catch {
    return "";
  }
}

/** The gesture callbacks of one subscriber; onEnd always follows its onStart exactly once. */
export interface GestureHandler {
  onStart(): void;
  onEnd(): void;
}

type GestureMap = Pick<MapLibreMap, "on" | "off">;

interface GestureHub {
  handlers: Map<GestureHandler, boolean>;
  depth: number;
  active: boolean;
  onMoveStart: () => void;
  onMoveEnd: () => void;
}

const hubs = new WeakMap<object, GestureHub>();

/**
 * Share one movestart/moveend pair per map across every gesture fast path. Nested gestures
 * notify once while any of them runs, a stray moveend without a start is ignored, and
 * unsubscribing mid-gesture restores that subscriber at once so a scene exit cannot leave
 * labels or shader paths frozen.
 */
export function subscribeGesture(map: GestureMap, handler: GestureHandler): () => void {
  if (typeof map.on !== "function" || typeof map.off !== "function") return () => {};
  let hub = hubs.get(map);
  if (!hub) {
    hub = {
      handlers: new Map(),
      depth: 0,
      active: false,
      onMoveStart: () => {},
      onMoveEnd: () => {},
    };
    const started = hub;
    hub.onMoveStart = () => startGesture(started);
    hub.onMoveEnd = () => endGesture(started);
    hubs.set(map, hub);
    map.on("movestart", hub.onMoveStart);
    map.on("moveend", hub.onMoveEnd);
  }

  hub.handlers.set(handler, hub.active);
  if (hub.active) handler.onStart();

  return () => {
    if (!hub!.handlers.has(handler)) return;
    const wasStarted = hub!.handlers.get(handler)!;
    hub!.handlers.delete(handler);
    if (wasStarted) handler.onEnd();
    if (hub!.handlers.size === 0) {
      map.off("movestart", hub!.onMoveStart);
      map.off("moveend", hub!.onMoveEnd);
      hubs.delete(map);
    }
  };
}

/** Whether the map is inside a notified gesture, so rebuilt layers start frozen. */
export function isGestureActive(map: GestureMap): boolean {
  return hubs.get(map)?.active ?? false;
}

function startGesture(hub: GestureHub) {
  hub.depth += 1;
  if (hub.active) return;
  hub.active = true;
  for (const handler of [...hub.handlers.keys()]) {
    hub.handlers.set(handler, true);
    handler.onStart();
  }
}

function endGesture(hub: GestureHub) {
  hub.depth = Math.max(0, hub.depth - 1);
  if (hub.depth > 0 || !hub.active) return;
  hub.active = false;
  for (const handler of [...hub.handlers.keys()]) {
    hub.handlers.set(handler, false);
    handler.onEnd();
  }
}
