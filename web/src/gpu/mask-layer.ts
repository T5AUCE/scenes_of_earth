/** Draw the area outside a scene as one untiled custom layer, filled even-odd on the GPU. */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

import { WORLD_WIDTH_DEG } from "../label-filter";
import { mercY } from "../render/mercator";
import { deleteResources, linkProgram } from "./gl";
import { localMatrix } from "./grid-geometry";

/** What createMaskLayers needs to place the mask and report on it. */
export interface MaskOptions {
  /**
   * The scene area's closed rings of longitude and latitude in the scene's world copy. The mask
   * covers whatever lies inside an even number of them, so lakes stay covered and the islands
   * in them show again.
   */
  rings: number[][][];
  /** The page background as a hex colour, which is what the mask is painted with. */
  color: string;
  opacity: number;
  /** Called once, outside any draw, when the layer can no longer draw. */
  onFail(error: Error): void;
}

type Point = [number, number];

/** A run of vertices that a triangle fan draws, starting at its centre. */
interface Fan {
  first: number;
  count: number;
}

/** The vertices of every fan, in world units relative to the area's centre. */
export interface MaskGeometry {
  /** The area's centre in world units, where the whole world is 1 wide. */
  origin: Point;
  vertices: Float32Array;
  outlines: Fan[];
  /** The first of the four corners of a quad that covers the clip space. */
  quadFirst: number;
}

interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  stencil: WebGLRenderbuffer;
  width: number;
  height: number;
}

interface MaskGpu {
  fillProgram: WebGLProgram;
  compositeProgram: WebGLProgram;
  fillMatrix: WebGLUniformLocation | null;
  fillColor: WebGLUniformLocation | null;
  compositeMask: WebGLUniformLocation | null;
  compositeOpacity: WebGLUniformLocation | null;
  vertexArray: WebGLVertexArrayObject;
  vertices: WebGLBuffer;
  maxTextureSize: number;
  target: Target | null;
  scale: number;
}

// Neighbouring copies cover a camera that wraps past the scene.
const WORLD_COPIES = [-1, 0, 1];
// Web Mercator tiles end at this latitude, so rings reaching a pole stay finite.
const MAX_LATITUDE_DEG = 85.051129;

const FLOATS_PER_VERTEX = 2;
const CLIP_QUAD = [-1, -1, 1, -1, -1, 1, 1, 1];
const QUAD_VERTICES = CLIP_QUAD.length / FLOATS_PER_VERTEX;
const POSITION_LOCATION = 0;
const EXTENT: [number, number] = [1, 1];
const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

// The mask is drawn at this multiple of the canvas and averaged down, which softens its edge.
const SUPERSAMPLE = 2;
const ODD_BIT = 1;
const ALL_STENCIL_BITS = 0xff;
const COLOR_MAX = 255;
const HEX_SHORT_DIGITS = 3;
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const FILL_VERTEX = `#version 300 es
layout(location = ${POSITION_LOCATION}) in vec2 aPosition;
uniform mat4 uMatrix;

void main() {
  gl_Position = uMatrix * vec4(aPosition, 0.0, 1.0);
}
`;

const FILL_FRAGMENT = `#version 300 es
precision mediump float;
uniform vec3 uColor;
out vec4 outColor;

void main() {
  outColor = vec4(uColor, 1.0);
}
`;

// Each canvas pixel sits between four texels, so the linear lookup averages them.
const COMPOSITE_VERTEX = `#version 300 es
layout(location = ${POSITION_LOCATION}) in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D uMask;
uniform float uOpacity;
in vec2 vUv;
out vec4 outColor;

void main() {
  outColor = texture(uMask, vUv) * uOpacity;
}
`;

/**
 * Cover everything outside the rings with the page background, without tiles. The rings are
 * filled into an offscreen stencil before the map draws, by flipping one bit per fan so that
 * nesting decides what is outside, and the result is composited once at each layer's opacity.
 * One layer per id is returned, and all of them share one target, so the fill is drawn once
 * per frame and only when the camera moved. At 2x that target costs about 20 bytes per canvas
 * pixel, which is 41 MB at 1920 x 1080. Programs and the target are built on the
 * first frame even at zero opacity, so a failure shows before anything is revealed. Setters
 * take effect on the next frame.
 */
