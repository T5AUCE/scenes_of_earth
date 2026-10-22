/** Describe API responses and bundle metadata alongside the viewer's renderer contracts. */
import type {} from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { Store } from "./data";
import type { Draw } from "./layers/allocate";
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
  kind: string; // renderer selected by style.kind
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
  method: string | null; // period summary method (sum, mean, point or max)
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

/** One class of a categorical layer, with the layer's own colour for it. */
export interface ClassDoc {
  value: number;
  label: string;
  color: string; // #rrggbb
}

/** A built layer's metadata and storage contract. */
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
    palette?: string; // default colours of a field layer, or of a categorical layer's classes
    stops?: number[]; // fitted values of the palette's colours, 2-9 increasing
    classes?: ClassDoc[]; // categorical layers
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

/** A toggleable group of map layers within one data layer. */
export interface Part {
  /** The layer's id for its first part and `<layer id>.<part>` for the others, as links name it. */
  id: string;
  label: string;
  layerIds: string[];
  onToggle?(visible: boolean): void;
  /** Sliders shown under the part's checkbox while the part is on. */
  controls?: LayerControl[];
  /** A small note under the checkbox, such as the contour interval. */
  note?: HTMLElement;
}

/** Raw display parameters from a link, including per-unit Show as choices. */
export interface DisplayTokens {
  pal: string;
  range: string;
  off: string;
  as: string; // `unit:draw` entries, where the unit is a layer id or blend
  ink: string; // `layer:preset` or `layer:rrggbb` entries
  dens: string; // `layer:multiple` entries, the dot density as a multiple of the default
  units: string; // `layer:unit` entries, the display unit for a convertible layer
}

/** A layer's display choices that differ from the bundle; a missing field means its default. */
export interface LayerDisplay {
  palette?: string;
  /** A dot or isotherm ink, by preset name or as #rrggbb. */
  ink?: string;
  range?: [number, number];
  /** The dot density as a multiple of the default one. */
  density?: number;
  /** The display unit for a convertible layer; absent means the bundle's native units. */
  units?: string;
}

/** Ids of the hidden map layers that fix where each kind of drawing sits, from bottom to top. */
export interface DrawSlots {
  /** Colour fills go below this anchor, so the shade covers them. */
  fill: string;
  /** The relief shade goes below this anchor. */
  shade: string;
  /** Dots go below this anchor, above the shade. */
  marks: string;
  /** Lines and outlines go below this anchor, above the dots. */
  lines: string;
}

/** What a layer renderer gets to draw one layer. */
export interface LayerContext {
  map: MapLibreMap;
  store: Promise<Store>;
  layer: LayerDoc;
  shift: number; // longitude offset of the scene's world copy, the same for all its layers
  slots: DrawSlots;
  /** The anchor of the lines slot, for line layers that need no other slot. */
  beforeId: string | undefined;
  /** The viewer's choices for this layer; absent means the bundle's defaults. */
  display?: LayerDisplay;
  /** Records a change of the viewer's choices for this layer, so the share link follows it. */
  changeDisplay(change: LayerDisplay): void;
  /**
   * Report failures after mounting, such as a step that cannot be read.
   * Returns a function that withdraws the note when the failure clears.
   */
  report(error: unknown): () => void;
}

/** A slider in a layer card or its menu. */
export interface LayerControl {
  label: string;
  unit?: string;
  /** A short instruction shown above the slider. */
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  set(value: number): void;
  /** Whether the slider applies right now; absent means it always does. */
  readonly isShown?: boolean;
  /** Fires a change event when isShown may have changed. */
  updates?: EventTarget;
}

/** The browser's edge choices for a categorical dataset, independent of shared links. */
export interface EdgeSettings {
  rounding: number;
  softnessCells: number;
  outline: boolean;
}

/** Controls available only while categorical classes are drawn with WebGL. */
export interface EdgesMenu {
  controls: LayerControl[];
  outline: { readonly value: boolean; set(on: boolean): void };
  readonly isDefault: boolean;
  reset(): void;
}

/** One palette in a layer menu, with the CSS colours of its swatch. */
export interface PaletteChoice {
  name: string;
  label: string;
  colors: string[];
}

/** The ink of a layer's dots or isotherms, which its menu can change. */
export interface InkMenu {
  /** The heading above the choices, such as Dot ink. */
  heading: string;
  presets: PaletteChoice[];
  defaultInk: string;
  /** Whether the layer is drawn as dots or isotherms right now. */
  readonly inUse: boolean;
  /** A preset name or a custom #rrggbb. */
  readonly value: string;
  set(ink: string): void;
}

/** A display range a layer's menu can change. */
export interface RangeMenu {
  /** The range the bundle fits to the area, with uneven spacing. */
  fitted: [number, number];
  /** The lowest and highest value in the area, which limit what can be typed. */
  bounds: [number, number];
  /** The number of decimals a link keeps. */
  decimals: number;
  units: string;
  /** The chosen display unit, which defaults to the native units. */
  readonly displayUnit?: string;
  /** The custom range, or null while the fitted one applies. */
  readonly value: [number, number] | null;
  set(range: [number, number] | null): void;
}

/** The display units a convertible layer offers, which its menu can change. */
export interface UnitsMenu {
  options: readonly string[];
  /** The bundle's native units, which the layer shows until the viewer chooses another. */
  defaultUnit: string;
  /** The chosen display unit. */
  readonly value: string;
  set(unit: string): void;
}

/** What a layer's Edit menu offers; changes apply to the map immediately. */
export interface LayerMenu {
  title: string;
  /** The heading above the palettes, such as Colours. */
  heading: string;
  /** Draw each swatch as separate blocks instead of one gradient. */
  blocks: boolean;
  palettes: PaletteChoice[];
  defaultPalette: string;
  /** Offer a custom gradient of 2 to 5 colours. */
  custom: boolean;
  readonly palette: string;
  setPalette(name: string): void;
  range?: RangeMenu;
  /** Present for a convertible layer, such as rainfall or temperature. */
  units?: UnitsMenu;
  /** Present for a layer with dots or isotherms, which replace the palettes while drawn. */
  ink?: InkMenu;
  readonly edges?: EdgesMenu;
  /** Explain why optional controls are unavailable, without showing disabled sliders. */
  readonly edgesNote?: string;
  /** Says that the palette applies only while the layer holds colour, empty while it does. */
  readonly paletteNote?: string;
  /** Notify an open menu when renderer-dependent controls change. */
  updates?: EventTarget;
  /** Reset a renderer control that lives outside the menu, such as the dot density. */
  resetDensity?(): void;
  /** Whether the dot density is at its default, so Reset layer needs no confirmation. */
  readonly isDensityDefault?: boolean;
}

/** Own a drawn layer's controls and time axis along with its legend and teardown. */
export interface LayerView {
  parts: Part[];
  options: { label: string; set(on: boolean): void; note?: string; initial?: boolean }[];
  time: TimeDoc | null;
  menu?: LayerMenu;
  ready?: Promise<void>; // rejects when the layer's data cannot be read
  setTime(time: string): void;
  /**
   * Draw the layer's first part as the allocation says, or stop drawing for null. A view without
   * it lets its parts' checkboxes switch their map layers.
   */
  show?(draw: Draw | null): void;
  /** Why the layer cannot draw its fallback right now, with an event for when that changes. */
  blocked?: { readonly reason: string | null; readonly changes: EventTarget };
  /** Soften the shade while a layer holds colour, so the colour stays readable under it. */
  setColourUnder?(isUnder: boolean): void;
  legend(): HTMLElement | null;
  destroy(): void;
}
