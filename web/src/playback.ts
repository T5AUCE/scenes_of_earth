/** Paced playback maths with a hold-then-fade playhead and per-viewer speed. */
export const LOOP_TARGET_MS = 18 * 1000;
export const MIN_STEP_MS = 150;
export const MAX_STEP_MS = 1500;
export const FASTEST_STEP_MS = 60;

export const HOLD_SHARE = 0.5;
export const END_HOLD_MIN_MS = 1000;

export const LOOKAHEAD_WINDOW_MS = 2 * 1000;
export const LOOKAHEAD_MIN = 2;
export const LOOKAHEAD_MAX = 12;
export const STALL_LOADING_MS = 300;

export const PLAY_SPEEDS = [0.5, 1, 2, 4];
export const PLAY_SPEED_KEY = "soe.playspeed.v1";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** One frame of the playhead: the step shown, the step fading in and its weight. */
export interface Playhead {
  index: number;
  next: number;
  mix: number;
}

/** Step duration for a series, slowed or quickened by the viewer's speed. */
export function stepMsFor(count: number, speed: number): number {
  if (!(count > 0)) return MAX_STEP_MS;

  const divisor = speed > 0 ? speed : 1;
  const perStepMs = LOOP_TARGET_MS / count;
  const clampedMs = Math.min(Math.max(perStepMs, MIN_STEP_MS), MAX_STEP_MS);
  const scaledMs = clampedMs / divisor;

  return Math.max(scaledMs, FASTEST_STEP_MS);
}

/** How many positions ahead the clock warms while a step shows. */
export function lookaheadFor(stepMs: number): number {
  if (!(stepMs > 0)) return LOOKAHEAD_MIN;

  const count = Math.ceil(LOOKAHEAD_WINDOW_MS / stepMs);

  return Math.min(Math.max(count, LOOKAHEAD_MIN), LOOKAHEAD_MAX);
}

/**
 * The step the label shows, flipping halfway through the fade so the map and
 * the label stay together while the playhead moves.
 */
export function labelIndexFor(frame: Playhead): number {
  return frame.mix < 0.5 ? frame.index : frame.next;
}

/**
 * Continuous position within the loop to the step shown and its fade weight.
 * Each step holds for HOLD_SHARE, then fades with smoothstep. The last step
 * holds without fading so the newest month never melts into the oldest.
 */
export function playheadAt(
  positionMs: number,
  stepMs: number,
  count: number,
  reducedMotion = false,
): Playhead {
  if (!(count > 1) || !(stepMs > 0)) return { index: 0, next: 0, mix: 0 };

  const loopMs = loopMsFor(stepMs, count);
  const wrappedMs = ((positionMs % loopMs) + loopMs) % loopMs;
  const lastStartMs = (count - 1) * stepMs;
  if (wrappedMs >= lastStartMs) return { index: count - 1, next: 0, mix: 0 };

  const index = Math.floor(wrappedMs / stepMs);
  const progress = (wrappedMs - index * stepMs) / stepMs;
  if (reducedMotion || progress < HOLD_SHARE) return { index, next: index + 1, mix: 0 };

  const fade = (progress - HOLD_SHARE) / (1 - HOLD_SHARE);

  return { index, next: index + 1, mix: smoothstep(fade) };
}

/** Length of one loop: every step holds its time and the last holds a little longer. */
export function loopMsFor(stepMs: number, count: number): number {
  const endHoldMs = Math.max(stepMs, END_HOLD_MIN_MS);

  return Math.max(count - 1, 0) * stepMs + endHoldMs;
}

/** The same point of the loop at another step duration, so a speed change never jumps. */
export function rescalePosition(
  positionMs: number,
  fromStepMs: number,
  toStepMs: number,
  count: number,
): number {
  const lastStartMs = (count - 1) * fromStepMs;
  if (positionMs < lastStartMs) return positionMs * (toStepMs / fromStepMs);

  const fromHoldMs = Math.max(fromStepMs, END_HOLD_MIN_MS);
  const toHoldMs = Math.max(toStepMs, END_HOLD_MIN_MS);

  return (count - 1) * toStepMs + (positionMs - lastStartMs) * (toHoldMs / fromHoldMs);
}

function smoothstep(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1);

  return clamped * clamped * (3 - 2 * clamped);
}

/** Whether the viewer asked for reduced motion, false without a browser. */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof matchMedia !== "function") return false;

    return matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/** Calls back when the viewer changes the setting; returns the way to stop listening. */
export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  try {
    if (typeof matchMedia !== "function") return () => {};

    const media = matchMedia(REDUCED_MOTION_QUERY);
    const listener = () => onChange(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  } catch {
    // Without a browser the playhead keeps its first reading.
    return () => {};
  }
}

/** The viewer's remembered speed, falling back to 1x when storage is blocked. */
export function loadPlaySpeed(): number {
  try {
    const speed = Number(localStorage.getItem(PLAY_SPEED_KEY));

    return PLAY_SPEEDS.includes(speed) ? speed : 1;
  } catch {
    return 1;
  }
}

/** Remember the viewer's speed for this browser only, never for the share link. */
export function storePlaySpeed(speed: number): void {
  try {
    localStorage.setItem(PLAY_SPEED_KEY, String(speed));
  } catch {
    // The speed still applies to this visit. A blocked store is not worth reporting.
  }
}
