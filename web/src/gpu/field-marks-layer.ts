/** Draw nested field dots and no-data hatching from tiled grid textures. */
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

import type { InkPaint } from "../render/palettes";
import { addressSearch, gestureFlags, subscribeGesture } from "../gesture-quality";
import { prefersReducedMotion, watchReducedMotion } from "../reduced-motion";
import {
  DEFAULT_DENSITY_RATIO,
  blockMeans,
  dotLattice,
  highZoomDotOpacity,
  highZoomDotSizeScale,
  limitCloseRadiusPx,
  markBytes,
  maxDotRadiusPx,
  writeContinuousLattice,
  type DotLattice,
} from "../render/lattice";
import { FIELD_MARKS_FRAGMENT, FIELD_MARKS_VERTEX } from "./field-marks-shaders";
import { deleteResources } from "./gl";
import {
  TiledGpuLayer,
  type TiledGpu,
  type TiledGrid,
  type TiledLayerOptions,
  timedGpuDraw,
} from "./tiled-layer";

/** What createFieldMarksLayer needs to place and report on a layer. */
export interface FieldMarksOptions extends TiledLayerOptions {
  /** The ink of dots and hatch with its halo, as RGB channels from 0 to 255. */
  ink: InkPaint;
}

interface BlockData {
  grid: TiledGrid;
  cells: Uint8Array;
}

/** Block sizes of uploaded textures; a zero parent factor means no parent texture. */
interface BlockFactors {
  factor: number;
  parentFactor: number;
}

/** What the uploaded textures hold, so that a frame uploads only what changed. */
interface Uploaded extends BlockFactors {
  from: Uint8Array | null;
  to: Uint8Array | null;
}

/** The textures of the step that fades in, one pair per tile in the order of the shared tiles. */
interface NextTile {
  texture: WebGLTexture;
  companion: WebGLTexture | null;
}

interface MarksGpu extends TiledGpu {
  nextTiles: NextTile[];
}

const CURRENT_IDS_UNIT = 0;
const PARENT_IDS_UNIT = 2;
const NEXT_IDS_UNIT = 3;
const NEXT_PARENT_IDS_UNIT = 4;

const UNIFORM_NAMES = [
  "uIds",
  "uParentIds",
  "uNextIds",
  "uNextParentIds",
  "uIdsSize",
  "uWindow",
  "uGridSize",
  "uExtentCells",
  "uSlots",
  "uParentSlots",
  "uBlockCells",
  "uRadiusPx",
  "uParentRadiusPx",
  "uFading",
  "uFade",
  "uStepMix",
  "uHasFrom",
  "uHasTo",
  "uInk",
  "uHaloInk",
  "uHalo",
  "uDots",
  "uHatch",
  "uPixelRatio",
  "uDotOpacity",
  "uSizeScale",
];
const COLOR_MAX = 255;

/** How long a density change eases between effective densities. */
const DENSITY_TRANSITION_MS = 180;

/**
 * Draw field values as dot sizes and hatch in-area cells with no value.
 * Setters take effect on the next frame. A fade between two steps keeps both uploaded.
 */
export function createFieldMarksLayer(options: FieldMarksOptions) {
  const layer = new FieldMarksLayer(options);
  return {
    layer: layer as CustomLayerInterface,
    setMask: (mask: ArrayLike<number>) => layer.setMask(mask),
    setFade: (from: Uint8Array | null, to: Uint8Array | null, mix: number) => {
      layer.setFade(from, to, mix);
    },
    isReady: (positions: Uint8Array) => layer.isReady(positions),
    setHalo: (isOn: boolean) => layer.setHalo(isOn),
    setInk: (ink: InkPaint) => layer.setInk(ink),
    setDensity: (density: number) => layer.setDensity(density),
    setDots: (isOn: boolean) => layer.setDots(isOn),
    setHatch: (isOn: boolean) => layer.setHatch(isOn),
    renderedDensity: () => layer.renderedDensity(),
    warmUp: (signal?: AbortSignal) => layer.warmUp(signal),
  };
}

