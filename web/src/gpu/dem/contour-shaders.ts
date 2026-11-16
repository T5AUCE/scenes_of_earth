/**
 * The contour fragment shader and its scalar reference. The reference runs the same arithmetic
 * as the shader, so tests can check the line rules without a GPU.
 */
import { FADE_SPAN_ZOOM, INTERVAL_CHAIN_M, type ContourLadder } from "../../contour-ladder";
import { convertValue } from "../../units";
import { glslFloat } from "../gl";
import { demFragmentShader } from "./draw";

/** The opacity of a fully shown tier. */
export const CONTOUR_OPACITY = 0.55;
export const MINOR_LINE_WIDTH_PX = 0.5;
export const BOLD_LINE_WIDTH_PX = 1.1;

/** The most tiers a ladder holds, which is the metres chain; the shader loops over all of them. */
export const MAX_TIERS = INTERVAL_CHAIN_M.length;

// A terrace rim has a slope near zero, so this floor keeps its line while the bias exceeds a pixel.
const MIN_SLOPE_M_PER_CSS_PX = 0.0005;
// A terrace at an exact contour height counts as below it, like the tracer's strict crossing.
export const TIE_BIAS_M = 0.001;
// Lines closer than about 5 CSS px fade out, and are gone at about 1.5 px.
const CLEAN_FADE_FROM_LINES_PER_PX = 0.2;
const CLEAN_FADE_TO_LINES_PER_PX = 0.65;

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
    widthsPx[index] =
      tier.interval >= ladder.boldInterval ? BOLD_LINE_WIDTH_PX : MINOR_LINE_WIDTH_PX;
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

/** A height field at one pixel, with its slope in metres per pixel and the heights it came from. */
export interface HeightSurface {
  height: number;
  gradientX: number;
  gradientY: number;
  minM: number;
  maxM: number;
}

/** The cubic B-spline over 4x4 texels inside the middle cell, with its slope per screen pixel. */
export function smoothSurfaceOf(
  heights: readonly (readonly number[])[],
  fractionX: number,
  fractionY: number,
  pixelsPerTexel = 1,
): HeightSurface {
  const [weightsX, slopesX] = bSplineWeights(fractionX);
  const [weightsY, slopesY] = bSplineWeights(fractionY);
  const origin = heights[1][1];

  let relative = 0;
  let slopeX = 0;
  let slopeY = 0;
  heights.forEach((row, rowIndex) =>
    row.forEach((height, columnIndex) => {
      const above = height - origin;
      relative += weightsX[columnIndex] * weightsY[rowIndex] * above;
      slopeX += slopesX[columnIndex] * weightsY[rowIndex] * above;
      slopeY += weightsX[columnIndex] * slopesY[rowIndex] * above;
    }),
  );

  const all = heights.flat();

  return {
    height: origin + relative,
    gradientX: slopeX / pixelsPerTexel,
    gradientY: slopeY / pixelsPerTexel,
    minM: Math.min(...all),
    maxM: Math.max(...all),
  };
}

/**
 * Mix two height fields into one, so a blend of two levels draws a single line that glides
 * instead of two partial ones. The weights are normalised by their total, which is below 1 while
 * a source has no ready ancestor; the caller scales the coverage by that total. Returns the
 * arguments of `contourCoverage`.
 */
