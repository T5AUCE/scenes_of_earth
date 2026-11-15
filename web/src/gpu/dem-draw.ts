/**
 * The per-tile drawing that the relief and contour layers share: the plan and pool frame loop,
 * the readiness-to-weights resolver, arrival fades, quad placement and sampler binding. A layer
 * supplies its own program and fragment shader and sets its own uniforms for each quad.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

import { prefersReducedMotion } from "../reduced-motion";
import { inverseMercatorY, mercatorY, WEB_MERCATOR_MAX_LAT_DEG } from "../render/tile-viewport";
import type { Bbox } from "../types";
import { DEM_TILE_SIZE_PX, STRIP_WIDTH_PX } from "../workers/dem-decode";
import {
  pinnedBase,
  planDemTiles,
  type DemPlan,
  type PinnedBase,
  type PlacedTile,
  type TileId,
  type ViewBounds,
} from "./dem-plan";
import {
  acquireDemPool,
  releaseDemPool,
  TEXTURE_SIZE_PX,
  type AcquireDemPoolOptions,
  type DemPool,
} from "./dem-pool";
import { localMatrix, type QuadExtent } from "./grid-geometry";

/** How long a tile takes to fade in over the nearest ready ancestor. */
export const ARRIVAL_FADE_MS = 250;

/** Names of the uniforms that `DEM_VERTEX_SHADER` and the fragment header declare. */
export const DEM_UNIFORM_NAMES = [
  "uMatrix",
  "uLatitudes",
  "uSourceA",
  "uSourceB",
  "uWeights",
  "uHeightsA",
  "uHeightsB",
];

/**
 * Place a unit quad in world space and give the fragment the uv of both sources. `uSourceA`
 * and `uSourceB` hold a source's uv offset and scale, and `uLatitudes` the quad's north and
 * south edge in radians. The latitude's secant is interpolated down the quad, which stays
 * within a fraction of a percent of the exact value at the sharp levels relief draws.
 */
export const DEM_VERTEX_SHADER = `#version 300 es
in vec2 aCorner;
uniform mat4 uMatrix;
uniform vec2 uLatitudes;
uniform vec3 uSourceA;
uniform vec3 uSourceB;
out vec2 vUvA;
out vec2 vUvB;
out float vLatitudeSecant;

void main() {
  vUvA = uSourceA.xy + aCorner * uSourceA.z;
  vUvB = uSourceB.xy + aCorner * uSourceB.z;
  vLatitudeSecant = mix(1.0 / cos(uLatitudes.x), 1.0 / cos(uLatitudes.y), aCorner.y);
  gl_Position = uMatrix * vec4(aCorner, 0.0, 1.0);
}`;

/** Declarations and the height lookup that every DEM fragment shader starts with. */
const DEM_FRAGMENT_HEADER = `precision highp float;
precision highp sampler2D;

in vec2 vUvA;
in vec2 vUvB;
in float vLatitudeSecant;
uniform sampler2D uHeightsA;
uniform sampler2D uHeightsB;
uniform vec2 uWeights;

const float DEM_TILE_PX = ${DEM_TILE_SIZE_PX}.0;
const float DEM_HALO_PX = ${STRIP_WIDTH_PX}.0;
const float DEM_TEXTURE_PX = ${TEXTURE_SIZE_PX}.0;

// A texture is the tile plus its halo, so a tile uv maps into its middle.
vec2 demTextureCoord(vec2 uv) {
  return (uv * DEM_TILE_PX + DEM_HALO_PX) / DEM_TEXTURE_PX;
}

float demHeightAt(sampler2D heights, vec2 uv) {
  return texture(heights, demTextureCoord(uv)).r;
}
`;

/** Put the shared header in front of a layer's own fragment code. */
export function demFragmentShader(body: string): string {
  return `#version 300 es\n${DEM_FRAGMENT_HEADER}\n${body}`;
}

/** One DEM texture that a quad samples and its share of the result. */
export interface DrawSource {
  /** The wrapped tile of the texture, which is the quad's tile or one of its ancestors. */
  tile: TileId;
  weight: number;
}

