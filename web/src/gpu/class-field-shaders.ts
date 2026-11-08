/**
 * Draw categorical fills and their optional outline with GLSL ES 3.00 and mirror their decisions
 * for tests.
 *
 * The vertex uniform `uMatrix` takes a quad corner in [0, 1]² to clip space. `uTile` holds its
 * first column and column count relative to the texture, followed by its vertical start and
 * length as fractions of the grid's Mercator height.
 *
 * The fragment uniform `uIds` holds one-based class ids (0 outside, 255 hatched no-data)
 * and `uIdsSize` its size. `uRows` holds `uRowCount` fractional grid rows at even Mercator
 * heights while `uWindowRow` is the grid row of the texture's first row. `uPalette` is a
 * 256 x 1 colour table by class id. `uSmooth` blends competing classes from the kernel instead
 * of painting the nearest cell. `uRounding` blends bilinear weights towards a cubic B-spline.
 * `uSoftnessCells` is the width of the colour blend between competing classes in grid cells.
 * `uSmoothRadiusCells` scales a cubic B-spline kernel with support twice the radius
 * in grid cells to round staircases, while 0 keeps the legacy kernel. Radii above 2 sample
 * every second cell over a 16 x 16 window so the cost stays 64 taps. `uOutline`
 * enables the border while `uOutlineStrength` controls its ink weight, `uOpacity`
 * scales the class fills while the hatch draws at full strength, and `uPixelRatio` keeps
 * the hatch at CSS spacing.
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
uniform usampler2D uHomogeneous;
uniform sampler2D uRows;
uniform sampler2D uPalette;
uniform ivec2 uIdsSize;
uniform int uRowCount;
uniform float uWindowRow;
uniform bool uSmooth;
uniform float uRounding;
uniform float uSoftnessCells;
uniform float uSmoothRadiusCells;
uniform bool uOutline;
uniform float uOutlineStrength;
uniform float uOpacity;
uniform float uPixelRatio;
out vec4 fragColor;

const float MIN_GRADIENT = 1e-6;
const float MIN_EDGE_WIDTH_PX = 1.0;
const vec3 INK = vec3(59.0, 48.0, 38.0) / 255.0;
const float OUTLINE_WIDTH_PX = 0.75;
const int KERNEL_SIZE = 4;
// 24 stays because 88 GLiM level-2 classes can put more than 16 ids in one window.
const int MAX_CLASS_COUNT = 24;
const int WIDE_FIRST_OFFSET = -3;
const int WIDE_SPAN = 8;
const int WIDE_LARGE_FIRST_OFFSET = -6;
const float WIDE_SUPPORT_RADII = 2.0;
const float FULL_SUPPORT_WEIGHT = 0.1;
const uint HATCH_ID = 255u;
const float HATCH_SPACING_PX = 8.0;
// Hatch lines stay faint so large unmapped areas don't strain the eye.
const float HATCH_STRENGTH = 0.45;
const float HATCH_LINE_PX = 0.6;
const float HATCH_EDGE_PX = 0.5;
const float MIN_HATCH_ALPHA = 0.004;

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

// Analytic slopes keep a gap's gradient stable when a pixel straddles its zero crossing.
vec4 axisSlopes(float fraction) {
  float square = fraction * fraction;
  vec4 bilinear = vec4(0.0, -1.0, 1.0, 0.0);
  vec4 bSpline = vec4(
    -0.5 * (1.0 - fraction) * (1.0 - fraction),
    1.5 * square - 2.0 * fraction,
    -1.5 * square + fraction + 0.5,
    0.5 * square
  );
  return mix(bilinear, bSpline, uRounding);
}

float classSupport(float weight) {
  return smoothstep(0.0, FULL_SUPPORT_WEIGHT, weight);
}

vec2 screenGradientOf(vec2 cellGradient, vec2 positionDx, vec2 positionDy) {
  return vec2(dot(cellGradient, positionDx), dot(cellGradient, positionDy));
}

float edgeCoverage(float gap, vec2 cellGradient, vec2 screenGradient) {
  float gradientCells = max(length(cellGradient), MIN_GRADIENT);
  float gradientPx = max(length(screenGradient), MIN_GRADIENT);
  float cellsPerPixel = gradientPx / gradientCells;
  // The one-device-pixel floor keeps edges crisp at native resolution.
  float blendCells = max(uSoftnessCells, MIN_EDGE_WIDTH_PX * cellsPerPixel);
  return clamp(0.5 + gap / gradientCells / blendCells, 0.0, 1.0);
}

// The diagonal hatch matches the continuous no-data style, measured in CSS px.
float hatchCoverage() {
  vec2 screenPx = gl_FragCoord.xy / uPixelRatio;
  float phase = fract((screenPx.x + screenPx.y) / HATCH_SPACING_PX);
  float distancePx = min(phase, 1.0 - phase) * HATCH_SPACING_PX;
  float line = 1.0 - smoothstep(HATCH_LINE_PX / 2.0, HATCH_LINE_PX / 2.0 + HATCH_EDGE_PX, distancePx);
  return HATCH_STRENGTH * line;
}

void gatherClasses(
  ivec2 base,
  vec4 columnWeights,
  vec4 rowWeights,
  vec4 columnSlopes,
  vec4 rowSlopes,
  out uint classIds[MAX_CLASS_COUNT],
  out float classWeights[MAX_CLASS_COUNT],
  out vec2 classGradients[MAX_CLASS_COUNT],
  out int classCount
) {
  classCount = 0;
  for (int row = 0; row < KERNEL_SIZE; row++) {
    for (int column = 0; column < KERNEL_SIZE; column++) {
      uint id = cellId(base + ivec2(column - 1, row - 1));
      int index = -1;
      for (int known = 0; known < classCount; known++) {
        if (classIds[known] == id) {
          index = known;
          break;
        }
      }
      if (index < 0) {
        index = classCount;
        classIds[index] = id;
        classWeights[index] = 0.0;
        classGradients[index] = vec2(0.0);
        classCount++;
      }
      classWeights[index] += columnWeights[column] * rowWeights[row];
      classGradients[index] += vec2(
        rowWeights[row] * columnSlopes[column],
        rowSlopes[row] * columnWeights[column]
      );
    }
  }
}

vec2 wideAxis(float offset, float radiusCells);

void gatherWideClasses(
  vec2 position,
  ivec2 base,
  float radiusCells,
  out uint classIds[MAX_CLASS_COUNT],
  out float classWeights[MAX_CLASS_COUNT],
  out vec2 classGradients[MAX_CLASS_COUNT],
  out int classCount,
  out bool overflowed
) {
  vec2 columnAxes[WIDE_SPAN];
  vec2 rowAxes[WIDE_SPAN];
  // Radii above 2 sample every second cell over a 16 x 16 window so the cost stays 64 taps.
  // The taps align to globally even cells so the sampled set slides without popping.
  int firstX = WIDE_FIRST_OFFSET;
  int firstY = WIDE_FIRST_OFFSET;
  int stride = 1;
  if (radiusCells > 2.0) {
    firstX = WIDE_LARGE_FIRST_OFFSET - (base.x & 1);
    firstY = WIDE_LARGE_FIRST_OFFSET - (base.y & 1);
    stride = 2;
  }
  for (int tap = 0; tap < WIDE_SPAN; tap++) {
    vec2 cell = vec2(base + ivec2(firstX + tap * stride, firstY + tap * stride));
    columnAxes[tap] = wideAxis(position.x - cell.x, radiusCells);
    rowAxes[tap] = wideAxis(position.y - cell.y, radiusCells);
  }

  classCount = 0;
  overflowed = false;
  float totalWeight = 0.0;
  vec2 totalGradient = vec2(0.0);
  for (int row = 0; row < WIDE_SPAN; row++) {
    for (int column = 0; column < WIDE_SPAN; column++) {
      float weight = columnAxes[column].x * rowAxes[row].x;
      if (weight <= 0.0) continue;

      vec2 gradient = vec2(
        columnAxes[column].y * rowAxes[row].x,
        columnAxes[column].x * rowAxes[row].y
      );
      totalWeight += weight;
      totalGradient += gradient;

      uint id = cellId(base + ivec2(firstX + column * stride, firstY + row * stride));
      int index = -1;
      for (int known = 0; known < classCount; known++) {
        if (classIds[known] == id) {
          index = known;
          break;
        }
      }
      if (index < 0) {
        if (classCount >= MAX_CLASS_COUNT) {
          overflowed = true;
          continue;
        }

        index = classCount;
        classIds[index] = id;
        classWeights[index] = 0.0;
        classGradients[index] = vec2(0.0);
        classCount++;
      }
      classWeights[index] += weight;
      classGradients[index] += gradient;
    }
  }

  // Shares keep the outside and hatch taps in the denominator so the mask edge does not move.
  float totalSquared = totalWeight * totalWeight;
  for (int index = 0; index < classCount; index++) {
    classGradients[index] = (
      classGradients[index] * totalWeight - classWeights[index] * totalGradient
    ) / totalSquared;
    classWeights[index] /= totalWeight;
  }
}

// The radius scales the kernel so the support stays twice the radius.
vec2 wideAxis(float offset, float radiusCells) {
  float x = abs(offset) / radiusCells;
  if (x >= WIDE_SUPPORT_RADII) return vec2(0.0);

  float weight = x < 1.0
    ? (4.0 - 6.0 * x * x + 3.0 * x * x * x) / 6.0
    : pow(2.0 - x, 3.0) / 6.0;
  float slope = x < 1.0
    ? (-12.0 * x + 9.0 * x * x) / 6.0
    : -0.5 * (2.0 - x) * (2.0 - x);
  return vec2(weight, slope * sign(offset) / radiusCells);
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

  // The screen Jacobian is taken before any discard so every pixel of a block takes part.
  vec2 positionDx = vec2(dFdx(position.x), dFdx(position.y));
  vec2 positionDy = vec2(dFdy(position.x), dFdy(position.y));

  uint nearest = cellId(base + ivec2(step(0.5, fraction)));
  if (nearest == 0u) discard;
  if (nearest == HATCH_ID) {
    float hatchAlpha = hatchCoverage();
    if (hatchAlpha < MIN_HATCH_ALPHA) discard;

    fragColor = vec4(INK * hatchAlpha, hatchAlpha);
    return;
  }
  if (!uSmooth) {
    fragColor = vec4(classColor(nearest) * uOpacity, uOpacity);
    return;
  }

  uint classIds[MAX_CLASS_COUNT];
  float classWeights[MAX_CLASS_COUNT];
  vec2 classGradients[MAX_CLASS_COUNT];
  int classCount = 0;
  if (uSmoothRadiusCells > 0.0) {
    // Uniform interiors skip the gather because the wide result equals the nearest colour.
    if (
      base.x >= 0
      && base.y >= 0
      && base.x < uIdsSize.x
      && base.y < uIdsSize.y
      && texelFetch(uHomogeneous, base, 0).r == 1u
    ) {
      fragColor = vec4(classColor(nearest) * uOpacity, uOpacity);
      return;
    }

    bool wideOverflowed = false;
    gatherWideClasses(
      position,
      base,
      uSmoothRadiusCells,
      classIds,
      classWeights,
      classGradients,
      classCount,
      wideOverflowed
    );
    // An empty or overflowing wide gather falls back to the legacy kernel as a safe default.
    if (wideOverflowed || classCount == 0) {
      gatherClasses(
        base,
        axisWeights(fraction.x),
        axisWeights(fraction.y),
        axisSlopes(fraction.x),
        axisSlopes(fraction.y),
        classIds,
        classWeights,
        classGradients,
        classCount
      );
    }
  } else {
    gatherClasses(
      base,
      axisWeights(fraction.x),
      axisWeights(fraction.y),
      axisSlopes(fraction.x),
      axisSlopes(fraction.y),
      classIds,
      classWeights,
      classGradients,
      classCount
    );
  }

  // A class fades out with its kernel support so classes entering the stencil change nothing.
  float influences[MAX_CLASS_COUNT];
  float totalInfluence = 0.0;
  for (int index = 0; index < classCount; index++) {
    influences[index] = 0.0;
    if (classIds[index] == 0u || classIds[index] == HATCH_ID) continue;

    float influence = classSupport(classWeights[index]);
    for (int other = 0; other < classCount; other++) {
      if (other == index) continue;
      if (classIds[other] == 0u || classIds[other] == HATCH_ID) continue;

      vec2 cellGradient = classGradients[index] - classGradients[other];
      float coverage = edgeCoverage(
        classWeights[index] - classWeights[other],
        cellGradient,
        screenGradientOf(cellGradient, positionDx, positionDy)
      );
      influence *= 1.0 - classSupport(classWeights[other]) * (1.0 - coverage);
    }
    influences[index] = influence;
    totalInfluence += influence;
  }

  vec3 color = vec3(0.0);
  for (int index = 0; index < classCount; index++) {
    if (influences[index] > 0.0) color += influences[index] * classColor(classIds[index]);
  }
  totalInfluence = max(totalInfluence, MIN_GRADIENT);
  color /= totalInfluence;

  float ink = 0.0;
  if (uOutline) {
    // A pair is weighted by how far both classes lead the rest so the ink is continuous.
    for (int index = 0; index < classCount; index++) {
      if (classIds[index] == 0u || classIds[index] == HATCH_ID) continue;

      for (int other = index + 1; other < classCount; other++) {
        if (classIds[other] == 0u || classIds[other] == HATCH_ID) continue;

        vec2 cellGradient = classGradients[index] - classGradients[other];
        float gapPx = abs(classWeights[index] - classWeights[other])
          / max(length(screenGradientOf(cellGradient, positionDx, positionDy)), MIN_GRADIENT);
        float presence = clamp(
          2.0 * min(influences[index], influences[other]) / totalInfluence,
          0.0,
          1.0
        );
        float leading = 1.0;
        for (int rival = 0; rival < classCount; rival++) {
          if (rival == index || rival == other) continue;
          if (classIds[rival] == 0u || classIds[rival] == HATCH_ID) continue;

          vec2 indexGradient = classGradients[index] - classGradients[rival];
          vec2 otherGradient = classGradients[other] - classGradients[rival];
          float leadPx = min(
            (classWeights[index] - classWeights[rival])
              / max(length(screenGradientOf(indexGradient, positionDx, positionDy)), MIN_GRADIENT),
            (classWeights[other] - classWeights[rival])
              / max(length(screenGradientOf(otherGradient, positionDx, positionDy)), MIN_GRADIENT)
          );
          float dominance = smoothstep(0.0, 1.0, 0.5 + leadPx / (2.0 * OUTLINE_WIDTH_PX));
          leading *= 1.0 - classSupport(classWeights[rival]) * (1.0 - dominance);
        }
        ink += (1.0 - smoothstep(0.0, OUTLINE_WIDTH_PX, gapPx)) * presence * leading;
      }
    }
    ink = min(ink, 1.0);
  }
  float inkAlpha = ink * uOutlineStrength;
  color = mix(color, INK, inkAlpha);
  fragColor = vec4(color * uOpacity, uOpacity);
}
`;

const KERNEL_SIZE = 4;
const MIN_MIRROR_GRADIENT = 1e-6;
const MIN_EDGE_WIDTH_PX = 1;
const FULL_SUPPORT_WEIGHT = 0.1;
const OUTLINE_WIDTH_PX = 0.75;
const WIDE_FIRST_OFFSET = -3;
const WIDE_SPAN = 8;
const WIDE_LARGE_FIRST_OFFSET = -6;
const WIDE_LARGE_FIRST = -7;
const WIDE_LARGE_SPAN = 16;
const WIDE_SUPPORT_RADII = 2;
// 24 stays because 88 GLiM level-2 classes can put more than 16 ids in one window.
const MAX_CLASS_COUNT = 24;
/** The class id that hatches an in-area cell with no class, leaving 0 for outside. */
export const CLASS_HATCH_ID = 255;
/** The faint outline drawn while a categorical layer holds colour. */
export const FILL_OUTLINE_STRENGTH = 0.25;

