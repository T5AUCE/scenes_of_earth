/** Supply GLSL ES 3.00 shaders for nested field dots and mask-aware no-data hatching. */
import {
  AREA_JITTER_RATIO,
  EDGE_PX,
  FINEST_SLOTS,
  HALO_WIDTH_PX,
  HASH_SALT,
  MAX_RADIUS_SCALE,
  MIN_DOT_RADIUS_PX,
  POSITION_JITTER_RATIO,
} from "../render/lattice";
import { CLASS_FIELD_VERTEX } from "./class-field-shaders";

/**
 * Reuse the class-field vertex shader to place field dots and hatching.
 *
 * `uIds` holds a position byte per cell or per block of cells below level 0.
 * Bytes from 0 to 253 locate a value on the colour stops. Byte 254 hatches an in-area cell
 * with no value while 255 draws nothing. `uIdsSize` is its size and `uWindow` the grid column
 * and row of its first texel, while `uGridSize` is the whole grid's size in texels and
 * `uExtentCells` the size in cells of the grid before it was padded to whole blocks. `uRows`
 * holds `uRowCount` fractional grid rows at even Mercator heights.
 *
 * Each texel is one cell of the dot level, or a block of `uBlockCells` cells below level 0.
 * `uInk` colours the dots and hatch while `uHaloInk` colours the halo around dots.
 * `uSlots` is the number of dot sites along a cell side. A dot's area is proportional to its
 * position byte, so `uRadiusPx` is the radius at byte 253 before it is shrunk to fit its sub-cell.
 * While `uFading`, the level above fades into this one by `uFade`. Its sites are `uParentSlots`
 * along a texel while a dot there shrinks from `uParentRadiusPx`. Below level 1 the parent's own
 * bytes come from `uParentIds`, which has the size of `uIds`. `uDots` draws the dots and `uHatch`
 * the no-data hatch, whose screen-space lines are measured through `uPixelRatio`.
 */
export const FIELD_MARKS_VERTEX = CLASS_FIELD_VERTEX;

export const FIELD_MARKS_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

in vec2 vPosition;
uniform usampler2D uIds;
uniform usampler2D uParentIds;
uniform sampler2D uRows;
uniform ivec2 uIdsSize;
uniform vec2 uWindow;
uniform vec2 uGridSize;
uniform vec2 uExtentCells;
uniform int uRowCount;
uniform float uSlots;
uniform float uParentSlots;
uniform float uBlockCells;
uniform float uRadiusPx;
uniform float uParentRadiusPx;
uniform bool uFading;
uniform float uFade;
uniform vec3 uInk;
uniform vec3 uHaloInk;
uniform bool uHalo;
uniform bool uDots;
uniform bool uHatch;
uniform float uPixelRatio;
out vec4 fragColor;

const uint HATCH = 254u;
const float MAX_POSITION = 253.0;
const float SLOT_OFFSET_CELLS = 15.0 / 32.0;
const float FINEST_SLOTS = ${glslFloat(FINEST_SLOTS)};
const float POSITION_JITTER = ${glslFloat(POSITION_JITTER_RATIO)};
const float AREA_JITTER = ${glslFloat(AREA_JITTER_RATIO)};
const float MAX_RADIUS_SCALE = ${glslFloat(MAX_RADIUS_SCALE)};
const float MIN_DOT_RADIUS_PX = ${glslFloat(MIN_DOT_RADIUS_PX)};
const float NO_VALUE = -1.0;
const uint HASH_SALT = ${HASH_SALT}u;
const float HALO_ALPHA = 0.7;
const float HALO_WIDTH_PX = ${glslFloat(HALO_WIDTH_PX)};
const float EDGE_PX = ${glslFloat(EDGE_PX)};
const float MIN_ALPHA = 0.004;
const float HATCH_SPACING_PX = 6.0;
const float HATCH_LINE_PX = 0.6;

struct Mark {
  float dotAlpha;
  float haloAlpha;
};

float gridRow() {
  float position = vPosition.y * float(uRowCount - 1);
  int index = min(int(position), uRowCount - 2);
  float lower = texelFetch(uRows, ivec2(index, 0), 0).r;
  float upper = texelFetch(uRows, ivec2(index + 1, 0), 0).r;
  return mix(lower, upper, position - float(index));
}

// Matches hash32 in render/lattice.ts.
uint hash32(uint value) {
  value ^= value >> 16;
  value *= 0x7feb352du;
  value ^= value >> 15;
  value *= 0x846ca68bu;
  value ^= value >> 16;
  return value;
}

