/** Draw tiled categorical class fills with their optional outline through the GPU lifecycle. */
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

import { addressSearch, gestureFlags, subscribeGesture } from "../gesture-quality";
import {
  BAND_BYTES_PER_CELL,
  bakeBandInto,
  CLASS_FIELD_VERTEX,
  classFieldFragment,
  FILL_OUTLINE_STRENGTH,
  homogeneousFlags,
  homogeneousWindow,
  isBandParityMismatched,
  markThinCells,
} from "./class-field-shaders";
import { deleteResources, uploadTexture } from "./gl";
import { WIDE_HALO_CELLS } from "./grid-geometry";
import {
  TiledGpuLayer,
  type TiledGpu,
  type TiledLayerOptions,
  type TiledProgram,
  timedGpuDraw,
} from "./tiled-layer";

/** How the edges between classes are drawn. */
export interface ClassEdges {
  /** Blend competing classes from the kernel instead of painting the nearest cell. */
  smooth: boolean;
  /** Blend bilinear weights towards a cubic B-spline, capped at 0.6 by the viewer. */
  rounding: number;
  /** The width of the colour blend between two classes in grid cells; 0 keeps a one-pixel edge. */
  softnessCells: number;
  /** Wider class-presence scale in grid cells with support twice the radius. */
  smoothRadiusCells?: number;
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
  bandTiles: BandTileTextures[];
}

/** One tile's baked band textures, uploaded beside the ids and flags windows. */
interface BandTileTextures {
  ids: WebGLTexture;
  low: WebGLTexture;
  high: WebGLTexture;
}

const PALETTE_SIZE = 256;
const CHANNELS = 4;
const BAND_IDS_UNIT = 4;
const BAND_LOW_UNIT = 5;
const BAND_HIGH_UNIT = 6;
// One bake slice stays well under a 60 Hz frame so tiles keep drawing the full path meanwhile.
const BAKE_SLICE_MS = 4;
// A busy page still gets a slice after this wait so the bake cannot starve.
const BAKE_IDLE_TIMEOUT_MS = 1000;
const UNIFORM_NAMES = [
  "uIds",
  "uHomogeneous",
  "uPalette",
  "uIdsSize",
  "uWindowRow",
  "uSmooth",
  "uRounding",
  "uSoftnessCells",
  "uSmoothRadiusCells",
  "uOutline",
  "uOutlineStrength",
  "uOpacity",
  "uPixelRatio",
];
const BAKE_UNIFORM_NAMES = ["uBandIds", "uBandLow", "uBandHigh", "uBake"];

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
    bakeSettled: () => layer.bakeSettled(),
  };
}

class ClassFieldLayer extends TiledGpuLayer<Gpu> {
  private ids: Uint8Array | null = null;
  private flags: Uint8Array | null = null;
  private flagsWindow: { first: number; span: number } | null = null;
  private bandIds: Uint8Array | null = null;
  private bandLow: Uint32Array | null = null;
  private bandHigh: Uint32Array | null = null;
  private isBandReady = false;
  private bakeGeneration = 0;
  private bakePromise: Promise<void> | null = null;
  private bakeResolve: (() => void) | null = null;
  private cancelBakeSlice: (() => void) | null = null;
  private bakeMs = 0;
  private bakeCpuBytes = 0;
  private bakeGpuBytes = 0;
  private paletteBytes = new Uint8Array(PALETTE_SIZE * CHANNELS);
  private edges: ClassEdges;
  private isIdsStale = false;
  private isBandStale = false;
  private isPaletteStale = true;
  private isGestureFast = false;
  private isRemoved = false;
  private stopGesture: (() => void) | null = null;
  private readonly fieldOptions: ClassFieldOptions;
  // Captured here because scene entry replaces the address and drops trial flags.
  private readonly fastAllowed = gestureFlags(addressSearch()).fastClass;
  private readonly bakeAllowed: boolean;

