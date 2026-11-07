import assert from "node:assert/strict";
import { test } from "node:test";

import { GEOLOGY_SMOOTH_RADIUS_CELLS } from "../display-state.ts";
import {
  CLASS_HATCH_ID,
  classFieldAlpha,
  edgeCoverage,
  FILL_OUTLINE_STRENGTH,
  homogeneousFlags,
  sampleClassField,
  type ClassFieldAppearance,
  type ClassFieldResult,
} from "./class-field-shaders.ts";
import { textureTiles, WIDE_HALO_CELLS, type TextureTile } from "./grid-geometry.ts";

const TREE = 10;
const GRASS = 20;
const COVER = 30;
const STAIRCASE_STEP_CELLS = 3; // replicated step width used in the review probe

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

test("no-data fragments draw no ink or alpha", () => {
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
  assert.deepEqual(classFieldAlpha(noData, fillAppearance()), { ink: 0, alpha: 0 });
});

test("a class fill is opaque and its outline uses the faint ink weight", () => {
  const result = sampleClassField(
    {
      ids: edgeNeighbourhood([TREE, TREE], [GRASS, GRASS]),
      fraction: [0.5, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: true, rounding: 0, softnessCells: 0 },
  );
  const drawn = classFieldAlpha(result, fillAppearance());

  assert.ok(result.outline > 0.99);
  assert.equal(drawn.alpha, 1);
  assert.ok(Math.abs(drawn.ink - result.outline * FILL_OUTLINE_STRENGTH) < 1e-12);
});

test("hatched no-data is drawn instead of discarded and stays out of blends", () => {
  const edges = { smooth: true, rounding: 0, softnessCells: 1 };
  const hatched = sampleClassField(
    {
      ids: edgeNeighbourhood([CLASS_HATCH_ID, CLASS_HATCH_ID], [CLASS_HATCH_ID, CLASS_HATCH_ID]),
      fraction: [0.5, 0.5],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    edges,
  );
  const besideHatch = sampleClassField(
    {
      ids: edgeNeighbourhood([TREE, CLASS_HATCH_ID], [GRASS, CLASS_HATCH_ID]),
      fraction: [0.25, 0.25],
      positionDx: [0.0001, 0],
      positionDy: [0, 0.0001],
    },
    edges,
  );

  assert.equal(hatched.discarded, false);
  assert.equal(hatched.nearest, CLASS_HATCH_ID);
  assert.deepEqual(hatched.weights, []);
  assert.deepEqual(classFieldAlpha(hatched, fillAppearance()), { ink: 0, alpha: 1 });
  assert.ok(Math.abs(weightOf(besideHatch, TREE) + weightOf(besideHatch, GRASS) - 1) < 1e-12);
  assert.equal(weightOf(besideHatch, CLASS_HATCH_ID), 0);
});

test("hatched no-data draws without smoothing like a class fill", () => {
  const hatched = sampleClassField(
    {
      ids: edgeNeighbourhood([CLASS_HATCH_ID, TREE], [TREE, TREE]),
      fraction: [0.25, 0.25],
      positionDx: [0.01, 0],
      positionDy: [0, 0.01],
    },
    { smooth: false, rounding: 0, softnessCells: 0 },
  );

  assert.equal(hatched.discarded, false);
  assert.equal(hatched.nearest, CLASS_HATCH_ID);
});

test("a zero radius ignores wide sampling and keeps the legacy kernel", () => {
  const ids = [
    [GRASS, GRASS, GRASS, GRASS],
    [GRASS, TREE, TREE, GRASS],
    [GRASS, TREE, GRASS, GRASS],
    [GRASS, GRASS, GRASS, GRASS],
  ];
  const fragment = {
    ids,
    fraction: [0.5, 0.5] as [number, number],
    positionDx: [0.0001, 0] as [number, number],
    positionDy: [0, 0.0001] as [number, number],
    position: [1.5, 1.5] as [number, number],
    sampleId: () => GRASS,
  };
  const legacy = sampleClassField(fragment, { smooth: true, rounding: 0.25, softnessCells: 0 });
  const explicit = sampleClassField(
    fragment,
    { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 0 },
  );

  assert.deepEqual(explicit.weights, legacy.weights);
  assert.equal(strongest(legacy), TREE);
});

test("the shipped default keeps straight edges centred", () => {
  const straightCentred = sampleClassField(
    fragmentAt(straightId, -0.5, 5.5, 0.01),
    {
      smooth: true,
      rounding: 0.25,
      softnessCells: 0,
      smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
    },
  );

  assert.ok(Math.abs(weightOf(straightCentred, TREE) - 0.5) < 1e-9);
});

test("the shipped default turns a staircase into a gradual slope", () => {
  const largestJump = (radius: number | undefined) => {
    const edge = [6, 6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75, 8, 8.25, 8.5, 8.75, 9, 9.25, 9.5]
      .map((positionY) => boundaryX(positionY, radius));
    return Math.max(...edge.slice(1).map((x, index) => Math.abs(x - edge[index])));
  };

  assert.ok(largestJump(GEOLOGY_SMOOTH_RADIUS_CELLS) < largestJump(undefined) / 1.5);
});

test("wide sampling stays continuous across tap cell borders at the shipped default", () => {
  const at = (positionY: number) => sampleClassField(
    fragmentAt(staircaseId, 4, positionY, 0.001),
    {
      smooth: true,
      rounding: 0.25,
      softnessCells: 0,
      smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
    },
  );
  const below = at(5.5 - 1e-7);
  const above = at(5.5 + 1e-7);

  assert.ok(Math.abs(weightOf(below, TREE) - weightOf(above, TREE)) < 0.01);
  assert.ok(Math.abs(below.outline - above.outline) < 0.01);
});

test("wide sampling keeps outside and hatch out of the class mix", () => {
  const gapped = sampleClassField(
    {
      ...fragmentAt(straightId, -0.5, 5.5, 0.01),
      sampleId: gappedStraightId,
    },
    {
      smooth: true,
      rounding: 0.25,
      softnessCells: 0,
      smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
    },
  );

  assert.equal(weightOf(gapped, 0), 0);
  assert.equal(weightOf(gapped, CLASS_HATCH_ID), 0);
  assert.ok(Math.abs(weightOf(gapped, TREE) + weightOf(gapped, GRASS) - 1) < 1e-9);
});

test("small positive radii fall back to the legacy kernel in a uniform field", () => {
  const uniform = () => TREE;
  for (const radius of [0.05, 0.1, 0.2, 0.25]) {
    const result = sampleClassField(
      fragmentAt(uniform, 0.5, 0.5, 0.0001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 0,
        smoothRadiusCells: radius,
      },
    );

    assert.deepEqual(result.weights, [{ id: TREE, weight: 1 }], `${radius}`);
    assert.equal(result.outline, 0, `${radius}`);
  }
});

test("a 25-class window falls back to the legacy kernel", () => {
  const wide = (sample: (cellX: number, cellY: number) => number) => sampleClassField(
    fragmentAt(sample, 0.5, 0.5, 0.0001),
    {
      smooth: true,
      rounding: 0.25,
      softnessCells: 0,
      smoothRadiusCells: 2,
    },
  );
  const legacy = (sample: (cellX: number, cellY: number) => number) => sampleClassField(
    fragmentAt(sample, 0.5, 0.5, 0.0001),
    { smooth: true, rounding: 0.25, softnessCells: 0 },
  );

  assert.deepEqual(wide(overflowId).weights, legacy(overflowId).weights);
  assert.equal(strongest(wide(overflowId)), 100);
  assert.deepEqual(wide(overflowGappedId).weights, legacy(overflowGappedId).weights);
  assert.equal(strongest(wide(overflowGappedId)), 100);
});

test("wide sampling stays continuous across integer steps on both axes", () => {
  const probes: {
    sample: (cellX: number, cellY: number) => number;
    position: [number, number];
    axis: string;
  }[] = [
    { sample: straightId, position: [0, 5.5], axis: "x" },
    { sample: horizontalId, position: [4, 0], axis: "y" },
    { sample: staircaseId, position: [6, 6], axis: "x" },
    { sample: staircaseId, position: [4, 6], axis: "y" },
  ];
  for (const radius of [GEOLOGY_SMOOTH_RADIUS_CELLS, 2]) {
    for (const { sample, position, axis } of probes) {
      const at = (offset: number) => sampleClassField(
        fragmentAt(
          sample,
          position[0] + (axis === "x" ? offset : 0),
          position[1] + (axis === "y" ? offset : 0),
          0.001,
        ),
        {
          smooth: true,
          rounding: 0.25,
          softnessCells: 0,
          smoothRadiusCells: radius,
        },
      );
      const below = at(-1e-7);
      const above = at(1e-7);
      const treeJump = Math.abs(weightOf(below, TREE) - weightOf(above, TREE));
      const inkJump = Math.abs(below.outline - above.outline);

      assert.ok(treeJump < 0.01, `${axis} ${radius}`);
      assert.ok(inkJump < 0.01, `${axis} ${radius}`);
    }
  }
});

test("wide sampling at radius 4 stays continuous across integer steps on both axes", () => {
  const probes: {
    sample: (cellX: number, cellY: number) => number;
    position: [number, number];
    axis: string;
  }[] = [
    { sample: straightId, position: [0, 5.5], axis: "x" },
    { sample: horizontalId, position: [4, 0], axis: "y" },
    { sample: staircaseId, position: [6, 6], axis: "x" },
    { sample: staircaseId, position: [4, 6], axis: "y" },
    { sample: oddStraightId, position: [1, 5.5], axis: "x" },
    { sample: oddHorizontalId, position: [4, 1], axis: "y" },
  ];
  for (const { sample, position, axis } of probes) {
    const at = (offset: number) => sampleClassField(
      fragmentAt(
        sample,
        position[0] + (axis === "x" ? offset : 0),
        position[1] + (axis === "y" ? offset : 0),
        0.001,
      ),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 0,
        smoothRadiusCells: 4,
      },
    );
    const below = at(-1e-7);
    const above = at(1e-7);
    const treeJump = Math.abs(weightOf(below, TREE) - weightOf(above, TREE));
    const inkJump = Math.abs(below.outline - above.outline);

    assert.ok(treeJump < 0.01, `${axis} ${treeJump}`);
    assert.ok(inkJump < 0.01, `${axis} ${inkJump}`);
  }
});

test("wide tiles with an eight-cell halo match unsplit sampling across a horizontal join", () => {
  const nx = 40;
  const ny = 16;
  const tiles = textureTiles(nx, ny, 24, WIDE_HALO_CELLS);

  assert.ok(tiles.length > 1);
  assert.ok(tiles.every((tile) => tile.window.column % 2 === 0));
  for (const positionX of tiledPositions(nx)) {
    const tiled = sampleClassField(
      fragmentAt(tiledDiagonal(tiles, nx, ny, positionX, 8.5), positionX, 8.5, 0.001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 1,
        smoothRadiusCells: 4,
      },
    );
    const direct = sampleClassField(
      fragmentAt(globalDiagonal(nx, ny), positionX, 8.5, 0.001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 1,
        smoothRadiusCells: 4,
      },
    );

    assert.ok(Math.abs(weightOf(tiled, TREE) - weightOf(direct, TREE)) < 1e-12, `${positionX}`);
    assert.ok(Math.abs(tiled.outline - direct.outline) < 1e-12, `${positionX}`);
  }
});

test("wide tiles with an eight-cell halo match unsplit sampling across a vertical join", () => {
  const nx = 16;
  const ny = 40;
  const tiles = textureTiles(nx, ny, 24, WIDE_HALO_CELLS);

  assert.ok(tiles.length > 1);
  assert.ok(tiles.every((tile) => tile.window.row % 2 === 0));
  for (const positionY of tiledPositions(ny)) {
    const tiled = sampleClassField(
      fragmentAt(tiledDiagonal(tiles, nx, ny, 8.5, positionY), 8.5, positionY, 0.001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 1,
        smoothRadiusCells: 4,
      },
    );
    const direct = sampleClassField(
      fragmentAt(globalDiagonal(nx, ny), 8.5, positionY, 0.001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 1,
        smoothRadiusCells: 4,
      },
    );

    assert.ok(Math.abs(weightOf(tiled, TREE) - weightOf(direct, TREE)) < 1e-12, `${positionY}`);
    assert.ok(Math.abs(tiled.outline - direct.outline) < 1e-12, `${positionY}`);
  }
});

test("wide sampling at radius 4 turns a staircase into a gradual slope", () => {
  const largestJump = (radius: number | undefined) => {
    const edge = [6, 6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75, 8, 8.25, 8.5, 8.75, 9, 9.25, 9.5]
      .map((positionY) => boundaryX(positionY, radius));
    return Math.max(...edge.slice(1).map((x, index) => Math.abs(x - edge[index])));
  };

  assert.ok(largestJump(4) < largestJump(undefined) / 1.5);
  assert.ok(largestJump(4) <= largestJump(GEOLOGY_SMOOTH_RADIUS_CELLS));
});

test("wide sampling at radius 4 fetches at most 64 taps", () => {
  for (const [positionX, positionY] of [[4.5, 5.5], [6, 6], [-3, -2.5]]) {
    const base = fragmentAt(staircaseId, positionX, positionY, 0.001);
    let calls = 0;
    const fragment = {
      ...base,
      sampleId: (cellX: number, cellY: number) => {
        calls++;
        return staircaseId(cellX, cellY);
      },
    };
    sampleClassField(fragment, {
      smooth: true,
      rounding: 0.25,
      softnessCells: 0,
      smoothRadiusCells: 4,
    });

    assert.ok(calls > 0, `${positionX},${positionY}`);
    assert.ok(calls <= 64, `${positionX},${positionY}: ${calls}`);
  }
});

test("homogeneous flags cover the 16 x 16 support of the largest radius", () => {
  const size = 24;
  const centre = 12;
  const uniform = new Uint8Array(size * size).fill(TREE);
  assert.ok(homogeneousFlags(uniform, size, size).every((flag) => flag === 1));

  const near = new Uint8Array(size * size).fill(TREE);
  near[centre * size + (centre + 7)] = GRASS;
  assert.equal(homogeneousFlags(near, size, size)[centre * size + centre], 0);

  const far = new Uint8Array(size * size).fill(TREE);
  far[centre * size + (centre + 9)] = GRASS;
  assert.equal(homogeneousFlags(far, size, size)[centre * size + centre], 1);

  const base = fragmentAt(() => TREE, 0.5, 0.5, 0.0001);
  const options = {
    smooth: true,
    rounding: 0.25,
    softnessCells: 0,
    smoothRadiusCells: 4,
  } as const;
  const flagged = sampleClassField({ ...base, homogeneous: true }, options);
  const plain = sampleClassField(base, options);

  assert.deepEqual(flagged.weights, plain.weights);
  assert.equal(flagged.outline, plain.outline);
});

test("homogeneous flags mark uniform neighbourhoods including edges", () => {
  const uniform = new Uint8Array(4 * 3).fill(TREE);
  assert.ok(homogeneousFlags(uniform, 4, 3).every((flag) => flag === 1));

  const split = new Uint8Array([
    TREE,
    TREE,
    GRASS,
    GRASS,
    TREE,
    TREE,
    GRASS,
    GRASS,
    TREE,
    TREE,
    GRASS,
    GRASS,
  ]);
  const splitFlags = homogeneousFlags(split, 4, 3);
  assert.ok(splitFlags.every((flag) => flag === 0));

  const clamped = new Uint8Array([TREE, TREE, TREE, TREE]);
  assert.ok(homogeneousFlags(clamped, 2, 2).every((flag) => flag === 1));

  const outside = new Uint8Array(4 * 3).fill(0);
  assert.ok(homogeneousFlags(outside, 4, 3).every((flag) => flag === 1));

  const hatched = new Uint8Array(4 * 3).fill(CLASS_HATCH_ID);
  assert.ok(homogeneousFlags(hatched, 4, 3).every((flag) => flag === 1));

  const withGap = new Uint8Array(4 * 3).fill(TREE);
  withGap[5] = 0;
  assert.ok(homogeneousFlags(withGap, 4, 3).every((flag) => flag === 0));
});

test("flagged and unflagged paths render the same colour in the mirror", () => {
  const uniform = () => TREE;
  for (const radius of [0.25, GEOLOGY_SMOOTH_RADIUS_CELLS, 2]) {
    const base = fragmentAt(uniform, 0.5, 0.5, 0.0001);
    const flagged = sampleClassField(
      { ...base, homogeneous: true },
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 0,
        smoothRadiusCells: radius,
      },
    );
    const plain = sampleClassField(
      base,
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 0,
        smoothRadiusCells: radius,
      },
    );

    assert.deepEqual(flagged.weights, plain.weights, `${radius}`);
    assert.equal(flagged.outline, plain.outline, `${radius}`);
  }

  const edgeBase = fragmentAt(straightId, -0.5, 5.5, 0.01);
  const edgeFlagged = sampleClassField(
    { ...edgeBase, homogeneous: true },
    {
      smooth: true,
      rounding: 0.25,
      softnessCells: 0,
      smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
    },
  );

  assert.deepEqual(edgeFlagged.weights, [{ id: GRASS, weight: 1 }]);

  const edgeLegacyFlagged = sampleClassField(
    { ...edgeBase, homogeneous: true },
    { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 0 },
  );
  const edgeLegacyPlain = sampleClassField(
    edgeBase,
    { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 0 },
  );

  assert.deepEqual(edgeLegacyFlagged.weights, edgeLegacyPlain.weights);
});