class FieldMarksLayer extends TiledGpuLayer<MarksGpu> {
  // A null step draws nothing, so a fade from or to it grows or shrinks dots from zero radius.
  private from: Uint8Array | null = null;
  private to: Uint8Array | null = null;
  private stepMix = 0;
  private mask: ArrayLike<number> | null = null;
  // Only the steps in use stay, so the entering step keeps its blocks once it is the first one.
  private pyramids = new Map<Uint8Array, StepPyramid>();
  private isHalo = false;
  private isDots = true;
  private isHatch = true;
  private isGestureHatchOff = false;
  private stopGesture: (() => void) | null = null;
  // Captured here because scene entry replaces the address and drops trial flags.
  private readonly fastHatchAllowed = gestureFlags(addressSearch()).fastHatch;
  private density = DEFAULT_DENSITY_RATIO;
  // The effective density the map draws, which eases toward the requested target after a change.
  private shownDensity = DEFAULT_DENSITY_RATIO;
  private tweenStartLog = 0;
  private tweenTargetLog = 0;
  private tweenStartMs = 0;
  private tweenActive = false;
  private hasInitialized = false;
  private fittedZoom = NaN;
  private fittedRatio = NaN;
  private fittedRequested = NaN;
  private fittedEffective = DEFAULT_DENSITY_RATIO;
  private reducedMotion = false;
  private stopReducedMotion: (() => void) | null = null;
  private readonly cellDegrees: { width: number; height: number };
  private readonly latitude: number;
  private inkChannels: [number, number, number];
  private haloChannels: [number, number, number];

  private cachedFactor = NaN;
  private cachedGrid: TiledGrid | null = null;
  private uploaded: Uploaded | null = null;
  private frame: DotLattice = {
    level: 0,
    fade: 0,
    sidesPx: { width: 1, height: 1 },
    aimedPx: 1,
    density: DEFAULT_DENSITY_RATIO,
    pixelRatio: 1,
    zoom: 0,
  };

  constructor(options: FieldMarksOptions) {
    super(options, {
      name: "Dots",
      vertex: FIELD_MARKS_VERTEX,
      fragment: FIELD_MARKS_FRAGMENT,
      uniformNames: UNIFORM_NAMES,
    });
    const [west, south, east, north] = options.grid.bbox;
    this.cellDegrees = {
      width: (east - west) / options.grid.nx,
      height: (north - south) / options.grid.ny,
    };
    this.latitude = (south + north) / 2;
    this.inkChannels = channels(options.ink.ink);
    this.haloChannels = channels(options.ink.halo);
  }

  setMask(mask: ArrayLike<number>) {
    if (this.mask === mask) return;

    this.mask = mask;
    this.resetData();
  }

  /** Show step `from` easing into step `to` by `mix`; `to` is uploaded even while mix is 0. */
  setFade(from: Uint8Array | null, to: Uint8Array | null, mix: number) {
    this.from = from;
    this.to = to === from ? null : to;
    this.stepMix = mix;
    this.pyramids = new Map(
      [...this.pyramids].filter(([positions]) => positions === from || positions === this.to),
    );
    this.map?.triggerRepaint();
  }

  /** Whether a draw already holds the step in its textures, so a fade to it can start. */
  isReady(positions: Uint8Array) {
    const { uploaded } = this;
    return uploaded !== null && (uploaded.from === positions || uploaded.to === positions);
  }

  private resetData() {
    this.pyramids.clear();
    this.uploaded = null;
    this.map?.triggerRepaint();
  }

  setHalo(isOn: boolean) {
    this.isHalo = isOn;
    this.map?.triggerRepaint();
  }

  setInk(ink: InkPaint) {
    this.inkChannels = channels(ink.ink);
    this.haloChannels = channels(ink.halo);
    this.map?.triggerRepaint();
  }

  setDensity(density: number) {
    this.density = density;
    this.retargetDensity();
    this.map?.triggerRepaint();
  }

  private retargetDensity() {
    const map = this.map;
    if (!map) {
      // The first render snaps to the fitted target, so seed the preview near the request.
      this.shownDensity = this.density;
      return;
    }
    const target = this.fittedDensity(map.getZoom(), map.getPixelRatio(), this.density);
    if (!this.hasInitialized || this.reducedMotion || !this.isDots) {
      this.snapDensity(target);
      return;
    }
    const targetLog = Math.log2(target);
    if (targetLog === this.tweenTargetLog) return;

    const startLog = this.tweenActive ? this.tweenLogAt(nowMs()) : Math.log2(this.shownDensity);
    this.startTween(startLog, targetLog);
  }