/** The distances and coverage that the fragment shader derives from one class gap. */
export interface EdgeCoverage {
  distanceCells: number;
  distancePx: number;
  coverage: number;
}

/**
 * The scalar edge formula that the shader applies to one class pair. A diagonal boundary uses
 * its true two-dimensional length rather than the sum of screen axes that `fwidth` reports.
 */
export function edgeCoverage(
  gap: number,
  cellGradient: readonly [number, number],
  screenGradient: readonly [number, number],
  softnessCells: number,
): EdgeCoverage {
  const gradientCells = Math.max(Math.hypot(cellGradient[0], cellGradient[1]), MIN_MIRROR_GRADIENT);
  const gradientPx = Math.max(
    Math.hypot(screenGradient[0], screenGradient[1]),
    MIN_MIRROR_GRADIENT,
  );
  const distanceCells = gap / gradientCells;
  const cellsPerPixel = gradientPx / gradientCells;
  const blendCells = Math.max(softnessCells, MIN_EDGE_WIDTH_PX * cellsPerPixel);
  return {
    distanceCells,
    distancePx: gap / gradientPx,
    coverage: Math.min(1, Math.max(0, 0.5 + distanceCells / blendCells)),
  };
}

/** One fragment's 4 x 4 class kernel and the screen mapping that its gradients use. */
export interface ClassFieldFragment {
  /** Class ids in kernel order, rows first, with the fragment's cells at [1][1] to [2][2]. */
  ids: readonly (readonly number[])[];
  /** Position inside the lower cell of the fragment, each in [0, 1). */
  fraction: readonly [number, number];
  /** Change in grid cells per screen pixel along screen x. */
  positionDx: readonly [number, number];
  /** Change in grid cells per screen pixel along screen y. */
  positionDy: readonly [number, number];
  /** Absolute cell coordinates of the fragment for wide taps, ignored when radius is 0. */
  position?: readonly [number, number];
  /** Grid lookup mirroring the shader cell fetch; required when the radius is positive. */
  sampleId?: (cellX: number, cellY: number) => number;
  /** Homogeneous-neighbourhood flag for the fragment base; only used when radius is positive. */
  homogeneous?: boolean;
}

