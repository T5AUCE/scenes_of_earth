/** Switch one map between the world and a single scene, holding the camera and masking the rest. */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapEventType,
  MapSourceDataEvent,
  VisibilitySpecification,
} from "maplibre-gl";

import { loadAreaFeature } from "./api";
import {
  loadMapDetailsShown,
  subscribeMapDetails,
} from "./display-state";
import { makeHtmlElement } from "./html";
import { polygonParts } from "./label-filter";
import { MAX_ZOOM, removeLayerAndSource, WORLD_VIEW } from "./map";
import { shiftLongitudes, worldShift } from "./render/mercator";
import { UNSYNCED_CHARTS_NOTICE, isCompleteUrlOversized } from "./charts/state";
import { flightDuration, flyIn, watchResize } from "./scene-camera";
import type { SceneStore } from "./scene-store";
import { sceneUrl, timeForPrefix, withChartsToken } from "./scene-url";
import type { AreaFeature, Bbox, DisplayTokens, Scene } from "./types";
import { createScenePanel } from "./ui/scene-panel";
import {
  PANEL_TABS,
  type FullOpenOptions,
  type PanelTab,
} from "./ui/panel-contract";
import { mountScene, OUTLINE_ID } from "./view";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const MASK_ID = "soe-scene-mask";
const FADE_ID = "soe-scene-fade";
const MASK_OPACITY = 1;
// Outside labels show through this much of the page background, so they read as faded.
const FADE_OPACITY = 0.6;
// The mask fades in between these distances (in zoom levels) below the fitted zoom.
const MASK_FADE_START_ZOOM = 1.5;
const MASK_FADE_END_ZOOM = 0.25;
// Data layers appear once the mask is opaque, so their uncropped bbox never shows through it.
const DATA_APPEARS_ZOOM = MASK_FADE_END_ZOOM;
// The flight waits for the mask and the first data, but never longer than this.
const READINESS_CAP_MS = 1500;
const PREPARING_NOTE = "Preparing scene...";
const PAGE_BACKGROUND_PROPERTY = "--page-background";
const HALF_WORLD_DEG = 180;
// Mercator has no poles.
const MAX_LATITUDE_DEG = 85;

const DOCK_GAP_PX = 8;

/**
 * How entering a scene treats history. A push adds a new entry and a replace reuses the entry the
 * page was opened with. Keep leaves history alone because Back or Forward made the change.
 */
export type SceneEntry = "push" | "replace" | "keep";

/**
 * Say which time a scene opens at, as a year, month or day, and how history records the entry.
 * A shared link may also bring display settings.
 */
export interface EnterOptions {
  time: string | null;
  entry: SceneEntry;
  display?: DisplayTokens;
}

/** Group the scene's column and time bar with its full-view dialog. */
export interface SceneRoots {
  column: HTMLElement;
  timeBar: HTMLElement;
  dialog: HTMLDialogElement;
}

type Camera = { center: { lng: number; lat: number } | [number, number]; zoom: number };

interface ActiveScene {
  id: string;
  panel: ReturnType<typeof createScenePanel>;
  clock: SceneClock;
  syncLayers(layerIds: string[]): void;
  close(): void;
}