function fragmentAt(
  sample: (cellX: number, cellY: number) => number,
  positionX: number,
  positionY: number,
  cellStep: number,
): {
  ids: number[][];
  fraction: [number, number];
  positionDx: [number, number];
  positionDy: [number, number];
  position: [number, number];
  sampleId: (cellX: number, cellY: number) => number;
} {
  const baseX = Math.floor(positionX);
  const baseY = Math.floor(positionY);
  const ids: number[][] = [];
  for (let row = -1; row <= 2; row++) {
    const line: number[] = [];
    for (let column = -1; column <= 2; column++) {
      line.push(sample(baseX + column, baseY + row));
    }
    ids.push(line);
  }
  return {
    ids,
    fraction: [positionX - baseX, positionY - baseY],
    positionDx: [cellStep, 0],
    positionDy: [0, cellStep],
    position: [positionX, positionY],
    sampleId: sample,
  };
}

function straightId(cellX: number, cellY: number): number {
  return cellX < 0 ? TREE : GRASS;
}

function oddStraightId(cellX: number, cellY: number): number {
  return cellX < 1 ? TREE : GRASS;
}

function boundaryX(positionY: number, radius: number | undefined): number {
  let low = 0;
  let high = 20;
  for (let step = 0; step < 30; step++) {
    const middle = (low + high) / 2;
    const result = sampleClassField(
      fragmentAt(staircaseId, middle, positionY, 0.01),
      { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: radius },
    );
    if (weightOf(result, TREE) > weightOf(result, GRASS)) low = middle;
    else high = middle;
  }
  return low;
}

