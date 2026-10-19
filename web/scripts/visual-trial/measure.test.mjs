import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyFailure,
  contourLegend,
  nearestPx,
  pickArea,
  sameSample,
  slug,
  viewRecord,
} from "./measure.mjs";

test("nearestPx measures to the closest point of a segment, not only its ends", () => {
  const line = [
    [0, 10],
    [100, 10],
  ];

  assert.equal(nearestPx([line], [50, 0]), 10);
  assert.equal(nearestPx([line], [130, 10]), 30);
});

test("nearestPx picks the closest of several lines and tolerates single points", () => {
  const far = [
    [0, 200],
    [10, 200],
  ];

  assert.equal(nearestPx([far, [[3, 4]]], [0, 0]), 5);
  assert.equal(nearestPx([], [0, 0]), null);
});

test("pickArea prefers an id match, then a name match, then the first hit", () => {
  const hits = [
    { id: "a", name: "Nairobi County" },
    { id: "sample:nairobi", name: "Nairobi" },
  ];

  assert.equal(pickArea(hits, "sample:nairobi").id, "sample:nairobi");
  assert.equal(pickArea(hits, "nairobi").id, "sample:nairobi");
  assert.equal(pickArea(hits, "Nairo").id, "a");
  assert.equal(pickArea([], "x"), null);
});

test("classifyFailure separates Mapterhorn, glyph and other requests", () => {
  assert.equal(classifyFailure("https://tiles.mapterhorn.com/6/63/36.webp"), "dem");
  assert.equal(
    classifyFailure("https://tiles.openfreemap.org/fonts/Open%20Sans/0-255.pbf"),
    "glyph",
  );
  assert.equal(classifyFailure("http://127.0.0.1:5173/scenes/x/data.zarr/zarr.json"), "other");
});

test("contourLegend returns only the contour line", () => {
  const text = "Rainfall\nContours every 100 m (bold every 500 m)\nmm";

  assert.equal(contourLegend(text), "Contours every 100 m (bold every 500 m)");
  assert.equal(contourLegend("Rainfall"), null);
});

test("sameSample is false without a previous sample", () => {
  assert.equal(sameSample(null, { labelCount: 1 }), false);
  assert.equal(sameSample({ labelCount: 1 }, { labelCount: 1 }), true);
  assert.equal(sameSample({ labelCount: 1 }, { labelCount: 2 }), false);
});

test("slug keeps file names simple", () => {
  assert.equal(slug("Viti Levu (Sigatoka valley)"), "viti-levu-sigatoka-valley");
});

test("viewRecord counts failures by kind and lists each message once", () => {
  const sample = {
    zoom: 12.0004,
    centre: [640, 400],
    labelCount: 2,
    labelLines: [
      [
        [640, 450],
        [700, 450],
      ],
    ],
    lineCount: 40,
    tilesLoaded: true,
    legend: "Contours every 10 m",
  };
  const failures = [{ kind: "dem" }, { kind: "dem" }, { kind: "glyph" }, { kind: "other" }];

  const record = viewRecord({
    spot: "Nairobi",
    scene: "sample:kenya",
    zoom: 12,
    sample,
    failures,
    messages: ["boom", "boom", "bang"],
    timedOut: false,
  });

  assert.equal(record.zoom, "12");
  assert.equal(record.zoom_actual, 12);
  assert.equal(record.nearest_label_px, 50);
  assert.equal(record.dem_404, 2);
  assert.equal(record.glyph_404, 1);
  assert.equal(record.failed_requests, 1);
  assert.equal(record.errors, 2);
});

test("viewRecord reports a view without a sample as not loaded", () => {
  const record = viewRecord({
    spot: "S",
    scene: "x",
    zoom: "fitted",
    sample: null,
    failures: [],
    messages: ["jump failed"],
    timedOut: true,
  });

  assert.equal(record.label_features, null);
  assert.equal(record.tiles_loaded, false);
  assert.equal(record.timed_out, true);
});
