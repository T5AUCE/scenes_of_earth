/** Paced playback maths with a hold-then-fade playhead, per-viewer speed and image crossfade. */
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

export const IDLE_TIMEOUT_MS = 50; // longest an image waits for an idle moment before painting

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

/** The two stacked image layers a crossfade drives; slot 1 is drawn above slot 0. */
export interface FadeLayers {
  setImage(slot: FadeSlot, image: ImageData): void;
  setOpacities(opacities: readonly [number, number]): void;
}

type FadeSlot = 0 | 1;

/**
 * Opacities that fade one image into another while the basemap keeps showing through at exactly
 * 1 - alpha. The incoming image sits on top at alpha * mix and the outgoing one below it.
 */
export function crossfadeOpacities(alpha: number, mix: number) {
  const incoming = alpha * mix;
  const outgoing = 1 - (1 - alpha) / (1 - incoming);

  return { incoming, outgoing };
}

/**
 * Keeps at most two painted images, one per layer, and fades between them. A key names what an
 * image shows, and null stands for nothing, which fades to or from transparent.
 */
export class ImageCrossfade<Key> {
  private readonly alpha: number;
  private readonly layers: FadeLayers;
  private readonly keys: [Key | null, Key | null] = [null, null];
  private applied: readonly [number, number] | null = null;
  private front: FadeSlot = 0;
  private pending: { key: Key; cancel: () => void } | null = null;
  private readonly failed = new Set<Key>();
  private readonly onEvict: (key: Key) => void;

  /** The callback hears of each key whose image is dropped, so data kept per image goes too. */
  constructor(alpha: number, layers: FadeLayers, onEvict: (key: Key) => void = () => {}) {
    this.alpha = alpha;
    this.layers = layers;
    this.onEvict = onEvict;
  }

  /** Whether one of the two images already shows the key. */
  holds(key: Key): boolean {
    return this.slotOf(key) !== null;
  }

  /**
   * Whether a fade from one key to another can run now. It can when both images are painted, and
   * also when either failed to paint, so the clock moves on instead of waiting forever.
   */
  isReady(from: Key | null, to: Key | null): boolean {
    if (from === to) return true;

    const isOutgoingReady = this.isSettled(from);
    return isOutgoingReady && (to === null || this.holds(to) || this.failed.has(to));
  }

  /** Shows the key alone at full opacity without painting, and returns false if none holds it. */
  select(key: Key): boolean {
    const held = this.slotOf(key);
    if (held === null) return false;

    this.front = held;
    this.setFront(this.alpha);
    return true;
  }

  /** Shows the key alone at full opacity, painting it only when neither image holds it. */
  show(key: Key, paint: () => ImageData) {
    if (this.select(key)) return;

    this.put(this.front, key, paint());
    this.setFront(this.alpha);
  }

  /** Paints the key into the hidden image unless one of the two already holds it. */
  arm(key: Key, paint: () => ImageData) {
    if (this.holds(key)) return;

    this.put(this.other(this.front), key, paint());
  }

  /**
   * Paints the key into the hidden image in an idle moment, once. A load that fails marks the key
   * so a fade to it stops waiting, and the draw of that step reports the failure later.
   */
  prepare(key: Key, load: () => Promise<() => ImageData>) {
    if (this.holds(key) || this.pending?.key === key || this.failed.has(key)) return;

    this.cancelPending();
    const pending = { key, cancel: () => {} };
    this.pending = pending;
    pending.cancel = scheduleIdle(() => void this.run(pending, load));
  }

  /**
   * Sets the opacities for a point of the fade from one key to another. Returns false without
   * changing anything when the outgoing image is not painted, and stays on it until the incoming
   * one is. An outgoing image that failed to paint counts as transparent.
   */
  frame(fromKey: Key | null, to: Key | null, mix: number): boolean {
    const from = this.isFailed(fromKey) ? null : fromKey;
    const outgoing = from === null ? null : this.slotOf(from);
    const incoming = to === null ? null : this.slotOf(to);
    if (from !== null && outgoing === null) return false;

    const isFading = from !== to && mix > 0 && (to === null || incoming !== null);
    if (!isFading) return this.hold(from);

    const opacities: [number, number] = [0, 0];
    if (outgoing === null) {
      opacities[incoming!] = this.alpha * mix;
    } else if (incoming === null) {
      opacities[outgoing] = this.alpha * (1 - mix);
    } else if (incoming === 1) {
      const top = crossfadeOpacities(this.alpha, mix);
      opacities[incoming] = top.incoming;
      opacities[outgoing] = top.outgoing;
    } else {
      const top = crossfadeOpacities(this.alpha, 1 - mix);
      opacities[outgoing] = top.incoming;
      opacities[incoming] = top.outgoing;
    }
    this.apply(opacities);
    return true;
  }

  /** Shows nothing while keeping the painted images. */
  hide() {
    this.cancelPending();
    this.apply([0, 0]);
  }

  /** Forgets both images after the colours changed, keeping what shows until a redraw. */
  invalidate() {
    this.cancelPending();
    this.failed.clear();
    for (const slot of [0, 1] as const) this.evict(slot);
  }

  private async run(pending: { key: Key }, load: () => Promise<() => ImageData>) {
    try {
      const paint = await load();
      if (this.pending === pending) this.arm(pending.key, paint);
    } catch {
      // The draw of that step reports the failure when the viewer reaches it.
      if (this.pending === pending) this.failed.add(pending.key);
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  private cancelPending() {
    this.pending?.cancel();
    this.pending = null;
  }

  private hold(key: Key | null): boolean {
    if (key !== null) return this.select(key);

    this.apply([0, 0]);
    return true;
  }

  private setFront(opacity: number) {
    const opacities: [number, number] = [0, 0];
    opacities[this.front] = opacity;
    this.apply(opacities);
  }

  // Skipping unchanged opacities keeps a layer whose step holds from touching the map each frame.
  private apply(opacities: readonly [number, number]) {
    const applied = this.applied;
    if (applied && applied[0] === opacities[0] && applied[1] === opacities[1]) return;

    this.applied = opacities;
    this.layers.setOpacities(opacities);
  }

  private put(slot: FadeSlot, key: Key, image: ImageData) {
    this.evict(slot);
    this.failed.delete(key);
    this.keys[slot] = key;
    this.layers.setImage(slot, image);
  }

  private evict(slot: FadeSlot) {
    const key = this.keys[slot];
    if (key === null) return;

    this.keys[slot] = null;
    this.onEvict(key);
  }

  private isFailed(key: Key | null): boolean {
    return key !== null && this.failed.has(key) && !this.holds(key);
  }

  private isSettled(key: Key | null): boolean {
    return key === null || this.holds(key) || this.failed.has(key);
  }

  private slotOf(key: Key): FadeSlot | null {
    if (this.keys[this.front] === key) return this.front;

    const back = this.other(this.front);
    return this.keys[back] === key ? back : null;
  }

  private other(slot: FadeSlot): FadeSlot {
    return slot === 0 ? 1 : 0;
  }
}

function scheduleIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(id);
  }

  const id = setTimeout(task, 0);
  return () => clearTimeout(id);
}
