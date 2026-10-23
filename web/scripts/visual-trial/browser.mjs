/** Launches headless Chromium and measures a spot at its zooms through the page's MapLibre map. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { installCache } from "./cache.mjs";
import {
  controlDisplay,
  LAYOUT_CONTROLS,
  LAYOUT_EDITOR,
  layoutRecord,
  layoutViewports,
  requiredInState,
  viewportLabel,
} from "./layout.mjs";
import {
  CONTOUR_LABEL_PATTERN,
  CONTOUR_LINE_PATTERN,
  classifyFailure,
  contourLegend,
  isSettled,
  slug,
  viewRecord,
  zoomLabel,
} from "./measure.mjs";

const TOOL_DIRS = [
  process.env.SOE_TRIAL_BROWSER_DIR,
  path.join(os.homedir(), ".cache/soe-visual-trial"),
  "/tmp/opencode/m5-visual-tools",
];
const BROWSER_NAME = "chrome-headless-shell";
const LIBS_SUBDIR = "libs/usr/lib/x86_64-linux-gnu";

// Headless SwiftShader fails when a display is set because it requests a display surface.
const DISPLAY_ENV_VARS = ["DISPLAY", "WAYLAND_DISPLAY"];

const VIEWPORT_PX = { width: 1280, height: 800 };
const OUTLINE_LAYER_ID = "soe-area-outline";
const SCENE_READY_TIMEOUT_MS = 90 * 1000;
const PAN_DURATION_MS = 2 * 1000;
const PAN_DISTANCE_PX = 160;
const HTTP_CACHE_DIR = path.resolve(import.meta.dirname, "../../.trial-cache/http");
export const VIEW_TIMEOUT_MS = 60 * 1000;

const LANDCOVER_COLOUR = "esa_worldcover";
const BLEND_UNIT = "blend";
const BLEND_HALVES = ["chirps_monthly", "era5land_temperature"];

const ATTRIBUTION_SCOPE = ".maplibregl-ctrl-attrib";
const HIT_TEXT_CHARS = 40; // Clipped element text keeps layout records to one short line.
const BODY_TEXT_CHARS = 200; // Visible app status stays a short excerpt in setup errors.

/** Launches Chromium from the first tool directory that has one. Throws a hint if none does. */
export async function launchBrowser() {
  const { executablePath, directory } = selectedBrowser();

  return chromium.launch({
    executablePath,
    env: launchEnv(path.join(directory, LIBS_SUBDIR)),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
}

/** Returns the selected Chromium executable. Throws a hint when none is installed. */
export function browserExecutable() {
  return selectedBrowser().executablePath;
}

function selectedBrowser() {
  for (const directory of TOOL_DIRS.filter(Boolean)) {
    const executablePath = findExecutable(path.join(directory, "browsers"));
    if (executablePath) return { executablePath, directory };
  }
  throw new Error("no Chromium found; run web/scripts/visual-trial/setup.sh");
}

function launchEnv(libraries) {
  const env = { ...process.env };
  for (const name of DISPLAY_ENV_VARS) delete env[name];
  const libraryPath = [
    fs.existsSync(libraries) ? libraries : null,
    process.env.LD_LIBRARY_PATH,
  ];
  env.LD_LIBRARY_PATH = libraryPath.filter(Boolean).join(":");

  return env;
}

function findExecutable(browsersDir) {
  if (!fs.existsSync(browsersDir)) return null;

  const entries = fs.readdirSync(browsersDir, { recursive: true });
  const match = entries.find((entry) => path.basename(entry) === BROWSER_NAME);

  return match ? path.join(browsersDir, match) : null;
}

/** Probes blank-page WebGL2 before scene work and reports the selected browser. */
export async function preflightWebGL(system = {}) {
  const {
    findPath: find = browserExecutable,
    openBrowser: open = launchBrowser,
    openBlank: openBlank = (browser) => browser.newContext(),
  } = system;
  const executablePath = find();
  const browser = await open();
  try {
    const context = await openBlank(browser);
    try {
      const page = await context.newPage();
      try {
        await page.goto("about:blank");
        const probe = await page.evaluate(checkWebGL2);
        const version = browserVersion(browser);
        const probeLabel = probe.ok ? "ok" : "missing";
        console.error(
          "trial browser",
          executablePath,
          `Chromium ${version} WebGL2 ${probeLabel}`,
        );
        if (probe.ok) return { executablePath, version };

        const hint = "reinstall with web/scripts/visual-trial/setup.sh";
        throw new Error(`WebGL2 unavailable in ${executablePath} (Chromium ${version}); ${hint}`);
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

function browserVersion(browser) {
  if (typeof browser.version === "function") return browser.version();

  return "unknown";
}

function checkWebGL2() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) return { ok: false };

  return { ok: true, version: gl.getParameter(gl.VERSION) };
}

/** Creates a context that exposes map diagnostics and scene readiness without app edits. */
export async function newContext(browser, viewport = VIEWPORT_PX) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(exposeMap);
  await exposeMapModule(context);
  await exposeMaskReadiness(context);
  await exposeLayerReadiness(context);

  return context;
}

async function exposeMapModule(context) {
  await context.route("**/src/map.ts*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const exposed = source.replace(/const map = new (\w+)\(/, "const map = window.__map = new $1(");
    if (exposed === source) throw new Error("src/map.ts no longer creates `const map = new …(`");

    await route.fulfill({ response, body: exposed });
  });
}

async function exposeMaskReadiness(context) {
  await context.route("**/src/scene-mode.ts*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const exposed = source.replace(
      /this\.isReady = true;/,
      "window.__trialMaskReady = true;\nthis.isReady = true;",
    );
    if (exposed === source) throw new Error("scene mask readiness hook no longer matches");

    await route.fulfill({ response, body: exposed });
  });
}

async function exposeLayerReadiness(context) {
  await context.route("**/src/view.ts*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const exposed = source.replace(
      /const layerIds = views\.flatMap/,
      `window.__trialLayersReady = false;
      Promise.all(views.map((view) => view.ready)).then(() => {
        window.__trialLayersReady = views.length === scene.layers.length;
      }).catch((error) => window.__trialErrors.push(String(error)));
      const layerIds = views.flatMap`,
    );
    if (exposed === source) throw new Error("scene layer readiness hook no longer matches");

    await route.fulfill({ response, body: exposed });
  });
}