/** How far a tile has faded in, from 0 to 1, or null while it cannot draw. */
export type FadeOf = (tile: TileId) => number | null;

/**
 * Turn what is ready into at most two sources for one quad. The quad's own weight and its
 * parent's weight each fade in over the nearest ready ancestors, equal tiles merge, and the two
 * heaviest sources are scaled up to keep the weight all of them held. The weights sum to 1
 * once every chain ends in a ready tile, and stay lower where nothing is ready to fade over.
 */
export function resolveSources(quad: PlacedTile, fadeOf: FadeOf): DrawSource[] {
  const chain: TileId[] = [{ z: quad.z, x: quad.wrappedX, y: quad.y }, ...quad.ancestors];
  const sources: DrawSource[] = [];
  addChainWeight(sources, chain, 0, quad.selfWeight, fadeOf);
  addChainWeight(sources, chain, 1, quad.parentWeight, fadeOf);

  const heaviest = sources
    .filter((source) => source.weight > 0)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 2);
  const total = sources.reduce((sum, source) => sum + source.weight, 0);
  const kept = heaviest.reduce((sum, source) => sum + source.weight, 0);

  return heaviest.map((source) => ({ ...source, weight: (source.weight * total) / kept }));
}

function addChainWeight(
  sources: DrawSource[],
  chain: TileId[],
  start: number,
  weight: number,
  fadeOf: FadeOf,
): void {
  let remaining = weight;

  for (let index = start; index < chain.length && remaining > 0; index++) {
    const fade = fadeOf(chain[index]);
    if (fade === null) continue;

    addWeight(sources, chain[index], remaining * fade);
    remaining *= 1 - fade;
  }
}

function addWeight(sources: DrawSource[], tile: TileId, weight: number): void {
  const same = sources.find(
    ({ tile: other }) => other.z === tile.z && other.x === tile.x && other.y === tile.y,
  );
  if (same) same.weight += weight;
  else sources.push({ tile, weight });
}

/** The uv offset and scale that map a quad onto the part of a source texture it covers. */
export function sourceUv(
  quad: Pick<PlacedTile, "z" | "wrappedX" | "y">,
  source: TileId,
): [number, number, number] {
  const span = 2 ** (quad.z - source.z);
  return [(quad.wrappedX % span) / span, (quad.y % span) / span, 1 / span];
}

/**
 * Fades each drawable texture in from the moment the pool says it could draw. A texture the pool
 * replaces counts as a new arrival, and one that was ready long before a quad needs it as a
 * fallback gives full weight at once.
 */
export class ArrivalFades {
  private readonly fadeMs = prefersReducedMotion() ? 0 : ARRIVAL_FADE_MS;
  isFading = false;

  constructor(private readonly pool: Pick<DemPool, "drawableForMs">) {}

  startFrame(): void {
    this.isFading = false;
  }

  readonly fadeOf: FadeOf = (tile) => {
    const drawableMs = this.pool.drawableForMs(tile);
    if (drawableMs === null) return null;

    const fade = this.fadeMs === 0 ? 1 : Math.min(drawableMs / this.fadeMs, 1);

    if (fade < 1) this.isFading = true;

    return fade;
  };
}

const HEADING_SMOOTHING = 0.8;

/** Smooths the pan direction in world units, which the planner uses to order the ring. */
class HeadingTracker {
  private previous: { x: number; y: number } | null = null;
  private readonly heading = { x: 0, y: 0 };

  update(view: ViewBounds): { x: number; y: number } {
    const centre = { x: (view.west + view.east) / 2, y: (view.north + view.south) / 2 };

    if (this.previous) {
      this.heading.x =
        this.heading.x * HEADING_SMOOTHING + (centre.x - this.previous.x) * (1 - HEADING_SMOOTHING);
      this.heading.y =
        this.heading.y * HEADING_SMOOTHING + (centre.y - this.previous.y) * (1 - HEADING_SMOOTHING);
    }

    this.previous = centre;

    return this.heading;
  }
}

