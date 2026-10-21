/** Encode field values as nested dot lattices and mask-aware no-data hatching. */
import { stopPosition } from "./colormap";

/** The finest and coarsest dot levels; a level L puts 2^L dot sites along each cell side. */
export const MIN_LEVEL = -6;
export const MAX_LEVEL = 6;

/** Dot radius at the top of the colour scale as a share of the zoomed-in dot spacing. */
export const DOT_RADIUS_RATIO = 0.09;

/** A dot's radius grows with its value to this power, so a quarter-value dot is 35% as wide. */
export const VALUE_RADIUS_EXPONENT = 0.75;

/** Density steps are equal ratios, with the default exactly twelve steps above the minimum. */
export const MIN_DENSITY_LOG2 = -1.5;
export const MAX_DENSITY_LOG2 = 0.5;
export const DENSITY_STEP_LOG2 = 1 / 8;

/** Density scales the number of sites along each axis, not the total number of dots. */
export const MIN_DENSITY_RATIO = 2 ** MIN_DENSITY_LOG2;
export const MAX_DENSITY_RATIO = 2 ** MAX_DENSITY_LOG2;
export const DEFAULT_DENSITY_RATIO = 1;

/** Dot spacing to aim for in css px when zoomed in; zoomed out it eases down to the next one. */
export const MIN_SPACING_PX = 30;

/** Dot spacing to aim for in css px when zoomed out, where denser dots read better. */
const ZOOMED_OUT_SPACING_PX = 15;

/** The zoomed-out spacing applies up to the first zoom and the zoomed-in one from the second. */
const ZOOMED_OUT_ZOOM = 6;
const ZOOMED_IN_ZOOM = 10;

/** The full-value dot radius in css px at the aimed spacing at the default density. */
const DOT_RADIUS_PX = DOT_RADIUS_RATIO * MIN_SPACING_PX;

/** The largest dot radius in css px at the default density, reached once the level stops rising. */
export const MAX_DOT_RADIUS_PX = 3 * DOT_RADIUS_PX;

/** Dots that would be smaller than this radius in css px fade out by area instead. */
export const MIN_DOT_RADIUS_PX = 0.5;

/** The zoom where dots finish fading out at a device pixel ratio of one. */
export const HIGH_ZOOM_FADE_END_ZOOM = 18;

/** The zoom span over which dots fade out before that end. */
export const HIGH_ZOOM_FADE_SPAN_ZOOM = 0.5;

/** How far a dot may sit from its site along each axis, as a share of the dot spacing. */
export const POSITION_JITTER_RATIO = 0.08;
/** How far a dot's radius may fall below the one its value calls for, as a share of it. */
export const SIZE_JITTER_RATIO = 0.2;
// The area varies symmetrically around the value's dot area so a cell keeps the ink of its value.
export const AREA_JITTER_RATIO = 1 - (1 - SIZE_JITTER_RATIO) ** 2;
/** The largest factor by which size jitter scales a radius. */
export const MAX_RADIUS_SCALE = Math.sqrt(1 + AREA_JITTER_RATIO);
/** The width in css px over which a dot's edge fades, which must also fit inside its sub-cell. */
export const EDGE_PX = 0.5;
/** The width in css px of the halo around a dot when it is drawn. */
export const HALO_WIDTH_PX = 0.6;
// Two routes to the same radius can differ in the last float bit.
const RADIUS_TOLERANCE_PX = 1e-9;

/** The byte that marks a cell with no value; positions use 0 to 253. */
export const NO_DATA_BYTE = 255;
/** The byte that hatches an in-area cell with no value, so the shader can tell it from outside. */
export const HATCH_BYTE = 254;
const MAX_POSITION_BYTE = 253;

// MapLibre draws the world 512 px wide at zoom 0.
const WORLD_PX_AT_ZOOM_0 = 512;
const DEGREES_PER_RADIAN = 180 / Math.PI;
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