/** Switch between the world view and one scene with the camera held to its area. */
export function createSceneMode(map: MapLibreMap, roots: SceneRoots) {
  let current: ActiveScene | null = null;
  let worldCamera: Camera | null = null;
  let sceneLayerIds: string[] = [];
  let savedBasemapOrder: string[] | null = null;

  return { enter, exit, sceneId: () => current?.id ?? null, showFullscreen };

  function enter(scene: Scene, { time: linkedTime, entry, display }: EnterOptions) {
    leaveCurrentScene();

    const cards = openColumn(scene, entry);
    const clock = createSceneClock(scene.id);
    // A list holds the deferred call because the checker keeps a narrowed let at null.
    const pendingLayerIds: string[][] = [];
    let panelRef: ReturnType<typeof createScenePanel> | null = null;
    let viewSync: string | null = null;
    let clockSync: string | null = null;
    let initialSync: string | null = null;
    const updatePanelSync = () => {
      const combined = viewSync ?? clockSync;
      if (panelRef) panelRef.setSyncNotice(combined);
      else initialSync = combined;
    };
    const syncFromClock = (notice: string | null) => {
      clockSync = notice;
      updatePanelSync();
    };
    clock.setSyncHandler(syncFromClock);

    const mounted = mountScene(map, scene, {
      cards,
      timeBar: roots.timeBar,
      display,
      onDisplay: (params) => clock.setDisplay(params),
      onCharts: (token) => clock.setCharts(token),
      onChartSync: (notice) => {
        viewSync = notice;
        updatePanelSync();
      },
      onTime: (time, label) => {
        clock.update(time, label);
        current?.panel.setTime(time, label);
      },
      onPlayingChange: (playing) => clock.setPlaying(playing),
      onUnits: (_elevation, _displayUnits, layerIds) => {
        if (!current) {
          pendingLayerIds.push(layerIds);

          return;
        }
        current.syncLayers(layerIds);
      },
    });

    restoreTime(mounted.timeline, linkedTime);
    sceneLayerIds = mounted.layerIds;
    const panel = mountPanel(scene, mounted.timeline, clock, mounted.store);
    panelRef = panel;
    if (initialSync) panel.setSyncNotice(initialSync);

    clock.publishEntry(entry);
    clock.markEntered();

    current = startScene(scene, mounted, panel, clock);
    const initialIds = pendingLayerIds[0];
    if (initialIds) current.syncLayers(initialIds);
    panel.setTime(clock.time, clock.label);
  }

  function exit() {
    if (!current) return;

    closeCurrentScene();

    map.flyTo({ ...(worldCamera ?? WORLD_VIEW), duration: flightDuration() });
    worldCamera = null;
  }

  function showFullscreen(tab: string | null) {
    if (!current) return;

    if (tab === null) {
      if (current.panel.isEditorDirty?.()) {
        current.clock.pushPanel({ panel: "charts" });
        current.panel.showCloseConfirm?.();

        return;
      }
      current.panel.closeFull();
      current.clock.syncUrl();
      return;
    }

    const knownTab = PANEL_TABS.find((known) => known === tab) ?? "about";
    if (!current.panel.isOpen) current.panel.openFull(knownTab);
  }

  function leaveCurrentScene() {
    if (current) return closeCurrentScene();

    worldCamera = { center: map.getCenter(), zoom: map.getZoom() };
  }

  function closeCurrentScene() {
    current?.close();
    current = null;
  }

  function openColumn(scene: Scene, entry: SceneEntry) {
    document.body.classList.add("scene-mode");
    roots.column.hidden = false;

    return makeColumn(scene, roots.column, () => leave(entry !== "replace"));
  }

  function mountPanel(
    scene: Scene,
    timeline: SceneTimeline,
    clock: SceneClock,
    store: SceneStore,
  ) {
    const panel = createScenePanel(scene, roots.dialog, store, {
      requestOpen(tab: PanelTab, options?: FullOpenOptions) {
        clock.pushPanel({ panel: tab });
        panel.openFull(tab, options);
      },
      requestClose() {
        if (history.state?.panel) return history.back();

        panel.closeFull();
        clock.syncUrl();
      },
      stepTime: (delta) => timeline?.move(delta),
    });

    roots.column.append(panel.element);
    return panel;
  }

  function startScene(
    scene: Scene,
    mounted: ReturnType<typeof mountScene>,
    panel: ReturnType<typeof createScenePanel>,
    clock: SceneClock,
  ): ActiveScene {
    const dataLayers = new SceneDataLayers(map, mounted.layerIds);
    const symbolBaseline = snapshotBasemapSymbols(map, new Set(sceneLayerIds));
    const stopDetails = subscribeMapDetails((shown) =>
      setBasemapSymbolsVisible(map, shown, symbolBaseline)
    );
    setBasemapSymbolsVisible(map, loadMapDetailsShown(), symbolBaseline);
    const maskLoad = new AbortController();
    // Once landed, nothing depends on zoom, so the elastic zoom-out dip stays clean.
    let isLanded = false;
    // The flight lifts off after the mask and the first data, so the fade reads its fit meanwhile.
    const flight = flyIn(map, scene, roots, () => {
      isLanded = true;
      dataLayers.update(undefined);
      refreshMaskAndLabels(undefined);
    });
    const fadeZoom = () => (isLanded ? undefined : flight.zoom);
    let isGone = false;

    dataLayers.update(fadeZoom());

    const removePreparing = mounted.addNote(PREPARING_NOTE);
    const stopWaiting = waitForReadiness(startFlight);

    const stopWatchingResize = watchResize(() => {
      flight.refit();
      dataLayers.update(fadeZoom());
      refreshMaskAndLabels(fadeZoom());
    });
    const stopDocking = watchDocking(roots);

    return {
      id: scene.id,
      panel,
      clock,
      syncLayers(layerIds) {
        sceneLayerIds = [...layerIds];
        dataLayers.sync(layerIds);
        liftSceneSymbols(map, sceneLayerIds);
      },
      close() {
        isGone = true;
        stopWaiting();
        removePreparing();
        maskLoad.abort();
        stopWatchingResize();
        stopDocking();
        flight.stopClamp();
        stopDetails();
        removeLayerAndSource(map, FADE_ID);
        removeLayerAndSource(map, MASK_ID);
        restoreBasemapOrder(map, savedBasemapOrder);
        savedBasemapOrder = null;
        restoreBasemapSymbols(map, symbolBaseline);
        panel.destroy();
        mounted.unmount();
        sceneLayerIds = [];
        roots.column.replaceChildren();
        roots.column.hidden = true;
        document.body.classList.remove("scene-mode");
      },
    };

    function startFlight() {
      if (isGone) return;

      stopWaiting();
      removePreparing();
      flight.start();
      dataLayers.update(fadeZoom());
    }

    function waitForReadiness(onReady: () => void) {
      let isDone = false;
      let settled = 0;
      const finish = () => {
        if (isDone || isGone) return;
        isDone = true;
        clearTimeout(capTimer);
        onReady();
      };
      const settleOne = () => {
        settled += 1;
        if (settled >= 2) finish();
      };
      const capTimer = setTimeout(finish, READINESS_CAP_MS);
      // The clock already holds the restored time, so a shared link warms its own month.
      const firstData = mounted.whenFirstDataReady(() => clock.time);
      firstData.ready.then(settleOne, settleOne);
      showAreaMask(scene, fadeZoom, maskLoad.signal)
        .then((isReady) => {
          if (isReady && !maskLoad.signal.aborted) dataLayers.show();
        })
        .catch((error) => {
          if (!maskLoad.signal.aborted) mounted.addNote(error.message);
        })
        .then(settleOne);

      return () => {
        isDone = true;
        firstData.cancel();
        clearTimeout(capTimer);
      };
    }
  }

  // Back goes through history when this page pushed the entry, so Back and the button agree.
  function leave(isPushed: boolean) {
    if (isPushed) return history.back();

    history.replaceState(null, "", location.pathname);
    exit();
  }

  function refreshMaskAndLabels(fittedZoom: number | undefined) {
    if (map.getLayer(MASK_ID)) {
      map.setPaintProperty(MASK_ID, "fill-opacity", maskOpacity(fittedZoom));
    }
    if (map.getLayer(FADE_ID)) {
      map.setPaintProperty(FADE_ID, "fill-opacity", fadeOpacity(fittedZoom));
    }
  }

  async function showAreaMask(
    scene: Scene,
    fadeZoom: () => number | undefined,
    signal: AbortSignal,
  ) {
    const feature = await loadAreaFeature(scene.area.geometry_href).catch((error) => {
      throw new Error(`Area outline: ${error.message}`);
    });
    if (signal.aborted) return false;

    const basemap = basemapLayers(map, new Set(sceneLayerIds));
    savedBasemapOrder = basemap.all;
    const isReady = await loadMask(
      map,
      feature,
      scene.area.bbox,
      fadeZoom(),
      signal,
      sceneLayerIds,
    );
    if (!isReady || signal.aborted) return false;

    return true;
  }
}

