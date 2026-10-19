/**
 * Measures the map of built scenes in headless Chromium and prints one JSON line per spot and
 * zoom. Run it as `npm run trial -- <places.json|preset> --start`; see web/scripts/visual-trial.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaces, parseArgs } from "./visual-trial/args.mjs";
import { launchBrowser, newContext, trialSpot } from "./visual-trial/browser.mjs";
import { installCache } from "./visual-trial/cache.mjs";
import { ensureScenes } from "./visual-trial/scenes.mjs";
import { startServers, stopServers } from "./visual-trial/servers.mjs";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(WEB_DIR, ".trial-cache");

process.on("SIGINT", () => stopAndExit(130));
process.on("SIGTERM", () => stopAndExit(143));

try {
  process.exitCode = await runTrial(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stopServers();
}

async function runTrial(options) {
  const spots = loadPlaces(options.places);
  const appUrl = options.start ? await startServers() : options.app.replace(/\/$/, "");
  const sceneIds = await ensureScenes(appUrl, spots);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = options.out ?? path.join(CACHE_DIR, "runs", stamp);
  fs.mkdirSync(out, { recursive: true });
  const resultsFile = fs.createWriteStream(path.join(out, "results.jsonl"));

  const browser = await launchBrowser();
  try {
    const context = await newContext(browser);
    await installCache(context, path.join(CACHE_DIR, "http"));
    const runOptions = { screens: options.screens, out };
    const jobs = spots.map((spot, index) => async () => {
      for (const record of await trialSpot(context, appUrl, spot, sceneIds[index], runOptions)) {
        const line = JSON.stringify(record);
        console.log(line);
        resultsFile.write(`${line}\n`);
      }
    });
    await runLimited(jobs, options.parallel);
  } finally {
    await browser.close();
    resultsFile.end();
  }
  console.error(`results in ${out}`);

  return 0;
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
