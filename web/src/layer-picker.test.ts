import assert from "node:assert/strict";
import { test } from "node:test";

import { commonRange } from "./layer-picker.ts";

test("month range is the overlap of the checked layers only", () => {
  const rain = { step: "P1M", first: "1981-01", last: "2026-08" };
  const temperature = { step: "P1M", first: "2016-01", last: "2026-06" };

  assert.deepEqual(commonRange([rain]), { first: "1981-01", last: "2026-08" });
  assert.deepEqual(commonRange([rain, temperature]), { first: "2016-01", last: "2026-06" });
});

test("no checked time axis leaves the range unset", () => {
  assert.equal(commonRange([]), null);
});