/** Measures every zoom of the spot in a new page of the context; returns one record per zoom. */
export async function trialSpot(context, appUrl, spot, sceneId, options) {
  if (spot.layout) return trialLayout(context, appUrl, spot, sceneId, options);
  if (spot.landcover) return trialLandcover(context, appUrl, spot, sceneId, options);

  return trialPage(context, appUrl, spot, sceneId, options);
}

async function trialLandcover(context, appUrl, spot, sceneId, options) {
  const records = [];
  for (const renderer of ["gpu", "image"]) {
    const isolated = await newContext(context.browser());
    try {
      await installCache(isolated, HTTP_CACHE_DIR);
      await isolated.addInitScript((mode) => {
        localStorage.setItem("soe.debug.gpu", mode === "image" ? "off" : "on");
        localStorage.removeItem("soe.edges.v1");
      }, renderer);
      records.push(...await trialPage(isolated, appUrl, spot, sceneId, {
        ...options,
        renderer,
      }));
    } finally {
      await isolated.close();
    }
  }
  return records;
}

/** Hit-tests every layout control at each viewport with the editor closed and open. */
export async function trialLayout(context, appUrl, spot, sceneId, options, system = {}) {
  const browser = context.browser();
  const records = [];
  for (const viewport of layoutViewports()) {
    records.push(...await layoutViewport(browser, appUrl, spot, sceneId, viewport, system));
  }
  return records;
}

