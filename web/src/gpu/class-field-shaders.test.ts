import assert from "node:assert/strict";
import { test } from "node:test";

import { GEOLOGY_SMOOTH_RADIUS_CELLS } from "../display-state.ts";
import {
  BAND_BYTES_PER_CELL,
  bakeBand,
  bakeBandInto,
  CLASS_HATCH_ID,
  classFieldAlpha,
  classFieldFragment,
  edgeCoverage,
  FILL_OUTLINE_STRENGTH,
  homogeneousFlags,
  isBandParityMismatched,
  gatherFieldClasses,
  isComplexBand,
  markThinCells,
  sampleClassField,
  THIN_CELL_FLAG,
  type BandTexel,
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

test("radius-sized tiles match unsplit sampling across a horizontal join", () => {
  const nx = 40;
  const ny = 16;
  const tiles = textureTiles(nx, ny, 24, WIDE_HALO_CELLS);

  assert.ok(tiles.length > 1);
  for (const positionX of tiledPositions(nx)) {
    const tiled = sampleClassField(
      fragmentAt(tiledDiagonal(tiles, nx, ny, positionX, 8.5), positionX, 8.5, 0.001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 1,
        smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
      },
    );
    const direct = sampleClassField(
      fragmentAt(globalDiagonal(nx, ny), positionX, 8.5, 0.001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 1,
        smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
      },
    );

    assert.ok(Math.abs(weightOf(tiled, TREE) - weightOf(direct, TREE)) < 1e-12, `${positionX}`);
    assert.ok(Math.abs(tiled.outline - direct.outline) < 1e-12, `${positionX}`);
  }
});

test("radius-sized tiles match unsplit sampling across a vertical join", () => {
  const nx = 16;
  const ny = 40;
  const tiles = textureTiles(nx, ny, 24, WIDE_HALO_CELLS);

  assert.ok(tiles.length > 1);
  for (const positionY of tiledPositions(ny)) {
    const tiled = sampleClassField(
      fragmentAt(tiledDiagonal(tiles, nx, ny, 8.5, positionY), 8.5, positionY, 0.001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 1,
        smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
      },
    );
    const direct = sampleClassField(
      fragmentAt(globalDiagonal(nx, ny), 8.5, positionY, 0.001),
      {
        smooth: true,
        rounding: 0.25,
        softnessCells: 1,
        smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
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

test("radius-sized flags skip interiors the kernel cannot reach", () => {
  const size = 24;
  const centre = 12;
  const uniform = new Uint8Array(size * size).fill(TREE);
  assert.ok(homogeneousFlags(uniform, size, size, GEOLOGY_SMOOTH_RADIUS_CELLS).every((flag) => (
    flag === 1
  )));

  const near = new Uint8Array(size * size).fill(TREE);
  near[centre * size + (centre + 4)] = GRASS;
  assert.equal(homogeneousFlags(near, size, size, GEOLOGY_SMOOTH_RADIUS_CELLS)[centre * size + centre], 0);

  const far = new Uint8Array(size * size).fill(TREE);
  far[centre * size + (centre + 5)] = GRASS;
  assert.equal(homogeneousFlags(far, size, size, GEOLOGY_SMOOTH_RADIUS_CELLS)[centre * size + centre], 1);
  assert.equal(homogeneousFlags(far, size, size)[centre * size + centre], 0);
});

test("the radius-sized skip renders the same colour as the wide gather", () => {
  // Five cells left of the edge the small window is uniform while the large one is not.
  const at = (homogeneous: boolean) => sampleClassField(
    { ...fragmentAt(straightId, -5.5, 5.5, 0.01), homogeneous },
    {
      smooth: true,
      rounding: 0.25,
      softnessCells: 0,
      smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
    },
  );
  const flagged = at(true);
  const plain = at(false);

  assert.equal(flagged.nearest, TREE);
  assert.deepEqual(flagged.weights, plain.weights);
  assert.equal(flagged.outline, plain.outline);
});

test("the single-pass flags equal the naive scan on random and edge-case grids", () => {
  for (const { cells, nx, ny } of flagCases()) {
    const fast = [...homogeneousFlags(cells, nx, ny)];
    assert.deepEqual(fast, [...naiveHomogeneousFlags(cells, nx, ny)]);
  }
});

test("the radius-sized flags equal the naive 8 x 8 scan", () => {
  for (const { cells, nx, ny } of flagCases()) {
    const fast = [...homogeneousFlags(cells, nx, ny, GEOLOGY_SMOOTH_RADIUS_CELLS)];
    assert.deepEqual(fast, [...naiveSmallHomogeneousFlags(cells, nx, ny)]);
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
// The radius-sized window the small kernel samples, kept as its own oracle.
const NAIVE_SMALL_FIRST_OFFSET_CELLS = -3;
const NAIVE_SMALL_SPAN_CELLS = 8;

function naiveHomogeneousFlags(cells: Uint8Array, nx: number, ny: number): Uint8Array {
  return naiveWindowFlags(cells, nx, ny, NAIVE_FIRST_OFFSET_CELLS, NAIVE_SPAN_CELLS);
}

function naiveSmallHomogeneousFlags(cells: Uint8Array, nx: number, ny: number): Uint8Array {
  return naiveWindowFlags(cells, nx, ny, NAIVE_SMALL_FIRST_OFFSET_CELLS, NAIVE_SMALL_SPAN_CELLS);
}

function naiveWindowFlags(
  cells: Uint8Array,
  nx: number,
  ny: number,
  firstOffset: number,
  span: number,
): Uint8Array {
  const flags = new Uint8Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      flags[row * nx + column] = isNaiveUniform(cells, nx, ny, column, row, firstOffset, span)
        ? 1
        : 0;
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
  firstOffset: number = NAIVE_FIRST_OFFSET_CELLS,
  span: number = NAIVE_SPAN_CELLS,
): boolean {
  const firstRow = naiveClamp(row + firstOffset, ny);
  const firstColumn = naiveClamp(column + firstOffset, nx);
  const first = cells[firstRow * nx + firstColumn];
  for (let tapRow = 0; tapRow < span; tapRow++) {
    const cellRow = naiveClamp(row + firstOffset + tapRow, ny);
    for (let tapColumn = 0; tapColumn < span; tapColumn++) {
      if (cells[cellRow * nx + naiveClamp(column + firstOffset + tapColumn, nx)] !== first) {
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

function bandTexelAt(
  band: { ids: Uint8Array; low: Uint32Array; high: Uint32Array },
  nx: number,
  positionX: number,
  positionY: number,
): BandTexel | undefined {
  const baseX = Math.floor(positionX);
  const baseY = Math.floor(positionY);
  if (baseX < 0 || baseY < 0 || baseX >= nx) {
    return undefined;
  }
  const ny = band.low.length / nx;
  if (baseY < 0 || baseY >= ny) {
    return undefined;
  }
  const index = baseY * nx + baseX;
  return {
    id0: band.ids[index * 2],
    id1: band.ids[index * 2 + 1],
    low: band.low[index],
    high: band.high[index],
  };
}

function gridFragment(
  cells: Uint8Array,
  nx: number,
  ny: number,
  positionX: number,
  positionY: number,
  cellStep: number,
  band?: BandTexel,
): {
  ids: number[][];
  fraction: [number, number];
  positionDx: [number, number];
  positionDy: [number, number];
  position: [number, number];
  sampleId: (cellX: number, cellY: number) => number;
  band?: BandTexel;
} {
  const base = fragmentAt(
    (cellX, cellY) => cells[clampCell(cellY, ny) * nx + clampCell(cellX, nx)],
    positionX,
    positionY,
    cellStep,
  );
  const flags = thinFlagsOf(cells, nx, ny);
  const baseX = Math.floor(positionX);
  const baseY = Math.floor(positionY);
  const thinAt = (cellX: number, cellY: number) => (
    flags[clampCell(cellY, ny) * nx + clampCell(cellX, nx)] === THIN_CELL_FLAG
  );
  const withThin = {
    ...base,
    thin: [
      [thinAt(baseX, baseY), thinAt(baseX + 1, baseY)],
      [thinAt(baseX, baseY + 1), thinAt(baseX + 1, baseY + 1)],
    ],
  };
  return band ? { ...withThin, band } : withThin;
}

const thinFlagCache = new WeakMap<Uint8Array, Uint8Array>();

/** The homogeneous and thin flags of a grid; thin marks do not depend on the radius. */
function thinFlagsOf(cells: Uint8Array, nx: number, ny: number): Uint8Array {
  let flags = thinFlagCache.get(cells);
  if (!flags) {
    flags = homogeneousFlags(cells, nx, ny, GEOLOGY_SMOOTH_RADIUS_CELLS);
    markThinCells(cells, nx, ny, flags);
    thinFlagCache.set(cells, flags);
  }
  return flags;
}

test("flat and smoothed boundaries share the same cell grid without an offset", () => {
  const flatEdges = { smooth: false, rounding: 0.25, softnessCells: 0 };
  const smoothEdges = {
    smooth: true,
    rounding: 0.25,
    softnessCells: 0,
    smoothRadiusCells: GEOLOGY_SMOOTH_RADIUS_CELLS,
  };
  // A straight edge flips the nearest cell at the same position where the smooth blend is tied.
  const centred = sampleClassField(fragmentAt(straightId, -0.5, 5.5, 0.01), smoothEdges);
  assert.ok(Math.abs(weightOf(centred, TREE) - 0.5) < 1e-9);
  const flatAtTie = sampleClassField(fragmentAt(straightId, -0.5, 5.5, 0.01), flatEdges);
  assert.equal(flatAtTie.nearest, GRASS);
  const flatWest = sampleClassField(fragmentAt(straightId, -0.51, 5.5, 0.01), flatEdges);
  assert.equal(flatWest.nearest, TREE);
  const flatEast = sampleClassField(fragmentAt(straightId, -0.49, 5.5, 0.01), flatEdges);
  assert.equal(flatEast.nearest, GRASS);
  // The horizontal edge uses the same grid: flat flips where the smooth tie sits.
  const horizontalCentred = sampleClassField(
    fragmentAt(horizontalId, 4.5, -0.5, 0.01),
    smoothEdges,
  );
  assert.ok(Math.abs(weightOf(horizontalCentred, TREE) - 0.5) < 1e-9);
  const flatHorizontal = sampleClassField(fragmentAt(horizontalId, 4.5, -0.5, 0.01), flatEdges);
  assert.equal(flatHorizontal.nearest, GRASS);
  const flatHorizontalWest = sampleClassField(
    fragmentAt(horizontalId, 4.5, -0.51, 0.01),
    flatEdges,
  );
  assert.equal(flatHorizontalWest.nearest, TREE);
});

test("wide smoothing keeps single cells and narrow strips at their centres", () => {
  const wide = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 1.5 };
  const legacy = { smooth: true, rounding: 0.25, softnessCells: 0 };
  const island = patchGrid((cellX, cellY) => (cellX === 12 && cellY === 12 ? TREE : GRASS));
  const strip = patchGrid((cellX) => (cellX === 12 ? TREE : GRASS));
  const islandWide = sampleClassField(gridFragment(island, PATCH, PATCH, 12, 12, 0.01), wide);
  const islandLegacy = sampleClassField(gridFragment(island, PATCH, PATCH, 12, 12, 0.01), legacy);
  assert.equal(strongest(islandWide), TREE);
  assert.equal(strongest(islandLegacy), TREE);
  const stripWide = sampleClassField(gridFragment(strip, PATCH, PATCH, 12, 12, 0.01), wide);
  assert.equal(strongest(stripWide), TREE);
  const patch = patchGrid((cellX, cellY) => (
    cellX >= 11 && cellX < 14 && cellY >= 11 && cellY < 14 ? TREE : GRASS
  ));
  const centre = sampleClassField(gridFragment(patch, PATCH, PATCH, 12, 12, 0.01), wide);
  assert.equal(strongest(centre), TREE);
});

test("the baked band matches the full gather on straight and staircase edges", () => {
  const nx = 32;
  const ny = 16;
  const cells = new Uint8Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      cells[row * nx + column] = staircaseId(column - 16, row) === TREE ? TREE : GRASS;
    }
  }
  for (const radius of [GEOLOGY_SMOOTH_RADIUS_CELLS, 2, 4]) {
    const band = bakeBand(cells, nx, ny, radius);
    for (const softnessCells of [0, 1]) {
      for (const outline of [false, true]) {
        const options = { smooth: true, rounding: 0.25, softnessCells, smoothRadiusCells: radius };
        for (const positionX of [12.5, 15.5, 16.5, 20.25, 24.75]) {
          for (const positionY of [4.5, 8.25, 12.75]) {
            const full = gridFragment(cells, nx, ny, positionX, positionY, 0.01);
            const texel = bandTexelAt(band, nx, positionX, positionY)!;
            const baked = gridFragment(cells, nx, ny, positionX, positionY, 0.01, texel);
            const expected = sampleClassField(full, options);
            const actual = sampleClassField(baked, options);
            assert.deepEqual(
              actual.weights.map(({ id }) => id),
              expected.weights.map(({ id }) => id),
              `${radius} ${softnessCells} ${outline} ${positionX},${positionY}`,
            );
            for (const { id, weight } of expected.weights) {
              assert.ok(
                Math.abs(weightOf(actual, id) - weight) < 1e-12,
                `${radius} ${positionX},${positionY} ${id}`,
              );
            }
            assert.ok(Math.abs(actual.outline - expected.outline) < 1e-12, `${positionX}`);
            void outline;
          }
        }
      }
    }
  }
});

test("the baked band matches across tile borders with halos", () => {
  const nx = 40;
  const ny = 16;
  const cells = new Uint8Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      cells[row * nx + column] = diagonalId(column, row) === TREE ? TREE : GRASS;
    }
  }
  const radius = 4;
  const band = bakeBand(cells, nx, ny, radius);
  const tiles = textureTiles(nx, ny, 24, WIDE_HALO_CELLS);
  assert.ok(tiles.length > 1);
  const options = { smooth: true, rounding: 0.25, softnessCells: 1, smoothRadiusCells: radius };
  for (const positionX of tiledPositions(nx)) {
    const positionY = 8.5;
    const full = gridFragment(cells, nx, ny, positionX, positionY, 0.001);
    const texel = bandTexelAt(band, nx, positionX, positionY)!;
    const baked = gridFragment(cells, nx, ny, positionX, positionY, 0.001, texel);
    const expected = sampleClassField(full, options);
    const actual = sampleClassField(baked, options);
    assert.ok(
      Math.abs(weightOf(actual, TREE) - weightOf(expected, TREE)) < 1e-12,
      `${positionX}`,
    );
    assert.ok(Math.abs(actual.outline - expected.outline) < 1e-12, `${positionX}`);
  }
  const windowed = windowBand(band, tiles[0].window, nx, ny);
  assert.equal(windowed.ids.length, tiles[0].window.width * tiles[0].window.height * 2);
  assert.equal(
    windowed.ids.length + windowed.low.length * 4 + windowed.high.length * 4,
    tiles[0].window.width * tiles[0].window.height * BAND_BYTES_PER_CELL,
  );
});

function windowBand(
  band: { ids: Uint8Array; low: Uint32Array; high: Uint32Array },
  window: TextureTile["window"],
  nx: number,
  ny: number,
): { ids: Uint8Array; low: Uint32Array; high: Uint32Array } {
  void ny;
  const ids = new Uint8Array(window.width * window.height * 2);
  const low = new Uint32Array(window.width * window.height);
  const high = new Uint32Array(window.width * window.height);
  for (let row = 0; row < window.height; row++) {
    for (let column = 0; column < window.width; column++) {
      const source = (window.row + row) * nx + (window.column + column);
      const target = row * window.width + column;
      ids[target * 2] = band.ids[source * 2];
      ids[target * 2 + 1] = band.ids[source * 2 + 1];
      low[target] = band.low[source];
      high[target] = band.high[source];
    }
  }
  return { ids, low, high };
}

test("the baked band falls back pixel-identical in many-class windows", () => {
  const nx = 16;
  const ny = 16;
  const cells = new Uint8Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      cells[row * nx + column] = overflowId(column - 8, row - 8);
    }
  }
  const band = bakeBand(cells, nx, ny, 2);
  const options = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 2 };
  const full = gridFragment(cells, nx, ny, 8.5, 8.5, 0.0001);
  const texel = bandTexelAt(band, nx, 8.5, 8.5)!;
  assert.ok(isComplexBand(texel));
  const baked = gridFragment(cells, nx, ny, 8.5, 8.5, 0.0001, texel);
  const bakedWeights = sampleClassField(baked, options).weights;
  const fullWeights = sampleClassField(full, options).weights;
  assert.deepEqual(bakedWeights, fullWeights);
  const gapped = new Uint8Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      gapped[row * nx + column] = overflowGappedId(column - 8, row - 8);
    }
  }
  const gappedBand = bakeBand(gapped, nx, ny, 2);
  const gappedTexel = bandTexelAt(gappedBand, nx, 8.5, 8.5)!;
  assert.ok(isComplexBand(gappedTexel));
  const gappedFull = gridFragment(gapped, nx, ny, 8.5, 8.5, 0.0001);
  const gappedBaked = gridFragment(gapped, nx, ny, 8.5, 8.5, 0.0001, gappedTexel);
  assert.deepEqual(
    sampleClassField(gappedBaked, options).weights,
    sampleClassField(gappedFull, options).weights,
  );
});

test("the baked band keeps hatch and outlines identical", () => {
  const nx = 16;
  const ny = 16;
  const cells = new Uint8Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      const id = straightId(column - 8, row - 8);
      cells[row * nx + column] = column - 8 === 0 && row - 8 >= 2 && row - 8 <= 4
        ? CLASS_HATCH_ID
        : id;
    }
  }
  for (const radius of [GEOLOGY_SMOOTH_RADIUS_CELLS, 4]) {
    const band = bakeBand(cells, nx, ny, radius);
    for (const outline of [false, true]) {
      void outline;
      const options = { smooth: true, rounding: 0.25, softnessCells: 1, smoothRadiusCells: radius };
      for (const [positionX, positionY] of [[7.5, 8.5], [8.5, 8.5], [9.5, 10.5]]) {
        const full = gridFragment(cells, nx, ny, positionX, positionY, 0.01);
        const texel = bandTexelAt(band, nx, positionX, positionY)!;
        const baked = gridFragment(cells, nx, ny, positionX, positionY, 0.01, texel);
        const expected = sampleClassField(full, options);
        const actual = sampleClassField(baked, options);
        assert.deepEqual(
          actual.weights.map(({ id }) => id),
          expected.weights.map(({ id }) => id),
          `${radius} ${positionX},${positionY}`,
        );
        assert.ok(Math.abs(actual.outline - expected.outline) < 1e-12, `${positionX}`);
      }
    }
  }
});

test("baking a 1000 x 1000 grid stays fast and reports bounded memory", () => {
  const nx = 1000;
  const ny = 1000;
  const cells = randomCells(nx, ny, 20261107);
  const start = performance.now();
  const band = bakeBand(cells, nx, ny, GEOLOGY_SMOOTH_RADIUS_CELLS);
  const elapsed = performance.now() - start;
  assert.equal(band.ids.length, nx * ny * 2);
  assert.equal(band.low.length, nx * ny);
  assert.ok(elapsed < MAX_BAND_BUILD_MS, `bakeBand took ${elapsed} ms`);
  assert.equal(BAND_BYTES_PER_CELL, 10);
  assert.equal(band.ids.byteLength + band.low.byteLength + band.high.byteLength, nx * ny * 10);
});

test("single cells, pairs, strips and Built-up islands stay visible at their centres", () => {
  for (const radius of [GEOLOGY_SMOOTH_RADIUS_CELLS, 2, 4]) {
    const options = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: radius };
    const centreWins = (cells: Uint8Array, cellX: number, cellY: number, id: number) => {
      const fragment = gridFragment(cells, PATCH, PATCH, cellX, cellY, 0.01);
      const result = sampleClassField(fragment, options);
      assert.equal(strongest(result), id, `${radius} ${cellX},${cellY}`);
    };
    const island = patchGrid((cellX, cellY) => (cellX === 12 && cellY === 12 ? TREE : GRASS));
    centreWins(island, 12, 12, TREE);
    const odd = patchGrid((cellX, cellY) => (cellX === 11 && cellY === 13 ? TREE : GRASS));
    centreWins(odd, 11, 13, TREE);
    const pair = patchGrid((cellX, cellY) => (
      cellX >= 12 && cellX < 14 && cellY >= 12 && cellY < 14 ? TREE : GRASS
    ));
    for (const [cellX, cellY] of [[12, 12], [13, 12], [12, 13], [13, 13]]) {
      centreWins(pair, cellX, cellY, TREE);
    }
    const strip = patchGrid((cellX) => (cellX === 12 ? TREE : GRASS));
    for (const cellY of [4, 12, 19]) centreWins(strip, 12, cellY, TREE);
    const builtUp = patchGrid((cellX, cellY) => (cellX === 15 && cellY === 15 ? 50 : 30));
    centreWins(builtUp, 15, 15, 50);
  }
});

