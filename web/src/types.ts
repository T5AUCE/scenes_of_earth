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
  first_month: string | null; // "YYYY-MM", time-varying layers only
  latest_month: string | null;
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

export interface Scene {
  id: string;
  title: string;
  time: { start: string; end: string; count: number } | null;
  area: { bbox: Bbox; geometry_href: string };
  layers: { id: string; units: string; time_varying: boolean; arrays: Record<string, string>; style: { kind: string; title: string } }[];
  data: { href: string };
  notices: { limits: string[] };
}
