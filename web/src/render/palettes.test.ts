import assert from "node:assert/strict";
import { test } from "node:test";

import { classColors, classPaletteOptions } from "./palettes.ts";

const AGE_CLASSES = [
  { value: 1, label: "Quaternary", color: "#f9f97f", group: "Cenozoic" },
  { value: 7, label: "Triassic", color: "#812b92", group: "Mesozoic" },
];

test("the age layer names its only palette after the ICS chart", () => {
  assert.deepEqual(classPaletteOptions("geology_age"), [{ name: "esa", label: "ICS colours" }]);
});

test("age classes keep the ICS colours of the bundle in every palette", () => {
  const expected = new Map([
    [1, [0xf9, 0xf9, 0x7f]],
    [7, [0x81, 0x2b, 0x92]],
  ]);

  assert.deepEqual(classColors("geology_age", AGE_CLASSES, "esa"), expected);
  assert.deepEqual(classColors("geology_age", AGE_CLASSES), expected);
  assert.deepEqual(classColors("geology_age", AGE_CLASSES, "painted"), expected);
});