/** Whether the context filters R32F linearly, which the shaders rely on. */
export function hasLinearHeights(gl: WebGL2RenderingContext): boolean {
  return gl.getExtension("OES_texture_float_linear") !== null;
}

/** The map and scene a draw needs. */
export interface DemDrawOptions {
  map: MapLibreMap;
  /** A url template with `{z}`, `{x}` and `{y}`. */
  tileUrl: string;
  /** The scene's bbox in its own world copy, where east may pass 180. */
  bbox: Bbox;
  maxZoom: number;
  /** The zoom the scene fits at, which sets the coarsest level and the pinned base. */
  fitZoom: number;
  /** Replace the store, worker or clock of the shared pool, for tests. */
  poolOptions?: Pick<AcquireDemPoolOptions, "createStore" | "createWorker" | "now">;
}

const CORNERS = Float32Array.of(0, 0, 1, 0, 0, 1, 1, 1);
const IDENTITY_MATRIX = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const SAMPLER_UNITS = [0, 1];

/** The GL objects that exist while the layer is added. */
interface DrawGpu {
  pool: DemPool;
  fades: ArrivalFades;
  vertexArray: WebGLVertexArrayObject;
  corners: WebGLBuffer;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

/**
 * One frame of DEM quads for a layer: plans the tiles, feeds the pool, binds the textures a
 * quad mixes and draws it. The layer owns the program and attaches it after it links.
 */
export class DemDraw {
  private readonly options: DemDrawOptions;
  private readonly heading = new HeadingTracker();
  private fitLevel: number;
  private pinnedLevel: number;
  private base: PinnedBase;
  private gpu: DrawGpu | null = null;
  private isWarm = false;

  constructor(options: DemDrawOptions) {
    this.options = options;
    this.fitLevel = this.levelOf(options.fitZoom);
    this.pinnedLevel = this.pinnedLevelOf(options.fitZoom);
    this.base = pinnedBase(options.bbox, this.pinnedLevel);
  }

  /** Take the shared pool and make the quad geometry for a linked program. */
  attach(gl: WebGL2RenderingContext, program: WebGLProgram): void {
    const vertexArray = gl.createVertexArray();
    const corners = gl.createBuffer();
    if (!vertexArray || !corners) throw new Error("Cannot allocate geometry for DEM tiles");

    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);

