/** Switch one map between the world and a single scene, holding the camera and masking the rest. */
import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapEventType,
  MapSourceDataEvent,
  VisibilitySpecification,
} from "maplibre-gl";

import { loadAreaFeature } from "./api";
import { noteSceneOpen, noteSceneReady, setPreloadDisabled } from "./dev-stats";
import {
  loadMapDetailsShown,
  subscribeMapDetails,
} from "./display-state";
import {
  addressSearch,
  gestureFlags,
  preloadEnabled,
  subscribeGesture,
  type GestureQualityFlags,
} from "./gesture-quality";
import { makeHtmlElement } from "./html";
import { polygonParts } from "./label-filter";
import { basemapPreloadSource } from "./layers/scene-preload";
import {
  closeScenePreload,
  currentScenePreload,
  openScenePreload,
  PRELOAD_ENTRY_BUDGET_MS,
} from "./layers/tile-prefetch";
import { buildMaskRings } from "./mask-ring";
import { MAX_ZOOM, removeLayerAndSource, WORLD_VIEW } from "./map";
import { resetFetchStats } from "./merging-store";
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
// Hidden fills stay fully transparent until the coordinated start reveals the flight.
const HIDDEN_OPACITY = 0;
// Entry never flies on a timer because the flight waits until required work is ready or fails.
const PREPARING_NOTE = "Preparing scene...";
const PAGE_BACKGROUND_PROPERTY = "--page-background";

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
  let savedBasemapFilters: Map<string, FilterSpecification | undefined> | null = null;
  // Each entry gets a number so stale preparation never starts a replaced flight.
  let entryGeneration = 0;

  return { enter, exit, sceneId: () => current?.id ?? null, showFullscreen };

  function enter(scene: Scene, { time: linkedTime, entry, display }: EnterOptions) {
    // A stale pick fit must not steer the new entry, so the camera freezes first.
    map.stop();
    leaveCurrentScene();
    entryGeneration += 1;
    noteSceneOpen(performance.now());
    resetFetchStats();
    // Captured here because publishing the entry replaces the address and drops trial flags.
    const flags = gestureFlags(addressSearch());
    openPreload(scene.area.bbox, preloadEnabled(addressSearch()));

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

    current = startScene(scene, mounted, panel, clock, flags);
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

  // The layers register their own sources when they mount, so the preload opens before them.
  function openPreload(bbox: Bbox, isEnabled: boolean) {
    setPreloadDisabled(!isEnabled);
    if (isEnabled) openScenePreload(map).add(basemapPreloadSource(map, bbox));
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
    flags: GestureQualityFlags,
  ): ActiveScene {
    const dataLayers = new SceneDataLayers(map, mounted.layerIds);
    const symbolBaseline = snapshotBasemapSymbols(map, new Set(sceneLayerIds));
    // A details change mid-gesture waits for moveend so frozen symbols stay hidden.
    let labelsFrozen = false;
    const generation = entryGeneration;
    const stopGesture = subscribeGesture(map, {
      onStart: () => {
        if (!flags.freezeLabels) return;
        labelsFrozen = true;
        setBasemapSymbolsVisible(map, false, symbolBaseline);
      },
      onEnd: () => {
        if (!labelsFrozen) return;
        labelsFrozen = false;
        const shown = loadMapDetailsShown();
        setBasemapSymbolsVisible(map, shown, symbolBaseline);
        syncFadeVisible(map, shown);
      },
    });
    const stopDetails = subscribeMapDetails((shown) => {
      if (labelsFrozen) return;
      setBasemapSymbolsVisible(map, shown, symbolBaseline);
      syncFadeVisible(map, shown);
    });
    setBasemapSymbolsVisible(map, loadMapDetailsShown(), symbolBaseline);
    const maskLoad = new AbortController();
    let hasStaged = false;
    let pendingBasemapClip: { bbox: Bbox; sceneIds: string[] } | null = null;
    // Once landed, nothing depends on zoom, so the elastic zoom-out dip stays clean.
    let isLanded = false;
    // The flight lifts off after the mask and the first data, so the fade reads its fit meanwhile.
    const flight = flyIn(map, scene, roots, () => {
      isLanded = true;
      dataLayers.update(undefined);
      refreshMaskAndLabels(undefined);
      applyPendingBasemapClip();
    });
    const fadeZoom = () => (isLanded ? undefined : flight.zoom);
    let isGone = false;

    dataLayers.update(fadeZoom());
    const outlineGate = gateOutlineDuringPreparation(map, mounted.store);

    const removePreparing = mounted.addNote(PREPARING_NOTE);
    const stopWaiting = waitForReadiness(startTransition, generation);

    const stopWatchingResize = watchResize(() => {
      flight.refit();
      // The gate stores its fitted zoom, so a preparation refit resyncs it while hidden.
      dataLayers.update(fadeZoom());
      if (!hasStaged) keepMaskHidden(map);
      else refreshMaskAndLabels(fadeZoom());
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
        outlineGate.stop();
        pendingBasemapClip = null;
        removePreparing();
        maskLoad.abort();
        stopWatchingResize();
        stopDocking();
        flight.stopClamp();
        stopGesture();
        stopDetails();
        closeScenePreload();
        setPreloadDisabled(false);
        removeLayerAndSource(map, FADE_ID);
        removeLayerAndSource(map, MASK_ID);
        restoreBasemapFilters(map, savedBasemapFilters);
        savedBasemapFilters = null;
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

    function startTransition(preparation: {
      time: string | null;
      allocation: unknown;
      display: unknown;
    }) {
      if (isGone || generation !== entryGeneration) return;
      // A toggle or scrub while loading retargets, so a stale flight never lifts off.
      if (clock.time !== preparation.time) return;
      const snapshot = mounted.store.getSnapshot();
      if (snapshot.allocation !== preparation.allocation) return;
      if (snapshot.display !== preparation.display) return;

      stopWaiting();
      removePreparing();
      // One coordinated start owns every visual so late completions cannot reveal a replaced scene.
      if (isGone || generation !== entryGeneration) return;
      hasStaged = true;
      const fitZoom = flight.zoom ?? map.getZoom();
      const startZoom = map.getZoom();
      const staged = stageSceneVisuals(map, scene, sceneLayerIds, fitZoom, startZoom);
      savedBasemapOrder = staged.order;
      pendingBasemapClip = staged.pendingClip;
      outlineGate.stop();
      dataLayers.show();
      revealLatestOutline(map, mounted.store, outlineGate.previous);
      syncFadeVisible(map);
      noteSceneReady(performance.now());
      currentScenePreload()?.start(fitZoom);
      flight.start();
    }

    // Destructive basemap filters wait for landing unless the fitted cover is already opaque.
    function applyPendingBasemapClip() {
      if (!pendingBasemapClip) return;
      savedBasemapFilters = clipBasemapToArea(
        map,
        pendingBasemapClip.bbox,
        new Set(pendingBasemapClip.sceneIds),
      );
      pendingBasemapClip = null;
    }

    function waitForReadiness(
      onReady: (preparation: {
        time: string | null;
        allocation: unknown;
        display: unknown;
      }) => void,
      generation: number,
    ) {
      let isDone = false;
      let cancelEntry: (() => void) | null = null;
      let retargetEntry: (() => void) | null = null;
      const originalUpdate = clock.update.bind(clock);
      clock.update = (newTime, newLabel) => {
        originalUpdate(newTime, newLabel);
        retargetEntry?.();
      };
      void run();

      return () => {
        isDone = true;
        cancelEntry?.();
        maskLoad.abort();
      };

      async function run() {
        // The note paints before heavy work begins, so the old pixels stay responsive.
        await nextEntryFrame();
        if (isDone || isGone || generation !== entryGeneration) return;

        // The clock already holds the restored time, so a shared link warms its own month.
        const entry = startEntryPreparation();
        cancelEntry = entry.cancel;
        retargetEntry = entry.retarget;
        const maskPromise = startMaskPreparation();
        const preloadPromise = startPreloadPreparation();
        const entryOutcomePromise = entry.ready.then(
          (preparation) => ({ ok: true as const, preparation }),
          (error) => ({ ok: false as const, error }),
        );
        const [entryOutcome, maskOutcome] = await Promise.all([
          entryOutcomePromise,
          maskPromise,
        ]);
        if (!entryOutcome.ok || !maskOutcome.ok) {
          currentScenePreload()?.expireEntryBudget();
          if (isDone || isGone || generation !== entryGeneration) return;

          const failure = pickFailure(entryOutcome, maskOutcome);
          if (failure) failEntry(failure);
          return;
        }
        const preloadOutcome = await preloadPromise;
        if (isDone || isGone || generation !== entryGeneration) return;

        if (!preloadOutcome.ok) {
          failEntry(preloadOutcome.error);
          return;
        }
        // The mask stays valid while time retargets, so only entry restarts here.
        await settleEntryRetarget(entryOutcome.preparation);
      }

      async function settleEntryRetarget(
        preparation: { time: string | null; allocation: unknown; display: unknown },
      ) {
        let current = preparation;
        while (true) {
          if (isDone || isGone || generation !== entryGeneration) return;

          const currentTime = clock.time;
          const snapshot = mounted.store.getSnapshot();
          if (
            current.time === currentTime
            && current.allocation === snapshot.allocation
            && current.display === snapshot.display
          ) {
            onReady({ ...current });
            return;
          }
          // Toggle or scrub while the mask settled retargets instead of flying stale.
          const retry = startEntryPreparation();
          cancelEntry = retry.cancel;
          retargetEntry = retry.retarget;
          const outcome = await retry.ready.then(
            (next) => ({ ok: true as const, next }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          if (isDone || isGone || generation !== entryGeneration) return;

          if (!outcome.ok) {
            failEntry(outcome.error);
            return;
          }
          current = outcome.next;
        }
      }

      function pickFailure(
        entryOutcome: { ok: boolean; error?: unknown },
        maskOutcome: { ok: boolean; error?: unknown },
      ): unknown {
        const errors = [entryOutcome, maskOutcome]
          .filter((outcome) => !outcome.ok)
          .map((outcome) => (outcome as { error: unknown }).error);
        return errors.find((error) => error && (error as Error).name !== "AbortError") ?? null;
      }

      function startEntryPreparation() {
        const prepared = mounted.whenEntryReady(() => clock.time, () => generation);
        const ready = prepared.ready.then((result) => ({
          time: (result.time ?? null) as string | null,
          allocation: result.allocation,
          display: result.display,
        }));
        void prepared.ready.then(
          () => {},
          () => maskLoad.abort(),
        );
        return { ready, cancel: prepared.cancel, retarget: prepared.retarget };
      }

      async function startMaskPreparation(): Promise<
        { ok: true; feature: AreaFeature } | { ok: false; error: unknown }
      > {
        try {
          const feature = await prepareHiddenMask(scene, maskLoad.signal);
          if (isDone || isGone || generation !== entryGeneration) {
            return { ok: false, error: null };
          }
          if (!feature) return { ok: false, error: null };
          return { ok: true, feature };
        } catch (error) {
          if (maskLoad.signal.aborted) return { ok: false, error: null };

          cancelEntry?.();
          currentScenePreload()?.expireEntryBudget();
          return { ok: false, error };
        }
      }

      async function startPreloadPreparation(): Promise<
        { ok: true } | { ok: false; error: unknown }
      > {
        try {
          const preload = currentScenePreload();
          if (!preload) return { ok: true };
          if (isDone || isGone || generation !== entryGeneration) {
            return { ok: false, error: null };
          }
          preload.start(flight.zoom ?? map.getZoom());
          await waitForBoundedPreload(preload, maskLoad.signal);
          if (isDone || isGone || generation !== entryGeneration) {
            return { ok: false, error: null };
          }
          return { ok: true };
        } catch (error) {
          if (maskLoad.signal.aborted) return { ok: false, error: null };

          return { ok: false, error };
        }
      }

      function waitForBoundedPreload(
        preload: NonNullable<ReturnType<typeof currentScenePreload>>,
        signal: AbortSignal,
      ): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          preload.settled(signal).then(
            () => {
              cleanup();
              resolve(false);
            },
            (error: unknown) => {
              cleanup();
              reject(error);
            },
          );
          timer = setTimeout(() => {
            preload.expireEntryBudget();
            cleanup();
            resolve(true);
          }, PRELOAD_ENTRY_BUDGET_MS);
        });
      }

      function failEntry(error: unknown) {
        if (isDone || isGone || generation !== entryGeneration) return;
        isDone = true;
        outlineGate.stop();
        removePreparing();
        revealLatestOutline(map, mounted.store, outlineGate.previous);
        // A null or abandoned entry is silent, so only real failures get a note.
        if (error && (error as Error).name !== "AbortError") {
          mounted.addNote((error as Error).message ?? String(error));
        }
      }
    }
  }

  /** Wait a frame so the preparing note paints before heavy work continues. */
  function nextEntryFrame(): Promise<void> {
    return new Promise((done) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => done());
        return;
      }
      setTimeout(done, 0);
    });
  }

  // Back goes through history when this page pushed the entry, so Back and the button agree.
  function leave(isPushed: boolean) {
    if (isPushed) return history.back();

    history.replaceState(null, "", location.pathname);
    exit();
  }

  /** Show the settled background once the flight has landed. */
  function refreshMaskAndLabels(fittedZoom: number | undefined) {
    if (map.getLayer(MASK_ID)) {
      map.setPaintProperty(MASK_ID, "fill-opacity", maskOpacity(fittedZoom));
    }
    if (map.getLayer(FADE_ID)) {
      map.setPaintProperty(FADE_ID, "fill-opacity", fadeOpacity(fittedZoom));
    }
  }

  /** Keep both fills fully transparent while required work stays pending. */
  function keepMaskHidden(map: MapLibreMap) {
    if (map.getLayer(MASK_ID)) {
      map.setPaintProperty(MASK_ID, "fill-opacity", HIDDEN_OPACITY);
    }
    if (map.getLayer(FADE_ID)) {
      map.setPaintProperty(FADE_ID, "fill-opacity", HIDDEN_OPACITY);
    }
  }

  async function prepareHiddenMask(
    scene: Scene,
    signal: AbortSignal,
  ): Promise<AreaFeature | null> {
    // An abandoned entry settles the geometry wait at once so a known failure shows promptly.
    const aborted = new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null);
      else signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const loaded = loadAreaFeature(scene.area.geometry_href).catch((error) => {
      throw new Error(`Area outline: ${error.message}`);
    });
    const feature = await Promise.race([loaded, aborted]);
    if (feature === null || signal.aborted) return null;

    const isReady = await loadHiddenMask(map, feature, scene.area.bbox, signal);
    if (!isReady || signal.aborted) return null;

    return feature;
  }

  function stageSceneVisuals(
    map: MapLibreMap,
    scene: Scene,
    sceneIds: readonly string[],
    fitZoom: number,
    startZoom: number,
  ): { order: string[]; pendingClip: { bbox: Bbox; sceneIds: string[] } | null } {
    const basemap = basemapLayers(map, new Set(sceneIds));
    const order = basemap.all;
    const nonSymbols = basemap.all.filter((id) => !basemap.symbols.includes(id));
    lowerBasemapGeometry(map, sceneIds, nonSymbols);
    for (const id of basemap.symbols) {
      if (map.getLayer(id)) map.moveLayer(id, FADE_ID);
    }
    // The camera-zoom cover takes over now, so data shows through while the flight runs.
    if (map.getLayer(MASK_ID)) {
      map.setPaintProperty(MASK_ID, "fill-opacity", maskOpacity(fitZoom));
    }
    if (map.getLayer(FADE_ID)) {
      map.setPaintProperty(FADE_ID, "fill-opacity", fadeOpacity(fitZoom));
    }
    liftSceneSymbols(map, sceneIds);
    // Destructive filters apply at once only under an already opaque cover.
    if (maskCoverProgress(startZoom, fitZoom) >= 1) {
      savedBasemapFilters = clipBasemapToArea(map, scene.area.bbox, new Set(sceneIds));
      return { order, pendingClip: null };
    }
    return { order, pendingClip: { bbox: scene.area.bbox, sceneIds: [...sceneIds] } };
  }
}

