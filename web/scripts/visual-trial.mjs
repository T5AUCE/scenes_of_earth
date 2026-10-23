/**
 * Measures the map of built scenes in headless Chromium and prints one JSON line per spot and
 * zoom. Run it as `npm run trial -- <places.json|preset> --start`; see web/scripts/visual-trial.
 * Exits 1 when any layout check fails.
 */
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { loadPlaces, parseArgs } from "./visual-trial/args.mjs";
import { launchBrowser, newContext, trialSpot } from "./visual-trial/browser.mjs";
import { installCache } from "./visual-trial/cache.mjs";
import { layoutFailed } from "./visual-trial/layout.mjs";
import { ensureScenes } from "./visual-trial/scenes.mjs";
import { startServers, stopServers } from "./visual-trial/servers.mjs";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(WEB_DIR, ".trial-cache");

process.on("SIGINT", () => stopAndExit(130));
process.on("SIGTERM", () => stopAndExit(143));

// Importing the runner must not start a trial, so tests can call runTrial with fakes.
const invokedAsScript = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  try {
    process.exitCode = await runTrial(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await stopServers();
  }
}

/**
 * Runs every spot and returns the exit code. The system argument injects fakes in tests,
 * so the default run uses the live trial modules.
 */
export async function runTrial(options, system = {}) {
  const {
    loadPlaces: readSpots = loadPlaces,
    startServers: bootServers = startServers,
    ensureScenes: resolveScenes = ensureScenes,
    launchBrowser: openBrowser = launchBrowser,
    newContext: openContext = newContext,
    installCache: warmCache = installCache,
    trialSpot: measureSpot = trialSpot,
  } = system;

  const records = [];
  const spots = readSpots(options.places);
  const appUrl = options.start ? await bootServers() : options.app.replace(/\/$/, "");
  const sceneIds = await resolveScenes(appUrl, spots);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = options.out ?? path.join(CACHE_DIR, "runs", stamp);
  fs.mkdirSync(out, { recursive: true });
  const resultsFile = fs.createWriteStream(path.join(out, "results.jsonl"));

  const browser = await openBrowser();
  try {
    const context = await openContext(browser);
    await warmCache(context, path.join(CACHE_DIR, "http"));
    const runOptions = { screens: options.screens, out };
    const jobs = spots.map((spot, index) => async () => {
      for (const record of await measureSpot(context, appUrl, spot, sceneIds[index], runOptions)) {
        const line = JSON.stringify(record);
        console.log(line);
        resultsFile.write(`${line}\n`);
        records.push(record);
      }
    });
    await runLimited(jobs, options.parallel);
  } finally {
    await browser.close();
    resultsFile.end();
    await finished(resultsFile);
  }
  console.error(`results in ${out}`);

  // Contour records carry no present flag, so only layout failures flip the exit.
  return layoutFailed(records) ? 1 : 0;
}

async function runLimited(jobs, limit) {
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await job();
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

async function stopAndExit(code) {
  await stopServers();
  process.exit(code);
}
