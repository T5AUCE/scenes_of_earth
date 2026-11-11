/** Draw categorical classes with GPU borders and a CPU image fallback. */
import {
  arrayDoc,
  decodeInSlices,
  isCancel,
  readArray,
  readMask,
  yieldToBrowser,
  type Store,
} from "../data";
import {
  DEFAULT_EDGES,
  defaultPalette,
  GEOLOGY_SMOOTH_RADIUS_CELLS,
  isGeologyLayer,
  loadStoredEdges,
  loadStoredSmoothing,
  MAX_ROUNDING,
  MAX_SMOOTH_RADIUS_CELLS,
  MAX_SOFTNESS_CELLS,
  storeEdges,
  storeSmoothing,
} from "../display-state";
import { createClassFieldLayer } from "../gpu/class-field-layer";
import { CLASS_HATCH_ID } from "../gpu/class-field-shaders";
import { layerPosition, type LayerPosition } from "../gpu/tiled-layer";
import { classLegend, classNoDataLegend } from "../legend";
import { removeLayerAndSource, warmHiddenRaster } from "../map";
import { classColors, classPaletteOptions, rgbToHex } from "../render/palettes";
import { cellClassIdsInSlices } from "../render/smooth-classes";
import type {
  EdgeSettings,
  EdgesMenu,
  LayerContext,
  LayerControl,
  LayerMenu,
  LayerView,
} from "../types";
import type { Draw } from "./allocate";
import { createImagePainter } from "./categorical-image";

const CATEGORICAL_OPACITY = 0.8;
const ROUNDING_STEP = 0.05;
const SOFTNESS_STEP_CELLS = 0.05;
const SMOOTHING_STEP_CELLS = 0.05;
const IMAGE_EDGES_NOTE = "Edge options need WebGL drawing.";

const METERS_PER_DEGREE = 111_320;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const COASTAL_FILL_M = 2000;
const MIN_FILL_RADIUS_CELLS = 1;

// Entry slices stay well under a frame while the previous pixels stay responsive.
const ENTRY_CHECK_CELLS = 4096;
const ENTRY_BUDGET_MS = 4;

/** Draw static classes with GPU edges, retaining the image painter as an automatic fallback. */
export function createCategoricalView(context: LayerContext): LayerView {
  return new CategoricalView(context);
}

class CategoricalView implements LayerView {
  readonly time = null;
  readonly parts;
  readonly options;
  readonly menu: LayerMenu;
  readonly ready: Promise<void>;

  private readonly id: string;
  private readonly classes;
  private readonly classValues;
  private readonly legendBox = document.createElement("div");
  private readonly menuUpdates = new EventTarget();
  private readonly gpu;
  private readonly edgeMenu: EdgesMenu;
  private image: ReturnType<typeof createImagePainter> | null = null;
  private ids: Uint8Array | null = null;
  private present = new Set<number>();
  private hasHatched = false;
  private readonly expandedGroups = new Set<string>();
  private palette: string;
  private colors;
  private smooth = true;
  private edges: EdgeSettings;
  private smoothing: number;
  private alive = true;
  private readonly context: LayerContext;
  private restorePosition: LayerPosition | null = null;
  private readonly loadAbort = new AbortController();

