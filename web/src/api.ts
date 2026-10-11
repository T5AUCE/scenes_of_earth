import type { Health } from "./types";

// Relative URLs only. Bundle files must be read via the scene's bundle_url, not a hard-coded path.
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export const getHealth = () => getJson<Health>("/api/health");
