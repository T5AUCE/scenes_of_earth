import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { runTrial } from "../visual-trial.mjs";
import {
  chartAttributionVisible,
  chartBoundsState,
  chartGalleryBarBounds,
  chartGalleryBoundsState,
  chartGalleryReferenceBounds,
  chartGalleryTickBounds,
  chartReferenceBounds,
  chartTickBounds,
  chartWorkflowState,
  hitTestAttribution,
  hitTestControl,
  layoutPageChecks,
  layoutViewport,
  openChartsGallery,
  openLayoutEditor,
  preflightWebGL,
  trialLayout,
} from "./browser.mjs";
import {
  CHART_EDITOR_CONTROLS,
  controlDisplay,
  LAYOUT_CONTROLS,
  LAYOUT_EDITOR,
} from "./layout.mjs";
import { ensureScenes } from "./scenes.mjs";

test("a successful contour run returns exit code 0 and writes its records", async (context) => {
  const out = temporaryDir(context);
  silenceTrial(context);
  const { calls, system } = trialSystem({
    Layout: [{ spot: "Nairobi", scene: "x", zoom: "fitted", timed_out: false }],
  });

  const code = await runTrial(trialOptions(out), system);

  assert.equal(code, 0);
  assert.equal(calls.closed, 1);
  assert.equal(calls.measured, 1);
  assert.equal(readResults(out).length, 1);
});

test("passing layout records return exit code 0", async (context) => {
  const out = temporaryDir(context);
  silenceTrial(context);
  const { system } = trialSystem({
    Layout: [{
      viewport: "320x800",
      editor: "closed",
      role: "button",
      name: "Play",
      present: true,
      pass: true,
      hit: null,
    }],
  });

  assert.equal(await runTrial(trialOptions(out), system), 0);
});

test("a failing layout record returns exit code 1", async (context) => {
  const out = temporaryDir(context);
  silenceTrial(context);
  const { calls, system } = trialSystem({
    Layout: [{
      viewport: "320x800",
      editor: "closed",
      role: "button",
      name: "Play",
      present: false,
      pass: false,
      hit: null,
    }],
  });

  assert.equal(await runTrial(trialOptions(out), system), 1);
  assert.equal(calls.closed, 1);
  assert.equal(readResults(out).length, 1);
});

test("a throwing spot still closes the browser", async (context) => {
  const out = temporaryDir(context);
  silenceTrial(context);
  const { calls, system } = trialSystem({}, { throwSpot: true });

  await assert.rejects(runTrial(trialOptions(out), system), /spot failed/);
  assert.equal(calls.closed, 1);
});

test("a missing Edit button keeps closed failures and tries later viewports", async (context) => {
  const previousViewports = process.env.SOE_LAYOUT_VIEWPORTS;
  process.env.SOE_LAYOUT_VIEWPORTS = "320x800,320x560";
  context.after(() => {
    if (previousViewports === undefined) delete process.env.SOE_LAYOUT_VIEWPORTS;
    else process.env.SOE_LAYOUT_VIEWPORTS = previousViewports;
  });
  const out = temporaryDir(context);
  silenceTrial(context);
  const attempts = [];
  const { system } = trialSystem({}, { layoutSystem: viewportFakes(attempts) });

  const code = await runTrial(trialOptions(out), system);

  assert.equal(code, 1);
  assert.deepEqual(attempts, [{ width: 320, height: 800 }, { width: 320, height: 560 }]);
  const records = readResults(out);
  const edit = controlDisplay(LAYOUT_EDITOR);
  for (const viewport of ["320x800", "320x560"]) {
    const missingEdit = records.some((record) =>
      record.viewport === viewport
      && record.editor === "closed"
      && record.name === edit
      && record.present === false
      && record.pass === false,
    );
    const failedEditorOpen = records.some((record) =>
      record.viewport === viewport && record.name === "editor opens" && record.pass === false,
    );
    assert.ok(missingEdit);
    assert.ok(failedEditorOpen);
  }
});

test("a failing preflight blocks servers and scene builds", async (context) => {
  const out = temporaryDir(context);
  silenceTrial(context);
  const { system } = trialSystem({});
  let serversStarted = false;
  let built = false;
  system.startServers = async () => {
    serversStarted = true;
    return "http://example.test";
  };
  system.ensureScenes = async () => {
    built = true;
    return ["scene-id"];
  };
  system.preflightWebGL = async () => {
    throw new Error("WebGL2 unavailable in /fake (Chromium 1); reinstall");
  };

  await assert.rejects(
    runTrial({ ...trialOptions(out), start: true }, system),
    /WebGL2 unavailable/,
  );
  assert.equal(serversStarted, false);
  assert.equal(built, false);
});

test(
  "existing-only resolution matches an inclusive monthly end to its half-open bundle",
  async (context) => {
    const directory = temporaryDir(context);
    writeExistingScene(
      directory,
      {
        id: "aaaaaaaaaaaaaaaaaaaa",
        area: "sample:kenya",
        layers: ["terrain", "chirps_monthly"],
        start: "2026-04-01",
        end: "2026-09-01",
      },
    );
    const previousOnly = process.env.SOE_TRIAL_EXISTING_ONLY;
    const previousDir = process.env.SOE_SCENES_DIR;
    process.env.SOE_TRIAL_EXISTING_ONLY = "1";
    process.env.SOE_SCENES_DIR = directory;
    context.after(() => {
      if (previousOnly === undefined) delete process.env.SOE_TRIAL_EXISTING_ONLY;
      else process.env.SOE_TRIAL_EXISTING_ONLY = previousOnly;
      if (previousDir === undefined) delete process.env.SOE_SCENES_DIR;
      else process.env.SOE_SCENES_DIR = previousDir;
    });
    const spot = {
      area: "sample:kenya",
      layers: ["terrain", "chirps_monthly"],
      start: "2026-04",
      end: "2026-08",
    };

    const ids = await ensureScenes("http://example.test", [spot]);

    assert.deepEqual(ids, ["aaaaaaaaaaaaaaaaaaaa"]);
  },
);

test("existing-only resolution rejects a genuinely mismatched period", async (context) => {
  const directory = temporaryDir(context);
  writeExistingScene(
    directory,
    {
      id: "aaaaaaaaaaaaaaaaaaaa",
      area: "sample:kenya",
      layers: ["terrain", "chirps_monthly"],
      start: "2026-04-01",
      end: "2026-09-01",
    },
  );
  const previousOnly = process.env.SOE_TRIAL_EXISTING_ONLY;
  const previousDir = process.env.SOE_SCENES_DIR;
  process.env.SOE_TRIAL_EXISTING_ONLY = "1";
  process.env.SOE_SCENES_DIR = directory;
  context.after(() => {
    if (previousOnly === undefined) delete process.env.SOE_TRIAL_EXISTING_ONLY;
    else process.env.SOE_TRIAL_EXISTING_ONLY = previousOnly;
    if (previousDir === undefined) delete process.env.SOE_SCENES_DIR;
    else process.env.SOE_SCENES_DIR = previousDir;
  });
  const lateStart = {
    area: "sample:kenya",
    layers: ["terrain", "chirps_monthly"],
    start: "2026-05",
    end: "2026-08",
  };
  const earlyEnd = {
    area: "sample:kenya",
    layers: ["terrain", "chirps_monthly"],
    start: "2026-04",
    end: "2026-07",
  };

  await assert.rejects(
    ensureScenes("http://example.test", [lateStart]),
    /no local built scene/,
  );
  await assert.rejects(
    ensureScenes("http://example.test", [earlyEnd]),
    /no local built scene/,
  );
});

test("a blank-page probe reports the browser and fails clearly without WebGL2", async (context) => {
  silenceTrial(context);
  const { calls, system } = probeFakes(false);

  await assert.rejects(
    preflightWebGL(system),
    /WebGL2 unavailable in \/fake\/chrome-headless-shell/,
  );
  assert.equal(calls.closedBrowser, 1);
  assert.equal(calls.closedContext, 1);
  assert.equal(calls.closedPage, 1);
});

test("a passing blank-page probe returns its browser", async (context) => {
  silenceTrial(context);
  const { system } = probeFakes(true);

  assert.deepEqual(await preflightWebGL(system), {
    executablePath: "/fake/chrome-headless-shell",
    version: "156.0.8078.4",
  });
});

test("a layout setup failure keeps request and console diagnostics", async (context) => {
  const previousViewports = process.env.SOE_LAYOUT_VIEWPORTS;
  process.env.SOE_LAYOUT_VIEWPORTS = "320x800";
  context.after(() => {
    if (previousViewports === undefined) delete process.env.SOE_LAYOUT_VIEWPORTS;
    else process.env.SOE_LAYOUT_VIEWPORTS = previousViewports;
  });
  silenceTrial(context);
  const system = {
    isolateViewport: async () => ({
      newPage: async () => diagnosticPage(),
      close: async () => {},
    }),
    warmViewport: async () => {},
    watchViewport: async () => ({
      failures: [{ kind: "other", url: "https://example.test/x", status: 500 }],
      messages: ["pageerror: WebGL2 is required"],
    }),
    loadViewport: async () => { throw new Error("Timeout 90000ms exceeded"); },
    settleViewport: async () => {},
  };

  const error = await trialLayout(
    { browser: () => ({}) },
    "http://example.test",
    { name: "Layout" },
    "scene-id",
    {},
    system,
  ).catch((failure) => failure);
  assert.match(error.message, /failed to open/);
  assert.match(error.message, /example.test\/x/);
  assert.match(error.message, /WebGL2 is required/);
  assert.equal(error.cause.message, "Timeout 90000ms exceeded");
});