  constructor(context: LayerContext) {
    this.context = context;
    const { layer } = context;
    this.id = `${layer.id}-classes`;
    const classes = layer.style.classes;
    if (!classes) throw new Error(`Layer "${layer.id}" needs classes`);

    this.classes = classes;
    this.classValues = this.classes.map(({ value }) => value);
    this.palette = context.display?.palette ?? defaultPalette(layer);
    this.colors = classColors(layer.id, this.classes, this.palette);
    this.edges = loadStoredEdges(layer.id);
    this.smoothing = loadStoredSmoothing(layer.id);
    this.gpu = createClassFieldLayer({
      id: this.id,
      grid: layer.grid,
      shift: context.shift,
      opacity: CATEGORICAL_OPACITY,
      edges: { smooth: this.smooth, ...this.edges, smoothRadiusCells: this.smoothing },
      onFail: () => this.useImage(),
    });
    this.edgeMenu = this.createEdgesMenu();
    this.menu = this.createMenu();
    this.parts = [{ id: layer.id, label: layer.title, layerIds: [this.id] }];
    this.options = [
      {
        label: "Smooth",
        initial: true,
        set: (on: boolean) => {
          this.smooth = on;
          if (this.image) this.repaint();
          else this.gpu.setEdges({ smooth: on, ...this.edges, smoothRadiusCells: this.smoothing });
        },
      },
    ];
    this.mount();
    this.ready = this.load();
  }

  private createEdgesMenu(): EdgesMenu {
    const view = this;
    const layerId = this.context.layer.id;
    // Geology smooths widely and keeps the default rounding internally, so its menu hides it.
    const controls: LayerControl[] = isGeologyLayer(layerId) ? [] : [
      {
        label: "Smoothing",
        min: 0,
        max: MAX_ROUNDING,
        step: ROUNDING_STEP,
        get value() {
          return view.edges.rounding;
        },
        set: (rounding: number) => this.setEdges({ ...this.edges, rounding }),
      },
    ];
    controls.push({
      label: "Softness",
      unit: "cells",
      min: 0,
      max: MAX_SOFTNESS_CELLS,
      step: SOFTNESS_STEP_CELLS,
      get value() {
        return view.edges.softnessCells;
      },
      set: (softnessCells: number) => this.setEdges({ ...this.edges, softnessCells }),
    });
    if (isGeologyLayer(layerId)) {
      controls.push({
        label: "Smoothing",
        unit: "cells",
        min: 0,
        max: MAX_SMOOTH_RADIUS_CELLS,
        step: SMOOTHING_STEP_CELLS,
        get value() {
          return view.smoothing;
        },
        set: (smoothRadiusCells: number) => this.setSmoothing(smoothRadiusCells),
      });
    }

    return {
      controls,
      outline: {
        get value() {
          return view.edges.outline;
        },
        set: (outline: boolean) => this.setEdges({ ...this.edges, outline }),
      },
      get isDefault() {
        return view.edges.rounding === DEFAULT_EDGES.rounding
          && view.edges.softnessCells === DEFAULT_EDGES.softnessCells
          && view.edges.outline === DEFAULT_EDGES.outline
          && view.smoothing === defaultSmoothing(layerId);
      },
      reset: () => {
        this.setEdges({ ...DEFAULT_EDGES });
        this.setSmoothing(defaultSmoothing(layerId));
      },
    };
  }

  private setEdges(edges: EdgeSettings) {
    this.edges = edges;
    storeEdges(this.context.layer.id, edges);
    this.gpu.setEdges({ smooth: this.smooth, ...edges, smoothRadiusCells: this.smoothing });
  }

  private setSmoothing(smoothRadiusCells: number) {
    this.smoothing = smoothRadiusCells;
    storeSmoothing(this.context.layer.id, smoothRadiusCells);
    this.gpu.setEdges({ smooth: this.smooth, ...this.edges, smoothRadiusCells });
  }

  private createMenu(): LayerMenu {
    const view = this;
    const layerId = this.context.layer.id;

    return {
      title: this.context.layer.title,
      heading: "Colours",
      blocks: true,
      palettes: classPaletteOptions(layerId).map(({ name, label }) => {
        const shades = classColors(layerId, this.classes, name);
        return {
          name,
          label,
          colors: this.classes.map(({ value }) => rgbToHex(shades.get(value)!)),
        };
      }),
      defaultPalette: defaultPalette(this.context.layer),
      custom: false,
      updates: this.menuUpdates,
      get palette() {
        return view.palette;
      },
      setPalette: (name) => {
        this.palette = name;
        this.colors = classColors(layerId, this.classes, name);
        this.repaint();
      },
      get edges() {
        return view.image ? undefined : view.edgeMenu;
      },
      get edgesNote() {
        return view.image ? IMAGE_EDGES_NOTE : undefined;
      },
    };
  }

