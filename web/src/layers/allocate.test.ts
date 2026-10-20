import assert from "node:assert/strict";
import { test } from "node:test";

import type { LayerDoc } from "../types.ts";
import { allocate, BLEND, blendPair, layerDraws } from "./allocate.ts";

const RAIN = layer("rain", ["ramp", "dots", "isolines", "chroma"]);
const TEMP = layer("temp", ["ramp", "isolines", "warmth"]);
const LAND = layer("land", ["fill"], "categorical");
const TERRAIN = layer("terrain", ["shade"], "terrain", ["contours"]);

test("auto gives colour to the isoline layer before the dot layer", () => {
  const allocation = allocate([RAIN, TEMP], on("rain", "temp"), null);

  assert.equal(allocation.owner, "temp");
  assert.equal(allocation.draws.get("temp"), "colour");
  assert.equal(allocation.draws.get("rain"), "dots");
});

test("a data layer owns colour over land cover", () => {
  const allocation = allocate([LAND, TEMP], on("land", "temp"), null);

  assert.equal(allocation.owner, "temp");
  assert.equal(allocation.draws.get("land"), "edges");
});

test("a pick beats the auto rank", () => {
  const allocation = allocate([RAIN, TEMP], on("rain", "temp"), "rain");

  assert.equal(allocation.owner, "rain");
  assert.equal(allocation.draws.get("temp"), "isolines");
});

test("an off pick passes colour to the auto rank meanwhile", () => {
  const allocation = allocate([RAIN, TEMP], on("temp"), "rain");

  assert.equal(allocation.owner, "temp");
  assert.equal(allocation.draws.has("rain"), false);
});

test("a categorical layer without a fallback uses edges", () => {
  assert.equal(layerDraws(LAND).fallback, "edges");

  const allocation = allocate([LAND, TEMP], on("land", "temp"), "land");
  assert.equal(allocation.draws.get("temp"), "isolines");
  assert.equal(layerDraws(TEMP).fallback, "isolines");
});

test("the fallback follows the encodings order rather than a fixed list", () => {
  const isotherm = layer("isotherm", ["ramp", "mystery", "isolines", "dots"]);

  assert.equal(layerDraws(isotherm).fallback, "isolines");
});

test("a field outranks a categorical layer that offers dots", () => {
  const categorical = layer("land", ["fill", "dots"], "categorical");
  const field = layer("field", ["ramp"]);
  const allocation = allocate([categorical, field], on("land", "field"), null);

  assert.equal(allocation.owner, "field");
  assert.equal(allocation.draws.get("land"), "dots");
});

test("land-cover outlines use no line slot", () => {
  const isotherm = layer("isotherm", ["ramp", "isolines"]);
  const units = [LAND, RAIN, isotherm, TERRAIN];
  const allocation = allocate(
    units,
    on("land", "rain", "isotherm", "terrain.contours"),
    "rain",
  );

  assert.equal(allocation.draws.get("land"), "edges");
  assert.equal(allocation.draws.get("isotherm"), "isolines");
  assert.equal(allocation.draws.get("terrain.contours"), "contours");
});

test("contours keep the solid slot with land-cover outlines", () => {
  const units = [LAND, TEMP, TERRAIN];
  const allocation = allocate(units, on("land", "temp", "terrain.contours"), "temp");

  assert.equal(allocation.draws.get("temp"), "colour");
  assert.equal(allocation.draws.get("land"), "edges");
  assert.equal(allocation.draws.get("terrain.contours"), "contours");
});

test("an extra isoline layer is hidden while contours stay visible", () => {
  const second = layer("second", ["ramp", "isolines"]);
  const allocation = allocate(
    [RAIN, TEMP, second, TERRAIN],
    on("rain", "temp", "second", "terrain.contours"),
    "rain",
  );

  assert.equal(allocation.draws.get("temp"), "isolines");
  assert.deepEqual(allocation.draws.get("second"), {
    hidden: "Hidden: the dashed line is in use (isotherms)",
  });
  assert.equal(allocation.draws.get("terrain.contours"), "contours");
});

test("a hidden isoline names the dashed line in use", () => {
  const second = layer("second", ["ramp", "isolines"]);
  const third = layer("third", ["ramp", "isolines"]);
  const allocation = allocate(
    [LAND, TEMP, second, third],
    on("land", "temp", "second", "third"),
    "land",
  );

  assert.deepEqual(allocation.draws.get("third"), {
    hidden: "Hidden: the dashed line is in use (isotherms)",
  });
});

test("the blend requires both a chroma and a warmth layer", () => {
  assert.deepEqual(blendPair([RAIN, TEMP]), ["rain", "temp"]);
  assert.equal(blendPair([RAIN]), null);
  assert.equal(blendPair([TEMP]), null);
  assert.equal(allocate([RAIN], on("rain"), BLEND).owner, "rain");
});

test("unknown encodings are skipped", () => {
  const unknown = layer("unknown", ["ramp", "vibes"]);
  const isotherm = layer("isotherm", ["ramp", "mystery", "isolines"]);

  assert.deepEqual(layerDraws(unknown), { colour: true, fallback: null, blend: null });
  assert.equal(layerDraws(isotherm).fallback, "isolines");

  const allocation = allocate([unknown, isotherm], on("unknown", "isotherm"), null);
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
