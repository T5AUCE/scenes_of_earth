/** Encode field values as nested dot lattices and mask-aware no-data hatching. */
import { stopPosition } from "./colormap";

/** The finest and coarsest dot levels; a level L puts 2^L dot sites along each cell side. */
export const MIN_LEVEL = -4;
export const MAX_LEVEL = 4;

/** Dot radius as a share of the dot spacing, which inks 18 % of the area at full density. */
export const DOT_RADIUS_RATIO = 0.24;

/** The byte that marks a cell with no value; positions use 0 to 253. */
export const NO_DATA_BYTE = 255;
/** The byte that hatches an in-area cell with no value, so the shader can tell it from outside. */
export const HATCH_BYTE = 254;
const MAX_POSITION_BYTE = 253;

// MapLibre draws the world 512 px wide at zoom 0.
const WORLD_PX_AT_ZOOM_0 = 512;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const MIN_SPACING_PX = 5;
const FADE_START = 0.75;
// This offset nests sites across levels and centres the finest sites in their sub-cells.
const SLOT_OFFSET_CELLS = 15 / 32;
const THRESHOLD_BITS = 3;
const THRESHOLD_SIZE = 2 ** THRESHOLD_BITS;

/**
 * The on-screen size of a cell as the geometric mean of its sides, which Mercator stretches
 * by 1 / cos(latitude) vertically.
 */
export function cellSizePx(
  zoom: number,
  cellDegrees: { width: number; height: number },
  latitude: number,
) {
  const worldPx = WORLD_PX_AT_ZOOM_0 * 2 ** zoom;
  const stretch = 1 / Math.cos(latitude / DEGREES_PER_RADIAN);
  return (worldPx / 360) * Math.sqrt(cellDegrees.width * cellDegrees.height * stretch);
}

/** Choose the level with 5 to 10 px dot spacing and its progress towards the next level. */
export function levelFor(cellPx: number) {
  const exact = Math.log2(cellPx / MIN_SPACING_PX);
  const level = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.floor(exact)));
  if (level === MAX_LEVEL) return { level, fade: 0 };

  const fraction = exact - level;
  const progress = Math.min(1, Math.max(0, (fraction - FADE_START) / (1 - FADE_START)));
  return { level, fade: progress * progress * (3 - 2 * progress) };
}

/**
 * Locate a slot along one axis in cells. Sites are 2^-L cells apart at level L.
 * Every slot of a level is also a slot of the next one.
 */
export function slotPosition(slot: number, level: number) {
  return slot / 2 ** level + SLOT_OFFSET_CELLS;
}

/**
 * Rank a slot among the 4^bits slots of a cell, where the first ranks are spread as widely as
 * possible. The slot at (2i, 2j) of the next level keeps the rank of (i, j).
 */
export function bayerRank(column: number, row: number, bits: number) {
  let rank = 0;
  for (let bit = 0; bit < bits; bit++) {
    const across = (column >> bit) & 1;
    const down = (row >> bit) & 1;
    rank += (2 * (across ^ down) + down) * 4 ** (bits - 1 - bit);
  }
  return rank;
}

/** A per-cell offset in (0, 1) that decides which cells round their dot count up. */
export function cellThreshold(column: number, row: number) {
  const rank = bayerRank(column % THRESHOLD_SIZE, row % THRESHOLD_SIZE, THRESHOLD_BITS);
  return (rank + 0.5) / THRESHOLD_SIZE ** 2;
}

/**
 * How many of a cell's dots to draw, which are the ones that rank below it. Below level 0 a
 * cell stands for a block of cells, so it has one dot site and a count of 0 or 1.
 */
export function dotCount(position: number, level: number, threshold: number) {
  const slots = 4 ** Math.max(level, 0);
  return Math.min(slots, Math.max(0, Math.floor(position * slots + 1 - threshold)));
}

/** Whether the dot at a slot of a cell is drawn, which a cell with no data never does. */
export function isDotLit(
  positionByte: number,
  level: number,
  threshold: number,
  column: number,
  row: number,
) {
  if (positionByte >= HATCH_BYTE) return false;

  const count = dotCount(positionByte / MAX_POSITION_BYTE, level, threshold);
  return bayerRank(column, row, Math.max(level, 0)) < count;
}

/** Whether a cell gets the no-data hatch, which needs it inside the area without a value. */
export function isHatched(inArea: boolean, positionByte: number) {
  return inArea && positionByte === NO_DATA_BYTE;
}

/** Whether a step has any in-area cell with no value, which the legend reports. */
export function hasHatchedCells(positions: ArrayLike<number>, mask: ArrayLike<number>) {
  for (let cell = 0; cell < positions.length; cell++) {
    if (isHatched(mask[cell] !== 0, positions[cell])) return true;
  }
  return false;
}

/** Combine a step's position bytes with the area mask, so outside cells draw nothing. */
export function markBytes(positions: ArrayLike<number>, mask: ArrayLike<number>) {
  return Uint8Array.from(positions, (position, cell) => markByte(position, mask[cell] !== 0));
}

function markByte(positionByte: number, inArea: boolean) {
  if (isHatched(inArea, positionByte)) return HATCH_BYTE;

  return inArea ? positionByte : NO_DATA_BYTE;
}

/**
 * How a dot looks while its level fades into the next one. A dot of the level above grows to the
 * new radius. A dot lit in only one level fades out or in while an unlit dot stays invisible.
 */
export function crossfadeDot(
  wasLit: boolean,
  willBeLit: boolean,
  fade: number,
  radiiPx: { parent: number; next: number },
) {
  const before = wasLit ? 1 : 0;
  const after = willBeLit ? 1 : 0;
  return {
    opacity: before + (after - before) * fade,
    radiusPx: wasLit ? radiiPx.parent + (radiiPx.next - radiiPx.parent) * fade : radiiPx.next,
  };
}

/**
 * Average each factor x factor block of marks bytes, skipping no-data and hatched cells. A
 * block hatches only when all its cells do, so hatch does not leak outside the area.
 */
export function blockMeans(bytes: Uint8Array, nx: number, ny: number, factor: number) {
  const width = Math.ceil(nx / factor);
  const height = Math.ceil(ny / factor);
  const means = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      means[row * width + column] = blockMean(bytes, nx, ny, factor, column, row);
    }
  }
  return { means, width, height };
}

function blockMean(
  bytes: Uint8Array,
  nx: number,
  ny: number,
  factor: number,
  column: number,
  row: number,
) {
  let sum = 0;
  let count = 0;
  let isAllHatched = true;
  for (let y = row * factor; y < Math.min(ny, (row + 1) * factor); y++) {
    for (let x = column * factor; x < Math.min(nx, (column + 1) * factor); x++) {
      const byte = bytes[y * nx + x];
      if (byte !== HATCH_BYTE) isAllHatched = false;
      if (byte === NO_DATA_BYTE || byte === HATCH_BYTE) continue;

      sum += byte;
      count++;
    }
  }
  if (count > 0) return Math.round(sum / count);

  return isAllHatched ? HATCH_BYTE : NO_DATA_BYTE;
}

/** Store each value's place on the colour stops as a byte, with NaN as no data. */
export function positionBytes(values: ArrayLike<number>, stops: number[]) {
  return Uint8Array.from(values, (value) =>
    Number.isNaN(value) ? NO_DATA_BYTE : Math.round(stopPosition(value, stops) * MAX_POSITION_BYTE),
  );
}
