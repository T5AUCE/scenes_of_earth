import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import {
  COARSE_JOB,
  covers,
  factorFor,
  viewInGridWorld,
  viewWindow,
  windowBounds,
  type GridWindow,
} from "../contours";
import type { ContourRequest, ContourResult } from "../contours.worker";
import { arrayDoc, decode, readArray, readMask } from "../data";
import { makeHtmlElement } from "../html";
import { contourLegendText } from "../legend";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { paintHillshade } from "../render/colormap";
import { sampleTable, worldShift } from "../render/mercator";
import type { Bbox, LayerContext, LayerDoc, LayerView, Part } from "../types";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const HILLSHADE_OPACITY = 0.7;
const CONTOUR_COLOR = "#5b4636";
const CONTOUR_OPACITY = 0.55;
const MINOR_LINE_WIDTH_PX = 0.5;
const MAJOR_LINE_WIDTH_PX = 1.1;
const DETAIL_DEBOUNCE_MS = 200;
const DETAIL_MARGIN = 0.5;

export function createTerrainView(context: LayerContext): LayerView {
  const { map, store, layer, beforeId } = context;
  const id = `${layer.id}-hillshade`;
  let alive = true;

  addImageLayer(map, id, layer.grid.bbox, beforeId, {
    "raster-opacity": HILLSHADE_OPACITY,
    "raster-resampling": "linear",
  });

  const maskRead = store.then((openedStore) => readMask(openedStore, layer));
  const contourOverlay = new ContourOverlay(context, maskRead);

  const drawHillshade = async () => {
    const openedStore = await store;
    const shade = await readArray(openedStore, arrayDoc(layer, "hillshade").path, [null, null]);
    if (!alive) return;

    const table = sampleTable(layer.grid, maxTextureSize(map));
    const rgba = paintHillshade(shade, table);
    setImage(map, id, new ImageData(rgba, table.width, table.height));
  };

  return {
    parts: [{ id, label: layer.title, layerIds: [id] }, contourOverlay.part],
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

interface DetailWindow {
  job: number;
  factor: number;
  bounds: Bbox;
  sourceWindow: GridWindow;
}

// Whole-area contours come first; zoomed in, a worker redraws the visible window at a finer factor.
class ContourOverlay {
  readonly legend = makeHtmlElement("div");
  readonly part: Part;
  private readonly map: MapLibreMap;
  private readonly layer: LayerDoc;
  private readonly coarseId: string;
  private readonly detailId: string;
  private readonly grid: ReturnType<typeof shiftedGrid>;
  private readonly coarseFactor: number;
  private readonly report: (error: unknown) => void;
  private alive = true;
  private isOn = true;
  private worker: Worker | null = null;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private inFlight: DetailWindow | null = null;
  private isRequestPending = false;
  private shown: DetailWindow | null = null;
  private lastJob = COARSE_JOB;

  constructor(
    { map, store, layer, beforeId, report }: LayerContext,
    maskRead: Promise<ArrayLike<number>>,
  ) {
    this.map = map;
    this.layer = layer;
    this.report = report;
    this.coarseId = `${layer.id}-contours`;
    this.detailId = `${layer.id}-contours-detail`;
    this.grid = shiftedGrid(layer);
    this.coarseFactor = factorFor(this.grid.nx, this.grid.ny);
    this.legend.hidden = true;

    this.part = {
      id: this.coarseId,
      label: "Contours",
      layerIds: [this.coarseId, this.detailId],
      onToggle: (visible) => {
        this.isOn = visible;
        this.updateVisibility();
      },
    };

    addContourLayer(map, this.coarseId, beforeId);
    addContourLayer(map, this.detailId, beforeId);
    setVisible(map, this.detailId, false);

    this.start(store, maskRead).catch((error) => this.alive && report(error));
  }

  destroy() {
    this.alive = false;
    clearTimeout(this.debounce);
    this.map.off("move", this.updateVisibility);
    this.map.off("moveend", this.scheduleDetail);
    this.worker?.terminate();
    removeLayerAndSource(this.map, this.detailId);
    removeLayerAndSource(this.map, this.coarseId);
  }

  private async start(store: LayerContext["store"], maskRead: Promise<ArrayLike<number>>) {
    const elevationDoc = arrayDoc(this.layer, "elevation");
    const openedStore = await store;
    const [mask, raw] = await Promise.all([
      maskRead,
      readArray(openedStore, elevationDoc.path, [null, null]),
    ]);
    if (!this.alive) return;

    const worker = new Worker(new URL("../contours.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<ContourResult>) => this.receive(event.data);
    worker.onerror = (event) => this.fail(event);
    this.worker = worker;

    // The worker keeps the elevation, so later windows need no new read.
    post(worker, { kind: "start", elevation: decode(raw, elevationDoc), mask, grid: this.grid });
  }

  private receive({ job, interval, collection }: ContourResult) {
    if (!this.alive) return;

    if (job === COARSE_JOB) {
      this.showCoarse(interval, collection);
    } else if (job === this.inFlight?.job) {
      setCollection(this.map, this.detailId, collection);
      this.shown = this.inFlight;
      this.inFlight = null;
    }

    this.updateVisibility();

    if (this.isRequestPending && !this.inFlight) {
      this.isRequestPending = false;
      this.requestDetail();
    }
  }

  private showCoarse(interval: number, collection: ContourResult["collection"]) {
    setCollection(this.map, this.coarseId, collection);
    this.legend.textContent = contourLegendText(interval, this.layer.units);
    this.map.on("move", this.updateVisibility);
    this.map.on("moveend", this.scheduleDetail);
    this.scheduleDetail();
  }

  private fail(event: ErrorEvent) {
    this.worker?.terminate();
    this.worker = null;
    this.inFlight = null;
    this.isRequestPending = false;
    this.report(new Error(event.message || "Contour worker failed"));
  }

  private readonly scheduleDetail = () => {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.requestDetail(), DETAIL_DEBOUNCE_MS);
  };

  // At most one window is computed at a time; the latest view is requested when it finishes.
  private requestDetail() {
    const target = viewWindow(this.grid, this.viewport(), DETAIL_MARGIN);
    if (!this.alive || !this.worker || !target || target.factor >= this.coarseFactor) return;

    const isCurrent = this.shown && this.showsDetail() && this.shown.factor <= target.factor;
    if (isCurrent) return;

    if (this.inFlight) {
      this.isRequestPending = true;

      return;
    }

    this.lastJob++;

    this.inFlight = {
      job: this.lastJob,
      factor: target.factor,
      bounds: windowBounds(this.grid, target.sourceWindow),
      sourceWindow: target.sourceWindow,
    };

    post(this.worker, { kind: "detail", job: this.lastJob, sourceWindow: target.sourceWindow });
  }

  private readonly updateVisibility = () => {
    const detailVisible = this.isOn && this.showsDetail();

    setVisible(this.map, this.coarseId, this.isOn && !detailVisible);
    setVisible(this.map, this.detailId, detailVisible);
    this.legend.hidden = !this.isOn || !this.legend.textContent;
  };

  private showsDetail() {
    return this.shown !== null && covers(this.shown.bounds, this.viewport(), this.grid.bbox);
  }

  private viewport(): Bbox {
    const bounds = this.map.getBounds();
    const view: Bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];

    return viewInGridWorld(view, this.grid.bbox);
  }
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

function setCollection(map: MapLibreMap, id: string, collection: ContourResult["collection"]) {
  (map.getSource(id) as GeoJSONSource).setData(collection as unknown as GeoJsonData);
}

function setVisible(map: MapLibreMap, id: string, visible: boolean) {
  map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}

function post(worker: Worker, request: ContourRequest) {
  const transfer = request.kind === "start" ? [request.elevation.buffer] : [];
  worker.postMessage(request, transfer);
}

// Lines are drawn in the same world copy as the hillshade image.
function shiftedGrid({ grid }: LayerDoc) {
  const shift = worldShift(grid.bbox);
  const [west, south, east, north] = grid.bbox;
  const bbox: Bbox = [west + shift, south, east + shift, north];

  return { ...grid, bbox };
}