float noiseFrom(uint bits) {
  return float(bits) / 32767.5 - 1.0;
}

uint siteHash(vec2 finestIndex) {
  uvec2 index = uvec2(ivec2(floor(finestIndex + 0.5)));
  return hash32(index.x ^ hash32(index.y + HASH_SALT));
}

// Matches siteNoise in render/lattice.ts. The index counts sites on the finest level.
vec2 siteNoise(vec2 slot, float slots) {
  uint hash = siteHash(slot * (FINEST_SLOTS * uBlockCells / slots));
  return vec2(noiseFrom(hash & 0xffffu), noiseFrom(hash >> 16));
}

// Matches firstSlotOfCell in render/lattice.ts.
vec2 firstSlotOfCell(vec2 slot, float slots) {
  vec2 cell = floor(slot / slots + SLOT_OFFSET_CELLS);
  return cell * slots + ceil(-SLOT_OFFSET_CELLS * slots);
}

// Matches areaNoise in render/lattice.ts.
float areaNoise(vec2 slot, float slots) {
  if (slots < 2.0) return 0.0;

  vec2 first = firstSlotOfCell(slot, slots);
  vec2 partnerSlot = first + (slots - 1.0 - (slot - first));
  bool isLower = slot.x < partnerSlot.x || (slot.x == partnerSlot.x && slot.y < partnerSlot.y);
  vec2 lowerSlot = isLower ? slot : partnerSlot;
  uint hash = siteHash(lowerSlot * (FINEST_SLOTS * uBlockCells / slots));
  float noise = noiseFrom(hash32(hash ^ HASH_SALT) & 0xffffu);
  return isLower ? noise : -noise;
}

// Matches containedRadiusPx in render/lattice.ts. The halo is in device px like the edge.
float containedRadiusPx(mat2 pixelsPerGrid, float slots, float radiusPx) {
  vec2 spacingPx = vec2(length(pixelsPerGrid[0]), length(pixelsPerGrid[1])) / slots;
  float reachPx = EDGE_PX + (uHalo ? HALO_WIDTH_PX : 0.0);
  float marginPx = min(spacingPx.x, spacingPx.y) * (0.5 - POSITION_JITTER) - reachPx;
  return min(radiusPx, max(marginPx, 0.0) / MAX_RADIUS_SCALE);
}

// Matches dotRadiusPx in render/lattice.ts.
float dotRadiusPx(float value, float maxRadiusPx, float areaNoise) {
  if (value == NO_VALUE) return 0.0;

  return maxRadiusPx * sqrt(value * (1.0 + AREA_JITTER * areaNoise));
}

bool isInGrid(vec2 owner) {
  return all(greaterThanEqual(owner, vec2(0.0))) && all(lessThan(owner, uGridSize));
}

ivec2 texelOf(vec2 owner) {
  return clamp(ivec2(owner - uWindow), ivec2(0), uIdsSize - 1);
}

float valueOf(uint stored) {
  return stored >= HATCH ? NO_VALUE : float(stored) / MAX_POSITION;
}

float valueAtLevel(vec2 site) {
  vec2 owner = floor(site);
  if (!isInGrid(owner)) return NO_VALUE;

  return valueOf(texelFetch(uIds, texelOf(owner), 0).r);
}

// Below level 1 a parent site is a block of the level above, so it is read from its own bytes.
float valueAtParentLevel(vec2 site) {
  vec2 owner = floor(site);
  if (!isInGrid(owner)) return NO_VALUE;

  if (uSlots == 1.0) return valueOf(texelFetch(uParentIds, texelOf(owner), 0).r);

  return valueOf(texelFetch(uIds, texelOf(owner), 0).r);
}

bool isHatchedAt(vec2 position) {
  vec2 owner = floor(position);
  if (!isInGrid(owner)) return false;

  return texelFetch(uIds, texelOf(owner), 0).r == HATCH;
}

float hatchCoverage() {
  vec2 screenPx = gl_FragCoord.xy / uPixelRatio;
  float phase = fract((screenPx.x + screenPx.y) / HATCH_SPACING_PX);
  float distancePx = min(phase, 1.0 - phase) * HATCH_SPACING_PX;
  return 1.0 - smoothstep(HATCH_LINE_PX / 2.0, HATCH_LINE_PX / 2.0 + EDGE_PX, distancePx);
}

float coverage(float distancePx, float radiusPx) {
  return 1.0 - smoothstep(radiusPx - EDGE_PX, radiusPx + EDGE_PX, distancePx);
}