/** The edge choices that change the fragment shader's result. */
export interface EdgeOptions {
  smooth: boolean;
  rounding: number;
  softnessCells: number;
  /** Wider class-presence scale in grid cells with support twice the radius. */
  smoothRadiusCells?: number;
}

/** The class mix and outline ink that the fragment shader makes for one fragment. */
export interface ClassFieldResult {
  discarded: boolean;
  nearest: number;
  /** Normalised influence by class id; classes with no influence are omitted. */
  weights: { id: number; weight: number }[];
  /** Outline ink in [0, 1] before the outline strength scales it. */
  outline: number;
}

/** How the outline ink is weighted in the shader's final write. */
export interface ClassFieldAppearance {
  /** Ink weight of the faint outline. */
  outlineStrength: number;
  /** Whether the outline is drawn at all. */
  outline: boolean;
}

/** The premultiplied ink and alpha the shader writes before the layer's `uOpacity` scales them. */
export interface ClassFieldAlpha {
  ink: number;
  alpha: number;
}

/**
 * Apply the fragment shader's outline weight to a sampled fragment so behaviour can be checked
 * in Node. A drawn class fill is always opaque, and hatched no-data counts as drawn.
 */
export function classFieldAlpha(
  result: ClassFieldResult,
  appearance: ClassFieldAppearance,
): ClassFieldAlpha {
  if (result.discarded) return { ink: 0, alpha: 0 };

  const ink = appearance.outline ? result.outline * appearance.outlineStrength : 0;
  return { ink, alpha: 1 };
}