function staircaseId(cellX: number, cellY: number): number {
  return cellX < STAIRCASE_STEP_CELLS * Math.floor(cellY / STAIRCASE_STEP_CELLS) ? TREE : GRASS;
}

function gappedStraightId(cellX: number, cellY: number): number {
  if (cellX === 0 && cellY === 7) return 0;
  if (cellX === 0 && cellY === 4) return CLASS_HATCH_ID;

  return straightId(cellX, cellY);
}

function overflowId(cellX: number, cellY: number): number {
  if (cellY >= 0) return 100;

  return (cellY + 3) * 8 + (cellX + 3) + 1;
}

function overflowGappedId(cellX: number, cellY: number): number {
  if (cellX === -3 && cellY === -3) return 0;
  if (cellX === -2 && cellY === -3) return CLASS_HATCH_ID;

  return overflowId(cellX, cellY);
}

function horizontalId(cellX: number, cellY: number): number {
  return cellY < 0 ? TREE : GRASS;
}

function oddHorizontalId(cellX: number, cellY: number): number {
  return cellY < 1 ? TREE : GRASS;
}

function diagonalId(cellX: number, cellY: number): number {
  return cellX - cellY < 8 ? TREE : GRASS;
}

function tiledPositions(count: number): number[] {
  const positions = [0.5, count - 0.5];
  for (let edge = 1; edge < count; edge++) {
    positions.push(edge - 1e-7, edge + 1e-7);
  }
  return positions;
}