  private mount() {
    const { map, slots } = this.context;
    if (gpuDisabled() || map.getProjection()?.type === "globe") {
      this.useImage();
      return;
    }

    const canvas = map.getCanvas();
    // Capture removes the custom layer before MapLibre serializes and destroys the lost style.
    canvas.addEventListener("webglcontextlost", this.onContextLost, true);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    map.addLayer(this.gpu.layer, slots.fill);
    document.body.dataset.landcoverRenderer = "gpu";
    this.repaint();
  }

  private readonly onContextLost = () => {
    const { map } = this.context;
    if (this.image || !map.getLayer(this.id)) return;

    this.restorePosition = this.drawPosition();
    map.removeLayer(this.id);
  };

  private readonly onContextRestored = () => {
    if (!this.restorePosition || !this.alive) return;

    const { map } = this.context;
    if (map.isStyleLoaded()) this.restoreLayer();
    else map.once("style.load", this.restoreLayer);
  };

  private readonly restoreLayer = () => {
    if (!this.alive || !this.restorePosition) return;

    const { map } = this.context;
    const position = this.restorePosition;
    this.restorePosition = null;
    map.addLayer(this.gpu.layer, position.beforeId);
    this.applyPosition(position);
    map.triggerRepaint();
  };

  private drawPosition(): LayerPosition {
    return layerPosition(this.context.map, this.id, this.context.slots.fill);
  }

  private applyPosition({ visibility, minzoom, maxzoom }: LayerPosition) {
    const { map } = this.context;
    map.setLayoutProperty(this.id, "visibility", visibility);
    map.setLayerZoomRange(this.id, minzoom, maxzoom);
  }

  private useImage() {
    if (!this.alive || this.image) return;

    const { map, layer, shift, report } = this.context;
    const position = this.drawPosition();
    removeLayerAndSource(map, this.id);
    try {
      this.image = createImagePainter({
        map,
        id: this.id,
        grid: layer.grid,
        shift,
        beforeId: position.beforeId,
        opacity: CATEGORICAL_OPACITY,
      });
      this.applyPosition(position);
      document.body.dataset.landcoverRenderer = "image";
      this.repaint();
      this.menuUpdates.dispatchEvent(new Event("change"));
    } catch (error) {
      report(error);
    }
  }

  private setVisible(visible: boolean) {
    const visibility = visible ? "visible" : "none";
    if (this.restorePosition) {
      this.restorePosition = { ...this.restorePosition, visibility };
      return;
    }

    const { map } = this.context;
    if (!map.getLayer(this.id)) return;

    map.setLayoutProperty(this.id, "visibility", visibility);
  }

  private repaint() {
    const colors = this.classValues.map((value) => this.colors.get(value) ?? [0, 0, 0]);
    if (this.image) {
      if (this.ids) this.image.paint(unhatchIds(this.ids), colors, this.smooth);
    } else {
      this.gpu.setColors(colors);
      this.gpu.setEdges({ smooth: this.smooth, ...this.edges, smoothRadiusCells: this.smoothing });
    }
    const legend = classLegend(this.classes, this.present, this.colors, this.expandedGroups);
    if (this.hasHatched && !this.image) legend.append(classNoDataLegend());
    this.legendBox.replaceChildren(legend);
  }

  private async load() {
    const signal = this.loadAbort.signal;
    const { layer, store } = this.context;
    const valueArray = arrayDoc(layer, "value");
    const opened = await store;
    const raw = await readArray(opened, valueArray.path, [null, null]);
    if (!this.alive || signal.aborted) return;

    const values = await decodeInSlices(raw, valueArray, signal);
    if (!this.alive || signal.aborted) return;

    this.ids = await cellClassIdsInSlices(values, this.classValues, signal);
    if (!this.alive || signal.aborted) return;

    this.present = await presentInSlices(values, signal);
    if (!this.alive || signal.aborted) return;

    await this.markAndFillNoData(opened, signal);
    if (!this.alive || signal.aborted) return;

    if (!this.image) this.gpu.setIds(this.ids);
    this.repaint();
  }

