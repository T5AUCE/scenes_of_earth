import assert from "node:assert/strict";
import { test } from "node:test";

import type { LayerDoc } from "../types.ts";
import { allocate, BLEND, blendPair, drawOptions, layerDraws } from "./allocate.ts";

const RAIN = layer("rain", ["ramp", "dots", "isolines", "chroma"]);
const TEMP = layer("temp", ["ramp", "isolines", "warmth"]);
const LAND = layer("land", ["fill"], "categorical");
const TERRAIN = layer("terrain", ["shade"], "terrain", ["contours"]);

test("auto gives colour to the isoline layer before the dot layer", () => {
  const allocation = allocate([RAIN, TEMP], on("rain", "temp"), {});

  assert.equal(allocation.owner, "temp");
  assert.equal(allocation.draws.get("temp"), "colour");
  assert.equal(allocation.draws.get("rain"), "dots");
});

test("land cover is hidden when a data layer owns colour", () => {
  const allocation = allocate([LAND, TEMP], on("land", "temp"), {});

  assert.equal(allocation.owner, "temp");
  assert.deepEqual(allocation.draws.get("land"), { hidden: "Shown only in colour" });
});

test("an explicit colour beats the auto rank", () => {
  const allocation = allocate([RAIN, TEMP], on("rain", "temp"), { rain: "colour" });

  assert.equal(allocation.owner, "rain");
  assert.equal(allocation.draws.get("temp"), "isolines");
});

test("an explicit non-colour choice keeps a layer out of the auto rank", () => {
  const allocation = allocate([RAIN, TEMP], on("rain", "temp"), { temp: "isolines" });

  assert.equal(allocation.owner, "rain");
  assert.equal(allocation.draws.get("rain"), "colour");
  assert.equal(allocation.draws.get("temp"), "isolines");
});

test("land cover gets colour when both fields choose non-colour draws", () => {
  const allocation = allocate([LAND, RAIN, TEMP], on("land", "rain", "temp"), {
    rain: "dots",
    temp: "isolines",
  });

  assert.equal(allocation.owner, "land");
  assert.equal(allocation.draws.get("land"), "colour");
  assert.equal(allocation.draws.get("rain"), "dots");
  assert.equal(allocation.draws.get("temp"), "isolines");
});

test("an off explicit owner passes colour to auto meanwhile", () => {
  const allocation = allocate([RAIN, TEMP], on("temp"), { rain: "colour" });

  assert.equal(allocation.owner, "temp");
  assert.equal(allocation.draws.has("rain"), false);
});

test("a blocked fallback is hidden with its reason while colour stays available", () => {
  const blocked = new Map([["rain", "Dots need more zoom"]]);

  const dotted = allocate([RAIN, TEMP], on("rain", "temp"), { temp: "colour" }, blocked);
  assert.deepEqual(dotted.draws.get("rain"), { hidden: "Dots need more zoom" });

  const coloured = allocate([RAIN, TEMP], on("rain", "temp"), { rain: "colour" }, blocked);
  assert.equal(coloured.draws.get("rain"), "colour");
});

test("a categorical layer without a fallback draws only in colour", () => {
  assert.equal(layerDraws(LAND).fallback, null);

  const allocation = allocate([LAND, TEMP], on("land", "temp"), { land: "colour" });
  assert.equal(allocation.draws.get("land"), "colour");
  assert.equal(allocation.draws.get("temp"), "isolines");
  assert.equal(layerDraws(TEMP).fallback, "isolines");
});

test("the fallback follows the encodings order rather than a fixed list", () => {
  const isotherm = layer("isotherm", ["ramp", "mystery", "isolines", "dots"]);

  assert.equal(layerDraws(isotherm).fallback, "isolines");
});

test("drawOptions lists colour then the mounted fallback and nothing for terrain", () => {
  assert.deepEqual(drawOptions(LAND), ["colour"]);
  assert.deepEqual(drawOptions(RAIN), ["colour", "dots"]);
  assert.deepEqual(drawOptions(TEMP), ["colour", "isolines"]);
  assert.deepEqual(drawOptions(TERRAIN), []);
});