function clampCell(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, value));
}

function globalDiagonal(nx: number, ny: number): (cellX: number, cellY: number) => number {
  return (cellX, cellY) => diagonalId(clampCell(cellX, nx), clampCell(cellY, ny));
}

function tiledDiagonal(
  tiles: TextureTile[],
  nx: number,
  ny: number,
  positionX: number,
  positionY: number,
): (cellX: number, cellY: number) => number {
  const baseX = Math.floor(positionX);
  const baseY = Math.floor(positionY);
  const tile = tiles.find(
    ({ core }) =>
      baseX >= core.column
      && baseX < core.column + core.width
      && baseY >= core.row
      && baseY < core.row + core.height,
  )!;
  const { window } = tile;
  return (cellX, cellY) =>
    diagonalId(
      Math.min(window.column + window.width - 1, Math.max(window.column, cellX)),
      Math.min(window.row + window.height - 1, Math.max(window.row, cellY)),
    );
}

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
  return { outlineStrength: FILL_OUTLINE_STRENGTH, outline: true };
}

function strongest(result: ClassFieldResult): number {
  return result.weights.reduce((best, entry) => (entry.weight > best.weight ? entry : best)).id;
}

test("the single-pass flags equal the naive scan on random and edge-case grids", () => {
  for (const { cells, nx, ny } of flagCases()) {
    const fast = [...homogeneousFlags(cells, nx, ny)];
    assert.deepEqual(fast, [...naiveHomogeneousFlags(cells, nx, ny)]);
  }
});

