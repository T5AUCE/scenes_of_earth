import type {} from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { Store } from "./data";
import type { Coordinates } from "./render/mercator";

export interface Health {
  ok: boolean;
  version: string;
}

/** [W, S, E, N] in degrees; E may exceed 180 across the antimeridian. */
export type Bbox = [number, number, number, number];

/** One layer offered by /api/layers, before a scene is built. */
export interface Layer {
  id: string;
  title: string;
  units: string;
  kind: string; // style.kind: how to render it
  time_varying: boolean;
  coverage: Bbox;
  time: { step: string; first: string; last: string } | null; // request periods, e.g. "YYYY-MM"
}

export interface LayersResponse {
  request_step: string; // ISO 8601 duration of the periods a scene request names, e.g. P1M
  default: string[];
  layers: Layer[];
}

export interface AreaHit {
  id: string;
  name: string;
  level: string;
  iso3: string | null;
  parent_name: string | null;
  bbox: Bbox;
  cells: number;
}

export interface SceneRequest {
  area: { type: "boundary"; id: string };
  start?: string; // omitted when no selected layer is time-varying
  end?: string;
  layers: string[];
  title?: string;
}

export interface SceneStatus {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  stage?: string | null; // short text such as "Rain 2019-03"; may be missing or null
  error: string | null;
  error_class: string | null;
  bundle_url: string | null;
}

/** A layer's stored grid, as scene.json describes it. */
export interface GridDoc {
  bbox: Bbox;
  res: number; // degrees
  nx: number;
  ny: number;
}

/** Storage and decoding metadata for one array role in scene.json. */
export interface ArrayDoc {
  path: string;
  dtype: string;
  scale_factor: number;
  add_offset: number;
  fill: number | null;
}

/** A layer's available period starts and exclusive end, as ISO dates. */
export interface TimeDoc {
  step: string; // ISO 8601 duration, e.g. P1M
  values: string[]; // "YYYY-MM-DD" period starts
  end: string; // "YYYY-MM-DD", the day after the last period
  method: string | null; // how a step summarises its period: sum, mean, point or max
}

/** The requested range of a scene, as ISO dates. */
export interface Period {
  start: string;
  end: string; // the day after the last period
  step: string;
}

/** Licence and attribution of one data source, as the bundle states them. */
export interface CreditDoc {
  name: string;
  version?: string;
  licence: string;
  licence_url?: string;
  attribution?: string;
  citation?: string;
  modified?: string;
  disclaimer?: string;
}

export interface BoundaryDoc {
  id: string;
  name: string;
  level: string;
  iso3: string | null;
  source: string;
  licence: string;
  licence_url?: string;
  attribution?: string;
  citation?: string;
  modified?: string;
}

/** Shared elevation tiles used for both relief and contours. */
export interface TerrainTiles {
  url: string;
  encoding: "terrarium";
  tile_size: number;
  maxzoom: number;
  source: CreditDoc;
}

/** In-mask Copernicus summaries that seed a scene's stable contour ladder. */
export interface TerrainStats {
  min: number;
  max: number;
  mean: number;
  p2: number;
  p98: number;
  slope_p50_deg: number;
  slope_p90_deg: number;
  cell_m: number;
}

/** One built layer's sources, display choices, grid and stored arrays. */
export interface LayerDoc {
  id: string;
  title: string;
  units: string;
  source: CreditDoc;
  fallback_sources?: CreditDoc[]; // sources of tiles or cells the main one lacks
  style: {
    kind: string;
    encodings: string[]; // display types the layer offers, best first
    parts?: string[]; // extra display types drawn alongside the main one
    palette?: string; // default colours of a field layer
    stops?: number[]; // fitted values of the palette's colours, 2-9 increasing
    classes?: { value: number; label: string; color: string }[]; // categorical layers
  };
  grid: GridDoc;
  mask: { path: string; cells_inside: number };
  time: TimeDoc | null;
  arrays: Record<string, ArrayDoc>; // by role, e.g. value or source; empty for tiled terrain
  tiles?: TerrainTiles;
  stats?: TerrainStats | Record<string, number | number[]>;
}

/** The area.geojson file, which is one Feature holding the area's outline. */
export interface AreaFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: Coordinates };
}

/** The scene.json fields the frontend consumes. */
export interface Scene {
  version: string;
  id: string;
  title: string;
  generator: { name: string; version: string };
  created: string; // ISO 8601 with UTC offset
  area: {
    boundary: BoundaryDoc | null; // null for a drawn polygon
    bbox: Bbox;
    geometry_href: string;
    clipped_to_coverage: boolean;
  };
  period: Period | null; // null for a scene without time-varying layers
  layers: LayerDoc[];
  data: { href: string };
  notices: { limits: string[] };
  credits: {
    lines: string[];
    disclaimers: string[];
    endorsement: string;
  };
}

/** A toggleable piece of a layer: map layers shown or hidden together. */
export interface Part {
  id: string;
  label: string;
  layerIds: string[];
  onToggle?(visible: boolean): void;
  /** Sliders shown under the part's checkbox while the part is on. */
  controls?: LayerControl[];
  /** A small note under the checkbox, such as the contour interval. */
  note?: HTMLElement;
}

/** What a layer renderer gets to draw one layer. */
export interface LayerContext {
  map: MapLibreMap;
  store: Promise<Store>;
  layer: LayerDoc;
  shift: number; // longitude offset of the scene's world copy, the same for all its layers
  beforeId: string | undefined;
  /** Report failures after mounting, such as a step that cannot be read. */
  report(error: unknown): void;
}

/** A slider under a part's checkbox; its value lasts for the visit only. */
export interface LayerControl {
  label: string;
  /** A short instruction shown above the slider. */
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  set(value: number): void;
}

/** Own a drawn layer's controls and time axis along with its legend and teardown. */
export interface LayerView {
  parts: Part[];
  options: { label: string; set(on: boolean): void }[];
  time: TimeDoc | null;
  ready?: Promise<void>; // rejects when the layer's data cannot be read
  setTime(time: string): void;
  legend(): HTMLElement | null;
  destroy(): void;
}
