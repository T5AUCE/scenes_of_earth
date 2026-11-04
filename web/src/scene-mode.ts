/** Switch one map between the world and a single scene, holding the camera and masking the rest. */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LayerSpecification,
  Map as MapLibreMap,
  MapEventType,
  MapSourceDataEvent,
} from "maplibre-gl";

import { loadAreaFeature } from "./api";
import { makeHtmlElement } from "./html";
import * as labelFilters from "./label-filter";
import type { TileArea } from "./label-filter";
import {
  MAX_ZOOM,
  moveLabelsIntoArea,
  removeLayerAndSource,
  WORLD_VIEW,
} from "./map";
import { shiftLongitudes, worldShift } from "./render/mercator";
import { UNSYNCED_CHARTS_NOTICE, isCompleteUrlOversized } from "./charts/state";
import { flightDuration, flyIn, watchResize } from "./scene-camera";
import type { SceneStore } from "./scene-store";
import { sceneUrl, timeForPrefix, withChartsToken } from "./scene-url";
import type { AreaFeature, Bbox, DisplayTokens, Scene } from "./types";
import {
  createScenePanel,
  PANEL_TABS,
  type FullOpenOptions,
  type PanelTab,
} from "./ui/scene-panel";
import { mountScene, OUTLINE_ID } from "./view";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const MASK_ID = "soe-scene-mask";
const MASK_OPACITY = 1;
// The mask fades in between these distances (in zoom levels) below the fitted zoom.
const MASK_FADE_START_ZOOM = 1.5;
const MASK_FADE_END_ZOOM = 0.25;
// Data layers appear once the mask is opaque, so their uncropped bbox never shows through it.
const DATA_APPEARS_ZOOM = MASK_FADE_END_ZOOM;
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
  let restoreLabels = () => {};
  let labelArea: TileArea | null = null;
  let sceneLayerIds: string[] = [];

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
    const maskLoad = new AbortController();
    // Once landed, nothing depends on zoom, so the elastic zoom-out dip stays clean.
    let isLanded = false;
    const fadeZoom = () => (isLanded ? undefined : flight.zoom);

    const flight = flyIn(map, scene, roots, () => {
      isLanded = true;
      dataLayers.update(undefined);
      refreshMaskAndLabels(undefined);
    });

    dataLayers.update(fadeZoom());

    showAreaMask(scene, fadeZoom, maskLoad.signal)
      .then((isReady) => {
        if (isReady && !maskLoad.signal.aborted) dataLayers.show();
      })
      .catch((error) => {
        if (!maskLoad.signal.aborted) mounted.addNote(error.message);
      });

    const stopWatchingResize = watchResize(() => {
      flight.refit();
      dataLayers.update(fadeZoom());
      refreshMaskAndLabels(fadeZoom());
    });
    const stopDocking = watchDocking(roots.timeBar);

    return {
      id: scene.id,
      panel,
      clock,
      syncLayers(layerIds) {
        sceneLayerIds = [...layerIds];
        dataLayers.sync(layerIds);
      },
      close() {
        maskLoad.abort();
        stopWatchingResize();
        stopDocking();
        flight.stopClamp();
        labelArea = null;
        restoreLabels();
        restoreLabels = () => {};
        removeLayerAndSource(map, MASK_ID);
        panel.destroy();
        mounted.unmount();
        sceneLayerIds = [];
        roots.column.replaceChildren();
        roots.column.hidden = true;
        document.body.classList.remove("scene-mode");
      },
    };
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

    if (!labelArea) return;

    restoreLabels();
    restoreLabels = movePlaceLabels(map, labelArea, dataMinZoom(fittedZoom), sceneLayerIds);
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

    const isReady = await loadMask(map, feature, scene.area.bbox, fadeZoom(), signal);
    if (!isReady || signal.aborted) return false;

    labelArea = labelFilters.tileAreaGeometry(feature.geometry);
    restoreLabels = movePlaceLabels(map, labelArea, dataMinZoom(fadeZoom()), sceneLayerIds);
    return true;
  }
}

