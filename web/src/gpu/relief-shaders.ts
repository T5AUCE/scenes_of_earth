/**
 * The relief fragment shader and its scalar reference. The reference runs the same arithmetic
 * as the shader, without the 8-bit slope rounding of `workers/shade-tile.ts`, so tests can
 * compare it with the raster path.
 */
import { RELIEF_LIGHTS } from "../layers/relief";
import { DEM_TILE_SIZE_PX } from "../workers/dem-decode";
import { demFragmentShader } from "./dem-draw";

// The prepare pass of MapLibre's hillshade divides slopes by the metres of one pixel.
const PIXEL_SIZE_OFFSET = 28.2562;
const EXAGGERATION_END_ZOOM = 15;
// The prepare pass stores slope / 8 + 128 / 255 in a byte, which clamps steep slopes.
const SLOPE_RANGE = 8;
const FLAT_SLOPE_LEVEL = 128 / 255;
const MIN_STORED_SLOPE = -FLAT_SLOPE_LEVEL * SLOPE_RANGE;
const MAX_STORED_SLOPE = (1 - FLAT_SLOPE_LEVEL) * SLOPE_RANGE;

/** The eight neighbours of a pixel in metres, named as the rows of a 3 by 3 stencil. */
export interface ReliefTaps {
  a: number;
  b: number;
  c: number;
  d: number;
  f: number;
  g: number;
  h: number;
  i: number;
}

/** What shapes the slope of one pixel besides its heights. */
export interface ReliefInput {
  slopeScale: number;
  exaggeration: number;
  /** One over the cosine of the latitude. */
  latitudeSecant: number;
}

/** The shade as premultiplied white and alpha; both are 0 on flat ground. */
export interface ReliefShade {
  white: number;
  alpha: number;
}

interface LightTerms {
  sinAltitude: number;
  slopeXTerm: number;
  slopeYTerm: number;
  shadowAlpha: number;
  highlightAlpha: number;
}

/** The constants of each light, which the shader receives as arrays. */
export const LIGHT_TERMS: readonly LightTerms[] = RELIEF_LIGHTS.map((light) => {
  const altitude = light.altitudeDeg * Math.PI / 180;
  const azimuth = light.azimuthDeg * Math.PI / 180;
  return {
    sinAltitude: Math.sin(altitude),
    slopeXTerm: -Math.sin(azimuth) * Math.cos(altitude),
    slopeYTerm: -Math.cos(azimuth) * Math.cos(altitude),
    shadowAlpha: light.shadowAlpha / RELIEF_LIGHTS.length,
    highlightAlpha: light.highlightAlpha / RELIEF_LIGHTS.length,
  };
});

/** The slope scale of a DEM tile at a zoom: its pixels per the metres one pixel spans. */
export function demSlopeScale(zoom: number, tileSizePx = DEM_TILE_SIZE_PX): number {
  return tileSizePx / 2 ** (prepareExaggeration(zoom) + PIXEL_SIZE_OFFSET - zoom);
}

function prepareExaggeration(zoom: number): number {
  if (zoom >= EXAGGERATION_END_ZOOM) return 0;

  const factor = zoom < 2 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3;
  return (zoom - EXAGGERATION_END_ZOOM) * factor;
}

/** Shade one pixel the way the fragment shader does, from the heights around it. */
export function reliefShade(taps: ReliefTaps, input: ReliefInput): ReliefShade {
  const { a, b, c, d, f, g, h, i } = taps;
  const slopeFactor = input.exaggeration * 2 * input.latitudeSecant;
  const slopeX = clampSlope((c + f + f + i - (a + d + d + g)) * input.slopeScale) * slopeFactor;
  const slopeY = clampSlope((g + h + h + i - (a + b + b + c)) * input.slopeScale) * slopeFactor;
  const steepness = Math.sqrt(1 + slopeX * slopeX + slopeY * slopeY);
  let alpha = 0;
  let white = 0;
  for (const light of LIGHT_TERMS) {
    const angle = (light.sinAltitude - slopeY * light.slopeYTerm + slopeX * light.slopeXTerm)
      / steepness;
    const shade = Math.min(Math.max(angle, 0), 1);
    if (shade > 0.5) {
      const highlight = light.highlightAlpha * (2 * shade - 1);
      alpha += highlight;
      white += highlight;
    } else {
      alpha += light.shadowAlpha * (1 - 2 * shade);
    }
  }
  return { white, alpha };
}

