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

const WORLD_SPAN_DEG = 360;

const LIGHT_DIRECTIONS_DEG = [315, 255, 15];
// MapLibre's multidirectional shader is transparent on flat ground only at sin(altitude) = 0.5.
const LIGHT_ALTITUDES_DEG = [30, 30, 30];
const SHADOW_COLORS = ["rgba(0,0,0,0.55)", "rgba(0,0,0,0.22)", "rgba(0,0,0,0.22)"];
const HIGHLIGHT_COLORS = [
  "rgba(255,255,255,0.35)",
  "rgba(255,255,255,0.08)",
  "rgba(255,255,255,0.08)",
];
const ACCENT_COLOR = "rgba(0,0,0,0.1)";

/** Return strictly neutral shading scaled by the visit's relief strength. */
export function reliefPaint(strength: number): HillshadePaint {
  return {
    "hillshade-method": "multidirectional",
    "hillshade-illumination-anchor": "map",
    "hillshade-illumination-direction": LIGHT_DIRECTIONS_DEG,
    "hillshade-illumination-altitude": LIGHT_ALTITUDES_DEG,
    "hillshade-shadow-color": SHADOW_COLORS,
    "hillshade-highlight-color": HIGHLIGHT_COLORS,
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

function exaggeration(base: number, strength: number) {
  return Math.min(Math.max(base * strength, 0), MAX_EXAGGERATION);
}

/** Cap the contour backdrop near the fitted zoom so it stays available when zooming out. */
export function backdropMaxZoom(
  longitudeSpanDeg: number,
  viewWidthPx: number,
  tileSizePx: number,
  sourceMaxZoom: number,
) {
  const worldWidthPx = (viewWidthPx * WORLD_SPAN_DEG) / longitudeSpanDeg;
  const fittedZoom = Math.log2(worldWidthPx / tileSizePx);
  const zoom = Math.max(0, Math.ceil(fittedZoom));
  return Math.min(zoom, sourceMaxZoom);
}