test("the baked band agrees with the full gather at island centres", () => {
  const nx = 16;
  const ny = 16;
  const cells = new Uint8Array(nx * ny).fill(GRASS);
  cells[8 * nx + 8] = TREE;
  const radius = GEOLOGY_SMOOTH_RADIUS_CELLS;
  const band = bakeBand(cells, nx, ny, radius);
  const options = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: radius };
  const full = gridFragment(cells, nx, ny, 8, 8, 0.01);
  const texel = bandTexelAt(band, nx, 8, 8)!;
  const baked = gridFragment(cells, nx, ny, 8, 8, 0.01, texel);
  assert.equal(strongest(sampleClassField(full, options)), TREE);
  assert.equal(strongest(sampleClassField(baked, options)), TREE);
});

test("odd window origins disable the band for large radii only", () => {
  assert.equal(isBandParityMismatched(0, 0, 4), false);
  assert.equal(isBandParityMismatched(2024, 8, 4), false);
  assert.equal(isBandParityMismatched(2025, 8, 4), true);
  assert.equal(isBandParityMismatched(2024, 9, 4), true);
  assert.equal(isBandParityMismatched(2025, 9, 1.5), false);
  assert.equal(isBandParityMismatched(2025, 9, 2), false);
  assert.equal(isBandParityMismatched(1, 0, 4), true);
});