export function blendSurfaces(
  first: HeightSurface,
  second: HeightSurface,
  secondWeight: number,
  firstWeight = 1 - secondWeight,
): { height: number; metresPerPixel: number; lowestM: number; highestM: number } {
  const totalWeight = firstWeight + secondWeight;
  const mix = (from: number, to: number) => (from * firstWeight + to * secondWeight) / totalWeight;

  const lowestM =
    secondWeight <= 0
      ? first.minM
      : firstWeight <= 0
        ? second.minM
        : Math.min(first.minM, second.minM);
  const highestM =
    secondWeight <= 0
      ? first.maxM
      : firstWeight <= 0
        ? second.maxM
        : Math.max(first.maxM, second.maxM);

  return {
    height: mix(first.height, second.height),
    metresPerPixel: Math.hypot(
      mix(first.gradientX, second.gradientX),
      mix(first.gradientY, second.gradientY),
    ),
    lowestM,
    highestM,
  };
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
 * the height changes per device pixel, and the lowest and highest taps the surface was built from.
 * A tier only draws where its nearest level lies between those taps, so a near miss on one side
 * of a seam stays empty. The pixel ratio keeps the widths, the fade and the slope floor in
 * CSS pixels.
 */
export function contourCoverage(
  height: number,
  metresPerPixel: number,
  tiers: readonly ContourTier[],
  pixelRatio: number,
  lowestM = -Infinity,
  highestM = Infinity,
): number {
  const slope = Math.max(metresPerPixel, MIN_SLOPE_M_PER_CSS_PX / pixelRatio);
  let strongest = 0;

  for (const tier of tiers) {
    if (tier.alpha <= 0) continue;

    const level = (height - TIE_BIAS_M) / tier.intervalM;
    // The coast already shows sea level, so the zero contour stays hidden at every zoom.
    if (Math.round(level) === 0) continue;

    const levelAbsM = Math.round(level) * tier.intervalM + TIE_BIAS_M;
    if (levelAbsM < lowestM || levelAbsM >= highestM) continue;

    const linesPerPixel = slope / tier.intervalM;
    const distancePx = Math.abs(fract(level + 0.5) - 0.5) / linesPerPixel;
    const line = clamp(tier.widthPx * pixelRatio * 0.5 + 0.5 - distancePx);
    const crowding = smoothstep(
      CLEAN_FADE_FROM_LINES_PER_PX,
      CLEAN_FADE_TO_LINES_PER_PX,
      linesPerPixel * pixelRatio,
    );
    strongest = Math.max(strongest, line * (1 - crowding) * tier.alpha);
  }

  return strongest;
}

/** The contour fragment shader, which mixes the height fields of up to two textures. */
export const CONTOUR_FRAGMENT_SHADER = demFragmentShader(`
uniform float uIntervals[${MAX_TIERS}];
uniform float uTierAlpha[${MAX_TIERS}];
uniform float uTierWidth[${MAX_TIERS}];
uniform float uPixelRatio;
uniform vec3 uColour;
out vec4 outColour;

struct HeightSample {
  float origin;
  float relative;
  vec2 gradient;
  float lowest;
  float highest;
};

// The slope needs each texel's own weight, so all 16 are read, relative to one for precision.
HeightSample smoothHeightAt(sampler2D heights, vec2 uv) {
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
  float origin = texelFetch(heights, clamp(first + 1, ivec2(0), last), 0).r;
  float relative = 0.0;
  float lowest = 0.0;
  float highest = 0.0;
  vec2 slope = vec2(0.0);
  for (int row = 0; row < 4; row++) {
    for (int column = 0; column < 4; column++) {
      ivec2 texel = clamp(first + ivec2(column, row), ivec2(0), last);
      float height = texelFetch(heights, texel, 0).r - origin;
      lowest = min(lowest, height);
      highest = max(highest, height);
      relative += weightsX[column] * weightsY[row] * height;
      slope += vec2(slopesX[column] * weightsY[row], weightsX[column] * slopesY[row]) * height;
    }
  }

  // The uv derivatives are smooth, unlike the quantized heights, so the slope stays steady.
  vec2 texelsPerPixelX = dFdx(uv) * DEM_TILE_PX;
  vec2 texelsPerPixelY = dFdy(uv) * DEM_TILE_PX;
  vec2 gradient = vec2(dot(slope, texelsPerPixelX), dot(slope, texelsPerPixelY));
  return HeightSample(origin, relative, gradient, lowest, highest);
}

float contourCoverage(HeightSample surface) {
  float slope = max(length(surface.gradient), ${glslFloat(MIN_SLOPE_M_PER_CSS_PX)} / uPixelRatio);
  float strongest = 0.0;
  for (int tier = 0; tier < ${MAX_TIERS}; tier++) {
    if (uTierAlpha[tier] <= 0.0) continue;

    float intervalM = uIntervals[tier];
    float originModM = mod(surface.origin, intervalM);
    float nearM = originModM + surface.relative;
    float level = (nearM - ${glslFloat(TIE_BIAS_M)}) / intervalM;
    // The coast already shows sea level, so the zero contour stays hidden at every zoom.
    float absoluteLevel = floor(surface.origin / intervalM) + round(level);
    if (absoluteLevel == 0.0) continue;
    float levelRelM = round(level) * intervalM - originModM + ${glslFloat(TIE_BIAS_M)};
    if (levelRelM < surface.lowest || levelRelM >= surface.highest) continue;

    float linesPerPixel = slope / intervalM;
    float distancePx = abs(fract(level + 0.5) - 0.5) / linesPerPixel;
    float line = clamp(uTierWidth[tier] * uPixelRatio * 0.5 + 0.5 - distancePx, 0.0, 1.0);
    float crowding = smoothstep(
      ${glslFloat(CLEAN_FADE_FROM_LINES_PER_PX)},
      ${glslFloat(CLEAN_FADE_TO_LINES_PER_PX)},
      linesPerPixel * uPixelRatio
    );
    strongest = max(strongest, line * (1.0 - crowding) * uTierAlpha[tier]);
  }
  return strongest;
}

// Two levels mix their height fields, because mixing their lines would show both traces.
void main() {
  HeightSample surface = smoothHeightAt(uHeightsA, vUvA);
  float totalWeight = uWeights.x + uWeights.y;
  if (uWeights.y > 0.0) {
    HeightSample second = smoothHeightAt(uHeightsB, vUvB);
    float offset = second.origin - surface.origin;
    if (uWeights.x <= 0.0) {
      surface = second;
    } else {
      surface.relative = (uWeights.x * surface.relative + uWeights.y * (second.relative + offset))
        / totalWeight;
      surface.gradient = (uWeights.x * surface.gradient + uWeights.y * second.gradient) / totalWeight;
      surface.lowest = min(surface.lowest, second.lowest + offset);
      surface.highest = max(surface.highest, second.highest + offset);
    }
  }
  float coverage = contourCoverage(surface) * totalWeight;
  outColour = vec4(uColour * coverage, coverage);
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