/** The on-screen width and height of a cell in css px, where Mercator stretches the height. */
export function cellSidesPx(
  zoom: number,
  cellDegrees: { width: number; height: number },
  latitude: number,
) {
  const pxPerDegree = (WORLD_PX_AT_ZOOM_0 * 2 ** zoom) / 360;
  const stretch = 1 / Math.cos(latitude / DEGREES_PER_RADIAN);
  return {
    width: pxPerDegree * cellDegrees.width,
    height: pxPerDegree * cellDegrees.height * stretch,
  };
}

/** Keep a density within its range. */
export function clampDensity(density: number) {
  return Math.min(MAX_DENSITY_RATIO, Math.max(MIN_DENSITY_RATIO, density));
}

/** Keep a density within its range and on the slider's step. */
export function quantiseDensity(density: number) {
  const steps = Math.round(Math.log2(clampDensity(density)) / DENSITY_STEP_LOG2);
  return 2 ** (steps * DENSITY_STEP_LOG2);
}

/**
 * The dot spacing to aim for at a zoom, easing geometrically between the two set spacings and
 * shrinking by the density.
 */
export function aimedSpacingPx(zoom: number, density = DEFAULT_DENSITY_RATIO) {
  const span = ZOOMED_IN_ZOOM - ZOOMED_OUT_ZOOM;
  const progress = Math.min(1, Math.max(0, (zoom - ZOOMED_OUT_ZOOM) / span));
  const spacingPx = ZOOMED_OUT_SPACING_PX * (MIN_SPACING_PX / ZOOMED_OUT_SPACING_PX) ** progress;
  return spacingPx / density;
}

/** Choose the level whose dot spacing is one to two aimed spacings and its progress to the next. */
export function levelFor(cellPx: number, aimedPx = MIN_SPACING_PX) {
  const exact = Math.log2(cellPx / aimedPx);
  const level = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.floor(exact)));
  if (level === MAX_LEVEL) return { level, fade: 0 };

  // A full-interval fade lets density steps change the dots between nested lattice levels.
  const progress = Math.min(1, Math.max(0, exact - level));
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
 * The largest dot radius in css px for dots this far apart at a lattice level. Dots shrink by the
 * density that shrank the aimed spacing, so the share of the surface they ink stays put. Once the
 * level reaches MAX_LEVEL no sites are added, so the default density keeps a denser setting from
 * thinning the same dots.
 */