export function createMaskLayers(options: MaskOptions, ids: string[]) {
  const fill = new MaskFill(options);

  return ids.map((id) => {
    const layer = new MaskLayer(id, fill, options.opacity);

    return {
      layer: layer as CustomLayerInterface,
      setOpacity: (opacity: number) => layer.setOpacity(opacity),
    };
  });
}

/** Lay out the rings and the clip quad as vertices around the area. */
export function buildMaskGeometry(rings: number[][][]): MaskGeometry {
  const outlines = rings.map((ring) => ring.map(worldPoint));
  const origin = centreOf(outlines.flat());
  const vertices: number[] = [];

  const fans = outlines.map((outline) => addFan(vertices, origin, outline));
  const quadFirst = vertices.length / FLOATS_PER_VERTEX;
  vertices.push(...CLIP_QUAD);

  return { origin, vertices: Float32Array.from(vertices), outlines: fans, quadFirst };
}

function worldPoint([longitude, latitude]: number[]): Point {
  const clamped = Math.max(-MAX_LATITUDE_DEG, Math.min(MAX_LATITUDE_DEG, latitude));

  return [
    (longitude + WORLD_WIDTH_DEG / 2) / WORLD_WIDTH_DEG,
    0.5 - mercY(clamped) / (2 * Math.PI),
  ];
}

function centreOf(points: Point[]): Point {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);

  return [
    (xs.reduce((a, b) => Math.min(a, b)) + xs.reduce((a, b) => Math.max(a, b))) / 2,
    (ys.reduce((a, b) => Math.min(a, b)) + ys.reduce((a, b) => Math.max(a, b))) / 2,
  ];
}

/**
 * Append a fan from the origin over a closed ring. Positions are stored relative to the origin
 * because a single-precision world position would be off by pixels at high zoom.
 */
function addFan(vertices: number[], origin: Point, points: Point[]): Fan {
  const first = vertices.length / FLOATS_PER_VERTEX;
  vertices.push(0, 0);
  for (const [x, y] of points) vertices.push(x - origin[0], y - origin[1]);

  return { first, count: vertices.length / FLOATS_PER_VERTEX - first };
}

class MaskLayer implements CustomLayerInterface {
  readonly type = "custom";
  readonly renderingMode = "2d";

  private map: MapLibreMap | null = null;
  private opacity: number;
  // Set by the offscreen draw, so that the composite never shows a frame the map did not ask for.
  private isMaskDrawn = false;

  constructor(
    readonly id: string,
    private readonly fill: MaskFill,
    opacity: number,
  ) {
    this.opacity = opacity;
  }

  setOpacity(opacity: number) {
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap) {
    this.map = map;
    this.fill.addUser();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.isMaskDrawn = false;
    this.fill.removeUser(gl);
    this.map = null;
  }

  prerender(gl: WebGL2RenderingContext, input: CustomRenderMethodInput) {
    this.isMaskDrawn = false;
    // A frame can arrive between the real loss and its event, when nothing can be drawn or read.
    if (gl.isContextLost()) return;

    const isVisible = this.opacity > 0;
    this.isMaskDrawn = this.fill.prepare(gl, input.defaultProjectionData.mainMatrix, isVisible);
  }

  render(gl: WebGL2RenderingContext) {
    const gpu = this.fill.gpu;
    const target = gpu?.target;
    if (!this.isMaskDrawn || !gpu || !target) return;

    const { compositeProgram, compositeMask, compositeOpacity, vertexArray } = gpu;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(compositeProgram);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindSampler(0, null);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(compositeMask, 0);
    gl.uniform1f(compositeOpacity, this.opacity);
    gl.drawArrays(gl.TRIANGLE_STRIP, this.fill.geometry.quadFirst, QUAD_VERTICES);
    gl.bindVertexArray(null);
  }
}

/** The GPU objects and the filled target that every layer of one mask composites. */
class MaskFill {
  gpu: MaskGpu | null = null;
  readonly geometry: MaskGeometry;