test("flags on a 1000 x 1000 grid stay under the generous regression limit", () => {
  const nx = 1000;
  const ny = 1000;
  const cells = randomCells(nx, ny, 20261107);
  const start = performance.now();
  const flags = homogeneousFlags(cells, nx, ny);
  const elapsed = performance.now() - start;

  assert.equal(flags.length, nx * ny);
  assert.ok(elapsed < MAX_FLAG_BUILD_MS, `homogeneousFlags took ${elapsed} ms`);
});

// Generous so slow machines pass while a return to the per-cell scan still fails.
const MAX_FLAG_BUILD_MS = 1500;

// A verbatim copy of the previous 16 x 16 scan, kept as the oracle for the fast pass.
const NAIVE_FIRST_OFFSET_CELLS = -7;
const NAIVE_SPAN_CELLS = 16;

function naiveHomogeneousFlags(cells: Uint8Array, nx: number, ny: number): Uint8Array {
  const flags = new Uint8Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      flags[row * nx + column] = isNaiveUniform(cells, nx, ny, column, row) ? 1 : 0;
    }
  }
  return flags;
}

function isNaiveUniform(
  cells: Uint8Array,
  nx: number,
  ny: number,
  column: number,
  row: number,
): boolean {
  const firstRow = naiveClamp(row + NAIVE_FIRST_OFFSET_CELLS, ny);
  const firstColumn = naiveClamp(column + NAIVE_FIRST_OFFSET_CELLS, nx);
  const first = cells[firstRow * nx + firstColumn];
  for (let tapRow = 0; tapRow < NAIVE_SPAN_CELLS; tapRow++) {
    const cellRow = naiveClamp(row + NAIVE_FIRST_OFFSET_CELLS + tapRow, ny);
    for (let tapColumn = 0; tapColumn < NAIVE_SPAN_CELLS; tapColumn++) {
      if (cells[cellRow * nx + naiveClamp(column + NAIVE_FIRST_OFFSET_CELLS + tapColumn, nx)] !== first) {
        return false;
      }
    }
  }
  return true;
}

