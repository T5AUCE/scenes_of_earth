/** Resolves areas and gets finished scene bundles through the app's API, building if needed. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickArea } from "./measure.mjs";

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_POLL_MS = 1000;
const RETRY_AFTER_FALLBACK_SECS = 5;
const LOCAL_SCENES_DIR = fileURLToPath(new URL("../../../data/scenes/", import.meta.url));

/**
 * Returns the scene id of each spot. Spots with the same request share one build, and a bundle
 * that already exists is reused because the backend names it by its request.
 */
export async function ensureScenes(appUrl, spots) {
  const sceneIds = new Map();
  for (const spot of spots) {
    const key = requestKey(spot);
    if (sceneIds.has(key)) continue;

    const existing = process.env.SOE_TRIAL_EXISTING_ONLY === "1";
    const id = existing
      ? existingScene(spot)
      : await buildScene(appUrl, await sceneBody(appUrl, spot));
    sceneIds.set(key, id);
  }

  return spots.map((spot) => sceneIds.get(requestKey(spot)));
}

function existingScene(spot) {
  const directory = process.env.SOE_SCENES_DIR ?? LOCAL_SCENES_DIR;
  const matches = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;

    const file = path.join(directory, entry.name, "scene.json");
    if (!fs.existsSync(file)) continue;

    const scene = JSON.parse(fs.readFileSync(file, "utf8"));
    const boundary = scene.area.boundary;
    const sameArea = boundary?.id === spot.area || boundary?.name === spot.area;
    const hasLayers = spot.layers.every((id) => scene.layers.some((layer) => layer.id === id));
    const samePeriod = (!spot.start || scene.period?.start.startsWith(spot.start))
      && (!spot.end || scene.period?.end.startsWith(spot.end));
    if (sameArea && hasLayers && samePeriod) matches.push(scene);
  }
  matches.sort((first, second) => first.layers.length - second.layers.length
    || second.created.localeCompare(first.created));
  if (!matches.length) throw new Error(`no local built scene for ${spot.area}`);

  return matches[0].id;
}

async function sceneBody(appUrl, spot) {
  const area = await resolveArea(appUrl, spot.area);
  const body = { area: { type: "boundary", id: area.id }, layers: spot.layers };
  if (spot.start) body.start = spot.start;
  if (spot.end) body.end = spot.end;

  return body;
}

async function resolveArea(appUrl, text) {
  const direct = await fetch(`${appUrl}/api/areas/${encodeURIComponent(text)}`);
  if (direct.ok) return direct.json();

  const search = await fetch(`${appUrl}/api/areas/search?q=${encodeURIComponent(text)}`);
  const area = pickArea(await search.json(), text);
  if (!area) throw new Error(`no area matches "${text}"`);

  return area;
}

async function buildScene(appUrl, body) {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  let scene = await postScene(appUrl, body, deadline);
  while (scene.status !== "done") {
    if (scene.status === "failed") throw new Error(`build of ${scene.id} failed: ${scene.error}`);
    console.error(`building ${scene.id}: ${scene.stage ?? scene.status}`);
    await waitWithinDeadline(BUILD_POLL_MS, deadline);
    const response = await fetch(`${appUrl}/api/scenes/${scene.id}`, {
      signal: AbortSignal.timeout(getRemainingMs(deadline)),
    });
    if (!response.ok) throw new Error(`GET /api/scenes/${scene.id} ${response.status}`);

    scene = await response.json();
  }
  getRemainingMs(deadline);

  return scene.id;
}

/** Retries temporary source failures without exceeding the shared build deadline. */
export async function postScene(appUrl, body, deadline) {
  for (;;) {
    const response = await fetch(`${appUrl}/api/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(getRemainingMs(deadline)),
    });
    if (response.status === 503) {
      const delayMs = getRetryDelayMs(response.headers.get("Retry-After"), deadline);
      await response.body?.cancel();
      await waitWithinDeadline(delayMs, deadline);
      continue;
    }
    if (!response.ok) {
      throw new Error(`POST /api/scenes ${response.status}: ${await response.text()}`);
    }

    const scene = await response.json();
    getRemainingMs(deadline);
    return scene;
  }
}

/** Returns the remaining request budget and rejects an expired build before another fetch. */
export function getRemainingMs(deadline, nowMs = Date.now()) {
  const remaining = deadline - nowMs;
  if (remaining <= 0) throw new Error("scene build deadline expired");

  return remaining;
}

/** Caps either form of Retry-After to the build's remaining budget. */
export function getRetryDelayMs(retryAfter, deadline, nowMs = Date.now()) {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const dateMs = Date.parse(retryAfter);
  const requestedMs = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Number.isFinite(dateMs)
      ? Math.max(0, dateMs - nowMs)
      : RETRY_AFTER_FALLBACK_SECS * 1000;

  return Math.min(requestedMs, getRemainingMs(deadline, nowMs));
}

async function waitWithinDeadline(delayMs, deadline) {
  const boundedMs = Math.min(delayMs, getRemainingMs(deadline));
  await new Promise((resolve) => setTimeout(resolve, boundedMs));
  getRemainingMs(deadline);
}

function requestKey(spot) {
  return JSON.stringify([spot.area, spot.layers, spot.start, spot.end]);
}
