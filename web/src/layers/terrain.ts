import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { ContourRequest, ContourResult } from "../contours.worker";
import { arrayDoc, decode, readArray, readMask } from "../data";
import { makeHtmlElement } from "../html";
import { contourLegendText } from "../legend";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { paintHillshade } from "../render/colormap";
import { sampleTable, worldShift } from "../render/mercator";
import type { Bbox, LayerContext, LayerDoc, LayerView } from "../types";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const HILLSHADE_OPACITY = 0.7;
const CONTOUR_COLOR = "#5b4636";
const CONTOUR_OPACITY = 0.55;
const MINOR_LINE_WIDTH_PX = 0.5;
const MAJOR_LINE_WIDTH_PX = 1.1;

export function createTerrainView(context: LayerContext): LayerView {
  const { map, store, layer, beforeId, report } = context;
  const id = `${layer.id}-hillshade`;
  const contourId = `${layer.id}-contours`;
  const contourLegend = makeHtmlElement("div");
  let alive = true;
  let worker: Worker | null = null;

  addImageLayer(map, id, layer.grid.bbox, beforeId, {
    "raster-opacity": HILLSHADE_OPACITY,
    "raster-resampling": "linear",
  });

  addContourLayer(map, contourId, beforeId);

  const maskRead = store.then((openedStore) => readMask(openedStore, layer));

  const drawHillshade = async () => {
    const openedStore = await store;
    const [mask, shade] = await Promise.all([
      maskRead,
      readArray(openedStore, arrayDoc(layer, "hillshade").path, [null, null]),
    ]);
    if (!alive) return;

    const table = sampleTable(layer.grid, mask, maxTextureSize(map));
    const rgba = paintHillshade(shade, table);
    setImage(map, id, new ImageData(rgba, table.width, table.height));
  };

  const drawContours = async () => {
    const openedStore = await store;
    const elevationDoc = arrayDoc(layer, "elevation");
    const [mask, raw] = await Promise.all([
      maskRead,
      readArray(openedStore, elevationDoc.path, [null, null]),
    ]);
    if (!alive) return;

    worker = new Worker(new URL("../contours.worker.ts", import.meta.url), { type: "module" });
    let result: ContourResult;

    try {
      result = await runContourWorker(worker, {
        elevation: decode(raw, elevationDoc),
        mask,
        grid: shiftedGrid(layer),
      });
    } finally {
      worker.terminate();
      worker = null;
    }

    if (!alive) return;

    const { interval, collection } = result;

    contourLegend.textContent = contourLegendText(interval, layer.units);
    (map.getSource(contourId) as GeoJSONSource).setData(collection as unknown as GeoJsonData);
  };

  drawContours().catch((error) => alive && report(error));

  return {
    parts: [
      { id, label: layer.title, layerIds: [id] },
      {
        id: contourId,
        label: "Contours",
        layerIds: [contourId],
        onToggle: (visible) => {
          contourLegend.hidden = !visible;
        },
      },
    ],
    options: [],
    time: null,
    ready: drawHillshade(),
    setTime: () => {},
    legend: () => contourLegend,
    destroy: () => {
      alive = false;
      worker?.terminate();
      removeLayerAndSource(map, contourId);
      removeLayerAndSource(map, id);
    },
  };
}

function addContourLayer(map: MapLibreMap, id: string, beforeId: string | undefined) {
  map.addSource(id, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer(
    {
      id,
      type: "line",
      source: id,
      paint: {
        "line-color": CONTOUR_COLOR,
        "line-opacity": CONTOUR_OPACITY,
        "line-width": ["case", ["get", "major"], MAJOR_LINE_WIDTH_PX, MINOR_LINE_WIDTH_PX],
      },
    },
    beforeId,
  );
}

// Lines are drawn in the same world copy as the hillshade image.
function shiftedGrid({ grid }: LayerDoc) {
  const shift = worldShift(grid.bbox);
  const [west, south, east, north] = grid.bbox;
  const bbox: Bbox = [west + shift, south, east + shift, north];

  return { ...grid, bbox };
}

function runContourWorker(worker: Worker, request: ContourRequest) {
  return new Promise<ContourResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<ContourResult>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || "Contour worker failed"));
    worker.postMessage(request, [request.elevation.buffer]);
  });
}
