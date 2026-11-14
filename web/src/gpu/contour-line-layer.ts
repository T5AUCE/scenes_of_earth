/** Contour lines drawn on the GPU from the shared DEM textures instead of vector tiles. */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

import type { ContourLadder } from "../contour-ladder";
import { hexToRgb } from "../render/palettes";
import type { Bbox } from "../types";
import {
  CONTOUR_FRAGMENT_SHADER,
  fillTierAlphas,
  MAX_TIERS,
  tierUniformsOf,
  type TierUniforms,
} from "./contour-shaders";
import {
  DEM_VERTEX_SHADER,
  DemDraw,
  hasLinearHeights,
  type DemDrawOptions,
} from "./dem-draw";
import { deleteResources, linkProgram } from "./gl";
import { keepThroughContextLoss, timedGpuDraw } from "./tiled-layer";

const COLOUR_CHANNEL_MAX = 255;

/** What the contour layer needs to find its tiles, place them and draw the ladder. */
export interface ContourLineLayerOptions {
  map: MapLibreMap;
  id: string;
  /** A url template with `{z}`, `{x}` and `{y}`. */
  tileUrl: string;
  /** The scene's bbox. */
  bbox: Bbox;
  /** Longitude offset of the scene's world copy. */
  shift: number;
  maxZoom: number;
  /** The zoom the scene fits at; the scene refits it through `setBaseZoom` after entry. */
  fitZoom: number;
  ladder: ContourLadder;
  elevationUnit: string;
  /** A #rrggbb colour. */
  color: string;
  /** Called once, outside any draw, when the layer can no longer draw. */
  onFail(error: Error): void;
  poolOptions?: DemDrawOptions["poolOptions"];
}

const CONTOUR_UNIFORM_NAMES = [
  "uIntervals",
  "uTierAlpha",
  "uTierWidth",
  "uPixelRatio",
  "uColour",
];

/** A custom layer that draws the contour ladder from the DEM pool at the zoom's sharp level. */
export class ContourLineLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";

  private readonly options: ContourLineLayerOptions;
  private readonly draw: DemDraw;
  private readonly alphas = new Float32Array(MAX_TIERS);
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private tiers: TierUniforms;
  private colour: [number, number, number];
  private isFailed = false;

  constructor(options: ContourLineLayerOptions) {
    this.options = options;
    this.id = options.id;
    this.tiers = tierUniformsOf(options.ladder, options.elevationUnit);
    this.colour = colourChannels(options.color);
    this.draw = new DemDraw({
      map: options.map,
      tileUrl: options.tileUrl,
      bbox: shiftedBbox(options.bbox, options.shift),
      maxZoom: options.maxZoom,
      fitZoom: options.fitZoom,
      poolOptions: options.poolOptions,
    });
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    try {
      if (!hasLinearHeights(gl)) {
        throw new Error("Contours need linear filtering of float textures");
      }

      this.program = linkProgram(gl, DEM_VERTEX_SHADER, CONTOUR_FRAGMENT_SHADER);
      this.uniforms = new Map(
        CONTOUR_UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(this.program!, name)]),
      );
      this.draw.attach(gl, this.program);
    } catch (error) {
      this.release();
      this.fail(error as Error);
    }
  }

  onRemove(): void {
    this.release();
    this.map = null;
    this.gl = null;
  }

  /** Switch to another ladder or unit without touching a tile, because both are uniforms. */
  setLadder(ladder: ContourLadder, elevationUnit: string): void {
    this.tiers = tierUniformsOf(ladder, elevationUnit);
    this.map?.triggerRepaint();
  }

  setColor(color: string): void {
    this.colour = colourChannels(color);
    this.map?.triggerRepaint();
  }

  /** Refit the pinned base to the zoom the scene fits at. */
  setBaseZoom(zoom: number): void {
    this.draw.setFitZoom(zoom);
    this.map?.triggerRepaint();
  }

  /**
   * Warm the program and load the pinned tiles while the layer is hidden. Returns whether no
   * tile is left to load, and true for a layer that cannot draw, which entry never waits for.
   */
  prepare(): boolean {
    const { gl, map, program } = this;
    if (!gl || !map || !program || this.isFailed) return true;

    this.draw.warmDraw(gl, () => this.setState(gl, program, map.getPixelRatio()));
    return this.draw.loadBase(gl);
  }

  render(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): void {
    const { map, program } = this;
    if (!map || !program || this.isFailed) return;
    if (!fillTierAlphas(this.alphas, this.tiers.entryZooms, map.getZoom())) return;

    try {
      this.setState(gl, program, map.getPixelRatio());
      let needsRepaint = false;
      timedGpuDraw(gl, this.id, () => {
        needsRepaint = this.draw.draw(gl, input.defaultProjectionData.mainMatrix);
      });
      if (needsRepaint) map.triggerRepaint();
    } catch (error) {
      this.fail(error as Error);
    } finally {
      gl.bindVertexArray(null);
    }
  }

  private setState(gl: WebGL2RenderingContext, program: WebGLProgram, pixelRatio: number): void {
    gl.useProgram(program);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    // The shader writes premultiplied colour, so the relief and basemap show through the gaps.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1fv(this.uniform("uIntervals"), this.tiers.intervalsM);
    gl.uniform1fv(this.uniform("uTierAlpha"), this.alphas);
    gl.uniform1fv(this.uniform("uTierWidth"), this.tiers.widthsPx);
    gl.uniform1f(this.uniform("uPixelRatio"), pixelRatio);
    gl.uniform3f(this.uniform("uColour"), ...this.colour);
  }

  private uniform(name: string): WebGLUniformLocation | null {
    return this.uniforms.get(name) ?? null;
  }

  private release(): void {
    const { gl, program } = this;
    this.program = null;
    if (!gl) return;

    this.draw.detach(gl);
    deleteResources(gl, { programs: [program] });
  }

  private fail(error: Error): void {
    if (this.isFailed) return;

    this.isFailed = true;
    queueMicrotask(() => this.options.onFail(error));
  }
}

/** The control a terrain view keeps over its contour layer. */
export interface ContourLineHandle {
  setLadder(ladder: ContourLadder, elevationUnit: string): void;
  setColor(color: string): void;
  setBaseZoom(zoom: number): void;
  prepare(): boolean;
  destroy(): void;
}

/** Add a contour layer before an anchor and keep it through a WebGL context loss. */
export function addContourLineLayer(
  options: ContourLineLayerOptions,
  beforeId: string | undefined,
): ContourLineHandle {
  const { map } = options;
  const layer = new ContourLineLayer(options);
  map.addLayer(layer, beforeId);
  // The keeper removes the layer on capture, before the pool hears of the loss.
  const stopKeeping = keepThroughContextLoss(map, layer, beforeId);
  return {
    setLadder: (ladder, elevationUnit) => layer.setLadder(ladder, elevationUnit),
    setColor: (color) => layer.setColor(color),
    setBaseZoom: (zoom) => layer.setBaseZoom(zoom),
    prepare: () => layer.prepare(),
    destroy: () => {
      stopKeeping();
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    },
  };
}

function shiftedBbox(bbox: Bbox, shift: number): Bbox {
  return [bbox[0] + shift, bbox[1], bbox[2] + shift, bbox[3]];
}

function colourChannels(hex: string): [number, number, number] {
  const [red, green, blue] = hexToRgb(hex);
  return [red / COLOUR_CHANNEL_MAX, green / COLOUR_CHANNEL_MAX, blue / COLOUR_CHANNEL_MAX];
}
