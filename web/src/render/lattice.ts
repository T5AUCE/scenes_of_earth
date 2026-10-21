/** Encode field values as nested dot lattices and mask-aware no-data hatching. */
import { stopPosition } from "./colormap";

/** The finest and coarsest dot levels; a level L puts 2^L dot sites along each cell side. */
export const MIN_LEVEL = -6;
export const MAX_LEVEL = 6;

/** Dot radius at the top of the colour scale as a share of the dot spacing, inking 32 % of it. */
export const DOT_RADIUS_RATIO = 0.08;

/** Dot spacing to aim for in css px. */
const MIN_SPACING_PX = 40;

/** The largest dot radius in css px, reached once the level stops rising. */
export const MAX_DOT_RADIUS_PX = DOT_RADIUS_RATIO * 3 * MIN_SPACING_PX;

/** Dots that would be smaller than this radius in css px fade out by area instead. */
export const MIN_DOT_RADIUS_PX = 0.5;

/** How far a dot may sit from its site along each axis, as a share of the dot spacing. */
export const POSITION_JITTER_RATIO = 0.08;
/** How far a dot's radius may fall below the one its value calls for, as a share of it. */
export const SIZE_JITTER_RATIO = 0.2;
// The area varies symmetrically around the value's area so a cell's total ink keeps its value.
export const AREA_JITTER_RATIO = 1 - (1 - SIZE_JITTER_RATIO) ** 2;
/** The largest factor by which size jitter scales a radius. */
export const MAX_RADIUS_SCALE = Math.sqrt(1 + AREA_JITTER_RATIO);
/** The width in css px over which a dot's edge fades, which must also fit inside its sub-cell. */
export const EDGE_PX = 0.5;
/** The width in css px of the halo around a dot when it is drawn. */
export const HALO_WIDTH_PX = 0.6;

/** The byte that marks a cell with no value; positions use 0 to 253. */
export const NO_DATA_BYTE = 255;
/** The byte that hatches an in-area cell with no value, so the shader can tell it from outside. */
export const HATCH_BYTE = 254;
const MAX_POSITION_BYTE = 253;

// MapLibre draws the world 512 px wide at zoom 0.
const WORLD_PX_AT_ZOOM_0 = 512;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const FADE_START = 0.75;
// The offset keeps every level's sites nested in the next level's and the lattice phase stable.
const SLOT_OFFSET_CELLS = 15 / 32;

/** Site indexes are counted on the finest level so a site keeps its jitter at every zoom. */
export const FINEST_SLOTS = 2 ** MAX_LEVEL;
export const HASH_SALT = 0x9e3779b9;
const NOISE_BITS = 16;
const NOISE_HALF_RANGE = (2 ** NOISE_BITS - 1) / 2;

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

/** The largest dot radius in css px for dots this far apart, which the zoom cap limits. */
export function maxDotRadiusPx(spacingPx: number) {
  return Math.min(DOT_RADIUS_RATIO * spacingPx, MAX_DOT_RADIUS_PX);
}

/**
 * Shrink the largest dot radius so the most jittered, largest dot with its fading edge and halo
 * stays within its sub-cell, whichever axis of the stretched Mercator spacing is shorter.
 */
export function containedRadiusPx(
  spacingXPx: number,
  spacingYPx: number,
  maxRadiusPx: number,
  haloWidthPx: number,
) {
  const reachPx = EDGE_PX + haloWidthPx;
  const marginPx = Math.min(spacingXPx, spacingYPx) * (0.5 - POSITION_JITTER_RATIO) - reachPx;
  return Math.min(maxRadiusPx, Math.max(marginPx, 0) / MAX_RADIUS_SCALE);
}

/** The radius of a dot whose area is proportional to its position, then jittered by area. */
export function dotRadiusPx(position: number, maxRadiusPx: number, areaNoise: number) {
  return maxRadiusPx * Math.sqrt(position * (1 + AREA_JITTER_RATIO * areaNoise));
}

/** The radius to draw and the opacity of a dot, which fades by area below the minimum radius. */
export function dotAppearance(radiusPx: number) {
  return {
    radiusPx: Math.max(radiusPx, MIN_DOT_RADIUS_PX),
    opacity: Math.min(1, (radiusPx / MIN_DOT_RADIUS_PX) ** 2),
  };
}

/**
 * Two pseudo-random numbers from -1 to 1 for the site at an index on the finest level, which
 * shift the dot along both axes.
 */
export function siteNoise(finestColumn: number, finestRow: number) {
  const hash = siteHash(finestColumn, finestRow);
  return {
    x: noiseFrom(hash & 0xffff),
    y: noiseFrom(hash >>> NOISE_BITS),
  };
}

/**
 * A pseudo-random number from -1 to 1 that changes the area of the dot at a slot of a level.
 * Each site gets the opposite of the number of its point-reflected partner in the same cell, so
 * a cell's dots keep its ink. A cell with a single site gets none.
 */
export function areaNoise(column: number, row: number, level: number) {
  const slots = 2 ** Math.max(level, 0);
  if (slots === 1) return 0;

  const [partnerColumn, partnerRow] = [column, row].map((slot) => {
    const first = firstSlotOfCell(slot, slots);
    return first + (slots - 1 - (slot - first));
  });
  const isLower = column < partnerColumn || (column === partnerColumn && row < partnerRow);
  const [lowerColumn, lowerRow] = isLower ? [column, row] : [partnerColumn, partnerRow];
  const finestStep = 2 ** (MAX_LEVEL - Math.max(level, 0));
  const hash = siteHash(lowerColumn * finestStep, lowerRow * finestStep);
  const noise = noiseFrom(hash32(hash ^ HASH_SALT) & 0xffff);
  return isLower ? noise : -noise;
}

// Offset sites belong to the cell they sit in, not to a block of raw slot indices.
function firstSlotOfCell(slot: number, slots: number) {
  const cell = Math.floor(slot / slots + SLOT_OFFSET_CELLS);
  return cell * slots + Math.ceil(-SLOT_OFFSET_CELLS * slots);
}

function siteHash(finestColumn: number, finestRow: number) {
  return hash32((finestColumn ^ hash32(finestRow + HASH_SALT)) >>> 0);
}

function noiseFrom(bits: number) {
  return bits / NOISE_HALF_RANGE - 1;
}

// Matches hash32 in gpu/field-marks-shaders.ts.
function hash32(value: number) {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
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
