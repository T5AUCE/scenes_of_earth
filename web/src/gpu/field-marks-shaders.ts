/** Supply GLSL ES 3.00 shaders for nested field dots and mask-aware no-data hatching. */
import { CLASS_FIELD_VERTEX } from "./class-field-shaders";

/**
 * Reuse the class-field vertex shader to place field dots and hatching.
 *
 * `uIds` holds a position byte per cell or per block of cells below level 0.
 * Bytes from 0 to 253 locate a value on the colour stops. Byte 254 hatches an in-area cell
 * with no value while 255 draws nothing. `uIdsSize` is its size and `uWindow` the grid column
 * and row of its first texel,
 * while `uGridSize` is the whole grid's size in texels and `uExtentCells` the size in cells of
 * the grid before it was padded to whole blocks. `uRows` holds `uRowCount` fractional grid rows
 * at even Mercator heights.
 *
 * Each texel is one cell of the dot level, or a block of `uBlockCells` cells below level 0.
 * `uSlots` is the number of dot sites along a cell side and `uLevelBits` its base-2 logarithm.
 * `uRadiusPx` is the dot radius. While `uFading`, the level above fades into this one by
 * `uFade`. Its sites are `uParentSlots` along a texel while a dot lit there grows from
 * `uParentRadiusPx`. Below level 1 the parent's own bytes come from `uParentIds`, which has the
 * size of `uIds`. `uDots` draws the dots and `uHatch` the no-data hatch, whose screen-space
 * lines are measured through `uPixelRatio`.
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
uniform int uLevelBits;
uniform float uBlockCells;
uniform float uRadiusPx;
uniform float uParentRadiusPx;
uniform bool uFading;
uniform float uFade;
uniform vec3 uInk;
uniform bool uHalo;
uniform bool uDots;
uniform bool uHatch;
uniform float uPixelRatio;
out vec4 fragColor;

const uint HATCH = 254u;
const float MAX_POSITION = 253.0;
const float SLOT_OFFSET_CELLS = 15.0 / 32.0;
const int MAX_LEVEL_BITS = 4;
const int THRESHOLD_BITS = 3;
const vec3 HALO = vec3(246.0, 239.0, 227.0) / 255.0;
const float HALO_ALPHA = 0.7;
const float HALO_WIDTH_PX = 0.6;
const float EDGE_PX = 0.5;
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

// Matches bayerRank in render/lattice.ts.
int bayerRank(ivec2 slot, int bits) {
  int rank = 0;
  for (int bit = 0; bit < MAX_LEVEL_BITS; bit++) {
    if (bit >= bits) break;

    int across = (slot.x >> bit) & 1;
    int down = (slot.y >> bit) & 1;
    rank += (2 * (across ^ down) + down) << (2 * (bits - 1 - bit));
  }
  return rank;
}

float cellThreshold(ivec2 cell) {
  int rank = bayerRank(cell & 7, THRESHOLD_BITS);
  return (float(rank) + 0.5) / 64.0;
}

// Matches isDotLit in render/lattice.ts.
bool isDotLit(uint stored, ivec2 cell, ivec2 slot, int bits) {
  if (stored >= HATCH) return false;

  float slotCount = float(1 << (2 * bits));
  float count = clamp(
    floor(float(stored) / MAX_POSITION * slotCount + 1.0 - cellThreshold(cell)),
    0.0,
    slotCount
  );
  return float(bayerRank(slot & ((1 << bits) - 1), bits)) < count;
}

bool isInGrid(vec2 owner) {
  return all(greaterThanEqual(owner, vec2(0.0))) && all(lessThan(owner, uGridSize));
}

ivec2 texelOf(vec2 owner) {
  return clamp(ivec2(owner - uWindow), ivec2(0), uIdsSize - 1);
}

bool isLitAtLevel(vec2 site, vec2 slot) {
  vec2 owner = floor(site);
  if (!isInGrid(owner)) return false;

  uint stored = texelFetch(uIds, texelOf(owner), 0).r;
  return isDotLit(stored, ivec2(owner), ivec2(slot), uLevelBits);
}

// Below level 1 a parent site is a block of the level above, so it is read from its own bytes.
bool isLitAtParentLevel(vec2 site, vec2 parentSlot) {
  vec2 owner = floor(site);
  if (!isInGrid(owner)) return false;

  if (uLevelBits == 0) {
    uint stored = texelFetch(uParentIds, texelOf(owner), 0).r;
    return isDotLit(stored, ivec2(parentSlot), ivec2(0), 0);
  }
  uint stored = texelFetch(uIds, texelOf(owner), 0).r;
  return isDotLit(stored, ivec2(owner), ivec2(parentSlot), uLevelBits - 1);
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

Mark markAt(float distancePx, float radiusPx, float weight) {
  if (weight == 0.0) return Mark(0.0, 0.0);

  float dotAlpha = coverage(distancePx, radiusPx) * weight;
  float haloAlpha = uHalo
    ? HALO_ALPHA * coverage(distancePx, radiusPx + HALO_WIDTH_PX) * weight
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
  if (uDots && (!uFading || isSibling)) {
    float weight = isLitAtLevel(site, slot) ? (uFading ? uFade : 1.0) : 0.0;
    mark = markAt(length(pixelsPerGrid * (position - site)), uRadiusPx, weight);
  }

  if (uDots && uFading) {
    // The parent dots are judged on their own lattice because they outgrow the nearest fine site.
    vec2 parentSlot = floor((position - offset) * uParentSlots + 0.5);
    vec2 parentSite = parentSlot / uParentSlots + offset;
    float wasLit = isLitAtParentLevel(parentSite, parentSlot) ? 1.0 : 0.0;
    float willBeLit = isLitAtLevel(parentSite, parentSlot * 2.0) ? 1.0 : 0.0;
    float radiusPx = wasLit > 0.0 ? mix(uParentRadiusPx, uRadiusPx, uFade) : uRadiusPx;
    float distancePx = length(pixelsPerGrid * (position - parentSite));
    mark = overlay(mark, markAt(distancePx, radiusPx, mix(wasLit, willBeLit, uFade)));
  }

  float alpha = mark.dotAlpha + mark.haloAlpha * (1.0 - mark.dotAlpha);
  vec3 color = uInk * mark.dotAlpha + HALO * mark.haloAlpha * (1.0 - mark.dotAlpha);
  if (uHatch && isHatchedAt(position)) {
    float hatchAlpha = hatchCoverage();
    color = uInk * hatchAlpha + color * (1.0 - hatchAlpha);
    alpha = hatchAlpha + alpha * (1.0 - hatchAlpha);
  }
  if (alpha < MIN_ALPHA) discard;

  fragColor = vec4(color, alpha);
}
`;
