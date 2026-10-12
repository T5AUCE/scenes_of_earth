import type {
  AreaFeature,
  AreaHit,
  Health,
  LayersResponse,
  Scene,
  SceneRequest,
  SceneStatus,
} from "./types";

const SCENE_VERSION = "0.2";
const REQUEST_TIMEOUT_MS = 10_000;
// The backend may wait up to 15 s on the CHIRPS vintage lookup before accepting a build.
export const BUILD_REQUEST_TIMEOUT_MS = 30_000;
const SCENE_ID_PATTERN = /^[0-9a-f]{20}$/;

// Relative URLs only. Bundle files must be read via the scene's bundle_url, not a hard-coded path.
export class ApiError extends Error {
  status: number;
  retryAfter?: number; // seconds, from the Retry-After header

  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const getHealth = () => request<Health>("/api/health");

export const getLayers = () => request<LayersResponse>("/api/layers");

export function searchAreas(query: string, level: string) {
  const levelParameter = level ? `&level=${level}` : "";
  return request<AreaHit[]>(`/api/areas/search?q=${encodeURIComponent(query)}${levelParameter}`);
}

// The backend makes scene ids from the first 20 hex characters of a hash.
export const isSceneId = (text: string) => SCENE_ID_PATTERN.test(text);

export const getSceneStatus = (id: string) =>
  request<SceneStatus>(`/api/scenes/${encodeURIComponent(id)}`);

export const loadAreaFeature = (href: string) => request<AreaFeature>(href);

export const postScene = (body: SceneRequest) =>
  request<SceneStatus>(
    "/api/scenes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    BUILD_REQUEST_TIMEOUT_MS,
  );

// Hrefs resolve against the bundle URL so the same code works for /scenes/ now and R2 later.
export async function loadScene(bundleUrl: string): Promise<Scene> {
  const base = new URL(bundleUrl, location.href);
  const scene = await request<Scene>(base.href);
  if (scene.version !== SCENE_VERSION) {
    throw new Error(`Scene format ${scene.version} is not supported; rebuild this scene.`);
  }

  scene.area.geometry_href = new URL(scene.area.geometry_href, base).href;
  scene.data.href = new URL(scene.data.href, base).href;

  return scene;
}

async function request<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw await apiErrorFrom(response);

  return response.json();
}

async function apiErrorFrom(response: Response) {
  const body = await response.json().catch(() => null);
  const retryAfter = Number(response.headers.get("Retry-After"));
  const message = errorMessage(body?.detail, response.status);

  return new ApiError(response.status, message, retryAfter || undefined);
}

function errorMessage(detail: unknown, status: number) {
  if (typeof detail === "string") return detail;

  // FastAPI validation errors arrive as a list of problems.
  if (Array.isArray(detail)) return detail.map((problem) => problem.msg).join("; ");

  return `HTTP ${status}`;
}
