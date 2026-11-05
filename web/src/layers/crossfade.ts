/** Crossfades two stacked image layers between the painted images of playback steps. */
export const IDLE_TIMEOUT_MS = 50; // longest an image waits for an idle moment before painting

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
    return from === to || (this.isSettled(from) && this.isSettled(to));
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
