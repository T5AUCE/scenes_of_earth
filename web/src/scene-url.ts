// The finest step decides whether a link keeps a year, month or day.
const TIME_PATTERN = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/** Where an address points: the world view, or a scene with an optional time and open tab. */
export type Route =
  | { kind: "world" }
  | { kind: "scene"; id: string; time: string | null; panel: string | null };

/** Build a scene link using formatTime's label to keep the finest step's precision. */
export function sceneUrl(id: string, label: string | null) {
  return label ? `?scene=${id}&t=${label}` : `?scene=${id}`;
}

/**
 * Read an address and history entry; the caller must validate the returned id before use.
 */
export function routeFor(search: string, state: { panel?: string } | null): Route {
  const parameters = new URLSearchParams(search);
  const id = parameters.get("scene");
  if (!id) return { kind: "world" };

  const time = parameters.get("t");
  const isTime = time !== null && TIME_PATTERN.test(time);

  return { kind: "scene", id, time: isTime ? time : null, panel: state?.panel ?? null };
}

/** A year, month or day in the link selects the first step that starts in it. */
export function timeForPrefix(times: string[], prefix: string) {
  return times.find((time) => time.startsWith(prefix));
}
