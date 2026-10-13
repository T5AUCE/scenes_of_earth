const MONTH_CHARS = 7; // "YYYY-MM"
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Where an address points: the world view, or a scene with an optional month and open tab. */
export type Route =
  | { kind: "world" }
  | { kind: "scene"; id: string; month: string | null; panel: string | null };

/** `time` is a full "YYYY-MM-DD" step start; the link keeps only the month. */
export function sceneUrl(id: string, time: string | null) {
  return time ? `?scene=${id}&t=${time.slice(0, MONTH_CHARS)}` : `?scene=${id}`;
}

/**
 * The route an address points to; the id is returned as typed and checked by the caller before
 * use.
 */
export function routeFor(search: string, state: { panel?: string } | null): Route {
  const parameters = new URLSearchParams(search);
  const id = parameters.get("scene");
  if (!id) return { kind: "world" };

  const month = parameters.get("t");
  const isMonth = month !== null && MONTH_PATTERN.test(month);

  return { kind: "scene", id, month: isMonth ? month : null, panel: state?.panel ?? null };
}

/** A month in the link selects the first step that starts in it. */
export function timeForMonth(times: string[], month: string) {
  return times.find((time) => time.startsWith(month));
}
