/** Mount scene renderers and coordinate their controls with colour ownership and time. */
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

import { loadAreaFeature } from "./api";
import {
  encodeSlice,
  loadStoredSlice,
  resolveCharts,
  storeSlice,
  type ChartSlice,
} from "./charts/state";
import { openStore, type Store } from "./data";
import {
  DROPPED_NOTE,
  displayUnitsFrom,
  elevationUnitFrom,
  formatDisplayParams,
  isGeologyLayer,
  loadStoredDensities,
  loadStoredInks,
  loadStoredOutline,
  loadStoredPalettes,
  loadStoredUnits,
  NO_TOKENS,
  outlineCss,
  resolveDisplay,
  type OutlineState,
  type SceneDisplay,
  setLayerDisplay,
  storeOutline,
} from "./display-state";
import { makeHtmlElement } from "./html";
import { BLEND, blendPair } from "./layers/allocate";
import { BLEND_TITLE, type BlendView, createBlendView } from "./layers/blend";
import { addGeologyWater, removeGeologyWater } from "./layers/geology-water";
import { LAYER_KINDS } from "./layers/registry";
import { firstSymbolId, removeLayerAndSource, showScaleBar } from "./map";
import { shiftLongitudes, worldShift } from "./render/mercator";
import { subscribeDrawing, type MountedLayer } from "./scene-cards";
import { createSceneStore, type SceneStore } from "./scene-store";
import { loadStoredShowAs } from "./show-as";
import { createTimeline, formatTime, scrubberTimes } from "./timeline";
import { mountSceneColumn } from "./ui/scene-column";
import type {
  DisplayTokens,
  DrawSlots,
  LayerDisplay,
  LayerDoc,
  LayerView,
  Scene,
} from "./types";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
type AddNote = (text: string) => () => void;

/** Map layer and source id of the scene's area outline. */
export const OUTLINE_ID = "soe-area-outline";
const EMPTY_FEATURES: GeoJsonData = { type: "FeatureCollection", features: [] };

// Hidden anchors keep each kind of drawing in its own band.
const SLOTS: DrawSlots = {
  fill: "soe-slot-fill",
  shade: "soe-slot-shade",
  marks: "soe-slot-marks",
  lines: "soe-slot-lines",
};

/** Where a scene puts its pieces; the caller owns the containers. */
export interface SceneSlots {
  cards: HTMLElement;
  timeBar: HTMLElement;
  onTime(time: string, label: string): void;
  onPlayingChange?(playing: boolean): void;
  /** The display settings of the link the scene was opened from, if any. */
  display?: DisplayTokens;
  /** Receives the link parameters for the scene's display choices whenever they change. */
  onDisplay(params: string): void;
  /** Receives the committed chart token for the share link whenever it changes. */
  onCharts?(token: string | null): void;
  /** Receives sync failure notices for chart persistence or sharing, null when synced. */
  onChartSync?(notice: string | null): void;
  /**
   * Receives the Terrain unit with the per-layer effective units and current map layer ids
   * whenever units change, including the restored choices of the initial load.
   */
  onUnits?(elevationUnit: string, displayUnits: Record<string, string>, layerIds: string[]): void;
}