  private snapDensity(target: number) {
    this.shownDensity = target;
    this.tweenTargetLog = Math.log2(target);
    this.tweenActive = false;
    this.hasInitialized = true;
  }

  private startTween(startLog: number, targetLog: number) {
    if (startLog === targetLog) {
      this.snapDensity(2 ** targetLog);
      return;
    }
    this.tweenStartLog = startLog;
    this.tweenTargetLog = targetLog;
    this.tweenStartMs = nowMs();
    this.tweenActive = true;
    this.hasInitialized = true;
  }

  // The settled containment fit for a request, cached so an unchanged tween frame skips it.
  private fittedDensity(zoom: number, pixelRatio: number, requested: number) {
    if (
      zoom === this.fittedZoom
      && pixelRatio === this.fittedRatio
      && requested === this.fittedRequested
    ) {
      return this.fittedEffective;
    }
    this.fittedZoom = zoom;
    this.fittedRatio = pixelRatio;
    this.fittedRequested = requested;
    this.fittedEffective = dotLattice(
      this.cellDegrees,
      this.latitude,
      zoom,
      requested,
      pixelRatio,
    ).density;

    return this.fittedEffective;
  }

  private tweenLogAt(now: number) {
    const progress = (now - this.tweenStartMs) / DENSITY_TRANSITION_MS;
    const eased = easeTransition(progress);
    return this.tweenStartLog + (this.tweenTargetLog - this.tweenStartLog) * eased;
  }

  /** The effective density the layer currently draws, which eases toward the set target. */
  renderedDensity() {
    return this.shownDensity;
  }

  setDots(isOn: boolean) {
    const wasHidden = !this.isDots && isOn;
    this.isDots = isOn;
    if (!isOn && this.tweenActive) {
      // A hidden layer draws no dots, so it finishes at once instead of animating unseen frames.
      this.snapDensity(2 ** this.tweenTargetLog);
    }
    if (wasHidden && this.map) {
      // Showing again settles at the selected target rather than flying in from the old value.
      this.snapDensity(
        this.fittedDensity(this.map.getZoom(), this.map.getPixelRatio(), this.density),
      );
    }
    this.map?.triggerRepaint();
  }

  setHatch(isOn: boolean) {
    this.isHatch = isOn;
    this.map?.triggerRepaint();
  }

