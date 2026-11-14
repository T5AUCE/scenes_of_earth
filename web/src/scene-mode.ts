/** Switch one map between the world and a single scene, holding the camera and masking the rest. */
import type {
  FilterSpecification,
  Map as MapLibreMap,
  VisibilitySpecification,
} from "maplibre-gl";

import { loadAreaFeature } from "./api";
import {
  noteEntryGap,
  noteEntryWait,
  noteSceneOpen,
  noteSceneReady,
  sceneLoadStats,
  setPreloadDisabled,
} from "./dev-stats";
import {
  loadMapDetailsShown,
  subscribeMapDetails,
} from "./display-state";
import { prefersReducedMotion } from "./reduced-motion";
import {
  addressSearch,
  gestureFlags,
  preloadEnabled,
  subscribeGesture,
  type GestureQualityFlags,
} from "./gesture-quality";
import {
  nextEntryFrame,
  REVEAL_MS,
  revealUnderCurtain,
  type EntryReveal,
} from "./entry-curtain";
import { makeHtmlElement } from "./html";
import { createMaskLayers } from "./gpu/mask-layer";
import { keepThroughContextLoss } from "./gpu/tiled-layer";
import { polygonParts } from "./label-filter";
import { basemapPreloadSource } from "./layers/scene-preload";
import { setTerrainBaseZoom } from "./layers/terrain";
import {
  closeScenePreload,
  currentScenePreload,
  openScenePreload,
} from "./layers/tile-prefetch";
import { maskRing } from "./mask-ring";
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
  PREPARING_STATUS,
  type PanelTab,
} from "./ui/panel-contract";
import { type EntryPreparation, mountScene, OUTLINE_ID } from "./view";

const MASK_ID = "soe-scene-mask";
const FADE_ID = "soe-scene-fade";
const MASK_OPACITY = 1;
// Outside labels show through this much of the page background, so they read as faded.
const FADE_OPACITY = 0.6;
// Hidden masks stay fully transparent until the reveal stages the scene under the curtain.
const HIDDEN_OPACITY = 0;
const PAGE_BACKGROUND_PROPERTY = "--page-background";

// The body carries the entry phase, so the style sheet can hide and slide the interface.
const ENTERING_CLASS = "scene-entering";
const FLYING_CLASS = "scene-flying";
const SLIDING_CLASS = "scene-ui-sliding";
// The build panel slides out over the flight, so it leaves as the camera does.
const ENTRY_FLIGHT_PROPERTY = "--entry-flight-ms";
// The scene UI slides on the same window as the curtain cross-fade.
const ENTRY_REVEAL_PROPERTY = "--entry-reveal-ms";
// The style sheet runs this animation on the body for as long as the slides last.
const SLIDES_END_ANIMATION = "entry-slides-end";

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
  buildPanel?: EntryPanel;
}

/** The build panel as entry sees it: it shows progress and failures and ignores input meanwhile. */
export interface EntryPanel {
  showStatus(text: string): void;
  setBusy(isBusy: boolean): void;
  setInert(isInert: boolean): void;
  hideAreaOutline(): void;
  showAreaOutline(): void;
}

/** The two GPU layers that cover the outside, and the call that stops keeping them alive. */
interface MaskLayers {
  mask: ReturnType<typeof createMaskLayers>[number];
  fade: ReturnType<typeof createMaskLayers>[number];
  release(): void;
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
  // Each entry gets a number so stale preparation never reveals a replaced scene.
  let entryGeneration = 0;
  let entryPanel: EntryPanel | undefined;
  let isSliding = false;

  return { enter, exit, sceneId: () => current?.id ?? null, showFullscreen };