/**
 * Apply the fragment shader's class decision to a neighbourhood so behaviour can be checked in
 * Node. The nearest cell gates outside, hatch and Smooth off before any kernel work, as in
 * the shader.
 */
export function sampleClassField(
  fragment: ClassFieldFragment,
  options: EdgeOptions,
): ClassFieldResult {
  const [fractionX, fractionY] = fragment.fraction;
  const nearestRow = 1 + (fractionY >= 0.5 ? 1 : 0);
  const nearestColumn = 1 + (fractionX >= 0.5 ? 1 : 0);
  const nearest = fragment.ids[nearestRow][nearestColumn];
  if (nearest === 0) return { discarded: true, nearest, weights: [], outline: 0 };
  if (nearest === CLASS_HATCH_ID) {
    return { discarded: false, nearest, weights: [], outline: 0 };
  }
  if (!options.smooth) {
    return { discarded: false, nearest, weights: [{ id: nearest, weight: 1 }], outline: 0 };
  }
  const radiusCells = options.smoothRadiusCells ?? 0;
  // Uniform interiors skip the gather because the wide result equals the nearest colour.
  if (radiusCells > 0 && fragment.homogeneous) {
    return { discarded: false, nearest, weights: [{ id: nearest, weight: 1 }], outline: 0 };
  }

  const columnWeights = axisWeights(fractionX, options.rounding);
  const rowWeights = axisWeights(fractionY, options.rounding);
  const columnSlopes = axisSlopes(fractionX, options.rounding);
  const rowSlopes = axisSlopes(fractionY, options.rounding);
  const classes = (
    (radiusCells > 0 ? wideClasses(fragment, radiusCells) : null)
    ?? gatherClasses(fragment.ids, columnWeights, rowWeights, columnSlopes, rowSlopes)
  // Remaining hatch stays out of the mix so its edge stays crisp while classes smooth around it.
  ).filter(({ id }) => id !== 0 && id !== CLASS_HATCH_ID);
  const influences = classInfluences(classes, fragment, options.softnessCells);
  const total = Math.max(
    influences.reduce((sum, influence) => sum + influence, 0),
    MIN_MIRROR_GRADIENT,
  );

  return {
    discarded: false,
    nearest,
    weights: classes
      .map(({ id }, index) => ({ id, weight: influences[index] / total }))
      .filter(({ weight }) => weight > 0),
    outline: outlineInk(classes, influences.map((influence) => influence / total), fragment),
  };
}

