import assert from "node:assert/strict";
import { test } from "node:test";

import { rgbToOklch } from "./colormap.ts";
import {
  classColors,
  classPaletteOptions,
  customColors,
  customPalette,
  customStops,
  fieldGradient,
  fieldStops,
} from "./palettes.ts";

const AGE_CLASSES = [
  { value: 1, label: "Quaternary", color: "#f9f97f", group: "Cenozoic" },
  { value: 7, label: "Triassic", color: "#812b92", group: "Mesozoic" },
];

test("legacy even custom names still parse to evenly spaced stops", () => {
  const stops = customStops("custom-000000-ffffff")!;

  assert.equal(stops.length, 2);
  assert.deepEqual(stops.map(({ at }) => at), [0, 1]);
  assert.deepEqual(customColors("custom-000000-ffffff"), ["#000000", "#ffffff"]);
  assert.deepEqual(fieldGradient("custom-000000-ffffff"), [[0, 0, 0], [255, 255, 255]]);
});

test("positioned custom names parse with integer percents in non-decreasing order", () => {
  const stops = customStops("custom-447dc4_0-189d73_50-618d63_80-cf764c_100")!;

  assert.deepEqual(stops.map(({ at }) => at), [0, 0.5, 0.8, 1]);
  assert.deepEqual(customColors("custom-447dc4_0-189d73_50-618d63_80-cf764c_100"), [
    "#447dc4",
    "#189d73",
    "#618d63",
    "#cf764c",
  ]);
});

test("custom names reject mixed, unordered or out-of-range positions", () => {
  const bad = [
    "custom-000000-ffffff_50",
    "custom-000000_50-ffffff_40",
    "custom-000000_101-ffffff_100",
    "custom-000000",
    "custom-000000-ffffff-000000-ffffff-000000-ffffff-000000-ffffff-000000",
    "custom-00000g-ffffff",
    "custom-000000-FFFFff",
  ];
  for (const name of bad) assert.equal(customStops(name), null, name);
  assert.equal(customStops("custom-000000_0-000000_0-ffffff_100")!.length, 3);
});

test("custom names canonically omit positions when the stops sit evenly", () => {
  const even = [
    { at: 0, rgb: [0, 0, 0] },
    { at: 0.5, rgb: [136, 136, 136] },
    { at: 1, rgb: [255, 255, 255] },
  ];

  assert.equal(customPalette(even), "custom-000000-888888-ffffff");
  assert.equal(
    customPalette([{ at: 0, rgb: [0, 0, 0] }, { at: 0.4, rgb: [255, 255, 255] }]),
    "custom-000000_0-ffffff_40",
  );
  assert.equal(customPalette(customStops("custom-000000-ffffff")!), "custom-000000-ffffff");
});

test("built-in gradients expose even stops while unknown names stay unknown", () => {
  const stops = fieldStops("ink-blue")!;

  assert.equal(stops.length, 9);
  assert.deepEqual(stops.map(({ at }) => at), stops.map((_, index) => index / 8));
  assert.deepEqual(fieldStops("custom-000000_0-ffffff_100")!.map(({ at }) => at), [0, 1]);
  assert.equal(fieldStops("nope"), undefined);
  assert.equal(fieldGradient("nope"), undefined);
});

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