test("a layout setup failure keeps transport-level request diagnostics", async (context) => {
  const previousViewports = process.env.SOE_LAYOUT_VIEWPORTS;
  process.env.SOE_LAYOUT_VIEWPORTS = "320x800";
  context.after(() => {
    if (previousViewports === undefined) delete process.env.SOE_LAYOUT_VIEWPORTS;
    else process.env.SOE_LAYOUT_VIEWPORTS = previousViewports;
  });
  silenceTrial(context);
  const system = {
    isolateViewport: async () => ({
      newPage: async () => networkErrorPage(),
      close: async () => {},
    }),
    warmViewport: async () => {},
    loadViewport: async (page) => {
      page.failRequest("https://failed-resource.example/style.json", "net::ERR_CONNECTION_REFUSED");
      page.failResponse("https://example.test/scene.json", 500);
      throw new Error("Timeout 90000ms exceeded");
    },
    settleViewport: async () => {},
  };

  const error = await trialLayout(
    { browser: () => ({}) },
    "http://example.test",
    { name: "Layout" },
    "scene-id",
    {},
    system,
  ).catch((failure) => failure);
  assert.match(error.message, /failed-resource\.example\/style\.json/);
  assert.match(error.message, /ERR_CONNECTION_REFUSED/);
  assert.match(error.message, /example\.test\/scene\.json/);
  assert.equal(error.cause.message, "Timeout 90000ms exceeded");
});

test("setup probes the canonical override for a relative override", (context) => {
  for (const stockDefault of [false, true]) {
    const sandbox = setupSandbox(context, { stockDefault });
    const result = runSetup(sandbox, "cache");

    assert.equal(result.status, 0);
    assert.equal(probedDir(sandbox), sandbox.cache);
  }
});

test("setup preflights the legacy cache instead of returning early", (context) => {
  if (!useLegacyBrowsers(context)) return;
  const sandbox = setupSandbox(context, { withBrowser: false });
  const result = runSetup(sandbox, path.join(sandbox.root, "empty-cache"));

  assert.equal(result.status, 0);
  assert.equal(probedDir(sandbox), LEGACY_BROWSERS);
  assert.match(result.stdout, /Chromium ready in/);
});

test("a failing legacy probe fails setup", (context) => {
  if (!useLegacyBrowsers(context)) return;
  const sandbox = setupSandbox(context, { withBrowser: false, probeExit: 1 });
  const result = runSetup(sandbox, path.join(sandbox.root, "empty-cache"));

  assert.notEqual(result.status, 0);
});

test("hit-testing passes when the point hits the control itself", async () => {
  const hit = { tagName: "BUTTON", id: "", classList: [], textContent: "Play" };
  const record = await hitTestControl(
    pageWith(shownTarget(hit, (element) => element === hit)),
    VIEWPORT_PX,
    "closed",
    controlNamed("Play"),
  );

  assert.equal(record.present, true);
  assert.equal(record.pass, true);
  assert.equal(record.hit, "button \"Play\"");
});

test("a covering element fails the hit-test with its selector", async () => {
  const cover = { tagName: "A", id: "", classList: ["time-bar"], textContent: "OpenFreeMap" };
  const record = await hitTestControl(
    pageWith(shownTarget(cover, () => false)),
    VIEWPORT_PX,
    "closed",
    controlNamed("Play"),
  );

  assert.equal(record.pass, false);
  assert.equal(record.hit, "a.time-bar \"OpenFreeMap\"");
});

test("a card control scrolls its container before the hit-test", async () => {
  const container = {
    clientHeight: 136,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 453 }),
  };
  const element = {
    closest: (selector) => selector === "#scene-column .cards" ? container : null,
    getBoundingClientRect: () => ({ top: 644, height: 18 }),
    scrollIntoView: () => { throw new Error("must not scroll the page"); },
    contains: (found) => found.tagName === "INPUT",
  };
  const seen = [];
  const control = LAYOUT_CONTROLS.find((entry) =>
    controlDisplay(entry).startsWith("^Show Terrain"),
  );
  const record = await hitTestControl(
    pageWithScroll(element, seen),
    VIEWPORT_PX,
    "closed",
    control,
  );

  assert.equal(container.scrollTop, 644 + 18 / 2 - 453 - 136 / 2);
  assert.equal(record.pass, true);
  assert.deepEqual(seen, ["#scene-column .cards"]);
});

test("an in-flow editor control scrolls the cards instead", async () => {
  const cards = {
    clientHeight: 32,
    scrollTop: 0,
    scrollHeight: 600,
    getBoundingClientRect: () => ({ top: 155 }),
  };
  const editor = {
    clientHeight: 500,
    scrollHeight: 500,
    parentElement: cards,
    getBoundingClientRect: () => ({ top: 155 }),
  };
  const element = {
    closest: () => editor,
    getBoundingClientRect: () => ({ top: 400, height: 21 }),
    scrollIntoView: () => { throw new Error("must not scroll the page"); },
    contains: (found) => found.tagName === "INPUT",
  };
  const seen = [];
  const control = LAYOUT_CONTROLS.find((entry) => entry.name === "mm/month");
  const record = await hitTestControl(
    pageWithScroll(element, seen, { documentElement: {} }),
    VIEWPORT_PX,
    "open",
    control,
  );

  assert.equal(cards.scrollTop, 400 + 21 / 2 - 155 - 32 / 2);
  assert.equal(record.pass, true);
  assert.deepEqual(seen, [".layer-editor"]);
});

test("a fixed control hit-tests without scrolling", async () => {
  const seen = [];
  const record = await hitTestControl(
    pageWithScroll({ contains: (found) => found.tagName === "INPUT" }, seen),
    VIEWPORT_PX,
    "closed",
    controlNamed("Play"),
  );

  assert.equal(record.pass, true);
  assert.deepEqual(seen, []);
});

test("a sampled slider passes when every point hits itself", async () => {
  const seen = [];
  const slider = LAYOUT_CONTROLS.find((control) => control.role === "slider");
  const record = await hitTestControl(
    pageSampling(["input", "input", "input", "input", "input", "input"], seen),
    VIEWPORT_PX,
    "open",
    slider,
  );

  assert.equal(record.present, true);
  assert.equal(record.pass, true);
  assert.equal(record.hit, "input \"input\"");
  assert.deepEqual(seen, []);
});

test("a sampled slider fails on its covered end with the interceptor", async () => {
  const seen = [];
  const slider = LAYOUT_CONTROLS.find((control) => control.role === "slider");
  const record = await hitTestControl(
    pageSampling(["input", "input", "input", "input", "aside"], seen),
    VIEWPORT_PX,
    "open",
    slider,
  );

  assert.equal(record.present, true);
  assert.equal(record.pass, false);
  assert.equal(record.hit, "aside.layer-editor \"Cover\"");
  assert.deepEqual(seen, []);
});

test("a missing Play fails the trial", async () => {
  const record = await hitTestControl(missingPage(), VIEWPORT_PX, "closed", controlNamed("Play"));

  assert.equal(record.present, false);
  assert.equal(record.pass, false);
});

test("a missing timeline slider fails the trial", async () => {
  const slider = LAYOUT_CONTROLS.find((control) => control.role === "slider");
  const record = await hitTestControl(missingPage(), VIEWPORT_PX, "closed", slider);

  assert.equal(record.pass, false);
});

test("a missing Units radio fails with the editor open but skips when closed", async () => {
  const units = controlNamed("mm/month");
  const open = await hitTestControl(missingPage(), VIEWPORT_PX, "open", units);
  const closed = await hitTestControl(missingPage(), VIEWPORT_PX, "closed", units);

  assert.equal(open.pass, false);
  assert.equal(closed.present, false);
  assert.equal(closed.pass, null);
});

test("a missing Expand only skips", async () => {
  const record = await hitTestControl(missingPage(), VIEWPORT_PX, "closed", controlNamed("Expand"));

  assert.equal(record.present, false);
  assert.equal(record.pass, null);
});

test("a hidden required control fails the trial", async () => {
  const record = await hitTestControl(
    pageWith({ count: async () => 1, boundingBox: async () => null }),
    VIEWPORT_PX,
    "closed",
    controlNamed("Play"),
  );

  assert.equal(record.present, false);
  assert.equal(record.pass, false);
});

