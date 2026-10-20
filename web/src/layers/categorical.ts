import { arrayDoc, decode, readArray } from "../data";
import { defaultPalette as layerDefaultPalette } from "../display-state";
import { classLegend } from "../legend";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { paintClasses, paintClassIds } from "../render/colormap";
import { sampleTable } from "../render/mercator";
import { CLASS_PALETTE_OPTIONS, classColors, classPalette } from "../render/palettes";
import { cellClassIds, smoothClassIds } from "../render/smooth-classes";
import type { ClassRaster } from "../render/smooth-classes";
import type { LayerContext, LayerMenu, LayerView } from "../types";

const CATEGORICAL_OPACITY = 0.8;
const SMOOTH_NOTE = "Edges smoothed for display; classes are per cell.";

/** Render a static class layer, with a legend of the classes present in the area. */
export function createCategoricalView(
  { map, store, layer, shift, beforeId, display }: LayerContext,
): LayerView {
  const id = `${layer.id}-classes`;
  const { classes } = layer.style;
  if (!classes) throw new Error(`Layer "${layer.id}" needs classes`);

  const valueArray = arrayDoc(layer, "value");
  const defaultPalette = layerDefaultPalette(layer);
  const legendBox = document.createElement("div");
  const classValues = classes.map(({ value }) => value);
  let palette = display?.palette ?? defaultPalette;
  let colors = classColors(classes, palette);
  let smooth = true;
  let values: Float32Array | null = null;
  let smoothRaster: ClassRaster | null = null;
  let alive = true;

  addImageLayer(map, id, layer.grid.bbox, shift, beforeId, {
    "raster-opacity": CATEGORICAL_OPACITY,
    "raster-resampling": "nearest",
  });

  const textureSize = maxTextureSize(map);
  const table = sampleTable(layer.grid, textureSize);

  // The smoothed raster is built once because only the colours change between repaints.
  const smoothedRaster = (cellValues: Float32Array) => {
    smoothRaster ??= smoothClassIds(
      cellClassIds(cellValues, classValues),
      layer.grid,
      table,
      textureSize,
    );
    return smoothRaster;
  };

  const repaint = () => {
    if (!values) return;

    if (smooth) {
      const { ids, width, height } = smoothedRaster(values);
      const rgba = paintClassIds(ids, classValues.map((value) => colors.get(value) ?? [0, 0, 0]));
      setImage(map, id, new ImageData(rgba, width, height));
    } else {
      const rgba = paintClasses(values, table, colors);
      setImage(map, id, new ImageData(rgba, table.width, table.height));
    }
    legendBox.replaceChildren(classLegend(classes, new Set(values), colors));
  };

  const menu: LayerMenu = {
    title: layer.title,
    heading: "Colours",
    blocks: true,
    palettes: CLASS_PALETTE_OPTIONS.map(({ name, label }) => ({
      name,
      label,
      colors: classes.map(({ value, color }) => classPalette(name)?.[value] ?? color),
    })),
    defaultPalette,
    custom: false,
    get palette() {
      return palette;
    },
    setPalette(name) {
      palette = name;
      colors = classColors(classes, palette);
      repaint();
    },
  };

  const ready = (async () => {
    const raw = await readArray(await store, valueArray.path, [null, null]);
    if (!alive) return;

    values = decode(raw, valueArray);
    repaint();
  })();

  return {
    parts: [{ id: layer.id, label: layer.title, layerIds: [id] }],
    options: [
      {
        label: "Smooth",
        note: SMOOTH_NOTE,
        initial: true,
        set: (on) => {
          smooth = on;
          repaint();
        },
      },
    ],
    menu,
    time: null,
    ready,
    setTime: () => {},
    legend: () => legendBox,
    destroy() {
      alive = false;
      removeLayerAndSource(map, id);
    },
  };
}
