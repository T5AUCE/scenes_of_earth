import { addImageLayer, removeLayerAndSource, setImage } from "../map";
import { arrayDoc, cacheByIndex, decode, readArray, readMask } from "../data";
import { gradientLegend } from "../legend";
import { lut, paintColormap } from "../render/colormap";
import { sampleTable } from "../render/mercator";
import { stepAt } from "../timeline";
import type { LayerContext, LayerView } from "../types";
import { createTerrainView } from "./terrain";

const CACHED_STEPS = 24;
const SERIES_OPACITY = 0.8;

function createSeriesView({ map, store, layer, beforeId, report }: LayerContext): LayerView {
  const id = `${layer.id}-series`;
  const { colormap = "Blues", domain } = layer.style;
  const { time } = layer;
  if (!domain || !time) throw new Error(`Layer "${layer.id}" needs a domain and a time axis`);

  const valueDoc = arrayDoc(layer, "value");
  const times = time.values;
  const colors = lut(colormap);
  let alive = true;
  let shown = -1; // index being displayed; a slow read of an older step must not overwrite it
  addImageLayer(map, id, layer.grid.bbox, beforeId, {
    "raster-opacity": 0,
    "raster-resampling": "nearest",
  });

  const table = (async () => sampleTable(layer.grid, await readMask(await store, layer)))();
  const readStep = cacheByIndex(CACHED_STEPS, async (index) =>
    decode(await readArray(await store, valueDoc.path, [index, null, null]), valueDoc),
  );

  const show = async (index: number) => {
    const [values, sampled] = await Promise.all([readStep(index), table]);
    if (!alive || index !== shown) return;

    const rgba = paintColormap(values, sampled, colors, domain);
    setImage(map, id, new ImageData(rgba, sampled.width, sampled.height));
    if (index + 1 < times.length) readStep(index + 1).catch(() => {});
  };

  return {
    parts: [{ id, label: layer.title, layerIds: [id] }],
    options: [
      {
        label: `Smooth ${layer.title.toLowerCase()}`,
        set: (on) => map.setPaintProperty(id, "raster-resampling", on ? "linear" : "nearest"),
      },
    ],
    time,
    ready: table.then(() => {}),
    setTime(t) {
      shown = stepAt(times, t);
      map.setPaintProperty(id, "raster-opacity", shown < 0 ? 0 : SERIES_OPACITY);
      if (shown >= 0) show(shown).catch(report);
    },
    legend: () => gradientLegend(colors, domain, layer.units),
    destroy() {
      alive = false;
      removeLayerAndSource(map, id);
    },
  };
}

// Later stack numbers draw on top of earlier ones.
export const LAYER_KINDS = new Map([
  ["series-colormap", { stack: 1, create: createSeriesView }],
  ["terrain", { stack: 2, create: createTerrainView }],
]);
