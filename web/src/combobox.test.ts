import assert from "node:assert/strict";
import { test } from "node:test";

import { nextOptionIndex } from "./combobox.ts";

test("arrow down starts at the first option and wraps after the last", () => {
  assert.equal(nextOptionIndex("ArrowDown", -1, 3), 0);
  assert.equal(nextOptionIndex("ArrowDown", 1, 3), 2);
  assert.equal(nextOptionIndex("ArrowDown", 2, 3), 0);
});

test("arrow up starts at the last option and wraps before the first", () => {
  assert.equal(nextOptionIndex("ArrowUp", -1, 3), 2);
  assert.equal(nextOptionIndex("ArrowUp", 0, 3), 2);
  assert.equal(nextOptionIndex("ArrowUp", 2, 3), 1);
});

test("other keys and an empty list leave the position alone", () => {
  assert.equal(nextOptionIndex("a", 1, 3), 1);
  assert.equal(nextOptionIndex("ArrowDown", 0, 0), -1);
});