/** Keep the docked column above the attribution and time bar. */
function watchDocking(roots: SceneRoots): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};

  try {
    const root = document.documentElement;
    if (!root || !root.style) return () => {};

    const updateDocking = () => {
      const footer = document.querySelector(".maplibregl-ctrl-bottom-left");
      // Only overlapping chrome lifts the column so the desktop gap stays at 8 px.
      const dockBottom = Math.max(
        DOCK_GAP_PX,
        dockedExtent(footer, roots.column) + DOCK_GAP_PX,
        dockedExtent(roots.timeBar, roots.column) + DOCK_GAP_PX,
      );
      root.style.setProperty("--scene-dock-bottom", `${dockBottom}px`);
    };
    const observer = new ResizeObserver(updateDocking);
    if (roots.column instanceof Element) observer.observe(roots.column);
    if (roots.timeBar instanceof Element) observer.observe(roots.timeBar);
    const footer = document.querySelector(".maplibregl-ctrl-bottom-left");
    if (footer instanceof Element) observer.observe(footer);
    window.addEventListener("resize", updateDocking);
    updateDocking();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateDocking);
    };
  } catch {
    return () => {};
  }
}

function dockedExtent(element: Element | null, column: Element | null): number {
  return overlapsColumn(element, column) ? bottomExtent(element) : 0;
}