  function enter(scene: Scene, { time: linkedTime, entry, display, buildPanel }: EnterOptions) {
    // A stale pick fit must not steer the new entry, so the camera freezes first.
    map.stop();
    leaveCurrentScene();
    entryGeneration += 1;
    noteSceneOpen(performance.now());
    resetFetchStats();
    // Captured here because publishing the entry replaces the address and drops trial flags.
    const flags = gestureFlags(addressSearch());
    const preload = openPreload(preloadEnabled(addressSearch()));

    entryPanel = buildPanel;
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

    // The basemap registers after the layer sources, so DEM and trace tasks queue first.
    preload?.add(basemapPreloadSource(map, scene.area.bbox));
    restoreTime(mounted.timeline, linkedTime);
    sceneLayerIds = mounted.layerIds;
    const panel = mountPanel(scene, mounted.timeline, clock, mounted.store);
    panelRef = panel;
    if (initialSync) panel.setSyncNotice(initialSync);

    clock.publishEntry(entry);
    clock.markEntered();

    lockEntry();
    current = startScene(scene, mounted, panel, clock, flags, () => leave(entry !== "replace"));
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
  function openPreload(isEnabled: boolean) {
    setPreloadDisabled(!isEnabled);

    return isEnabled ? openScenePreload(map) : null;
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
    return makeColumn(scene, roots.column, () => leave(entry !== "replace"));
  }

  // The interface is laid out but hidden, so the fit can measure it before anything shows.
  function lockEntry() {
    document.body.classList.add("scene-mode", ENTERING_CLASS);
    roots.column.hidden = false;
    setInputLocked(true);
  }

  // The map and interface ignore input while the scene opens, so nothing can move the camera.
  function setInputLocked(isLocked: boolean) {
    for (const element of [map.getContainer(), roots.column, roots.timeBar]) {
      element.inert = isLocked;
    }
    entryPanel?.setInert(isLocked);
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

  /**
   * Open the scene without a pause once it moves. All waiting happens first while the build panel
   * says so. Then the panel slides out with the flight, a still picture covers the map while the
   * scene is staged, and the picture cross-fades as the scene UI slides in and input unlocks.
   */
  function startScene(
    scene: Scene,
    mounted: ReturnType<typeof mountScene>,
    panel: ReturnType<typeof createScenePanel>,
    clock: SceneClock,
    flags: GestureQualityFlags,
    leaveScene: () => void,
  ): ActiveScene {
    const dataLayers = new SceneDataLayers(map, [...mounted.layerIds, OUTLINE_ID]);
    const symbolBaseline = snapshotBasemapSymbols(map, new Set(sceneLayerIds));
    // A details change mid-gesture waits for moveend so frozen symbols stay hidden.
    let labelsFrozen = false;
    // Labels stay until the curtain covers, so early toggles and gestures wait for the stage.
    let isStaged = false;
    const generation = entryGeneration;
    const stopGesture = subscribeGesture(map, {
      onStart: () => {
        if (!isStaged) return;
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
      if (!isStaged) return;
      if (labelsFrozen) return;
      setBasemapSymbolsVisible(map, shown, symbolBaseline);
      syncFadeVisible(map, shown);
    });
    const entryRun = new AbortController();
    const flight = flyIn(map, scene, roots);
    let reveal: EntryReveal | null = null;
    let masks: MaskLayers | null = null;
    let curtainId = 0;
    let isPreparing = true;
    let landedMs = 0;
    const canvas = map.getCanvas();
    const onEntryContextLost = () => {
      if (reveal) reveal.cancel();
      else failEntry(new Error("WebGL context was lost during entry"));
    };
    canvas.addEventListener("webglcontextlost", onEntryContextLost);

    entryPanel?.showStatus(PREPARING_STATUS);
    entryPanel?.setBusy(true);
    void run();

    const stopWatchingResize = watchResize(() => {
      flight.refit();
      refitTerrainBase();
    });
    const stopDocking = watchDocking(roots);

    return {
      id: scene.id,
      panel,
      clock,
      syncLayers(layerIds) {
        sceneLayerIds = [...layerIds];
        dataLayers.sync([...layerIds, OUTLINE_ID]);
        placeSceneSymbols(map, sceneLayerIds);
      },
      close() {
        entryRun.abort();
        reveal?.cancel();
        flight.stop();
        stopWatchingResize();
        stopDocking();
        stopGesture();
        stopDetails();
        stopEntryContextLoss();
        masks?.release();
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
        stopSliding();
        document.body.classList.remove("scene-mode", ENTERING_CLASS, FLYING_CLASS);
        // Some test doubles stub only setProperty, so the cleanup tolerates its absence.
        document.documentElement.style.removeProperty?.(ENTRY_FLIGHT_PROPERTY);
        document.documentElement.style.removeProperty?.(ENTRY_REVEAL_PROPERTY);
        setInputLocked(false);
        if (isPreparing) entryPanel?.showStatus("");
        if (isPreparing) entryPanel?.setBusy(false);
        // The area stays selected, so its outline returns with the build panel.
        entryPanel?.showAreaOutline();
      },
    };

    function isStale() {
      return entryRun.signal.aborted || generation !== entryGeneration;
    }

    function stopEntryContextLoss() {
      canvas.removeEventListener("webglcontextlost", onEntryContextLost);
    }

    async function run() {
      // The status paints before heavy work begins, so the old pixels stay responsive.
      await nextEntryFrame();
      if (isStale()) return;

      const fittedZoom = flight.zoom ?? map.getZoom();
      currentScenePreload()?.start(fittedZoom);
      try {
        const preparation = await prepareBeforeFlight();
        if (isStale()) return;

        noteEntryWait(performance.now() - sceneLoadStats.startMs);
        beginFlightPhase(flight.durationMs);
        await flight.start();
        currentScenePreload()?.noteLanded();
        await coverWhenLanded(preparation);
      } catch (error) {
        failEntry(error);
      }
    }

    // Everything that could pause the transition finishes here, so nothing waits once it starts.
    async function prepareBeforeFlight(): Promise<EntryPreparation> {
      const [, preparation] = await Promise.all([
        addMasksWhenLoaded(),
        mounted.prepareEntry(() => clock.time, entryRun.signal),
      ]);

      return settleOnCurrentEntry(preparation);
    }

    // An abandoned entry settles the geometry wait at once so a known failure shows promptly.
    async function addMasksWhenLoaded() {
      const { signal } = entryRun;
      const aborted = new Promise<null>((resolve) => {
        if (signal.aborted) resolve(null);
        else signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      const loaded = loadAreaFeature(scene.area.geometry_href).catch((error) => {
        throw new Error(`Area outline: ${error.message}`);
      });
      const feature = await Promise.race([loaded, aborted]);
      if (feature === null || signal.aborted) return;

      const failMask = (error: Error) => failEntry(new Error(`Area mask: ${error.message}`));
      masks = addHiddenMask(map, feature, scene.area.bbox, failMask);
    }

    // The build panel slides out with the flight while the scene UI stays hidden and inert.
    function beginFlightPhase(durationMs: number) {
      isPreparing = false;
      entryPanel?.showStatus("");
      entryPanel?.setBusy(false);
      entryPanel?.hideAreaOutline();
      document.body.classList.add(FLYING_CLASS);
      // Reduced motion hides the panel at once, so no slide duration is needed.
      if (prefersReducedMotion()) return;

      document.documentElement.style.setProperty(ENTRY_FLIGHT_PROPERTY, `${durationMs}ms`);
    }

    // A toggle or scrub while loading is caught here, so a stale preparation never reveals.
    async function settleOnCurrentEntry(preparation: EntryPreparation): Promise<EntryPreparation> {
      let latest = preparation;
      while (!isStale() && !isCurrent(latest)) {
        latest = await mounted.prepareEntry(() => clock.time, entryRun.signal);
      }

      return latest;
    }

    function isCurrent(preparation: EntryPreparation) {
      const snapshot = mounted.store.getSnapshot();

      return clock.time === preparation.time
        && snapshot.allocation === preparation.allocation
        && snapshot.display === preparation.display;
    }

    // The failure hides the scene UI again so only the build panel shows the message.
    function failEntry(error: unknown) {
      const isAbandoned = isStale();
      entryRun.abort();
      if (isAbandoned) return;

      isPreparing = false;
      stopSliding();
      document.body.classList.remove(FLYING_CLASS);
      document.body.classList.add(ENTERING_CLASS);
      entryPanel?.showStatus((error as Error).message ?? String(error));
      entryPanel?.setBusy(false);
      leaveScene();
    }

    // The flight already fits the scene bounds with its padding, so its zoom refits the base.
    function refitTerrainBase() {
      setTerrainBaseZoom(map, flight.zoom ?? map.getZoom());
    }

    async function coverWhenLanded(preparation: EntryPreparation) {
      const latest = await settleOnCurrentEntry(preparation);
      await flight.settled();
      if (isStale()) return;

      refitTerrainBase();
      landedMs ||= performance.now();
      const id = ++curtainId;
      reveal = revealUnderCurtain(
        map,
        () => stageScene(latest, id),
        () => beginRevealPhase(latest, id),
        () => finishReveal(id),
      );
    }

    // This runs inside the curtain's render event, so none of it shows before the picture covers.
    function stageScene(preparation: EntryPreparation, id: number) {
      if (isStale() || id !== curtainId) return;
      if (!isCurrent(preparation)) {
        void reprepareAndRecurtain();
        return;
      }

      const basemap = basemapLayers(map, new Set(sceneLayerIds));
      savedBasemapOrder ??= basemap.all;
      const geometry = basemap.all.filter((layer) => !basemap.symbols.includes(layer));
      lowerBasemapGeometry(map, sceneLayerIds, geometry);
      for (const symbol of basemap.symbols) {
        if (map.getLayer(symbol)) map.moveLayer(symbol, FADE_ID);
      }
      masks?.mask.setOpacity(MASK_OPACITY);
      masks?.fade.setOpacity(FADE_OPACITY);
      placeSceneSymbols(map, sceneLayerIds);
      savedBasemapFilters ??= clipBasemapToArea(map, scene.area.bbox, new Set(sceneLayerIds));
      dataLayers.show();
      isStaged = true;
      const shown = loadMapDetailsShown();
      setBasemapSymbolsVisible(map, shown, symbolBaseline);
      syncFadeVisible(map, shown);
      flight.hold();
      noteSceneReady(performance.now());
    }

    // A scrub after the curtain starts reprepares instead, so stale work never shows.
    async function reprepareAndRecurtain() {
      if (isStale()) return;
      curtainId++;
      const old = reveal;
      old?.retire();
      if (reveal === old) reveal = null;
      try {
        await coverWhenLanded(
          await mounted.prepareEntry(() => clock.time, entryRun.signal),
        );
      } catch (error) {
        failEntry(error);
      }
    }

    // The fade starts, so the scene UI slides in on the same window while staying inert.
    function beginRevealPhase(preparation: EntryPreparation, id: number) {
      if (isStale() || id !== curtainId) return;
      if (!isCurrent(preparation)) {
        void reprepareAndRecurtain();
        return;
      }

      noteEntryGap(performance.now() - landedMs);
      stopEntryContextLoss();
      document.body.classList.remove(ENTERING_CLASS);
      // The sliding styles need an animation to end them, so reduced motion skips them entirely.
      if (prefersReducedMotion()) return;

      document.documentElement.style.setProperty(ENTRY_REVEAL_PROPERTY, `${REVEAL_MS}ms`);
      document.body.classList.add(SLIDING_CLASS);
      isSliding = true;
      document.body.addEventListener("animationend", endSlidingOnSlidesEnd);
    }

    // The cross-fade completed, so the visible interface unlocks.
    function finishReveal(id: number) {
      if (isStale() || id !== curtainId) return;

      setInputLocked(false);
    }
  }

  // Cards and notes added later must not wait for the entry delays, so the sliding styles end.
  function endSlidingOnSlidesEnd(event: AnimationEvent) {
    if (event.target === document.body && event.animationName === SLIDES_END_ANIMATION) {
      stopSliding();
    }
  }

  function stopSliding() {
    if (!isSliding) return;

    isSliding = false;
    document.body.classList.remove(SLIDING_CLASS);
    document.body.removeEventListener("animationend", endSlidingOnSlidesEnd);
  }

  // Back goes through history when this page pushed the entry, so Back and the button agree.
  function leave(isPushed: boolean) {
    if (isPushed) return history.back();

    history.replaceState(null, "", location.pathname);
    exit();
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
 * Hide scene data and the area outline until the reveal, without touching their visibility
 * or native zoom bounds. A hidden layer is limited to its highest zoom, and a shown one is
 * restored to its own range.
 */
export class SceneDataLayers {
  private readonly map: MapLibreMap;
  private readonly ranges: { id: string; minzoom: number; maxzoom: number; ref: unknown }[];
  private isShown = false;

  constructor(map: MapLibreMap, layerIds: string[]) {
    this.map = map;
    this.ranges = layerIds.map((id) => nativeRange(map, id));
    this.apply();
  }

  show() {
    this.isShown = true;
    this.apply();
  }

  /**
   * Track recreated layers after a units change. Dropped ids leave the gate and new ids join
   * with their native zooms, while unchanged layers keep the ranges they were first seen with.
   */
  sync(layerIds: string[]) {
    const kept = new Map(this.ranges.map((range) => [range.id, range]));
    this.ranges.length = 0;
    for (const id of layerIds) {
      const previous = kept.get(id);
      const native = nativeRange(this.map, id);
      this.ranges.push(previous && previous.ref === native.ref ? previous : native);
    }
    this.apply();
  }

  private apply() {
    for (const { id, minzoom, maxzoom } of this.ranges) {
      if (!this.map.getLayer(id)) continue;

      this.map.setLayerZoomRange(id, this.isShown ? minzoom : maxzoom, maxzoom);
    }
  }
}

function nativeRange(map: MapLibreMap, id: string) {
  const layer = map.getLayer(id);

  return { id, minzoom: layer?.minzoom ?? 0, maxzoom: layer?.maxzoom ?? MAX_ZOOM, ref: layer };
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

// Everything outside the area is blanked, which also crops the cell edges of the layers below.
function addHiddenMask(
  map: MapLibreMap,
  feature: AreaFeature,
  bbox: Bbox,
  onFail: (error: Error) => void,
): MaskLayers {
  const shift = worldShift(bbox);
  const { exteriors, interiors } = outlines(feature.geometry);
  const rings = [...exteriors, ...interiors]
    .map((ring) => shiftLongitudes(ring, shift) as number[][]);
  // Both start transparent so the basemap stays stable while required work settles.
  const options = { rings, color: pageBackground(), opacity: HIDDEN_OPACITY, onFail };
  // The fade is a second layer above the basemap symbols, so outside labels read as dimmed.
  const [mask, fade] = createMaskLayers(options, [MASK_ID, FADE_ID]);
  map.addLayer(mask.layer);
  map.addLayer(fade.layer);
  const stopKeepingMask = keepThroughContextLoss(map, mask.layer, undefined);
  const stopKeepingFade = keepThroughContextLoss(map, fade.layer, undefined);

  return {
    mask,
    fade,
    release() {
      stopKeepingMask();
      stopKeepingFade();
    },
  };
}

/** Drop basemap geometry below the lowest scene layer, keeping every relative order. */
function lowerBasemapGeometry(
  map: MapLibreMap,
  sceneLayerIds: readonly string[],
  nonSymbols: readonly string[],
): void {
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
  if (!baseline) return;
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
    coordinates: [[maskRing([ring])]],
  };
}

/** Scene symbols sit under the mask so labels are cut at the outline, not drawn outside it. */
function placeSceneSymbols(map: MapLibreMap, sceneLayerIds: readonly string[]): void {
  const beforeId = map.getLayer(MASK_ID) ? MASK_ID : undefined;
  for (const id of sceneSymbols(map, sceneLayerIds)) map.moveLayer(id, beforeId);
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
  for (const [id] of baseline) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, "visibility", visible ? "visible" : ("none" as const));
  }
}

/** Hide the outside-dimming fill when details are off, since it dims nothing then. */
function syncFadeVisible(map: MapLibreMap, shown = loadMapDetailsShown()): void {
  if (!map.getLayer(FADE_ID)) return;
  map.setLayoutProperty(FADE_ID, "visibility", shown ? "visible" : "none");
}

/** Return each basemap symbol to its own visibility, clearing overrides the scene added. */
function restoreBasemapSymbols(
  map: MapLibreMap,
  baseline: ReadonlyMap<string, VisibilitySpecification | undefined>,
): void {
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