test("opening the editor clicks the first Edit match and waits for Close", async () => {
  const calls = [];
  const page = {
    getByRole: (role, { name } = {}) => ({
      first: () => (name === "Close"
        ? { waitFor: async () => { calls.push("wait"); } }
        : { click: async () => { calls.push("click"); } }),
    }),
    locator: () => { throw new Error("no scoped lookup here"); },
  };

  await openLayoutEditor(page);

  assert.deepEqual(calls, ["click", "wait"]);
});

test("the scale check fails outside the viewport and passes inside", async () => {
  const inside = await layoutPageChecks(
    scalePage({ x: 223, y: 8, w: 89, h: 22 }),
    VIEWPORT_PX,
    "closed",
  );
  const outside = await layoutPageChecks(
    scalePage({ x: 226, y: -44, w: 86, h: 22 }),
    VIEWPORT_PX,
    "closed",
  );
  const missing = await layoutPageChecks(scalePage(null), VIEWPORT_PX, "closed");

  assert.equal(inside.at(-1).name, "scale inside viewport");
  assert.equal(inside.at(-1).pass, true);
  assert.equal(outside.at(-1).pass, false);
  assert.equal(missing.at(-1).present, false);
  assert.equal(missing.at(-1).pass, false);
});

test("a short viewport opens tall and resizes down for its open checks", async () => {
  const sizes = [];
  const opened = [];
  const viewport = { width: 320, height: 320, openHeight: 560 };
  const system = {
    isolateViewport: async () => ({
      newPage: async () => resizePage(sizes),
      close: async () => {},
    }),
    warmViewport: async () => {},
    watchViewport: async () => ({ failures: [], messages: [] }),
    loadViewport: async () => {},
    settleViewport: async () => {},
    openEditor: async () => { opened.push("editor"); },
  };

  const records = await layoutViewport(
    {},
    "http://example.test",
    { name: "Layout" },
    "id",
    viewport,
    {},
    system,
  );

  assert.deepEqual(sizes, [{ width: 320, height: 560 }, { width: 320, height: 320 }]);
  assert.deepEqual(opened, ["editor"]);
  assert.ok(records.length > 0);
  assert.ok(records.every((record) => record.viewport === "320x320"));
});

test("a hidden attribution link fails the record", async () => {
  const link = { boundingBox: async () => null, textContent: async () => "© OpenStreetMap" };
  const [record] = await hitTestAttribution(attributionPage([link]), VIEWPORT_PX, "closed");

  assert.equal(record.role, "link");
  assert.equal(record.present, false);
  assert.equal(record.pass, false);
  assert.equal(record.name, "© OpenStreetMap");
});

test("a wrapped link probes its first rendered line", async () => {
  const link = wrappedLink("© OpenMapTiles", true);
  const [record] = await hitTestAttribution(attributionPage([link]), VIEWPORT_PX, "closed");

  assert.equal(record.present, true);
  assert.equal(record.pass, true);
  assert.equal(record.hit, "a \"© OpenMapTiles\"");
});

test("a covered first line fails the link with its interceptor", async () => {
  const link = wrappedLink("© OpenMapTiles", false);
  const [record] = await hitTestAttribution(attributionPage([link]), VIEWPORT_PX, "open");

  assert.equal(record.present, true);
  assert.equal(record.pass, false);
  assert.equal(record.hit, "div.maplibregl-ctrl-attrib-inner \"Terrain\"");
});

test("an empty attribution bar fails the trial", async () => {
  const [record] = await hitTestAttribution(attributionPage([]), VIEWPORT_PX, "open");

  assert.equal(record.present, false);
  assert.equal(record.pass, false);
});

test("opening the gallery clicks Charts then Expand and waits for it", async () => {
  const calls = [];
  const page = {
    getByRole: (role, { name } = {}) => ({
      first: () => ({ click: async () => { calls.push(`${role}:${String(name)}`); } }),
    }),
    locator: (selector) => ({
      first: () => ({ waitFor: async () => { calls.push(`wait:${selector}`); } }),
    }),
  };

  await openChartsGallery(page);

  assert.deepEqual(calls, ["button:Charts", "button:Expand ⤢", "wait:.chart-gallery"]);
});

test("a missing gallery fails only its opening check", async () => {
  const records = await chartWorkflowState({}, { width: 1024, height: 768 }, {
    openGallery: async () => { throw new Error("no gallery"); },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].viewport, "1024x768");
  assert.equal(records[0].editor, "charts");
  assert.equal(records[0].name, "chart gallery opens");
  assert.equal(records[0].pass, false);
});

test("a missing draft keeps gallery records and fails the editor step", async () => {
  const page = {
    ...missingPage(),
    evaluate: async () => ({ present: false, pass: false }),
  };
  const records = await chartWorkflowState(page, { width: 1280, height: 800 }, {
    openGallery: async () => {},
    openDraft: async () => { throw new Error("no draft"); },
    closeDialog: async () => {},
  });
  const names = records.map((record) => record.name);

  assert.ok(names.includes("+ New chart"));
  assert.ok(names.includes("chart editor opens"));
  assert.ok(records.every((record) => record.viewport === "1280x800"));
  assert.ok(records.every((record) => record.editor === "charts"));
});

test("gallery bounds fail on tick collision while editor passes", async () => {
  const page = {
    evaluate: async (probe) => {
      if (probe.name === "chartGalleryTickBounds") return { present: true, pass: false };
      if (probe.name === "chartGalleryReferenceBounds") return { present: true, pass: true };
      if (probe.name === "chartGalleryBarBounds") return { present: true, pass: true };
      throw new Error(`unexpected probe ${probe.name}`);
    },
  };
  const records = await chartGalleryBoundsState(page, { width: 1024, height: 768 });
  const byName = new Map(records.map((record) => [record.name, record]));

  assert.equal(records.length, 3);
  assert.equal(byName.get("chart gallery tick labels inside axes").pass, false);
  assert.equal(byName.get("chart gallery reference labels inside axes").pass, true);
  assert.equal(byName.get("chart gallery bars inside plot").pass, true);
  assert.ok(records.every((record) => record.viewport === "1024x768"));
});