  constructor(options: ClassFieldOptions) {
    const bakeAllowed = gestureFlags(addressSearch()).bake;
    super(options, classFieldProgram(bakeAllowed));
    this.fieldOptions = options;
    this.edges = options.edges;
    this.bakeAllowed = bakeAllowed;
  }

  override onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    super.onAdd(map, gl);
    this.isRemoved = false;
    this.scheduleBandBuild();
    if (!this.fastAllowed || this.stopGesture) return;
    this.stopGesture = subscribeGesture(map, {
      onStart: () => this.setGestureFast(true),
      onEnd: () => this.setGestureFast(false),
    });
  }

  override onRemove() {
    this.stopGesture?.();
    this.stopGesture = null;
    this.isRemoved = true;
    this.clearBand();
    super.onRemove();
  }

  setIds(ids: Uint8Array) {
    this.ids = ids;
    this.flags = null;
    this.clearBand();
    this.buildMissingFlags();
    this.scheduleBandBuild();
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

  /**
   * Ease the edges while the camera moves and restore them on moveend. The fast path only
   * overrides the draw uniforms, so no companion texture is rebuilt and the user's own edge
   * settings apply again untouched once the gesture ends.
   */
  setGestureFast(isFast: boolean) {
    if (isFast === this.isGestureFast) return;
    this.isGestureFast = isFast;
    this.map?.triggerRepaint();
  }

  setEdges(edges: ClassEdges) {
    const hadFlags = this.needsFlags();
    const hadBake = this.isBakeReady();
    this.edges = edges;
    // A radius crossing the stride threshold needs a new flag window, so drop the cached pair.
    if (this.flags !== null && !sameWindow(this.flagsWindow, this.wantedWindow())) {
      this.flags = null;
      this.clearBand();
    }
    const hadBuiltFlags = this.flags !== null;
    this.buildMissingFlags();
    this.scheduleBandBuild();
    // A new companion texture needs an upload, while a radius change within use does not.
    if (this.ids && (hadFlags !== this.needsFlags() || (!hadBuiltFlags && this.flags !== null))) {
      this.isIdsStale = true;
    }
    if (this.ids && hadBake !== this.isBakeReady() && this.isBakeReady()) {
      this.isIdsStale = true;
    }
    this.map?.triggerRepaint();
  }

  /** Resolve when the pending band build finishes so tests can draw the baked path. */
  bakeSettled(): Promise<void> {
    return this.bakePromise ?? Promise.resolve();
  }

  private needsFlags(): boolean {
    return this.edges.smooth && (this.edges.smoothRadiusCells ?? 0) > 0;
  }

  private needsBake(): boolean {
    return this.bakeAllowed && this.needsFlags();
  }

  private isBakeReady(): boolean {
    return this.needsBake() && this.isBandReady && this.bandIds !== null;
  }

  private wantedWindow(): { first: number; span: number } | null {
    if (!this.needsFlags()) return null;
    return homogeneousWindow(this.edges.smoothRadiusCells);
  }

  private buildMissingFlags(): void {
    if (!this.ids || this.flags || !this.needsFlags()) return;

    // Flags are built at load so the draw frame only uploads the cached textures.
    // Colours reuse the flags untouched because only ids and the radius feed them.
    const { nx, ny } = this.options.grid;
    const radius = this.edges.smoothRadiusCells ?? 0;
    this.flags = homogeneousFlags(this.ids, nx, ny, radius);
    markThinCells(this.ids, nx, ny, this.flags);
    this.flagsWindow = homogeneousWindow(radius);
  }

  private clearBand(): void {
    this.bakeGeneration += 1;
    this.cancelBakeSlice?.();
    this.cancelBakeSlice = null;
    this.bandIds = null;
    this.bandLow = null;
    this.bandHigh = null;
    this.isBandReady = false;
    this.isBandStale = false;
    this.bakeCpuBytes = 0;
    this.bakeGpuBytes = 0;
    clearBakeStats(this.id);
    this.bakeResolve?.();
    this.bakePromise = null;
    this.bakeResolve = null;
  }

  private scheduleBandBuild(): void {
    if (!this.needsBake() || !this.ids || !this.flags || this.isBandReady) return;
    if (this.bakePromise || this.isRemoved) return;

    const generation = ++this.bakeGeneration;
    const { nx, ny } = this.options.grid;
    const radius = this.edges.smoothRadiusCells ?? 0;
    const cells = this.ids;
    const flags = this.flags;
    const count = Math.max(0, nx) * Math.max(0, ny);
    let band: { ids: Uint8Array; low: Uint32Array; high: Uint32Array } | null = null;
    let nextRow = 0;
    let cpuMs = 0;
    this.bakePromise = new Promise<void>((done) => {
      this.bakeResolve = done;
    });
    const step = (budgetMs: number): void => {
      this.cancelBakeSlice = null;
      if (generation !== this.bakeGeneration) return;

      const start = performance.now();
      // The allocation waits for the first slice so loading the ids stays cheap.
      band ??= {
        ids: new Uint8Array(count * 2),
        low: new Uint32Array(count),
        high: new Uint32Array(count),
      };
      do {
        const { ids, low, high } = band;
        bakeBandInto(cells, nx, ny, radius, flags, ids, low, high, nextRow, nextRow + 1);
        nextRow += 1;
      } while (nextRow < ny && performance.now() - start < budgetMs);
      cpuMs += performance.now() - start;
      if (nextRow < ny) {
        this.cancelBakeSlice = scheduleIdle(step);
        return;
      }

      this.bandIds = band.ids;
      this.bandLow = band.low;
      this.bandHigh = band.high;
      this.isBandReady = true;
      this.bakeMs = cpuMs;
      this.bakeCpuBytes = count * BAND_BYTES_PER_CELL;
      this.publishBakeStats();
      this.isBandStale = true;
      this.map?.triggerRepaint();
      this.bakeResolve?.();
      this.bakePromise = null;
      this.bakeResolve = null;
    };
    this.cancelBakeSlice = scheduleIdle(step);
  }

  private publishBakeStats(): void {
    const stats = bakeStatsScope();
    if (!stats) return;

    stats[this.id] = {
      ms: this.bakeMs,
      cpuBytes: this.bakeCpuBytes,
      gpuBytes: this.bakeGpuBytes,
    };
  }

  protected hasData() {
    return this.ids !== null;
  }

  protected extendGpu(base: TiledGpu): Gpu {
    return { ...base, palette: null, bandTiles: [] };
  }

  protected extraTextures(gpu: Gpu) {
    return [
      gpu.palette,
      ...gpu.bandTiles.flatMap(({ ids, low, high }) => [ids, low, high]),
    ];
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
      // A zero radius never samples the flags, so land cover uploads ids alone.
      const flags = this.needsFlags() ? this.flags! : undefined;
      this.uploadTiles(gl, gpu, this.options.grid, this.ids!, flags, WIDE_HALO_CELLS);
      this.uploadBandTiles(gl, gpu);
      this.isIdsStale = false;
      this.isBandStale = false;
      return;
    }
    if (this.isBandStale) {
      this.uploadBandTiles(gl, gpu);
      this.isBandStale = false;
    }
  }

  private uploadBandTiles(gl: WebGL2RenderingContext, gpu: Gpu): void {
    if (!this.bakeAllowed) return;

    deleteResources(gl, {
      textures: gpu.bandTiles.flatMap(({ ids, low, high }) => [ids, low, high]),
    });
    gpu.bandTiles = [];
    this.bakeGpuBytes = 0;
    if (!this.isBakeReady()) return;

    const radius = this.edges.smoothRadiusCells ?? 0;
    const { nx } = this.options.grid;
    let gpuBytes = 0;
    for (const { tile } of gpu.tiles) {
      const { window } = tile;
      const mismatched = isBandParityMismatched(window.column, window.row, radius);
      const idsWindow = mismatched
        ? complexBandIds(window.width, window.height)
        : bandIdsWindow(this.bandIds!, nx, window);
      const lowWindow = mismatched
        ? complexBandMask(window.width, window.height)
        : bandMaskWindow(this.bandLow!, nx, window);
      const highWindow = mismatched
        ? complexBandMask(window.width, window.height)
        : bandMaskWindow(this.bandHigh!, nx, window);
      let idsTexture: WebGLTexture | null = null;
      let lowTexture: WebGLTexture | null = null;
      let highTexture: WebGLTexture | null = null;
      try {
        idsTexture = uploadTexture(gl, "bandIds", window.width, window.height, idsWindow);
        lowTexture = uploadTexture(gl, "bandMask", window.width, window.height, lowWindow);
        highTexture = uploadTexture(gl, "bandMask", window.width, window.height, highWindow);
      } catch (error) {
        deleteResources(gl, { textures: [idsTexture, lowTexture, highTexture] });
        throw error;
      }
      gpu.bandTiles.push({ ids: idsTexture, low: lowTexture, high: highTexture });
      gpuBytes += window.width * window.height * BAND_BYTES_PER_CELL;
    }
    this.bakeGpuBytes = gpuBytes;
    this.publishBakeStats();
  }

  protected draw(gl: WebGL2RenderingContext, gpu: Gpu, mainMatrix: ArrayLike<number>) {
    const uniform = (name: string) => this.uniform(gpu, name);
    const { rounding, softnessCells, outline } = this.edges;

    this.beginDraw(gl, gpu);
    gl.bindSampler(3, null);
    gl.uniform1i(uniform("uIds"), 0);
    // Unit 0 holds an integer texture, which keeps the unsigned sampler valid without flags.
    gl.uniform1i(uniform("uHomogeneous"), this.needsFlags() ? 2 : 0);
    gl.uniform1i(uniform("uPalette"), 3);
    gl.uniform1i(uniform("uSmooth"), this.edges.smooth && !this.isGestureFast ? 1 : 0);
    gl.uniform1f(uniform("uRounding"), rounding);
    gl.uniform1f(uniform("uSoftnessCells"), softnessCells);
    gl.uniform1f(uniform("uSmoothRadiusCells"), this.edges.smoothRadiusCells ?? 0);
    gl.uniform1i(uniform("uOutline"), outline && !this.isGestureFast ? 1 : 0);
    gl.uniform1f(uniform("uOutlineStrength"), FILL_OUTLINE_STRENGTH);
    gl.uniform1f(uniform("uOpacity"), this.fieldOptions.opacity);
    const pixelRatio = this.map?.getPixelRatio?.() ?? 1;
    gl.uniform1f(uniform("uPixelRatio"), pixelRatio);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, gpu.palette);
    gl.activeTexture(gl.TEXTURE0);
    if (this.bakeAllowed) this.bindBakeUniforms(gl, gpu);

    let tileIndex = 0;
    timedGpuDraw(gl, this.id, () => this.drawTiles(gl, gpu, mainMatrix, ({ window }) => {
      if (this.bakeAllowed) this.bindBandTile(gl, gpu, tileIndex++);
      gl.uniform2i(uniform("uIdsSize"), window.width, window.height);
      gl.uniform1f(uniform("uWindowRow"), window.row);
    }));
  }

  private bindBakeUniforms(gl: WebGL2RenderingContext, gpu: Gpu): void {
    const uniform = (name: string) => this.uniform(gpu, name);
    const baked = this.isBakeReady();
    gl.bindSampler(BAND_IDS_UNIT, null);
    gl.bindSampler(BAND_LOW_UNIT, null);
    gl.bindSampler(BAND_HIGH_UNIT, null);
    // Unit 0 holds an integer texture, which keeps the unsigned samplers valid without a bake.
    gl.uniform1i(uniform("uBandIds"), baked ? BAND_IDS_UNIT : 0);
    gl.uniform1i(uniform("uBandLow"), baked ? BAND_LOW_UNIT : 0);
    gl.uniform1i(uniform("uBandHigh"), baked ? BAND_HIGH_UNIT : 0);
    gl.uniform1i(uniform("uBake"), baked ? 1 : 0);
  }

  private bindBandTile(gl: WebGL2RenderingContext, gpu: Gpu, index: number): void {
    const band = gpu.bandTiles[index];
    if (!band) return;

    gl.activeTexture(gl.TEXTURE0 + BAND_IDS_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, band.ids);
    gl.activeTexture(gl.TEXTURE0 + BAND_LOW_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, band.low);
    gl.activeTexture(gl.TEXTURE0 + BAND_HIGH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, band.high);
    gl.activeTexture(gl.TEXTURE0);
  }
}

