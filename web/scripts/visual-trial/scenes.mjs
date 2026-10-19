/** Resolves areas and gets finished scene bundles through the app's API, building if needed. */
import { pickArea } from "./measure.mjs";

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_POLL_MS = 1000;
const RETRY_AFTER_FALLBACK_SECS = 5;

/**
 * Returns the scene id of each spot. Spots with the same request share one build, and a bundle
 * that already exists is reused because the backend names it by its request.
 */
export async function ensureScenes(appUrl, spots) {
  const sceneIds = new Map();
  for (const spot of spots) {
    const key = requestKey(spot);
    if (sceneIds.has(key)) continue;

    sceneIds.set(key, await buildScene(appUrl, await sceneBody(appUrl, spot)));
  }

  return spots.map((spot) => sceneIds.get(requestKey(spot)));
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
