/** Launches headless Chromium and measures a spot at its zooms through the page's MapLibre map. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

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

const VIEWPORT_PX = { width: 1280, height: 800 };
const OUTLINE_LAYER_ID = "soe-area-outline";
const SCENE_READY_TIMEOUT_MS = 90 * 1000;
export const VIEW_TIMEOUT_MS = 60 * 1000;

/** Launches Chromium from the first tool directory that has one. Throws a hint if none does. */
export async function launchBrowser() {
  for (const dir of TOOL_DIRS.filter(Boolean)) {
    const executablePath = findExecutable(path.join(dir, "browsers"));
    if (!executablePath) continue;

    const libs = path.join(dir, LIBS_SUBDIR);
    const libraryPath = [fs.existsSync(libs) ? libs : null, process.env.LD_LIBRARY_PATH];
    return chromium.launch({
      executablePath,
      env: { ...process.env, LD_LIBRARY_PATH: libraryPath.filter(Boolean).join(":") },
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
  }
  throw new Error("no Chromium found; run web/scripts/visual-trial/setup.sh");
}

function findExecutable(browsersDir) {
  if (!fs.existsSync(browsersDir)) return null;

  const entries = fs.readdirSync(browsersDir, { recursive: true });
  const match = entries.find((entry) => path.basename(entry) === BROWSER_NAME);

  return match ? path.join(browsersDir, match) : null;
}

/** Creates a context that exposes map diagnostics and scene readiness without app edits. */
export async function newContext(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT_PX });
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
  const page = await context.newPage();
  const watcher = watchPage(page);
  try {
    await openScene(page, appUrl, sceneId, spot.enable);
    const records = [];
    for (const zoom of spot.zooms) {
      records.push(await trialView(page, watcher, spot, sceneId, zoom, options));
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
  page.on("pageerror", (error) => watcher.messages.push(`pageerror: ${error.message}`));

  return watcher;
}

async function openScene(page, appUrl, sceneId, enable) {
  await page.goto(`${appUrl}/?scene=${sceneId}`);
  await page.waitForFunction(
    (layerId) => window.__map?.getLayer(layerId),
    OUTLINE_LAYER_ID,
    { timeout: SCENE_READY_TIMEOUT_MS },
  );
  for (const label of enable) await page.evaluate(enableCheckbox, label);
}

async function trialView(page, watcher, spot, sceneId, zoom, options) {
  let timedOut = false;
  let sample = null;
  try {
    if (zoom !== "fitted") await page.evaluate(jumpTo, [spot.centre, zoom]);
    ({ sample, timedOut } = await settledSample(page));
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
  if (options.screens) {
    const file = `${slug(spot.name)}-${slug(zoomLabel(zoom))}.png`;
    await page.screenshot({ path: path.join(options.out, file) });
  }

  return record;
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

function jumpTo([centre, zoom]) {
  window.__map.jumpTo({ center: centre, zoom });
}

function enableCheckbox(label) {
  const rows = [...document.querySelectorAll("section.card label")];
  const row = rows.find((candidate) => candidate.textContent.trim() === label);
  if (!row) throw new Error(`no checkbox labelled "${label}"`);
  if (!row.querySelector("input").checked) row.querySelector("input").click();
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
  };
}