/** Mount a scene and its controls, removing partial mounts if setup fails. */
export function mountScene(
  map: MapLibreMap,
  scene: Scene,
  {
    cards,
    timeBar,
    onTime,
    onPlayingChange,
    display: linked = NO_TOKENS,
    onDisplay,
    onCharts,
    onChartSync,
    onUnits,
  }: SceneSlots,
) {
  const box = makeHtmlElement("div", "", cards);
  const mounted: MountedLayer[] = [];
  const views: LayerView[] = [];
  let blend: BlendView | null = null;
  let timeline: ReturnType<typeof createSceneTimeline> = null;
  let isMounted = true;
  let sceneStore: SceneStore | null = null;
  let stopDrawing = () => {};
  let stopLinking = () => {};
  let column: ReturnType<typeof mountSceneColumn> | null = null;

  const notes = makeHtmlElement("div", "", box);
  const host = makeHtmlElement("div", "", box);
  const addNote = (text: string) => {
    const note = makeHtmlElement("div", text, notes);
    note.className = "notice";
    return () => note.remove();
  };

  let elevationUnit = "m";
  let displayUnits: Record<string, string> = {};
  let removeScaleBar = () => {};

  const unmount = () => {
    isMounted = false;
    column?.unmount();
    stopDrawing();
    stopLinking();
    removeScaleBar();
    timeline?.destroy();
    views.forEach((view) => view.destroy());
    blend?.destroy();
    removeGeologyWater(map);
    Object.values(SLOTS).forEach((id) => removeLayerAndSource(map, id));
    removeLayerAndSource(map, OUTLINE_ID);
    timeline?.element.remove();
    box.remove();
  };

  const { display, dropped } = resolveDisplay(
    scene.layers,
    linked,
    loadStoredPalettes(),
    loadStoredShowAs(),
    loadStoredInks(),
    loadStoredDensities(),
    loadStoredUnits(),
    loadStoredOutline(),
  );
  if (dropped) addNote(DROPPED_NOTE);
  elevationUnit = elevationUnitFrom(display, scene.layers);
  displayUnits = displayUnitsFrom(display, scene.layers);
  removeScaleBar = showScaleBar(map, elevationUnit);
  const changeDisplay = (layerId: string, change: LayerDisplay) => {
    const apply = (target: SceneDisplay) => {
      setLayerDisplay(target, layerId, { ...target.layers[layerId], ...change });
    };
    if (sceneStore) sceneStore.dispatch({ kind: "display", update: apply });
    else apply(display);
  };

  const currentLayerIds = () => {
    const ids = views.flatMap((view) => view.parts.flatMap((part) => part.layerIds));
    if (blend) ids.push(...blend.parts[0].layerIds);

    return ids;
  };

  const notifyUnits = (nextDisplay: SceneDisplay, layerDocs: readonly LayerDoc[]) => {
    const nextElevation = elevationUnitFrom(nextDisplay, layerDocs);
    const nextUnits = displayUnitsFrom(nextDisplay, layerDocs);
    if (nextElevation === elevationUnit && unitsEqual(nextUnits, displayUnits)) return;

    const elevationChanged = nextElevation !== elevationUnit;
    elevationUnit = nextElevation;
    displayUnits = nextUnits;
    if (elevationChanged) {
      removeScaleBar();
      removeScaleBar = showScaleBar(map, elevationUnit);
    }
    onUnits?.(elevationUnit, displayUnits, currentLayerIds());
  };

  const linkToken = linked.charts ? linked.charts : null;
  const storedLoaded = loadStoredSlice(scene.id, scene.layers);
  const storedForResolve = storedLoaded.stored ? storedLoaded.slice : null;
  const resolved = resolveCharts(scene.layers, linkToken, storedForResolve);
  if (linkToken) {
    if (resolved.notice) addNote(resolved.notice);
  } else if (storedLoaded.notice) {
    addNote(storedLoaded.notice);
  }
  const chartsSessionOnly = resolved.sessionOnly;

  try {
    const dataStore = openStore(scene.data.href);
    dataStore.catch((error) => addNote(`Cannot open the data: ${error.message}`));

    const shift = worldShift(scene.area.bbox);
    addOutline(map, scene, shift, addNote, () => isMounted, display.outline);
    addSlotAnchors(map);
    mounted.push(
      ...mountLayerViews(map, scene.layers, dataStore, shift, addNote, display, changeDisplay),
    );
    views.push(...mounted.map(({ view }) => view));

    blend = mountBlend(map, mounted, dataStore, shift, addNote);

    const drawLayers = mounted.map(({ layer }) => layer);
    const store = createSceneStore(drawLayers, display, resolved.slice, scene.layers);
    sceneStore = store;
    const layerDocs = scene.layers;
    column = mountSceneColumn(host, {
      mounted,
      blend,
      store,
    });
    stopDrawing = subscribeDrawing(map, mounted, blend, store);
    let previousDisplay = store.getSnapshot().display;
    let previousOutline = store.getSnapshot().display.outline;
    let previousCharts = store.getSnapshot().charts;
    let lastSyncNotice: string | null = null;
    let removeSyncNote: (() => void) | null = null;
    let storageNotice: string | null = null;
    const reportSync = (notice: string | null) => {
      if (notice === lastSyncNotice) return;
      if (removeSyncNote) {
        removeSyncNote();
        removeSyncNote = null;
      }
      lastSyncNotice = notice;
      if (notice) removeSyncNote = addNote(notice);
      onChartSync?.(notice);
    };
    const handleCharts = (chartsSlice: ChartSlice) => {
      if (!chartsSessionOnly) {
        const result = storeSlice(scene.id, chartsSlice);
        if (!result.saved && result.notice) {
          storageNotice = result.notice;
          reportSync(storageNotice);
        } else if (storageNotice !== null) {
          storageNotice = null;
          reportSync(storageNotice);
        }
      }
      onCharts?.(encodeSlice(chartsSlice));
    };
    stopLinking = store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (snapshot.display !== previousDisplay) {
        previousDisplay = snapshot.display;
        onDisplay(formatDisplayParams(snapshot.display, layerDocs));
        notifyUnits(snapshot.display, layerDocs);
        if (outlineChanged(snapshot.display.outline, previousOutline)) {
          previousOutline = { ...snapshot.display.outline };
          applyOutline(map, snapshot.display.outline);
          storeOutline(snapshot.display.outline);
        }
      }
      if (snapshot.charts !== previousCharts) {
        previousCharts = snapshot.charts;
        handleCharts(snapshot.charts);
      }
    });
    onDisplay(formatDisplayParams(store.getSnapshot().display, layerDocs));
    onUnits?.(elevationUnit, displayUnits, currentLayerIds());
    onCharts?.(encodeSlice(store.getSnapshot().charts));

    timeline = createSceneTimeline(
      blend ? [...views, blend] : views,
      scene.period,
      store,
      onTime,
      onPlayingChange,
    );
    if (timeline) timeBar.append(timeline.element);
  } catch (error) {
    unmount();
    throw error;
  }

  const layerIds = views.flatMap((view) => view.parts.flatMap((part) => part.layerIds));
  if (blend) layerIds.push(...blend.parts[0].layerIds);
  // Entry warms the current allocation and first-render work while the old pixels stay.
  const whenEntryReady = (
    getTime: () => string | null,
    getGeneration?: () => number,
  ) => waitForEntryPreparation(
    sceneStore as SceneStore,
    views,
    blend,
    timeline,
    getTime,
    getGeneration ?? (() => 0),
  );

  // The try block assigns the store, so reaching here means it exists.
  return {
    unmount,
    addNote,
    timeline,
    layerIds,
    store: sceneStore as SceneStore,
    whenEntryReady,
  };
}

