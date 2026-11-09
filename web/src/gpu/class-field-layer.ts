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
  bandTiles: (BandTileTextures | null | undefined)[];
  bandStaging: (BandStaging | undefined)[];
}

/** One tile's baked band textures, uploaded beside the ids and flags windows. */
interface BandTileTextures {
  ids: WebGLTexture;
  low: WebGLTexture;
  high: WebGLTexture;
}

/** A large tile's band textures while row uploads fill them from the top. */
interface BandStaging {
  ids: WebGLTexture;
  low: WebGLTexture;
  high: WebGLTexture;
  nextRow: number;
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
// Final copies and uploads also stay staged so one render never carries every band tile.
const BAKE_UPLOAD_TILES_PER_RENDER = 4;
// A large tile's rows fill the staging textures within this byte budget per render.
const BAKE_UPLOAD_BYTES_PER_RENDER = 2 * 1024 * 1024;
// A large tile also yields within this time so a slow copy cannot stall the frame.
const BAKE_UPLOAD_MS_PER_RENDER = 4;
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
    return { ...base, palette: null, bandTiles: [], bandStaging: [] };
  }

  protected extraTextures(gpu: Gpu) {
    return [
      gpu.palette,
      ...gpu.bandTiles.flatMap((band) => (band ? [band.ids, band.low, band.high] : [])),
      ...gpu.bandStaging.flatMap((staging) => (
        staging ? [staging.ids, staging.low, staging.high] : []
      )),
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
      // New tiles invalidate every band decision, so skipped tiles are reconsidered.
      deleteBandTextures(gl, gpu);
      gpu.bandTiles = [];
      gpu.bandStaging = [];
      this.bakeGpuBytes = 0;
      const pending = this.uploadBandTiles(gl, gpu);
      this.isIdsStale = false;
      this.isBandStale = pending;
      if (pending) this.map?.triggerRepaint();
      return;
    }
    if (this.isBandStale) {
      const pending = this.uploadBandTiles(gl, gpu);
      this.isBandStale = pending;
      if (pending) this.map?.triggerRepaint();
    }
  }

  private uploadBandTiles(gl: WebGL2RenderingContext, gpu: Gpu): boolean {
    if (!this.bakeAllowed) return false;

    if (!this.isBakeReady()) {
      deleteBandTextures(gl, gpu);
      gpu.bandTiles = [];
      gpu.bandStaging = [];
      this.bakeGpuBytes = 0;
      this.publishBakeStats();
      return false;
    }

    const radius = this.edges.smoothRadiusCells ?? 0;
    const { nx, ny } = this.options.grid;
    if (gpu.bandTiles.length !== gpu.tiles.length) {
      deleteBandTextures(gl, gpu);
      gpu.bandTiles = new Array(gpu.tiles.length).fill(undefined);
      gpu.bandStaging = new Array(gpu.tiles.length).fill(undefined);
      this.bakeGpuBytes = 0;
    }
    if (gpu.bandStaging.length !== gpu.tiles.length) {
      gpu.bandStaging = new Array(gpu.tiles.length).fill(undefined);
    }
    let gpuBytes = this.bakeGpuBytes;
    let bytesUsed = 0;
    let tilesUsed = 0;
    const startMs = performance.now();
    for (let index = 0; index < gpu.tiles.length; index++) {
      if (gpu.bandTiles[index] !== undefined) continue;

      const { window } = gpu.tiles[index].tile;
      // Tiles that fall back never sample the band, so they keep the full gather.
      if (isBandParityMismatched(window.column, window.row, radius)) {
        gpu.bandTiles[index] = null;
        continue;
      }
      if (this.flags && isUniformBandWindow(this.flags, nx, window)) {
        gpu.bandTiles[index] = null;
        continue;
      }
      if (tilesUsed >= BAKE_UPLOAD_TILES_PER_RENDER) break;
      if (bytesUsed > 0 && performance.now() - startMs >= BAKE_UPLOAD_MS_PER_RENDER) break;

      const bytesLeft = BAKE_UPLOAD_BYTES_PER_RENDER - bytesUsed;
      const result = this.uploadOneBand(gl, gpu, index, window, nx, ny, bytesLeft);
      if (!result) break;

      bytesUsed += result.bytes;
      if (result.finished) {
        gpuBytes += window.width * window.height * BAND_BYTES_PER_CELL;
        tilesUsed += 1;
      }
      if (bytesUsed >= BAKE_UPLOAD_BYTES_PER_RENDER) break;
      if (performance.now() - startMs >= BAKE_UPLOAD_MS_PER_RENDER) break;
    }
    this.bakeGpuBytes = gpuBytes;
    this.publishBakeStats();
    return gpu.bandTiles.some((band) => band === undefined);
  }

  private uploadOneBand(
    gl: WebGL2RenderingContext,
    gpu: Gpu,
    index: number,
    window: { column: number; row: number; width: number; height: number },
    nx: number,
    ny: number,
    bytesLeft: number,
  ): { bytes: number; finished: boolean } | null {
    const windowBytes = window.width * window.height * BAND_BYTES_PER_CELL;
    if (gpu.bandStaging[index] === undefined && windowBytes <= bytesLeft) {
      const fullGrid = window.column === 0
        && window.row === 0
        && window.width === nx
        && window.height === ny;
      const idsWindow = fullGrid ? this.bandIds! : bandIdsWindow(this.bandIds!, nx, window);
      const lowWindow = fullGrid ? this.bandLow! : bandMaskWindow(this.bandLow!, nx, window);
      const highWindow = fullGrid ? this.bandHigh! : bandMaskWindow(this.bandHigh!, nx, window);
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
      gpu.bandTiles[index] = { ids: idsTexture, low: lowTexture, high: highTexture };
      return { bytes: windowBytes, finished: true };
    }
    return this.uploadPartialBand(gl, gpu, index, window, nx, bytesLeft);
  }

  private uploadPartialBand(
    gl: WebGL2RenderingContext,
    gpu: Gpu,
    index: number,
    window: { column: number; row: number; width: number; height: number },
    nx: number,
    bytesLeft: number,
  ): { bytes: number; finished: boolean } | null {
    const bytesPerRow = window.width * BAND_BYTES_PER_CELL;
    const rowsLeft = window.height - (gpu.bandStaging[index]?.nextRow ?? 0);
    const rowsCanDo = Math.floor(bytesLeft / bytesPerRow);
    if (bytesLeft <= 0 || rowsCanDo <= 0 || rowsLeft <= 0) return null;

    let staging = gpu.bandStaging[index];
    if (!staging) {
      try {
        staging = allocateBandStaging(gl, window.width, window.height);
      } catch (error) {
        gpu.bandStaging[index] = undefined;
        throw error;
      }
      gpu.bandStaging[index] = staging;
    }
    const rows = Math.min(rowsLeft, rowsCanDo);
    const startRow = staging.nextRow;
    const idsRows = bandIdsRowRange(this.bandIds!, nx, window, startRow, rows);
    const lowRows = bandMaskRowRange(this.bandLow!, nx, window, startRow, rows);
    const highRows = bandMaskRowRange(this.bandHigh!, nx, window, startRow, rows);
    try {
      uploadBandRows(gl, staging.ids, "ids", window.width, startRow, rows, idsRows);
      uploadBandRows(gl, staging.low, "mask", window.width, startRow, rows, lowRows);
      uploadBandRows(gl, staging.high, "mask", window.width, startRow, rows, highRows);
    } catch (error) {
      deleteResources(gl, { textures: [staging.ids, staging.low, staging.high] });
      gpu.bandStaging[index] = undefined;
      throw error;
    }
    staging.nextRow += rows;
    if (staging.nextRow < window.height) {
      return { bytes: rows * bytesPerRow, finished: false };
    }
    gpu.bandTiles[index] = { ids: staging.ids, low: staging.low, high: staging.high };
    gpu.bandStaging[index] = undefined;
    return { bytes: rows * bytesPerRow, finished: true };
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
      if (this.bakeAllowed) {
        const band = gpu.bandTiles[tileIndex];
        const ready = band !== null && band !== undefined;
        gl.uniform1i(uniform("uBake"), ready ? 1 : 0);
        if (ready) {
          gl.uniform1i(uniform("uBandIds"), BAND_IDS_UNIT);
          gl.uniform1i(uniform("uBandLow"), BAND_LOW_UNIT);
          gl.uniform1i(uniform("uBandHigh"), BAND_HIGH_UNIT);
          this.bindBandTile(gl, gpu, tileIndex);
        } else {
          // Unsigned samplers must stay valid even when their branch is inactive.
          gl.uniform1i(uniform("uBandIds"), 0);
          gl.uniform1i(uniform("uBandLow"), 0);
          gl.uniform1i(uniform("uBandHigh"), 0);
        }
      }
      tileIndex += 1;
      gl.uniform2i(uniform("uIdsSize"), window.width, window.height);
      gl.uniform1f(uniform("uWindowRow"), window.row);
    }));
  }

  private bindBakeUniforms(gl: WebGL2RenderingContext, gpu: Gpu): void {
    const uniform = (name: string) => this.uniform(gpu, name);
    gl.bindSampler(BAND_IDS_UNIT, null);
    gl.bindSampler(BAND_LOW_UNIT, null);
    gl.bindSampler(BAND_HIGH_UNIT, null);
    gl.uniform1i(uniform("uBandIds"), 0);
    gl.uniform1i(uniform("uBandLow"), 0);
    gl.uniform1i(uniform("uBandHigh"), 0);
  }

  private bindBandTile(gl: WebGL2RenderingContext, gpu: Gpu, index: number): void {
    const band = gpu.bandTiles[index];
    if (band === null || band === undefined) return;

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

function bandIdsRowRange(
  bandIds: Uint8Array,
  nx: number,
  window: { column: number; row: number; width: number; height: number },
  startRow: number,
  rowCount: number,
): Uint8Array {
  const cells = new Uint8Array(window.width * rowCount * 2);
  for (let row = 0; row < rowCount; row++) {
    const source = ((window.row + startRow + row) * nx + window.column) * 2;
    const target = row * window.width * 2;
    cells.set(bandIds.subarray(source, source + window.width * 2), target);
  }
  return cells;
}

function bandMaskRowRange(
  bandMasks: Uint32Array,
  nx: number,
  window: { column: number; row: number; width: number; height: number },
  startRow: number,
  rowCount: number,
): Uint32Array {
  const cells = new Uint32Array(window.width * rowCount);
  for (let row = 0; row < rowCount; row++) {
    const source = (window.row + startRow + row) * nx + window.column;
    cells.set(bandMasks.subarray(source, source + window.width), row * window.width);
  }
  return cells;
}

/**
 * Whether every flag in a tile window marks a uniform interior. Those fragments return
 * before any band fetch, so the tile keeps the full path without band textures.
 */
function isUniformBandWindow(
  flags: Uint8Array | readonly number[],
  nx: number,
  window: { column: number; row: number; width: number; height: number },
): boolean {
  for (let row = 0; row < window.height; row++) {
    for (let column = 0; column < window.width; column++) {
      if (flags[(window.row + row) * nx + window.column + column] !== 1) return false;
    }
  }
  return true;
}

/** Free finished and partially uploaded band textures when tiles or data change. */
function deleteBandTextures(gl: WebGL2RenderingContext, gpu: Gpu): void {
  deleteResources(gl, {
    textures: [
      ...gpu.bandTiles.flatMap((band) => (band ? [band.ids, band.low, band.high] : [])),
      ...(gpu.bandStaging ?? []).flatMap((staging) => (
        staging ? [staging.ids, staging.low, staging.high] : []
      )),
    ],
  });
}

/**
 * Allocate empty band textures for a large tile so later renders fill them row by row.
 * Empty allocation keeps one render inside its byte budget while the tile still falls
 * back to the full gather until every row arrives.
 */
function allocateBandStaging(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): BandStaging {
  const ids = allocateBandTexture(gl, "ids", width, height);
  try {
    const low = allocateBandTexture(gl, "mask", width, height);
    try {
      const high = allocateBandTexture(gl, "mask", width, height);
      return { ids, low, high, nextRow: 0 };
    } catch (error) {
      deleteResources(gl, { textures: [low] });
      throw error;
    }
  } catch (error) {
    deleteResources(gl, { textures: [ids] });
    throw error;
  }
}

function allocateBandTexture(
  gl: WebGL2RenderingContext,
  kind: "ids" | "mask",
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Cannot allocate a band texture");

  const internal = kind === "ids" ? gl.RG8UI : gl.R32UI;
  const layout = kind === "ids" ? gl.RG_INTEGER : gl.RED_INTEGER;
  const type = kind === "ids" ? gl.UNSIGNED_BYTE : gl.UNSIGNED_INT;
  const error = withIsolatedUnpack(gl, () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, layout, type, null);
    return gl.getError();
  });
  if (error !== gl.NO_ERROR) {
    gl.deleteTexture(texture);
    throw new Error(`Cannot allocate a ${width} x ${height} band texture`);
  }
  return texture;
}

