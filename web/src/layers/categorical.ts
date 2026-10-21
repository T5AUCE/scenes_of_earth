/** Draw categorical classes with GPU borders and a CPU image fallback. */
import { arrayDoc, decode, readArray } from "../data";
import {
  DEFAULT_EDGES,
  defaultPalette,
  loadStoredEdges,
  MAX_ROUNDING,
  MAX_SOFTNESS_CELLS,
  storeEdges,
} from "../display-state";
import { createClassFieldLayer } from "../gpu/class-field-layer";
import { layerPosition, type LayerPosition } from "../gpu/tiled-layer";
import { classLegend } from "../legend";
import { removeLayerAndSource } from "../map";
import { CLASS_PALETTE_OPTIONS, classColors, classPalette } from "../render/palettes";
import { cellClassIds } from "../render/smooth-classes";
import type { EdgeSettings, EdgesMenu, LayerContext, LayerMenu, LayerView } from "../types";
import type { Draw } from "./allocate";
import { createImagePainter } from "./categorical-image";

const CATEGORICAL_OPACITY = 0.8;
const ROUNDING_STEP = 0.05;
const SOFTNESS_STEP_CELLS = 0.05;
const IMAGE_EDGES_NOTE = "Edge options need WebGL drawing.";

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
  private palette: string;
  private colors;
  private smooth = true;
  private edges: EdgeSettings;
  private alive = true;
  private readonly context: LayerContext;
  private restorePosition: LayerPosition | null = null;

  constructor(context: LayerContext) {
    this.context = context;
    const { layer } = context;
    this.id = `${layer.id}-classes`;
    const classes = layer.style.classes;
    if (!classes) throw new Error(`Layer "${layer.id}" needs classes`);

    this.classes = classes;
    this.classValues = this.classes.map(({ value }) => value);
    this.palette = context.display?.palette ?? defaultPalette(layer);
    this.colors = classColors(this.classes, this.palette);
    this.edges = loadStoredEdges(layer.id);
    this.gpu = createClassFieldLayer({
      id: this.id,
      grid: layer.grid,
      shift: context.shift,
      opacity: CATEGORICAL_OPACITY,
      edges: { smooth: this.smooth, ...this.edges },
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
          else this.gpu.setEdges({ smooth: on, ...this.edges });
        },
      },
    ];
    this.mount();
    this.ready = this.load();
  }

  private createEdgesMenu(): EdgesMenu {
    const view = this;

    return {
      controls: [
        {
          label: "Rounding",
          min: 0,
          max: MAX_ROUNDING,
          step: ROUNDING_STEP,
          get value() {
            return view.edges.rounding;
          },
          set: (rounding) => this.setEdges({ ...this.edges, rounding }),
        },
        {
          label: "Edge softness",
          unit: "cells",
          min: 0,
          max: MAX_SOFTNESS_CELLS,
          step: SOFTNESS_STEP_CELLS,
          get value() {
            return view.edges.softnessCells;
          },
          set: (softnessCells) => this.setEdges({ ...this.edges, softnessCells }),
        },
      ],
      outline: {
        get value() {
          return view.edges.outline;
        },
        set: (outline) => this.setEdges({ ...this.edges, outline }),
      },
      get isDefault() {
        return view.edges.rounding === DEFAULT_EDGES.rounding
          && view.edges.softnessCells === DEFAULT_EDGES.softnessCells
          && view.edges.outline === DEFAULT_EDGES.outline;
      },
      reset: () => this.setEdges({ ...DEFAULT_EDGES }),
    };
  }

  private setEdges(edges: EdgeSettings) {
    this.edges = edges;
    storeEdges(this.context.layer.id, edges);
    this.gpu.setEdges({ smooth: this.smooth, ...edges });
  }

  private createMenu(): LayerMenu {
    const view = this;

    return {
      title: this.context.layer.title,
      heading: "Colours",
      blocks: true,
      palettes: CLASS_PALETTE_OPTIONS.map(({ name, label }) => ({
        name,
        label,
        colors: this.classes.map(({ value, color }) => classPalette(name)?.[value] ?? color),
      })),
      defaultPalette: defaultPalette(this.context.layer),
      custom: false,
      updates: this.menuUpdates,
      get palette() {
        return view.palette;
      },
      setPalette: (name) => {
        this.palette = name;
        this.colors = classColors(this.classes, name);
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
      if (this.ids) this.image.paint(this.ids, colors, this.smooth);
    } else {
      this.gpu.setColors(colors);
      this.gpu.setEdges({ smooth: this.smooth, ...this.edges });
    }
    this.legendBox.replaceChildren(classLegend(this.classes, this.present, this.colors));
  }

  private async load() {
    const { layer, store } = this.context;
    const valueArray = arrayDoc(layer, "value");
    const raw = await readArray(await store, valueArray.path, [null, null]);
    if (!this.alive) return;

    const values = decode(raw, valueArray);
    this.ids = cellClassIds(values, this.classValues);
    this.present = new Set(values);
    if (!this.image) this.gpu.setIds(this.ids);
    this.repaint();
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
