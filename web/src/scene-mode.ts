import type {
  ExpressionSpecification,
  GeoJSONSource,
  LngLat,
  Map as MapLibreMap,
  PaddingOptions,
} from "maplibre-gl";

import { loadAreaFeature } from "./api";
import { makeHtmlElement } from "./html";
import { polygonParts, tileAreaGeometry, type TileArea } from "./label-filter";
import {
  fitCamera,
  fitToBbox,
  lockPan,
  MAX_ZOOM,
  moveLabelsIntoArea,
  removeLayerAndSource,
  WORLD_VIEW,
} from "./map";
import { shiftLongitudes, worldShift } from "./render/mercator";
import { createScenePanel, PANEL_TABS, type PanelTab } from "./scene-panel";
import { sceneUrl, timeForMonth } from "./scene-url";
import type { AreaFeature, Bbox, Scene } from "./types";
import { mountScene, OUTLINE_ID } from "./view";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const FLY_DURATION_MS = 1800;
const SNAP_BACK_MS = 250;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const USER_INPUT_EVENTS = ["wheel", "mousedown", "touchstart"];
// Capture and non-passive, so a gesture can be stopped before the map handles it.
const LISTEN_FIRST = { capture: true, passive: false };

// Zooming out may pass the fitted zoom by this much before it eases back.
const MIN_ZOOM_OVERSHOOT = 0.15;
const ZOOM_EPSILON = 0.001;

const MASK_ID = "soe-scene-mask";
const MASK_OPACITY = 1;
// The mask fades in between these distances (in zoom levels) below the fitted zoom.
const MASK_FADE_START_ZOOMS = 1.5;
const MASK_FADE_END_ZOOMS = 0.25;
// Data layers appear once the mask is opaque, so their uncropped bbox never shows through it.
const DATA_APPEARS_ZOOMS = MASK_FADE_END_ZOOMS;
const PAGE_BACKGROUND_PROPERTY = "--page-background";
const HALF_WORLD_DEGREES = 180;
// Mercator has no poles.
const MAX_LATITUDE = 85;

// Space kept between the fitted area and whatever covers or borders the map.
const EDGE_MARGIN_PX = 24;
const STATUS_BADGE_ID = "status";
const PHONE_QUERY = "(max-width: 600px)";
const RESIZE_DEBOUNCE_MS = 200;

// push: a new history entry; replace: the entry the page was opened with; keep: Back/Forward.
export type SceneEntry = "push" | "replace" | "keep";

export interface EnterOptions {
  month: string | null;
  entry: SceneEntry;
}

export interface SceneRoots {
  column: HTMLElement;
  timeBar: HTMLElement;
  dialog: HTMLDialogElement;
}

type FittedCamera = { center: LngLat; zoom: number };

type Camera = { center: { lng: number; lat: number } | [number, number]; zoom: number };

// What the caller must know about the scene that is showing.
interface ActiveScene {
  id: string;
  panel: ReturnType<typeof createScenePanel>;
  clock: SceneClock;
  close(): void;
}