function clampSlope(slope: number): number {
  return Math.min(Math.max(slope, MIN_STORED_SLOPE), MAX_STORED_SLOPE);
}

function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : value.toPrecision(9);
}

function lightArray(name: string, pick: (light: LightTerms) => number): string {
  const values = LIGHT_TERMS.map((light) => glslFloat(pick(light))).join(", ");
  return `const float ${name}[${LIGHT_TERMS.length}] = float[${LIGHT_TERMS.length}](${values});`;
}

/** The relief fragment shader, which mixes the shade of up to two height textures. */
export const RELIEF_FRAGMENT_SHADER = demFragmentShader(`
uniform vec2 uSlopeScale;
uniform float uExaggeration;
out vec4 outColour;

const float MIN_STORED_SLOPE = ${glslFloat(MIN_STORED_SLOPE)};
const float MAX_STORED_SLOPE = ${glslFloat(MAX_STORED_SLOPE)};

const float TEXEL_UV = 1.0 / DEM_TILE_PX;
${lightArray("SIN_ALTITUDE", (light) => light.sinAltitude)}
${lightArray("SLOPE_X_TERM", (light) => light.slopeXTerm)}
${lightArray("SLOPE_Y_TERM", (light) => light.slopeYTerm)}
${lightArray("SHADOW_ALPHA", (light) => light.shadowAlpha)}
${lightArray("HIGHLIGHT_ALPHA", (light) => light.highlightAlpha)}

vec2 premultipliedRelief(sampler2D heights, vec2 uv, float slopeScale) {
  float a = demHeightAt(heights, uv + vec2(-TEXEL_UV, -TEXEL_UV));
  float b = demHeightAt(heights, uv + vec2(0.0, -TEXEL_UV));
  float c = demHeightAt(heights, uv + vec2(TEXEL_UV, -TEXEL_UV));
  float d = demHeightAt(heights, uv + vec2(-TEXEL_UV, 0.0));
  float f = demHeightAt(heights, uv + vec2(TEXEL_UV, 0.0));
  float g = demHeightAt(heights, uv + vec2(-TEXEL_UV, TEXEL_UV));
  float h = demHeightAt(heights, uv + vec2(0.0, TEXEL_UV));
  float i = demHeightAt(heights, uv + vec2(TEXEL_UV, TEXEL_UV));
  float slopeFactor = uExaggeration * 2.0 * vLatitudeSecant;
  float slopeX = clamp((c + f + f + i - (a + d + d + g)) * slopeScale,
    MIN_STORED_SLOPE, MAX_STORED_SLOPE) * slopeFactor;
  float slopeY = clamp((g + h + h + i - (a + b + b + c)) * slopeScale,
    MIN_STORED_SLOPE, MAX_STORED_SLOPE) * slopeFactor;
  float steepness = sqrt(1.0 + slopeX * slopeX + slopeY * slopeY);
  float alpha = 0.0;
  float white = 0.0;
  for (int light = 0; light < ${LIGHT_TERMS.length}; light++) {
    float angle = (SIN_ALTITUDE[light] - slopeY * SLOPE_Y_TERM[light]
      + slopeX * SLOPE_X_TERM[light]) / steepness;
    float shade = clamp(angle, 0.0, 1.0);
    if (shade > 0.5) {
      float highlight = HIGHLIGHT_ALPHA[light] * (2.0 * shade - 1.0);
      alpha += highlight;
      white += highlight;
    } else {
      alpha += SHADOW_ALPHA[light] * (1.0 - 2.0 * shade);
    }
  }
  return vec2(white, alpha);
}

vec4 shade(sampler2D heights, vec2 uv, float slopeScale) {
  vec2 relief = premultipliedRelief(heights, uv, slopeScale);
  return vec4(vec3(relief.x), relief.y);
}

// Both levels mix here in one pass, so a blend keeps the full strength of its shadows.
void main() {
  vec4 colour = shade(uHeightsA, vUvA, uSlopeScale.x) * uWeights.x;
  if (uWeights.y > 0.0) colour += shade(uHeightsB, vUvB, uSlopeScale.y) * uWeights.y;
  outColour = colour;
}`);
