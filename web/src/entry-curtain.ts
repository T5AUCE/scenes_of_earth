/** A still copy of the map held over it while the scene is staged underneath, then faded out. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { prefersReducedMotion } from "./reduced-motion";

const CURTAIN_CLASS = "entry-curtain";
const FADING_CLASS = "fading";
// A transition that never runs, such as in a hidden tab, must not keep the picture forever.
const FADE_GRACE_MS = 100;

/** The cross-fade and UI slide window, shared with the style sheet through scene-mode. */
export const REVEAL_MS = 650;
// The staged scene is shown after this long even when a tile is slow, so entry never stalls.
const SETTLE_LIMIT_MS = 200;

/** A running reveal; cancelling it finishes every remaining step at once. */
export interface EntryReveal {
  done: Promise<void>;
  cancel(): void;
  retire(): void;
}

type Step = "waiting" | "staged" | "fading" | "done";

/**
 * Copy the next drawn frame over the map, run `stage` in that same task so the swap never
 * shows, wait for the staged scene to settle, then fade the copy out. `onFadeStart` opens the
 * reveal and `onFadeEnd` closes it once the fade completes. Reduced motion skips the copy,
 * so `stage` and both callbacks run at once.
 */
export function revealUnderCurtain(
  map: MapLibreMap,
  stage: () => void,
  onFadeStart: () => void,
  onFadeEnd: () => void,
): EntryReveal {
  let step: Step = "waiting";
  let picture: HTMLCanvasElement | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let finishDone!: () => void;
  const done = new Promise<void>((resolve) => {
    finishDone = resolve;
  });

  if (prefersReducedMotion()) {
    stage();
    onFadeStart();
    step = "done";
    finishDone();
    onFadeEnd();
  } else {
    map.once("render", cover);
    map.on("resize", cancel);
    map.getCanvas().addEventListener("webglcontextlost", cancel);
    map.triggerRepaint();
  }

  return { done, cancel, retire };

  // The copy only works inside the render event, because the drawing buffer is cleared after it.
  function cover() {
    picture = copyMap(map);
    if (picture) map.getCanvasContainer().append(picture);
    stage();
    // A retired curtain stops here, so a replaced entry never stages twice.
    if (step === "done") return;
    step = "staged";
    if (!picture) return fade();

    map.once("idle", fade);
    settleTimer = setTimeout(fade, SETTLE_LIMIT_MS);
  }

  function fade() {
    if (step !== "staged") return;

    step = "fading";
    clearTimeout(settleTimer);
    map.off("idle", fade);
    onFadeStart();
    if (!picture) return finish(true);

    picture.classList.add(FADING_CLASS);
    picture.addEventListener("transitionend", () => finish(true), { once: true });
    fadeTimer = setTimeout(() => finish(true), REVEAL_MS + FADE_GRACE_MS);
  }

  function finish(completed: boolean) {
    if (step === "done") return;

    const faded = completed && step === "fading";
    step = "done";
    clearTimeout(settleTimer);
    clearTimeout(fadeTimer);
    map.off("render", cover);
    map.off("idle", fade);
    map.off("resize", cancel);
    map.getCanvas().removeEventListener("webglcontextlost", cancel);
    picture?.remove();
    finishDone();
    if (faded) onFadeEnd();
  }

  function cancel() {
    if (isFinished()) return;

    if (step === "waiting") stage();
    if (isFinished()) return;
    if (step !== "fading") onFadeStart();
    step = "fading";
    finish(true);
  }

  // Staging may retire this curtain, which the compiler cannot see through the narrowed step.
  function isFinished() {
    return step === "done";
  }

  // A replaced curtain leaves quietly, so its later fade never starts another entry.
  function retire() {
    finish(false);
  }
}

/** Wait a frame so the page paints before heavy work continues. */
export function nextEntryFrame(): Promise<void> {
  return new Promise((done) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => done());
      return;
    }
    setTimeout(done, 0);
  });
}

function copyMap(map: MapLibreMap): HTMLCanvasElement | null {
  const source = map.getCanvas();
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext("2d");
  if (!context) return null;

  context.drawImage(source, 0, 0);
  copy.className = CURTAIN_CLASS;
  copy.style.transitionDuration = `${REVEAL_MS}ms`;

  return copy;
}
