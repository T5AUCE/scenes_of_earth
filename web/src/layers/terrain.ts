import { arrayDoc, readArray, readMask } from "../data";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { paintHillshade } from "../render/colormap";
import { sampleTable } from "../render/mercator";
import type { LayerContext, LayerView } from "../types";

const HILLSHADE_OPACITY = 0.7;

export function createTerrainView({ map, store, layer, beforeId }: LayerContext): LayerView {
  const id = `${layer.id}-hillshade`;
  let alive = true;

  addImageLayer(map, id, layer.grid.bbox, beforeId, {
    "raster-opacity": HILLSHADE_OPACITY,
    "raster-resampling": "linear",
  });

  const drawHillshade = async () => {
    const openedStore = await store;
    const [mask, shade] = await Promise.all([
      readMask(openedStore, layer),
      readArray(openedStore, arrayDoc(layer, "hillshade").path, [null, null]),
    ]);
    if (!alive) return;

    const table = sampleTable(layer.grid, mask, maxTextureSize(map));
    const rgba = paintHillshade(shade, table);
    setImage(map, id, new ImageData(rgba, table.width, table.height));
  };

  return {
    parts: [{ id, label: layer.title, layerIds: [id] }],
    options: [],
    time: null,
    ready: drawHillshade(),
    setTime: () => {},
    legend: () => null,
    destroy: () => {
      alive = false;
      removeLayerAndSource(map, id);
    },
  };
}
