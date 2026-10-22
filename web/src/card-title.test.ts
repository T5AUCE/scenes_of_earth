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
    "Rainfall · dots, smoothed",
  );
  assert.equal(cardTitle(RAIN, { draw: "dots", off: false }), "Rainfall · dots");
});

test("a temperature field names its lines isotherms and other fields name them lines", () => {
  assert.equal(
    cardTitle(TEMPERATURE, { draw: "isolines", off: false }),
    "Temperature · isotherms",
  );
  assert.equal(cardTitle(OTHER, { draw: "isolines", off: false }), "Wind · lines");
});

test("colour, contours and relief keep their plain names", () => {
  assert.equal(cardTitle(RAIN, { draw: "colour", off: false }), "Rainfall · colour");
  assert.equal(cardTitle(OTHER, { draw: "contours", off: false }), "Wind · contours");
  assert.equal(cardTitle(OTHER, { draw: "shade", off: false }), "Wind · relief");
});

test("a hidden layer names colour ownership as the reason", () => {
  assert.equal(
    cardTitle({ title: "Land cover", units: "" }, {
      draw: { hidden: "Shown only in colour" },
      off: false,
    }),
    "Land cover · hidden while another layer uses colour",
  );
});

test("a layer stopped by a slot conflict keeps its reason in the title", () => {
  assert.equal(
    cardTitle(TEMPERATURE, {
      draw: { hidden: "Hidden: the dashed line is in use (isotherms)" },
      off: false,
    }),
    "Temperature · hidden (Hidden: the dashed line is in use (isotherms))",
  );
});

test("a switched-off layer reads off whatever it would draw", () => {
  assert.equal(
    cardTitle(RAIN, { draw: "dots", off: true, smoothed: true }),
    "Rainfall · off",
  );
});

test("draw labels stand alone for card titles", () => {
  assert.equal(drawLabel("colour", RAIN), "colour");
  assert.equal(drawLabel("isolines", TEMPERATURE), "isotherms");
  assert.equal(drawLabel("isolines", RAIN), "lines");
  assert.equal(drawLabel("shade", RAIN), "relief");
});

test("Show as radios stay layer-agnostic", () => {
  assert.equal(showAsLabel("colour"), "Colour");
  assert.equal(showAsLabel("dots"), "Dots");
  assert.equal(showAsLabel("isolines"), "Lines");
});

function layer(title: string, units: string): LayerDoc {
  return { title, units } as LayerDoc;
}
