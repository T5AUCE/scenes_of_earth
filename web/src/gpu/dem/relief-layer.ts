/** Terrain shading drawn on the GPU from the shared DEM textures instead of raster tiles. */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

import type { Bbox } from "../../types";
import { deleteResources, linkProgram } from "../gl";
import { keepThroughContextLoss, timedGpuDraw } from "../tiled-layer";
import {
  DEM_VERTEX_SHADER,
  DemDraw,
  hasLinearHeights,
  type DemDrawOptions,
  type DrawSource,
} from "./draw";
import { demSlopeScale, reliefExaggeration, RELIEF_FRAGMENT_SHADER } from "./relief-shaders";

/** What the relief layer needs to find its tiles and place them. */
export interface ReliefLayerOptions {
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
  strength: number;
  /** Called once, outside any draw, when the layer can no longer draw. */
  onFail(error: Error): void;
  poolOptions?: DemDrawOptions["poolOptions"];
}

const RELIEF_UNIFORM_NAMES = ["uSlopeScale", "uExaggeration"];

/** A custom layer that shades relief from the DEM pool at the zoom's sharp level. */
export class ReliefLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "2d";

  private readonly options: ReliefLayerOptions;
  private readonly draw: DemDraw;
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private strength: number;
  private isFailed = false;

  constructor(options: ReliefLayerOptions) {
    this.options = options;
    this.id = options.id;
    this.strength = options.strength;
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
      if (!hasLinearHeights(gl)) throw new Error("Relief needs linear filtering of float textures");

      this.program = linkProgram(gl, DEM_VERTEX_SHADER, RELIEF_FRAGMENT_SHADER);
      this.uniforms = new Map(
        RELIEF_UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(this.program!, name)]),
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

  /** Change the strength without touching a tile, because it is only a uniform. */
  setStrength(strength: number): void {
    this.strength = strength;
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

    this.draw.warmDraw(gl, () => this.setState(gl, program, map.getZoom()));

    return this.draw.loadBase(gl);
  }

  render(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): void {
    const { map, program } = this;
    if (!map || !program || this.isFailed) return;

    try {
      this.setState(gl, program, map.getZoom());

      let needsRepaint = false;
      timedGpuDraw(gl, this.id, () => {
        needsRepaint = this.draw.draw(gl, input.defaultProjectionData.mainMatrix, (sources) =>
          this.setSlopeScales(gl, sources),
        );
      });

      if (needsRepaint) map.triggerRepaint();
    } catch (error) {
      this.fail(error as Error);
    } finally {
      gl.bindVertexArray(null);
    }
  }

  private setState(gl: WebGL2RenderingContext, program: WebGLProgram, zoom: number): void {
    gl.useProgram(program);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    // The shader writes premultiplied colour, so the basemap shows through what it leaves.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const exaggeration = reliefExaggeration(zoom, this.strength);
    gl.uniform1f(this.uniforms.get("uExaggeration") ?? null, exaggeration);
  }

  private setSlopeScales(gl: WebGL2RenderingContext, [first, second]: DrawSource[]): void {
    gl.uniform2f(
      this.uniforms.get("uSlopeScale") ?? null,
      demSlopeScale(first.tile.z),
      second ? demSlopeScale(second.tile.z) : 0,
    );
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

/** The control a terrain view keeps over its relief layer. */
export interface ReliefHandle {
  setStrength(strength: number): void;
  setBaseZoom(zoom: number): void;
  prepare(): boolean;
  destroy(): void;
}

/** Add a relief layer before an anchor and keep it through a WebGL context loss. */
export function addReliefLayer(
  options: ReliefLayerOptions,
  beforeId: string | undefined,
): ReliefHandle {
  const { map } = options;
  const layer = new ReliefLayer(options);
  map.addLayer(layer, beforeId);

  // The keeper removes the layer on capture, before the pool hears of the loss.
  const stopKeeping = keepThroughContextLoss(map, layer, beforeId);

  return {
    setStrength: (strength) => layer.setStrength(strength),
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