// One map with two modes: the world, and one scene at a time that the camera is held to.
export function createSceneMode(map: MapLibreMap, roots: SceneRoots) {
  let current: ActiveScene | null = null;
  let worldCamera: Camera | null = null;
  let restoreLabels = () => {};
  let labelArea: TileArea | null = null;

  return { enter, exit, sceneId: () => current?.id ?? null, showFullscreen };

  function enter(scene: Scene, { month, entry }: EnterOptions) {
    leaveCurrentScene();

    const cards = openColumn(scene, entry);
    const clock = createSceneClock(scene.id);

    const mounted = mountScene(map, scene, {
      cards,
      timeBar: roots.timeBar,
      onTime: (time, label) => {
        clock.update(time, label);
        current?.panel.setTimeLabel(label);
      },
    });

    restoreTime(mounted.timeline, month);
    const panel = mountPanel(scene, mounted.timeline, clock);

    recordEntry(scene.id, clock.time, entry);
    clock.markEntered();

    current = startScene(scene, mounted, panel, clock);
    panel.setTimeLabel(clock.label);
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

  function mountPanel(scene: Scene, timeline: SceneTimeline, clock: SceneClock) {
    const panel = createScenePanel(scene, roots.dialog, {
      requestOpen(tab: PanelTab) {
        history.pushState({ panel: tab }, "", sceneUrl(scene.id, clock.time));
        panel.openFull(tab);
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
    // Once landed, nothing depends on zoom, so the elastic zoom-out dip stays clean.
    let isLanded = false;
    const fadeZoom = () => (isLanded ? undefined : flight.zoom);

    const flight = flyIn(scene, () => {
      isLanded = true;
      hideDataBelow(mounted.layerIds, undefined);
      refreshMaskAndLabels(undefined);
    });

    hideDataBelow(mounted.layerIds, fadeZoom());

    let isOpen = true;
    showAreaMask(scene, fadeZoom, () => isOpen)
      .catch((error) => mounted.addNote(error.message));

    const stopWatchingResize = watchResize(() => {
      flight.refit();
      hideDataBelow(mounted.layerIds, fadeZoom());
      refreshMaskAndLabels(fadeZoom());
    });

    return {
      id: scene.id,
      panel,
      clock,
      close() {
        isOpen = false;
        stopWatchingResize();
        flight.stopClamp();
        labelArea = null;
        restoreLabels();
        restoreLabels = () => {};
        removeLayerAndSource(map, MASK_ID);
        panel.destroy();
        mounted.unmount();
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

  function recordEntry(id: string, time: string | null, entry: SceneEntry) {
    const url = sceneUrl(id, time);
    if (entry === "push") history.pushState(null, "", url);
    if (entry === "replace") history.replaceState(null, "", url);

    // The dialog is closed on entry, so a stale full-view state is dropped.
    if (entry === "keep" && history.state?.panel) history.replaceState(null, "", url);
  }

  // The area is centred in the part of the map that the column and the time bar leave open.
  function flyIn(scene: Scene, onLanded: () => void) {
    const padding = scenePadding();
    const camera = fitCamera(map, scene.area.bbox, padding);

    fitToBbox(map, scene.area.bbox, { padding, duration: flightDuration() });

    const hold = camera ? holdView(camera, onLanded) : null;
    let fitted = camera;

    return {
      get zoom() {
        return fitted?.zoom;
      },

      stopClamp: () => hold?.stop(),

      // The window changed size, so the area is centred again in the space that is left.
      refit() {
        const next = fitCamera(map, scene.area.bbox, scenePadding());
        if (!next || !hold) return;

        hold.refit(next);
        fitted = next;
      },
    };
  }

  function scenePadding(): PaddingOptions {
    const column = roots.column.getBoundingClientRect();
    const timeBar = roots.timeBar.getBoundingClientRect();
    const edges = { top: EDGE_MARGIN_PX, bottom: EDGE_MARGIN_PX, left: EDGE_MARGIN_PX };

    if (matchMedia(PHONE_QUERY).matches) {
      const badge = document.getElementById(STATUS_BADGE_ID)!.getBoundingClientRect();
      const top = badge.bottom + EDGE_MARGIN_PX;
      const bottom = window.innerHeight - column.top + EDGE_MARGIN_PX;

      return { ...edges, top, right: EDGE_MARGIN_PX, bottom };
    }

    const right = window.innerWidth - column.left + EDGE_MARGIN_PX;
    const timeBarTop = timeBar.height ? timeBar.top : window.innerHeight;
    const bottom = window.innerHeight - timeBarTop + EDGE_MARGIN_PX;

    return { ...edges, right, bottom };
  }

  // Data and labels wait for the complete mask, so unmasked data never shows.
  function hideDataBelow(layerIds: string[], fittedZoom: number | undefined) {
    for (const id of layerIds) map.setLayerZoomRange(id, dataMinZoom(fittedZoom), MAX_ZOOM);
  }

  function refreshMaskAndLabels(fittedZoom: number | undefined) {
    if (map.getLayer(MASK_ID)) {
      map.setPaintProperty(MASK_ID, "fill-opacity", maskOpacity(fittedZoom));
    }

    if (!labelArea) return;

    restoreLabels();
    restoreLabels = moveLabelsIntoArea(map, labelArea, dataMinZoom(fittedZoom));
  }

  // The limits start after the flight, because they would cut it short.
  function holdView(first: FittedCamera, onLanded: () => void) {
    let fitted = first;
    let isHolding = false;
    let isSnapping = false;
    // Set when the user took over from the snap-back, until that gesture has ended.
    let isSnapBackPaused = false;
    let stopPanLock = () => {};
    const canvasContainer = map.getCanvasContainer();

    const snapBack = () => {
      const isAtFit = map.getZoom() >= fitted.zoom - ZOOM_EPSILON;
      if (isSnapping || isSnapBackPaused || isAtFit) return;

      isSnapping = true;
      map.easeTo({
        center: fitted.center,
        zoom: fitted.zoom,
        duration: SNAP_BACK_MS,
        easing: easeOut,
      });
    };

    const endMove = () => {
      isSnapping = false;
      isSnapBackPaused = false;
    };

    const takeOverFromSnapBack = (event: Event) => {
      // A trackpad's zoom-out stream would hold the dip open, so it is dropped at the fitted zoom.
      if (isZoomOut(event) && map.getZoom() <= fitted.zoom + ZOOM_EPSILON) {
        event.stopPropagation();
        event.preventDefault();
        return;
      }

      if (!isSnapping) return;

      isSnapBackPaused = true;
      isSnapping = false;
      map.stop();
    };

    const apply = () => {
      map.off("moveend", apply);
      isHolding = true;
      map.setMinZoom(fitted.zoom - MIN_ZOOM_OVERSHOOT);
      map.on("zoomend", snapBack);
      map.on("moveend", endMove);
      stopPanLock = lockPan(map, fitted);

      for (const type of USER_INPUT_EVENTS) {
        canvasContainer.addEventListener(type, takeOverFromSnapBack, LISTEN_FIRST);
      }

      onLanded();
    };

    if (map.isMoving()) map.on("moveend", apply);
    else apply();

    return {
      refit(next: FittedCamera) {
        const wasAtFit = map.getZoom() <= fitted.zoom + ZOOM_EPSILON;
        fitted = next;
        if (!isHolding) return;

        stopPanLock();
        map.setMinZoom(next.zoom - MIN_ZOOM_OVERSHOOT);
        stopPanLock = lockPan(map, next);

        if (wasAtFit) map.jumpTo({ center: next.center, zoom: next.zoom });
      },

      stop() {
        map.off("moveend", apply);
        map.off("moveend", endMove);
        map.off("zoomend", snapBack);

        for (const type of USER_INPUT_EVENTS) {
          canvasContainer.removeEventListener(type, takeOverFromSnapBack, LISTEN_FIRST);
        }

        stopPanLock();
        map.setMinZoom(null);
      },
    };
  }

  async function showAreaMask(
    scene: Scene,
    fadeZoom: () => number | undefined,
    isOpen: () => boolean,
  ) {
    const feature = await loadAreaFeature(scene.area.geometry_href).catch((error) => {
      throw new Error(`Area outline: ${error.message}`);
    });
    if (!isOpen()) return;

    const zoom = fadeZoom();
    addMask(map, feature, scene.area.bbox, zoom);

    labelArea = tileAreaGeometry(feature.geometry);
    restoreLabels = moveLabelsIntoArea(map, labelArea, dataMinZoom(zoom));
  }
}

// The current step of the scene, and the link that says so.
function createSceneClock(sceneId: string) {
  let time: string | null = null;
  let label: string | null = null;
  let isEntered = false;

  return {
    get time() {
      return time;
    },

    get label() {
      return label;
    },

    update(newTime: string, newLabel: string) {
      time = newTime;
      label = newLabel;
      if (isEntered) this.syncUrl();
    },

    // Scrubbing replaces the entry, so Back is never flooded with months.
    syncUrl() {
      history.replaceState(history.state, "", sceneUrl(sceneId, time));
    },

    markEntered() {
      isEntered = true;
    },
  };
}

type SceneClock = ReturnType<typeof createSceneClock>;

type SceneTimeline = ReturnType<typeof mountScene>["timeline"];

function restoreTime(timeline: SceneTimeline, month: string | null) {
  if (!timeline || !month) return;

  const time = timeForMonth(timeline.times, month);
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
  const parts = polygonParts(geometry.type, coordinates);

  return {
    exteriors: parts.map((part) => part[0]),
    interiors: parts.flatMap((part) => part.slice(1)),
  };
}

// One world wide, centred on the area: MapLibre does not cut holes from a ring that is wider.
function worldRing(holes: number[][][]) {
  const longitudes = holes.flat().map(([longitude]) => longitude);
  const centre = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
  const [west, east] = [centre - HALF_WORLD_DEGREES, centre + HALF_WORLD_DEGREES];

  return [
    [west, -MAX_LATITUDE],
    [east, -MAX_LATITUDE],
    [east, MAX_LATITUDE],
    [west, MAX_LATITUDE],
    [west, -MAX_LATITUDE],
  ];
}

const isZoomOut = (event: Event) => event.type === "wheel" && (event as WheelEvent).deltaY > 0;

// A soft landing makes the snap-back feel elastic rather than abrupt.
const easeOut = (progress: number) => 1 - (1 - progress) ** 3;

// Calls back once the window has stopped changing size; returns the undo.
function watchResize(onSettled: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onResize = () => {
    clearTimeout(timer);
    timer = setTimeout(onSettled, RESIZE_DEBOUNCE_MS);
  };

  window.addEventListener("resize", onResize);

  return () => {
    window.removeEventListener("resize", onResize);
    clearTimeout(timer);
  };
}

const dataMinZoom = (fittedZoom: number | undefined) =>
  fittedZoom === undefined ? 0 : fittedZoom - DATA_APPEARS_ZOOMS;

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
    fittedZoom - MASK_FADE_START_ZOOMS,
    0,
    fittedZoom - MASK_FADE_END_ZOOMS,
    MASK_OPACITY,
  ];
}

const flightDuration = () => (matchMedia(REDUCED_MOTION_QUERY).matches ? 0 : FLY_DURATION_MS);
