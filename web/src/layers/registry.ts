import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { arrayDoc, cacheByIndex, decode, readArray, readMask } from "../data";
import { gradientLegend } from "../legend";
import { lut, paintColormap } from "../render/colormap";
import { sampleTable } from "../render/mercator";
import { latestOnly, stepAt } from "../timeline";
import type { LayerContext, LayerView } from "../types";
import { createTerrainView } from "./terrain";

const CACHED_STEPS = 24;
const SERIES_OPACITY = 0.8;

function createSeriesView({ map, store, layer, beforeId, report }: LayerContext): LayerView {
  const id = `${layer.id}-series`;
  const { colormap = "Blues", domain } = layer.style;
  const { time: timeAxis } = layer;
  if (!domain || !timeAxis) throw new Error(`Layer "${layer.id}" needs a domain and a time axis`);

  const valueDoc = arrayDoc(layer, "value");
  const colors = lut(colormap);
  let alive = true;
  let shownStep = -1; // a slow read of an older step must not overwrite the one being displayed

  addImageLayer(map, id, layer.grid.bbox, beforeId, {
    "raster-opacity": 0,
    "raster-resampling": "nearest",
  });

  const sampledGrid = (async () => {
    const mask = await readMask(await store, layer);

    return sampleTable(layer.grid, mask, maxTextureSize(map));
  })();

  const readStep = cacheByIndex(CACHED_STEPS, async (step) => {
    const raw = await readArray(await store, valueDoc.path, [step, null, null]);
    return decode(raw, valueDoc);
  });

  const hideImage = () => map.setPaintProperty(id, "raster-opacity", 0);

  const drawStep = async (step: number) => {
    try {
      const [values, table] = await Promise.all([readStep(step), sampledGrid]);
      if (!alive || step !== shownStep) return;

      const rgba = paintColormap(values, table, colors, domain);
      setImage(map, id, new ImageData(rgba, table.width, table.height));
      map.setPaintProperty(id, "raster-opacity", SERIES_OPACITY);

      const nextStep = step + 1;
      if (nextStep < timeAxis.values.length) readStep(nextStep).catch(() => {});
    } catch (error) {
      // An error for a step the user has already left is no longer relevant.
      if (!alive || step !== shownStep) return;

      // The image on the map still belongs to an earlier step and must not pass for this one.
      hideImage();
      report(error);
    }
  };

  const drawLatestStep = latestOnly(drawStep);

  return {
    parts: [{ id, label: layer.title, layerIds: [id] }],
    options: [
      {
        label: `Smooth ${layer.title.toLowerCase()}`,
        set: (on) => map.setPaintProperty(id, "raster-resampling", on ? "linear" : "nearest"),
      },
    ],
    time: timeAxis,
    ready: sampledGrid.then(() => {}),
    setTime(time) {
      shownStep = stepAt(timeAxis.values, time);
      if (shownStep < 0) hideImage();
      else drawLatestStep(shownStep);
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
