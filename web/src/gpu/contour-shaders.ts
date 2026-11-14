/**
 * The contour fragment shader and its scalar reference. The reference runs the same arithmetic
 * as the shader, so tests can check the line rules without a GPU.
 */
import {
  FADE_SPAN_ZOOM,
  INTERVAL_CHAIN_M,
  type ContourLadder,
} from "../contour-ladder";
import { convertValue } from "../units";
import { demFragmentShader } from "./dem-draw";

/** The opacity of a fully shown tier. */
export const CONTOUR_OPACITY = 0.55;
export const MINOR_LINE_WIDTH_PX = 0.5;
export const BOLD_LINE_WIDTH_PX = 1.1;

/** The most tiers a ladder holds, which is the metres chain; the shader loops over all of them. */
export const MAX_TIERS = INTERVAL_CHAIN_M.length;

// Flat ground at an exact contour height, such as sea at 0 m, would otherwise fill solid.
const SLOPED_FROM_M_PER_PX = 0.001;
const SLOPED_TO_M_PER_PX = 0.004;
// A terrace at an exact contour height counts as below it, like the tracer's strict crossing.
export const TIE_BIAS_M = 0.001;
// Lines closer than about 5 CSS px fade out, and are gone at about 1.5 px.
const CLEAN_FADE_FROM_LINES_PER_PX = 0.2;
const CLEAN_FADE_TO_LINES_PER_PX = 0.65;
const MIN_LINES_PER_PX = 1e-6;

/** One height step as the shader draws it. */
export interface ContourTier {
  /** The step in metres, which is what the height texture holds. */
  intervalM: number;
  alpha: number;
  widthPx: number;
}

/** The uniform arrays of a ladder, which stay the same until the unit changes. */
export interface TierUniforms {
  intervalsM: Float32Array;
  widthsPx: Float32Array;
  entryZooms: readonly number[];
}

/** Lay the ladder's tiers out in the fixed-size arrays of the shader, coarsest first. */
export function tierUniformsOf(ladder: ContourLadder, elevationUnit: string): TierUniforms {
  const metresPerUnit = convertValue(1, elevationUnit, "m");
  // Unused slots keep a positive step so the shader never divides by zero.
  const intervalsM = new Float32Array(MAX_TIERS).fill(1);
  const widthsPx = new Float32Array(MAX_TIERS);
  ladder.tiers.forEach((tier, index) => {
    intervalsM[index] = tier.interval * metresPerUnit;
    widthsPx[index] = tier.interval >= ladder.boldInterval
      ? BOLD_LINE_WIDTH_PX
      : MINOR_LINE_WIDTH_PX;
  });
  return { intervalsM, widthsPx, entryZooms: ladder.tiers.map((tier) => tier.entryZoom) };
}

/**
 * Fade every tier in over `FADE_SPAN_ZOOM` from its entry zoom, leaving unused slots at 0.
 * Returns whether any tier shows at the zoom.
 */
export function fillTierAlphas(
  alphas: Float32Array,
  entryZooms: readonly number[],
  zoom: number,
): boolean {
  alphas.fill(0);
  entryZooms.forEach((entryZoom, index) => {
    const entered = Math.min(Math.max((zoom - entryZoom) / FADE_SPAN_ZOOM, 0), 1);
    alphas[index] = entered * CONTOUR_OPACITY;
  });
  return alphas.some((alpha) => alpha > 0);
}

/** The cubic B-spline over 4x4 texels inside the middle cell, with its slope per texel. */
export function smoothSurfaceOf(
  heights: readonly (readonly number[])[],
  fractionX: number,
  fractionY: number,
): { height: number; slopeX: number; slopeY: number } {
  const [weightsX, slopesX] = bSplineWeights(fractionX);
  const [weightsY, slopesY] = bSplineWeights(fractionY);
  const origin = heights[1][1];
  let relative = 0;
  let slopeX = 0;
  let slopeY = 0;
  heights.forEach((row, rowIndex) => row.forEach((height, columnIndex) => {
    const above = height - origin;
    relative += weightsX[columnIndex] * weightsY[rowIndex] * above;
    slopeX += slopesX[columnIndex] * weightsY[rowIndex] * above;
    slopeY += weightsX[columnIndex] * slopesY[rowIndex] * above;
  }));
  return { height: origin + relative, slopeX, slopeY };
}

function bSplineWeights(fraction: number): [number[], number[]] {
  const f = fraction;
  const inverse = 1 - f;
  const weights = [
    inverse ** 3 / 6,
    (3 * f ** 3 - 6 * f ** 2 + 4) / 6,
    (-3 * f ** 3 + 3 * f ** 2 + 3 * f + 1) / 6,
    f ** 3 / 6,
  ];
  const slopes = [
    -(inverse ** 2) / 2,
    (9 * f ** 2 - 12 * f) / 6,
    (-9 * f ** 2 + 6 * f + 3) / 6,
    f ** 2 / 2,
  ];
  return [weights, slopes];
}

/**
 * The coverage of the strongest tier at one pixel, from the height there and how many metres
 * the height changes per device pixel. The pixel ratio keeps the widths, the fade and the flat
 * guard in CSS pixels.
 */