function axisWeights(fraction: number, rounding: number): number[] {
  const square = fraction * fraction;
  const cube = square * fraction;
  const bilinear = [0, 1 - fraction, fraction, 0];
  const bSpline = [
    (1 - fraction) ** 3,
    3 * cube - 6 * square + 4,
    -3 * cube + 3 * square + 3 * fraction + 1,
    cube,
  ].map((value) => value / 6);
  return bilinear.map((value, index) => value + (bSpline[index] - value) * rounding);
}

function axisSlopes(fraction: number, rounding: number): number[] {
  const square = fraction * fraction;
  const bilinear = [0, -1, 1, 0];
  const bSpline = [
    -0.5 * (1 - fraction) * (1 - fraction),
    1.5 * square - 2 * fraction,
    -1.5 * square + fraction + 0.5,
    0.5 * square,
  ];
  return bilinear.map((value, index) => value + (bSpline[index] - value) * rounding);
}

interface ClassSum {
  id: number;
  weight: number;
  gradient: [number, number];
}

function gatherClasses(
  ids: readonly (readonly number[])[],
  columnWeights: number[],
  rowWeights: number[],
  columnSlopes: number[],
  rowSlopes: number[],
): ClassSum[] {
  const classes: ClassSum[] = [];
  for (let row = 0; row < KERNEL_SIZE; row++) {
    for (let column = 0; column < KERNEL_SIZE; column++) {
      const id = ids[row][column];
      let current = classes.find((entry) => entry.id === id);
      if (!current) {
        current = { id, weight: 0, gradient: [0, 0] };
        classes.push(current);
      }
      current.weight += columnWeights[column] * rowWeights[row];
      current.gradient[0] += rowWeights[row] * columnSlopes[column];
      current.gradient[1] += rowSlopes[row] * columnWeights[column];
    }
  }
  return classes;
}

