/** Manage tiled GPU resources and restore custom layers after context loss. */
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

/** The GPU resources held by every tiled layer. */
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

const NS_PER_MS = 1e6;
const GPU_QUERY_ATTEMPTS = 30;
// Without a frame scheduler the poll waits one frame interval before checking again.
const NEXT_FRAME_FALLBACK_MS = 16;
// The WebGL timer extension keeps its registry name across browsers.
const TIMER_QUERY_EXTENSION = "EXT_disjoint_timer_query_webgl2";

/**
 * Draw a cell grid as textured quads through the MapLibre custom-layer lifecycle.
 * Subclasses supply shaders and data while this class manages shared GPU resources.
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
  private isContextLost = false;

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
    // The first visible draw compiles, so hidden layers never pay for a program.
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.gpu = null;
    this.isContextLost = true;
  };

  private readonly onContextRestored = () => {
    // The next visible draw rebuilds, so hidden layers stay uncompiled.
    this.isContextLost = false;
    clearGpuMs(this.options.id);
    clearGpuUnavailable();
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

  onRemove() {
    const canvas = this.map?.getCanvas();
    canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.release();
    this.map = null;
    this.gl = null;
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
    if (this.isFailed || this.isContextLost) return;
    if (!this.map || !this.gl || this.isHidden() || !this.hasData()) return;
    if (!this.gpu) {
      this.build();
      if (!this.gpu) return;
    }

    try {
      if (this.map?.getProjection()?.type === "globe") {
        throw new Error(`${this.program.name} need Mercator drawing`);
      }
      this.uploadStaleData(gl, this.gpu);
      const gpu = this.gpu;
      // MapLibre's model-view matrix uses world pixels rather than normalised Mercator coordinates.
      this.draw(gl, gpu, input.defaultProjectionData.mainMatrix);
    } catch (error) {
      this.fail(error as Error);
    } finally {
      gl.bindVertexArray(null);
    }
  }

  private isHidden(): boolean {
    try {
      // A style without the lookup reads as visible so tests without layers still draw.
      return this.map?.getLayoutProperty?.(this.id, "visibility") === "none";
    } catch {
      return false;
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

  protected uploadRows(gl: WebGL2RenderingContext, gpu: Gpu, grid: TiledGrid) {
    deleteResources(gl, { textures: [gpu.rows] });
    gpu.rows = null;
    gpu.rows = uploadTexture(gl, "floats", gpu.rowCount, 1, rowTable(grid, gpu.rowCount));
  }

  /**
   * Upload one-byte grid cells with tile halos and an optional companion grid of the same size.
   * A layer passes its own halo so wide kernels stay inside one texture without changing others.
   */
  protected uploadTiles(
    gl: WebGL2RenderingContext,
    gpu: Gpu,
    grid: TiledGrid,
    cells: Uint8Array,
    companionCells?: Uint8Array,
    halo?: number,
  ) {
    deleteResources(gl, {
      textures: gpu.tiles.flatMap(({ texture, companion }) => [texture, companion]),
    });
    gpu.tiles = [];
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    for (const tile of textureTiles(grid.nx, grid.ny, maxTextureSize, halo)) {
      const texture = this.uploadWindow(gl, grid, tile.window, cells);
      gpu.tiles.push({
        texture,
        companion: this.uploadCompanion(gl, grid, tile, companionCells, texture),
        tile,
        quad: quadExtent(grid, tile.core, this.options.shift),
      });
    }
  }

  private uploadCompanion(
    gl: WebGL2RenderingContext,
    grid: TiledGrid,
    tile: TextureTile,
    companionCells: Uint8Array | undefined,
    texture: WebGLTexture,
  ) {
    if (!companionCells) return null;

    try {
      return this.uploadWindow(gl, grid, tile.window, companionCells);
    } catch (error) {
      deleteResources(gl, { textures: [texture] });
      throw error;
    }
  }

  protected uploadWindow(
    gl: WebGL2RenderingContext,
    grid: TiledGrid,
    window: TextureTile["window"],
    cells: Uint8Array,
  ) {
    const windowCells = new Uint8Array(window.width * window.height);
    for (let row = 0; row < window.height; row++) {
      const start = (window.row + row) * grid.nx + window.column;
      windowCells.set(cells.subarray(start, start + window.width), row * window.width);
    }
    return uploadTexture(gl, "ids", window.width, window.height, windowCells);
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

  protected uniform(gpu: Gpu, name: string) {
    return gpu.uniforms.get(name)!;
  }
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

/** Read a layer's position with a fallback anchor when it is absent from the style. */
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

/** The timer query of one custom-layer draw, kept small because it runs every frame. */
interface GpuTimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Whether this build and address may spend GPU time queries on the dev readout. */
export function isGpuTimingEnabled(): boolean {
  try {
    const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
    if (dev) return true;
    return new URLSearchParams(location.search).has("debug");
  } catch {
    return false;
  }
}

/** Run a layer draw inside a disjoint timer query when the dev readout allows it. */
export function timedGpuDraw(
  gl: WebGL2RenderingContext,
  layerId: string,
  run: () => void,
): void {
  if (!isGpuTimingEnabled()) {
    run();
    return;
  }
  timeWithQuery(gl, layerId, run);
}

function timeWithQuery(gl: WebGL2RenderingContext, layerId: string, run: () => void): void {
  const extension = gl.getExtension(TIMER_QUERY_EXTENSION) as unknown as GpuTimerExtension | null;
  if (!extension) {
    markGpuUnavailable();
    run();
    return;
  }
  const query = gl.createQuery();
  if (!query) {
    run();
    return;
  }
  gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
  try {
    run();
  } finally {
    gl.endQuery(extension.TIME_ELAPSED_EXT);
  }
  pollGpuQuery(gl, extension, query, layerId);
}

function pollGpuQuery(
  gl: WebGL2RenderingContext,
  extension: GpuTimerExtension,
  query: WebGLQuery,
  layerId: string,
): void {
  let attempts = 0;
  const check = (): void => {
    attempts += 1;
    const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean;
    const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT) as boolean;
    if (available && !disjoint) {
      const elapsedNs = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      recordGpuMs(layerId, elapsedNs / NS_PER_MS);
      gl.deleteQuery(query);
      return;
    }
    if (disjoint || attempts >= GPU_QUERY_ATTEMPTS) {
      gl.deleteQuery(query);
      return;
    }
    nextFrame(check);
  };
  nextFrame(check);
}