export function maxDotRadiusPx(
  spacingPx: number,
  level: number,
  aimedPx = MIN_SPACING_PX,
  density = DEFAULT_DENSITY_RATIO,
) {
  if (level >= MAX_LEVEL) {
    return Math.min(DOT_RADIUS_PX * (spacingPx / (aimedPx * density)), MAX_DOT_RADIUS_PX);
  }

  return Math.min(DOT_RADIUS_PX * (spacingPx / aimedPx), MAX_DOT_RADIUS_PX) / density;
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

/** The dot spacing along each axis in css px at a level, for cell sides in css px. */
export function levelSpacingPx(sidesPx: { width: number; height: number }, level: number) {
  return { x: sidesPx.width / 2 ** level, y: sidesPx.height / 2 ** level };
}

/**
 * The dot lattice at a zoom, with a density whose dots the shortest cell axis can hold.
 */
export interface DotLattice {
  level: number;
  fade: number;
  sidesPx: { width: number; height: number };
  aimedPx: number;
  density: number;
  pixelRatio: number;
}

/**
 * The largest dot radius in css px at a level as the shader draws it. The shader works in device
 * px, so containment leaves room for the device-px edge and halo.
 */
export function levelRadiusPx(
  sidesPx: { width: number; height: number },
  level: number,
  aimedPx: number,
  pixelRatio: number,
  density = DEFAULT_DENSITY_RATIO,
) {
  const spacingPx = levelSpacingPx(sidesPx, level);
  const cellPx = Math.sqrt(sidesPx.width * sidesPx.height);
  const zoomCapPx = maxDotRadiusPx(cellPx / 2 ** level, level, aimedPx, density);
  return containedRadiusPx(
    spacingPx.x * pixelRatio,
    spacingPx.y * pixelRatio,
    zoomCapPx * pixelRatio,
    HALO_WIDTH_PX,
  ) / pixelRatio;
}

/**
 * The dot lattice for a cell at a zoom. A density whose dot the shortest axis would clip is
 * lowered to the closest logarithmic step that fits, so a denser setting does not thin the ink.
 */
export function dotLattice(
  cellDegrees: { width: number; height: number },
  latitude: number,
  zoom: number,
  density: number,
  pixelRatio: number,
): DotLattice {
  const sidesPx = cellSidesPx(zoom, cellDegrees, latitude);
  const cellPx = Math.sqrt(sidesPx.width * sidesPx.height);
  const fitting = containedDensity(cellPx, sidesPx, zoom, density, pixelRatio);
  const aimedPx = aimedSpacingPx(zoom, fitting);
  const { level, fade } = levelFor(cellPx, aimedPx);

  return { level, fade, sidesPx, aimedPx, density: fitting, pixelRatio };
}

function containedDensity(
  cellPx: number,
  sidesPx: { width: number; height: number },
  zoom: number,
  density: number,
  pixelRatio: number,
) {
  const highestStep = Math.round(Math.log2(quantiseDensity(density)) / DENSITY_STEP_LOG2);
  const lowestStep = MIN_DENSITY_LOG2 / DENSITY_STEP_LOG2;
  for (let step = highestStep; step >= lowestStep; step--) {
    const candidate = 2 ** (step * DENSITY_STEP_LOG2);
    if (fitsContainment(cellPx, sidesPx, zoom, candidate, pixelRatio)) return candidate;
  }

  return MIN_DENSITY_RATIO;
}

function fitsContainment(
  cellPx: number,
  sidesPx: { width: number; height: number },
  zoom: number,
  density: number,
  pixelRatio: number,
) {
  const aimedPx = aimedSpacingPx(zoom, density);
  const { level, fade } = levelFor(cellPx, aimedPx);
  const drawnLevel = fade > 0 ? level + 1 : level;
  for (let activeLevel = level; activeLevel <= drawnLevel; activeLevel++) {
    const fullRadiusPx = maxDotRadiusPx(cellPx / 2 ** activeLevel, activeLevel, aimedPx, density);
    const containedPx = levelRadiusPx(sidesPx, activeLevel, aimedPx, pixelRatio, density);
    if (containedPx < fullRadiusPx - RADIUS_TOLERANCE_PX) return false;
  }

  return true;
}

/** The radius of a dot that grows with its position by the exponent, then jittered by area. */
export function dotRadiusPx(position: number, maxRadiusPx: number, areaNoise: number) {
  return maxRadiusPx * position ** VALUE_RADIUS_EXPONENT
    * Math.sqrt(1 + AREA_JITTER_RATIO * areaNoise);
}

/** The radius to draw and the opacity of a dot, which fades by area below the minimum radius. */
export function dotAppearance(radiusPx: number) {
  return {
    radiusPx: Math.max(radiusPx, MIN_DOT_RADIUS_PX),
    opacity: Math.min(1, (radiusPx / MIN_DOT_RADIUS_PX) ** 2),
  };
}

/**
 * The opacity of dots at a zoom and device pixel ratio. The GPU keeps grid coordinates in
 * float32, so dots break into noise once the device-pixel zoom passes about 18.7. They fade out
 * before that.
 */
export function highZoomDotOpacity(zoom: number, pixelRatio: number) {
  const endZoom = HIGH_ZOOM_FADE_END_ZOOM - Math.log2(Math.max(1, pixelRatio));
  const startZoom = endZoom - HIGH_ZOOM_FADE_SPAN_ZOOM;
  const progress = Math.min(1, Math.max(0, (zoom - startZoom) / HIGH_ZOOM_FADE_SPAN_ZOOM));
  return 1 - progress * progress * (3 - 2 * progress);
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