/** Hide the outline until liftoff, so the stable basemap shows no scene pixels. */
function hideSceneOutline(map: MapLibreMap): string | undefined {
  try {
    if (!map.getLayer(OUTLINE_ID)) return undefined;
    let previous: string | undefined;
    try {
      if (typeof map.getLayoutProperty === "function") {
        previous = map.getLayoutProperty(OUTLINE_ID, "visibility") as string | undefined;
      } else {
        const layer = map.getLayer(OUTLINE_ID) as unknown as {
          layout?: { visibility?: string };
        };
        previous = layer?.layout?.visibility;
      }
    } catch {
      previous = undefined;
    }
    setLayerVisible(map, OUTLINE_ID, "none");
    return previous;
  } catch {
    return undefined;
  }
}

/** Keep display edits hidden until liftoff so no outline pixel shows early. */
function gateOutlineDuringPreparation(
  map: MapLibreMap,
  store: { subscribe(listener: () => void): () => void },
): { stop(): void; previous: string | undefined } {
  const previous = hideSceneOutline(map);
  let stopStore: () => void = () => {};
  try {
    stopStore = store.subscribe(() => {
      try {
        if (map.getLayer(OUTLINE_ID)) setLayerVisible(map, OUTLINE_ID, "none");
      } catch {
      }
    });
  } catch {
  }
  return { stop: stopStore, previous };
}

