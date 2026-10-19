import { removeLayerAndSource } from "../map";
import type { LayerContext, LayerControl, LayerView, TerrainStats } from "../types";
import { ContourOverlay, sharedDemSource, terrainTileBounds } from "./contour-overlay";
import { backdropMaxZoom, RELIEF_STRENGTH, reliefPaint } from "./relief";

/** Terrain shading from Mapterhorn tiles and contour lines for one terrain layer. */
export function createTerrainView(context: LayerContext): LayerView {
  const { map, layer, beforeId, report } = context;
  const { tiles, stats } = layer;
  if (!tiles || !stats) throw new Error("Terrain needs tile metadata and summary statistics");

  const dem = sharedDemSource(tiles);
  const id = `${layer.id}-relief`;

  const backdropId = `${id}-backdrop`;
  const [west, , east] = layer.grid.bbox;
  const backdropZoom = backdropMaxZoom(
    east - west,
    map.getCanvas().clientWidth,
    tiles.tile_size,
    tiles.maxzoom,
  );

  const addDemSource = (sourceId: string, maxzoom: number, attribution?: string) => {
    map.addSource(sourceId, {
      type: "raster-dem",
      tiles: [dem.sharedDemProtocolUrl],
      encoding: tiles.encoding,
      tileSize: tiles.tile_size,
      maxzoom,
      ...(attribution ? { attribution } : {}),
      ...terrainTileBounds(layer.grid.bbox),
    });
  };
  // The coarse backdrop keeps some relief loaded while a zoom change waits for its own tiles.
  addDemSource(backdropId, backdropZoom);
  map.addLayer(
    {
      id: backdropId,
      type: "hillshade",
      source: backdropId,
      paint: reliefPaint(RELIEF_STRENGTH.initial),
    },
    beforeId,
  );
  addDemSource(id, tiles.maxzoom, tiles.source.attribution);
  map.addLayer(
    { id, type: "hillshade", source: id, paint: reliefPaint(RELIEF_STRENGTH.initial) },
    beforeId,
  );

  // Both layers shading at once would darken twice, so the backdrop goes flat once the main loads.
  let strengthValue = RELIEF_STRENGTH.initial;
  const paintBackdrop = () => {
    const isMainReady = map.isSourceLoaded(id) && !map.isZooming();
    const visibleStrength = isMainReady ? 0 : strengthValue;
    const exaggeration = reliefPaint(visibleStrength)["hillshade-exaggeration"];
    map.setPaintProperty(backdropId, "hillshade-exaggeration", exaggeration);
  };
  const onMainSourceData = (event: object) => {
    if ((event as { sourceId?: string }).sourceId === id) paintBackdrop();
  };
  map.on("dataloading", onMainSourceData);
  map.on("sourcedata", onMainSourceData);
  map.on("zoomstart", paintBackdrop);
  map.on("zoomend", paintBackdrop);

  const reportTilesUnavailable = (event: object) => {
    const sourceId = (event as { sourceId?: string }).sourceId;
    if (sourceId !== id && sourceId !== `${layer.id}-contours`) return;

    map.off("error", reportTilesUnavailable);
    report(new Error("Terrain shading or contour tiles could not be loaded"));
  };
  map.on("error", reportTilesUnavailable);

  const strength: LayerControl = {
    label: "Relief strength",
    hint: "Change intensity using slider",
    min: RELIEF_STRENGTH.min,
    max: RELIEF_STRENGTH.max,
    step: RELIEF_STRENGTH.step,
    value: RELIEF_STRENGTH.initial,
    set: (value) => {
      strengthValue = value;
      const exaggeration = reliefPaint(value)["hillshade-exaggeration"];
      map.setPaintProperty(id, "hillshade-exaggeration", exaggeration);
      paintBackdrop();
    },
  };

  const contourOverlay = new ContourOverlay(context, dem, tiles, stats as TerrainStats);

  return {
    parts: [
      { id, label: "Relief", layerIds: [backdropId, id], controls: [strength] },
      contourOverlay.part,
    ],
    options: [],
    time: null,
    setTime: () => {},
    legend: () => null,
    destroy: () => {
      map.off("error", reportTilesUnavailable);
      map.off("dataloading", onMainSourceData);
      map.off("sourcedata", onMainSourceData);
      map.off("zoomstart", paintBackdrop);
      map.off("zoomend", paintBackdrop);
      contourOverlay.destroy();
      removeLayerAndSource(map, id);
      removeLayerAndSource(map, backdropId);
    },
  };
}