  /**
   * Warm the opening ids on the map context so the flight never pays for them.
   * Playback keeps using ready, so this never changes its contract.
   */
  async prepareEntry(time: string | null, signal?: AbortSignal): Promise<void> {
    void time;
    await this.ready;
    if (!this.alive || !this.ids || signal?.aborted) return;

    const palette = this.palette;
    const smooth = this.smooth;
    if (this.image) {
      if (!this.alive || this.palette !== palette) return;

      await warmHiddenRaster(this.context.map, this.id, signal);
    } else {
      await this.gpu.prepareFlags(signal);
      if (!this.alive || signal?.aborted || this.palette !== palette || this.smooth !== smooth) {
        return;
      }

      try {
        await this.gpu.warmUp(signal);
      } catch (error) {
        if (!this.alive || signal?.aborted) return;

        this.useImage();
        if (!this.alive || !this.image) throw error;

        this.repaint();
        await warmHiddenRaster(this.context.map, this.id, signal);
        return;
      }
    }
    if (!this.alive || signal?.aborted) return;

    await nextEntryFrame(signal);
  }

  private async markAndFillNoData(store: Store, signal?: AbortSignal) {
    try {
      const mask = await readMask(store, this.context.layer);
      await markHatchedNoDataInSlices(this.ids!, mask, signal);
      if (isGeologyLayer(this.context.layer.id)) {
        const { bbox, nx, ny, res } = this.context.layer.grid;
        const meanLatitude = (bbox[1] + bbox[3]) / 2;
        this.ids = await fillCoastalGapsInSlices(
          this.ids!,
          mask,
          nx,
          ny,
          coastalFillRadiusCells(res, meanLatitude),
          cellWidthM(res, meanLatitude),
          cellHeightM(res),
          signal,
        );
      }
      this.hasHatched = this.ids!.includes(CLASS_HATCH_ID);
    } catch (error) {
      if (isCancel(error)) throw error;

      this.hasHatched = false;
    }
  }

  setTime() {}

  show(draw: Draw | null) {
    if (draw !== "colour") {
      this.setVisible(false);
      return;
    }

    this.setVisible(true);
    this.repaint();
    this.menuUpdates.dispatchEvent(new Event("change"));
  }

  legend() {
    return this.legendBox;
  }

  destroy() {
    this.alive = false;
    this.loadAbort.abort();
    const { map } = this.context;
    const canvas = map.getCanvas();
    canvas.removeEventListener("webglcontextlost", this.onContextLost, true);
    canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    map.off("style.load", this.restoreLayer);
    removeLayerAndSource(map, this.id);
    delete document.body.dataset.landcoverRenderer;
  }
}

function gpuDisabled() {
  try {
    return localStorage.getItem("soe.debug.gpu") === "off";
  } catch {
    return false;
  }
}

/** The Edge smoothing radius a layer starts with. Only geology layers smooth widely. */
function defaultSmoothing(layerId: string): number {
  return isGeologyLayer(layerId) ? GEOLOGY_SMOOTH_RADIUS_CELLS : 0;
}

/**
 * Mark hatched cells in bounded slices so entry keeps responding while filling.
 * Abandoned entries stop scheduling instead of finishing the grid.
 */