  override onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    super.onAdd(map, gl);
    this.reducedMotion = prefersReducedMotion();
    this.stopReducedMotion ??= watchReducedMotion((reduced) => this.setReducedMotion(reduced));
    if (!this.fastHatchAllowed || this.stopGesture) return;
    this.stopGesture = subscribeGesture(map, {
      onStart: () => this.setGestureHatchOff(true),
      onEnd: () => this.setGestureHatchOff(false),
    });
  }

  override onRemove() {
    this.stopGesture?.();
    this.stopGesture = null;
    this.stopReducedMotion?.();
    this.stopReducedMotion = null;
    // The requested target survives for restoration while the unseen tween stops.
    this.tweenActive = false;
    super.onRemove();
  }

  // Reduced motion skips the easing and draws the settled target at once.
  private setReducedMotion(reduced: boolean) {
    if (reduced === this.reducedMotion) return;

    this.reducedMotion = reduced;
    if (!reduced || !this.map) return;

    this.snapDensity(
      this.fittedDensity(this.map.getZoom(), this.map.getPixelRatio(), this.density),
    );
    this.map.triggerRepaint();
  }

  /**
   * Hide the hatch while the camera moves and restore it on moveend. The override applies
   * at draw time, so the per-step hatch choice survives the gesture untouched.
   */
  private setGestureHatchOff(isOff: boolean) {
    if (isOff === this.isGestureHatchOff) return;
    this.isGestureHatchOff = isOff;
    this.map?.triggerRepaint();
  }

  private hasEffectiveHatch() {
    return this.isHatch && !this.isGestureHatchOff;
  }

  protected hasData() {
    return (this.from !== null || this.to !== null)
      && this.mask !== null
      && (this.isDots || this.hasEffectiveHatch());
  }

  protected extendGpu(base: TiledGpu): MarksGpu {
    return { ...base, nextTiles: [] };
  }

  protected extraTextures(gpu: MarksGpu) {
    return gpu.nextTiles.flatMap(({ texture, companion }) => [texture, companion]);
  }

  protected initialize() {
    this.uploaded = null;
  }

  protected uploadStaleData(gl: WebGL2RenderingContext, gpu: MarksGpu) {
    const zoom = this.map!.getZoom();
    const pixelRatio = this.map!.getPixelRatio();
    this.updateShownDensity(zoom, pixelRatio);
    writeContinuousLattice(
      this.frame,
      this.cellDegrees,
      this.latitude,
      zoom,
      this.shownDensity,
      pixelRatio,
    );
    const drawnLevel = this.frame.fade > 0 ? this.frame.level + 1 : this.frame.level;
    const factor = 2 ** Math.max(-drawnLevel, 0);
    const parentFactor = this.frame.fade > 0 && drawnLevel <= 0 ? 2 * factor : 0;
    const { from, to, uploaded } = this;
    const isSameBlocks = uploaded?.factor === factor && uploaded.parentFactor === parentFactor;
    if (isSameBlocks && uploaded.from === from && uploaded.to === to) {
      if (this.tweenActive) this.map?.triggerRepaint();
      return;
    }

    // At a step boundary the entering step already sits in the second set, so it uploads once.
    const factors = { factor, parentFactor };
    if (isSameBlocks && from !== null && uploaded.to === from) {
      this.promoteNextTiles(gl, gpu);
    } else if (!isSameBlocks || from === null || uploaded.from !== from) {
      this.uploadFirstTiles(gl, gpu, factors);
    }
    this.uploadNextTiles(gl, gpu, factors);
    this.uploaded = { ...factors, from, to };
    if (this.tweenActive) this.map?.triggerRepaint();
  }

  // Advance or retarget the density tween at the live camera, snapping when nothing eases.
  private updateShownDensity(zoom: number, pixelRatio: number) {
    const target = this.fittedDensity(zoom, pixelRatio, this.density);
    if (!this.hasInitialized || this.reducedMotion || !this.isDots) {
      this.snapDensity(target);
      return;
    }
    if (!this.tweenActive) {
      // A camera move shifts the fitted endpoint at once while a density change eases.
      this.snapDensity(target);
      return;
    }
    const now = nowMs();
    const targetLog = Math.log2(target);
    if (targetLog !== this.tweenTargetLog) {
      // Containment moved the endpoint mid-tween, so restart from the displayed value.
      this.tweenStartLog = this.tweenLogAt(now);
      this.tweenStartMs = now;
      this.tweenTargetLog = targetLog;
    }
    const progress = (now - this.tweenStartMs) / DENSITY_TRANSITION_MS;
    this.shownDensity = 2
      ** (this.tweenStartLog
        + (this.tweenTargetLog - this.tweenStartLog) * easeTransition(progress));
    if (progress >= 1) {
      // Assign the exact target so a log round-trip never leaves a residue.
      this.snapDensity(target);
    }
  }

  // The first texture set holds the leaving step, or the entering one when nothing leaves.
  private uploadFirstTiles(gl: WebGL2RenderingContext, gpu: MarksGpu, factors: BlockFactors) {
    const first = this.pyramidOf((this.from ?? this.to)!);
    const { grid, cells, parentCells } = first.textureCells(factors);
    this.uploadRows(gl, gpu, grid);
    this.uploadTiles(gl, gpu, grid, cells, parentCells);
  }

  private promoteNextTiles(gl: WebGL2RenderingContext, gpu: MarksGpu) {
    const { nextTiles } = gpu;
    deleteResources(gl, {
      textures: gpu.tiles.flatMap(({ texture, companion }) => [texture, companion]),
    });
    gpu.tiles = gpu.tiles.map((entry, index) => ({ ...entry, ...nextTiles[index] }));
    gpu.nextTiles = [];
  }

  private uploadNextTiles(gl: WebGL2RenderingContext, gpu: MarksGpu, factors: BlockFactors) {
    deleteResources(gl, { textures: this.extraTextures(gpu) });
    gpu.nextTiles = [];
    if (!this.from || !this.to) return;

    const { grid, cells, parentCells } = this.pyramidOf(this.to).textureCells(factors);
    try {
      for (const { tile } of gpu.tiles) {
        const nextTile: NextTile = {
          texture: this.uploadWindow(gl, grid, tile.window, cells),
          companion: null,
        };
        gpu.nextTiles.push(nextTile);
        nextTile.companion = this.uploadWindow(gl, grid, tile.window, parentCells);
      }
    } catch (error) {
      deleteResources(gl, { textures: this.extraTextures(gpu) });
      gpu.nextTiles = [];
      throw error;
    }
  }

  private pyramidOf(positions: Uint8Array) {
    const cached = this.pyramids.get(positions);
    if (cached) return cached;

    const pyramid = new StepPyramid(this.options.grid, positions, this.mask!);
    this.pyramids.set(positions, pyramid);
    return pyramid;
  }

  protected draw(gl: WebGL2RenderingContext, gpu: MarksGpu, mainMatrix: ArrayLike<number>) {
    const uniform = (name: string) => this.uniform(gpu, name);
    const { level, fade, sidesPx, aimedPx, density } = this.frame;
    const drawnLevel = fade > 0 ? level + 1 : level;
    const zoom = this.map!.getZoom();
    const pixelRatio = this.map!.getPixelRatio();
    const dotOpacity = highZoomDotOpacity(zoom, pixelRatio);
    if (dotOpacity === 0 && !this.hasEffectiveHatch()) return;
    // The display cap bounds close-zoom radii before device pixels, matching the preview.
    const sizeScale = highZoomDotSizeScale(zoom, pixelRatio);
    const cellPx = Math.sqrt(sidesPx.width * sidesPx.height);
    const radiusPx = (dotLevel: number) =>
      limitCloseRadiusPx(maxDotRadiusPx(cellPx / 2 ** dotLevel, dotLevel, aimedPx, density), zoom)
      * pixelRatio;
    const grid = this.blocksFor(drawnLevel);
    const original = this.options.grid;

    this.beginDraw(gl, gpu);
    gl.bindSampler(NEXT_IDS_UNIT, null);
    gl.bindSampler(NEXT_PARENT_IDS_UNIT, null);
    gl.uniform1i(uniform("uIds"), CURRENT_IDS_UNIT);
    gl.uniform1i(uniform("uParentIds"), PARENT_IDS_UNIT);
    gl.uniform1i(uniform("uNextIds"), NEXT_IDS_UNIT);
    gl.uniform1i(uniform("uNextParentIds"), NEXT_PARENT_IDS_UNIT);
    gl.uniform2f(uniform("uGridSize"), grid.nx, grid.ny);
    gl.uniform2f(uniform("uExtentCells"), original.nx, original.ny);
    gl.uniform1f(uniform("uSlots"), 2 ** Math.max(drawnLevel, 0));
    gl.uniform1f(uniform("uParentSlots"), 2 ** Math.max(drawnLevel - 1, -1));
    gl.uniform1f(uniform("uBlockCells"), 2 ** Math.max(-drawnLevel, 0));
    gl.uniform1f(uniform("uRadiusPx"), radiusPx(drawnLevel));
    gl.uniform1f(uniform("uParentRadiusPx"), radiusPx(level));
    gl.uniform1i(uniform("uFading"), fade > 0 ? 1 : 0);
    gl.uniform1f(uniform("uFade"), fade);
    gl.uniform1f(uniform("uStepMix"), this.stepMix);
    gl.uniform1i(uniform("uHasFrom"), this.from ? 1 : 0);
    gl.uniform1i(uniform("uHasTo"), this.to ? 1 : 0);
    gl.uniform3f(uniform("uInk"), ...this.inkChannels);
    gl.uniform3f(uniform("uHaloInk"), ...this.haloChannels);
    gl.uniform1i(uniform("uHalo"), this.isHalo ? 1 : 0);
    gl.uniform1i(uniform("uDots"), this.isDots && dotOpacity > 0 ? 1 : 0);
    gl.uniform1i(uniform("uHatch"), this.hasEffectiveHatch() ? 1 : 0);
    gl.uniform1f(uniform("uPixelRatio"), pixelRatio);
    gl.uniform1f(uniform("uDotOpacity"), dotOpacity);
    gl.uniform1f(uniform("uSizeScale"), sizeScale);

    let tileIndex = 0;
    timedGpuDraw(gl, this.id, () => this.drawTiles(gl, gpu, mainMatrix, (tile) => {
      this.bindNextTile(gl, gpu, tileIndex++);
      gl.uniform2i(uniform("uIdsSize"), tile.window.width, tile.window.height);
      gl.uniform2f(uniform("uWindow"), tile.window.column, tile.window.row);
    }));
  }

  // The block grid for a drawn level, cached because the grid never changes with density.
  private blocksFor(drawnLevel: number): TiledGrid {
    const factor = 2 ** Math.max(-drawnLevel, 0);
    if (this.cachedGrid && factor === this.cachedFactor) return this.cachedGrid;

    this.cachedFactor = factor;
    this.cachedGrid = blockGrid(this.options.grid, factor);

    return this.cachedGrid;
  }

  // Without a step to fade into, the next samplers read the shown step so that they stay complete.
  private bindNextTile(gl: WebGL2RenderingContext, gpu: MarksGpu, index: number) {
    const { texture, companion } = gpu.tiles[index];
    const next = gpu.nextTiles[index];
    gl.activeTexture(gl.TEXTURE0 + NEXT_IDS_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, next?.texture ?? texture);
    gl.activeTexture(gl.TEXTURE0 + NEXT_PARENT_IDS_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, next?.companion ?? companion);
    gl.activeTexture(gl.TEXTURE0);
  }
}