    const location = gl.getAttribLocation(program, "aCorner");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const pool = this.acquirePool(gl, vertexArray, corners);
    this.gpu = {
      pool,
      vertexArray,
      corners,
      uniforms: new Map(
        DEM_UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)]),
      ),
      fades: new ArrivalFades(pool),
    };
  }

  private acquirePool(
    gl: WebGL2RenderingContext,
    vertexArray: WebGLVertexArrayObject,
    corners: WebGLBuffer,
  ): DemPool {
    const { map, tileUrl, poolOptions } = this.options;

    try {
      return acquireDemPool({ map, gl, tileUrl, ...poolOptions });
    } catch (error) {
      gl.deleteVertexArray(vertexArray);
      gl.deleteBuffer(corners);
      throw error;
    }
  }

  /** Give the quad geometry back and release the pool. */
  detach(gl: WebGL2RenderingContext): void {
    const { gpu } = this;
    this.gpu = null;
    this.isWarm = false;

    if (!gpu) return;

    gl.deleteVertexArray(gpu.vertexArray);
    gl.deleteBuffer(gpu.corners);
    releaseDemPool(this.options.map, this.options.tileUrl);
  }

  /** Refit the pinned base after the camera lands on the scene. */
  setFitZoom(zoom: number): void {
    const fit = this.levelOf(zoom);
    const pinned = this.pinnedLevelOf(zoom);
    if (fit === this.fitLevel && pinned === this.pinnedLevel) return;

    this.fitLevel = fit;
    this.pinnedLevel = pinned;
    this.base = pinnedBase(this.options.bbox, pinned);
  }

  /**
   * Draw one quad that writes no pixel while the layer is hidden, so the driver builds the
   * program now and the first visible frame does not. `setState` is the layer's own state setup.
   */
  warmDraw(gl: WebGL2RenderingContext, setState: () => void): void {
    const { gpu } = this;
    if (!gpu || this.isWarm) return;

    this.isWarm = true;
    preservingGlState(gl, () => {
      setState();
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, 1, 1);
      gl.colorMask(false, false, false, false);

      for (const unit of SAMPLER_UNITS) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }

      gl.bindVertexArray(gpu.vertexArray);
      gl.uniform1i(this.uniform("uHeightsA"), 0);
      gl.uniform1i(this.uniform("uHeightsB"), 1);
      gl.uniformMatrix4fv(this.uniform("uMatrix"), false, IDENTITY_MATRIX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, CORNERS.length / 2);
    });
  }

  /**
   * Load and upload the pinned base while the layer is hidden. Returns whether nothing is left
   * to fetch or upload, which includes tiles that failed, so a missing tile never holds entry.
   */
  loadBase(gl: WebGL2RenderingContext): boolean {
    const { gpu } = this;
    if (!gpu) return true;

    preservingGlState(gl, () => {
      // Preparation shares the pool's per-frame upload budget with visible drawing.
      gpu.pool.syncFrame(this.base.tiles);
    });

    const { inflight, queueDepth, awaitingUpload } = gpu.pool.stats();

    // Uploads stop at the per-frame budget and a hidden layer gets no other frame,
    // so ask for the one that finishes them.
    if (awaitingUpload > 0) this.options.map.triggerRepaint();

    return inflight + queueDepth + awaitingUpload === 0;
  }

  /**
   * Draw the quads of one frame with the layer's program already in use. `drawQuad` sets the
   * layer's own uniforms just before each draw, for layers that have per-quad ones. Returns
   * whether the layer should repaint because tiles are fading in or the pool has uploads left.
   */
  draw(
    gl: WebGL2RenderingContext,
    mainMatrix: ArrayLike<number>,
    drawQuad?: (sources: DrawSource[]) => void,
  ): boolean {
    const { gpu } = this;
    if (!gpu) return false;

    const plan = this.plan();
    // The pool's uploads bind textures, so the draw binds its own afterwards.
    gpu.pool.syncFrame(plan.wanted);

    gl.bindVertexArray(gpu.vertexArray);
    gl.bindSampler(0, null);
    gl.bindSampler(1, null);
    gl.uniform1i(this.uniform("uHeightsA"), 0);
    gl.uniform1i(this.uniform("uHeightsB"), 1);

    gpu.fades.startFrame();

    for (const quad of plan.quads) {
      const sources = resolveSources(quad, gpu.fades.fadeOf);
      if (sources.length === 0) continue;

      this.bindQuad(gl, mainMatrix, quad, sources);
      drawQuad?.(sources);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, CORNERS.length / 2);
    }

    return gpu.fades.isFading || gpu.pool.needsRepaint();
  }

  private plan(): DemPlan {
    const { map, bbox, maxZoom } = this.options;
    const view = viewBoundsOf(map);

    return planDemTiles({
      zoom: map.getZoom(),
      view,
      bbox,
      fitLevel: this.fitLevel,
      maxZoom,
      base: this.base,
      heading: this.heading.update(view),
    });
  }

  private levelOf(zoom: number): number {
    // Floor keeps the planner clamp, so lower zooms still draw the floor level.
    return Math.min(Math.max(Math.floor(zoom), 0), this.options.maxZoom);
  }

  private pinnedLevelOf(zoom: number): number {
    // Round loads the level drawn at entry, which is the sharp level there.
    return Math.min(Math.max(Math.round(zoom), 0), this.options.maxZoom);
  }

  private bindQuad(
    gl: WebGL2RenderingContext,
    mainMatrix: ArrayLike<number>,
    quad: PlacedTile,
    sources: DrawSource[],
  ): void {
    const count = 2 ** quad.z;
    const placement: Pick<QuadExtent, "origin" | "extent"> = {
      origin: [quad.x / count, quad.y / count],
      extent: [1 / count, 1 / count],
    };
    gl.uniformMatrix4fv(this.uniform("uMatrix"), false, localMatrix(mainMatrix, placement, 0));
    gl.uniform2f(
      this.uniform("uLatitudes"),
      radiansOf(inverseMercatorY(quad.y / count)),
      radiansOf(inverseMercatorY((quad.y + 1) / count)),
    );

    const [first, second] = sources;
    gl.uniform2f(this.uniform("uWeights"), first.weight, second?.weight ?? 0);
    this.bindSource(gl, "uSourceA", 0, quad, first.tile);

    if (second) this.bindSource(gl, "uSourceB", 1, quad, second.tile);
  }

  private bindSource(
    gl: WebGL2RenderingContext,
    name: string,
    unit: number,
    quad: PlacedTile,
    source: TileId,
  ): void {
    gl.uniform3f(this.uniform(name), ...sourceUv(quad, source));
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.gpu!.pool.texture(source) as WebGLTexture);
  }

  private uniform(name: string): WebGLUniformLocation | null {
    return this.gpu!.uniforms.get(name) ?? null;
  }
}

