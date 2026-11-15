/** Shared relief lights and exaggeration for the GPU relief shader. */

/** Configure visit-only strength with 2 as the default and 0 as no shading. */
export const RELIEF_STRENGTH = { min: 0, max: 5, step: 0.1, initial: 2 };

// The shader scales slopes linearly, so larger values still steepen the shading.
const MAX_EXAGGERATION = 3.5;
const LOW_DETAIL_ZOOM = 4;
const HIGH_DETAIL_ZOOM = 12;
// Low zoom needs gentler shading because slopes read steeper there.
const LOW_DETAIL_EXAGGERATION = 0.4;
const HIGH_DETAIL_EXAGGERATION = 0.7;

/**
 * The three lights of the relief shading, shared by the GPU shader and its scalar reference.
 * The shader stays transparent on flat ground only at sin(altitude) = 0.5.
 */
export const RELIEF_LIGHTS = [
  { azimuthDeg: 315, altitudeDeg: 30, shadowAlpha: 0.55, highlightAlpha: 0.35 },
  { azimuthDeg: 255, altitudeDeg: 30, shadowAlpha: 0.22, highlightAlpha: 0.08 },
  { azimuthDeg: 15, altitudeDeg: 30, shadowAlpha: 0.22, highlightAlpha: 0.08 },
];

/**
 * Return the exaggeration the relief shader uses at a zoom, ramping between the low and high
 * detail ends. Zooms outside the ramp keep its end values.
 */
export function reliefExaggeration(zoom: number, strength: number): number {
  const low = exaggeration(LOW_DETAIL_EXAGGERATION, strength);
  const high = exaggeration(HIGH_DETAIL_EXAGGERATION, strength);
  const along = (zoom - LOW_DETAIL_ZOOM) / (HIGH_DETAIL_ZOOM - LOW_DETAIL_ZOOM);

  return low + (high - low) * Math.min(Math.max(along, 0), 1);
}

function exaggeration(base: number, strength: number) {
  return Math.min(Math.max(base * strength, 0), MAX_EXAGGERATION);
}
