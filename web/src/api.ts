import type { AreaHit, Health, LayersResponse, Scene, SceneRequest, SceneStatus } from "./types";

const SCENE_VERSION = "0.2";

// Relative URLs only. Bundle files must be read via the scene's bundle_url, not a hard-coded path.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number, // seconds, from the Retry-After header
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const retry = Number(res.headers.get("Retry-After"));
    const detail = body?.detail;
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") // FastAPI validation errors
      : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, retry || undefined);
  }
  return res.json();
}

export const getHealth = () => request<Health>("/api/health");
export const getLayers = () => request<LayersResponse>("/api/layers");
export const searchAreas = (q: string, level: string) =>
  request<AreaHit[]>(`/api/areas/search?q=${encodeURIComponent(q)}${level ? `&level=${level}` : ""}`);
export const getSceneStatus = (id: string) => request<SceneStatus>(`/api/scenes/${id}`);
export const postScene = (body: SceneRequest) =>
  request<SceneStatus>("/api/scenes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// Loads scene.json and makes its relative hrefs absolute against the bundle URL (works for /scenes/... now, R2 later).
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
