/** Draw basemap water above categorical fills and the ocean above the scene mask. */
import type { Map as MapLibreMap } from "maplibre-gl";

/** The water copy above categorical fills; the basemap source stays owned by the basemap. */
export const GEOLOGY_WATER_ID = "soe-geology-water";

/** The ocean copy above the scene mask and fade; the basemap source stays owned by the basemap. */
export const OCEAN_COVER_ID = "soe-ocean-cover";

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
 * Add the basemap water fill above categorical fills. The copy reuses the basemap vector source,
 * so removing it must never remove the source and mounting it adds no network requests. The single
 * copy sits above both geology and land cover, while WorldCover water outside basemap polygons
 * stays visible because the copy only paints where the basemap has water. Returns false when the
 * style has no water.
 */
export function addGeologyWater(map: MapLibreMap, beforeId: string | undefined): boolean {
  return addWaterCopy(map, GEOLOGY_WATER_ID, undefined, beforeId);
}

/**
 * Add the basemap ocean fill above the scene mask and fade. The copy reuses the basemap vector
 * source so mounting it adds no network requests, and the soe- id keeps the scene bbox clip from
 * filtering it. It paints only the ocean class with the basemap paint, so the sea shows the
 * basemap blue at every zoom while lakes keep today's rule. Returns false when the style has no
 * water.
 */
export function addOceanCover(map: MapLibreMap, beforeId: string | undefined): boolean {
  const oceanOnly = ["==", ["get", "class"], OCEAN_CLASS];

  return addWaterCopy(map, OCEAN_COVER_ID, oceanOnly, beforeId);
}

/**
 * Add one basemap water copy with an optional extra filter. The copy keeps the basemap paint and
 * zoom range while the extra filter narrows the water underneath.
 */
function addWaterCopy(
  map: MapLibreMap,
  id: string,
  extraFilter: unknown,
  beforeId: string | undefined,
): boolean {
  if (map.getLayer(id)) return true;

  const water = basemapWaterSpec(map);
  if (!water) return false;

  const filter = combinedFilter(water.filter, extraFilter);

  map.addLayer(
    {
      id,
      type: "fill",
      source: water.source,
      "source-layer": water["source-layer"],
      ...(filter !== undefined ? { filter: filter as never } : {}),
      ...(water.layout ? { layout: water.layout as never } : {}),
      paint: water.paint as never,
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

/** Remove the water copy while leaving the basemap source untouched. */
export function removeGeologyWater(map: MapLibreMap): void {
  removeWaterCopy(map, GEOLOGY_WATER_ID);
}

/** Remove the ocean copy while leaving the basemap source untouched. */
export function removeOceanCover(map: MapLibreMap): void {
  removeWaterCopy(map, OCEAN_COVER_ID);
}

/** Remove one water copy while leaving the basemap source untouched. */
function removeWaterCopy(map: MapLibreMap, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
}
