import { readMask } from "../data";
import { removeLayerAndSource } from "../map";
import type { Bbox, LayerContext, LayerControl, LayerView } from "../types";
import { ContourOverlay } from "./contour-overlay";
import { RELIEF_STRENGTH, reliefPaint } from "./relief";

// The hosted endpoint stays here until the bundle contract can name the tiles.
const TERRAIN_TILES_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const TILES_ATTRIBUTION = "<a href='https://mapterhorn.com/attribution'>© Mapterhorn</a>";
const TILE_SIZE_PX = 512;
const TILES_MAX_ZOOM = 11;
const ANTIMERIDIAN_DEG = 180;

/** Terrain shading from Mapterhorn tiles and contour lines for one terrain layer. */
export function createTerrainView(context: LayerContext): LayerView {
  const { map, store, layer, beforeId, report } = context;
  const id = `${layer.id}-relief`;

  map.addSource(id, {
    type: "raster-dem",
    tiles: [TERRAIN_TILES_URL],
    encoding: "terrarium",
    tileSize: TILE_SIZE_PX,
    maxzoom: TILES_MAX_ZOOM,
    attribution: TILES_ATTRIBUTION,
    ...tileBounds(layer.grid.bbox),
  });
  map.addLayer(
    { id, type: "hillshade", source: id, paint: reliefPaint(RELIEF_STRENGTH.initial) },
    beforeId,
  );

  const reportTilesUnavailable = (event: object) => {
    if ((event as { sourceId?: string }).sourceId !== id) return;

    map.off("error", reportTilesUnavailable);
    report(new Error("Terrain shading tiles could not be loaded"));
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
      map.setPaintProperty(id, "hillshade-exaggeration", reliefPaint(value)["hillshade-exaggeration"]);
    },
  };

  const maskRead = store.then((openedStore) => readMask(openedStore, layer));
  const contourOverlay = new ContourOverlay(context, maskRead);

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

// Source bounds use the -180 to 180 frame, so an area east of 180 must load tiles without them.
function tileBounds(bbox: Bbox) {
  const [, , east] = bbox;
  return east <= ANTIMERIDIAN_DEG ? { bounds: bbox } : {};
}