async function markHatchedNoDataInSlices(
  ids: Uint8Array,
  mask: ArrayLike<number>,
  signal?: AbortSignal,
) {
  let sliceMs = performance.now();
  for (let cell = 0; cell < ids.length; cell++) {
    if (ids[cell] === 0 && mask[cell] === 1) ids[cell] = CLASS_HATCH_ID;
    if ((cell + 1) % ENTRY_CHECK_CELLS !== 0) continue;
    if (signal?.aborted) throw cancelError();
    if (performance.now() - sliceMs < ENTRY_BUDGET_MS) continue;

    await yieldToBrowser(signal);
    sliceMs = performance.now();
  }
  if (signal?.aborted) throw cancelError();
}

/** Collect the values present in bounded slices so entry keeps responding. */
async function presentInSlices(values: Float32Array, signal?: AbortSignal): Promise<Set<number>> {
  const present = new Set<number>();
  let sliceMs = performance.now();
  for (let cell = 0; cell < values.length; cell++) {
    present.add(values[cell]);
    if ((cell + 1) % ENTRY_CHECK_CELLS !== 0) continue;
    if (signal?.aborted) throw cancelError();
    if (performance.now() - sliceMs < ENTRY_BUDGET_MS) continue;

    await yieldToBrowser(signal);
    sliceMs = performance.now();
  }
  if (signal?.aborted) throw cancelError();
  return present;
}

/** Wait a frame so the preparing note paints before heavy work continues. */
function nextEntryFrame(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelError());
  return new Promise((done, fail) => {
    const onFrame = () => {
      signal?.removeEventListener("abort", onAbort);
      done();
    };
    const onAbort = () => fail(cancelError());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(onFrame);
      return;
    }
    setTimeout(onFrame, 0);
  });
}

function cancelError(): Error {
  const error = new Error("Entry preparation was cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * The coastal fill radius in cells for about 2 km of bundle grid.
 * Two kilometres bridge the shoreline offset at both geology resolutions.
 * Coarse grids fall back to a single cell so they never stretch far inland.
 */
export function coastalFillRadiusCells(resDeg: number, meanLatitude = 0): number {
  if (!Number.isFinite(resDeg) || resDeg <= 0) return MIN_FILL_RADIUS_CELLS;

  const meanCell = (cellWidthM(resDeg, meanLatitude) + cellHeightM(resDeg)) / 2;
  if (!Number.isFinite(meanCell) || meanCell <= 0) return MIN_FILL_RADIUS_CELLS;

  return Math.max(MIN_FILL_RADIUS_CELLS, Math.round(COASTAL_FILL_M / meanCell));
}

/** The width of a bundle cell in metres at the bundle mean latitude. */
function cellWidthM(resDeg: number, meanLatitude: number): number {
  return resDeg * METERS_PER_DEGREE * Math.cos(meanLatitude / DEGREES_PER_RADIAN);
}

/** The height of a bundle cell in metres. */
function cellHeightM(resDeg: number): number {
  return resDeg * METERS_PER_DEGREE;
}

/**
 * Extend geology classes into neighbouring hatched cells inside the area by nearest class.
 * The fill stays discrete and display-only. Ties go to the smallest id. Outside cells stay
 * untouched. Cells beyond the radius stay hatched. Spill into water hides under the copy.
 */
export function fillCoastalGaps(
  ids: Uint8Array,
  mask: ArrayLike<number>,
  nx: number,
  ny: number,
  radiusCells: number,
  widthM = 1,
  heightM = 1,
): Uint8Array {
  const filled = Uint8Array.from(ids);
  if (radiusCells <= 0) return filled;
  const { maxDistance, stepX, stepY, widthM: cellWidth, heightM: cellHeight } = fillWindow(
    radiusCells,
    widthM,
    heightM,
  );
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      const cell = row * nx + column;
      if (mask[cell] !== 1 || filled[cell] !== CLASS_HATCH_ID) continue;

      const best = nearestCoastalSource(
        ids,
        mask,
        nx,
        ny,
        row,
        column,
        stepX,
        stepY,
        maxDistance,
        cellWidth,
        cellHeight,
      );
      if (best !== 0) filled[cell] = best;
    }
  }
  return filled;
}