function overlapsColumn(element: Element | null, column: Element | null): boolean {
  if (!(element instanceof Element)) return false;
  if (!(column instanceof Element)) return true;
  const elementRect = element.getBoundingClientRect();
  const columnRect = column.getBoundingClientRect();
  if (!elementRect || !columnRect) return true;
  // A missing column rect cannot prove separation, so the column stays lifted.
  if (columnRect.width === 0 || columnRect.height === 0) return true;

  return elementRect.left < columnRect.right && elementRect.right > columnRect.left;
}

function bottomExtent(element: Element | null): number {
  if (!(element instanceof HTMLElement)) return 0;

  const rect = element.getBoundingClientRect();
  if (rect.height === 0) return 0;
  if (typeof window === "undefined" || typeof window.innerHeight !== "number") {
    return rect.height;
  }

  return Math.max(0, window.innerHeight - rect.top);
}

/** Gate scene data until the mask is ready without changing visibility or native zoom bounds. */
export class SceneDataLayers {
  private readonly map: MapLibreMap;
  private readonly ranges: { id: string; minzoom: number; maxzoom: number; ref: unknown }[];
  private isReady = false;
  private fittedZoom: number | undefined;

  constructor(map: MapLibreMap, layerIds: string[]) {
    this.map = map;
    this.ranges = layerIds.map((id) => {
      const layer = map.getLayer(id);
      return {
        id,
        minzoom: layer?.minzoom ?? 0,
        maxzoom: layer?.maxzoom ?? MAX_ZOOM,
        ref: layer,
      };
    });
    this.update(undefined);
  }

  update(fittedZoom: number | undefined) {
    this.fittedZoom = fittedZoom;
    for (const { id, minzoom, maxzoom } of this.ranges) {
      const minimum = this.isReady ? Math.max(minzoom, dataMinZoom(fittedZoom)) : maxzoom;
      this.map.setLayerZoomRange(id, Math.min(minimum, maxzoom), maxzoom);
    }
  }

  show() {
    this.isReady = true;
    this.update(this.fittedZoom);
  }

  /**
   * Track recreated layers after a units change. Dropped ids leave the gate and new ids join
   * with their native zooms. The current mask gate applies before the next paint.
   */
  sync(layerIds: string[]) {
    const kept = new Map(this.ranges.map((range) => [range.id, range]));
    this.ranges.length = 0;
    for (const id of layerIds) {
      const layer = this.map.getLayer(id);
      const native = {
        id,
        minzoom: layer?.minzoom ?? 0,
        maxzoom: layer?.maxzoom ?? MAX_ZOOM,
        ref: layer,
      };
      const previous = kept.get(id);
      // Recreated layers need fresh native zooms; unchanged layers retain their original ranges.
      this.ranges.push(previous && previous.ref === layer ? previous : native);
    }
    this.update(this.fittedZoom);
  }
}

