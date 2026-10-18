import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTime, latestOnly, scrubberTimes, stepAt, unionTimes } from "./timeline.ts";

const monthly = ["2020-01-01", "2020-02-01", "2020-03-01"];
const monthlyEnd = "2020-04-01";
const sixteenDay = ["2020-01-01", "2020-01-17", "2020-02-02", "2020-02-18"];

test("union of a monthly and a 16-day axis is sorted without duplicates", () => {
  assert.deepEqual(unionTimes([monthly, sixteenDay]), [
    "2020-01-01",
    "2020-01-17",
    "2020-02-01",
    "2020-02-02",
    "2020-02-18",
    "2020-03-01",
  ]);
});

test("a layer holds its last step until the next one starts", () => {
  assert.equal(stepAt(monthly, monthlyEnd, "2020-02-01"), 1);
  assert.equal(stepAt(monthly, monthlyEnd, "2020-02-18"), 1);
  assert.equal(stepAt(sixteenDay, "2020-03-05", "2020-02-01"), 1);
});

test("a five-year step holds until its period ends", () => {
  const fiveYearly = ["2015-01-01", "2020-01-01"];

  assert.equal(stepAt(fiveYearly, "2025-01-01", "2024-12-31"), 1);
  assert.equal(stepAt(fiveYearly, "2025-01-01", "2025-01-01"), -1);
});

test("a time outside the axis gives no step", () => {
  assert.equal(stepAt(monthly, monthlyEnd, "2019-12-31"), -1);
  assert.equal(stepAt(monthly, monthlyEnd, "2020-04-01"), -1);
  assert.equal(stepAt([], "2020-01-01", "2020-01-01"), -1);
});

test("the scrubber starts at the period start when a coarse layer began earlier", () => {
  const fiveYearly = ["2015-01-01", "2020-01-01"];
  const period = { start: "2019-01-01", end: "2021-01-01" };
  const monthlyRain = ["2019-01-01", "2019-02-01", "2019-03-01"];

  assert.deepEqual(scrubberTimes([fiveYearly, monthlyRain], period), [
    "2019-01-01",
    "2019-02-01",
    "2019-03-01",
    "2020-01-01",
  ]);
});

test("labels show only as much date as the finest step needs", () => {
  assert.equal(formatTime("2020-02-01", ["P1M"]), "2020-02");
  assert.equal(formatTime("2020-02-01", ["P1M", "P16D"]), "2020-02-01");
  assert.equal(formatTime("2020-01-01", ["P5Y"]), "2020");
});

test("while a step is loading, only the latest later step is loaded", async () => {
  const loaded: number[] = [];
  let finishFirst: () => void = () => {};
  const draw = latestOnly(async (step: number) => {
    loaded.push(step);
    if (step === 0) await new Promise<void>((resolve) => (finishFirst = resolve));
  });

  const firstRun = draw(0);
  draw(1);
  draw(2);
  draw(3);
  finishFirst();
  await firstRun;

  assert.deepEqual(loaded, [0, 3]);
});

test("steps given one after another are each loaded", async () => {
  const loaded: number[] = [];
  const draw = latestOnly(async (step: number) => {
    loaded.push(step);
  });

  await draw(1);
  await draw(2);

  assert.deepEqual(loaded, [1, 2]);
});