/** Display edits during preparation change the choice so liftoff reads the current state. */
function revealLatestOutline(
  map: MapLibreMap,
  store: { getSnapshot(): unknown },
  fallback: string | undefined,
) {
  try {
    const outline = (store.getSnapshot() as { display?: { outline?: { shown?: boolean } } })
      .display?.outline;
    if (outline && typeof outline.shown === "boolean") {
      setLayerVisible(map, OUTLINE_ID, outline.shown ? "visible" : "none");
      return;
    }
  } catch {
  }
  revealSceneOutline(map, fallback);
}

/** Reveal the outline at liftoff, restoring the choice the display state requested. */
function revealSceneOutline(map: MapLibreMap, previous: string | undefined) {
  try {
    if (!map.getLayer(OUTLINE_ID)) return;
    if (previous === undefined || previous === "visible") {
      setLayerVisible(map, OUTLINE_ID, "visible");
    } else if (previous === "none") {
      setLayerVisible(map, OUTLINE_ID, "none");
    } else {
      setLayerVisible(map, OUTLINE_ID, "visible");
    }
  } catch {
    // A torn-down map must not block the transition the outline belongs to.
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

/**
 * Gate scene data until liftoff without changing visibility or native zoom bounds.
 * A ready layer stays at its fitted minimum while the camera runs, then lands on native.
 */
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

function loadHiddenMask(
  map: MapLibreMap,
  feature: AreaFeature,
  bbox: Bbox,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    map.on("sourcedata", onData);
    map.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      addHiddenMask(map, feature, bbox);
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
function addHiddenMask(
  map: MapLibreMap,
  feature: AreaFeature,
  bbox: Bbox,
) {
  const shift = worldShift(bbox);
  const { exteriors, interiors } = outlines(feature.geometry);
  const lands = exteriors.map((ring) => shiftLongitudes(ring, shift) as number[][]);
  const waters = interiors.map((ring) => shiftLongitudes(ring, shift) as number[][]);
  const maskRings = buildMaskRings(lands, waters);

  const maskFeature = {
    type: "Feature",
    properties: {},
    // Lakes are cut out of the area so they blank again, with land islands cut back out of each lake.
    geometry: { type: "MultiPolygon", coordinates: maskRings.map((ring) => [ring]) },
  };

  // Simplifying would treat the two sides of each slit separately and leave hairline gaps.
  map.addSource(MASK_ID, { type: "geojson", data: maskFeature as GeoJsonData, tolerance: 0 });
  // Both fills start transparent so the basemap stays stable while required work settles.
  // The reveal snaps at once because the default 300 ms tween would show data early.
  map.addLayer({
    id: MASK_ID,
    type: "fill",
    source: MASK_ID,
    paint: {
      "fill-color": pageBackground(),
      "fill-opacity": HIDDEN_OPACITY,
      "fill-opacity-transition": { duration: 0, delay: 0 },
    },
  });
  // The fade shares the mask source so outside labels dim without a second geometry.
  map.addLayer({
    id: FADE_ID,
    type: "fill",
    source: MASK_ID,
    paint: {
      "fill-color": pageBackground(),
      "fill-opacity": HIDDEN_OPACITY,
      "fill-opacity-transition": { duration: 0, delay: 0 },
    },
  });
}

/** Show a layer without depending on the map double, so tests stay honest about visibility. */
function setLayerVisible(map: MapLibreMap, id: string, visibility: "visible" | "none") {
  try {
    if (!map.getLayer(id)) return;
    const styled = map as unknown as { setLayoutProperty?: unknown };
    if (typeof styled.setLayoutProperty === "function") {
      (styled as {
        setLayoutProperty(id: string, name: string, value: unknown): void;
      }).setLayoutProperty(id, "visibility", visibility);
      return;
    }
  } catch {
    return;
  }
  try {
    const layer = map.getLayer(id) as unknown as { layout?: { visibility?: string } };
    if (layer && typeof layer === "object") {
      layer.layout ??= {};
      layer.layout.visibility = visibility;
    }
  } catch {
    // A torn-down map must not block the transition the layer belongs to.
  }
}

/** Drop basemap geometry below the lowest scene layer, keeping every relative order. */
function lowerBasemapGeometry(
  map: MapLibreMap,
  sceneLayerIds: readonly string[],
  nonSymbols: readonly string[],
): void {
  if (typeof map.getStyle !== "function") return;
  const layers = map.getStyle()?.layers ?? [];
  const anchor = layers.find(
    (layer) => sceneLayerIds.includes(layer.id) && map.getLayer(layer.id),
  )?.id;
  if (!anchor) return;
  const anchorIndex = layers.findIndex((layer) => layer.id === anchor);
  for (const id of nonSymbols) {
    const index = layers.findIndex((layer) => layer.id === id);
    if (index < 0 || index < anchorIndex || !map.getLayer(id)) continue;
    map.moveLayer(id, anchor);
  }
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

/**
 * Hide fully-outside basemap features while a scene is open. Intersecting features stay
 * because the bbox test keeps anything not fully outside the bbox, so inside pixels match.
 * The bbox mask has a dozen vertices while a full outline can exceed ten thousand, so the
 * per-feature test stays cheap on every tile load while zooming.
 */
function clipBasemapToArea(
  map: MapLibreMap,
  bbox: Bbox,
  sceneIds: ReadonlySet<string>,
): Map<string, FilterSpecification | undefined> {
  const baseline = new Map<string, FilterSpecification | undefined>();
  if (typeof map.getFilter !== "function" || typeof map.setFilter !== "function") return baseline;
  const keep = ["!", ["within", bboxMaskGeometry(bbox)]] as unknown as FilterSpecification;
  for (const id of basemapLayers(map, sceneIds).all) {
    if (!map.getLayer(id)) continue;
    try {
      const previous: FilterSpecification | undefined = map.getFilter(id) ?? undefined;
      baseline.set(id, previous);
      map.setFilter(id, previous ? ["all", previous, keep] as FilterSpecification : keep);
    } catch {
      baseline.delete(id);
    }
  }
  return baseline;
}

/** Return each basemap layer to its own filter, clearing overrides the scene added. */
function restoreBasemapFilters(
  map: MapLibreMap,
  baseline: ReadonlyMap<string, FilterSpecification | undefined> | null,
): void {
  if (!baseline || typeof map.setFilter !== "function") return;
  for (const [id, previous] of baseline) {
    if (!map.getLayer(id)) continue;
    try {
      map.setFilter(id, previous ?? null);
    } catch {
      // A missing layer must not block the remaining restores.
    }
  }
}

/** The world outside the bbox, which safely contains every fully-outside feature. */
function bboxMaskGeometry([west, south, east, north]: Bbox) {
  const ring = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  return {
    type: "MultiPolygon",
    coordinates: buildMaskRings([ring], []).map((ring) => [ring]),
  };
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

/** Hide the outside-dimming fill when details are off, since it dims nothing then. */
function syncFadeVisible(map: MapLibreMap, shown = loadMapDetailsShown()): void {
  if (typeof map.setLayoutProperty !== "function" || !map.getLayer(FADE_ID)) return;
  map.setLayoutProperty(FADE_ID, "visibility", shown ? "visible" : "none");
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

const dataMinZoom = (fittedZoom: number | undefined) =>
  fittedZoom === undefined ? 0 : fittedZoom - DATA_APPEARS_ZOOM;

/** How much of the camera-zoom cover shows at a zoom below its fit, from hidden to opaque. */
function maskCoverProgress(zoom: number, fitZoom: number) {
  const spanZoom = MASK_FADE_START_ZOOM - MASK_FADE_END_ZOOM;
  return Math.min(1, Math.max(0, (zoom - (fitZoom - MASK_FADE_START_ZOOM)) / spanZoom));
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

function pageBackground() {
  const style = getComputedStyle(document.documentElement);
  return style.getPropertyValue(PAGE_BACKGROUND_PROPERTY).trim();
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
