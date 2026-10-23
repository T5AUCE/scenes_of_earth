import assert from "node:assert/strict";
import { test } from "node:test";

import {
  controlDisplay,
  DEFAULT_LAYOUT_VIEWPORTS_PX,
  hitLabel,
  LAYOUT_CONTROLS,
  LAYOUT_EDITOR,
  layoutFailed,
  layoutRecord,
  layoutViewports,
  parseViewportList,
  requiredInState,
  viewportLabel,
} from "./layout.mjs";

test("parseViewportList reads viewports with surrounding spaces", () => {
  assert.deepEqual(parseViewportList("320x800, 320x560,1280x800"), [
    { width: 320, height: 800 },
    { width: 320, height: 560 },
    { width: 1280, height: 800 },
  ]);
});

test("parseViewportList names the bad entry", () => {
  for (const text of ["", "320", "320x", "x800", "0x800", "320x0", "99999x800", "axb"]) {
    assert.throws(() => parseViewportList(text), new RegExp(`bad viewport "${text}"`));
  }
  assert.throws(() => parseViewportList("320x800,wide"), /bad viewport "wide"/);
});

test("layoutViewports defaults without an override and reads one", () => {
  assert.equal(layoutViewports({}), DEFAULT_LAYOUT_VIEWPORTS_PX);
  assert.equal(layoutViewports({ SOE_LAYOUT_VIEWPORTS: "" }), DEFAULT_LAYOUT_VIEWPORTS_PX);
  assert.deepEqual(
    layoutViewports({ SOE_LAYOUT_VIEWPORTS: "320x560" }),
    [{ width: 320, height: 560 }],
  );
});

test("the control list matches roles with names and scopes the slider", () => {
  const roles = new Set(["button", "switch", "slider", "radio", "link", "page"]);

  assert.ok(LAYOUT_CONTROLS.length > 10);
  for (const control of LAYOUT_CONTROLS) {
    assert.ok(roles.has(control.role), `unexpected role ${control.role}`);
    assert.ok(typeof control.name === "string" || control.name instanceof RegExp);
    assert.ok(control.when === undefined || ["open", "closed", "both"].includes(control.when));
    assert.ok(control.optional === undefined || control.optional === true);
  }
  const slider = LAYOUT_CONTROLS.find((control) => control.role === "slider");
  assert.equal(slider.scope, "#time-bar");
  assert.ok(LAYOUT_CONTROLS.includes(LAYOUT_EDITOR));
  assert.ok(LAYOUT_CONTROLS.some((control) => control.name === "Play"));
  assert.ok(LAYOUT_CONTROLS.some((control) => control.name === "Close"));
  assert.ok(LAYOUT_CONTROLS.some((control) => control.name === "Expand"));
});

test("the Rainfall entries skip the blend card but keep suffixed cards", () => {
  const edit = LAYOUT_CONTROLS.find((control) => control === LAYOUT_EDITOR);
  const toggle = LAYOUT_CONTROLS.find(
    (control) => control.role === "switch" && controlDisplay(control).startsWith("^Show Rainfall"),
  );

  assert.equal(edit.name.test("Edit Rainfall · Dots"), true);
  assert.equal(edit.name.test("Edit Rainfall + temperature (blended) · Colour"), false);
  assert.equal(toggle.name.test("Show Rainfall · Colour"), true);
  assert.equal(toggle.name.test("Show Rainfall + temperature (blended) · Colour"), false);
});

test("requiredInState expects editor-only entries while the editor is open", () => {
  const units = LAYOUT_CONTROLS.find((control) => control.name === "mm/month");
  const expand = LAYOUT_CONTROLS.find((control) => control.name === "Expand");

  assert.equal(requiredInState({ role: "button", name: "Play" }, "closed"), true);
  assert.equal(requiredInState({ role: "button", name: "Play" }, "open"), true);
  assert.equal(requiredInState(units, "closed"), false);
  assert.equal(requiredInState(units, "open"), true);
  assert.equal(requiredInState(expand, "closed"), false);
  assert.equal(requiredInState(expand, "open"), false);
});

test("controlDisplay keeps strings and unwraps patterns", () => {
  assert.equal(controlDisplay({ role: "button", name: "Play" }), "Play");
  assert.equal(controlDisplay(LAYOUT_EDITOR), "^Edit Rainfall(?: ·|$)");
});

test("viewportLabel renders the WxH text records carry", () => {
  assert.equal(viewportLabel({ width: 320, height: 800 }), "320x800");
});

test("hitLabel renders a short selector with clipped text", () => {
  assert.equal(
    hitLabel({ tag: "a", id: null, classes: ["maplibregl-ctrl-attrib"], text: "© OpenMapTiles" }),
    "a.maplibregl-ctrl-attrib \"© OpenMapTiles\"",
  );
  assert.equal(hitLabel({ tag: "div", id: "map", classes: [], text: "" }), "div#map");
  assert.equal(hitLabel(null), null);
});

test("layoutRecord shapes a passing hit-test with its interceptor", () => {
  const record = layoutRecord({
    viewport: { width: 320, height: 800 },
    editor: "closed",
    role: "button",
    name: "Play",
    present: true,
    pass: false,
    hit: { tag: "a", id: null, classes: [], text: "OpenFreeMap" },
  });

  assert.deepEqual(record, {
    viewport: "320x800",
    editor: "closed",
    role: "button",
    name: "Play",
    present: true,
    pass: false,
    hit: "a \"OpenFreeMap\"",
  });
});

test("layoutRecord keeps an explicit absent pass and nulls its hit", () => {
  const missing = layoutRecord({
    viewport: { width: 1280, height: 800 },
    editor: "open",
    role: "radio",
    name: "mm/month",
    present: false,
    pass: false,
    hit: { tag: "aside", id: null, classes: ["layer-editor"], text: "" },
  });
  const skipped = layoutRecord({
    viewport: { width: 1280, height: 800 },
    editor: "closed",
    role: "radio",
    name: "mm/month",
    present: false,
    pass: null,
    hit: null,
  });

  assert.equal(missing.present, false);
  assert.equal(missing.pass, false);
  assert.equal(missing.hit, null);
  assert.equal(skipped.pass, null);
});

test("layoutFailed fails on any explicit failure", () => {
  const viewport = { width: 320, height: 800 };
  const passing = {
    viewport,
    editor: "closed",
    role: "page",
    name: "ok",
    present: true,
    pass: true,
  };
  const failing = { ...passing, pass: false };
  const missing = { ...passing, present: false, pass: false };
  const skipped = { ...passing, present: false, pass: null };

  assert.equal(layoutFailed([]), false);
  assert.equal(layoutFailed([passing]), false);
  assert.equal(layoutFailed([skipped]), false);
  assert.equal(layoutFailed([passing, failing, skipped]), true);
  assert.equal(layoutFailed([missing]), true);
});

test("layoutFailed ignores contour records without a present flag", () => {
  assert.equal(layoutFailed([{ spot: "Nairobi", timed_out: false }]), false);
  assert.equal(
    layoutFailed([
      { spot: "Nairobi", timed_out: false },
      { viewport: "320x800", editor: "closed", present: true, pass: false },
    ]),
    true,
  );
});
