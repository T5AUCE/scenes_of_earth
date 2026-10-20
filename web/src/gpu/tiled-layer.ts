import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

import type { Bbox } from "../types";
import { deleteResources, linkProgram, uploadTexture } from "./gl";
import {
  localMatrix,
  quadExtent,
  rowTable,
  textureTiles,
  type QuadExtent,
  type TextureTile,
} from "./grid-geometry";

/** A grid of cells that covers a bbox. */
export interface TiledGrid {
  bbox: Bbox;
  nx: number;
  ny: number;
}

/** What a tiled layer needs to place and report on itself. */
export interface TiledLayerOptions {
  id: string;
  grid: TiledGrid;
  /** Longitude offset of the scene's world copy. */
  shift: number;
  /** Called once, outside any draw, when the layer can no longer draw. */
  onFail(error: Error): void;
}

/** The shader code of a tiled layer and the names of the uniforms its draw sets. */
export interface TiledProgram {
  /** What the layer draws, for its failure messages. */
  name: string;
  vertex: string;
  fragment: string;
  uniformNames: string[];
}

interface GpuTile {
  texture: WebGLTexture;
  /** A second texture of the same window, which a draw reads from texture unit 2. */
  companion: WebGLTexture | null;
  tile: TextureTile;
  quad: QuadExtent;
}

/** The GPU resources every tiled layer holds. */
export interface TiledGpu {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  vertexArray: WebGLVertexArrayObject;
  corners: WebGLBuffer;
  rows: WebGLTexture | null;
  rowCount: number;
  tiles: GpuTile[];
}

/** Where a custom layer sits in the style, so it can be put back after a context loss. */
export interface LayerPosition {
  beforeId: string | undefined;
  visibility: "visible" | "none";
  minzoom: number;
  maxzoom: number;
}

const MAX_ROW_SAMPLES = 4096;
// Neighbouring copies cover a camera that wraps past the scene.
const WORLD_COPIES = [-1, 0, 1];
const CORNERS = Float32Array.of(0, 0, 1, 0, 0, 1, 1, 1);
const TILE_UNIFORM_NAMES = ["uMatrix", "uTile", "uRows", "uRowCount"];

/**
 * The lifecycle of a MapLibre custom layer that draws a grid of cells as textured quads: shader
 * setup, context loss, failure reporting, tile uploads and world copies. A subclass chooses the
 * shaders, uploads its own data and sets its own uniforms.
 */
