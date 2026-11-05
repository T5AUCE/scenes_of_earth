/** Keep the dot positions of the steps a dots fade uses, loading the next one in the background. */

/** Kept for each painted image so the hatch can switch at the fade midpoint without rereading. */
export interface MarksState {
  positions: Uint8Array;
  mask: ArrayLike<number> | null;
  hasHatch: boolean;
}

/** What the fade needs from its layer to load a step's marks and tell when they are drawable. */
export interface MarksSource {
  /** Reads a step's values together with the area mask, queued behind what the map draws. */
  read(step: number): Promise<[Float32Array, ArrayLike<number> | null]>;
  /** Turns read values into marks, or null when the layer no longer draws dots. */
  toMarks(values: Float32Array, mask: ArrayLike<number> | null): MarksState | null;
  /** Whether the dots layer has uploaded these positions. */
  isUploaded(positions: Uint8Array): boolean;
}

/** The marks of each step a dots fade may use, with the steps whose load failed. */
export class MarksFade {
  private readonly source: MarksSource;
  private readonly byStep = new Map<number, MarksState>();
  private readonly failed = new Set<number>();
  private armingStep: number | null = null;

  constructor(source: MarksSource) {
    this.source = source;
  }

  has(step: number): boolean {
    return this.byStep.has(step);
  }

  get(step: number): MarksState | undefined {
    return this.byStep.get(step);
  }

  cache(step: number, state: MarksState) {
    this.failed.delete(step);
    this.byStep.set(step, state);
  }

  delete(step: number) {
    this.byStep.delete(step);
  }

  /** Forgets every step after the colours changed, failed loads included. */
  clear() {
    this.byStep.clear();
    this.failed.clear();
  }

  // Only the two steps in use stay, however far play looks ahead.
  keepOnly(step: number, nextStep: number) {
    for (const cached of this.byStep.keys()) {
      if (cached !== step && cached !== nextStep) this.byStep.delete(cached);
    }
  }

  /** Loads the step's marks once in the background unless they are cached or failed. */
  arm(step: number) {
    const isArmed = step < 0 || this.byStep.has(step) || this.failed.has(step);
    if (isArmed || this.armingStep === step) return;

    this.armingStep = step;
    void this.load(step);
  }

  private async load(step: number) {
    try {
      const [values, mask] = await this.source.read(step);
      const state = this.source.toMarks(values, mask);
      if (state) this.cache(step, state);
    } catch {
      // The draw of that step reports the failure when the viewer reaches it.
      this.failed.add(step);
    } finally {
      if (this.armingStep === step) this.armingStep = null;
    }
  }

  // A fade can start once the next step's bytes are uploaded, or when it failed to load.
  isReady(nextStep: number): boolean {
    if (nextStep < 0 || this.failed.has(nextStep)) return true;

    const state = this.byStep.get(nextStep);
    return state !== undefined && this.source.isUploaded(state.positions);
  }
}
