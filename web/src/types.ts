import type { Map as MapLibreMap } from "maplibre-gl";
import type { Store } from "./data";

// Shapes of backend responses (only the fields the frontend uses).

export interface Health {
  ok: boolean;
  version: string;
}

export type Bbox = [number, number, number, number]; // [W, S, E, N]; E may exceed 180 across the antimeridian

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

export interface LayerDoc {
  id: string;
  title: string;
  units: string;
  style: {
    kind: string;
    colormap?: string;
    domain?: [number, number];
  };
  grid: GridDoc;
  mask: { path: string };
  time: TimeDoc | null;
  arrays: Record<string, ArrayDoc>; // by role, e.g. value, elevation, hillshade
}

export interface Scene {
  version: string;
  id: string;
  title: string;
  area: { bbox: Bbox; geometry_href: string };
  layers: LayerDoc[];
  data: { href: string };
  notices: { limits: string[] };
}

export interface Part {
  id: string;
  label: string;
  layerIds: string[]; // map layers shown or hidden together
}

export interface LayerContext {
  map: MapLibreMap;
  store: Promise<Store>;
  layer: LayerDoc;
  beforeId: string | undefined;
  report(error: unknown): void; // for failures after the layer is mounted, e.g. a month that cannot be read
}

export interface LayerView {
  parts: Part[];
  options: { label: string; set(on: boolean): void }[];
  time: TimeDoc | null;
  ready: Promise<void>; // rejects when the layer's data cannot be read
  setTime(t: string): void;
  legend(): HTMLElement | null;
  destroy(): void;
}
