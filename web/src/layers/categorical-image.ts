import type { Map as MapLibreMap } from "maplibre-gl";

import { addImageLayer, maxTextureSize, setImage } from "../map";
import { paintClassIds } from "../render/colormap";
import { sampleTable } from "../render/mercator";
import { smoothClassIds } from "../render/smooth-classes";
import type { ClassRaster } from "../render/smooth-classes";
import type { Bbox } from "../types";

/** Where and how the image painter draws one class layer. */
export interface ImagePainterOptions {
  map: MapLibreMap;
  id: string;
  grid: { bbox: Bbox; nx: number; ny: number };
  shift: number;
  beforeId: string | undefined;
  opacity: number;
}

/**
 * Draw a CPU image when GPU class fields are unavailable.
 * The fallback retains bilinear class selection at a fixed image resolution.
 */
export function createImagePainter(
  { map, id, grid, shift, beforeId, opacity }: ImagePainterOptions,
) {
  addImageLayer(map, id, grid.bbox, shift, beforeId, {
    "raster-opacity": opacity,
    "raster-resampling": "nearest",
  });

  const textureSize = maxTextureSize(map);
  const table = sampleTable(grid, textureSize);
  let smoothedIds: Uint8Array | null = null;
  let smoothRaster: ClassRaster | null = null;

  // The smoothed raster is built once because only the colours change between repaints.
  const smoothedRaster = (ids: Uint8Array) => {
    if (smoothedIds !== ids) {
      smoothRaster = smoothClassIds(ids, grid, table, textureSize);
      smoothedIds = ids;
    }
    return smoothRaster!;
  };

  return {
    /** Paint the one-based class ids with colors[id - 1]. */
    paint(ids: Uint8Array, colors: number[][], smooth: boolean) {
      if (smooth) {
        const { ids: pixels, width, height } = smoothedRaster(ids);
        setImage(map, id, new ImageData(paintClassIds(pixels, colors), width, height));
        return;
      }

      const pixels = Uint8Array.from(table.src, (cell) => ids[cell]);
      setImage(map, id, new ImageData(paintClassIds(pixels, colors), table.width, table.height));
    },
  };
}
