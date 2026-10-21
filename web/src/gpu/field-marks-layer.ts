/** Draw nested field dots and no-data hatching from tiled grid textures. */
import type { CustomLayerInterface } from "maplibre-gl";

import {
  blockMeans,
  cellSizePx,
  DOT_RADIUS_RATIO,
  levelFor,
  markBytes,
} from "../render/lattice";
import { FIELD_MARKS_FRAGMENT, FIELD_MARKS_VERTEX } from "./field-marks-shaders";
import {
  TiledGpuLayer,
  type TiledGpu,
  type TiledGrid,
  type TiledLayerOptions,
} from "./tiled-layer";

/** What createFieldMarksLayer needs to place and report on a layer. */
export interface FieldMarksOptions extends TiledLayerOptions {
  /** Dot ink as RGB channels from 0 to 255. */
  ink: [number, number, number];
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

const UNIFORM_NAMES = [
  "uIds",
  "uParentIds",
  "uIdsSize",
  "uWindow",
  "uGridSize",
  "uExtentCells",
  "uSlots",
  "uParentSlots",
  "uLevelBits",
  "uBlockCells",
  "uRadiusPx",
  "uParentRadiusPx",
  "uFading",
  "uFade",
  "uInk",
  "uHalo",
  "uDots",
  "uHatch",
  "uPixelRatio",
];
const COLOR_MAX = 255;

/**
 * Draw field values as dot counts and hatch in-area cells with no value.
 * Setters take effect on the next frame.
 */
export function createFieldMarksLayer(options: FieldMarksOptions) {
  const layer = new FieldMarksLayer(options);
  return {
    layer: layer as CustomLayerInterface,
    setMask: (mask: ArrayLike<number>) => layer.setMask(mask),
    setPositions: (positions: Uint8Array) => layer.setPositions(positions),
    setHalo: (isOn: boolean) => layer.setHalo(isOn),
    setDots: (isOn: boolean) => layer.setDots(isOn),
    setHatch: (isOn: boolean) => layer.setHatch(isOn),
  };
}

class FieldMarksLayer extends TiledGpuLayer {
  private positions: Uint8Array | null = null;
  private mask: ArrayLike<number> | null = null;
  private markCells: Uint8Array | null = null;
  // Levels from zero upwards share the same one-cell blocks.
  private readonly pyramid = new Map<number, BlockData>();
  private isHalo = false;
  private isDots = true;
  private isHatch = true;
  private uploaded: BlockFactors | null = null;
  private frame = { level: 0, fade: 0, cellPx: 1 };
  private readonly marksOptions: FieldMarksOptions;

  constructor(options: FieldMarksOptions) {
    super(options, {
      name: "Dots",
      vertex: FIELD_MARKS_VERTEX,
      fragment: FIELD_MARKS_FRAGMENT,
      uniformNames: UNIFORM_NAMES,
    });
    this.marksOptions = options;
  }

  setMask(mask: ArrayLike<number>) {
    if (this.mask === mask) return;

    this.mask = mask;
    this.resetData();
  }

  setPositions(positions: Uint8Array) {
    this.positions = positions;
    this.resetData();
  }

  private resetData() {
    this.markCells = null;
    this.pyramid.clear();
    this.uploaded = null;
    this.map?.triggerRepaint();
  }

  setHalo(isOn: boolean) {
    this.isHalo = isOn;
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
    return this.positions !== null
      && this.mask !== null
      && (this.isDots || this.isHatch);
  }

  protected extendGpu(base: TiledGpu) {
    return base;
  }

  protected extraTextures() {
    return [];
  }

  protected initialize() {
    this.uploaded = null;
  }

  protected uploadStaleData(gl: WebGL2RenderingContext, gpu: TiledGpu) {
    const cellPx = this.cellPx();
    const { level, fade } = levelFor(cellPx);
    this.frame = { level, fade, cellPx };
    const factors = blockFactors(level, fade);
    if (
      this.uploaded?.factor === factors.factor
      && this.uploaded.parentFactor === factors.parentFactor
    ) {
      return;
    }

    const { grid, cells } = this.blockData(factors.factor);
    // The parent sampler needs an integer texture even when nothing fades, or the draw fails.
    const parentCells = factors.parentFactor ? this.parentCells(factors.factor) : cells;
    this.uploadRows(gl, gpu, grid);
    this.uploadTiles(gl, gpu, grid, cells, parentCells);
    this.uploaded = factors;
  }