/**
 * Fill one row range of an allocated band texture so a large tile uploads in bounded
 * chunks. The tile keeps the full gather until the last row arrives.
 */
function uploadBandRows(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  kind: "ids" | "mask",
  width: number,
  startRow: number,
  rowCount: number,
  data: ArrayBufferView,
): void {
  const layout = kind === "ids" ? gl.RG_INTEGER : gl.RED_INTEGER;
  const type = kind === "ids" ? gl.UNSIGNED_BYTE : gl.UNSIGNED_INT;
  const error = withIsolatedUnpack(gl, () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, startRow, width, rowCount, layout, type, data);
    return gl.getError();
  });
  if (error !== gl.NO_ERROR) {
    throw new Error(`Cannot upload band rows ${startRow} to ${startRow + rowCount}`);
  }
}

// MapLibre leaves image unpack state behind, so grid uploads run isolated.
function withIsolatedUnpack<T>(gl: WebGL2RenderingContext, task: () => T): T {
  const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
  const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
  const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
  const rowLength = gl.getParameter(gl.UNPACK_ROW_LENGTH) as number;
  const skipRows = gl.getParameter(gl.UNPACK_SKIP_ROWS) as number;
  const skipPixels = gl.getParameter(gl.UNPACK_SKIP_PIXELS) as number;
  const unpackBuffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null;
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  try {
    return task();
  } finally {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, skipRows);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, skipPixels);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpackBuffer);
  }
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