/** The bindings and switches that work between map frames may change. */
interface SavedGlState {
  program: WebGLProgram | null;
  vertexArray: WebGLVertexArrayObject | null;
  activeUnit: number;
  textureUnits: { unit: number; texture: WebGLTexture | null }[];
  switches: { capability: number; isOn: boolean }[];
  scissor: Int32Array;
  colorMask: boolean[];
  blend: number[];
}

/**
 * Run GL work between map frames and put back what it changed. MapLibre caches its own GL state
 * and only resets it around a custom layer's render, so anything left changed would corrupt it.
 */
function preservingGlState(gl: WebGL2RenderingContext, run: () => void): void {
  const saved = saveGlState(gl);
  try {
    run();
  } finally {
    restoreGlState(gl, saved);
  }
}

function saveGlState(gl: WebGL2RenderingContext): SavedGlState {
  const activeUnit = (gl.getParameter(gl.ACTIVE_TEXTURE) as number) - gl.TEXTURE0;
  const textureUnits = [...new Set([...SAMPLER_UNITS, activeUnit])].map((unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    return { unit, texture: gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null };
  });
  gl.activeTexture(gl.TEXTURE0 + activeUnit);

  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
    activeUnit,
    textureUnits,
    switches: [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST].map((capability) => ({
      capability,
      isOn: gl.isEnabled(capability),
    })),
    scissor: gl.getParameter(gl.SCISSOR_BOX) as Int32Array,
    colorMask: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
    blend: [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].map(
      (name) => gl.getParameter(name) as number,
    ),
  };
}

function restoreGlState(gl: WebGL2RenderingContext, saved: SavedGlState): void {
  gl.useProgram(saved.program);
  gl.bindVertexArray(saved.vertexArray);

  for (const { unit, texture } of saved.textureUnits) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  gl.activeTexture(gl.TEXTURE0 + saved.activeUnit);

  for (const { capability, isOn } of saved.switches) {
    if (isOn) gl.enable(capability);
    else gl.disable(capability);
  }

  gl.scissor(saved.scissor[0], saved.scissor[1], saved.scissor[2], saved.scissor[3]);
  gl.colorMask(saved.colorMask[0], saved.colorMask[1], saved.colorMask[2], saved.colorMask[3]);
  gl.blendFuncSeparate(saved.blend[0], saved.blend[1], saved.blend[2], saved.blend[3]);
}

function viewBoundsOf(map: MapLibreMap): ViewBounds {
  const bounds = map.getBounds();
  return {
    west: (bounds.getWest() + 180) / 360,
    east: (bounds.getEast() + 180) / 360,
    north: mercatorY(Math.min(bounds.getNorth(), WEB_MERCATOR_MAX_LAT_DEG)),
    south: mercatorY(Math.max(bounds.getSouth(), -WEB_MERCATOR_MAX_LAT_DEG)),
  };
}

function radiansOf(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
