import { useSyncExternalStore } from "react";

import type { SceneStore, SceneStoreSnapshot } from "../scene-store";

/** Subscribe a React component to a scene store's immutable snapshot. */
export function useSceneStore(store: SceneStore): SceneStoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