test("skipping homogeneous bases keeps the band identical", () => {
  const nx = 24;
  const ny = 20;
  const cells = randomCells(nx, ny, 4242);
  const radius = GEOLOGY_SMOOTH_RADIUS_CELLS;
  const flags = homogeneousFlags(cells, nx, ny, radius);
  const plain = bakeBand(cells, nx, ny, radius);
  const skipped = bakeBand(cells, nx, ny, radius, flags);
  assert.deepEqual([...skipped.ids], [...plain.ids]);
  assert.deepEqual([...skipped.low], [...plain.low]);
  assert.deepEqual([...skipped.high], [...plain.high]);
});

test("chunked baking matches the whole-grid bake", () => {
  const nx = 40;
  const ny = 33;
  const cells = randomCells(nx, ny, 777);
  const radius = GEOLOGY_SMOOTH_RADIUS_CELLS;
  const flags = homogeneousFlags(cells, nx, ny, radius);
  const whole = bakeBand(cells, nx, ny, radius, flags);
  const count = nx * ny;
  const ids = new Uint8Array(count * 2);
  const low = new Uint32Array(count);
  const high = new Uint32Array(count);
  bakeBandInto(cells, nx, ny, radius, flags, ids, low, high, 0, 10);
  bakeBandInto(cells, nx, ny, radius, flags, ids, low, high, 10, ny);
  assert.deepEqual([...ids], [...whole.ids]);
  assert.deepEqual([...low], [...whole.low]);
  assert.deepEqual([...high], [...whole.high]);
});

