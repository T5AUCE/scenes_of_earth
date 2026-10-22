import assert from "node:assert/strict";
import { test } from "node:test";

import { cardTitle, drawLabel, showAsLabel } from "./card-title.ts";
import type { LayerDoc } from "./types.ts";

const RAIN = layer("Rainfall", "mm/month");
const TEMPERATURE = layer("Temperature", "°C");
const OTHER = layer("Wind", "m/s");

test("a dotted layer says that it is smoothed while the option applies", () => {
  assert.equal(
    cardTitle(RAIN, { draw: "dots", off: false, smoothed: true }),
    "Rainfall · Dots, Smoothed",
  );
  assert.equal(cardTitle(RAIN, { draw: "dots", off: false }), "Rainfall · Dots");
});

test("a temperature field names its lines isotherms and other fields name them lines", () => {
  assert.equal(
    cardTitle(TEMPERATURE, { draw: "isolines", off: false }),
    "Temperature · Isotherms",
  );
  assert.equal(cardTitle(OTHER, { draw: "isolines", off: false }), "Wind · Lines");
});

test("colour, contours and relief keep their plain names", () => {
  assert.equal(cardTitle(RAIN, { draw: "colour", off: false }), "Rainfall · Colour");
  assert.equal(cardTitle(OTHER, { draw: "contours", off: false }), "Wind · Contours");
  assert.equal(cardTitle(OTHER, { draw: "shade", off: false }), "Wind · Relief");
});

test("a layer hidden by colour reads hidden", () => {
  assert.equal(
    cardTitle({ title: "Land cover", units: "" }, {
      draw: { hidden: "Shown only in colour" },
      off: false,
    }),
    "Land cover · Hidden",
  );
});

test("a layer stopped by a slot conflict keeps its reason in the title", () => {
  assert.equal(
    cardTitle(TEMPERATURE, {
      draw: { hidden: "Hidden: the dashed line is in use (isotherms)" },
      off: false,
    }),
    "Temperature · Hidden (Hidden: the dashed line is in use (isotherms))",
  );
});

test("a switched-off layer reads off whatever it would draw", () => {
  assert.equal(
    cardTitle(RAIN, { draw: "dots", off: true, smoothed: true }),
    "Rainfall · Off",
  );
});

test("a multi-part layer with no draw names the parts that are on", () => {
  const terrain = layer("Terrain", "");
  assert.equal(
    cardTitle(terrain, { draw: undefined, off: false, parts: ["relief", "contours"] }),
    "Terrain · Relief, Contours",
  );
  assert.equal(
    cardTitle(terrain, { draw: undefined, off: false, parts: ["relief"] }),
    "Terrain · Relief",
  );
  assert.equal(
    cardTitle(terrain, { draw: undefined, off: false, parts: ["contours"] }),
    "Terrain · Contours",
  );
});

test("a multi-part layer with no parts on reads off", () => {
  const terrain = layer("Terrain", "");
  assert.equal(cardTitle(terrain, { draw: undefined, off: false, parts: [] }), "Terrain · Off");
  assert.equal(
    cardTitle(terrain, { draw: undefined, off: true, parts: ["relief"] }),
    "Terrain · Off",
  );
});

test("a layer with no draw and no parts keeps its plain title", () => {
  assert.equal(cardTitle(layer("Terrain", ""), { draw: undefined, off: false }), "Terrain");
});

test("draw labels stand alone for card titles", () => {
  assert.equal(drawLabel("colour", RAIN), "colour");
  assert.equal(drawLabel("isolines", TEMPERATURE), "isotherms");
  assert.equal(drawLabel("isolines", RAIN), "lines");
  assert.equal(drawLabel("shade", RAIN), "relief");
});

test("Show as tabs name temperature isolines Isotherms", () => {
  assert.equal(showAsLabel("colour", RAIN), "Colour");
  assert.equal(showAsLabel("dots", RAIN), "Dots");
  assert.equal(showAsLabel("isolines", TEMPERATURE), "Isotherms");
  assert.equal(showAsLabel("isolines", RAIN), "Lines");
  assert.equal(showAsLabel("contours", RAIN), "Contours");
  assert.equal(showAsLabel("shade", RAIN), "Relief");
});

function layer(title: string, units: string): LayerDoc {
  return { title, units } as LayerDoc;
}
