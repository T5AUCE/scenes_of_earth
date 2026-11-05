/** Paced playback maths with a hold-then-fade playhead and a per-viewer speed. */
export const LOOP_TARGET_MS = 18 * 1000;
export const MIN_STEP_MS = 150;
export const MAX_STEP_MS = 1500;
export const FASTEST_STEP_MS = 60;

export const HOLD_SHARE = 0.5;
export const END_HOLD_MIN_MS = 1000;

export const LOOKAHEAD_WINDOW_MS = 3 * 1000;
export const LOOKAHEAD_MIN = 2;
export const LOOKAHEAD_MAX = 24;
export const PRIME_STEPS = 2;
export const STALL_LOADING_MS = 300;
export const PREFETCH_LUMP_MAX = 12; // steps a lookahead refill waits for, to share shard reads

export const PACE_MARGIN = 1.15;
export const PACE_SMOOTHING_MS = 1500;
export const PACE_SLOWED_RATIO = 1.25; // slower than this much shows the loading cue
export const PACE_MIN_STEPS = 4;
export const PACE_MEMORY = 0.97; // weight of each earlier arrival when the next one lands
export const PACE_HALF_LIFE_MS = 2 * 1000; // history also halves per this much wall time

export const READS_IN_FLIGHT_PLAYING = 4;
export const READS_IN_FLIGHT_PAUSED = 2;

export const PLAY_SPEEDS = [0.5, 1, 2, 4];
export const PLAY_SPEED_KEY = "soe.playspeed.v1";

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

/** How many missing steps the lookahead gathers before it asks for them, so they share reads. */
export function lumpFor(reach: number): number {
  return Math.min(Math.ceil(reach / 2), PREFETCH_LUMP_MAX);
}

/**
 * The step duration loading sustains, never faster than the viewer chose. The measured time per
 * step is null until enough steps arrived, which leaves the chosen speed unchanged.
 */
export function sustainedStepMs(chosenMs: number, loadMs: number | null): number {
  if (loadMs === null) return chosenMs;

  return Math.max(chosenMs, Math.min(loadMs * PACE_MARGIN, MAX_STEP_MS));
}

/** Moves the step duration part of the way to its target, so pacing changes never jump. */
export function easePaceMs(paceMs: number, targetMs: number, elapsedMs: number): number {
  const share = 1 - Math.exp(-Math.max(elapsedMs, 0) / PACE_SMOOTHING_MS);

  return paceMs + (targetMs - paceMs) * share;
}

/**
 * Time a view spends loading per arrived step. Only time with a read outstanding counts, so a
 * view that is idle because its lookahead is full never looks slow. Time while the tab or view is
 * hidden is left out, one interval counts at most MAX_STEP_MS per outstanding read, and history
 * fades with wall time, so one long stall cannot hold playback slow once reads are fast again.
 */
export class LoadMeter {
  private outstanding = 0;
  private lastMs = 0;
  private busyMs = 0;
  private totalBusyMs = 0;
  private totalSteps = 0;
  private arrived = 0;
  private lastArrivalMs: number | null = null;
  private isCounting = true;

  begin(atMs: number) {
    this.accrue(atMs);
    this.outstanding += 1;
  }

  finish(atMs: number) {
    this.accrue(atMs);
    this.outstanding = Math.max(this.outstanding - 1, 0);
    const idleMs = this.lastArrivalMs === null ? 0 : atMs - this.lastArrivalMs;
    const memory = PACE_MEMORY * 0.5 ** (Math.max(idleMs, 0) / PACE_HALF_LIFE_MS);
    this.totalBusyMs = this.totalBusyMs * memory + this.busyMs;
    this.totalSteps = this.totalSteps * memory + 1;
    this.lastArrivalMs = atMs;
    this.busyMs = 0;
    this.arrived += 1;
  }

  /** Stops or resumes counting time, for a hidden tab or a view the viewer does not see. */
  setCounting(isCounting: boolean, atMs: number) {
    this.accrue(atMs);
    this.isCounting = isCounting;
  }

  /** Busy milliseconds per arrived step, or null before enough steps arrived to tell. */
  stepMs(): number | null {
    if (this.arrived < PACE_MIN_STEPS) return null;

    return this.totalBusyMs / this.totalSteps;
  }

  private accrue(atMs: number) {
    if (this.outstanding > 0 && this.isCounting) {
      this.busyMs += Math.min(atMs - this.lastMs, MAX_STEP_MS * this.outstanding);
    }
    this.lastMs = atMs;
  }
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

function smoothstep(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1);

  return clamped * clamped * (3 - 2 * clamped);
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