function createSceneClock(sceneId: string) {
  let time: string | null = null;
  let label: string | null = null;
  let display = "";
  let chartsToken: string | null = null;
  let isEntered = false;
  let isPlaying = false;
  let syncNotice: string | null = null;
  let lastSafeComplete: string | null = null;
  let onSync: ((notice: string | null) => void) | null = null;

  return {
    get time() {
      return time;
    },

    get label() {
      return label;
    },

    setSyncHandler(handler: (notice: string | null) => void) {
      onSync = handler;
    },

    baseUrl() {
      return sceneUrl(sceneId, label, display);
    },

    fullUrl() {
      const base = sceneUrl(sceneId, label, display);
      if (!chartsToken) return base;

      return withChartsToken(base, chartsToken);
    },

    update(newTime: string | null, newLabel: string | null) {
      time = newTime;
      label = newLabel;
      if (isEntered && !isPlaying) this.syncUrl();
    },

    setPlaying(playing: boolean) {
      const wasPlaying = isPlaying;
      isPlaying = playing;
      if (wasPlaying && !playing && isEntered) this.syncUrl();
    },

    setDisplay(params: string) {
      display = params;
      if (isEntered) this.syncUrl();
    },

    setCharts(token: string | null) {
      chartsToken = token;
      if (isEntered) this.syncUrl();
    },

    // Scrubbing replaces the entry, so Back is never flooded with months.
    syncUrl() {
      try {
        const published = this.publishCandidate(this.fullUrl());
        history.replaceState(history.state, "", published.url);
      } catch {
        // Rapid replaceState calls can throw a SecurityError, and the next change retries.
      }
    },

    publishEntry(entry: SceneEntry) {
      const published = this.publishCandidate(this.fullUrl());
      if (entry === "push") history.pushState(null, "", published.url);
      if (entry === "replace") history.replaceState(null, "", published.url);

      // The dialog is closed on entry, so a stale full-view state is dropped.
      if (entry === "keep" && history.state?.panel) {
        history.replaceState(null, "", published.url);
      }

      return published.outcome;
    },

    // Panel pushes always record history so dirty Back returns to the pending decision.
    pushPanel(state: { panel: string } | null) {
      const published = this.publishCandidate(this.fullUrl());
      history.pushState(state, "", published.url);

      return published.outcome;
    },

    // One owner publishes share URLs and reports oversized outcomes through the sync handler.
    publishCandidate(relative: string) {
      const complete = completeUrl(relative);
      if (!isCompleteUrlOversized(complete)) {
        if (syncNotice !== null) {
          syncNotice = null;
          onSync?.(null);
        }
        lastSafeComplete = complete;

        return { url: complete, outcome: "installed" as const };
      }
      if (syncNotice === null) {
        syncNotice = UNSYNCED_CHARTS_NOTICE;
        onSync?.(syncNotice);
      }
      // An oversized replacement keeps the newest token while the address stays safe.
      if (lastSafeComplete !== null && !isCompleteUrlOversized(lastSafeComplete)) {
        return { url: lastSafeComplete, outcome: "safe-fallback" as const };
      }
      const fallback = completeUrl(this.baseUrl());
      if (!isCompleteUrlOversized(fallback)) {
        lastSafeComplete = fallback;

        return { url: fallback, outcome: "safe-fallback" as const };
      }

      return { url: currentAddress(fallback), outcome: "oversized" as const };
    },

    markEntered() {
      isEntered = true;
    },
  };
}

type SceneClock = ReturnType<typeof createSceneClock>;

type SceneTimeline = ReturnType<typeof mountScene>["timeline"];

function restoreTime(timeline: SceneTimeline, linkedTime: string | null) {
  if (!timeline || !linkedTime) return;

  const time = timeForPrefix(timeline.times, linkedTime);
  if (time) timeline.goTo(time);
}

function makeColumn(scene: Scene, column: HTMLElement, leave: () => void) {
  const header = makeHtmlElement("header", "", column);
  makeHtmlElement("h3", scene.title, header);
  makeHtmlElement("button", "← Back to map", header).onclick = leave;

  const cards = makeHtmlElement("div", "", column);
  cards.className = "cards";
  return cards;
}

