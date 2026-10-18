import type { LngLat, Map as MapLibreMap, PaddingOptions } from "maplibre-gl";

import { fitCamera, fitToBbox, lockPan } from "./map";
import type { Scene } from "./types";

const FLY_DURATION_MS = 1800;
const SNAP_BACK_MS = 250;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const USER_INPUT_EVENTS = ["wheel", "mousedown", "touchstart"];
// Capture and non-passive, so a gesture can be stopped before the map handles it.
const LISTEN_FIRST = { capture: true, passive: false };

// Zooming out may pass the fitted zoom by this much before it eases back.
const FIT_OVERSHOOT_ZOOM = 0.15;
const FIT_TOLERANCE_ZOOM = 0.001;

// Space kept between the fitted area and whatever covers or borders the map.
const EDGE_MARGIN_PX = 24;
const STATUS_BADGE_ID = "status";
const PHONE_QUERY = "(max-width: 600px)";
const RESIZE_DEBOUNCE_MS = 200;

type FittedCamera = { center: LngLat; zoom: number };

interface CameraRoots {
  column: HTMLElement;
  timeBar: HTMLElement;
}

/** Fit the area into the uncovered map, then hold its view with elastic zoom-out. */
export function flyIn(
  map: MapLibreMap,
  scene: Scene,
  roots: CameraRoots,
  onLanded: () => void,
) {
  const padding = scenePadding(roots);
  const camera = fitCamera(map, scene.area.bbox, padding);

  fitToBbox(map, scene.area.bbox, { padding, duration: flightDuration() });

  const hold = camera ? holdView(map, camera, onLanded) : null;
  let fitted = camera;

  return {
    get zoom() {
      return fitted?.zoom;
    },

    stopClamp: () => hold?.stop(),

    // The window changed size, so the area is centred again in the space that is left.
    refit() {
      const next = fitCamera(map, scene.area.bbox, scenePadding(roots));
      if (!next || !hold) return;

      hold.refit(next);
      fitted = next;
    },
  };
}

function scenePadding(roots: CameraRoots): PaddingOptions {
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

// The limits start after the flight, because they would cut it short.
function holdView(map: MapLibreMap, first: FittedCamera, onLanded: () => void) {
  let fitted = first;
  let isHolding = false;
  let isSnapping = false;
  // Set when the user took over from the snap-back, until that gesture has ended.
  let isSnapBackPaused = false;
  let stopPanLock = () => {};
  const canvasContainer = map.getCanvasContainer();

  const snapBack = () => {
    const isAtFit = map.getZoom() >= fitted.zoom - FIT_TOLERANCE_ZOOM;
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
    if (isZoomOut(event) && map.getZoom() <= fitted.zoom + FIT_TOLERANCE_ZOOM) {
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
    map.setMinZoom(fitted.zoom - FIT_OVERSHOOT_ZOOM);
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
      const wasAtFit = map.getZoom() <= fitted.zoom + FIT_TOLERANCE_ZOOM;
      fitted = next;
      if (!isHolding) return;

      stopPanLock();
      map.setMinZoom(next.zoom - FIT_OVERSHOOT_ZOOM);
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

const isZoomOut = (event: Event) => event.type === "wheel" && (event as WheelEvent).deltaY > 0;

// A soft landing makes the snap-back feel elastic rather than abrupt.
const easeOut = (progress: number) => 1 - (1 - progress) ** 3;

/** Refit after the window settles; return cleanup for the listener and pending callback. */
export function watchResize(onSettled: () => void) {
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

/** Respect reduced motion for scene entry and return flights. */
export const flightDuration = () =>
  (matchMedia(REDUCED_MOTION_QUERY).matches ? 0 : FLY_DURATION_MS);
