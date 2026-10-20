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
 * `uSmooth` blends competing classes from the kernel instead of painting the nearest cell.
 * `uRounding` blends bilinear weights towards a cubic B-spline. `uSoftnessCells` is the width of
 * the colour blend between competing classes in grid cells. `uOutline` switches the faint ink
 * line between them and `uOpacity` scales the result.
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
uniform float uSoftnessCells;
uniform bool uOutline;
uniform float uOpacity;
out vec4 fragColor;

const float MIN_GRADIENT = 1e-6;
const float MIN_EDGE_WIDTH_PX = 1.0;
const vec3 INK = vec3(59.0, 48.0, 38.0) / 255.0;
const float OUTLINE_STRENGTH = 0.25;
const float OUTLINE_WIDTH_PX = 0.75;
const int KERNEL_SIZE = 4;
const float FULL_SUPPORT_WEIGHT = 0.1;

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

void gatherClasses(
  ivec2 base,
  vec4 columnWeights,
  vec4 rowWeights,
  vec4 columnSlopes,
  vec4 rowSlopes,
  out uint classIds[16],
  out float classWeights[16],
  out vec2 classGradients[16],
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
  if (!uSmooth) {
    fragColor = vec4(classColor(nearest) * uOpacity, uOpacity);
    return;
  }

  vec4 columnWeights = axisWeights(fraction.x);
  vec4 rowWeights = axisWeights(fraction.y);
  vec4 columnSlopes = axisSlopes(fraction.x);
  vec4 rowSlopes = axisSlopes(fraction.y);

  uint classIds[16];
  float classWeights[16];
  vec2 classGradients[16];
  int classCount = 0;
  gatherClasses(
    base,
    columnWeights,
    rowWeights,
    columnSlopes,
    rowSlopes,
    classIds,
    classWeights,
    classGradients,
    classCount
  );

  // A class fades out with its kernel support so classes entering the stencil change nothing.
  float influences[16];
  float totalInfluence = 0.0;
  for (int index = 0; index < classCount; index++) {
    influences[index] = 0.0;
    if (classIds[index] == 0u) continue;

    float influence = classSupport(classWeights[index]);
    for (int other = 0; other < classCount; other++) {
      if (other == index || classIds[other] == 0u) continue;

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

  if (uOutline) {
    float ink = 0.0;
    for (int index = 0; index < classCount; index++) {
      if (classIds[index] == 0u) continue;

      for (int other = index + 1; other < classCount; other++) {
        if (classIds[other] == 0u) continue;

        vec2 cellGradient = classGradients[index] - classGradients[other];
        vec2 screenGradient = screenGradientOf(cellGradient, positionDx, positionDy);
        float gapPx = abs(classWeights[index] - classWeights[other])
          / max(length(screenGradient), MIN_GRADIENT);
        float presence = clamp(
          2.0 * min(influences[index], influences[other]) / totalInfluence,
          0.0,
          1.0
        );
        ink = max(ink, (1.0 - smoothstep(0.0, OUTLINE_WIDTH_PX, gapPx)) * presence);
      }
    }
    color = mix(color, INK, ink * OUTLINE_STRENGTH);
  }
  fragColor = vec4(color * uOpacity, uOpacity);
}
`;

const KERNEL_SIZE = 4;
const MIN_MIRROR_GRADIENT = 1e-6;
const MIN_EDGE_WIDTH_PX = 1;
const FULL_SUPPORT_WEIGHT = 0.1;
const OUTLINE_WIDTH_PX = 0.75;

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
}

/** The edge choices that change the fragment shader's result. */
export interface EdgeOptions {
  smooth: boolean;
  rounding: number;
  softnessCells: number;
}

/** The class mix and outline ink that the fragment shader makes for one fragment. */
export interface ClassFieldResult {
  discarded: boolean;
  nearest: number;
  /** Normalized influence by class id; classes with no influence are omitted. */
  weights: { id: number; weight: number }[];
  /** Outline ink in [0, 1] before the outline strength scales it. */
  outline: number;
}

/**
 * Apply the fragment shader's class decision to a neighbourhood so behaviour can be checked in
 * Node. The nearest cell gates no-data and Smooth off before any kernel work, as in the shader.
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
  if (!options.smooth) {
    return { discarded: false, nearest, weights: [{ id: nearest, weight: 1 }], outline: 0 };
  }

  const columnWeights = axisWeights(fractionX, options.rounding);
  const rowWeights = axisWeights(fractionY, options.rounding);
  const columnSlopes = axisSlopes(fractionX, options.rounding);
  const rowSlopes = axisSlopes(fractionY, options.rounding);
  const classes = gatherClasses(
    fragment.ids,
    columnWeights,
    rowWeights,
    columnSlopes,
    rowSlopes,
  ).filter(({ id }) => id !== 0);
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

// Only pairs that both show in the final mix can ink, so losing classes never outline an interior.
function outlineInk(
  classes: ClassSum[],
  shares: number[],
  fragment: ClassFieldFragment,
): number {
  let ink = 0;
  for (let index = 0; index < classes.length; index++) {
    for (let other = index + 1; other < classes.length; other++) {
      const { gap, screenGradient } = pairGradients(classes[index], classes[other], fragment);
      const gapPx = Math.abs(gap)
        / Math.max(Math.hypot(screenGradient[0], screenGradient[1]), MIN_MIRROR_GRADIENT);
      const presence = Math.min(1, 2 * Math.min(shares[index], shares[other]));
      const nearness = 1 - smoothstep(gapPx / OUTLINE_WIDTH_PX);
      ink = Math.max(ink, nearness * presence);
    }
  }
  return ink;
}

function smoothstep(fraction: number): number {
  const t = Math.min(1, Math.max(0, fraction));
  return t * t * (3 - 2 * t);
}