/**
 * Replace the kernel sums with a wide B-spline so staircases become smooth curves. Outside and
 * hatch taps stay in the denominator so the mask edge does not move.
 */
function wideClasses(
  fragment: ClassFieldFragment,
  radiusCells: number,
): ClassSum[] | null {
  const position = fragment.position;
  const sample = fragment.sampleId;
  if (!position || !sample) return null;

  const base = [Math.floor(position[0]), Math.floor(position[1])];
  // Radii above 2 sample every second cell over a 16 x 16 window so the cost stays 64 taps.
  // The taps align to globally even cells so the sampled set slides without popping.
  const large = radiusCells > 2;
  const stride = large ? 2 : 1;
  const firstX = large ? WIDE_LARGE_FIRST_OFFSET - parity(base[0]) : WIDE_FIRST_OFFSET;
  const firstY = large ? WIDE_LARGE_FIRST_OFFSET - parity(base[1]) : WIDE_FIRST_OFFSET;
  const columns = Array.from(
    { length: WIDE_SPAN },
    (_, tap) => wideAxis(position[0] - (base[0] + firstX + tap * stride), radiusCells),
  );
  const rows = Array.from(
    { length: WIDE_SPAN },
    (_, tap) => wideAxis(position[1] - (base[1] + firstY + tap * stride), radiusCells),
  );
  const classes: ClassSum[] = [];
  let totalWeight = 0;
  const totalGradient: [number, number] = [0, 0];
  let overflowed = false;
  rows.forEach(([rowWeight, rowSlope], row) => {
    columns.forEach(([columnWeight, columnSlope], column) => {
      const weight = columnWeight * rowWeight;
      if (weight <= 0) return;

      const gradient: [number, number] = [columnSlope * rowWeight, columnWeight * rowSlope];
      totalWeight += weight;
      totalGradient[0] += gradient[0];
      totalGradient[1] += gradient[1];
      const id = sample(base[0] + firstX + column * stride, base[1] + firstY + row * stride);
      let current = classes.find((entry) => entry.id === id);
      if (!current) {
        if (classes.length >= MAX_CLASS_COUNT) {
          overflowed = true;
          return;
        }
        current = { id, weight: 0, gradient: [0, 0] };
        classes.push(current);
      }
      current.weight += weight;
      current.gradient[0] += gradient[0];
      current.gradient[1] += gradient[1];
    });
  });
  if (overflowed || classes.length === 0) return null;

  const totalSquared = totalWeight * totalWeight;
  for (const current of classes) {
    current.gradient = [
      (current.gradient[0] * totalWeight - current.weight * totalGradient[0]) / totalSquared,
      (current.gradient[1] * totalWeight - current.weight * totalGradient[1]) / totalSquared,
    ];
    current.weight /= totalWeight;
  }
  return classes;
}