function sameWindow(
  first: { first: number; span: number } | null,
  second: { first: number; span: number } | null,
): boolean {
  return first?.first === second?.first && first?.span === second?.span;
}

function bandIdsWindow(
  bandIds: Uint8Array,
  nx: number,
  window: { column: number; row: number; width: number; height: number },
): Uint8Array {
  const cells = new Uint8Array(window.width * window.height * 2);
  for (let row = 0; row < window.height; row++) {
    const source = ((window.row + row) * nx + window.column) * 2;
    cells.set(bandIds.subarray(source, source + window.width * 2), row * window.width * 2);
  }
  return cells;
}

function bandMaskWindow(
  bandMasks: Uint32Array,
  nx: number,
  window: { column: number; row: number; width: number; height: number },
): Uint32Array {
  const cells = new Uint32Array(window.width * window.height);
  for (let row = 0; row < window.height; row++) {
    const source = (window.row + row) * nx + window.column;
    cells.set(bandMasks.subarray(source, source + window.width), row * window.width);
  }
  return cells;
}

/** A window that always falls back because an odd origin would misread the baked taps. */
function complexBandIds(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height * 2);
}

/** All-ones mask marks a complex window so the shader takes the full gather. */
function complexBandMask(width: number, height: number): Uint32Array {
  return new Uint32Array(width * height).fill(0xffffffff);
}

