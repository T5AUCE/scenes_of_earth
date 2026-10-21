import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classFieldAlpha,
  EDGES_OUTLINE_STRENGTH,
  edgeCoverage,
  FILL_OUTLINE_STRENGTH,
  sampleClassField,
  type ClassFieldAppearance,
  type ClassFieldResult,
} from "./class-field-shaders.ts";

const TREE = 10;
const GRASS = 20;
const COVER = 30;

test("the scalar edge formula centres a one-pixel anti-alias", () => {
  const cellGradient: [number, number] = [2, 0];
  const screenGradient: [number, number] = [0.02, 0]; // One cell is 100 px wide.
  const at = (gap: number) => edgeCoverage(gap, cellGradient, screenGradient, 0);

  assert.equal(at(0).coverage, 0.5);
  assert.ok(Math.abs(at(0.005).coverage - 0.75) < 1e-12);
  assert.ok(Math.abs(at(-0.005).coverage - 0.25) < 1e-12);
  assert.equal(at(0.01).coverage, 1);
  assert.equal(at(-0.01).coverage, 0);
  assert.ok(Math.abs(edgeCoverage(0.2, [0, 2], [0, 1], 1).distanceCells - 0.1) < 1e-12);
});

test("class neighbourhoods centre a two-class edge and reach pure interiors", () => {
  const ids = edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]);
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const at = (fractionX: number) => sampleClassField(
    {
      ids,
      fraction: [fractionX, 0.5],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );

  assert.equal(weightOf(at(0), TREE), 1);
  assert.ok(Math.abs(weightOf(at(0.25), TREE) - 0.75) < 1e-12);
  assert.ok(Math.abs(weightOf(at(0.25), GRASS) - 0.25) < 1e-12);
  assert.ok(Math.abs(weightOf(at(0.5), TREE) - 0.5) < 1e-12);
  assert.ok(Math.abs(weightOf(at(0.5), GRASS) - 0.5) < 1e-12);
  assert.ok(weightOf(at(0.999), GRASS) > 0.998);
});

test("a subpixel edge widens to one device pixel on both sides", () => {
  const ids = edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]);
  const edges = { smooth: true, rounding: 0, softnessCells: 0 };
  const at = (fractionX: number) => sampleClassField(
    {
      ids,
      fraction: [fractionX, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    edges,
  );

  assert.ok(Math.abs(weightOf(at(0.4975), TREE) - 0.75) < 1e-12);
  assert.ok(Math.abs(weightOf(at(0.5025), GRASS) - 0.75) < 1e-12);
  assert.equal(weightOf(at(0.49), TREE), 1);
  assert.equal(weightOf(at(0.51), GRASS), 1);
});

test("the screen Jacobian sets the blend width without moving the edge", () => {
  const ids = edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]);
  const edges = { smooth: true, rounding: 0, softnessCells: 0 };
  const sample = (
    positionDx: [number, number],
    positionDy: [number, number],
  ) => sampleClassField(
    { ids, fraction: [0.4975, 0.5], positionDx, positionDy },
    edges,
  );
  const rotated = 0.01 / Math.SQRT2;

  assert.ok(Math.abs(weightOf(sample([0.01, 0], [0, 0.01]), TREE) - 0.75) < 1e-12);
  assert.ok(weightOf(sample([0.005, 0], [0, 0.01]), TREE) > 0.999);
  assert.ok(
    Math.abs(weightOf(sample([rotated, rotated], [-rotated, rotated]), TREE) - 0.75) < 1e-12,
  );
});