/** The time an entry preparation warmed, so liftoff can revalidate it before flying. */
export interface EntryPreparation {
  time: string | undefined;
  generation: number;
  allocation: unknown;
  display: unknown;
}

/**
 * Warm the drawn layers for entry, including first-render work, without hiding failures.
 * The coordinator keeps generation and time identity so stale reads never certify readiness.
 */
function waitForEntryPreparation(
  store: SceneStore,
  views: LayerView[],
  blend: BlendView | null,
  timeline: ReturnType<typeof createSceneTimeline>,
  getTime: () => string | null,
  getGeneration: () => number,
): { ready: Promise<EntryPreparation>; cancel(): void; retarget(): void } {
  const tracker = new EntryReadiness(store, views, blend, timeline, getTime, getGeneration);
  return {
    ready: tracker.finished,
    cancel: () => tracker.cancel(),
    retarget: () => tracker.retarget(),
  };
}

/** Own the entry wait so stale work never certifies and allocation changes reprepare. */
class EntryReadiness {
  readonly finished: Promise<EntryPreparation>;
  private readonly settled = new Map<LayerView, {
    time: string | undefined;
    allocation: unknown;
    display: unknown;
  }>();
  private readonly pending = new Map<LayerView, {
    request: object;
    time: string | undefined;
    allocation: unknown;
    display: unknown;
    generation: number;
    controller: AbortController;
  }>();
  private isDone = false;
  private isCancelled = false;
  private stopStore = () => {};
  private finishOk: (preparation: EntryPreparation) => void = () => {};
  private finishBad: (error: unknown) => void = () => {};

