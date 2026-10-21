/** Draw tiled categorical class fills with their optional outline through the GPU lifecycle. */
import type { CustomLayerInterface } from "maplibre-gl";

import {
  CLASS_FIELD_FRAGMENT,
  CLASS_FIELD_VERTEX,
  FILL_OUTLINE_STRENGTH,
} from "./class-field-shaders";
import { deleteResources, uploadTexture } from "./gl";
import {
  TiledGpuLayer,
  type TiledGpu,
  type TiledLayerOptions,
} from "./tiled-layer";

/** How the edges between classes are drawn. */
export interface ClassEdges {
  /** Blend competing classes from the kernel instead of painting the nearest cell. */
  smooth: boolean;
  /** Blend bilinear weights towards a cubic B-spline, capped at 0.6 by the viewer. */
  rounding: number;
  /** The width of the colour blend between two classes in grid cells; 0 keeps a one-pixel edge. */
  softnessCells: number;
  /** Draw a faint ink line between two classes. */
  outline: boolean;
}

/** What createClassFieldLayer needs to place and report on a layer. */
export interface ClassFieldOptions extends TiledLayerOptions {
  opacity: number;
  edges: ClassEdges;
}

interface Gpu extends TiledGpu {
  palette: WebGLTexture | null;
}

const PALETTE_SIZE = 256;
const CHANNELS = 4;
const UNIFORM_NAMES = [
  "uIds",
  "uPalette",
  "uIdsSize",
  "uWindowRow",
  "uSmooth",
  "uRounding",
  "uSoftnessCells",
  "uOutline",
  "uOutlineStrength",
  "uOpacity",
];

/**
 * A MapLibre custom layer that draws one-based class ids with the class kernel of the fragment
 * shader. The setters take effect on the next frame.
 */
export function createClassFieldLayer(options: ClassFieldOptions) {
  const layer = new ClassFieldLayer(options);
  return {
    layer: layer as CustomLayerInterface,
    setIds: (ids: Uint8Array) => layer.setIds(ids),
    setColors: (colors: number[][]) => layer.setColors(colors),
    setEdges: (edges: ClassEdges) => layer.setEdges(edges),
  };
}

class ClassFieldLayer extends TiledGpuLayer<Gpu> {
  private ids: Uint8Array | null = null;
  private paletteBytes = new Uint8Array(PALETTE_SIZE * CHANNELS);
  private edges: ClassEdges;
  private isIdsStale = false;
  private isPaletteStale = true;
  private readonly fieldOptions: ClassFieldOptions;

  constructor(options: ClassFieldOptions) {
    super(options, {
      name: "Class fields",
      vertex: CLASS_FIELD_VERTEX,
      fragment: CLASS_FIELD_FRAGMENT,
      uniformNames: UNIFORM_NAMES,
    });
    this.fieldOptions = options;
    this.edges = options.edges;
  }

  setIds(ids: Uint8Array) {
    this.ids = ids;
    this.isIdsStale = true;
    this.map?.triggerRepaint();
  }

  setColors(colors: number[][]) {
    this.paletteBytes.fill(0);
    colors.forEach((color, index) => {
      this.paletteBytes.set([...color, 255], (index + 1) * CHANNELS);
    });
    this.isPaletteStale = true;
    this.map?.triggerRepaint();
  }

  setEdges(edges: ClassEdges) {
    this.edges = edges;
    this.map?.triggerRepaint();
  }

  protected hasData() {
    return this.ids !== null;
  }

  protected extendGpu(base: TiledGpu): Gpu {
    return { ...base, palette: null };
  }

  protected extraTextures(gpu: Gpu) {
    return [gpu.palette];
  }

  protected initialize(gl: WebGL2RenderingContext, gpu: Gpu) {
    this.uploadRows(gl, gpu, this.options.grid);
    this.isIdsStale = true;
    this.isPaletteStale = true;
  }

  protected uploadStaleData(gl: WebGL2RenderingContext, gpu: Gpu) {
    if (this.isPaletteStale) {
      deleteResources(gl, { textures: [gpu.palette] });
      gpu.palette = uploadTexture(gl, "colors", PALETTE_SIZE, 1, this.paletteBytes);
      this.isPaletteStale = false;
    }
    if (this.isIdsStale) {
      this.uploadTiles(gl, gpu, this.options.grid, this.ids!);
      this.isIdsStale = false;
    }
  }

  protected draw(gl: WebGL2RenderingContext, gpu: Gpu, mainMatrix: ArrayLike<number>) {
    const uniform = (name: string) => this.uniform(gpu, name);
    const { rounding, softnessCells, outline } = this.edges;

    this.beginDraw(gl, gpu);
    gl.uniform1i(uniform("uIds"), 0);
    gl.uniform1i(uniform("uPalette"), 2);
    gl.uniform1i(uniform("uSmooth"), this.edges.smooth ? 1 : 0);
    gl.uniform1f(uniform("uRounding"), rounding);
    gl.uniform1f(uniform("uSoftnessCells"), softnessCells);
    gl.uniform1i(uniform("uOutline"), outline ? 1 : 0);
    gl.uniform1f(uniform("uOutlineStrength"), FILL_OUTLINE_STRENGTH);
    gl.uniform1f(uniform("uOpacity"), this.fieldOptions.opacity);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, gpu.palette);
    gl.activeTexture(gl.TEXTURE0);

    this.drawTiles(gl, gpu, mainMatrix, ({ window }) => {
      gl.uniform2i(uniform("uIdsSize"), window.width, window.height);
      gl.uniform1f(uniform("uWindowRow"), window.row);
    });
  }
}