async function layoutViewport(browser, appUrl, spot, sceneId, viewport, system = {}) {
  const {
    isolateViewport: isolate = (owner, size) => newContext(owner, size),
    warmViewport: warm = (isolated) => installCache(isolated, HTTP_CACHE_DIR),
    watchViewport: watch = (page) => watchPage(page),
    loadViewport: load = (page) => openScene(page, appUrl, sceneId, spot),
    settleViewport: settle = (page) => settledSample(page),
  } = system;
  const isolated = await isolate(browser, viewport);
  try {
    await warm(isolated);
    const page = await isolated.newPage();
    const watcher = await watch(page);
    try {
      await load(page);
      await settle(page);
      const closed = await layoutState(page, viewport, "closed");
      try {
        await openLayoutEditor(page);
      } catch (error) {
        const reason = error.message.split("\n")[0];
        console.error(`layout ${viewportLabel(viewport)} editor failed to open: ${reason}`);
        return [...closed, editorOpeningRecord(viewport)];
      }
      const open = await layoutState(page, viewport, "open");
      return [...closed, ...open];
    } catch (error) {
      throw await layoutSetupError(page, watcher, viewport, error);
    } finally {
      await page.close();
    }
  } finally {
    await isolated.close();
  }
}

async function layoutSetupError(page, watcher, viewport, error) {
  const state = await viewportState(page);
  const reason = error.message.split("\n")[0];
  const lines = [
    `layout ${viewportLabel(viewport)} failed to open: ${reason}`,
    `requests ${JSON.stringify(watcher.failures)}`,
    `console ${JSON.stringify(watcher.messages)}`,
    `state ${JSON.stringify(state)}`,
  ];
  const enriched = new Error(lines.join("\n"));
  enriched.cause = error;

  return enriched;
}

async function viewportState(page) {
  try {
    return await page.evaluate(readViewportState, BODY_TEXT_CHARS);
  } catch {
    return null;
  }
}

function readViewportState(limit) {
  return {
    hasMap: Boolean(window.__map),
    maskReady: window.__trialMaskReady ?? null,
    layersReady: window.__trialLayersReady ?? null,
    mapErrors: window.__trialErrors ?? [],
    bodyText: document.body?.innerText?.slice(0, limit) ?? null,
  };
}

async function layoutState(page, viewport, editor) {
  const records = [];
  for (const control of LAYOUT_CONTROLS) {
    records.push(await hitTestControl(page, viewport, editor, control));
  }
  records.push(...await hitTestAttribution(page, viewport, editor));
  records.push(...await layoutPageChecks(page, viewport, editor));

  return records;
}

export async function hitTestControl(page, viewport, editor, control) {
  const target = controlLocator(page, control).first();
  const required = requiredInState(control, editor);
  if (await target.count() === 0) return absentRecord(viewport, editor, control, required);

  const box = await target.boundingBox();
  if (!box) return absentRecord(viewport, editor, control, required);

  const { pass, hit } = await target.evaluate(containsPoint, [centreOf(box), HIT_TEXT_CHARS]);
  return layoutRecord({
    viewport,
    editor,
    role: control.role,
    name: controlDisplay(control),
    present: true,
    pass,
    hit,
  });
}

export async function hitTestAttribution(page, viewport, editor) {
  const links = page.locator(`${ATTRIBUTION_SCOPE} a`);
  const count = await links.count();
  if (count === 0) {
    return [
      layoutRecord({
        viewport,
        editor,
        role: "link",
        name: "attribution",
        present: false,
        pass: false,
        hit: null,
      }),
    ];
  }
  const records = [];
  for (let index = 0; index < count; index += 1) {
    records.push(await hitTestLink(viewport, editor, links.nth(index)));
  }

  return records;
}

async function hitTestLink(viewport, editor, link) {
  const box = await link.boundingBox();
  const name = ((await link.textContent()) ?? "").trim().replace(/\s+/g, " ");
  if (!box) {
    return layoutRecord({
      viewport,
      editor,
      role: "link",
      name,
      present: false,
      pass: false,
      hit: null,
    });
  }

  const { pass, hit } = await link.evaluate(containsPoint, [centreOf(box), HIT_TEXT_CHARS]);
  return layoutRecord({ viewport, editor, role: "link", name, present: true, pass, hit });
}