  constructor(
    private readonly store: SceneStore,
    private readonly views: LayerView[],
    private readonly blend: BlendView | null,
    private readonly timeline: ReturnType<typeof createSceneTimeline>,
    private readonly getTime: () => string | null,
    private readonly getGeneration: () => number,
  ) {
    this.finished = new Promise<EntryPreparation>((resolve, reject) => {
      this.finishOk = resolve;
      this.finishBad = reject;
    });
    void this.start();
    this.stopStore = this.store.subscribe(() => this.reconcile());
  }

  cancel() {
    if (this.isDone) return;
    this.isDone = true;
    this.isCancelled = true;
    for (const { controller } of this.pending.values()) controller.abort();
    this.pending.clear();
    this.stopStore();
    this.finishBad(cancelError());
  }

  retarget() {
    this.reconcile();
  }

  private async start() {
    // The note paints before heavy work begins, so the old pixels stay responsive.
    await nextEntryFrame();
    if (this.isCancelled) return;

    this.reconcile();
  }

  private reconcile() {
    if (this.isDone) return;
    const time = this.getTime() ?? this.timeline?.times[0];
    const generation = this.getGeneration();
    const { allocation, display } = this.store.getSnapshot();
    const drawn = this.drawnViews();
    for (const view of drawn) {
      const asked = this.pending.get(view);
      if (asked) {
        const isRetarget = asked.time !== time
          || asked.generation !== generation
          || asked.allocation !== allocation
          || asked.display !== display;
        if (isRetarget) {
          asked.controller.abort();
          this.pending.delete(view);
        } else continue;
      }
      const kept = this.settled.get(view);
      const isStale = !kept
        || kept.time !== time
        || kept.allocation !== allocation
        || kept.display !== display;
      if (isStale) this.awaitEntry(view, time, allocation, display, generation);
    }
    for (const view of [...this.pending.keys()]) {
      if (!drawn.includes(view)) {
        this.pending.get(view)?.controller.abort();
        this.pending.delete(view);
      }
    }
    if (this.pending.size === 0) this.finishSettled(time, allocation, display, generation);
  }

  private drawnViews() {
    const drawn = this.views.filter((view) => isDrawn(this.store, view));
    if (this.blend && typeof this.store.getSnapshot().allocation.draws.get(BLEND) === "string") {
      drawn.push(this.blend);
    }

    return drawn;
  }

  private awaitEntry(
    view: LayerView,
    time: string | undefined,
    allocation: unknown,
    display: unknown,
    generation: number,
  ) {
    const request = {};
    const controller = new AbortController();
    this.pending.set(view, { request, time, allocation, display, generation, controller });
    settleEntry(view, time, controller.signal).then(
      () => {
        const asked = this.pending.get(view);
        if (!asked || asked.request !== request) {
          this.reconcile();
          return;
        }
        this.pending.delete(view);
        if (this.isDone || this.isCancelled) return;
        // A toggle or scrub while loading retargets, so stale work never certifies.
        if (asked.time !== (this.getTime() ?? this.timeline?.times[0])) {
          this.reconcile();
          return;
        }
        if (asked.generation !== this.getGeneration()) {
          this.reconcile();
          return;
        }
        const snapshot = this.store.getSnapshot();
        if (asked.allocation !== snapshot.allocation || asked.display !== snapshot.display) {
          this.reconcile();
          return;
        }
        if (!this.drawnViews().includes(view)) {
          this.reconcile();
          return;
        }

        this.settled.set(view, { time, allocation, display });
        this.reconcile();
      },
      (error) => {
        const asked = this.pending.get(view);
        if (!asked || asked.request !== request) {
          this.reconcile();
          return;
        }
        this.pending.delete(view);
        if (this.isDone || this.isCancelled) return;
        if ((error as Error)?.name === "AbortError") {
          this.reconcile();
          return;
        }

        this.fail(error);
      },
    );
  }

