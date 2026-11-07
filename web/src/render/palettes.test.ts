import assert from "node:assert/strict";
import { test } from "node:test";

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