function naiveClamp(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, value));
}

function flagCases(): { cells: Uint8Array; nx: number; ny: number }[] {
  const alphabet = [0, TREE, GRASS, COVER, CLASS_HATCH_ID];
  const cases: { cells: Uint8Array; nx: number; ny: number }[] = [
    { cells: Uint8Array.of(TREE), nx: 1, ny: 1 },
    { cells: Uint8Array.of(0), nx: 1, ny: 1 },
    { cells: new Uint8Array(4 * 3).fill(TREE), nx: 4, ny: 3 },
    { cells: new Uint8Array(4 * 3).fill(0), nx: 4, ny: 3 },
    { cells: new Uint8Array(4 * 3).fill(CLASS_HATCH_ID), nx: 4, ny: 3 },
    { cells: Uint8Array.from([TREE, GRASS, 0, CLASS_HATCH_ID]), nx: 2, ny: 2 },
    { cells: Uint8Array.from([TREE, TREE, TREE, 0]), nx: 2, ny: 2 },
  ];
  const sizes: [number, number][] = [[3, 3], [5, 4], [16, 16], [17, 17], [24, 20], [33, 9]];
  sizes.forEach(([nx, ny], index) => {
    cases.push({ cells: randomCells(nx, ny, 1000 + index, alphabet), nx, ny });
    cases.push({ cells: new Uint8Array(nx * ny).fill(GRASS), nx, ny });
  });
  return cases;
}

function randomCells(nx: number, ny: number, seed: number, alphabet?: number[]): Uint8Array {
  const values = alphabet ?? [0, TREE, GRASS, COVER, 30, 40, 50, CLASS_HATCH_ID];
  let state = seed >>> 0;
  const cells = new Uint8Array(nx * ny);
  for (let cell = 0; cell < cells.length; cell++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    cells[cell] = values[((mixed ^ (mixed >>> 14)) >>> 0) % values.length];
  }
  return cells;
}