/** Wait for the next frame before polling again, so one layer costs one check per frame. */
function nextFrame(callback: () => void): void {
  try {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => callback());
      return;
    }
  } catch {
    // A missing frame scheduler falls through to the timer below.
  }
  setTimeout(callback, NEXT_FRAME_FALLBACK_MS);
}

function recordGpuMs(layerId: string, elapsedMs: number): void {
  try {
    const scope = globalThis as unknown as { __gpuMs?: Record<string, number> };
    scope.__gpuMs ??= {};
    scope.__gpuMs[layerId] = elapsedMs;
  } catch {
    // A missing window must not break the draw it timed.
  }
}

function markGpuUnavailable(): void {
  try {
    (globalThis as unknown as { __gpuUnavailable?: boolean }).__gpuUnavailable = true;
  } catch {
    // A missing window must not break the draw it timed.
  }
}

/** Drop one layer's timing after a context restore, so the badge shows no stale value. */
export function clearGpuMs(layerId: string): void {
  try {
    const scope = globalThis as unknown as { __gpuMs?: Record<string, number> };
    if (scope.__gpuMs) delete scope.__gpuMs[layerId];
  } catch {
    // A missing window must not break the restore it cleans up after.
  }
}

/** Clear the missing-extension flag after a context restore, so a new GPU can time again. */
export function clearGpuUnavailable(): void {
  try {
    delete (globalThis as unknown as { __gpuUnavailable?: boolean }).__gpuUnavailable;
  } catch {
    // A missing window must not break the restore it cleans up after.
  }
}
