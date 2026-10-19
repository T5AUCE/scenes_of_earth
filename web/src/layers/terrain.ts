import { removeLayerAndSource } from "../map";
import type { LayerContext, LayerControl, LayerView, TerrainStats } from "../types";
import { ContourOverlay, sharedDemSource, terrainTileBounds } from "./contour-overlay";
import { RELIEF_STRENGTH, reliefPaint } from "./relief";

/** Terrain shading from Mapterhorn tiles and contour lines for one terrain layer. */
export function createTerrainView(context: LayerContext): LayerView {
  const { map, layer, beforeId, report } = context;
  const { tiles, stats } = layer;
  if (!tiles || !stats) throw new Error("Terrain needs tile metadata and summary statistics");

  const dem = sharedDemSource(tiles);
  const id = `${layer.id}-relief`;

  map.addSource(id, {
    type: "raster-dem",
    tiles: [dem.sharedDemProtocolUrl],
    encoding: tiles.encoding,
    tileSize: tiles.tile_size,
    maxzoom: tiles.maxzoom,
    attribution: tiles.source.attribution,
    ...terrainTileBounds(layer.grid.bbox),
  });
  map.addLayer(
    { id, type: "hillshade", source: id, paint: reliefPaint(RELIEF_STRENGTH.initial) },
    beforeId,
  );

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
      const exaggeration = reliefPaint(value)["hillshade-exaggeration"];
      map.setPaintProperty(id, "hillshade-exaggeration", exaggeration);
    },
  };

  const contourOverlay = new ContourOverlay(context, dem, tiles, stats as TerrainStats);

  return {
    parts: [
      { id, label: "Relief", layerIds: [id], controls: [strength] },
      contourOverlay.part,
    ],
    options: [],
    time: null,
    setTime: () => {},
    legend: () => null,
    destroy: () => {
      map.off("error", reportTilesUnavailable);
      contourOverlay.destroy();
      removeLayerAndSource(map, id);
    },
  };
}
