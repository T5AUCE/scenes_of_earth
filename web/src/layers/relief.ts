import type { LayerSpecification } from "maplibre-gl";

type HillshadePaint = NonNullable<Extract<LayerSpecification, { type: "hillshade" }>["paint"]>;

/** Configure visit-only strength with 2 as the default and 0 as no shading. */
export const RELIEF_STRENGTH = { min: 0, max: 5, step: 0.1, initial: 2 };

// The style spec caps exaggeration at 1, but MapLibre does not range-check expression output and
// the multidirectional shader scales slopes linearly, so larger values still steepen the shading.
const MAX_EXAGGERATION = 3.5;
const LOW_DETAIL_ZOOM = 4;
const HIGH_DETAIL_ZOOM = 12;
// Low zoom needs gentler shading because MapLibre already steepens slopes there.
const LOW_DETAIL_EXAGGERATION = 0.4;
const HIGH_DETAIL_EXAGGERATION = 0.7;

/**
 * The three lights of the relief shading, shared by the hillshade paint and the CPU shading.
 * MapLibre's multidirectional shader is transparent on flat ground only at sin(altitude) = 0.5.
 */
export const RELIEF_LIGHTS = [
  { azimuthDeg: 315, altitudeDeg: 30, shadowAlpha: 0.55, highlightAlpha: 0.35 },
  { azimuthDeg: 255, altitudeDeg: 30, shadowAlpha: 0.22, highlightAlpha: 0.08 },
  { azimuthDeg: 15, altitudeDeg: 30, shadowAlpha: 0.22, highlightAlpha: 0.08 },
];

const ACCENT_COLOR = "rgba(0,0,0,0.1)";

/** Return strictly neutral shading scaled by the visit's relief strength. */
export function reliefPaint(strength: number): HillshadePaint {
  return {
    "hillshade-method": "multidirectional",
    "hillshade-illumination-anchor": "map",
    "hillshade-illumination-direction": RELIEF_LIGHTS.map((light) => light.azimuthDeg),
    "hillshade-illumination-altitude": RELIEF_LIGHTS.map((light) => light.altitudeDeg),
    "hillshade-shadow-color": RELIEF_LIGHTS.map((light) => `rgba(0,0,0,${light.shadowAlpha})`),
    "hillshade-highlight-color": RELIEF_LIGHTS.map(
      (light) => `rgba(255,255,255,${light.highlightAlpha})`,
    ),
    "hillshade-accent-color": ACCENT_COLOR,
    "hillshade-exaggeration": [
      "interpolate",
      ["linear"],
      ["zoom"],
      LOW_DETAIL_ZOOM,
      exaggeration(LOW_DETAIL_EXAGGERATION, strength),
      HIGH_DETAIL_ZOOM,
      exaggeration(HIGH_DETAIL_EXAGGERATION, strength),
    ],
  };
}

/**
 * Return the exaggeration the paint's zoom ramp gives at a zoom, so pre-shaded tiles can bake
 * the value MapLibre would evaluate there. Zooms outside the ramp keep its end values.
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
