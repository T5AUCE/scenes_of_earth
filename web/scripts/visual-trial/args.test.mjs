import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPlaces, loadPlaces, parseArgs } from "./args.mjs";

test("parseArgs reads flags and the places argument", () => {
  const options = parseArgs(["contours", "--start", "--screens", "--out", "x", "--parallel", "2"]);

  assert.deepEqual(options, {
    places: "contours",
    start: true,
    app: null,
    out: "x",
    screens: true,
    parallel: 2,
  });
});

test("parseArgs needs exactly one of --start and --app", () => {
  assert.throws(() => parseArgs(["contours"]), /exactly one/);
  assert.throws(() => parseArgs(["contours", "--start", "--app", "http://x"]), /exactly one/);
  assert.equal(parseArgs(["contours", "--app", "http://x"]).app, "http://x");
});

test("parseArgs rejects unknown flags and a missing places argument", () => {
  assert.throws(() => parseArgs(["--start"]), /usage/);
  assert.throws(() => parseArgs(["a", "--start", "--bogus"]), /unexpected/);
});

test("checkPlaces fills defaults and rejects bad spots", () => {
  const [spot] = checkPlaces({ spots: [{ name: "A", area: "sample:a", centre: [1, 2] }] });

  assert.deepEqual(spot.zooms, ["fitted"]);
  assert.deepEqual(spot.layers, ["terrain"]);
  assert.throws(() => checkPlaces({ spots: [{ name: "A", area: "x", centre: [1] }] }), /centre/);
  assert.throws(
    () => checkPlaces({ spots: [{ name: "A", area: "x", centre: [1, 2], zooms: ["a"] }] }),
    /zooms/,
  );
});

test("the contours preset loads", () => {
  const spots = loadPlaces("contours");

  assert.ok(spots.length >= 3);
});
