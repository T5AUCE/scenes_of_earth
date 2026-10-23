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
  hitTestAttribution,
  hitTestControl,
  layoutPageChecks,
  layoutViewport,
  openLayoutEditor,
  preflightWebGL,
  trialLayout,
} from "./browser.mjs";
import { controlDisplay, LAYOUT_CONTROLS, LAYOUT_EDITOR } from "./layout.mjs";

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
