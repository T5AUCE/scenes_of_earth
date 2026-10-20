/**
 * Draw class fields with GLSL ES 3.00.
 *
 * The vertex uniform `uMatrix` takes a quad corner in [0, 1]² to clip space. `uTile` holds its
 * first column and column count relative to the texture, followed by its vertical start and
 * length as fractions of the grid's Mercator height.
 *
 * The fragment uniform `uIds` holds one-based class ids (0 for none) and `uIdsSize` its size.
 * `uRows` holds `uRowCount` fractional grid rows at even Mercator heights while `uWindowRow` is
 * the grid row of the texture's first row. `uPalette` is a 256 x 1 colour table by class id.
 * `uSmooth` chooses the kernel over the nearest cell. `uRounding` blends bilinear weights towards
 * a cubic B-spline. `uSoftnessPx` is the width of the colour blend between two classes.
 * `uOutline` switches the faint ink line between them and `uOpacity` scales the result.
 */
export const CLASS_FIELD_VERTEX = `#version 300 es
in vec2 aCorner;
uniform mat4 uMatrix;
uniform vec4 uTile;
out vec2 vPosition;

void main() {
  vPosition = vec2(uTile.x + aCorner.x * uTile.y, uTile.z + aCorner.y * uTile.w);
  gl_Position = uMatrix * vec4(aCorner, 0.0, 1.0);
}
`;

export const CLASS_FIELD_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

in vec2 vPosition;
uniform usampler2D uIds;
uniform sampler2D uRows;
uniform sampler2D uPalette;
uniform ivec2 uIdsSize;
uniform int uRowCount;
uniform float uWindowRow;
uniform bool uSmooth;
uniform float uRounding;
uniform float uSoftnessPx;
uniform bool uOutline;
uniform float uOpacity;
out vec4 fragColor;

const float TIE_TOLERANCE = 1e-6;
const vec3 INK = vec3(59.0, 48.0, 38.0) / 255.0;
const float OUTLINE_STRENGTH = 0.25;
const float OUTLINE_WIDTH_PX = 0.75;

uint cellId(ivec2 cell) {
  return texelFetch(uIds, clamp(cell, ivec2(0), uIdsSize - 1), 0).r;
}

vec3 classColor(uint id) {
  return texelFetch(uPalette, ivec2(int(id), 0), 0).rgb;
}

vec4 axisWeights(float fraction) {
  float square = fraction * fraction;
  float cube = square * fraction;
  vec4 bilinear = vec4(0.0, 1.0 - fraction, fraction, 0.0);
  vec4 bSpline = vec4(
    pow(1.0 - fraction, 3.0),
    3.0 * cube - 6.0 * square + 4.0,
    -3.0 * cube + 3.0 * square + 3.0 * fraction + 1.0,
    cube
  ) / 6.0;
  return mix(bilinear, bSpline, uRounding);
}

float classWeight(uint ids[16], float weights[16], uint id) {
  float total = 0.0;
  for (int index = 0; index < 16; index++) {
    if (ids[index] == id) total += weights[index];
  }
  return total;
}

// The tolerance preserves nearest-cell ties despite floating-point round-off.
void strongestClasses(
  ivec2 base,
  vec2 fraction,
  inout uint best,
  out uint runnerUp,
  out float margin
) {
  vec4 columnWeights = axisWeights(fraction.x);
  vec4 rowWeights = axisWeights(fraction.y);
  uint ids[16];
  float weights[16];
  bool isUniform = true;
  for (int row = 0; row < 4; row++) {
    for (int column = 0; column < 4; column++) {
      int index = row * 4 + column;
      ids[index] = cellId(base + ivec2(column - 1, row - 1));
      weights[index] = columnWeights[column] * rowWeights[row];
      isUniform = isUniform && ids[index] == ids[0];
    }
  }

  runnerUp = 0u;
  margin = 1.0;
  if (isUniform) return;

  float bestWeight = classWeight(ids, weights, best);
  float runnerUpWeight = 0.0;
  for (int index = 0; index < 16; index++) {
    uint id = ids[index];
    if (id == 0u || id == best || id == runnerUp) continue;

    float weight = classWeight(ids, weights, id);
    if (weight > bestWeight + TIE_TOLERANCE) {
      runnerUp = best;
      runnerUpWeight = bestWeight;
      best = id;
      bestWeight = weight;
    } else if (weight > runnerUpWeight) {
      runnerUp = id;
      runnerUpWeight = weight;
    }
  }
  if (runnerUp != 0u) margin = bestWeight - runnerUpWeight;
}

float gridRow() {
  float position = vPosition.y * float(uRowCount - 1);
  int index = min(int(position), uRowCount - 2);
  float lower = texelFetch(uRows, ivec2(index, 0), 0).r;
  float upper = texelFetch(uRows, ivec2(index + 1, 0), 0).r;
  return mix(lower, upper, position - float(index)) - uWindowRow;
}

void main() {
  vec2 position = vec2(vPosition.x, gridRow()) - 0.5;
  ivec2 base = ivec2(floor(position));
  vec2 fraction = position - vec2(base);

  uint best = cellId(base + ivec2(step(0.5, fraction)));
  uint runnerUp = 0u;
  float margin = 1.0;
  if (best != 0u && uSmooth) strongestClasses(base, fraction, best, runnerUp, margin);

  // The derivative is taken before any discard so that every pixel of a block takes part.
  float marginPerPixel = max(fwidth(margin), 1e-5);
  if (best == 0u) discard;

  vec3 color = classColor(best);
  float distancePx = margin / marginPerPixel;
  if (runnerUp != 0u && uSoftnessPx > 0.0) {
    float coverage = clamp(0.5 + distancePx / uSoftnessPx, 0.0, 1.0);
    color = mix(classColor(runnerUp), color, coverage);
  }
  if (runnerUp != 0u && uOutline) {
    float ink = 1.0 - smoothstep(0.0, OUTLINE_WIDTH_PX, distancePx);
    color = mix(color, INK, ink * OUTLINE_STRENGTH);
  }
  fragColor = vec4(color * uOpacity, uOpacity);
}
`;