test("the plain shader holds no band code outside the bake guard", () => {
  const plain = classFieldFragment(false);
  const baked = classFieldFragment(true);
  const unguarded = plain.replace(/#ifdef BAKE[\s\S]*?#endif\n/g, "");

  assert.ok(!plain.includes("#define BAKE"));
  assert.ok(baked.startsWith("#version 300 es\n#define BAKE\n"));
  assert.ok(!/uBand|uBake|bandIs|gatherBand|gatherBaked/.test(unguarded));
  assert.ok(/uBand/.test(baked));
});

const FROZEN_FINGERPRINTS: [string, number, number, string][] = [
  ["straight", 1.5, 0, "bf2f245"],
  ["straight", 1.5, 1, "68918505"],
  ["straight", 2, 0, "bf2f245"],
  ["straight", 2, 1, "ef256a05"],
  ["straight", 4, 0, "9c15647a"],
  ["straight", 4, 1, "b39dec45"],
  ["convex", 1.5, 0, "251e11ba"],
  ["convex", 1.5, 1, "43de5dc"],
  ["convex", 2, 0, "dc5d2678"],
  ["convex", 2, 1, "923e1b2b"],
  ["convex", 4, 0, "162aaa5a"],
  ["convex", 4, 1, "f65d1274"],
  ["concave", 1.5, 0, "62ddc998"],
  ["concave", 1.5, 1, "816e8131"],
  ["concave", 2, 0, "bb6fa322"],
  ["concave", 2, 1, "cf077e73"],
  ["concave", 4, 0, "39e9180d"],
  ["concave", 4, 1, "8f1e7bfc"],
];

const LARGE_REGIONS: Record<string, (cellX: number, cellY: number) => number> = {
  straight: (cellX) => (cellX < 15 ? TREE : GRASS),
  convex: (cellX, cellY) => (cellX <= 15 && cellY <= 15 ? TREE : GRASS),
  concave: (cellX, cellY) => (cellX <= 15 || cellY <= 15 ? TREE : GRASS),
};

test("large-region edges and corners stay identical to the frozen pre-repair field", () => {
  const size = 30;
  for (const [name, radius, softnessCells, expected] of FROZEN_FINGERPRINTS) {
    const cells = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        cells[row * size + column] = LARGE_REGIONS[name](column, row);
      }
    }
    const flags = thinFlagsOf(cells, size, size);
    assert.ok(flags.every((flag) => flag !== THIN_CELL_FLAG), `${name} has thin cells`);
    const options = { smooth: true, rounding: 0.25, softnessCells, smoothRadiusCells: radius };
    let hash = 2166136261;
    const mix = (value: number) => {
      const scaled = Math.round(value * 1e12);
      for (const part of [scaled % 4294967296, Math.floor(scaled / 4294967296)]) {
        hash = Math.imul(hash ^ (part >>> 0), 16777619) >>> 0;
      }
    };
    for (let positionY = 12; positionY < 18; positionY += 0.25) {
      for (let positionX = 12; positionX < 18; positionX += 0.25) {
        const fragment = gridFragment(cells, size, size, positionX, positionY, 0.001);
        const homogeneous = flags[Math.floor(positionY) * size + Math.floor(positionX)] === 1;
        const result = sampleClassField({ ...fragment, homogeneous }, options);
        mix(result.outline);
        for (const { id, weight } of result.weights) {
          mix(id === TREE ? 1 : 2);
          mix(weight);
        }
      }
    }
    assert.equal(hash.toString(16), expected, `${name} radius ${radius} softness ${softnessCells}`);
  }
});