test("gallery overlapping x ticks fail inside the card", () => {
  const overlapping = galleryTickSandbox({
    xBoxes: [
      { left: 60, right: 120, top: 152, bottom: 163 },
      { left: 100, right: 160, top: 152, bottom: 163 },
    ],
  });
  const result = runInNewContext(`(${chartGalleryTickBounds})()`, overlapping);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("gallery separated x ticks pass inside the card", () => {
  const sandbox = galleryTickSandbox({
    xBoxes: [
      { left: 60, right: 110, top: 152, bottom: 163 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
  });
  const result = runInNewContext(`(${chartGalleryTickBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, true);
});

test("gallery bars covering y ticks fail inside the card", () => {
  const sandbox = galleryBarSandbox({
    bars: [{ left: 20, right: 60, top: 40, bottom: 100 }],
    yBoxes: [{ left: 20, right: 44, top: 40, bottom: 51 }],
  });
  const result = runInNewContext(`(${chartGalleryBarBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("gallery bars inside the plot pass clear of y ticks", () => {
  const sandbox = galleryBarSandbox({
    bars: [{ left: 60, right: 90, top: 40, bottom: 100 }],
    yBoxes: [{ left: 20, right: 44, top: 40, bottom: 51 }],
  });
  const result = runInNewContext(`(${chartGalleryBarBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, true);
});

test("gallery endpoints outside the plot fail inside the card", () => {
  const sandbox = galleryReferenceSandbox([
    { left: 280, right: 360, top: 30, bottom: 41 },
  ]);
  const result = runInNewContext(`(${chartGalleryReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("gallery second card tick collision fails every card", () => {
  const separated = [
    { left: 60, right: 110, top: 152, bottom: 163 },
    { left: 180, right: 230, top: 152, bottom: 163 },
  ];
  const colliding = [
    { left: 60, right: 120, top: 152, bottom: 163 },
    { left: 100, right: 160, top: 152, bottom: 163 },
  ];
  const cards = [
    galleryCard({ id: EXPECTED_GALLERY_IDS[0], xBoxes: separated }),
    galleryCard({ id: EXPECTED_GALLERY_IDS[1], xBoxes: colliding }),
    galleryCard({ id: EXPECTED_GALLERY_IDS[2], xBoxes: separated }),
  ];
  const result = runInNewContext(
    `(${chartGalleryTickBounds})()`,
    gallerySandbox(cards),
  );

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("gallery x title outside names its card and predicate", () => {
  const outside = { left: 280, right: 340, top: 168, bottom: 178 };
  const cards = EXPECTED_GALLERY_IDS.map((id) => galleryCard({
    id,
    xTitleBoxes: id === "terrain:distribution" ? [outside] : undefined,
  }));
  const result = runInNewContext(
    `(${chartGalleryTickBounds})()`,
    gallerySandbox(cards),
  );

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
  assert.equal(result.detail.card, "terrain:distribution");
  assert.equal(result.detail.predicate, "x-title-outside-svg");
  assert.equal(result.detail.rect.left, 280);
  assert.equal(result.detail.rect.right, 340);
  assert.equal(result.detail.rect.top, 168);
  assert.equal(result.detail.rect.bottom, 178);
});

test("gallery wrapped x titles pass when both lines fit", () => {
  const lines = [
    { left: 90, right: 210, top: 164, bottom: 172 },
    { left: 120, right: 180, top: 172, bottom: 180 },
  ];
  const cards = EXPECTED_GALLERY_IDS.map((id) => galleryCard({
    id,
    xTitleBoxes: lines,
  }));
  const result = runInNewContext(
    `(${chartGalleryTickBounds})()`,
    gallerySandbox(cards),
  );

  assert.equal(result.present, true);
  assert.equal(result.pass, true);
  assert.equal(result.detail, null);
});

test("gallery missing SVG fails every expected card", () => {
  const bars = [{ left: 60, right: 90, top: 40, bottom: 100 }];
  const references = [
    { left: 200, right: 290, top: 30, bottom: 41 },
    { left: 200, right: 290, top: 50, bottom: 61 },
  ];
  const cards = [
    galleryCard({ id: EXPECTED_GALLERY_IDS[0], bars }),
    galleryCard({ id: EXPECTED_GALLERY_IDS[1], hasSvg: false }),
    galleryCard({ id: EXPECTED_GALLERY_IDS[2], references }),
  ];
  const sandbox = gallerySandbox(cards);
  const tick = runInNewContext(`(${chartGalleryTickBounds})()`, sandbox);
  const reference = runInNewContext(
    `(${chartGalleryReferenceBounds})()`,
    sandbox,
  );
  const barBounds = runInNewContext(`(${chartGalleryBarBounds})()`, sandbox);

  assert.equal(tick.present, true);
  assert.equal(tick.pass, false);
  assert.equal(reference.present, true);
  assert.equal(reference.pass, false);
  assert.equal(barBounds.present, true);
  assert.equal(barBounds.pass, false);
});

test("gallery missing expected card fails", () => {
  const bars = [{ left: 60, right: 90, top: 40, bottom: 100 }];
  const cards = [
    galleryCard({ id: EXPECTED_GALLERY_IDS[0], bars }),
    galleryCard({ id: EXPECTED_GALLERY_IDS[1] }),
  ];
  const sandbox = gallerySandbox(cards);
  const tick = runInNewContext(`(${chartGalleryTickBounds})()`, sandbox);
  const reference = runInNewContext(
    `(${chartGalleryReferenceBounds})()`,
    sandbox,
  );
  const barBounds = runInNewContext(`(${chartGalleryBarBounds})()`, sandbox);

  assert.equal(tick.present, true);
  assert.equal(tick.pass, false);
  assert.equal(reference.present, true);
  assert.equal(reference.pass, false);
  assert.equal(barBounds.present, true);
  assert.equal(barBounds.pass, false);
});

test("gallery bar group is required on its card", () => {
  const cards = EXPECTED_GALLERY_IDS.map((id) => galleryCard({ id }));
  const result = runInNewContext(
    `(${chartGalleryBarBounds})()`,
    gallerySandbox(cards),
  );

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("gallery reference group is required on its card", () => {
  const cards = EXPECTED_GALLERY_IDS.map((id) => galleryCard({ id }));
  const result = runInNewContext(
    `(${chartGalleryReferenceBounds})()`,
    gallerySandbox(cards),
  );

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("gallery overlapping bars fail inside the card", () => {
  const sandbox = galleryBarSandbox({
    bars: [
      { left: 60, right: 90, top: 40, bottom: 100 },
      { left: 80, right: 110, top: 40, bottom: 100 },
    ],
    yBoxes: [{ left: 20, right: 44, top: 40, bottom: 51 }],
  });
  const result = runInNewContext(`(${chartGalleryBarBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("gallery unknown unavailable title fails the trial", () => {
  const bars = [{ left: 60, right: 90, top: 40, bottom: 100 }];
  const references = [
    { left: 200, right: 290, top: 30, bottom: 41 },
    { left: 200, right: 290, top: 50, bottom: 61 },
  ];
  const cards = [
    galleryCard({ id: EXPECTED_GALLERY_IDS[0], bars }),
    galleryCard({ id: EXPECTED_GALLERY_IDS[1] }),
    galleryCard({ id: EXPECTED_GALLERY_IDS[2], references }),
  ];
  const known = gallerySandbox(cards, [
    unavailableTile("No rainfall accumulation"),
  ]);
  const unknown = gallerySandbox(cards, [unavailableTile("Something else")]);

  assert.equal(
    runInNewContext(`(${chartGalleryTickBounds})()`, known).pass,
    true,
  );
  assert.equal(
    runInNewContext(`(${chartGalleryTickBounds})()`, unknown).pass,
    false,
  );
});

test("clipped tick labels fail the bounds check while rendering passes", async () => {
  const page = {
    evaluate: async (probe) => {
      if (probe.name === "chartEditorSvg") return true;
      if (probe.name === "chartTickBounds") return { present: true, pass: false };
      if (probe.name === "chartReferenceBounds") return { present: true, pass: true };
      if (probe.name === "chartAttributionVisible") return true;
      if (probe.name === "chartEditorOverflow") return true;
      throw new Error(`unexpected probe ${probe.name}`);
    },
  };
  const records = await chartBoundsState(page, { width: 1024, height: 768 });
  const byName = new Map(records.map((record) => [record.name, record]));

  assert.equal(records.length, 5);
  assert.equal(byName.get("chart renders in the dialog").pass, true);
  assert.equal(byName.get("chart tick labels inside axes").pass, false);
  assert.equal(byName.get("chart reference labels inside axes").pass, true);
  assert.equal(byName.get("chart attribution visible").pass, true);
  assert.equal(byName.get("chart editor without horizontal overflow").pass, true);
  assert.ok(records.every((record) => record.viewport === "1024x768"));
});

test("tick labels pass in their gutters clear of titles", () => {
  const sandbox = tickSandbox({
    yBoxes: [
      { left: 20, right: 44, top: 18, bottom: 29 },
      { left: 20, right: 44, top: 100, bottom: 111 },
    ],
    xBoxes: [
      { left: 60, right: 110, top: 152, bottom: 163 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
  });
  const result = runInNewContext(`(${chartTickBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, true);
});

test("a y tick overlapping the title fails inside the svg", () => {
  const sandbox = tickSandbox({
    yBoxes: [
      { left: 10, right: 30, top: 60, bottom: 71 },
      { left: 20, right: 44, top: 100, bottom: 111 },
    ],
    xBoxes: [
      { left: 60, right: 110, top: 152, bottom: 163 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
  });
  const result = runInNewContext(`(${chartTickBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("an x tick overlapping its title fails inside the svg", () => {
  const sandbox = tickSandbox({
    yBoxes: [
      { left: 20, right: 44, top: 18, bottom: 29 },
      { left: 20, right: 44, top: 100, bottom: 111 },
    ],
    xBoxes: [
      { left: 120, right: 200, top: 170, bottom: 181 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
  });
  const result = runInNewContext(`(${chartTickBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("a y tick entering the plot fails inside the svg", () => {
  const sandbox = tickSandbox({
    yBoxes: [
      { left: 40, right: 60, top: 18, bottom: 29 },
      { left: 20, right: 44, top: 100, bottom: 111 },
    ],
    xBoxes: [
      { left: 60, right: 110, top: 152, bottom: 163 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
  });
  const result = runInNewContext(`(${chartTickBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("overlapping y ticks fail while separated ticks pass", () => {
  const overlapping = tickSandbox({
    yBoxes: [
      { left: 20, right: 44, top: 50, bottom: 61 },
      { left: 20, right: 44, top: 55, bottom: 66 },
    ],
    xBoxes: [
      { left: 60, right: 110, top: 152, bottom: 163 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
  });
  const result = runInNewContext(`(${chartTickBounds})()`, overlapping);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("a disclosure outside the svg fails the tick bounds", () => {
  const sandbox = tickSandbox({
    yBoxes: [
      { left: 20, right: 44, top: 18, bottom: 29 },
      { left: 20, right: 44, top: 100, bottom: 111 },
    ],
    xBoxes: [
      { left: 60, right: 110, top: 152, bottom: 163 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
    disclosure: { left: 300, right: 340, top: 2, bottom: 14, width: 40, height: 12 },
  });
  const result = runInNewContext(`(${chartTickBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("an x tick overlapping a reference fails the tick bounds", () => {
  const sandbox = tickSandbox({
    yBoxes: [
      { left: 20, right: 44, top: 18, bottom: 29 },
      { left: 20, right: 44, top: 100, bottom: 111 },
    ],
    xBoxes: [{ left: 200, right: 290, top: 152, bottom: 163 }],
    references: [{ left: 200, right: 290, top: 152, bottom: 163 }],
  });
  const result = runInNewContext(`(${chartTickBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("wrapped disclosure lines all stay inside the svg", () => {
  const inside = tickSandbox({
    yBoxes: [
      { left: 20, right: 44, top: 18, bottom: 29 },
      { left: 20, right: 44, top: 100, bottom: 111 },
    ],
    xBoxes: [
      { left: 60, right: 110, top: 152, bottom: 163 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
    disclosures: [
      { left: 48, right: 200, top: 2, bottom: 14, width: 152, height: 12 },
      { left: 48, right: 210, top: 14, bottom: 26, width: 162, height: 12 },
    ],
  });
  assert.equal(runInNewContext(`(${chartTickBounds})()`, inside).pass, true);
  const outside = tickSandbox({
    yBoxes: [
      { left: 20, right: 44, top: 18, bottom: 29 },
      { left: 20, right: 44, top: 100, bottom: 111 },
    ],
    xBoxes: [
      { left: 60, right: 110, top: 152, bottom: 163 },
      { left: 180, right: 230, top: 152, bottom: 163 },
    ],
    disclosures: [
      { left: 48, right: 200, top: 2, bottom: 14, width: 152, height: 12 },
      { left: 300, right: 400, top: 14, bottom: 26, width: 100, height: 12 },
    ],
  });
  const result = runInNewContext(`(${chartTickBounds})()`, outside);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("reference labels pass inside the plot frame", () => {
  const sandbox = referenceSandbox([
    { left: 200, right: 290, top: 30, bottom: 41 },
    { left: 200, right: 290, top: 50, bottom: 61 },
  ]);
  const result = runInNewContext(`(${chartReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, true);
});

test("overlapping reference labels fail inside the svg", () => {
  const sandbox = referenceSandbox([
    { left: 200, right: 290, top: 30, bottom: 41 },
    { left: 200, right: 290, top: 35, bottom: 46 },
  ]);
  const result = runInNewContext(`(${chartReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("a reference label outside the plot fails inside the svg", () => {
  const sandbox = referenceSandbox([
    { left: 10, right: 40, top: 30, bottom: 41 },
    { left: 200, right: 290, top: 50, bottom: 61 },
  ]);
  const result = runInNewContext(`(${chartReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("a title outside the svg fails the reference bounds", () => {
  const sandbox = referenceSandbox({
    rects: [
      { left: 200, right: 290, top: 30, bottom: 41 },
      { left: 200, right: 290, top: 50, bottom: 61 },
    ],
    yTitleBox: { left: 6, right: 18, top: 45, bottom: 200 },
  });
  const result = runInNewContext(`(${chartReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("a reference over an x tick fails inside the svg", () => {
  const sandbox = referenceSandbox({
    rects: [{ left: 200, right: 290, top: 152, bottom: 163 }],
    xBoxes: [{ left: 180, right: 230, top: 152, bottom: 163 }],
  });
  const result = runInNewContext(`(${chartReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("an in-frame reference and tick overlap fails the cross-group check", () => {
  const sandbox = referenceSandbox({
    rects: [{ left: 200, right: 290, top: 138, bottom: 148 }],
    xBoxes: [{ left: 200, right: 290, top: 145, bottom: 156 }],
  });
  const result = runInNewContext(`(${chartReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
  const withoutTick = referenceSandbox({
    rects: [{ left: 200, right: 290, top: 138, bottom: 148 }],
  });
  assert.equal(runInNewContext(`(${chartReferenceBounds})()`, withoutTick).pass, true);
});

test("a centered constant tick keeps in-frame references passing", () => {
  const sandbox = referenceSandbox({
    rects: [
      { left: 200, right: 290, top: 80, bottom: 91 },
      { left: 200, right: 290, top: 100, bottom: 111 },
    ],
    grid: [{ left: 48, right: 296, top: 84, bottom: 85 }],
    plotFrame: { left: 48, right: 296, top: 20, bottom: 148 },
  });
  const result = runInNewContext(`(${chartReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, true);
});

test("a centered constant tick still rejects labels below the frame", () => {
  const sandbox = referenceSandbox({
    rects: [{ left: 200, right: 290, top: 150, bottom: 161 }],
    grid: [{ left: 48, right: 296, top: 84, bottom: 85 }],
    plotFrame: { left: 48, right: 296, top: 20, bottom: 148 },
  });
  const result = runInNewContext(`(${chartReferenceBounds})()`, sandbox);

  assert.equal(result.present, true);
  assert.equal(result.pass, false);
});

test("attribution passes with every line hit-tested", () => {
  const sandbox = attributionSandbox({
    lines: [{ left: 100, right: 300, top: 700, bottom: 714, width: 200, height: 14 }],
    covered: false,
    style: { display: "block", visibility: "visible", opacity: "1" },
  });
  const result = runInNewContext(`(${chartAttributionVisible})()`, sandbox);

  assert.equal(result, true);
});

test("attribution fails when a line leaves the scrollport", () => {
  const sandbox = attributionSandbox({
    lines: [
      { left: 100, right: 300, top: 700, bottom: 714, width: 200, height: 14 },
      { left: 400, right: 600, top: 700, bottom: 714, width: 200, height: 14 },
    ],
    covered: false,
    style: { display: "block", visibility: "visible", opacity: "1" },
  });
  const result = runInNewContext(`(${chartAttributionVisible})()`, sandbox);

  assert.equal(result, false);
});

test("attribution fails when hidden or covered", () => {
  const hidden = attributionSandbox({
    lines: [{ left: 100, right: 300, top: 700, bottom: 714, width: 200, height: 14 }],
    covered: false,
    style: { display: "block", visibility: "hidden", opacity: "1" },
  });
  const covered = attributionSandbox({
    lines: [{ left: 100, right: 300, top: 700, bottom: 714, width: 200, height: 14 }],
    covered: true,
    style: { display: "block", visibility: "visible", opacity: "1" },
  });

  assert.equal(runInNewContext(`(${chartAttributionVisible})()`, hidden), false);
  assert.equal(runInNewContext(`(${chartAttributionVisible})()`, covered), false);
});

test("attribution fails when a fragment extends past the viewport", () => {
  const sandbox = attributionSandbox({
    lines: [{ left: 900, right: 1100, top: 700, bottom: 714, width: 200, height: 14 }],
    covered: false,
    style: { display: "block", visibility: "visible", opacity: "1" },
    mainBox: { left: 0, right: 1200, top: 0, bottom: 768 },
    viewport: { width: 1024, height: 768 },
  });
  const result = runInNewContext(`(${chartAttributionVisible})()`, sandbox);

  assert.equal(result, false);
});

test("attribution fails when an overlay covers one end of a line", () => {
  const sandbox = attributionSandbox({
    lines: [{ left: 100, right: 300, top: 700, bottom: 714, width: 200, height: 14 }],
    style: { display: "block", visibility: "visible", opacity: "1" },
    hitFor: (x) => (x > 250 ? { inside: false } : { inside: true }),
  });
  const result = runInNewContext(`(${chartAttributionVisible})()`, sandbox);

  assert.equal(result, false);
});

test("attribution uses text fragments rather than the element box", () => {
  const fragments = [
    { left: 100, right: 300, top: 700, bottom: 714, width: 200, height: 14 },
    { left: 100, right: 250, top: 716, bottom: 730, width: 150, height: 14 },
  ];
  const elementBox = { left: 100, right: 300, top: 700, bottom: 730, width: 200, height: 30 };
  const sandbox = attributionSandbox({
    lines: fragments,
    elementBox,
    style: { display: "block", visibility: "visible", opacity: "1" },
    hitFor: (x, y) => (
      x >= 150 && x <= 190 && y >= 718 && y <= 728 ? { inside: false } : { inside: true }
    ),
  });
  const note = sandbox.document.querySelector("#scene-full .chart-editor .editor-attribution");
  assert.equal(note.childNodes.length, 1);
  assert.equal(note.childNodes[0].nodeType, 3);
  assert.equal(note.getClientRects().length, 1);
  const range = sandbox.document.createRange();
  range.selectNodeContents(note.childNodes[0]);
  assert.equal(range.getClientRects().length, 2);
  const result = runInNewContext(`(${chartAttributionVisible})()`, sandbox);

  assert.equal(result, false);
});

test("a covered Save fails with its interceptor in the dialog", async () => {
  const cover = { tagName: "ASIDE", id: "", classList: ["chart-editor"], textContent: "Cover" };
  const save = CHART_EDITOR_CONTROLS.find((control) => controlDisplay(control) === "Save");
  const target = {
    count: async () => 1,
    boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 10 }),
    evaluate: async (source, args) => {
      if (typeof args === "string") return undefined;
      return runInNewContext(`(${source})(control, args)`, {
        control: { contains: () => false },
        args,
        document: { elementFromPoint: () => cover },
      });
    },
  };
  const byRole = () => ({ first: () => target });
  const page = { getByRole: byRole, locator: () => ({ getByRole: byRole }) };
  const record = await hitTestControl(page, VIEWPORT_PX, "charts", save);

  assert.equal(record.present, true);
  assert.equal(record.pass, false);
  assert.equal(record.hit, "aside.chart-editor \"Cover\"");
});

test("the layout pass labels chart records with its viewport", async (context) => {
  silenceTrial(context);
  const system = {
    isolateViewport: async () => ({
      newPage: async () => missingEditPage(),
      close: async () => {},
    }),
    warmViewport: async () => {},
    watchViewport: async () => ({ failures: [], messages: [] }),
    loadViewport: async () => {},
    settleViewport: async () => {},
  };
  const records = await layoutViewport(
    {},
    "http://example.test",
    { name: "Layout" },
    "id",
    { width: 1024, height: 768 },
    {},
    system,
  );
  const gallery = records.find((record) => record.name === "chart gallery opens");

  assert.ok(gallery);
  assert.equal(gallery.viewport, "1024x768");
  assert.equal(gallery.pass, false);
});

test("layout screenshots stay disabled without --screens", async () => {
  const screenshots = [];
  const events = [];
  const system = screenshotSystem(screenshots, events);

  await layoutViewport(
    {},
    "http://example.test",
    { name: "Layout" },
    "id",
    { width: 1024, height: 768 },
    { screens: false, out: "/tmp/out" },
    system,
  );

  assert.deepEqual(screenshots, []);
  assert.ok(events.includes("close-page"));
  assert.ok(events.includes("close-context"));
});

test("layout screenshots capture each state while it stays open", async () => {
  const screenshots = [];
  const events = [];
  const system = screenshotSystem(screenshots, events);

  await layoutViewport(
    {},
    "http://example.test",
    { name: "Layout" },
    "id",
    { width: 1024, height: 768 },
    { screens: true, out: "/tmp/out" },
    system,
  );

  assert.deepEqual(screenshots.map((file) => path.basename(file)), [
    "layout-1024x768-closed.png",
    "layout-1024x768-charts-gallery.png",
    "layout-1024x768-chart-editor.png",
    "layout-1024x768-open.png",
  ]);
  const order = (name) => events.indexOf(name);
  assert.ok(order("screenshot:layout-1024x768-closed.png") < order("gallery"));
  assert.ok(order("gallery") < order("screenshot:layout-1024x768-charts-gallery.png"));
  assert.ok(order("screenshot:layout-1024x768-charts-gallery.png") < order("draft"));
  assert.ok(order("draft") < order("screenshot:layout-1024x768-chart-editor.png"));
  assert.ok(order("screenshot:layout-1024x768-chart-editor.png") < order("close-dialog"));
  assert.ok(order("close-dialog") < order("editor"));
  assert.ok(order("editor") < order("screenshot:layout-1024x768-open.png"));
  assert.ok(order("screenshot:layout-1024x768-open.png") < order("close-page"));
  assert.ok(order("close-page") < order("close-context"));
});

test("trialLayout threads screenshot options to each desktop viewport", async (context) => {
  const previous = process.env.SOE_LAYOUT_VIEWPORTS;
  process.env.SOE_LAYOUT_VIEWPORTS = "1024x768,1280x800";
  context.after(() => {
    if (previous === undefined) delete process.env.SOE_LAYOUT_VIEWPORTS;
    else process.env.SOE_LAYOUT_VIEWPORTS = previous;
  });
  silenceTrial(context);
  const screenshots = [];
  const events = [];
  const seen = [];
  const system = screenshotSystem(screenshots, events, seen);

  await trialLayout(
    { browser: () => ({}) },
    "http://example.test",
    { name: "Layout" },
    "id",
    { screens: true, out: "/tmp/out" },
    system,
  );

  assert.deepEqual(seen, ["1024x768", "1280x800"]);
  assert.equal(screenshots.length, 8);
  for (const viewport of ["1024x768", "1280x800"]) {
    for (const state of ["closed", "charts-gallery", "chart-editor", "open"]) {
      assert.ok(screenshots.some((file) => file.endsWith(`layout-${viewport}-${state}.png`)));
    }
  }
  assert.equal(new Set(screenshots).size, 8);
});

// A link wrapped across two lines renders nothing at its box center.
function wrappedLink(name, reachable) {
  const hit = reachable
    ? { tagName: "A", id: "", classList: [], textContent: name }
    : {
      tagName: "DIV",
      id: "",
      classList: ["maplibregl-ctrl-attrib-inner"],
      textContent: "Terrain",
    };
  return {
    boundingBox: async () => ({ x: 90, y: 520, width: 120, height: 28 }),
    textContent: async () => name,
    evaluate: async (source, args) => runInNewContext(`(${source})(control, args)`, {
      control: {
        getClientRects: () => [
          { x: 90, y: 520, width: 100, height: 14 },
          { x: 5, y: 534, width: 20, height: 14 },
        ],
        contains: () => reachable,
      },
      args,
      document: { elementFromPoint: () => hit },
    }),
  };
}

const VIEWPORT_PX = { width: 320, height: 800 };

const SETUP_SCRIPT = fileURLToPath(new URL("./setup.sh", import.meta.url));
const LEGACY_BROWSERS = "/tmp/opencode/m5-visual-tools";

function trialSystem(recordsBySpot, behaviour = {}) {
  const calls = { closed: 0, measured: 0, preflight: 0 };
  return {
    calls,
    system: {
      loadPlaces: () => [{ name: "Layout", layout: true }],
      preflightWebGL: async () => { calls.preflight += 1; },
      ensureScenes: async () => ["scene-id"],
      launchBrowser: async () => ({ close: async () => { calls.closed += 1; } }),
      newContext: async () => (behaviour.layoutSystem ? { browser: () => ({}) } : {}),
      installCache: async () => {},
      trialSpot: async (context, appUrl, spot, sceneId, runOptions) => {
        calls.measured += 1;
        assert.equal(sceneId, "scene-id");
        if (behaviour.throwSpot) throw new Error("spot failed");
        if (behaviour.layoutSystem) {
          return trialLayout(context, appUrl, spot, sceneId, runOptions, behaviour.layoutSystem);
        }
        return recordsBySpot[spot.name] ?? [];
      },
    },
  };
}

function trialOptions(out) {
  return {
    places: "layout",
    start: false,
    app: "http://example.test/",
    out,
    screens: false,
    parallel: 1,
  };
}

function temporaryDir(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "soe-runner-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeExistingScene(directory, scene) {
  const sceneDir = path.join(directory, scene.id);
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(
    path.join(sceneDir, "scene.json"),
    JSON.stringify({
      id: scene.id,
      area: { boundary: { id: scene.area, name: scene.area } },
      layers: scene.layers.map((id) => ({ id })),
      period: { start: scene.start, end: scene.end },
      created: "2026-11-02T22:00:43+00:00",
    }),
  );
}

function silenceTrial(context) {
  context.mock.method(console, "log", () => {});
  context.mock.method(console, "error", () => {});
}

function readResults(out) {
  const text = fs.readFileSync(path.join(out, "results.jsonl"), "utf8").trim();
  return text ? text.split("\n").map(JSON.parse) : [];
}

function setupSandbox(context, { stockDefault = false, withBrowser = true, probeExit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soe-setup-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const probed = path.join(root, "probed");
  // The stub records the probed directory instead of launching a browser.
  const stub = [
    "#!/usr/bin/env bash",
    `echo "$SOE_TRIAL_BROWSER_DIR" > "${probed}"`,
    `exit ${probeExit}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(bin, "node"), stub);
  fs.chmodSync(path.join(bin, "node"), 0o755);
  const cache = path.join(root, "cache");
  if (withBrowser) fakeBrowser(cache);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  if (stockDefault) fakeBrowser(path.join(home, ".cache/soe-visual-trial"));

  return { root, bin, cache, home };
}

function fakeBrowser(cacheDir) {
  const shell = path.join(
    cacheDir,
    "browsers",
    "chromium_headless_shell-1",
    "chrome-headless-shell-linux64",
  );
  fs.mkdirSync(shell, { recursive: true });
  fs.writeFileSync(path.join(shell, "chrome-headless-shell"), "");
}

function runSetup(sandbox, override) {
  return spawnSync("bash", [SETUP_SCRIPT], {
    cwd: sandbox.root,
    env: {
      ...process.env,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      HOME: sandbox.home,
      SOE_TRIAL_BROWSER_DIR: override,
    },
    encoding: "utf8",
  });
}

function probedDir(sandbox) {
  return fs.readFileSync(path.join(sandbox.root, "probed"), "utf8").trim();
}

// A pre-existing legacy install must never be removed by a test run.
function useLegacyBrowsers(context) {
  if (fs.existsSync(LEGACY_BROWSERS)) return false;
  fakeBrowser(LEGACY_BROWSERS);
  context.after(() => fs.rmSync(LEGACY_BROWSERS, { recursive: true, force: true }));

  return true;
}

function viewportFakes(attempts) {
  return {
    isolateViewport: async (browser, viewport) => {
      attempts.push(viewport);
      return { newPage: async () => missingEditPage(), close: async () => {} };
    },
    warmViewport: async () => {},
    watchViewport: async () => ({ failures: [], messages: [] }),
    loadViewport: async () => {},
    settleViewport: async () => {},
  };
}

function missingEditPage() {
  const missing = {
    count: async () => 0,
    click: async () => { throw new Error("locator.click: Edit Rainfall is missing"); },
  };
  const first = () => missing;
  return {
    close: async () => {},
    getByRole: () => ({ first }),
    locator: (scope) => {
      if (scope.endsWith(" a")) return { count: async () => 0 };
      return { getByRole: () => ({ first }) };
    },
    evaluate: async (probe) => probe.name === "seesAttribution",
  };
}

// Runs the layout workflow with screenshot fakes, so option plumbing stays honest.
function screenshotSystem(screenshots, events, seen = null) {
  return {
    isolateViewport: async (browser, viewport) => {
      if (seen) seen.push(`${viewport.width}x${viewport.height}`);
      return {
        newPage: async () => screenshotTrialPage(screenshots, events),
        close: async () => { events.push("close-context"); },
      };
    },
    warmViewport: async () => {},
    watchViewport: async () => ({ failures: [], messages: [] }),
    loadViewport: async () => {},
    settleViewport: async () => {},
    openGallery: async () => { events.push("gallery"); },
    openDraft: async () => { events.push("draft"); },
    closeDialog: async () => { events.push("close-dialog"); },
    openEditor: async () => { events.push("editor"); },
  };
}

function screenshotTrialPage(screenshots, events) {
  const missing = { count: async () => 0 };
  return {
    setViewportSize: async () => {},
    close: async () => { events.push("close-page"); },
    getByRole: () => ({ first: () => missing }),
    locator: () => ({ count: async () => 0, getByRole: () => ({ first: () => missing }) }),
    evaluate: async (probe) => screenshotProbe(probe),
    screenshot: async ({ path: file }) => {
      screenshots.push(file);
      events.push(`screenshot:${path.basename(file)}`);
    },
  };
}

function screenshotProbe(probe) {
  if (probe.name === "hasHorizontalOverflow") return false;
  if (probe.name === "seesAttribution") return true;
  if (probe.name === "scaleInsideViewport") return true;
  if (probe.name === "chartEditorSvg") return true;
  if (probe.name === "chartTickBounds") return { present: true, pass: true };
  if (probe.name === "chartReferenceBounds") return { present: true, pass: true };
  if (probe.name === "chartGalleryTickBounds") return { present: true, pass: true };
  if (probe.name === "chartGalleryReferenceBounds") return { present: true, pass: true };
  if (probe.name === "chartGalleryBarBounds") return { present: true, pass: true };
  if (probe.name === "chartAttributionVisible") return true;
  if (probe.name === "chartEditorOverflow") return true;

  return null;
}

function probeFakes(webglOk) {
  const calls = { closedBrowser: 0, closedContext: 0, closedPage: 0 };
  const page = {
    goto: async () => {},
    evaluate: async () => (
      webglOk ? { ok: true, version: "WebGL 2.0" } : { ok: false }
    ),
    close: async () => { calls.closedPage += 1; },
  };
  const browser = {
    version: () => "156.0.8078.4",
    close: async () => { calls.closedBrowser += 1; },
  };
  return {
    calls,
    system: {
      findPath: () => "/fake/chrome-headless-shell",
      openBrowser: async () => browser,
      openBlank: async () => ({
        newPage: async () => page,
        close: async () => { calls.closedContext += 1; },
      }),
    },
  };
}

function diagnosticPage() {
  return {
    close: async () => {},
    evaluate: async (probe) => {
      if (probe.name === "readViewportState") return loadingViewportState();
      return null;
    },
  };
}

// Records Playwright listeners so tests can fire the real watcher events on demand.
function networkErrorPage() {
  const listeners = {};
  const fire = (event, payload) => {
    for (const handler of listeners[event] ?? []) {
      handler(payload);
    }
  };
  return {
    on: (event, handler) => {
      listeners[event] ??= [];
      listeners[event].push(handler);
    },
    failRequest: (url, errorText) => {
      fire("requestfailed", { url: () => url, failure: () => ({ errorText }) });
    },
    failResponse: (url, status) => {
      fire("response", { url: () => url, status: () => status });
    },
    close: async () => {},
    evaluate: async (probe) => {
      if (probe.name === "readViewportState") return loadingViewportState();
      return null;
    },
  };
}

function loadingViewportState() {
  return {
    hasMap: false,
    maskReady: false,
    layersReady: false,
    mapErrors: [],
    bodyText: "loading",
  };
}

// Serves each sampled point the next tag, so endpoint coverage is testable.
function pageSampling(tags, seen) {
  const queue = [...tags];
  const byRole = () => ({
    first: () => ({
      count: async () => 1,
      boundingBox: async () => ({ x: 60, y: 750, width: 200, height: 8 }),
      evaluate: async (source, args) => {
        if (typeof args === "string") {
          seen.push(args);

          return undefined;
        }
        const tag = queue.shift() ?? "input";
        const hit = {
          tagName: tag.toUpperCase(),
          id: "",
          classList: tag === "input" ? [] : ["layer-editor"],
          textContent: tag === "input" ? "input" : "Cover",
        };
        return runInNewContext(`(${source})(control, args)`, {
          control: { contains: (found) => found.tagName === "INPUT" },
          args,
          document: { elementFromPoint: () => hit },
        });
      },
    }),
  });
  return { getByRole: byRole, locator: () => ({ getByRole: byRole }) };
}

function pageWithScroll(element, seen, sandboxDocument = undefined) {
  const hit = { tagName: "INPUT", id: "", classList: [], textContent: "" };
  const byRole = () => ({
    first: () => ({
      count: async () => 1,
      boundingBox: async () => ({ x: 0, y: 600, width: 20, height: 10 }),
      evaluate: async (source, args) => {
        if (typeof args === "string") {
          seen.push(args);
          return runInNewContext(`(${source})(control, args)`, {
            control: element,
            args,
            document: sandboxDocument,
          });
        }
        return runInNewContext(`(${source})(control, args)`, {
          control: { contains: (found) => element.contains(found) },
          args,
          document: { elementFromPoint: () => hit },
        });
      },
    }),
  });
  return { getByRole: byRole, locator: () => ({ getByRole: byRole }) };
}

// Runs the real page probes against a fake scale box in a fixed viewport.
function scalePage(box) {
  return {
    evaluate: async (source, args) => runInNewContext(`(${source})(args)`, {
      args,
      document: {
        querySelector: () => (box === null ? null : {
          getBoundingClientRect: () => ({
            x: box.x,
            y: box.y,
            width: box.w,
            height: box.h,
            right: box.x + box.w,
            bottom: box.y + box.h,
          }),
        }),
        documentElement: { scrollWidth: 320 },
      },
      window: { innerWidth: 320, innerHeight: 800 },
    }),
  };
}

// Records resizes while every control stays absent, isolating the resize wiring.
function resizePage(sizes) {
  const missing = { count: async () => 0 };
  return {
    setViewportSize: async (size) => { sizes.push(size); },
    close: async () => {},
    getByRole: () => ({ first: () => missing }),
    locator: () => ({ count: async () => 0, getByRole: () => ({ first: () => missing }) }),
    evaluate: async (probe) => probe.name === "scaleInsideViewport",
  };
}

function pageWith(target) {
  const byRole = () => ({ first: () => target });
  return { getByRole: byRole, locator: () => ({ getByRole: byRole }) };
}

function missingPage() {
  return pageWith({ count: async () => 0 });
}

// Runs the real page probe from its source in a sandbox, so the orchestration stays honest.
function pageProbe(hit, inside) {
  return async (source, args) => runInNewContext(
    `(${source})(control, args)`,
    {
      control: { contains: (element) => inside(element) },
      args,
      document: { elementFromPoint: () => hit },
    },
  );
}

function controlNamed(name) {
  return LAYOUT_CONTROLS.find((control) => controlDisplay(control) === name);
}

function shownTarget(hit, inside) {
  return {
    count: async () => 1,
    boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 10 }),
    evaluate: pageProbe(hit, inside),
  };
}

function attributionPage(links) {
  return {
    locator: () => ({ count: async () => links.length, nth: (index) => links[index] }),
    getByRole: () => { throw new Error("unused"); },
  };
}

// Runs the tick probe against fake gutters, so collisions inside the svg still fail.
function tickSandbox({
  yBoxes,
  xBoxes,
  references = [],
  disclosure = null,
  disclosures = null,
  yTitleBox = { left: 6, right: 18, top: 45, bottom: 123 },
  xTitleBox = { left: 112, right: 232, top: 168, bottom: 178 },
  plotFrame = { left: 48, right: 296, top: 20, bottom: 148 },
  grid = null,
}) {
  const svgBox = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 };
  const gridBoxes = grid ?? [
    { left: 48, right: 296, top: 20, bottom: 21 },
    { left: 48, right: 296, top: 148, bottom: 149 },
  ];
  const boxed = (box) => ({ getBoundingClientRect: () => box });
  const titled = (box, rotated, offset = false) => ({
    getAttribute: () => (rotated ? "rotate(-90 12 84)" : ""),
    getBoundingClientRect: () => box,
    classList: { contains: (name) => offset && name === "chart-offset" },
  });
  const disclosureList = disclosures ?? (disclosure ? [disclosure] : []);
  const disclosureBoxes = disclosureList.map((box) => titled(box, false, true));

  return {
    document: {
      querySelector: (selector) => {
        if (selector.includes("chart-plot-frame")) return boxed(plotFrame);
        if (selector.includes("chart-offset")) return disclosureBoxes[0] ?? null;
        if (selector.includes("svg")) return boxed(svgBox);
        return null;
      },
      querySelectorAll: (selector) => {
        if (selector.includes("chart-grid")) return gridBoxes.map(boxed);
        if (selector.includes("chart-axes")) {
          const axes = [titled(yTitleBox, true), titled(xTitleBox, false), ...disclosureBoxes];

          return axes;
        }
        if (selector.includes("chart-offset")) return disclosureBoxes;
        if (selector.includes("chart-y-ticks")) return yBoxes.map(boxed);
        if (selector.includes("chart-x-ticks")) return xBoxes.map(boxed);
        if (selector.includes("chart-references") || selector.includes("chart-endpoints")) {
          return references.map(boxed);
        }
        return [];
      },
    },
    window: {},
  };
}

// Runs the reference probe inside the plot frame, so outside labels still fail.
function referenceSandbox(rectsOrOptions, maybeOptions = {}) {
  const normalized = Array.isArray(rectsOrOptions)
    ? { rects: rectsOrOptions, ...maybeOptions }
    : rectsOrOptions;
  const rects = normalized.rects ?? [];
  const resolvedY = normalized.yBoxes ?? [];
  const resolvedX = normalized.xBoxes ?? [];
  const resolvedList = normalized.disclosures
    ?? (normalized.disclosure ? [normalized.disclosure] : []);
  const resolvedYTitle = normalized.yTitleBox ?? { left: 6, right: 18, top: 45, bottom: 123 };
  const resolvedXTitle = normalized.xTitleBox ?? { left: 112, right: 232, top: 168, bottom: 178 };
  const resolvedFrame = normalized.plotFrame ?? { left: 48, right: 296, top: 20, bottom: 148 };
  const resolvedGrid = normalized.grid ?? [
    { left: 48, right: 296, top: 20, bottom: 21 },
    { left: 48, right: 296, top: 148, bottom: 149 },
  ];
  const svgBox = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 };
  const boxed = (box) => ({ getBoundingClientRect: () => box });
  const titled = (box, rotated, offset = false) => ({
    getAttribute: () => (rotated ? "rotate(-90 12 84)" : ""),
    getBoundingClientRect: () => box,
    classList: { contains: (name) => offset && name === "chart-offset" },
  });
  const disclosureBoxes = resolvedList.map((box) => titled(box, false, true));

  return {
    document: {
      querySelector: (selector) => {
        if (selector.includes("chart-plot-frame")) return boxed(resolvedFrame);
        if (selector.includes("chart-offset")) return disclosureBoxes[0] ?? null;
        if (selector.includes("svg")) return boxed(svgBox);
        return null;
      },
      querySelectorAll: (selector) => {
        if (selector.includes("chart-grid")) return resolvedGrid.map(boxed);
        if (selector.includes("chart-axes")) {
          const axes = [titled(resolvedYTitle, true), titled(resolvedXTitle, false)];
          for (const box of disclosureBoxes) axes.push(box);

          return axes;
        }
        if (selector.includes("chart-offset")) return disclosureBoxes;
        if (selector.includes("chart-y-ticks")) return resolvedY.map(boxed);
        if (selector.includes("chart-x-ticks")) return resolvedX.map(boxed);
        if (selector.includes("chart-references")) return rects.map(boxed);
        return [];
      },
    },
    window: {},
  };
}

// Gallery probes scope every check to one card, so one clipped card fails the trial.
const EXPECTED_GALLERY_IDS = [
  "chirps_monthly:time_series",
  "era5land_temperature:time_series",
  "terrain:distribution",
];

function galleryCard({
  id = "chirps_monthly:time_series",
  hasSvg = true,
  yBoxes = [
    { left: 20, right: 44, top: 18, bottom: 29 },
    { left: 20, right: 44, top: 100, bottom: 111 },
  ],
  xBoxes = [
    { left: 60, right: 110, top: 152, bottom: 163 },
    { left: 180, right: 230, top: 152, bottom: 163 },
  ],
  references = [],
  bars = [],
  xTitleBoxes = null,
}) {
  const svgBox = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 };
  const plotFrame = { left: 48, right: 296, top: 20, bottom: 148 };
  const grid = [
    { left: 48, right: 296, top: 20, bottom: 21 },
    { left: 48, right: 296, top: 148, bottom: 149 },
  ];
  const yTitleBox = { left: 6, right: 18, top: 45, bottom: 123 };
  const singleTitle = { left: 112, right: 232, top: 168, bottom: 178 };
  const titles = xTitleBoxes ?? [singleTitle];
  const boxed = (box) => ({ getBoundingClientRect: () => box });
  const titled = (box, rotated) => ({
    getAttribute: () => (rotated ? "rotate(-90 12 84)" : ""),
    getBoundingClientRect: () => box,
    classList: { contains: () => false },
  });

  return {
    getAttribute: (name) => (name === "data-chart-id" ? id : null),
    querySelector: (selector) => {
      if (selector === "svg") return hasSvg ? boxed(svgBox) : null;
      if (selector.includes("svg")) return hasSvg ? boxed(svgBox) : null;
      if (selector.includes("chart-plot-frame")) return boxed(plotFrame);
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector.includes("chart-grid")) return grid.map(boxed);
      if (selector.includes("chart-axes")) {
        return [
          titled(yTitleBox, true),
          ...titles.map((box) => titled(box, false)),
        ];
      }
      if (selector.includes("chart-offset")) return [];
      if (selector.includes("chart-y-ticks")) return yBoxes.map(boxed);
      if (selector.includes("chart-x-ticks")) return xBoxes.map(boxed);
      if (selector.includes("chart-references") || selector.includes("chart-endpoints")) {
        return references.map(boxed);
      }
      if (selector.includes("chart-bars")) return bars.map(boxed);
      return [];
    },
  };
}

function unavailableTile(title) {
  return {
    querySelector: (selector) => (
      selector.includes("h4") ? { textContent: title } : null
    ),
  };
}

function gallerySandbox(cards, unavailable = []) {
  return {
    document: {
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector.includes(".gallery-card")) return cards;
        if (selector.includes(".chart-unavailable")) return unavailable;
        return [];
      },
    },
    window: {},
  };
}

function galleryTickSandbox({ yBoxes, xBoxes }) {
  const cards = EXPECTED_GALLERY_IDS.map((id) => galleryCard({
    id,
    yBoxes,
    xBoxes,
  }));

  return gallerySandbox(cards);
}

function galleryReferenceSandbox(rects) {
  const list = Array.isArray(rects) ? rects : [];
  const cards = EXPECTED_GALLERY_IDS.map((id) => galleryCard({
    id,
    references: id === "terrain:distribution" ? list : [],
  }));

  return gallerySandbox(cards);
}

function galleryBarSandbox({ bars, yBoxes }) {
  const cards = EXPECTED_GALLERY_IDS.map((id) => galleryCard({
    id,
    bars: id === "chirps_monthly:time_series" ? bars : [],
    yBoxes,
  }));

  return gallerySandbox(cards);
}

// Runs the attribution probe with every line hit-tested, so cover still fails.
function attributionSandbox({
  lines,
  elementBox = null,
  covered = false,
  style,
  viewport = { width: 1024, height: 768 },
  mainBox = { left: 0, right: 320, top: 0, bottom: 768 },
  hitFor = null,
}) {
  const textNode = { nodeType: 3, textContent: "credit", childNodes: [] };
  const elementRects = elementBox ? [elementBox] : lines;
  const note = {
    childNodes: [textNode],
    getClientRects: () => elementRects,
    contains: (hit) => hit.inside === true,
    checkVisibility: () => style.visibility !== "hidden",
  };
  const fallback = covered ? { inside: false } : { inside: true };

  return {
    document: {
      querySelector: (selector) => {
        if (selector.includes("editor-attribution")) return note;
        if (selector.includes("#scene-full main")) return { getBoundingClientRect: () => mainBox };
        return null;
      },
      createRange: () => {
        let target = null;

        return {
          selectNodeContents: (node) => {
            target = node;
          },
          getClientRects: () => (target === textNode ? lines : []),
        };
      },
      elementFromPoint: (x, y) => {
        if (typeof hitFor === "function") return hitFor(x, y);

        return fallback;
      },
    },
    window: {
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      getComputedStyle: () => style,
    },
  };
}