export function contourCoverage(
  height: number,
  metresPerPixel: number,
  tiers: readonly ContourTier[],
  pixelRatio: number,
): number {
  let strongest = 0;
  for (const tier of tiers) {
    if (tier.alpha <= 0) continue;

    const linesPerPixel = Math.max(metresPerPixel / tier.intervalM, MIN_LINES_PER_PX);
    const level = (height - TIE_BIAS_M) / tier.intervalM;
    const distancePx = Math.abs(fract(level + 0.5) - 0.5) / linesPerPixel;
    const line = clamp(tier.widthPx * pixelRatio * 0.5 + 0.5 - distancePx);
    const crowding = smoothstep(
      CLEAN_FADE_FROM_LINES_PER_PX,
      CLEAN_FADE_TO_LINES_PER_PX,
      linesPerPixel * pixelRatio,
    );
    strongest = Math.max(strongest, line * (1 - crowding) * tier.alpha);
  }
  return strongest * smoothstep(
    SLOPED_FROM_M_PER_PX,
    SLOPED_TO_M_PER_PX,
    metresPerPixel * pixelRatio,
  );
}

/** The contour fragment shader, which mixes the lines of up to two height textures. */
export const CONTOUR_FRAGMENT_SHADER = demFragmentShader(`
uniform float uIntervals[${MAX_TIERS}];
uniform float uTierAlpha[${MAX_TIERS}];
uniform float uTierWidth[${MAX_TIERS}];
uniform float uPixelRatio;
uniform vec3 uColour;
out vec4 outColour;

// The slope needs each texel's own weight, so all 16 are read, relative to one for precision.
void smoothHeightAt(
  sampler2D heights,
  vec2 uv,
  out float origin,
  out float relative,
  out float metresPerPixel
) {
  vec2 coord = uv * DEM_TILE_PX + DEM_HALO_PX - 0.5;
  vec2 base = floor(coord);
  vec2 f = coord - base;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 g = 1.0 - f;
  vec2 w0 = g * g * g / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec4 weightsX = vec4(w0.x, w1.x, w2.x, w3.x);
  vec4 weightsY = vec4(w0.y, w1.y, w2.y, w3.y);
  vec4 slopesX = vec4(-g.x * g.x * 0.5, (9.0 * f2.x - 12.0 * f.x) / 6.0,
    (-9.0 * f2.x + 6.0 * f.x + 3.0) / 6.0, f2.x * 0.5);
  vec4 slopesY = vec4(-g.y * g.y * 0.5, (9.0 * f2.y - 12.0 * f.y) / 6.0,
    (-9.0 * f2.y + 6.0 * f.y + 3.0) / 6.0, f2.y * 0.5);

  ivec2 first = ivec2(base) - 1;
  ivec2 last = ivec2(DEM_TEXTURE_PX) - 1;
  origin = texelFetch(heights, clamp(first + 1, ivec2(0), last), 0).r;
  relative = 0.0;
  vec2 slope = vec2(0.0);
  for (int row = 0; row < 4; row++) {
    for (int column = 0; column < 4; column++) {
      ivec2 texel = clamp(first + ivec2(column, row), ivec2(0), last);
      float height = texelFetch(heights, texel, 0).r - origin;
      relative += weightsX[column] * weightsY[row] * height;
      slope += vec2(slopesX[column] * weightsY[row], weightsX[column] * slopesY[row]) * height;
    }
  }

  // The uv derivatives are smooth, unlike the quantized heights, so the slope stays steady.
  vec2 texelsPerPixelX = dFdx(uv) * DEM_TILE_PX;
  vec2 texelsPerPixelY = dFdy(uv) * DEM_TILE_PX;
  metresPerPixel = length(vec2(dot(slope, texelsPerPixelX), dot(slope, texelsPerPixelY)));
}

float contourCoverage(float origin, float relative, float metresPerPixel) {
  float strongest = 0.0;
  for (int tier = 0; tier < ${MAX_TIERS}; tier++) {
    if (uTierAlpha[tier] <= 0.0) continue;

    float linesPerPixel = max(metresPerPixel / uIntervals[tier], ${glslFloat(MIN_LINES_PER_PX)});
    float aboveLevelM = mod(origin, uIntervals[tier]) + relative - ${glslFloat(TIE_BIAS_M)};
    float level = aboveLevelM / uIntervals[tier];
    float distancePx = abs(fract(level + 0.5) - 0.5) / linesPerPixel;
    float line = clamp(uTierWidth[tier] * uPixelRatio * 0.5 + 0.5 - distancePx, 0.0, 1.0);
    float crowding = smoothstep(
      ${glslFloat(CLEAN_FADE_FROM_LINES_PER_PX)},
      ${glslFloat(CLEAN_FADE_TO_LINES_PER_PX)},
      linesPerPixel * uPixelRatio
    );
    strongest = max(strongest, line * (1.0 - crowding) * uTierAlpha[tier]);
  }
  return strongest * smoothstep(
    ${glslFloat(SLOPED_FROM_M_PER_PX)},
    ${glslFloat(SLOPED_TO_M_PER_PX)},
    metresPerPixel * uPixelRatio
  );
}

vec4 contourLine(sampler2D heights, vec2 uv) {
  float origin;
  float relative;
  float metresPerPixel;
  smoothHeightAt(heights, uv, origin, relative, metresPerPixel);
  float coverage = contourCoverage(origin, relative, metresPerPixel);
  return vec4(uColour * coverage, coverage);
}

// Both levels mix here in one pass, so a blend keeps the full strength of its lines.
void main() {
  vec4 colour = contourLine(uHeightsA, vUvA) * uWeights.x;
  if (uWeights.y > 0.0) colour += contourLine(uHeightsB, vUvB) * uWeights.y;
  outColour = colour;
}`);

function fract(value: number): number {
  return value - Math.floor(value);
}

function clamp(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function smoothstep(from: number, to: number, value: number): number {
  const position = clamp((value - from) / (to - from));
  return position * position * (3 - 2 * position);
}

function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
