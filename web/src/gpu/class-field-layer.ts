import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

import type { Bbox } from "../types";
import { CLASS_FIELD_FRAGMENT, CLASS_FIELD_VERTEX } from "./class-field-shaders";
import { deleteResources, linkProgram, uploadTexture } from "./gl";
import {
  localMatrix,
  quadExtent,
  rowTable,
  textureTiles,
  type QuadExtent,
  type TextureTile,
} from "./grid-geometry";

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
export interface ClassFieldOptions {
  id: string;
  grid: { bbox: Bbox; nx: number; ny: number };
  /** Longitude offset of the scene's world copy. */
  shift: number;
  opacity: number;
  edges: ClassEdges;
  /** Called once, outside any draw, when the layer can no longer draw. */
  onFail(error: Error): void;
}

interface GpuTile {
  texture: WebGLTexture;
  tile: TextureTile;
  quad: QuadExtent;
}

interface Gpu {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  vertexArray: WebGLVertexArrayObject;
  corners: WebGLBuffer;
  rows: WebGLTexture | null;
  rowCount: number;
  palette: WebGLTexture | null;
  tiles: GpuTile[];
}

const MAX_ROW_SAMPLES = 4096;
const PALETTE_SIZE = 256;
const CHANNELS = 4;
// Neighbouring copies cover a camera that wraps past the scene.
const WORLD_COPIES = [-1, 0, 1];
const UNIFORM_NAMES = [
  "uMatrix",
  "uTile",
  "uIds",
  "uRows",
  "uPalette",
  "uIdsSize",
  "uRowCount",
  "uWindowRow",
  "uSmooth",
  "uRounding",
  "uSoftnessCells",
  "uOutline",
  "uOpacity",
];
const CORNERS = Float32Array.of(0, 0, 1, 0, 0, 1, 1, 1);

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

class ClassFieldLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private gpu: Gpu | null = null;
  private ids: Uint8Array | null = null;
  private paletteBytes = new Uint8Array(PALETTE_SIZE * CHANNELS);
  private edges: ClassEdges;
  private isIdsStale = false;
  private isPaletteStale = true;
  private isFailed = false;
  private readonly options: ClassFieldOptions;

  constructor(options: ClassFieldOptions) {
    this.options = options;
    this.id = options.id;
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

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const canvas = map.getCanvas();
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.build();
  }

  onRemove() {
    const canvas = this.map?.getCanvas();
    canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.release();
    this.map = null;
    this.gl = null;
  }

  render(gl: WebGL2RenderingContext, input: CustomRenderMethodInput) {
    if (this.isFailed || !this.gpu || !this.ids) return;

    try {
      if (this.map?.getProjection()?.type === "globe") {
        throw new Error("Class fields need Mercator drawing");
      }
      this.uploadStaleData(gl, this.gpu);
      // MapLibre's model-view matrix uses world pixels, not normalized Mercator coordinates.
      this.draw(gl, this.gpu, input.defaultProjectionData.mainMatrix);
    } catch (error) {
      this.fail(error as Error);
    } finally {
      gl.bindVertexArray(null);
    }
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.gpu = null;
  };

  private readonly onContextRestored = () => {
    this.build();
    this.map?.triggerRepaint();
  };

  private build() {
    const gl = this.gl!;
    try {
      if (typeof gl.createVertexArray !== "function") {
        throw new Error("Class fields need WebGL 2");
      }
      const program = linkProgram(gl, CLASS_FIELD_VERTEX, CLASS_FIELD_FRAGMENT);
      const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const rowCount = Math.min(maxTextureSize, MAX_ROW_SAMPLES);
      try {
        this.gpu = {
          program,
          uniforms: uniformLocations(gl, program),
          ...createQuad(gl, program),
          rows: null,
          rowCount,
          palette: null,
          tiles: [],
        };
      } catch (error) {
        gl.deleteProgram(program);
        throw error;
      }
      this.gpu.rows = uploadTexture(
        gl,
        "floats",
        rowCount,
        1,
        rowTable(this.options.grid, rowCount),
      );
      this.isIdsStale = true;
      this.isPaletteStale = true;
    } catch (error) {
      this.release();
      this.fail(error as Error);
    }
  }

  private release() {
    const { gpu, gl } = this;
    this.gpu = null;
    if (!gpu || !gl) return;

    deleteResources(gl, {
      programs: [gpu.program],
      textures: [gpu.rows, gpu.palette, ...gpu.tiles.map(({ texture }) => texture)],
      buffers: [gpu.corners],
      vertexArrays: [gpu.vertexArray],
    });
  }

  private fail(error: Error) {
    if (this.isFailed) return;

    this.isFailed = true;
    queueMicrotask(() => this.options.onFail(error));
  }

  private uploadStaleData(gl: WebGL2RenderingContext, gpu: Gpu) {
    if (this.isPaletteStale) {
      deleteResources(gl, { textures: [gpu.palette] });
      gpu.palette = uploadTexture(gl, "colors", PALETTE_SIZE, 1, this.paletteBytes);
      this.isPaletteStale = false;
    }
    if (this.isIdsStale) {
      deleteResources(gl, { textures: gpu.tiles.map(({ texture }) => texture) });
      gpu.tiles = [];
      this.uploadTiles(gl, gpu, this.ids!);
      this.isIdsStale = false;
    }
  }

  private uploadTiles(gl: WebGL2RenderingContext, gpu: Gpu, ids: Uint8Array) {
    const { grid, shift } = this.options;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    for (const tile of textureTiles(grid.nx, grid.ny, maxTextureSize)) {
      const { window } = tile;
      const cells = new Uint8Array(window.width * window.height);
      for (let row = 0; row < window.height; row++) {
        const start = (window.row + row) * grid.nx + window.column;
        cells.set(ids.subarray(start, start + window.width), row * window.width);
      }
      gpu.tiles.push({
        texture: uploadTexture(gl, "ids", window.width, window.height, cells),
        tile,
        quad: quadExtent(grid, tile.core, shift),
      });
    }
  }

  private draw(gl: WebGL2RenderingContext, gpu: Gpu, mainMatrix: ArrayLike<number>) {
    const uniform = (name: string) => gpu.uniforms.get(name)!;
    const { smooth, rounding, softnessCells, outline } = this.edges;

    gl.useProgram(gpu.program);
    gl.bindVertexArray(gpu.vertexArray);
    gl.bindSampler(0, null);
    gl.bindSampler(1, null);
    gl.bindSampler(2, null);
    gl.uniform1i(uniform("uIds"), 0);
    gl.uniform1i(uniform("uRows"), 1);
    gl.uniform1i(uniform("uPalette"), 2);
    gl.uniform1i(uniform("uRowCount"), gpu.rowCount);
    gl.uniform1i(uniform("uSmooth"), smooth ? 1 : 0);
    gl.uniform1f(uniform("uRounding"), rounding);
    gl.uniform1f(uniform("uSoftnessCells"), softnessCells);
    gl.uniform1i(uniform("uOutline"), outline ? 1 : 0);
    gl.uniform1f(uniform("uOpacity"), this.options.opacity);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, gpu.rows);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, gpu.palette);
    gl.activeTexture(gl.TEXTURE0);

    for (const { texture, tile, quad } of gpu.tiles) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform2i(uniform("uIdsSize"), tile.window.width, tile.window.height);
      gl.uniform1f(uniform("uWindowRow"), tile.window.row);
      gl.uniform4f(
        uniform("uTile"),
        tile.core.column - tile.window.column,
        tile.core.width,
        quad.rowSpan[0],
        quad.rowSpan[1],
      );
      for (const worldOffset of WORLD_COPIES) {
        gl.uniformMatrix4fv(uniform("uMatrix"), false, localMatrix(mainMatrix, quad, worldOffset));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, CORNERS.length / 2);
      }
    }
  }
}

function uniformLocations(gl: WebGL2RenderingContext, program: WebGLProgram) {
  return new Map(UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)]));
}

function createQuad(gl: WebGL2RenderingContext, program: WebGLProgram) {
  const vertexArray = gl.createVertexArray();
  const corners = gl.createBuffer();
  if (!vertexArray || !corners) {
    deleteResources(gl, { vertexArrays: [vertexArray], buffers: [corners] });
    throw new Error("Cannot allocate class-field geometry");
  }

  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, "aCorner");
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  return { vertexArray, corners };
}