/** The mathematical parity of a possibly negative cell index, matching the shader's bit test. */
function parity(index: number): number {
  return ((index % 2) + 2) % 2;
}

/** The radius scales the kernel so the support stays twice the radius. */
function wideAxis(offset: number, radiusCells: number): [number, number] {
  const x = Math.abs(offset) / radiusCells;
  if (x >= WIDE_SUPPORT_RADII) return [0, 0];

  const weight = x < 1 ? (4 - 6 * x * x + 3 * x ** 3) / 6 : (2 - x) ** 3 / 6;
  const slope = x < 1 ? (-12 * x + 9 * x * x) / 6 : -0.5 * (2 - x) * (2 - x);
  return [weight, (slope * Math.sign(offset)) / radiusCells];
}

// A class fades out with its kernel support so classes entering the stencil change nothing.
function classInfluences(
  classes: ClassSum[],
  fragment: ClassFieldFragment,
  softnessCells: number,
): number[] {
  return classes.map((current) => {
    let influence = classSupport(current.weight);
    for (const other of classes) {
      if (other === current) continue;

      const { gap, cellGradient, screenGradient } = pairGradients(current, other, fragment);
      const coverage = edgeCoverage(gap, cellGradient, screenGradient, softnessCells).coverage;
      influence *= 1 - classSupport(other.weight) * (1 - coverage);
    }
    return influence;
  });
}

function classSupport(weight: number): number {
  return smoothstep(weight / FULL_SUPPORT_WEIGHT);
}

function pairGradients(current: ClassSum, other: ClassSum, fragment: ClassFieldFragment) {
  const cellGradient: [number, number] = [
    current.gradient[0] - other.gradient[0],
    current.gradient[1] - other.gradient[1],
  ];
  const screenGradient: [number, number] = [
    cellGradient[0] * fragment.positionDx[0] + cellGradient[1] * fragment.positionDx[1],
    cellGradient[0] * fragment.positionDy[0] + cellGradient[1] * fragment.positionDy[1],
  ];
  return { gap: current.weight - other.weight, cellGradient, screenGradient };
}

// Each pair is weighted by how far both its classes lead the rest so the ink is continuous.
function outlineInk(
  classes: ClassSum[],
  shares: number[],
  fragment: ClassFieldFragment,
): number {
  let ink = 0;
  for (let index = 0; index < classes.length; index++) {
    for (let other = index + 1; other < classes.length; other++) {
      const gapPx = Math.abs(distancePx(classes[index], classes[other], fragment));
      const presence = Math.min(1, 2 * Math.min(shares[index], shares[other]));
      let leading = 1;
      classes.forEach((rival, rivalIndex) => {
        if (rivalIndex === index || rivalIndex === other) return;

        const leadPx = Math.min(
          distancePx(classes[index], rival, fragment),
          distancePx(classes[other], rival, fragment),
        );
        const dominance = smoothstep(0.5 + leadPx / (2 * OUTLINE_WIDTH_PX));
        leading *= 1 - classSupport(rival.weight) * (1 - dominance);
      });
      ink += (1 - smoothstep(gapPx / OUTLINE_WIDTH_PX)) * presence * leading;
    }
  }
  return Math.min(ink, 1);
}

