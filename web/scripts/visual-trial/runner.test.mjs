import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { runTrial } from "../visual-trial.mjs";
import {
  hitTestAttribution,
  hitTestControl,
  openLayoutEditor,
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

test("a hidden attribution link fails the record", async () => {
  const link = { boundingBox: async () => null, textContent: async () => "© OpenStreetMap" };
  const [record] = await hitTestAttribution(attributionPage([link]), VIEWPORT_PX, "closed");

  assert.equal(record.role, "link");
  assert.equal(record.present, false);
  assert.equal(record.pass, false);
  assert.equal(record.name, "© OpenStreetMap");
});

test("an empty attribution bar fails the trial", async () => {
  const [record] = await hitTestAttribution(attributionPage([]), VIEWPORT_PX, "open");

  assert.equal(record.present, false);
  assert.equal(record.pass, false);
});

const VIEWPORT_PX = { width: 320, height: 800 };

function trialSystem(recordsBySpot, behaviour = {}) {
  const calls = { closed: 0, measured: 0 };
  return {
    calls,
    system: {
      loadPlaces: () => [{ name: "Layout", layout: true }],
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

function viewportFakes(attempts) {
  return {
    isolateViewport: async (browser, viewport) => {
      attempts.push(viewport);
      return { newPage: async () => missingEditPage(), close: async () => {} };
    },
    warmViewport: async () => {},
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
