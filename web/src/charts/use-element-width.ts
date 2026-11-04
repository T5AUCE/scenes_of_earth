/** Measure an element width with ResizeObserver while staying usable without one. */
import { useEffect, useRef, useState, type RefObject } from "react";

/** Width used before the observer reports, so server and test renders still draw. */
export const FALLBACK_WIDTH_PX = 320;

/**
 * Observe the width of a block element. The fallback keeps charts drawable before the first
 * measurement and where ResizeObserver is unavailable, so layout never depends on the observer.
 */
export function useElementWidth(
  fallbackPx = FALLBACK_WIDTH_PX,
): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallbackPx);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = entry.contentRect.width;
      if (Number.isFinite(next) && next > 0) setWidth(next);
    });
    observer.observe(element);
    const rect = readWidth(element);
    if (rect !== null) setWidth(rect);

    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

function readWidth(element: HTMLDivElement) {
  try {
    const rect = element.getBoundingClientRect();
    if (rect && Number.isFinite(rect.width) && rect.width > 0) return rect.width;
  } catch {
    // A missing layout engine keeps the fallback width instead of throwing.
  }

  return null;
}