/** Keep the docked column above the attribution and time bar. */
function watchDocking(timeBar: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};

  try {
    const root = document.documentElement;
    if (!root || !root.style) return () => {};

    const updateDocking = () => {
      const footer = document.querySelector(".maplibregl-ctrl-bottom-left");
      // The column keeps a gap above the taller footer, matching its side margins.
      const dockBottom = Math.max(
        DOCK_GAP_PX,
        bottomExtent(footer) + DOCK_GAP_PX,
        bottomExtent(timeBar) + DOCK_GAP_PX,
      );
      root.style.setProperty("--scene-dock-bottom", `${dockBottom}px`);
    };
    const observer = new ResizeObserver(updateDocking);
    if (timeBar instanceof Element) observer.observe(timeBar);
    const footer = document.querySelector(".maplibregl-ctrl-bottom-left");
    if (footer instanceof Element) observer.observe(footer);
    updateDocking();

    return () => observer.disconnect();
  } catch {
    return () => {};
  }
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

/** Move only basemap labels above the mask so scene labels keep their native visibility. */
export function movePlaceLabels(
  map: MapLibreMap,
  area: TileArea,
  fromZoom: number,
  sceneLayerIds: string[],
) {
  const hasSceneSymbols = sceneLayerIds.some((id) => map.getLayer(id)?.type === "symbol");
  if (!hasSceneSymbols) return moveLabelsIntoArea(map, area, fromZoom);

  const labels = map.getStyle().layers
    .filter((layer) => layer.type === "symbol")
    .filter((layer) => !sceneLayerIds.includes(layer.id));
  const originals = labels.map((layer) => {
    const minzoom = layer.minzoom ?? 0;
    const maxzoom = layer.maxzoom ?? MAX_ZOOM;
    const switchZoom = Math.min(Math.max(minzoom, fromZoom), maxzoom);
    map.setLayerZoomRange(layer.id, minzoom, switchZoom);
    const copyId = `${layer.id}-soe-scene-label`;
    map.addLayer({
      ...layer,
      id: copyId,
      filter: labelFilters.areaFilter(layer.filter, area, Boolean(layer.layout?.["icon-image"])),
      minzoom: switchZoom,
      maxzoom,
    } as LayerSpecification);
    return { id: layer.id, copyId, minzoom, maxzoom };
  });

  return () => {
    for (const { id, copyId, minzoom, maxzoom } of originals) {
      map.removeLayer(copyId);
      map.setLayerZoomRange(id, minzoom, maxzoom);
    }
  };
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
      if (isEntered) this.syncUrl();
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
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    map.on("sourcedata", onData);
    map.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      addMask(map, feature, bbox, fittedZoom);
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
function addMask(map: MapLibreMap, feature: AreaFeature, bbox: Bbox, fittedZoom?: number) {
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
  map.addLayer({
    id: MASK_ID,
    type: "fill",
    source: MASK_ID,
    paint: { "fill-color": pageBackground(), "fill-opacity": maskOpacity(fittedZoom) },
  });

  // The mask also covers the basemap labels; the outline stays on top of it.
  if (map.getLayer(OUTLINE_ID)) map.moveLayer(OUTLINE_ID);
}

function outlines(geometry: AreaFeature["geometry"]) {
  const coordinates = geometry.coordinates as number[][][] | number[][][][];
  const parts = labelFilters.polygonParts(geometry.type, coordinates);
  return {
    exteriors: parts.map((part) => part[0]),
    interiors: parts.flatMap((part) => part.slice(1)),
  };
}

// The ring is one world wide and centred on the area because MapLibre cannot cut holes in a wider one.
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
function maskOpacity(fittedZoom?: number): number | ExpressionSpecification {
  if (fittedZoom === undefined) return MASK_OPACITY;

  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    fittedZoom - MASK_FADE_START_ZOOM,
    0,
    fittedZoom - MASK_FADE_END_ZOOM,
    MASK_OPACITY,
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