// A dot below the minimum radius keeps that radius and fades by area instead.
Mark markAt(float distancePx, float radiusPx, float weight) {
  float minRadiusPx = MIN_DOT_RADIUS_PX * uPixelRatio;
  float opacity = weight * min(1.0, pow(radiusPx / minRadiusPx, 2.0));
  if (opacity == 0.0) return Mark(0.0, 0.0);

  float drawnRadiusPx = max(radiusPx, minRadiusPx);
  float dotAlpha = coverage(distancePx, drawnRadiusPx) * opacity;
  float haloAlpha = uHalo
    ? HALO_ALPHA * coverage(distancePx, drawnRadiusPx + HALO_WIDTH_PX) * opacity
    : 0.0;
  return Mark(dotAlpha, haloAlpha);
}

Mark overlay(Mark top, Mark under) {
  return Mark(
    top.dotAlpha + under.dotAlpha * (1.0 - top.dotAlpha),
    top.haloAlpha + under.haloAlpha * (1.0 - top.haloAlpha)
  );
}

void main() {
  vec2 position = vec2(vPosition.x + uWindow.x, gridRow());

  // The screen Jacobian is taken before any discard so every pixel of a block takes part.
  mat2 pixelsPerGrid = inverse(mat2(dFdx(position), dFdy(position)));

  // Padded blocks reach past the last cell, so a big dot must not be drawn there.
  vec2 cells = position * uBlockCells;
  if (any(lessThan(cells, vec2(0.0))) || any(greaterThanEqual(cells, uExtentCells))) discard;

  vec2 offset = vec2(SLOT_OFFSET_CELLS / uBlockCells);
  vec2 slot = floor((position - offset) * uSlots + 0.5);
  vec2 site = slot / uSlots + offset;
  bool isSibling = uFading && any(notEqual(mod(slot, 2.0), vec2(0.0)));

  Mark mark = Mark(0.0, 0.0);
  float value = uDots && (!uFading || isSibling) ? valueAtLevel(site) : NO_VALUE;
  if (value != NO_VALUE) {
    vec2 jitter = siteNoise(slot, uSlots);
    vec2 center = site + jitter * POSITION_JITTER / uSlots;
    float distancePx = length(pixelsPerGrid * (position - center));
    float maxRadiusPx = containedRadiusPx(pixelsPerGrid, uSlots, uRadiusPx);
    float radiusPx = dotRadiusPx(value, maxRadiusPx, areaNoise(slot, uSlots));
    mark = markAt(distancePx, radiusPx, uFading ? uFade : 1.0);
  }

  if (uDots && uFading) {
    // The parent dots are judged on their own lattice because they outgrow the nearest fine site.
    vec2 parentSlot = floor((position - offset) * uParentSlots + 0.5);
    vec2 parentSite = parentSlot / uParentSlots + offset;
    float wasValue = valueAtParentLevel(parentSite);
    float willValue = valueAtLevel(parentSite);
    if (wasValue != NO_VALUE || willValue != NO_VALUE) {
      vec2 jitter = siteNoise(parentSlot, uParentSlots);
      float spacing = mix(1.0 / uParentSlots, 1.0 / uSlots, uFade);
      vec2 center = parentSite + jitter * POSITION_JITTER * spacing;
      float distancePx = length(pixelsPerGrid * (position - center));
      float wasRadiusPx = containedRadiusPx(pixelsPerGrid, uParentSlots, uParentRadiusPx);
      float willRadiusPx = containedRadiusPx(pixelsPerGrid, uSlots, uRadiusPx);
      float radiusPx = mix(
        dotRadiusPx(wasValue, wasRadiusPx, areaNoise(parentSlot, uParentSlots)),
        dotRadiusPx(willValue, willRadiusPx, areaNoise(parentSlot * uSlots / uParentSlots, uSlots)),
        uFade
      );
      mark = overlay(mark, markAt(distancePx, radiusPx, 1.0));
    }
  }

  float alpha = mark.dotAlpha + mark.haloAlpha * (1.0 - mark.dotAlpha);
  vec3 color = uInk * mark.dotAlpha + uHaloInk * mark.haloAlpha * (1.0 - mark.dotAlpha);
  if (uHatch && isHatchedAt(position)) {
    float hatchAlpha = hatchCoverage();
    color = uInk * hatchAlpha + color * (1.0 - hatchAlpha);
    alpha = hatchAlpha + alpha * (1.0 - hatchAlpha);
  }
  if (alpha < MIN_ALPHA) discard;

  fragColor = vec4(color, alpha);
}
`;

function glslFloat(value: number) {
  return value.toFixed(4);
}
