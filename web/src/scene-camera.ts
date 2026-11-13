import type { LngLat, Map as MapLibreMap, PaddingOptions } from "maplibre-gl";

import { fitCamera, fitToBbox, lockPan } from "./map";
import { prefersReducedMotion } from "./reduced-motion";
import type { Scene } from "./types";

// The flight grows with the zoom distance, so a short hop does not drag.
const FLY_BASE_MS = 700;
const FLY_PER_ZOOM_MS = 450;
const FLY_MAX_MS = 1800;
const SNAP_BACK_MS = 250;

const USER_INPUT_EVENTS = ["wheel", "mousedown", "touchstart"];
// Capture and non-passive, so a gesture can be stopped before the map handles it.
const LISTEN_FIRST = { capture: true, passive: false };

// Zooming out may pass the fitted zoom by this much before it eases back.
const FIT_OVERSHOOT_ZOOM = 0.15;
const FIT_TOLERANCE_ZOOM = 0.001;
const FIT_TOLERANCE_DEG = 1e-4;

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

/**
 * Fit the area into the uncovered map. The flight is one native fit; `hold` then limits the
 * view to the area with elastic zoom-out, and is called once the scene is staged.
 */
export function flyIn(map: MapLibreMap, scene: Scene, roots: CameraRoots) {
  let padding = scenePadding(roots);
  let fitted = fitCamera(map, scene.area.bbox, padding);
  let hold: ReturnType<typeof holdView> | null = null;
  let stopLanding = () => {};
  let stopSettling = () => {};
  let isLanded = false;
  let settlePromise: Promise<void> | null = null;
  let finishSettle: (() => void) | null = null;

  return {
    get zoom() {
      return fitted?.zoom;
    },

    // The build panel slide-out scales with this, so it leaves with the camera.
    get durationMs() {
      return flightDuration(fitted ? Math.abs(fitted.zoom - map.getZoom()) : Infinity);
    },

    // The window changed size, so the area is centred again in the space that is left.
    refit() {
      const nextPadding = scenePadding(roots);
      const next = fitCamera(map, scene.area.bbox, nextPadding);
      if (!next) return;

      padding = nextPadding;
      fitted = next;
      if (hold) {
        hold.refit(next);
        return;
      }
      if (isLanded) moveToFit();
    },

    start: () => new Promise<void>((resolve) => {
      let isCorrected = false;
      const land = () => {
        if (fitted && !isCorrected && !isAtFit(map, fitted)) {
          isCorrected = true;
          // A resize or an interruption moved the target, so one short ease finishes the fit.
          map.easeTo({ ...fitted, duration: SNAP_BACK_MS, easing: easeOut });
          return;
        }
        stopLanding();
        isLanded = true;
        resolve();
      };
      const duration = flightDuration(fitted ? Math.abs(fitted.zoom - map.getZoom()) : Infinity);
      stopLanding = () => map.off("moveend", land);
      map.on("moveend", land);
      fitToBbox(map, scene.area.bbox, { padding, duration });
      if (!map.isMoving()) land();
    }),

    settled() {
      return settlePromise ?? Promise.resolve();
    },

    hold() {
      if (fitted) hold ??= holdView(map, fitted);
    },

    stop() {
      stopLanding();
      resolveSettle();
      hold?.stop();
    },
  };

  // A resize after landing moves at once, so staging can install limits around the new fit.
  function moveToFit() {
    const target = fitted;
    if (!target) return;
    if (isAtFit(map, target)) {
      resolveSettle();
      return;
    }

    ensureSettleListener();
    map.easeTo({
      center: target.center,
      zoom: target.zoom,
      duration: SNAP_BACK_MS,
      easing: easeOut,
    });
  }

  // One waiter survives every replacement fit, so an earlier settled call still lands.
  function ensureSettleListener() {
    if (settlePromise) return;

    settlePromise = new Promise<void>((resolve) => {
      finishSettle = resolve;
    });
    const onMoveEnd = () => {
      if (!fitted || !isAtFit(map, fitted)) return;

      resolveSettle();
    };
    stopSettling = () => {
      map.off("moveend", onMoveEnd);
      stopSettling = () => {};
    };
    map.on("moveend", onMoveEnd);
  }

  function resolveSettle() {
    stopSettling();
    const finish = finishSettle;
    settlePromise = null;
    finishSettle = null;
    finish?.();
  }
}

function isAtFit(map: MapLibreMap, fitted: FittedCamera) {
  const { lng, lat } = map.getCenter();

  return Math.abs(map.getZoom() - fitted.zoom) <= FIT_TOLERANCE_ZOOM
    && Math.abs(lng - fitted.center.lng) <= FIT_TOLERANCE_DEG
    && Math.abs(lat - fitted.center.lat) <= FIT_TOLERANCE_DEG;
}

function scenePadding(roots: CameraRoots): PaddingOptions {
  // Offsets ignore the entry slides, so the fit never depends on how far a panel has moved.
  const edges = { top: EDGE_MARGIN_PX, bottom: EDGE_MARGIN_PX, left: EDGE_MARGIN_PX };

  if (matchMedia(PHONE_QUERY).matches) {
    const badge = document.getElementById(STATUS_BADGE_ID)!.getBoundingClientRect();
    const top = badge.bottom + EDGE_MARGIN_PX;
    const bottom = window.innerHeight - roots.column.offsetTop + EDGE_MARGIN_PX;

    return { ...edges, top, right: EDGE_MARGIN_PX, bottom };
  }

  const right = window.innerWidth - roots.column.offsetLeft + EDGE_MARGIN_PX;
  const timeBarTop = roots.timeBar.offsetHeight ? roots.timeBar.offsetTop : window.innerHeight;
  const bottom = window.innerHeight - timeBarTop + EDGE_MARGIN_PX;

  return { ...edges, right, bottom };
}

// The limits start after the flight, because they would cut it short.
function holdView(map: MapLibreMap, first: FittedCamera) {
  let fitted = first;
  let isSnapping = false;
  // Set when the user took over from the snap-back, until that gesture has ended.
  let isSnapBackPaused = false;
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

  map.setMinZoom(fitted.zoom - FIT_OVERSHOOT_ZOOM);
  map.on("zoomend", snapBack);
  map.on("moveend", endMove);
  let stopPanLock = lockPan(map, fitted);

  for (const type of USER_INPUT_EVENTS) {
    canvasContainer.addEventListener(type, takeOverFromSnapBack, LISTEN_FIRST);
  }

  return {
    refit(next: FittedCamera) {
      const wasAtFit = map.getZoom() <= fitted.zoom + FIT_TOLERANCE_ZOOM;
      fitted = next;
      stopPanLock();
      map.setMinZoom(next.zoom - FIT_OVERSHOOT_ZOOM);
      stopPanLock = lockPan(map, next);

      if (wasAtFit) map.jumpTo({ center: next.center, zoom: next.zoom });
    },

    stop() {
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

/** How long a flight over this many zoom levels takes, or zero when reduced motion is asked. */
export function flightDuration(zoomLevels = Infinity) {
  if (prefersReducedMotion()) return 0;

  return Math.min(FLY_MAX_MS, FLY_BASE_MS + FLY_PER_ZOOM_MS * zoomLevels);
}