test("thin cells are the cells outside every uniform 3 x 3 block", () => {
  const nx = 12;
  const ny = 12;
  const cells = new Uint8Array(nx * ny).fill(GRASS);
  cells[5 * nx + 5] = TREE;
  for (let row = 8; row < 11; row++) cells.fill(COVER, row * nx + 8, row * nx + 11);
  cells[0] = CLASS_HATCH_ID;
  const flags = homogeneousFlags(cells, nx, ny, 1.5);
  markThinCells(cells, nx, ny, flags);

  assert.equal(flags[5 * nx + 5], THIN_CELL_FLAG);
  assert.equal(flags[9 * nx + 9], 0);
  assert.equal(flags[8 * nx + 8], 0);
  assert.equal(flags[0], 0);
  assert.equal(flags[9 * nx + 2], 1);
  const strip = new Uint8Array(nx * ny).fill(GRASS);
  for (let row = 0; row < ny; row++) strip[row * nx + 6] = TREE;
  const stripFlags = homogeneousFlags(strip, nx, ny, 1.5);
  markThinCells(strip, nx, ny, stripFlags);
  assert.ok([3, 4, 5].every((row) => stripFlags[row * nx + 6] === THIN_CELL_FLAG));
  assert.equal(stripFlags[5 * nx + 2], 0);
});

