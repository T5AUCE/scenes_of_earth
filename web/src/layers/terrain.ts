import { arrayDoc, decode, readArray, readMask } from "../data";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { paintHillshade } from "../render/colormap";
import { sampleTable } from "../render/mercator";
import type { LayerContext, LayerView } from "../types";
import { ContourOverlay } from "./contour-overlay";

const HILLSHADE_OPACITY = 0.7;

/** Hillshade image and contour lines for one terrain layer. */
export function createTerrainView(context: LayerContext): LayerView {
  const { map, store, layer, shift, beforeId } = context;
  const id = `${layer.id}-hillshade`;
  let alive = true;

  addImageLayer(map, id, layer.grid.bbox, shift, beforeId, {
    "raster-opacity": HILLSHADE_OPACITY,
    "raster-resampling": "linear",
  });

  const maskRead = store.then((openedStore) => readMask(openedStore, layer));
  const contourOverlay = new ContourOverlay(context, maskRead);

  const drawHillshade = async () => {
    const openedStore = await store;
    const shadeDoc = arrayDoc(layer, "hillshade");
    const raw = await readArray(openedStore, shadeDoc.path, [null, null]);
    if (!alive) return;

    const table = sampleTable(layer.grid, maxTextureSize(map));
    const rgba = paintHillshade(decode(raw, shadeDoc), table);
    setImage(map, id, new ImageData(rgba, table.width, table.height));
  };

  return {
    parts: [
      { id, label: layer.title, layerIds: [id] },
      contourOverlay.part,
    ],
    options: [],
    time: null,
    ready: drawHillshade(),
    setTime: () => {},
    legend: () => contourOverlay.legend,
    destroy: () => {
      alive = false;
      contourOverlay.destroy();
      removeLayerAndSource(map, id);
    },
  };
}