function loadMask(
  map: MapLibreMap,
  feature: AreaFeature,
  bbox: Bbox,
  fittedZoom: number | undefined,
  signal: AbortSignal,
  sceneLayerIds: readonly string[],
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    map.on("sourcedata", onData);
    map.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      addMask(map, feature, bbox, fittedZoom, sceneLayerIds);
      checkReady();
    } catch (error) {
      cleanup();
      reject(error);
    }

    function onData(event: MapSourceDataEvent) {
      if (event.sourceId !== MASK_ID || !event.isSourceLoaded) return;

      checkReady();
    }

    function onError(event: MapEventType["error"] & { sourceId?: string }) {
      if (event.sourceId !== MASK_ID) return;

      cleanup();
      reject(new Error(`Area mask: ${event.error.message}`));
    }

    function onAbort() {
      cleanup();
      resolve(false);
    }

    function checkReady() {
      if (!map.getLayer(MASK_ID) || !map.isSourceLoaded(MASK_ID)) return;

      cleanup();
      resolve(true);
    }

    function cleanup() {
      map.off("sourcedata", onData);
      map.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    }
  });
}

// Everything outside the area is blanked, which also crops the cell edges of the layers below.
function addMask(
  map: MapLibreMap,
  feature: AreaFeature,
  bbox: Bbox,
  fittedZoom: number | undefined,
  sceneLayerIds: readonly string[],
) {
  const shift = worldShift(bbox);
  const { exteriors, interiors } = outlines(feature.geometry);
  const holes = exteriors.map((ring) => shiftLongitudes(ring, shift) as number[][]);
  const enclaves = interiors.map((ring) => [shiftLongitudes(ring, shift)]);

  const maskFeature = {
    type: "Feature",
    properties: {},
    // Lakes and enclaves inside the area are cut out of the area, so they are blanked again.
    geometry: { type: "MultiPolygon", coordinates: [[worldRing(holes), ...holes], ...enclaves] },
  };

  map.addSource(MASK_ID, { type: "geojson", data: maskFeature as GeoJsonData });
  // Appended last, the mask already covers every basemap layer beneath it.
  map.addLayer({
    id: MASK_ID,
    type: "fill",
    source: MASK_ID,
    paint: {
      "fill-color": pageBackground(),
      "fill-opacity": maskOpacity(fittedZoom),
    },
  });

  const basemap = basemapLayers(map, new Set(sceneLayerIds));
  // The fade shares the mask source so outside labels dim without a second geometry.
  map.addLayer({
    id: FADE_ID,
    type: "fill",
    source: MASK_ID,
    paint: { "fill-color": pageBackground(), "fill-opacity": fadeOpacity(fittedZoom) },
  });

  // Basemap labels sit above the mask in their original relative order.
  for (const id of basemap.symbols) {
    if (map.getLayer(id)) map.moveLayer(id, FADE_ID);
  }

  liftSceneSymbols(map, sceneLayerIds);
}

/** Basemap symbols in style order, plus the full basemap order for the exit restore. */
function basemapLayers(
  map: MapLibreMap,
  sceneIds: ReadonlySet<string>,
): { symbols: string[]; all: string[] } {
  const symbols: string[] = [];
  const all: string[] = [];
  if (typeof map.getStyle !== "function") return { symbols, all };
  for (const layer of map.getStyle()?.layers ?? []) {
    if (sceneIds.has(layer.id) || layer.id.startsWith("soe-")) continue;
    all.push(layer.id);
    if (layer.type === "symbol") symbols.push(layer.id);
  }
  return { symbols, all };
}

/** Return the basemap to its pre-scene order, leaving scene leftovers for unmount. */
function restoreBasemapOrder(map: MapLibreMap, order: readonly string[] | null): void {
  if (!order) return;
  for (const id of order) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

/** Scene symbols stay above the fade so their own labels keep full strength. */
function liftSceneSymbols(map: MapLibreMap, sceneLayerIds: readonly string[]): void {
  for (const id of sceneSymbols(map, sceneLayerIds)) map.moveLayer(id);
  if (map.getLayer(OUTLINE_ID)) map.moveLayer(OUTLINE_ID);
}

function sceneSymbols(map: MapLibreMap, sceneLayerIds: readonly string[]): string[] {
  return sceneLayerIds.filter((id) => map.getLayer(id)?.type === "symbol");
}

/** Remember each basemap symbol's own visibility so scenes restore it exactly. */
function snapshotBasemapSymbols(
  map: MapLibreMap,
  sceneIds: ReadonlySet<string>,
): Map<string, VisibilitySpecification | undefined> {
  const baseline = new Map<string, VisibilitySpecification | undefined>();
  if (typeof map.getStyle !== "function" || typeof map.getLayoutProperty !== "function") {
    return baseline;
  }
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type !== "symbol" || sceneIds.has(layer.id) || layer.id.startsWith("soe-")) continue;
    if (!map.getLayer(layer.id)) continue;
    baseline.set(layer.id, map.getLayoutProperty(layer.id, "visibility"));
  }
  return baseline;
}