test("smoothing leaves no cell of a noisy field hidden", () => {
  const size = 36;
  for (const radius of [GEOLOGY_SMOOTH_RADIUS_CELLS, 2, 4]) {
    for (const softnessCells of [0, 1]) {
      const cells = randomCells(size, size, 7, [TREE, GRASS, COVER]);
      const options = { smooth: true, rounding: 0.25, softnessCells, smoothRadiusCells: radius };
      let hidden = 0;
      for (let cellY = 6; cellY < size - 6; cellY++) {
        for (let cellX = 6; cellX < size - 6; cellX++) {
          if (!winsInsideCell(cells, size, cellX, cellY, options)) hidden++;
        }
      }
      // Three classes within 0.01 of each other at radius 4 are the only ties left hidden.
      const allowed = radius > 2 ? Math.ceil(((size - 12) ** 2) / 200) : 0;
      assert.ok(hidden <= allowed, `${radius} ${softnessCells} hidden ${hidden}`);
    }
  }
});

test("a one-cell strip stays one connected winning strip", () => {
  const strip = patchGrid((cellX) => (cellX === 12 ? TREE : GRASS));
  for (const radius of [GEOLOGY_SMOOTH_RADIUS_CELLS, 2, 4]) {
    const options = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: radius };
    for (let positionY = 6; positionY <= 18; positionY += 0.05) {
      const fragment = gridFragment(strip, PATCH, PATCH, 12, positionY, 0.01);
      const result = sampleClassField(fragment, options);
      assert.equal(strongest(result), TREE, `${radius} y=${positionY}`);
    }
  }
});