/**
 * Run a bake slice when the page is idle and return a function that cancels it. The slice gets
 * the idle time left, capped at one slice, so a busy frame is never overrun by a long chunk.
 */
function scheduleIdle(slice: (budgetMs: number) => void): () => void {
  const scope = globalThis as unknown as {
    requestIdleCallback?: (
      callback: (deadline: IdleDeadline) => void,
      options: { timeout: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof scope.requestIdleCallback === "function") {
    const handle = scope.requestIdleCallback(
      (deadline) => {
        // A timed-out callback reports no time left, so it still gets a full slice.
        const idleMs = deadline.didTimeout ? BAKE_SLICE_MS : deadline.timeRemaining();
        slice(Math.min(BAKE_SLICE_MS, idleMs));
      },
      { timeout: BAKE_IDLE_TIMEOUT_MS },
    );
    return () => scope.cancelIdleCallback?.(handle);
  }

  const timer = setTimeout(() => slice(BAKE_SLICE_MS), 0);
  return () => clearTimeout(timer);
}

type BakeStatsScope = Record<string, { ms: number; cpuBytes: number; gpuBytes: number }>;

/** The shared dev-readout record, or undefined where globals cannot be written. */
function bakeStatsScope(): BakeStatsScope | undefined {
  try {
    const scope = globalThis as unknown as { __bakeStats?: BakeStatsScope };
    return scope.__bakeStats ??= {};
  } catch {
    // Stats must not break drawing.
    return undefined;
  }
}

function clearBakeStats(id: string): void {
  const stats = bakeStatsScope();
  if (stats) delete stats[id];
}

function classFieldProgram(bake: boolean): TiledProgram {
  return {
    name: "Class fields",
    vertex: CLASS_FIELD_VERTEX,
    fragment: classFieldFragment(bake),
    uniformNames: bake ? [...UNIFORM_NAMES, ...BAKE_UNIFORM_NAMES] : UNIFORM_NAMES,
  };
}