export abstract class TiledGpuLayer<Gpu extends TiledGpu = TiledGpu>
  implements CustomLayerInterface
{
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";

  protected map: MapLibreMap | null = null;
  protected gl: WebGL2RenderingContext | null = null;
  protected gpu: Gpu | null = null;
  protected readonly options: TiledLayerOptions;
  private readonly program: TiledProgram;
  private isFailed = false;

  constructor(options: TiledLayerOptions, program: TiledProgram) {
    this.options = options;
    this.program = program;
    this.id = options.id;
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
        throw new Error(`${this.program.name} need WebGL 2`);
      }
      const { vertex, fragment, uniformNames } = this.program;
      const program = linkProgram(gl, vertex, fragment);
      const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      try {
        this.gpu = this.extendGpu({
          program,
          uniforms: new Map(
            [...TILE_UNIFORM_NAMES, ...uniformNames].map((name) => [
              name,
              gl.getUniformLocation(program, name),
            ]),
          ),
          ...this.createQuad(gl, program),
          rows: null,
          rowCount: Math.min(maxTextureSize, MAX_ROW_SAMPLES),
          tiles: [],
        });
      } catch (error) {
        gl.deleteProgram(program);
        throw error;
      }
      this.initialize(gl, this.gpu);
    } catch (error) {
      this.release();
      this.fail(error as Error);
    }
  }

  private createQuad(gl: WebGL2RenderingContext, program: WebGLProgram) {
    const vertexArray = gl.createVertexArray();
    const corners = gl.createBuffer();
    if (!vertexArray || !corners) {
      deleteResources(gl, { vertexArrays: [vertexArray], buffers: [corners] });
      throw new Error(`Cannot allocate geometry for ${this.program.name.toLowerCase()}`);
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

  private release() {
    const { gpu, gl } = this;
    this.gpu = null;
    if (!gpu || !gl) return;

    deleteResources(gl, {
      programs: [gpu.program],
      textures: [
        gpu.rows,
        ...this.extraTextures(gpu),
        ...gpu.tiles.flatMap(({ texture, companion }) => [texture, companion]),
      ],
      buffers: [gpu.corners],
      vertexArrays: [gpu.vertexArray],
    });
  }

  protected fail(error: Error) {
    if (this.isFailed) return;

    this.isFailed = true;
    queueMicrotask(() => this.options.onFail(error));
  }

  render(gl: WebGL2RenderingContext, input: CustomRenderMethodInput) {
    if (this.isFailed || !this.gpu || !this.hasData()) return;

    try {
      if (this.map?.getProjection()?.type === "globe") {
        throw new Error(`${this.program.name} need Mercator drawing`);
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

  /** Whether the layer has the data it needs to draw. */
  protected abstract hasData(): boolean;

  /** Add the layer's own resources to the shared ones. */
  protected abstract extendGpu(base: TiledGpu): Gpu;

  /** The layer's own textures, so that they are freed with the shared ones. */
  protected abstract extraTextures(gpu: Gpu): (WebGLTexture | null)[];

  /** Mark all data stale and upload what a frame does not, after the GPU resources exist. */
  protected abstract initialize(gl: WebGL2RenderingContext, gpu: Gpu): void;

  protected abstract uploadStaleData(gl: WebGL2RenderingContext, gpu: Gpu): void;

  protected abstract draw(
    gl: WebGL2RenderingContext,
    gpu: Gpu,
    mainMatrix: ArrayLike<number>,
  ): void;

  /** Make the program current and bind the row table to texture unit 1. */
  protected beginDraw(gl: WebGL2RenderingContext, gpu: Gpu) {
    gl.useProgram(gpu.program);
    gl.bindVertexArray(gpu.vertexArray);
    gl.bindSampler(0, null);
    gl.bindSampler(1, null);
    gl.bindSampler(2, null);
    gl.uniform1i(this.uniform(gpu, "uRows"), 1);
    gl.uniform1i(this.uniform(gpu, "uRowCount"), gpu.rowCount);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, gpu.rows);
    gl.activeTexture(gl.TEXTURE0);
  }

  protected uniform(gpu: Gpu, name: string) {
    return gpu.uniforms.get(name)!;
  }

  protected uploadRows(gl: WebGL2RenderingContext, gpu: Gpu, grid: TiledGrid) {
    deleteResources(gl, { textures: [gpu.rows] });
    gpu.rows = null;
    gpu.rows = uploadTexture(gl, "floats", gpu.rowCount, 1, rowTable(grid, gpu.rowCount));
  }

  /**
   * Replace the layer's tile textures with one-byte cells of the grid, each with its halo, and
   * with the cells of a companion grid of the same size when there is one.
   */
  protected uploadTiles(
    gl: WebGL2RenderingContext,
    gpu: Gpu,
    grid: TiledGrid,
    cells: Uint8Array,
    companionCells?: Uint8Array,
  ) {
    deleteResources(gl, {
      textures: gpu.tiles.flatMap(({ texture, companion }) => [texture, companion]),
    });
    gpu.tiles = [];
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    for (const tile of textureTiles(grid.nx, grid.ny, maxTextureSize)) {
      const { window } = tile;
      const upload = (source: Uint8Array) => {
        const windowCells = new Uint8Array(window.width * window.height);
        for (let row = 0; row < window.height; row++) {
          const start = (window.row + row) * grid.nx + window.column;
          windowCells.set(source.subarray(start, start + window.width), row * window.width);
        }
        return uploadTexture(gl, "ids", window.width, window.height, windowCells);
      };
      gpu.tiles.push({
        texture: upload(cells),
        companion: companionCells ? upload(companionCells) : null,
        tile,
        quad: quadExtent(grid, tile.core, this.options.shift),
      });
    }
  }

  /** Draw every tile in every world copy, after `bindTile` sets the tile's own uniforms. */
  protected drawTiles(
    gl: WebGL2RenderingContext,
    gpu: Gpu,
    mainMatrix: ArrayLike<number>,
    bindTile: (tile: TextureTile) => void,
  ) {
    for (const { texture, companion, tile, quad } of gpu.tiles) {
      if (companion) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, companion);
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      bindTile(tile);
      gl.uniform4f(
        this.uniform(gpu, "uTile"),
        tile.core.column - tile.window.column,
        tile.core.width,
        quad.rowSpan[0],
        quad.rowSpan[1],
      );
      for (const worldOffset of WORLD_COPIES) {
        gl.uniformMatrix4fv(
          this.uniform(gpu, "uMatrix"),
          false,
          localMatrix(mainMatrix, quad, worldOffset),
        );
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, CORNERS.length / 2);
      }
    }
  }
}

/** Read where a layer sits now, with `fallbackBeforeId` for a layer that is last in the style. */
export function layerPosition(
  map: MapLibreMap,
  id: string,
  fallbackBeforeId: string | undefined,
): LayerPosition {
  const layers = map.getLayersOrder();
  const index = layers.indexOf(id);
  const layer = map.getLayer(id);
  const isHidden = layer && map.getLayoutProperty(id, "visibility") === "none";

  return {
    beforeId: index < 0 ? fallbackBeforeId : layers[index + 1],
    visibility: isHidden ? "none" : "visible",
    minzoom: layer?.minzoom ?? 0,
    maxzoom: layer?.maxzoom ?? map.getMaxZoom(),
  };
}

/**
 * Put a custom layer back where it was after a WebGL context loss, because MapLibre leaves custom
 * layers out of the style it rebuilds. The returned function stops the watching.
 */
export function keepThroughContextLoss(
  map: MapLibreMap,
  layer: CustomLayerInterface,
  fallbackBeforeId: string | undefined,
): () => void {
  const canvas = map.getCanvas();
  let lost: LayerPosition | null = null;

  const onLost = () => {
    if (!map.getLayer(layer.id)) return;

    lost = layerPosition(map, layer.id, fallbackBeforeId);
    map.removeLayer(layer.id);
  };

  const restore = () => {
    if (!lost) return;

    const { beforeId, visibility, minzoom, maxzoom } = lost;
    lost = null;
    map.addLayer(layer, beforeId);
    map.setLayoutProperty(layer.id, "visibility", visibility);
    map.setLayerZoomRange(layer.id, minzoom, maxzoom);
    map.triggerRepaint();
  };

  const onRestored = () => {
    if (!lost) return;

    if (map.isStyleLoaded()) restore();
    else map.once("style.load", restore);
  };

  // Capture removes the layer before MapLibre serializes and destroys the lost style.
  canvas.addEventListener("webglcontextlost", onLost, true);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return () => {
    canvas.removeEventListener("webglcontextlost", onLost, true);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    map.off("style.load", restore);
    lost = null;
  };
}