test("the repaired weights and gradients are continuous and the gradient is analytic", () => {
  const spur = patchGrid((cellX, cellY) => (
    cellX < 12 || (cellY === 12 && cellX < 18) ? TREE : GRASS
  ));
  const single = patchGrid((cellX, cellY) => (cellX === 12 && cellY === 12 ? TREE : GRASS));
  const step = 1e-6;
  for (const cells of [spur, single]) {
    for (const radius of [GEOLOGY_SMOOTH_RADIUS_CELLS, 4]) {
      const options = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: radius };
      const field = (positionX: number, positionY: number) => (
        gatherFieldClasses(gridFragment(cells, PATCH, PATCH, positionX, positionY, 0.01), options)
          .find(({ id }) => id === TREE) ?? { weight: 0, gradient: [0, 0] }
      );
      for (let positionY = 10.1; positionY < 14; positionY += 0.173) {
        for (let positionX = 10.1; positionX < 20; positionX += 0.317) {
          const here = field(positionX, positionY);
          const slopeX = (field(positionX + step, positionY).weight
            - field(positionX - step, positionY).weight) / (2 * step);
          const slopeY = (field(positionX, positionY + step).weight
            - field(positionX, positionY - step).weight) / (2 * step);
          const label = `${radius} ${positionX},${positionY}`;
          assert.ok(Math.abs(slopeX - here.gradient[0]) < 1e-3, label);
          assert.ok(Math.abs(slopeY - here.gradient[1]) < 1e-3, label);
        }
      }
      for (const border of [11.5, 12, 12.5, 13]) {
        const before = field(border - 1e-7, 12.2);
        const after = field(border + 1e-7, 12.2);
        assert.ok(Math.abs(before.weight - after.weight) < 1e-5, `value ${radius} ${border}`);
        const label = `slope ${radius} ${border}`;
        assert.ok(Math.abs(before.gradient[0] - after.gradient[0]) < 1e-5, label);
        assert.ok(Math.abs(before.gradient[1] - after.gradient[1]) < 1e-5, label);
      }
    }
  }
});

