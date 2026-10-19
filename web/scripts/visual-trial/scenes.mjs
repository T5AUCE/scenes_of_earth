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
  let scene = await postScene(appUrl, body);
  while (scene.status !== "done") {
    if (scene.status === "failed") throw new Error(`build of ${scene.id} failed: ${scene.error}`);
    if (Date.now() > deadline) throw new Error(`build of ${scene.id} did not finish in time`);

    console.error(`building ${scene.id}: ${scene.stage ?? scene.status}`);
    await new Promise((resolve) => setTimeout(resolve, BUILD_POLL_MS));
    const response = await fetch(`${appUrl}/api/scenes/${scene.id}`);
    scene = await response.json();
  }

  return scene.id;
}

async function postScene(appUrl, body) {
  for (;;) {
    const response = await fetch(`${appUrl}/api/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 503) {
      const delaySecs = Number(response.headers.get("Retry-After")) || RETRY_AFTER_FALLBACK_SECS;
      await new Promise((resolve) => setTimeout(resolve, delaySecs * 1000));
      continue;
    }
    if (!response.ok) {
      throw new Error(`POST /api/scenes ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }
}

function requestKey(spot) {
  return JSON.stringify([spot.area, spot.layers, spot.start, spot.end]);
}