/** The blocks of one step's marks at each level, built when a level first needs them. */
class StepPyramid {
  private readonly grid: TiledGrid;
  private readonly positions: Uint8Array;
  private readonly mask: ArrayLike<number>;
  private markCells: Uint8Array | null = null;
  // Levels from zero upwards share the same one-cell blocks.
  private readonly blockByFactor = new Map<number, BlockData>();

  constructor(grid: TiledGrid, positions: Uint8Array, mask: ArrayLike<number>) {
    this.grid = grid;
    this.positions = positions;
    this.mask = mask;
  }

  // The parent sampler needs an integer texture even when nothing fades, or the draw fails.
  textureCells({ factor, parentFactor }: BlockFactors) {
    const { grid, cells } = this.blocks(factor);
    const parentCells = parentFactor ? this.parentCells(factor) : cells;
    return { grid, cells, parentCells };
  }

  private blocks(factor: number): BlockData {
    const cached = this.blockByFactor.get(factor);
    if (cached) return cached;

    const { nx, ny } = this.grid;
    const { means } = blockMeans(this.markedCells(), nx, ny, factor);
    const data = { grid: blockGrid(this.grid, factor), cells: means };
    this.blockByFactor.set(factor, data);
    return data;
  }

  private parentCells(factor: number) {
    const { grid } = this.blocks(factor);
    const parent = this.blocks(2 * factor);
    const cells = new Uint8Array(grid.nx * grid.ny);
    for (let row = 0; row < grid.ny; row++) {
      for (let column = 0; column < grid.nx; column++) {
        const parentCell = (row >> 1) * parent.grid.nx + (column >> 1);
        cells[row * grid.nx + column] = parent.cells[parentCell];
      }
    }
    return cells;
  }

  private markedCells() {
    this.markCells ??= markBytes(this.positions, this.mask);

    return this.markCells;
  }
}

function channels([red, green, blue]: number[]): [number, number, number] {
  return [red / COLOR_MAX, green / COLOR_MAX, blue / COLOR_MAX];
}

/** The clock the density tween samples, which tests can pin by stubbing performance. */
function nowMs(): number {
  try {
    if (typeof performance === "object" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {
    // High-resolution time is missing, so the Date fallback below keeps the tween easing.
  }

  return Date.now();
}

/** Ease a tween progress so a density change starts and lands without a step. */
function easeTransition(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped * clamped * (3 - 2 * clamped);
}

// Padding preserves cell size because the shader clips blocks to the original grid.
function blockGrid(grid: TiledGrid, factor: number): TiledGrid {
  const width = Math.ceil(grid.nx / factor);
  const height = Math.ceil(grid.ny / factor);
  const [west, south, east, north] = grid.bbox;
  return {
    bbox: [
      west,
      north - ((north - south) / grid.ny) * factor * height,
      west + ((east - west) / grid.nx) * factor * width,
      north,
    ],
    nx: width,
    ny: height,
  };
}
