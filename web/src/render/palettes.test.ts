import assert from "node:assert/strict";
import { test } from "node:test";

import { rgbToOklch } from "./colormap.ts";
import { classColors, classPaletteOptions } from "./palettes.ts";

const AGE_CLASSES = [
  { value: 1, label: "Quaternary", color: "#f9f97f", group: "Cenozoic" },
  { value: 7, label: "Triassic", color: "#812b92", group: "Mesozoic" },
];

test("the age layer offers painted colours first and the ICS chart second", () => {
  assert.deepEqual(classPaletteOptions("geology_age"), [
    { name: "painted", label: "Painted" },
    { name: "esa", label: "ICS colours" },
  ]);
});

test("age classes keep the ICS colours of the bundle unless painted is chosen", () => {
  const expected = new Map([
    [1, [0xf9, 0xf9, 0x7f]],
    [7, [0x81, 0x2b, 0x92]],
  ]);

  assert.deepEqual(classColors("geology_age", AGE_CLASSES, "esa"), expected);
  assert.deepEqual(classColors("geology_age", AGE_CLASSES), expected);
  assert.deepEqual(
    classColors("geology_age", AGE_CLASSES, "painted"),
    new Map([
      [1, [0xf4, 0xef, 0xb6]],
      [7, [0x8b, 0x63, 0x90]],
    ]),
  );
});

const SILICICLASTIC_VARIANTS = [
  { value: 11, label: "Siliciclastic, mixed grain", color: "#e8c33c", parent: "ss", variant: 0 },
  { value: 12, label: "Siliciclastic, coarse grain", color: "#e8c33c", parent: "ss", variant: 1 },
  { value: 13, label: "Siliciclastic, fine grain", color: "#e8c33c", parent: "ss", variant: 2 },
];

const UNCONSOLIDATED_VARIANTS = [0, 1, 2, 5, 8].map((variant) => ({
  value: variant,
  label: `Unconsolidated ${variant}`,
  color: "#fdf0a8",
  parent: "su",
  variant,
}));

/** Sibling variants stay at least this far apart in OKLab, above the 0.02 test floor. */
const MIN_SIBLING_OKLAB_DISTANCE = 0.03;

function oklabOf(rgb: number[]): [number, number, number] {
  const { lightness, chroma, hue } = rgbToOklch(rgb);
  const angle = (hue * Math.PI) / 180;
  return [lightness, chroma * Math.cos(angle), chroma * Math.sin(angle)];
}

function pairwiseDistances(rgbs: number[][]) {
  const labs = rgbs.map(oklabOf);
  const distances = [];
  for (let first = 0; first < labs.length; first++) {
    for (let second = first + 1; second < labs.length; second++) {
      distances.push(
        Math.hypot(
          labs[first][0] - labs[second][0],
          labs[first][1] - labs[second][1],
          labs[first][2] - labs[second][2],
        ),
      );
    }
  }
  return distances;
}

test("siliciclastic coarse, fine and mixed grains differ by a minimum colour distance", () => {
  const rgbs = [...classColors("geology", SILICICLASTIC_VARIANTS, "painted").values()].map(
    (rgb) => rgb!,
  );

  assert.equal(new Set(rgbs.map((rgb) => rgb.join(","))).size, rgbs.length);
  for (const distance of pairwiseDistances(rgbs)) {
    assert.ok(distance > MIN_SIBLING_OKLAB_DISTANCE, `distance ${distance}`);
  }
});

test("unconsolidated mixed, coarse, fine, alluvial and loess differ by a minimum distance", () => {
  const rgbs = [...classColors("geology", UNCONSOLIDATED_VARIANTS, "painted").values()].map(
    (rgb) => rgb!,
  );

  assert.equal(new Set(rgbs.map((rgb) => rgb.join(","))).size, rgbs.length);
  for (const distance of pairwiseDistances(rgbs)) {
    assert.ok(distance > MIN_SIBLING_OKLAB_DISTANCE, `distance ${distance}`);
  }
});
