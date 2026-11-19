/** Draw scene borders from the basemap's boundary lines, with the bundle's borders at low zoom. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { outlineCss, type OutlineState } from "../display-state";
import type { Scene } from "../types";
import { basemapLayerSpec } from "./geology-water";

/** The solid basemap border line at and above the area's switch zoom. */
export const BORDER_LINE_ID = "soe-border-line";

/** The disputed basemap border line at and above the area's switch zoom. */
export const BORDER_DISPUTED_ID = "soe-border-disputed";

/** The bundle's borders below the area's switch zoom. */
export const BORDER_LOW_ID = "soe-border-low";

/** Every border copy, in the order they stack from bottom to top. */
export const BORDER_LAYER_IDS = [BORDER_LOW_ID, BORDER_LINE_ID, BORDER_DISPUTED_ID];

// The coast mask keeps only the half of a centred line inside the area, so double the width.
const BORDER_WIDTH_FACTOR = 2;
// Half of Liberty's [1, 2] keeps the dash length at twice the line width.
const DISPUTED_DASH_PATTERN = [0.5, 1];
// A zero gap keeps the solid features continuous while one layer dashes both kinds.
const SOLID_DASH_PATTERN = [1, 0];

const NON_MARITIME = ["!=", ["get", "maritime"], 1];
const SOLID_BORDER = ["!=", ["get", "disputed"], 1];
const DISPUTED_BORDER = ["==", ["get", "disputed"], 1];

// The bundle writes disputed as a boolean, while the vector tiles use 0 and 1.
const BUNDLE_DISPUTED = ["==", ["get", "disputed"], true];

/**
 * Add the three border copies when the area and the basemap allow it. The solid and disputed
 * lines copy the basemap boundary line at the area's own admin level from its switch zoom,
 * while the low layer draws the bundle's borders below that zoom. Returns false for a drawn
 * area, an area without a level or borders, or a style without a boundary line.
 */
export function addBorders(
  map: MapLibreMap,
  area: Scene["area"],
  outline: OutlineState,
  lowSourceId: string,
  beforeId: string | undefined,
): boolean {
  const level = area.border_level;
  const minZoom = area.border_min_zoom;
  if (!area.borders_href || typeof level !== "number" || typeof minZoom !== "number") return false;

  const boundary = basemapLayerSpec(map, "boundary", "line");
  if (!boundary) return false;

  if (map.getLayer(BORDER_LINE_ID)) {
    applyBorders(map, outline);
    return true;
  }

  const source = boundary.source;
  const sourceLayer = boundary["source-layer"];

  map.addLayer(
    borderLayerSpec({
      id: BORDER_LOW_ID,
      source: lowSourceId,
      maxzoom: minZoom,
      paint: borderPaint(outline, disputedDashes()),
    }),
    beforeId,
  );
  map.addLayer(
    borderLayerSpec({
      id: BORDER_LINE_ID,
      source,
      sourceLayer,
      filter: ["all", adminAtMost(level), NON_MARITIME, SOLID_BORDER],
      minzoom: minZoom,
      paint: borderPaint(outline),
    }),
    beforeId,
  );
  map.addLayer(
    borderLayerSpec({
      id: BORDER_DISPUTED_ID,
      source,
      sourceLayer,
      filter: ["all", adminAtMost(level), NON_MARITIME, DISPUTED_BORDER],
      minzoom: minZoom,
      paint: borderPaint(outline, DISPUTED_DASH_PATTERN),
    }),
    beforeId,
  );
  applyBorders(map, outline);

  return true;
}

interface BorderLayerSpec {
  id: string;
  source: string;
  sourceLayer?: string;
  filter?: unknown;
  minzoom?: number;
  maxzoom?: number;
  paint: Record<string, unknown>;
}

/** One line copy that reuses a basemap or bundle source with its own filter and zoom range. */
function borderLayerSpec(layer: BorderLayerSpec) {
  return {
    id: layer.id,
    type: "line",
    source: layer.source,
    ...(layer.sourceLayer !== undefined ? { "source-layer": layer.sourceLayer } : {}),
    ...(layer.filter !== undefined ? { filter: layer.filter } : {}),
    ...(layer.minzoom !== undefined ? { minzoom: layer.minzoom } : {}),
    ...(layer.maxzoom !== undefined ? { maxzoom: layer.maxzoom } : {}),
    layout: { "line-join": "round" },
    paint: layer.paint,
  } as Parameters<MapLibreMap["addLayer"]>[0];
}

/** The border paint at twice the outline width, because the coast mask hides the outer half. */
function borderPaint(outline: OutlineState, dasharray?: unknown): Record<string, unknown> {
  return {
    "line-color": outlineCss(outline.color),
    "line-width": outline.widthPx * BORDER_WIDTH_FACTOR,
    "line-opacity": 1,
    ...(dasharray !== undefined ? { "line-dasharray": dasharray } : {}),
  };
}

/** Dash only the features marked disputed in the bundle's borders collection. */
function disputedDashes() {
  return [
    "case",
    BUNDLE_DISPUTED,
    ["literal", DISPUTED_DASH_PATTERN],
    ["literal", SOLID_DASH_PATTERN],
  ];
}

function adminAtMost(level: number) {
  return ["<=", ["get", "admin_level"], level];
}

/** Paint every mounted border copy from the area outline's colour, width and visibility. */
export function applyBorders(map: MapLibreMap, outline: OutlineState): void {
  for (const id of BORDER_LAYER_IDS) {
    if (!map.getLayer(id)) continue;

    map.setLayoutProperty(id, "visibility", outline.shown ? "visible" : "none");
    map.setPaintProperty(id, "line-color", outlineCss(outline.color));
    map.setPaintProperty(id, "line-width", outline.widthPx * BORDER_WIDTH_FACTOR);
  }
}

/** Whether the basemap border copy is mounted, which keeps the fallback outline hidden. */
export function borderCopyMounted(map: MapLibreMap): boolean {
  return BORDER_LAYER_IDS.some((id) => Boolean(map.getLayer(id)));
}

/** Remove every border copy while leaving the basemap source untouched. */
export function removeBorders(map: MapLibreMap): void {
  for (const id of BORDER_LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
}