async function layoutPageChecks(page, viewport, editor) {
  const overflow = await page.evaluate(hasHorizontalOverflow);
  const attribution = await page.evaluate(seesAttribution, ATTRIBUTION_SCOPE);

  return [
    layoutRecord({
      viewport,
      editor,
      role: "page",
      name: "no horizontal overflow",
      present: true,
      pass: !overflow,
      hit: null,
    }),
    layoutRecord({
      viewport,
      editor,
      role: "page",
      name: "attribution visible",
      present: true,
      pass: attribution,
      hit: null,
    }),
  ];
}

function controlLocator(page, control) {
  const scope = control.scope ? page.locator(control.scope) : page;
  if (control.name === "") return scope.getByRole(control.role);

  return scope.getByRole(control.role, { name: control.name });
}

function centreOf(box) {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

function absentRecord(viewport, editor, control, required) {
  return layoutRecord({
    viewport,
    editor,
    role: control.role,
    name: controlDisplay(control),
    present: false,
    pass: required ? false : null,
    hit: null,
  });
}

// The closed editor cannot supply open-state records, so the opening itself is the failed check.
function editorOpeningRecord(viewport) {
  return layoutRecord({
    viewport,
    editor: "open",
    role: "page",
    name: "editor opens",
    present: false,
    pass: false,
    hit: null,
  });
}

// Rainfall configures Units and Reset, so its editor stands in for every editor.
export async function openLayoutEditor(page) {
  await controlLocator(page, LAYOUT_EDITOR).first().click();
  await page.getByRole("button", { name: "Close" }).first().waitFor();
}

async function trialPage(context, appUrl, spot, sceneId, options) {
  const page = await context.newPage();
  const watcher = watchPage(page);
  try {
    await openScene(page, appUrl, sceneId, spot);
    const records = [];
    for (const [index, zoom] of spot.zooms.entries()) {
      records.push(await trialView(page, watcher, spot, sceneId, zoom, {
        ...options,
        checkContext: spot.landcover && index === 0 && options.renderer === "gpu",
      }));
    }
    return records;
  } catch (error) {
    const mapErrors = await page.evaluate(() => window.__trialErrors ?? []).catch(() => []);
    return [failedRecord(spot, sceneId, error, watcher, mapErrors)];
  } finally {
    await page.close();
  }
}

// MapLibre errors are collected from the moment the map is created, so early failures count too.
function exposeMap() {
  window.__trialErrors = [];
  window.__trialMaskReady = false;
  window.__trialLayersReady = false;
  window.__trialGlErrors = [];
  const getError = WebGL2RenderingContext.prototype.getError;
  WebGL2RenderingContext.prototype.getError = function () {
    const error = getError.call(this);
    if (error !== this.NO_ERROR) window.__trialGlErrors.push(error);
    return error;
  };
  let map;
  Object.defineProperty(window, "__map", {
    configurable: true,
    get: () => map,
    set: (created) => {
      map = created;
      map.on("error", (event) => window.__trialErrors.push(String(event.error?.message ?? event)));
    },
  });
}

function watchPage(page) {
  const watcher = { failures: [], messages: [] };
  page.on("response", (response) => {
    if (response.status() < 400) return;

    const url = response.url();
    watcher.failures.push({ kind: classifyFailure(url), url, status: response.status() });
  });
  page.on("console", (message) => {
    const ignored = /Failed to load resource/.test(message.text());
    if (["error", "warning"].includes(message.type()) && !ignored) {
      watcher.messages.push(`${message.type()}: ${message.text()}`);
    }
  });
  // Transport failures never produce a response, so the network reason is kept instead.
  page.on("requestfailed", (request) => {
    const url = request.url();
    watcher.failures.push({ kind: classifyFailure(url), url, error: requestError(request) });
  });
  page.on("pageerror", (error) => watcher.messages.push(`pageerror: ${error.message}`));

  return watcher;
}

function requestError(request) {
  return request.failure()?.errorText ?? "unknown";
}

// The link carries the supported allocation, because the removed colour= never chose an owner.
async function openScene(page, appUrl, sceneId, spot) {
  await page.goto(`${appUrl}/?scene=${sceneId}${allocationQuery(spot)}`);
  await page.waitForFunction(
    (layerId) => window.__map?.getLayer(layerId),
    OUTLINE_LAYER_ID,
    { timeout: SCENE_READY_TIMEOUT_MS },
  );
  for (const entry of spot.enable) await enableOption(page, entry);
}

// A layer id owns the map's colour through as, while the blend also switches its halves off.
function allocationQuery(spot) {
  const colour = effectiveColour(spot);
  if (colour === null) return "";
  if (colour !== BLEND_UNIT) return `&as=${colour}:colour`;

  const halves = BLEND_HALVES.filter((half) => (spot.layers ?? []).includes(half));
  if (halves.length === 0) return `&as=${BLEND_UNIT}:colour`;

  return `&as=${BLEND_UNIT}:colour&off=${halves.join(",")}`;
}

// Land-cover spots leave Temperature owning colour by default, so they request esa_worldcover.
function effectiveColour(spot) {
  return spot.colour ?? (spot.landcover ? LANDCOVER_COLOUR : null);
}

// Options now live in each layer's editor, so enabling opens that editor first.
async function enableOption(page, entry) {
  const target = typeof entry === "string" ? { option: entry } : entry;
  if (target.layer) {
    await checkEditorOption(page, target.layer, target.option);
    return;
  }
  await checkFirstOption(page, target.option);
}

async function checkEditorOption(page, layer, option) {
  await page.getByRole("button", { name: editButtonName(layer) }).click();
  const menu = page.getByRole("complementary", { name: `Edit ${layer}`, exact: true });
  await menu.getByRole("checkbox", { name: option, exact: true }).check();
  await menu.getByRole("button", { name: "Close", exact: true }).click();
}

async function checkFirstOption(page, option) {
  const edits = page.getByRole("button", { name: /^Edit / });
  const count = await edits.count();
  for (let index = 0; index < count; index += 1) {
    await edits.nth(index).click();
    const menu = page.getByRole("complementary", { name: /^Edit / });
    const box = menu.getByRole("checkbox", { name: option, exact: true });
    if (await box.count() > 0) {
      await box.check();
      await menu.getByRole("button", { name: "Close", exact: true }).click();
      return;
    }
    await menu.getByRole("button", { name: "Close", exact: true }).click();
  }
  throw new Error(`no checkbox labelled "${option}"`);
}

function editButtonName(layer) {
  return new RegExp(`^Edit ${escapeRegExp(layer)}(?: ·|$)`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function trialView(page, watcher, spot, sceneId, zoom, options) {
  let timedOut = false;
  let sample = null;
  try {
    if (zoom !== "fitted") await page.evaluate(jumpTo, [spot.centre, zoom]);
    ({ sample, timedOut } = await settledSample(page));
    const ownerFailure = ownerMismatch(spot, sample);
    if (ownerFailure !== null) {
      watcher.messages.push(ownerFailure);
      timedOut = true;
    }

    if (spot.landcover && sample) {
      await landcoverScreens(page, spot, zoom, options);
      const frameDeltas = await page.evaluate(panFrames, [PAN_DURATION_MS, PAN_DISTANCE_PX]);
      const displayChecks = await checkDisplay(page, options.renderer);
      const contextRestored = options.checkContext ? await checkContextRestore(page) : null;
      const diagnostics = await page.evaluate(() => {
        window.__map.getCanvas().getContext("webgl2").getError();
        return {
          glErrors: [...window.__trialGlErrors],
          landcoverRenderer: document.body.dataset.landcoverRenderer,
        };
      });
      sample = { ...sample, ...diagnostics, frameDeltas, displayChecks, contextRestored };
      const failures = displayFailures(displayChecks, options.renderer);
      if (failures.length > 0) timedOut = true;
      watcher.messages.push(...failures);
    }
    if (spot.colour && sample) {
      const marksFrameDeltas = await page.evaluate(panFrames, [PAN_DURATION_MS, PAN_DISTANCE_PX]);
      sample = { ...sample, marksFrameDeltas };
    }
  } catch (error) {
    watcher.messages.push(`view failed: ${error.message.split("\n")[0]}`);
    timedOut = true;
  }

  const mapErrors = await page.evaluate(() => window.__trialErrors.splice(0));
  const record = viewRecord({
    spot: spot.name,
    scene: sceneId,
    zoom,
    sample: sample && { ...sample, legend: contourLegend(sample.cardText) },
    failures: watcher.failures.splice(0),
    messages: [...watcher.messages.splice(0), ...mapErrors],
    timedOut,
  });
  if (options.screens && !spot.landcover) {
    const file = `${slug(spot.name)}-${slug(zoomLabel(zoom))}.png`;
    await page.screenshot({ path: path.join(options.out, file) });
  }

  return record;
}

// The sampled owner must equal the requested one, or the view measured the wrong layer.
function ownerMismatch(spot, sample) {
  const wanted = effectiveColour(spot);
  if (wanted === null || !sample) return null;
  if (sample.colourOwner === wanted) return null;

  return `colour owner ${sample.colourOwner ?? "none"} is not the requested ${wanted}`;
}

// False repaint readings fail the record, because a hidden layer repaints nothing.
function displayFailures(checks, renderer) {
  const failures = [];
  if (!checks.visibility) failures.push("land cover visibility check did not repaint");
  if (!checks.palette_repaints) failures.push("land cover palette check did not repaint");
  if (renderer === "gpu" && checks.edges_available && !checks.edges_repaint) {
    failures.push("land cover edges check did not repaint");
  }
  if (renderer === "image" && !checks.fallback_note) {
    failures.push("land cover image fallback note is missing");
  }

  return failures;
}

async function landcoverScreens(page, spot, zoom, options) {
  if (!options.screens) return;

  const prefix = `${slug(spot.name)}-${slug(zoomLabel(zoom))}`;
  await page.screenshot({ path: path.join(options.out, `${prefix}-${options.renderer}.png`) });
  if (options.renderer !== "gpu") return;

  await page.getByRole("button", { name: /^Edit Land cover(?: ·|$)/ }).click();
  const rounding = page.getByRole("slider", { name: "Rounding", exact: true });
  if (await rounding.count()) {
    await rounding.fill("0");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(nextFrame);
    await page.screenshot({ path: path.join(options.out, `${prefix}-gpu-rounding-0.png`) });
    await page.getByRole("button", { name: /^Edit Land cover(?: ·|$)/ }).click();
    await rounding.fill("0.25");
  }
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

async function checkDisplay(page, renderer) {
  const card = page.locator("section.card").filter({ hasText: "Land cover" });
  const master = card.getByRole("switch", { name: /^Show Land cover(?: ·|$)/ });
  const before = await page.evaluate(frameHash);
  await master.uncheck();
  const hidden = await page.evaluate(frameHash);
  await master.check();
  const shown = await page.evaluate(frameHash);
  await page.getByRole("button", { name: /^Edit Land cover(?: ·|$)/ }).click();
  const menu = page.getByRole("complementary", { name: "Edit Land cover", exact: true });
  const original = await menu.locator(".palette-choice input[type=radio]:checked").inputValue();
  await menu.getByRole("radio", { name: "ESA", exact: false }).check();
  const recoloured = await page.evaluate(frameHash);
  await menu.locator(`.palette-choice input[type=radio][value="${original}"]`).check();
  const rounding = menu.getByRole("slider", { name: "Rounding", exact: true });
  const hasEdges = await rounding.count() > 0;
  let edgesRepaint = null;
  if (hasEdges) {
    await rounding.fill("0.6");
    await menu.getByRole("slider", { name: "Edge softness", exact: true }).fill("1");
    await menu.getByRole("checkbox", { name: "Faint outline" }).check();
    edgesRepaint = await page.evaluate(frameHash) !== shown;
    await rounding.fill("0.25");
    await menu.getByRole("slider", { name: "Edge softness", exact: true }).fill("0");
    await menu.getByRole("checkbox", { name: "Faint outline" }).uncheck();
  }
  const fallbackNote = await menu.getByText("Edge options need WebGL drawing.", {
    exact: true,
  }).count();
  await menu.getByRole("button", { name: "Close", exact: true }).click();

  return {
    visibility: hidden !== before && shown !== hidden,
    palette_repaints: recoloured !== shown,
    edges_available: hasEdges,
    edges_repaint: edgesRepaint,
    fallback_note: renderer === "image" ? fallbackNote === 1 && !hasEdges : null,
  };
}

async function checkContextRestore(page) {
  const before = await page.evaluate(frameHash);
  const supported = await page.evaluate(restoreContext);
  if (!supported) return "unsupported";

  await settledSample(page);
  const after = await page.evaluate(frameHash);
  const mounted = await page.evaluate(() =>
    document.body.dataset.landcoverRenderer === "gpu"
    && Boolean(window.__map.getLayer("esa_worldcover-classes")),
  );
  return mounted && before === after;
}

async function settledSample(page) {
  const deadline = Date.now() + VIEW_TIMEOUT_MS;
  await page.waitForFunction(
    () => window.__trialMaskReady === true && window.__trialLayersReady === true,
    null,
    { timeout: VIEW_TIMEOUT_MS },
  );
  let previous = null;
  while (Date.now() < deadline) {
    const idle = await page.evaluate(waitForIdle, deadline - Date.now());
    const patterns = [CONTOUR_LINE_PATTERN.source, CONTOUR_LABEL_PATTERN.source];
    const sample = await page.evaluate(takeSample, patterns);
    if (isSettled(previous, sample, idle)) {
      return { sample, timedOut: false };
    }
    previous = sample;
  }

  return { sample: previous, timedOut: true };
}

function failedRecord(spot, sceneId, error, watcher, mapErrors) {
  return viewRecord({
    spot: spot.name,
    scene: sceneId,
    zoom: "fitted",
    sample: null,
    failures: watcher.failures,
    messages: [
      ...watcher.messages,
      ...mapErrors,
      `spot failed: ${error.message.split("\n")[0]}`,
    ],
    timedOut: true,
  });
}

// Playwright serializes these callbacks, so their dependencies must stay inside each function.

function nextFrame() {
  return new Promise((resolve) => {
    window.__map.once("render", () => resolve());
    window.__map.triggerRepaint();
  });
}

function frameHash() {
  const map = window.__map;
  return new Promise((resolve) => {
    map.once("render", () => {
      const canvas = map.getCanvas();
      const gl = canvas.getContext("webgl2");
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let hash = 2166136261;
      for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
      resolve(hash >>> 0);
    });
    map.triggerRepaint();
  });
}

function panFrames([durationMs, distancePx]) {
  const map = window.__map;
  const centre = map.getCenter();
  const start = map.project(centre);
  const end = map.unproject([start.x + distancePx, start.y]);
  const longitudeSpan = end.lng - centre.lng;
  const deltas = [];
  return new Promise((resolve) => {
    let started;
    let previous;
    const frame = (now) => {
      started ??= now;
      if (previous !== undefined) deltas.push(now - previous);
      previous = now;
      const progress = Math.min(1, (now - started) / durationMs);
      const offset = Math.sin(progress * Math.PI * 2) * longitudeSpan;
      map.setCenter([centre.lng + offset, centre.lat]);
      if (progress < 1) return requestAnimationFrame(frame);

      map.setCenter(centre);
      map.once("render", () => resolve(deltas));
      map.triggerRepaint();
    };
    requestAnimationFrame(frame);
  });
}

function restoreContext() {
  const canvas = window.__map.getCanvas();
  const extension = canvas.getContext("webgl2").getExtension("WEBGL_lose_context");
  if (!extension) return false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("context restore timed out")), 10 * 1000);
    canvas.addEventListener("webglcontextlost", () => {
      // Restoration must happen in a later task after all lost-context listeners have run.
      setTimeout(() => extension.restoreContext(), 0);
    }, { once: true });
    canvas.addEventListener("webglcontextrestored", () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
    extension.loseContext();
  });
}

function jumpTo([centre, zoom]) {
  window.__map.jumpTo({ center: centre, zoom });
}

function waitForIdle(timeoutMs) {
  const map = window.__map;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      map.off("idle", onIdle);
      resolve(false);
    }, timeoutMs);
    const onIdle = () => {
      if (map.isMoving()) return;
      clearTimeout(timer);
      map.off("idle", onIdle);
      resolve(true);
    };
    map.on("idle", onIdle);
    map.triggerRepaint();
  });
}