  private finishSettled(
    time: string | undefined,
    allocation: unknown,
    display: unknown,
    generation: number,
  ) {
    if (this.isDone || this.isCancelled) return;
    if (generation !== this.getGeneration()) return;
    if (time !== (this.getTime() ?? this.timeline?.times[0])) return;
    const snapshot = this.store.getSnapshot();
    if (allocation !== snapshot.allocation || display !== snapshot.display) return;

    void nextEntryFrame().then(() => {
      if (this.isCancelled) return;
      if (generation !== this.getGeneration()) {
        this.reconcile();
        return;
      }
      if (time !== (this.getTime() ?? this.timeline?.times[0])) {
        this.reconcile();
        return;
      }
      const latest = this.store.getSnapshot();
      if (allocation !== latest.allocation || display !== latest.display) {
        this.reconcile();
        return;
      }

      this.isDone = true;
      this.stopStore();
      this.finishOk({ time, generation, allocation, display });
    });
  }

  private fail(error: unknown) {
    this.isDone = true;
    for (const { controller } of this.pending.values()) controller.abort();
    this.pending.clear();
    this.stopStore();
    this.finishBad(error);
  }
}

async function settleEntry(
  view: LayerView,
  time: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (view.ready) await view.ready;
  if (signal?.aborted) throw cancelError();
  if (time === undefined) {
    if (typeof view.prepareEntry === "function") await view.prepareEntry(null, signal);
    return;
  }
  if (typeof view.prepareEntry === "function") {
    await view.prepareEntry(time, signal);
    return;
  }
  if (typeof view.prepare === "function") await view.prepare(time);
  if (signal?.aborted) throw cancelError();
}

