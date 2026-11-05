/** Draw nested field dots and no-data hatching from tiled grid textures. */
import type { CustomLayerInterface } from "maplibre-gl";

import type { InkPaint } from "../render/palettes";
import {
  DEFAULT_DENSITY_RATIO,
  blockMeans,
  dotLattice,
  highZoomDotOpacity,
  markBytes,
  maxDotRadiusPx,
  type DotLattice,
} from "../render/lattice";
import { FIELD_MARKS_FRAGMENT, FIELD_MARKS_VERTEX } from "./field-marks-shaders";
import { deleteResources } from "./gl";
import {
  TiledGpuLayer,
  type TiledGpu,
  type TiledGrid,
  type TiledLayerOptions,
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
];
const COLOR_MAX = 255;

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
  private density = DEFAULT_DENSITY_RATIO;
  private uploaded: Uploaded | null = null;
  private frame: DotLattice = {
    level: 0,
    fade: 0,
    sidesPx: { width: 1, height: 1 },
    aimedPx: 1,
    density: DEFAULT_DENSITY_RATIO,
    pixelRatio: 1,
  };
  private ink: InkPaint;

  constructor(options: FieldMarksOptions) {
    super(options, {
      name: "Dots",
      vertex: FIELD_MARKS_VERTEX,
      fragment: FIELD_MARKS_FRAGMENT,
      uniformNames: UNIFORM_NAMES,
    });
    this.ink = options.ink;
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
    this.ink = ink;
    this.map?.triggerRepaint();
  }

  setDensity(density: number) {
    this.density = density;
    this.map?.triggerRepaint();
  }

  setDots(isOn: boolean) {
    this.isDots = isOn;
    this.map?.triggerRepaint();
  }

  setHatch(isOn: boolean) {
    this.isHatch = isOn;
    this.map?.triggerRepaint();
  }

  protected hasData() {
    return (this.from !== null || this.to !== null)
      && this.mask !== null
      && (this.isDots || this.isHatch);
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
    this.frame = this.lattice();
    const factors = blockFactors(this.frame.level, this.frame.fade);
    const { from, to, uploaded } = this;
    const isSameBlocks = uploaded?.factor === factors.factor
      && uploaded.parentFactor === factors.parentFactor;
    if (isSameBlocks && uploaded.from === from && uploaded.to === to) return;

    // At a step boundary the entering step already sits in the second set, so it uploads once.
    if (isSameBlocks && from !== null && uploaded.to === from) {
      this.promoteNextTiles(gl, gpu);
    } else if (!isSameBlocks || from === null || uploaded.from !== from) {
      this.uploadFirstTiles(gl, gpu, factors);
    }
    this.uploadNextTiles(gl, gpu, factors);
    this.uploaded = { ...factors, from, to };
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

  private lattice() {
    const { bbox, nx, ny } = this.options.grid;
    const [west, south, east, north] = bbox;
    return dotLattice(
      { width: (east - west) / nx, height: (north - south) / ny },
      (south + north) / 2,
      this.map!.getZoom(),
      this.density,
      this.map!.getPixelRatio(),
    );
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
    const pixelRatio = this.map!.getPixelRatio();
    const dotOpacity = highZoomDotOpacity(this.map!.getZoom(), pixelRatio);
    if (dotOpacity === 0 && !this.isHatch) return;
    const cellPx = Math.sqrt(sidesPx.width * sidesPx.height);
    const radiusPx = (dotLevel: number) =>
      maxDotRadiusPx(cellPx / 2 ** dotLevel, dotLevel, aimedPx, density) * pixelRatio;
    const grid = blockGrid(this.options.grid, blockFactors(level, fade).factor);
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
    gl.uniform3f(uniform("uInk"), ...channels(this.ink.ink));
    gl.uniform3f(uniform("uHaloInk"), ...channels(this.ink.halo));
    gl.uniform1i(uniform("uHalo"), this.isHalo ? 1 : 0);
    gl.uniform1i(uniform("uDots"), this.isDots && dotOpacity > 0 ? 1 : 0);
    gl.uniform1i(uniform("uHatch"), this.isHatch ? 1 : 0);
    gl.uniform1f(uniform("uPixelRatio"), pixelRatio);
    gl.uniform1f(uniform("uDotOpacity"), dotOpacity);

    let tileIndex = 0;
    this.drawTiles(gl, gpu, mainMatrix, (tile) => {
      this.bindNextTile(gl, gpu, tileIndex++);
      gl.uniform2i(uniform("uIdsSize"), tile.window.width, tile.window.height);
      gl.uniform2f(uniform("uWindow"), tile.window.column, tile.window.row);
    });
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

function blockFactors(level: number, fade: number): BlockFactors {
  const drawnLevel = fade > 0 ? level + 1 : level;
  const factor = 2 ** Math.max(-drawnLevel, 0);
  return { factor, parentFactor: fade > 0 && drawnLevel <= 0 ? 2 * factor : 0 };
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