test("multi-class blends stay continuous across a winner change", () => {
  const ids = edgeNeighbourhood([TREE, COVER], [GRASS, GRASS]);
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const at = (fractionX: number) => sampleClassField(
    {
      ids,
      fraction: [fractionX, 0.25],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );
  const tie = 3 / 7;
  const tied = at(tie);
  const below = at(tie - 1e-4);
  const above = at(tie + 1e-4);

  assert.equal(tied.weights.length, 3);
  assert.ok(weightOf(tied, COVER) > 0.05 && weightOf(tied, COVER) < 0.2);
  assert.ok(Math.abs(weightOf(below, TREE) - weightOf(above, TREE)) < 0.001);
  assert.ok(Math.abs(weightOf(below, GRASS) - weightOf(above, GRASS)) < 0.001);
  assert.ok(Math.abs(weightOf(below, COVER) - weightOf(above, COVER)) < 0.001);

  assert.equal(strongest(at(tie - 0.01)), TREE);
  assert.equal(strongest(at(tie + 0.01)), GRASS);
  assert.ok(weightOf(at(tie + 0.01), COVER) > 0.02);
});

test("a class entering the stencil changes no blend at any rounding", () => {
  const field = [
    [GRASS, GRASS, GRASS, GRASS, GRASS],
    [GRASS, GRASS, GRASS, GRASS, COVER],
    [TREE, TREE, TREE, TREE, TREE],
    [TREE, TREE, TREE, TREE, TREE],
  ];
  const window = (firstColumn: number, fractionX: number, rounding: number) => sampleClassField(
    {
      ids: field.map((row) => row.slice(firstColumn, firstColumn + 4)),
      fraction: [fractionX, 0.25],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    { smooth: true, rounding, softnessCells: 1 },
  );

  for (const rounding of [0, 0.25, 0.6]) {
    const before = window(0, 1 - 1e-7, rounding);
    const after = window(1, 1e-7, rounding);

    assert.ok(Math.abs(weightOf(before, GRASS) - weightOf(after, GRASS)) < 1e-4, `${rounding}`);
    assert.ok(Math.abs(weightOf(before, TREE) - weightOf(after, TREE)) < 1e-4, `${rounding}`);
    assert.ok(weightOf(after, COVER) < 1e-4, `${rounding}`);
  }
});

test("outline ink is continuous where a class enters the stencil", () => {
  const field = [
    [GRASS, GRASS, GRASS, GRASS, GRASS],
    [GRASS, GRASS, GRASS, GRASS, COVER],
    [TREE, TREE, TREE, TREE, TREE],
    [TREE, TREE, TREE, TREE, TREE],
  ];

  for (const softnessCells of [0, 1]) {
    for (const rounding of [0.25, 1]) {
      const ink = (firstColumn: number, fractionX: number) => sampleClassField(
        {
          ids: field.map((row) => row.slice(firstColumn, firstColumn + 4)),
          fraction: [fractionX, 0.5],
          positionDx: [2, 0],
          positionDy: [0, 2],
        },
        { smooth: true, rounding, softnessCells },
      ).outline;

      const message = `${softnessCells} ${rounding}`;
      assert.ok(Math.abs(ink(0, 1 - 1e-9) - ink(1, 1e-9)) < 1e-6, message);
    }
  }
});

test("an unsupported outer class leaves a two-class blend unchanged", () => {
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const blend = (outer: number) => sampleClassField(
    {
      ids: [
        [0, 0, 0, outer],
        [0, TREE, GRASS, 0],
        [0, TREE, GRASS, 0],
        [0, 0, 0, 0],
      ],
      fraction: [0.25, 0.5],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );

  assert.ok(Math.abs(weightOf(blend(COVER), TREE) - 0.75) < 1e-12);
  assert.equal(weightOf(blend(COVER), COVER), 0);
});

test("outline ink marks real edges and never a pure interior", () => {
  const sample = (ids: number[][], rounding: number, fractionX = 0.5) => sampleClassField(
    {
      ids,
      fraction: [fractionX, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding, softnessCells: 0 },
  );
  const interior = [
    [COVER, GRASS, GRASS, COVER],
    [GRASS, TREE, TREE, GRASS],
    [GRASS, TREE, TREE, GRASS],
    [COVER, GRASS, GRASS, COVER],
  ];
  const edge = edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]);

  for (const rounding of [0, 0.25, 0.6]) {
    assert.ok(sample(interior, rounding).outline < 1e-3, `${rounding}`);
  }
  assert.ok(sample(edge, 0).outline > 0.99);
  assert.ok(sample(edge, 0, 0.9).outline < 1e-3);
});

test("outline ink skips a tie hidden under a dominant third class", () => {
  const ids = edgeNeighbourhood([TREE, GRASS], [COVER, GRASS]);
  const ink = (fractionX: number, fractionY: number) => sampleClassField(
    {
      ids,
      fraction: [fractionX, fractionY],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding: 0, softnessCells: 0 },
  ).outline;

  assert.ok(ink(0.5, 0.25) > 0.8);
  assert.ok(ink(0.3, 0.7 / 1.7) > 0.9);
  assert.ok(ink(0.5, 0.75) < 1e-3);
  assert.ok(ink(0.3, 0.9) < 1e-3);
});

test("outline ink stops at a junction instead of following a losing pair's tie", () => {
  const ids = edgeNeighbourhood([TREE, COVER], [GRASS, COVER]);
  const ink = (fractionY: number, softnessCells: number) => sampleClassField(
    {
      ids,
      fraction: [0.5, fractionY],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding: 0, softnessCells },
  ).outline;

  for (const softnessCells of [0, 1]) {
    assert.ok(ink(0.2, softnessCells) > 0.5, `${softnessCells}`);
    assert.ok(ink(0.8, softnessCells) < 1e-3, `${softnessCells}`);
    assert.ok(ink(0.95, softnessCells) < 1e-3, `${softnessCells}`);
  }
});

test("outline ink is continuous where the runner-up swaps places", () => {
  const ids = edgeNeighbourhood([TREE, COVER], [GRASS, COVER]);
  const swapY = 0.495 / 1.495;
  const ink = (fractionY: number, positionDx: [number, number], positionDy: [number, number]) =>
    sampleClassField(
      { ids, fraction: [0.495, fractionY], positionDx, positionDy },
      { smooth: true, rounding: 0, softnessCells: 1 },
    ).outline;
  const scales: [[number, number], [number, number]][] = [
    [[0.01, 0], [0, 0.01]],
    [[0.04, 0], [0, 0.005]],
  ];

  for (const [positionDx, positionDy] of scales) {
    const before = ink(swapY - 1e-9, positionDx, positionDy);
    const after = ink(swapY + 1e-9, positionDx, positionDy);

    assert.ok(Math.abs(before - after) < 1e-6, `${positionDx} ${before} ${after}`);
  }
});

test("outline ink is continuous where the top two classes swap places", () => {
  const ids = edgeNeighbourhood([TREE, COVER], [GRASS, COVER]);
  const swapX = 0.48752205697000256;
  const swapY = 0.3388333333333333;

  for (const softnessCells of [0, 1]) {
    const ink = (offset: number) => sampleClassField(
      {
        ids,
        fraction: [swapX, swapY + offset],
        positionDx: [0.04, 0],
        positionDy: [0, 0.005],
      },
      { smooth: true, rounding: 0, softnessCells },
    ).outline;

    assert.ok(Math.abs(ink(-1e-9) - ink(1e-9)) < 1e-6, `${softnessCells}`);
  }
});

test("Smooth off paints the nearest cell instead of the kernel winner", () => {
  const ids = edgeNeighbourhood([TREE, GRASS], [GRASS, GRASS]);
  const fragment = {
    ids,
    fraction: [0.49, 0.49] as [number, number],
    positionDx: [0.0001, 0] as [number, number],
    positionDy: [0, 0.0001] as [number, number],
  };
  const smooth = sampleClassField(fragment, { smooth: true, rounding: 0, softnessCells: 1 });
  const flat = sampleClassField(fragment, { smooth: false, rounding: 0, softnessCells: 1 });

  assert.equal(flat.nearest, TREE);
  assert.deepEqual(flat.weights, [{ id: TREE, weight: 1 }]);
  assert.equal(smooth.nearest, TREE);
  assert.ok(weightOf(smooth, GRASS) > 0.7);
  assert.ok(weightOf(smooth, GRASS) > weightOf(smooth, TREE));
});

test("no-data keeps the nearest-cell mask and isolated classes whole", () => {
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const isolated = sampleClassField(
    {
      ids: edgeNeighbourhood([TREE, 0], [0, 0]),
      fraction: [0.49, 0.49],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );
  const loneCell = sampleClassField(
    {
      ids: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, TREE, 0],
        [0, 0, 0, 0],
      ],
      fraction: [0.6, 0.6],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );
  const besideEmpty = sampleClassField(
    {
      ids: edgeNeighbourhood([TREE, 0], [GRASS, 0]),
      fraction: [0.49, 0.49],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );
  const nearestEmpty = {
    ids: edgeNeighbourhood([0, TREE], [TREE, 0]),
    fraction: [0.49, 0.49] as [number, number],
    positionDx: [0.0001, 0] as [number, number],
    positionDy: [0, 0.0001] as [number, number],
  };

  assert.equal(isolated.discarded, false);
  assert.deepEqual(isolated.weights, [{ id: TREE, weight: 1 }]);
  assert.equal(loneCell.discarded, false);
  assert.deepEqual(loneCell.weights, [{ id: TREE, weight: 1 }]);
  assert.ok(Math.abs(weightOf(besideEmpty, TREE) + weightOf(besideEmpty, GRASS) - 1) < 1e-12);
  assert.ok(weightOf(besideEmpty, TREE) > 0.4);
  assert.equal(sampleClassField(nearestEmpty, edges).discarded, true);
  assert.equal(sampleClassField(nearestEmpty, { ...edges, smooth: false }).discarded, true);
});


test("edges mode draws no fill", () => {
  const interior = sampleClassField(
    {
      ids: [
        [COVER, GRASS, GRASS, COVER],
        [GRASS, TREE, TREE, GRASS],
        [GRASS, TREE, TREE, GRASS],
        [COVER, GRASS, GRASS, COVER],
      ],
      fraction: [0.5, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding: 0, softnessCells: 0 },
  );
  const fillMode = classFieldAlpha(interior, fillAppearance());
  const edgesMode = classFieldAlpha(interior, edgesAppearance());

  assert.equal(edgesMode.fill, 0);
  assert.equal(edgesMode.ink, 0);
  assert.equal(edgesMode.alpha, 0);
  assert.equal(fillMode.fill, 1);
  assert.equal(fillMode.alpha, 1);
});

test("no-data fragments draw no fill or ink in either appearance", () => {
  const noData = sampleClassField(
    {
      ids: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      fraction: [0.5, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding: 0, softnessCells: 0 },
  );

  assert.equal(noData.discarded, true);
  assert.deepEqual(
    classFieldAlpha(noData, fillAppearance()),
    { fill: 0, ink: 0, alpha: 0 },
  );
  assert.deepEqual(
    classFieldAlpha(noData, edgesAppearance()),
    { fill: 0, ink: 0, alpha: 0 },
  );
});

test("edges mode ink is stronger than the faint outline", () => {
  const result = sampleClassField(
    {
      ids: edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]),
      fraction: [0.5, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding: 0, softnessCells: 0 },
  );
  const fillMode = classFieldAlpha(result, fillAppearance());
  const edgesMode = classFieldAlpha(result, edgesAppearance());

  assert.ok(result.outline > 0.99);
  assert.ok(edgesMode.ink > 2 * fillMode.ink);
  assert.ok(Math.abs(fillMode.ink - result.outline * FILL_OUTLINE_STRENGTH) < 1e-12);
  assert.ok(Math.abs(edgesMode.ink - result.outline * EDGES_OUTLINE_STRENGTH) < 1e-12);
});


function edgeNeighbourhood(
  left: readonly [number, number],
  right: readonly [number, number],
): number[][] {
  return [
    [0, 0, 0, 0],
    [0, left[0], right[0], 0],
    [0, left[1], right[1], 0],
    [0, 0, 0, 0],
  ];
}

function weightOf(result: ClassFieldResult, id: number): number {
  return result.weights.find((entry) => entry.id === id)?.weight ?? 0;
}

function fillAppearance(): ClassFieldAppearance {
  return { fillOpacity: 1, outlineStrength: FILL_OUTLINE_STRENGTH, outline: true };
}

function edgesAppearance(): ClassFieldAppearance {
  return { fillOpacity: 0, outlineStrength: EDGES_OUTLINE_STRENGTH, outline: true };
}

function strongest(result: ClassFieldResult): number {
  return result.weights.reduce((best, entry) => (entry.weight > best.weight ? entry : best)).id;
}