test("outlines come from the repaired field and ring a lifted cell", () => {
  const single = patchGrid((cellX, cellY) => (cellX === 12 && cellY === 12 ? TREE : GRASS));
  const options = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 1.5 };
  let ringInk = 0;
  for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
    for (let radius = 0.2; radius < 0.6; radius += 0.02) {
      const fragment = gridFragment(
        single,
        PATCH,
        PATCH,
        12 + radius * Math.cos(angle),
        12 + radius * Math.sin(angle),
        0.01,
      );
      ringInk = Math.max(ringInk, sampleClassField(fragment, options).outline);
    }
  }
  assert.ok(ringInk > 0.5, `${ringInk}`);
});

test("lifted weights are normalised at odd-parity centres on the full and baked paths", () => {
  const cells = patchGrid((cellX, cellY) => (cellX === 13 && cellY === 11 ? TREE : GRASS));
  for (const radius of [GEOLOGY_SMOOTH_RADIUS_CELLS, 2, 4]) {
    const options = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: radius };
    const band = bakeBand(cells, PATCH, PATCH, radius);
    const full = gridFragment(cells, PATCH, PATCH, 13, 11, 0.01);
    const texel = bandTexelAt(band, PATCH, 13, 11)!;
    const baked = gridFragment(cells, PATCH, PATCH, 13, 11, 0.01, texel);
    for (const fragment of [full, baked]) {
      const result = sampleClassField(fragment, options);
      const total = result.weights.reduce((sum, { weight }) => sum + weight, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `${radius} ${total}`);
      assert.equal(strongest(result), TREE, `${radius}`);
    }
  }
});

test("the lift ignores the order of thin corners", () => {
  const mixed = patchGrid((cellX, cellY) => (
    (cellX + cellY) % 3 === 0 ? TREE : (cellX % 2 ? GRASS : COVER)
  ));
  const options = { smooth: true, rounding: 0.25, softnessCells: 0, smoothRadiusCells: 1.5 };
  for (let positionY = 8.05; positionY < 9; positionY += 0.1) {
    const left = gatherFieldClasses(
      gridFragment(mixed, PATCH, PATCH, 8.9999999, positionY, 0.01),
      options,
    );
    const right = gatherFieldClasses(
      gridFragment(mixed, PATCH, PATCH, 9.0000001, positionY, 0.01),
      options,
    );
    assert.equal(left.length, right.length);
    for (const { id, weight } of left) {
      const other = right.find((entry) => entry.id === id)!;
      assert.ok(Math.abs(other.weight - weight) < 1e-6, `${positionY} ${id}`);
    }
  }
});

function winsInsideCell(
  cells: Uint8Array,
  size: number,
  cellX: number,
  cellY: number,
  options: { smooth: boolean; rounding: number; softnessCells: number; smoothRadiusCells: number },
): boolean {
  const id = cells[cellY * size + cellX];
  for (let offsetY = -0.45; offsetY <= 0.451; offsetY += 0.15) {
    for (let offsetX = -0.45; offsetX <= 0.451; offsetX += 0.15) {
      const result = sampleClassField(
        gridFragment(cells, size, size, cellX + offsetX, cellY + offsetY, 0.001),
        options,
      );
      if (result.nearest === id && strongest(result) === id) return true;
    }
  }
  return false;
}

const MAX_BAND_BUILD_MS = 1500;
const PATCH = 24;

function patchGrid(sample: (cellX: number, cellY: number) => number): Uint8Array {
  const cells = new Uint8Array(PATCH * PATCH);
  for (let row = 0; row < PATCH; row++) {
    for (let column = 0; column < PATCH; column++) {
      cells[row * PATCH + column] = sample(column, row);
    }
  }
  return cells;
}