function cancelError(): Error {
  const error = new Error("Entry preparation was cancelled");
  error.name = "AbortError";
  return error;
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

function unitsEqual(first: Record<string, string>, second: Record<string, string>) {
  const keys = Object.keys(first);

  return keys.length === Object.keys(second).length
    && keys.every((key) => first[key] === second[key]);
}

// Rasters past the antimeridian are drawn one world west, so the outline is shifted to match.
function addOutline(
  map: MapLibreMap,
  scene: Scene,
  shift: number,
  addNote: AddNote,
  isMounted: () => boolean,
  outline: OutlineState,
) {
  const data = shift === 0 ? scene.area.geometry_href : EMPTY_FEATURES;

  map.addSource(OUTLINE_ID, { type: "geojson", data });
  map.addLayer({ id: OUTLINE_ID, type: "line", source: OUTLINE_ID }, firstSymbolId(map));
  applyOutline(map, outline);

  if (shift === 0) return;

  showShiftedOutline(map, scene.area.geometry_href, shift, isMounted)
    .catch((error) => addNote(`Area outline: ${error.message}`));
}

/** Paint the area outline's colour, width and visibility without rebuilding. */
function applyOutline(map: MapLibreMap, outline: OutlineState) {
  map.setLayoutProperty(OUTLINE_ID, "visibility", outline.shown ? "visible" : "none");
  map.setPaintProperty(OUTLINE_ID, "line-color", outlineCss(outline.color));
  map.setPaintProperty(OUTLINE_ID, "line-width", outline.widthPx);
}

function outlineChanged(next: OutlineState, previous: OutlineState): boolean {
  return next.shown !== previous.shown
    || next.color !== previous.color
    || next.widthPx !== previous.widthPx;
}

async function showShiftedOutline(
  map: MapLibreMap,
  geometryHref: string,
  shift: number,
  isMounted: () => boolean,
) {
  const feature = await loadAreaFeature(geometryHref);
  if (!isMounted()) return;

  const { geometry } = feature;
  const shifted = {
    ...feature,
    geometry: { ...geometry, coordinates: shiftLongitudes(geometry.coordinates, shift) },
  };

  (map.getSource(OUTLINE_ID) as GeoJSONSource).setData(shifted as GeoJsonData);
}

function addSlotAnchors(map: MapLibreMap) {
  for (const id of Object.values(SLOTS)) {
    map.addLayer({ id, type: "background", layout: { visibility: "none" } }, OUTLINE_ID);
  }
}

// Unsupported or failed renderers must not prevent the other layers from mounting.
function mountLayerViews(
  map: MapLibreMap,
  layers: LayerDoc[],
  store: Promise<Store>,
  shift: number,
  addNote: AddNote,
  display: SceneDisplay,
  changeDisplay: (layerId: string, change: LayerDisplay) => void,
): MountedLayer[] {
  const layersWithKind = layers.map((layer) => ({
    layer,
    kind: LAYER_KINDS.get(layer.style.kind),
  }));

  for (const { layer } of layersWithKind.filter(({ kind }) => !kind)) {
    addNote(`${layer.title}: display not supported yet`);
  }

  const supported = layersWithKind
    .filter(({ kind }) => kind)
    .sort(
      (first, second) => first.kind!.stack - second.kind!.stack,
    );

  const geology = supported.filter(({ layer }) => isGeologyLayer(layer.id));
  const rest = supported.filter(({ layer }) => !isGeologyLayer(layer.id));

  const mounted: MountedLayer[] = [];
  const mountOne = (entry: (typeof supported)[number]) => {
    const { layer, kind } = entry;
    const report = (error: unknown) => addNote(`${layer.title}: ${(error as Error).message}`);

    try {
      const view = kind!.create({
        map,
        store,
        layer,
        shift,
        slots: SLOTS,
        beforeId: SLOTS.lines,
        display: display.layers[layer.id],
        changeDisplay: (change) => changeDisplay(layer.id, change),
        report,
      });
      view.ready?.catch(report);
      mounted.push({ layer, view });
    } catch (error) {
      report(error);
    }
  };
  for (const entry of geology) mountOne(entry);
  if (mounted.some(({ layer }) => isGeologyLayer(layer.id))) addGeologyWater(map, SLOTS.fill);
  for (const entry of rest) mountOne(entry);
  return mounted;
}

// The blend reads the two layers' own steps and ranges, so it follows their menus.
function mountBlend(
  map: MapLibreMap,
  mounted: MountedLayer[],
  store: Promise<Store>,
  shift: number,
  addNote: AddNote,
) {
  const layerDocs = mounted.map(({ layer }) => layer);
  const pair = blendPair(layerDocs);
  if (!pair) return null;

  const [rain, temperature] = pair.map((id) => layerDocs.find((layer) => layer.id === id)!);
  const rangeOf = (id: string) => {
    const mountedLayer = mounted.find(({ layer }) => layer.id === id);
    return mountedLayer?.view.menu?.range?.value ?? null;
  };
  const unitsOf = (id: string) => {
    const mountedLayer = mounted.find(({ layer }) => layer.id === id);
    return mountedLayer?.view.menu?.units?.value ?? mountedLayer?.layer.units ?? "";
  };
  const report = (error: unknown) => addNote(`${BLEND_TITLE}: ${(error as Error).message}`);

  try {
    return createBlendView(
      [rain, temperature],
      { map, store, shift, slots: SLOTS, report, rangeOf, unitsOf },
    );
  } catch (error) {
    report(error);
    return null;
  }
}

function createSceneTimeline(
  views: LayerView[],
  period: Scene["period"],
  store: SceneStore,
  onTime: SceneSlots["onTime"],
  onPlayingChange?: SceneSlots["onPlayingChange"],
) {
  const axes = views.flatMap((view) => (view.time ? [view.time] : []));
  if (!axes.length || !period) return null;

  const steps = axes.map((axis) => axis.step);
  const timeValues = axes.map((axis) => axis.values);
  const times = scrubberTimes(timeValues, period);
  const visibility = {
    isVisible: (view: LayerView) => isDrawn(store, view),
    subscribe: store.subscribe,
  };

  return createTimeline(
    times,
    steps,
    (time, isFrame) => {
      // A view that fades is driven by setFrame while play runs, so the label flip must not cut it.
      views.forEach((view) => {
        if (!isFrame || !view.setFrame) view.setTime(time);
      });
      onTime(time, formatTime(time, steps));
    },
    { views, visibility, onPlayingChange },
  );
}

function isDrawn(store: SceneStore, view: LayerView) {
  const draw = store.getSnapshot().allocation.draws.get(view.parts[0].id);

  return typeof draw === "string";
}