/** The toggle governs every basemap symbol, so off hides all text and on shows it all. */
function setBasemapSymbolsVisible(
  map: MapLibreMap,
  visible: boolean,
  baseline: ReadonlyMap<string, VisibilitySpecification | undefined>,
): void {
  if (typeof map.setLayoutProperty !== "function") return;
  for (const [id] of baseline) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, "visibility", visible ? "visible" : ("none" as const));
  }
}

/** Return each basemap symbol to its own visibility, clearing overrides the scene added. */
function restoreBasemapSymbols(
  map: MapLibreMap,
  baseline: ReadonlyMap<string, VisibilitySpecification | undefined>,
): void {
  if (typeof map.setLayoutProperty !== "function") return;
  for (const [id, original] of baseline) {
    if (!map.getLayer(id)) continue;
    // An unset original clears the property back to the style default.
    map.setLayoutProperty(id, "visibility", original as VisibilitySpecification);
  }
}

function outlines(geometry: AreaFeature["geometry"]) {
  const coordinates = geometry.coordinates as number[][][] | number[][][][];
  const parts = polygonParts(geometry.type, coordinates);
  return {
    exteriors: parts.map((part) => part[0]),
    interiors: parts.flatMap((part) => part.slice(1)),
  };
}

// The ring is one world wide and centred on the area, as MapLibre cannot cut holes in a wider one.
function worldRing(holes: number[][][]) {
  const longitudes = holes.flat().map(([longitude]) => longitude);
  const centre = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
  const west = centre - HALF_WORLD_DEG;
  const east = centre + HALF_WORLD_DEG;

  return [
    [west, -MAX_LATITUDE_DEG],
    [east, -MAX_LATITUDE_DEG],
    [east, MAX_LATITUDE_DEG],
    [west, MAX_LATITUDE_DEG],
    [west, -MAX_LATITUDE_DEG],
  ];
}

const dataMinZoom = (fittedZoom: number | undefined) =>
  fittedZoom === undefined ? 0 : fittedZoom - DATA_APPEARS_ZOOM;

function pageBackground() {
  const style = getComputedStyle(document.documentElement);
  return style.getPropertyValue(PAGE_BACKGROUND_PROPERTY).trim();
}

// Fades in while zooming toward the area, and is complete once the view is held to it.
function maskOpacity(fittedZoom: number | undefined): number | ExpressionSpecification {
  return opacityFor(MASK_OPACITY, fittedZoom);
}

// The fade dims outside labels with the same zoom behaviour as the mask beneath them.
function fadeOpacity(fittedZoom?: number): number | ExpressionSpecification {
  return opacityFor(FADE_OPACITY, fittedZoom);
}

function opacityFor(
  maximum: number,
  fittedZoom: number | undefined,
): number | ExpressionSpecification {
  if (fittedZoom === undefined) return maximum;

  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    fittedZoom - MASK_FADE_START_ZOOM,
    0,
    fittedZoom - MASK_FADE_END_ZOOM,
    maximum,
  ];
}

// Relative scene links resolve against the page, so history always holds complete URLs.
function completeUrl(relative: string) {
  try {
    return new URL(relative, location.href).href;
  } catch {
    return relative;
  }
}

// The current address is already in history, so it never introduces a new oversized URL.
function currentAddress(fallback: string) {
  try {
    if (typeof location !== "undefined" && typeof location.href === "string") {
      if (!isCompleteUrlOversized(location.href)) return location.href;
    }
  } catch {
  }
  return fallback;
}
