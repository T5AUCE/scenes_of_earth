/** Draw inland water, the sea cover in the page colour, and the coast stroke above it. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { outlineCss, type OutlineState } from "../display-state";

/** The inland cover above every scene layer; the basemap source stays owned by the basemap. */
export const INLAND_WATER_ID = "soe-inland-water";

/** The ocean copy above every scene layer; the basemap source stays owned by the basemap. */
export const OCEAN_COVER_ID = "soe-ocean-cover";

/** The coast stroke above the ocean cover; the basemap source stays owned by the basemap. */
export const COAST_STROKE_ID = "soe-coast-stroke";

/** The basemap water class that marks the sea. */
const OCEAN_CLASS = "ocean";

interface WaterLayer {
  type?: string;
  source?: string;
  ["source-layer"]?: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  minzoom?: number;
  maxzoom?: number;
}

/**
 * Add the inland water fill above every scene layer with the basemap paint. The copy reuses
 * the basemap vector source, so mounting it adds no network requests and the soe- id keeps the
 * scene bbox clip from filtering it. It paints every water class except ocean, because the
 * ocean cover owns the sea. The scene owner keeps it below the mask, so the outside stays
 * hidden while lakes and rivers show basemap blue over data. Returns false when the style
 * has no water.
 */
export function addInlandWater(map: MapLibreMap, beforeId: string | undefined): boolean {
  const inlandOnly = ["!=", ["get", "class"], OCEAN_CLASS];

  return addWaterCopy(map, INLAND_WATER_ID, inlandOnly, beforeId);
}

/**
 * Add the basemap ocean fill above every scene layer in the page colour. The copy reuses the
 * basemap vector source so mounting it adds no network requests, and the soe- id keeps the
 * scene bbox clip from filtering it. It paints only the ocean class with an opaque fill, so
 * the sea meets the coast at basemap resolution while the inland cover paints lakes and
 * rivers. Call refreshOceanCover when the page theme changes, because map paint keeps the
 * colour it had.
 */
export function addOceanCover(
  map: MapLibreMap,
  beforeId: string | undefined,
  color: string,
): boolean {
  const oceanOnly = ["==", ["get", "class"], OCEAN_CLASS];
  const pagePaint = { "fill-color": color, "fill-opacity": 1 };

  return addWaterCopy(map, OCEAN_COVER_ID, oceanOnly, beforeId, pagePaint);
}

/** Repaint the ocean cover after a theme change, while a missing layer needs nothing. */
export function refreshOceanCover(map: MapLibreMap, color: string): void {
  if (!map.getLayer(OCEAN_COVER_ID)) return;

  map.setPaintProperty(OCEAN_COVER_ID, "fill-color", color);
}

/**
 * Add the coast stroke centred on the basemap ocean edge above the ocean cover. The copy
 * reuses the basemap water source with an ocean-only filter, so it draws the sea coast at
 * the same detail as the water edge the viewer sees and it draws no lake or reservoir
 * shore. It shares the outline colour and width, with round joins and caps, so the coast
 * reads as part of the border. The soe- id keeps the scene bbox clip from filtering it.
 * Returns false when the style has no water.
 */
export function addCoastStroke(
  map: MapLibreMap,
  beforeId: string | undefined,
  outline: OutlineState,
): boolean {
  if (map.getLayer(COAST_STROKE_ID)) {
    applyCoastStroke(map, outline);

    return true;
  }

  const water = basemapWaterSpec(map);
  if (!water) return false;

  const filter = combinedFilter(water.filter, ["==", ["get", "class"], OCEAN_CLASS]);

  map.addLayer(
    {
      id: COAST_STROKE_ID,
      type: "line",
      source: water.source,
      "source-layer": water["source-layer"],
      ...(filter !== undefined ? { filter: filter as never } : {}),
      ...(water.minzoom !== undefined ? { minzoom: water.minzoom } : {}),
      ...(water.maxzoom !== undefined ? { maxzoom: water.maxzoom } : {}),
      layout: { "line-join": "round", "line-cap": "round", visibility: "visible" } as never,
      paint: {
        "line-color": outlineCss(outline.color),
        "line-width": outline.widthPx,
        "line-opacity": 1,
      } as never,
    } as Parameters<MapLibreMap["addLayer"]>[0],
    beforeId,
  );
  applyCoastStroke(map, outline);

  return true;
}

/**
 * Repaint the coast stroke from the outline state, so the coast shares the border colour,
 * width, and visibility. A missing layer needs nothing, because exit removes it.
 */
export function applyCoastStroke(map: MapLibreMap, outline: OutlineState): void {
  if (!map.getLayer(COAST_STROKE_ID)) return;

  map.setLayoutProperty(COAST_STROKE_ID, "visibility", outline.shown ? "visible" : "none");
  map.setPaintProperty(COAST_STROKE_ID, "line-color", outlineCss(outline.color));
  map.setPaintProperty(COAST_STROKE_ID, "line-width", outline.widthPx);
}

/** Remove the coast stroke while leaving the basemap source untouched. */
export function removeCoastStroke(map: MapLibreMap): void {
  if (map.getLayer(COAST_STROKE_ID)) map.removeLayer(COAST_STROKE_ID);
}

/**
 * Add one basemap water copy with an optional extra filter. The copy keeps the basemap paint
 * and zoom range unless the caller passes its own paint, while the extra filter narrows the
 * water underneath.
 */
function addWaterCopy(
  map: MapLibreMap,
  id: string,
  extraFilter: unknown,
  beforeId: string | undefined,
  paintOverride?: Record<string, unknown>,
): boolean {
  if (map.getLayer(id)) return true;

  const water = basemapWaterSpec(map);
  if (!water) return false;

  const filter = combinedFilter(water.filter, extraFilter);
  const paint = paintOverride ?? water.paint;

  map.addLayer(
    {
      id,
      type: "fill",
      source: water.source,
      "source-layer": water["source-layer"],
      ...(filter !== undefined ? { filter: filter as never } : {}),
      ...(water.layout ? { layout: water.layout as never } : {}),
      paint: paint as never,
      ...(water.minzoom !== undefined ? { minzoom: water.minzoom } : {}),
      ...(water.maxzoom !== undefined ? { maxzoom: water.maxzoom } : {}),
    } as Parameters<MapLibreMap["addLayer"]>[0],
    beforeId,
  );

  return true;
}

/** Keep the basemap filter and narrow it with the extra clause when both exist. */
function combinedFilter(base: unknown, extra: unknown): unknown {
  if (extra === undefined) return base;
  if (base === undefined) return extra;

  return ["all", base, extra];
}

/**
 * Read the basemap water fill from the loaded style so the copy tracks its colours.
 * A missing style or water layer means there is nothing to copy.
 */
function basemapWaterSpec(map: MapLibreMap) {
  let layers: WaterLayer[] | undefined;

  try {
    layers = (map.getStyle() as unknown as { layers?: WaterLayer[] }).layers;
  } catch {
    return null;
  }

  const water = layers?.find((layer) => layer.type === "fill" && layer["source-layer"] === "water");
  if (!water?.source || !water["source-layer"] || !water.paint) return null;

  return water;
}

/** Remove the inland cover while leaving the basemap source untouched. */
export function removeInlandWater(map: MapLibreMap): void {
  removeWaterCopy(map, INLAND_WATER_ID);
}

/** Remove the ocean copy while leaving the basemap source untouched. */
export function removeOceanCover(map: MapLibreMap): void {
  removeWaterCopy(map, OCEAN_COVER_ID);
}

/** Remove one water copy while leaving the basemap source untouched. */
function removeWaterCopy(map: MapLibreMap, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
}