  private readonly options: MaskOptions;
  private readonly color: Float32Array;
  private isFailed = false;
  private users = 0;
  // The matrix the target was last filled for, so an unmoved camera needs no new fill.
  private filledMatrix: Float64Array | null = null;

  constructor(options: MaskOptions) {
    this.options = options;
    this.color = Float32Array.from(colorChannels(options.color));
    this.geometry = buildMaskGeometry(options.rings);
  }

  addUser() {
    this.users++;
  }

  removeUser(gl: WebGL2RenderingContext) {
    this.users--;
    if (this.users === 0) this.release(gl);
  }

  /** Make the target current and report whether it holds the mask for this frame. */
  prepare(gl: WebGL2RenderingContext, mainMatrix: ArrayLike<number>, isVisible: boolean) {
    if (this.isFailed) return false;

    // The common frame needs no GL state read: the target fits and is already filled.
    const gpu = this.gpu;
    if (gpu && this.hasTargetForCanvas(gl, gpu) && (!isVisible || this.isFilledFor(mainMatrix))) {
      return isVisible;
    }

    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    try {
      const gpu = (this.gpu ??= this.build(gl));
      this.ensureTarget(gl, gpu);
      if (!isVisible) return false;
      if (!this.isFilledFor(mainMatrix)) this.fillTarget(gl, gpu, mainMatrix);

      return true;
    } catch (error) {
      this.fail(error as Error);

      return false;
    } finally {
      this.restoreState(gl, framebuffer, viewport);
    }
  }

  private build(gl: WebGL2RenderingContext): MaskGpu {
    const programs: WebGLProgram[] = [];
    const vertexArray = gl.createVertexArray();
    const vertices = gl.createBuffer();
    try {
      if (!vertexArray || !vertices) throw new Error("Cannot allocate geometry for the mask");

      const fillProgram = linkProgram(gl, FILL_VERTEX, FILL_FRAGMENT);
      programs.push(fillProgram);
      const compositeProgram = linkProgram(gl, COMPOSITE_VERTEX, COMPOSITE_FRAGMENT);
      programs.push(compositeProgram);
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      gl.bufferData(gl.ARRAY_BUFFER, this.geometry.vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(POSITION_LOCATION);
      gl.vertexAttribPointer(POSITION_LOCATION, FLOATS_PER_VERTEX, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      return {
        fillProgram,
        compositeProgram,
        fillMatrix: gl.getUniformLocation(fillProgram, "uMatrix"),
        fillColor: gl.getUniformLocation(fillProgram, "uColor"),
        compositeMask: gl.getUniformLocation(compositeProgram, "uMask"),
        compositeOpacity: gl.getUniformLocation(compositeProgram, "uOpacity"),
        vertexArray,
        vertices,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        target: null,
        scale: SUPERSAMPLE,
      };
    } catch (error) {
      deleteResources(gl, { programs, buffers: [vertices], vertexArrays: [vertexArray] });
      throw error;
    }
  }

  private targetSize(gl: WebGL2RenderingContext, gpu: MaskGpu) {
    const scale = Math.min(
      gpu.scale,
      gpu.maxTextureSize / Math.max(gl.drawingBufferWidth, gl.drawingBufferHeight),
    );

    return {
      width: Math.max(1, Math.floor(gl.drawingBufferWidth * scale)),
      height: Math.max(1, Math.floor(gl.drawingBufferHeight * scale)),
    };
  }

  private hasTargetForCanvas(gl: WebGL2RenderingContext, gpu: MaskGpu) {
    const { width, height } = this.targetSize(gl, gpu);

    return gpu.target?.width === width && gpu.target.height === height;
  }

  private ensureTarget(gl: WebGL2RenderingContext, gpu: MaskGpu) {
    if (this.hasTargetForCanvas(gl, gpu)) return;

    const { width, height } = this.targetSize(gl, gpu);
    this.releaseTarget(gl, gpu);
    try {
      gpu.target = createTarget(gl, width, height);
    } catch (error) {
      // A canvas-sized target costs a quarter of the memory, so it can succeed where 2x cannot.
      if (gpu.scale === 1) throw error;

      gpu.scale = 1;
      this.ensureTarget(gl, gpu);
    }
  }

  private releaseTarget(gl: WebGL2RenderingContext, gpu: MaskGpu) {
    const { target } = gpu;
    gpu.target = null;
    this.filledMatrix = null;
    if (!target) return;

    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteRenderbuffer(target.stencil);
    deleteResources(gl, { textures: [target.texture] });
  }

  private isFilledFor(mainMatrix: ArrayLike<number>) {
    const filled = this.filledMatrix;

    return filled !== null && filled.every((value, index) => value === mainMatrix[index]);
  }

  /** Flip a stencil bit once per fan, then paint the covered pixels into the target. */
  private fillTarget(gl: WebGL2RenderingContext, gpu: MaskGpu, mainMatrix: ArrayLike<number>) {
    const target = gpu.target!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(ALL_STENCIL_BITS);
    gl.clearColor(0, 0, 0, 0);
    // Every pixel starts odd, so only the pixels inside the area's rings end up even.
    gl.clearStencil(ODD_BIT);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    gl.useProgram(gpu.fillProgram);
    gl.bindVertexArray(gpu.vertexArray);
    this.flipStencil(gl, gpu, mainMatrix);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, ODD_BIT, ODD_BIT);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.uniformMatrix4fv(gpu.fillMatrix, false, IDENTITY);
    gl.uniform3fv(gpu.fillColor, this.color);
    gl.drawArrays(gl.TRIANGLE_STRIP, this.geometry.quadFirst, QUAD_VERTICES);
    this.filledMatrix ??= new Float64Array(mainMatrix.length);
    this.filledMatrix.set(mainMatrix);
  }

  private flipStencil(gl: WebGL2RenderingContext, gpu: MaskGpu, mainMatrix: ArrayLike<number>) {
    const { origin, outlines } = this.geometry;
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, ODD_BIT);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.stencilMask(ODD_BIT);
    for (const worldOffset of WORLD_COPIES) {
      const matrix = localMatrix(mainMatrix, { origin, extent: EXTENT }, worldOffset);
      gl.uniformMatrix4fv(gpu.fillMatrix, false, matrix);
      for (const { first, count } of outlines) gl.drawArrays(gl.TRIANGLE_FAN, first, count);
    }
  }

