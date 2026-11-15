/** Draw basemap water above categorical fills so coastal gaps hide under the map's own water. */
import type { Map as MapLibreMap } from "maplibre-gl";

/** The water copy above categorical fills; the basemap source stays owned by the basemap. */
export const GEOLOGY_WATER_ID = "soe-geology-water";

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
  if (map.getLayer(GEOLOGY_WATER_ID)) return true;

  const water = basemapWaterSpec(map);
  if (!water) return false;

  map.addLayer(
    {
      id: GEOLOGY_WATER_ID,
      type: "fill",
      source: water.source,
      "source-layer": water["source-layer"],
      ...(water.filter !== undefined ? { filter: water.filter as never } : {}),
      ...(water.layout ? { layout: water.layout as never } : {}),
      paint: water.paint as never,
      ...(water.minzoom !== undefined ? { minzoom: water.minzoom } : {}),
      ...(water.maxzoom !== undefined ? { maxzoom: water.maxzoom } : {}),
    } as Parameters<MapLibreMap["addLayer"]>[0],
    beforeId,
  );

  return true;
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
  if (map.getLayer(GEOLOGY_WATER_ID)) map.removeLayer(GEOLOGY_WATER_ID);
}
