import type {
  AreaFeature,
  AreaHit,
  Health,
  LayersResponse,
  Scene,
  SceneRequest,
  SceneStatus,
} from "./types";

const SCENE_VERSION = "0.4";
const SCENE_ID_CHARS = 20; // Must match ID_CHARS in soe/scene_request.py.
const SCENE_ID_PATTERN = new RegExp(`^[0-9a-f]{${SCENE_ID_CHARS}}$`);

const REQUEST_TIMEOUT_MS = 10 * 1000;
/** Build request timeout; the backend may first wait up to 15 s on the CHIRPS revision lookup. */
export const BUILD_REQUEST_TIMEOUT_MS = 30 * 1000;

/** A failed API response, with its HTTP status and any Retry-After delay. */
export class ApiError extends Error {
  status: number;
  retryAfterSecs?: number; // From the Retry-After header.

  constructor(status: number, message: string, retryAfterSecs?: number) {
    super(message);
    this.status = status;
    this.retryAfterSecs = retryAfterSecs;
  }
}

/** Backend health and version. */
export const getHealth = () => request<Health>("/api/health");

/** The layers the backend can build, with the default selection. */
export const getLayers = () => request<LayersResponse>("/api/layers");

/** Named areas matching the query, optionally at one level only. */
export const searchAreas = (query: string, level: string) =>
  request<AreaHit[]>(searchUrl(query, level));

/** The area search URL; the level is left out when empty. */
export function searchUrl(query: string, level: string) {
  const parameters = new URLSearchParams({ q: query });
  if (level) parameters.set("level", level);
  return `/api/areas/search?${parameters}`;
}

/** Whether text is a scene id, the first SCENE_ID_CHARS hex characters of the backend's hash. */
export const isSceneId = (text: string) => SCENE_ID_PATTERN.test(text);

/** The build status of one scene. */
export const getSceneStatus = (id: string) =>
  request<SceneStatus>(`/api/scenes/${encodeURIComponent(id)}`);

/** One area with its geometry; search hits carry only a bbox, so the outline needs this request. */
export const getArea = (id: string) =>
  request<AreaHit & { geometry: AreaFeature["geometry"] }>(`/api/areas/${encodeURIComponent(id)}`);

/** The area outline (area.geojson) at href. */
export const loadAreaFeature = (href: string) => request<AreaFeature>(href);

/** Submit a scene build request. */
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

/** Hrefs resolve against the bundle URL so the same code works for /scenes/ now and R2 later. */
export async function loadScene(bundleUrl: string): Promise<Scene> {
  const base = new URL(bundleUrl, location.href);
  const scene = await request<Scene>(base.href);
  if (scene.version !== SCENE_VERSION) {
    throw new Error(
      `This scene was made by an older version (format ${scene.version}); pick the area again.`,
    );
  }

  scene.area.geometry_href = new URL(scene.area.geometry_href, base).href;
  scene.data.href = new URL(scene.data.href, base).href;
  return scene;
}

// Relative URLs only. Bundle files must be read via the scene's bundle_url, not a hard-coded path.
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
  const retryAfterSecs = Number(response.headers.get("Retry-After"));
  const message = errorMessage(body?.detail, response.status);

  return new ApiError(response.status, message, retryAfterSecs || undefined);
}

function errorMessage(detail: unknown, status: number) {
  if (typeof detail === "string") return detail;
  // FastAPI validation errors arrive as a list of problems.
  if (Array.isArray(detail)) return detail.map((problem) => problem.msg).join("; ");
  return `HTTP ${status}`;
}
