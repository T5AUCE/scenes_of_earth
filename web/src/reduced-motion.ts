/** Reads and watches the viewer's reduced-motion setting, which every map animation honours. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

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