/**
 * Copy class ids with hatched no-data mapped back to outside, so the image fallback never
 * sees the hatch sentinel and its smoothing treats those cells like other no-data cells.
 */
export function unhatchIds(ids: Uint8Array) {
  return Uint8Array.from(ids, (id) => (id === CLASS_HATCH_ID ? 0 : id));
}

/**
 * Fill coastal gaps in bounded row slices so entry keeps responding while filling.
 * The output matches fillCoastalGaps exactly.
 */
async function fillCoastalGapsInSlices(
  ids: Uint8Array,
  mask: ArrayLike<number>,
  nx: number,
  ny: number,
  radiusCells: number,
  widthM = 1,
  heightM = 1,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const filled = Uint8Array.from(ids);
  if (radiusCells <= 0) return filled;
  const { maxDistance, stepX, stepY, widthM: cellWidth, heightM: cellHeight } = fillWindow(
    radiusCells,
    widthM,
    heightM,
  );
  // The window area sets the check cadence so one slice never carries many costly scans.
  const windowCells = (2 * stepX + 1) * (2 * stepY + 1);
  const checkCells = Math.max(1, Math.floor(ENTRY_CHECK_CELLS / Math.max(1, windowCells)));
  let sliceMs = performance.now();
  let checked = 0;
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      const cell = row * nx + column;
      if (mask[cell] === 1 && filled[cell] === CLASS_HATCH_ID) {
        const best = nearestCoastalSource(
          ids,
          mask,
          nx,
          ny,
          row,
          column,
          stepX,
          stepY,
          maxDistance,
          cellWidth,
          cellHeight,
        );
        if (best !== 0) filled[cell] = best;
      }
      checked += 1;
      if (checked % checkCells !== 0) continue;
      if (signal?.aborted) throw cancelError();
      if (performance.now() - sliceMs < ENTRY_BUDGET_MS) continue;

      await yieldToBrowser(signal);
      sliceMs = performance.now();
    }
  }
  if (signal?.aborted) throw cancelError();
  return filled;
}

function fillWindow(radiusCells: number, widthM: number, heightM: number) {
  // Invalid dimensions fall back to one metre so the window and the distances agree.
  if (!Number.isFinite(widthM) || widthM <= 0) widthM = 1;
  if (!Number.isFinite(heightM) || heightM <= 0) heightM = 1;

  const meanCell = (widthM + heightM) / 2;
  const maxDistance = radiusCells * meanCell;
  return {
    maxDistance,
    stepX: Math.max(1, Math.ceil(maxDistance / widthM)),
    stepY: Math.max(1, Math.ceil(maxDistance / heightM)),
    widthM,
    heightM,
  };
}

function nearestCoastalSource(
  ids: Uint8Array,
  mask: ArrayLike<number>,
  nx: number,
  ny: number,
  row: number,
  column: number,
  stepX: number,
  stepY: number,
  maxDistance: number,
  widthM: number,
  heightM: number,
): number {
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestSource = 0;
  const minRow = Math.max(0, row - stepY);
  const maxRow = Math.min(ny - 1, row + stepY);
  const minColumn = Math.max(0, column - stepX);
  const maxColumn = Math.min(nx - 1, column + stepX);
  for (let sourceRow = minRow; sourceRow <= maxRow; sourceRow++) {
    for (let sourceColumn = minColumn; sourceColumn <= maxColumn; sourceColumn++) {
      const sourceCell = sourceRow * nx + sourceColumn;
      if (mask[sourceCell] !== 1) continue;

      const source = ids[sourceCell];
      if (source === 0 || source === CLASS_HATCH_ID) continue;

      const distance = Math.hypot((column - sourceColumn) * widthM, (row - sourceRow) * heightM);
      if (distance > maxDistance) continue;
      if (distance < bestDistance || (distance === bestDistance && source < bestSource)) {
        bestDistance = distance;
        bestSource = source;
      }
    }
  }
  return bestSource;
}