function distancePx(current: ClassSum, other: ClassSum, fragment: ClassFieldFragment): number {
  const { gap, screenGradient } = pairGradients(current, other, fragment);
  return gap / Math.max(Math.hypot(screenGradient[0], screenGradient[1]), MIN_MIRROR_GRADIENT);
}

function smoothstep(fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Mark base cells whose kernel support holds one id so uniform interiors skip
 * the gather. A summed-area table of neighbour differences answers each window
 * in O(1) so the whole grid costs one pass, and clipped edges match the shader
 * exactly. Small radii use the 8 x 8 window the kernel reaches, so more interiors
 * skip with pixel-identical output.
 */
export function homogeneousFlags(
  cells: Uint8Array | readonly number[],
  nx: number,
  ny: number,
  smoothRadiusCells?: number,
): Uint8Array {
  const flags = new Uint8Array(nx * ny);
  if (nx <= 0 || ny <= 0) {
    return flags;
  }
  const horizontal = summedHorizontal(cells, nx, ny);
  const vertical = summedVertical(cells, nx, ny);
  const { first, span } = homogeneousWindow(smoothRadiusCells);
  const lastOffset = first + span - 1;
  for (let row = 0; row < ny; row++) {
    const top = Math.max(0, row + first);
    const bottom = Math.min(ny - 1, row + lastOffset);
    for (let column = 0; column < nx; column++) {
      const left = Math.max(0, column + first);
      const right = Math.min(nx - 1, column + lastOffset);
      flags[row * nx + column] = isUniformWindow(
        horizontal,
        vertical,
        nx,
        top,
        bottom,
        left,
        right,
      ) ? 1 : 0;
    }
  }
  return flags;
}

/**
 * Match the flag window to the kernel the shader samples. Radii above 2 sample
 * every second cell over the large window, following the shader's stride branch.
 */
export function homogeneousWindow(smoothRadiusCells?: number): { first: number; span: number } {
  if (smoothRadiusCells !== undefined && smoothRadiusCells > 0 && smoothRadiusCells <= 2) {
    return { first: WIDE_FIRST_OFFSET, span: WIDE_SPAN };
  }
  return { first: WIDE_LARGE_FIRST, span: WIDE_LARGE_SPAN };
}

function isUniformWindow(
  horizontal: Int32Array,
  vertical: Int32Array,
  nx: number,
  top: number,
  bottom: number,
  left: number,
  right: number,
): boolean {
  if (left < right && rectangleSum(horizontal, nx, top, bottom, left, right - 1) > 0) {
    return false;
  }
  return !(top < bottom && rectangleSum(vertical, nx, top, bottom - 1, left, right) > 0);
}

function summedHorizontal(
  cells: Uint8Array | readonly number[],
  nx: number,
  ny: number,
): Int32Array {
  const table = new Int32Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      const differs = column + 1 < nx && cells[row * nx + column] !== cells[row * nx + column + 1]
        ? 1
        : 0;
      table[row * nx + column] = differs
        + (row > 0 ? table[(row - 1) * nx + column] : 0)
        + (column > 0 ? table[row * nx + column - 1] : 0)
        - (row > 0 && column > 0 ? table[(row - 1) * nx + column - 1] : 0);
    }
  }
  return table;
}

function summedVertical(
  cells: Uint8Array | readonly number[],
  nx: number,
  ny: number,
): Int32Array {
  const table = new Int32Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      const differs = row + 1 < ny && cells[row * nx + column] !== cells[(row + 1) * nx + column]
        ? 1
        : 0;
      table[row * nx + column] = differs
        + (row > 0 ? table[(row - 1) * nx + column] : 0)
        + (column > 0 ? table[row * nx + column - 1] : 0)
        - (row > 0 && column > 0 ? table[(row - 1) * nx + column - 1] : 0);
    }
  }
  return table;
}

function rectangleSum(
  table: Int32Array,
  nx: number,
  top: number,
  bottom: number,
  left: number,
  right: number,
): number {
  return table[bottom * nx + right]
    - (top > 0 ? table[(top - 1) * nx + right] : 0)
    - (left > 0 ? table[bottom * nx + left - 1] : 0)
    + (top > 0 && left > 0 ? table[(top - 1) * nx + left - 1] : 0);
}
