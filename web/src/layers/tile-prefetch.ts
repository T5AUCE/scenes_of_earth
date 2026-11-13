/** Scene preload shared types with the warmer-only opener. */
import type { Map as MapLibreMap } from "maplibre-gl";

import type { TileLayerKey } from "../dev-stats";
import type { DwellViewport } from "../render/tile-viewport";
import { TileWarmer } from "./tile-warmer";

/** One unit of preload work, such as a tile download or a contour trace. */
export interface PreloadTask {
  /** Dedupes the task. A download uses its tile URL, which is also its warm key. */
  key: string;
  /** The tile zoom this task serves. */
  zoom?: number;
  /** Do the work and resolve with the downloaded body, or nothing when it lives elsewhere. */
  run(abort: AbortController): Promise<Blob | undefined>;
  /** Task keys that must already be warmed before this task may launch. */
  needs?: string[];
}

/** A pluggable kind of preload, such as the DEM pyramid, the basemap or the contour traces. */
export interface PreloadSource {
  id: string;
  /** The dev readout layer that credits this source's warmed requests. */
  layer: TileLayerKey;
  /** Tasks running at once, which keeps preload from crowding visible requests. */
  lanes: number;
  /** Another source whose tasks must finish before this one starts. */
  after?: string;
  /** The tasks for a scene fitted at this zoom, in priority order. */
  tasks(fittedZoom: number): PreloadTask[];
  /** Dwell tasks for the resting viewport, bounded so pans never flood the network. */
  dwell?(viewport: DwellViewport, fittedZoom: number, currentZoom: number): PreloadTask[];
}

/** The map surface the warmer listens to for its dwell timing. */
export type PreloadMap = Pick<MapLibreMap, "on" | "off">;

/** The preload of the open scene, which is always the HTTP-cache warmer. */
export type ScenePreloader = TileWarmer;

let current: ScenePreloader | null = null;

/** Start the preload for a scene that is opening, closing the previous one. */
export function openScenePreload(map: PreloadMap): ScenePreloader {
  closeScenePreload();
  current = new TileWarmer(map);
  return current;
}

/** The preload of the open scene, which its layers register their sources with. */
export function currentScenePreload(): ScenePreloader | null {
  return current;
}

/** Abort the open scene's preload and free what it holds. */
export function closeScenePreload(): void {
  current?.destroy();
  current = null;
}