test("a field outranks a categorical layer that offers dots", () => {
  const categorical = layer("land", ["fill", "dots"], "categorical");
  const field = layer("field", ["ramp"]);
  const allocation = allocate([categorical, field], on("land", "field"), {});

  assert.equal(allocation.owner, "field");
  assert.equal(allocation.draws.get("land"), "dots");
});

test("hidden land cover leaves the line slots free", () => {
  const isotherm = layer("isotherm", ["ramp", "isolines"]);
  const units = [LAND, RAIN, isotherm, TERRAIN];
  const allocation = allocate(
    units,
    on("land", "rain", "isotherm", "terrain.contours"),
    { rain: "colour" },
  );

  assert.deepEqual(allocation.draws.get("land"), { hidden: "Shown only in colour" });
  assert.equal(allocation.draws.get("isotherm"), "isolines");
  assert.equal(allocation.draws.get("terrain.contours"), "contours");
});

test("contours keep the solid slot while land cover is hidden", () => {
  const units = [LAND, TEMP, TERRAIN];
  const allocation = allocate(
    units,
    on("land", "temp", "terrain.contours"),
    { temp: "colour" },
  );

  assert.equal(allocation.draws.get("temp"), "colour");
  assert.deepEqual(allocation.draws.get("land"), { hidden: "Shown only in colour" });
  assert.equal(allocation.draws.get("terrain.contours"), "contours");
});

test("an extra isoline layer is hidden while contours stay visible", () => {
  const second = layer("second", ["ramp", "isolines"]);
  const allocation = allocate(
    [RAIN, TEMP, second, TERRAIN],
    on("rain", "temp", "second", "terrain.contours"),
    { rain: "colour" },
  );

  assert.equal(allocation.draws.get("temp"), "isolines");
  assert.deepEqual(allocation.draws.get("second"), {
    hidden: "Hidden: the dashed line is in use (isotherms)",
  });
  assert.equal(allocation.draws.get("terrain.contours"), "contours");
});

test("a slot-hidden unit keeps its chosen draw in as", () => {
  const second = layer("second", ["ramp", "isolines"]);
  const allocation = allocate(
    [RAIN, TEMP, second],
    on("rain", "temp", "second"),
    { rain: "colour" },
  );

  assert.equal(allocation.as.get("temp"), "isolines");
  assert.equal(allocation.as.get("second"), "isolines");
  assert.deepEqual(allocation.draws.get("second"), {
    hidden: "Hidden: the dashed line is in use (isotherms)",
  });
});

test("a hidden isoline names the dashed line in use", () => {
  const second = layer("second", ["ramp", "isolines"]);
  const third = layer("third", ["ramp", "isolines"]);
  const allocation = allocate(
    [LAND, TEMP, second, third],
    on("land", "temp", "second", "third"),
    { land: "colour" },
  );

  assert.deepEqual(allocation.draws.get("third"), {
    hidden: "Hidden: the dashed line is in use (isotherms)",
  });
});

test("the blend requires both a chroma and a warmth layer", () => {
  assert.deepEqual(blendPair([RAIN, TEMP]), ["rain", "temp"]);
  assert.equal(blendPair([RAIN]), null);
  assert.equal(blendPair([TEMP]), null);
  assert.equal(allocate([RAIN], on("rain"), { blend: "colour" }).owner, "rain");
});

test("unknown encodings are skipped", () => {
  const unknown = layer("unknown", ["ramp", "vibes"]);
  const isotherm = layer("isotherm", ["ramp", "mystery", "isolines"]);

  assert.deepEqual(layerDraws(unknown), { colour: true, fallback: null, blend: null });
  assert.equal(layerDraws(isotherm).fallback, "isolines");

  const allocation = allocate([unknown, isotherm], on("unknown", "isotherm"), {});
  assert.equal(allocation.owner, "isotherm");
  assert.deepEqual(allocation.draws.get("unknown"), { hidden: "Shown only in colour" });
});

function layer(id: string, encodings: string[], kind = "field", parts?: string[]) {
  return {
    id,
    style: { kind, encodings, ...(parts && { parts }) },
  } as unknown as LayerDoc;
}

function on(...units: string[]) {
  return new Set(units);
}
