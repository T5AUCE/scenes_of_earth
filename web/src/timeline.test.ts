import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTime, stepAt, unionTimes } from "./timeline.ts";

const monthly = ["2020-01-01", "2020-02-01", "2020-03-01"];
const sixteenDay = ["2020-01-01", "2020-01-17", "2020-02-02", "2020-02-18"];

test("union of a monthly and a 16-day axis is sorted without duplicates", () => {
  assert.deepEqual(unionTimes([monthly, sixteenDay]), [
    "2020-01-01", "2020-01-17", "2020-02-01", "2020-02-02", "2020-02-18", "2020-03-01",
  ]);
});

test("a layer holds its last step until the next one starts", () => {
  assert.equal(stepAt(monthly, "2020-02-01"), 1);
  assert.equal(stepAt(monthly, "2020-02-18"), 1);
  assert.equal(stepAt(sixteenDay, "2020-02-01"), 1);
});

test("a time outside the axis gives no step", () => {
  assert.equal(stepAt(monthly, "2019-12-31"), -1);
  assert.equal(stepAt(monthly, "2020-03-02"), -1);
  assert.equal(stepAt([], "2020-01-01"), -1);
});

test("labels show only as much date as the finest step needs", () => {
  assert.equal(formatTime("2020-02-01", ["P1M"]), "2020-02");
  assert.equal(formatTime("2020-02-01", ["P1M", "P16D"]), "2020-02-01");
  assert.equal(formatTime("2020-01-01", ["P5Y"]), "2020");
});
