/**
 * Keep a scene's display state and its colour allocation in one framework-free external store.
 * React reads an immutable snapshot through useSyncExternalStore, while the map drawing can
 * subscribe to the same changes.
 */
import {
  MAX_DEFINITIONS,
  resolveMainId,
  validateDefinition,
  type ChartDefinition,
} from "./charts/definitions";
import { CHARTS_VERSION, defaultSlice, isValidSlice, type ChartSlice } from "./charts/state";
import { layerUnits, type SceneDisplay } from "./display-state";
import { allocate, type ColourAllocation } from "./layers/allocate";
import { choose, clear, toggle, toggleMany, type ShowAsAction } from "./show-as";
import type { LayerDisplay, LayerDoc } from "./types";

/** Everything the scene's UI and map need after one change. */
export interface SceneStoreSnapshot {
  readonly display: SceneDisplay;
  /** The colour owner and the draw of every visible unit. */
  readonly allocation: ColourAllocation;
  /** Units that are switched on, including each layer's extra parts. */
  readonly on: ReadonlySet<string>;
  /** Saved chart definitions with the chosen main; tables stay derived. */
  readonly charts: ChartSlice;
}

/** A display change that is not a Show as action, such as a palette or range change. */
export interface DisplayUpdate {
  kind: "display";
  /** Change the copy it receives; the store leaves the previous snapshot untouched. */
  update(display: SceneDisplay): void;
}

/** An atomic chart change; chart edits never touch display or allocation identity. */
export type ChartStoreAction =
  | { kind: "saveChart"; definition: ChartDefinition; makeMain?: boolean }
  | { kind: "deleteChart"; id: string }
  | { kind: "setMain"; id: string }
  | { kind: "resetCharts" };

/** A Show as choice, any other display change or an atomic chart change. */
export type SceneStoreAction = ShowAsAction | DisplayUpdate | ChartStoreAction;

/** The external store contract expected by React's useSyncExternalStore. */
export interface SceneStore {
  getSnapshot(): SceneStoreSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(action: SceneStoreAction): void;
}