function takeSample([linePattern, labelPattern]) {
  const map = window.__map;
  const layers = map.getStyle().layers;
  const idsOf = (type, pattern) => {
    const matching = layers.filter((layer) => layer.type === type);
    return matching.filter((layer) => new RegExp(pattern).test(layer.id)).map((layer) => layer.id);
  };
  const rendered = (ids) => {
    const unique = new Map();
    const features = ids.length ? map.queryRenderedFeatures({ layers: ids }) : [];
    for (const feature of features) {
      const start = feature.geometry.coordinates[0];
      unique.set(JSON.stringify([feature.layer.id, feature.properties, start]), feature);
    }
    return [...unique.values()];
  };
  const toPixels = ({ geometry }) => {
    const isMulti = geometry.type === "MultiLineString";
    const lines = isMulti ? geometry.coordinates : [geometry.coordinates];
    return lines.map((line) =>
      line.map((point) => {
        const pixel = map.project(point);
        return [pixel.x, pixel.y];
      }),
    );
  };
  const labels = rendered(idsOf("symbol", labelPattern));
  const canvas = map.getCanvas();
  const cards = [...document.querySelectorAll("section.card")];
  // The link carries the normalized allocation, so its as entries name the colour owner.
  const search = window.location?.search ?? "";
  // URLSearchParams is missing from the trial's sandbox, so the query is read by hand.
  const queryParam = (name) => new RegExp(`[?&]${name}=([^&]*)`).exec(search)?.[1] ?? "";
  const off = new Set(queryParam("off").split(",").filter(Boolean));
  let colourOwner = null;
  for (const entry of queryParam("as").split(",").filter(Boolean)) {
    const [unit, draw] = entry.split(":");
    if (draw === "colour" && !off.has(unit)) colourOwner = unit;
    else if (colourOwner === unit) colourOwner = null;
  }

  return {
    zoom: map.getZoom(),
    centre: [canvas.clientWidth / 2, canvas.clientHeight / 2],
    labelCount: labels.length,
    labelLines: labels.flatMap(toPixels),
    lineCount: rendered(idsOf("line", linePattern)).length,
    tilesLoaded: map.areTilesLoaded(),
    sceneReady: window.__trialMaskReady === true && window.__trialLayersReady === true,
    cardText: cards.map((card) => card.innerText).join("\n"),
    classLabels: cards.flatMap((card) =>
      [...card.querySelectorAll(".legend-swatch + span")]
        .filter((label) => label.checkVisibility({ visibilityProperty: true }))
        .map((label) => label.innerText.trim()),
    ),
    colourOwner,
  };
}

function containsPoint(control, [point, limit]) {
  const [pointX, pointY] = point;
  const hit = document.elementFromPoint(pointX, pointY);
  if (!hit) return { pass: false, hit: null };

  const text = (hit.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, limit);
  return {
    pass: control.contains(hit),
    hit: {
      tag: hit.tagName.toLowerCase(),
      id: hit.id || null,
      classes: [...hit.classList],
      text,
    },
  };
}

function hasHorizontalOverflow() {
  return document.documentElement.scrollWidth > window.innerWidth;
}

function seesAttribution(scope) {
  const bar = document.querySelector(scope);
  if (!bar) return false;

  const box = bar.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
}