  private fail(error: Error) {
    this.isFailed = true;
    queueMicrotask(() => this.options.onFail(error));
  }

  private restoreState(
    gl: WebGL2RenderingContext,
    framebuffer: WebGLFramebuffer | null,
    viewport: Int32Array,
  ) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(ALL_STENCIL_BITS);
    gl.bindVertexArray(null);
  }

  private release(gl: WebGL2RenderingContext) {
    const { gpu } = this;
    this.gpu = null;
    if (!gpu) return;

    this.releaseTarget(gl, gpu);
    deleteResources(gl, {
      programs: [gpu.fillProgram, gpu.compositeProgram],
      buffers: [gpu.vertices],
      vertexArrays: [gpu.vertexArray],
    });
  }
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const framebuffer = gl.createFramebuffer();
  const texture = gl.createTexture();
  const stencil = gl.createRenderbuffer();
  const free = () => {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteRenderbuffer(stencil);
    deleteResources(gl, { textures: [texture] });
  };
  if (!framebuffer || !texture || !stencil) {
    free();
    throw new Error("Cannot allocate a framebuffer for the mask");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, width, height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
  // A failed allocation leaves an attachment without storage, which makes the status incomplete.
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    free();
    throw new Error(`Cannot build a ${width} x ${height} framebuffer for the mask`);
  }

  return { framebuffer, texture, stencil, width, height };
}

function colorChannels(hex: string): [number, number, number] {
  const digits = HEX_COLOR.exec(hex.trim())?.[1];
  if (!digits) throw new Error(`The mask needs a hex colour, not "${hex}"`);

  const isShort = digits.length === HEX_SHORT_DIGITS;
  const full = isShort ? [...digits].map((digit) => digit + digit).join("") : digits;
  const [red, green, blue] = [0, 2, 4].map((start) => parseInt(full.slice(start, start + 2), 16));

  return [red / COLOR_MAX, green / COLOR_MAX, blue / COLOR_MAX];
}