/** Build a store for a scene's layers and resolved display state. */
export function createSceneStore(
  layers: readonly LayerDoc[],
  display: SceneDisplay,
  initialCharts?: ChartSlice | null,
): SceneStore {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot(layers, display, initialCharts ?? null);

  function getSnapshot(): SceneStoreSnapshot {
    return snapshot;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  function dispatch(action: SceneStoreAction): void {
    if (isChartAction(action)) snapshot = applyChartAction(layers, snapshot, action);
    else snapshot = applyDisplayAction(layers, snapshot, action);
    for (const listener of [...listeners]) listener();
  }

  function applyDisplayAction(
    layers: readonly LayerDoc[],
    snapshot: SceneStoreSnapshot,
    action: DisplayUpdate | ShowAsAction,
  ): SceneStoreSnapshot {
    const next = action.kind === "display"
      ? updateDisplay(snapshot, action)
      : showAsDisplay(layers, snapshot, action);
    const on = new Set(layers.flatMap(layerUnits).filter((unit) => !next.off.has(unit)));
    const allocation = allocate(layers, on, next.showAs);

    return { display: next, allocation, on, charts: snapshot.charts };
  }

  function updateDisplay(snapshot: SceneStoreSnapshot, action: DisplayUpdate): SceneDisplay {
    const next = copyDisplay(snapshot.display);
    action.update(next);

    return next;
  }

  function showAsDisplay(
    layers: readonly LayerDoc[],
    snapshot: SceneStoreSnapshot,
    action: ShowAsAction,
  ): SceneDisplay {
    const state = { showAs: snapshot.display.showAs, off: snapshot.display.off };
    const next = action.kind === "choose"
      ? choose(state, action.unit, action.draw, layers)
      : action.kind === "clear"
        ? clear(state, action.unit)
        : action.kind === "toggle"
          ? toggle(state, action.unit, action.on, layers)
          : toggleMany(state, action.units, action.on, layers);

    return { ...copyDisplay(snapshot.display), showAs: next.showAs, off: new Set(next.off) };
  }

  return { getSnapshot, subscribe, dispatch };
}

function initialSnapshot(
  layers: readonly LayerDoc[],
  display: SceneDisplay,
  initialCharts: ChartSlice | null,
): SceneStoreSnapshot {
  const copied = copyDisplay(display);
  const on = new Set(layers.flatMap(layerUnits).filter((unit) => !copied.off.has(unit)));
  const charts = initialCharts && isValidSlice(initialCharts, layers)
    ? copySlice(initialCharts)
    : defaultSlice(layers);

  return { display: copied, allocation: allocate(layers, on, copied.showAs), on, charts };
}

function isChartAction(action: SceneStoreAction): action is ChartStoreAction {
  return action.kind === "saveChart"
    || action.kind === "deleteChart"
    || action.kind === "setMain"
    || action.kind === "resetCharts";
}

function applyChartAction(
  layers: readonly LayerDoc[],
  snapshot: SceneStoreSnapshot,
  action: ChartStoreAction,
): SceneStoreSnapshot {
  const charts = nextCharts(layers, snapshot.charts, action);

  return { display: snapshot.display, allocation: snapshot.allocation, on: snapshot.on, charts };
}

function nextCharts(
  layers: readonly LayerDoc[],
  charts: ChartSlice,
  action: ChartStoreAction,
): ChartSlice {
  if (action.kind === "resetCharts") return defaultSlice(layers);
  if (action.kind === "setMain") return setMainChart(charts, action.id);
  if (action.kind === "deleteChart") return deleteChart(layers, charts, action.id);

  return saveChart(layers, charts, action.definition, action.makeMain ?? false);
}

function saveChart(
  layers: readonly LayerDoc[],
  charts: ChartSlice,
  definition: ChartDefinition,
  makeMain: boolean,
): ChartSlice {
  const error = validateDefinition(definition, layers);
  if (error) throw new Error(error);

  const copied = copyDefinition(definition);
  const existing = charts.definitions.findIndex((entry) => entry.id === copied.id);
  const definitions = existing >= 0
    ? charts.definitions.map((entry, index) => (index === existing ? copied : entry))
    : [...charts.definitions, copied];
  if (definitions.length > MAX_DEFINITIONS) throw new Error("Too many charts.");

  const mainChartId = makeMain || charts.mainChartId === null
    ? definition.id
    : resolveMainId(definitions, charts.mainChartId, layers);

  return { version: CHARTS_VERSION, definitions, mainChartId };
}

function deleteChart(layers: readonly LayerDoc[], charts: ChartSlice, id: string): ChartSlice {
  const definitions = charts.definitions.filter((entry) => entry.id !== id);
  if (definitions.length === charts.definitions.length) return charts;
  if (definitions.length === 0) return defaultSlice(layers);

  const mainChartId = resolveMainId(definitions, charts.mainChartId, layers);

  return { version: CHARTS_VERSION, definitions, mainChartId };
}

function setMainChart(charts: ChartSlice, id: string): ChartSlice {
  if (!charts.definitions.some((entry) => entry.id === id)) return charts;

  return { version: CHARTS_VERSION, definitions: charts.definitions, mainChartId: id };
}

function copyDisplay(display: SceneDisplay): SceneDisplay {
  return {
    layers: Object.fromEntries(
      Object.entries(display.layers).map(([id, layer]) => [id, copyLayer(layer)]),
    ),
    off: new Set(display.off),
    showAs: { ...display.showAs },
  };
}

function copyLayer(layer: LayerDisplay): LayerDisplay {
  return layer.range ? { ...layer, range: [...layer.range] } : { ...layer };
}

function copySlice(slice: ChartSlice): ChartSlice {
  return {
    version: slice.version,
    definitions: slice.definitions.map((definition) => copyDefinition(definition)),
    mainChartId: slice.mainChartId,
  };
}

function copyDefinition(definition: ChartDefinition): ChartDefinition {
  const yRange = definition.options.yRange;
  if (!Array.isArray(yRange)) {
    return {
      ...definition,
      source: { ...definition.source },
      options: { ...definition.options },
    };
  }

  return {
    ...definition,
    source: { ...definition.source },
    options: { ...definition.options, yRange: [...yRange] as [number, number] },
  };
}