  private cellPx() {
    const { bbox, nx, ny } = this.options.grid;
    const [west, south, east, north] = bbox;
    return cellSizePx(
      this.map!.getZoom(),
      { width: (east - west) / nx, height: (north - south) / ny },
      (south + north) / 2,
    );
  }

  private blockData(factor: number): BlockData {
    const cached = this.pyramid.get(factor);
    if (cached) return cached;

    const { grid } = this.options;
    const { means, width, height } = blockMeans(this.markedCells(), grid.nx, grid.ny, factor);
    const [west, south, east, north] = grid.bbox;
    const data = {
      grid: {
        // Padding preserves cell size because the shader clips blocks to the original grid.
        bbox: [
          west,
          north - ((north - south) / grid.ny) * factor * height,
          west + ((east - west) / grid.nx) * factor * width,
          north,
        ] as TiledGrid["bbox"],
        nx: width,
        ny: height,
      },
      cells: means,
    };
    this.pyramid.set(factor, data);
    return data;
  }

  private markedCells() {
    if (!this.markCells) this.markCells = markBytes(this.positions!, this.mask!);

    return this.markCells;
  }

  private parentCells(factor: number) {
    const { grid } = this.blockData(factor);
    const parent = this.blockData(2 * factor);
    const cells = new Uint8Array(grid.nx * grid.ny);
    for (let row = 0; row < grid.ny; row++) {
      for (let column = 0; column < grid.nx; column++) {
        const parentCell = (row >> 1) * parent.grid.nx + (column >> 1);
        cells[row * grid.nx + column] = parent.cells[parentCell];
      }
    }
    return cells;
  }

  protected draw(gl: WebGL2RenderingContext, gpu: TiledGpu, mainMatrix: ArrayLike<number>) {
    const uniform = (name: string) => this.uniform(gpu, name);
    const { level, fade, cellPx } = this.frame;
    const drawnLevel = fade > 0 ? level + 1 : level;
    const pixelRatio = this.map!.getPixelRatio();
    const radiusPx = (dotLevel: number) =>
      DOT_RADIUS_RATIO * (cellPx / 2 ** dotLevel) * pixelRatio;
    const [red, green, blue] = this.marksOptions.ink;
    const { grid } = this.blockData(blockFactors(level, fade).factor);
    const original = this.options.grid;

    this.beginDraw(gl, gpu);
    gl.uniform1i(uniform("uIds"), 0);
    gl.uniform1i(uniform("uParentIds"), 2);
    gl.uniform2f(uniform("uGridSize"), grid.nx, grid.ny);
    gl.uniform2f(uniform("uExtentCells"), original.nx, original.ny);
    gl.uniform1f(uniform("uSlots"), 2 ** Math.max(drawnLevel, 0));
    gl.uniform1f(uniform("uParentSlots"), 2 ** Math.max(drawnLevel - 1, -1));
    gl.uniform1i(uniform("uLevelBits"), Math.max(drawnLevel, 0));
    gl.uniform1f(uniform("uBlockCells"), 2 ** Math.max(-drawnLevel, 0));
    gl.uniform1f(uniform("uRadiusPx"), radiusPx(drawnLevel));
    gl.uniform1f(uniform("uParentRadiusPx"), radiusPx(level));
    gl.uniform1i(uniform("uFading"), fade > 0 ? 1 : 0);
    gl.uniform1f(uniform("uFade"), fade);
    gl.uniform3f(uniform("uInk"), red / COLOR_MAX, green / COLOR_MAX, blue / COLOR_MAX);
    gl.uniform1i(uniform("uHalo"), this.isHalo ? 1 : 0);
    gl.uniform1i(uniform("uDots"), this.isDots ? 1 : 0);
    gl.uniform1i(uniform("uHatch"), this.isHatch ? 1 : 0);
    gl.uniform1f(uniform("uPixelRatio"), pixelRatio);

    this.drawTiles(gl, gpu, mainMatrix, ({ window }) => {
      gl.uniform2i(uniform("uIdsSize"), window.width, window.height);
      gl.uniform2f(uniform("uWindow"), window.column, window.row);
    });
  }
}

function blockFactors(level: number, fade: number): BlockFactors {
  const drawnLevel = fade > 0 ? level + 1 : level;
  const factor = 2 ** Math.max(-drawnLevel, 0);
  return { factor, parentFactor: fade > 0 && drawnLevel <= 0 ? 2 * factor : 0 };
}
