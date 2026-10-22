/**
 * Keep a scene's display state and its colour allocation in one framework-free external store.
 * React reads an immutable snapshot through useSyncExternalStore, while the map drawing can
 * subscribe to the same changes.
 */
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
}

/** A display change that is not a Show as action, such as a palette or range change. */
export interface DisplayUpdate {
  kind: "display";
  /** Change the copy it receives; the store leaves the previous snapshot untouched. */
  update(display: SceneDisplay): void;
}

/** A Show as choice or any other display change. */
export type SceneStoreAction = ShowAsAction | DisplayUpdate;

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
): SceneStore {
  const listeners = new Set<() => void>();
  let snapshot = derive(layers, copyDisplay(display));

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
    const next = action.kind === "display" ? updateDisplay(action) : showAsDisplay(action);
    snapshot = derive(layers, next);
    for (const listener of [...listeners]) listener();
  }

  function updateDisplay(action: DisplayUpdate): SceneDisplay {
    const next = copyDisplay(snapshot.display);
    action.update(next);

    return next;
  }

  function showAsDisplay(action: ShowAsAction): SceneDisplay {
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

function derive(layers: readonly LayerDoc[], display: SceneDisplay): SceneStoreSnapshot {
  const on = new Set(layers.flatMap(layerUnits).filter((unit) => !display.off.has(unit)));

  return { display, allocation: allocate(layers, on, display.showAs), on };
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
