import type { Map as MapLibreMap } from "maplibre-gl";

import type { Store } from "./data";
import type { Coordinates } from "./render/mercator";

// Shapes of backend responses (only the fields the frontend uses).

export interface Health {
  ok: boolean;
  version: string;
}

// [W, S, E, N]; E may exceed 180 across the antimeridian.
export type Bbox = [number, number, number, number];

export interface Layer {
  id: string;
  title: string;
  units: string;
  kind: string; // style.kind: how to render it
  time_varying: boolean;
  coverage: Bbox;
  time: { step: string; first: string; latest: string } | null; // first/latest are "YYYY-MM"
}

export interface LayersResponse {
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
  error: string | null;
  error_class: string | null;
  bundle_url: string | null;
}

export interface GridDoc {
  bbox: Bbox;
  res: number; // degrees
  nx: number;
  ny: number;
}

export interface ArrayDoc {
  path: string;
  dtype: string;
  scale_factor: number;
  add_offset: number;
  fill: number | null;
}

export interface TimeDoc {
  step: string; // ISO 8601 duration, e.g. P1M
  values: string[]; // "YYYY-MM-DD" period starts
}

// Licence and attribution of one data source, as the bundle states them.
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

export interface LayerDoc {
  id: string;
  title: string;
  units: string;
  source: CreditDoc;
  style: {
    kind: string;
    colormap?: string;
    domain?: [number, number];
  };
  grid: GridDoc;
  mask: { path: string; cells_inside: number };
  time: TimeDoc | null;
  arrays: Record<string, ArrayDoc>; // by role, e.g. value, elevation, hillshade
}

// area.geojson: one Feature holding the area's outline.
export interface AreaFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: Coordinates };
}

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
  layers: LayerDoc[];
  data: { href: string };
  notices: { limits: string[] };
  credits: {
    lines: string[];
    disclaimers: string[];
    endorsement: string;
  };
}

export interface Part {
  id: string;
  label: string;
  layerIds: string[]; // map layers shown or hidden together
  onToggle?(visible: boolean): void;
}

export interface LayerContext {
  map: MapLibreMap;
  store: Promise<Store>;
  layer: LayerDoc;
  beforeId: string | undefined;
  // For failures after the layer is mounted, e.g. a month that cannot be read.
  report(error: unknown): void;
}

export interface LayerView {
  parts: Part[];
  options: { label: string; set(on: boolean): void }[];
  time: TimeDoc | null;
  ready?: Promise<void>; // rejects when the layer's data cannot be read
  setTime(time: string): void;
  legend(): HTMLElement | null;
  destroy(): void;
}
