/** Edit a layer's display range with Low and High on one line. */
import { useEffect, useRef } from "react";

import type { RangeMenu } from "../types";

interface RangeSectionProps {
  range: RangeMenu;
  onChange(change: "range"): void;
}

/** Low and High inputs that share the menu's validation. Reset returns to the fitted range. */
export function RangeSection({
  range,
  onChange,
}: RangeSectionProps): React.ReactElement {
  const low = useRef<HTMLInputElement>(null);
  const high = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);

  useEffect(() => {
    show(range.value ?? range.fitted);
    dirty.current = false;
  }, [range, range.fitted, range.value]);

  // A native listener marks edits, so typing always arms the next blur or Enter.
  useEffect(() => {
    const mark = () => {
      dirty.current = true;
    };
    const lowInput = low.current;
    const highInput = high.current;
    lowInput?.addEventListener("input", mark);
    highInput?.addEventListener("input", mark);

    return () => {
      lowInput?.removeEventListener("input", mark);
      highInput?.removeEventListener("input", mark);
    };
  }, []);

  const show = (values: [number, number]) => {
    if (low.current) low.current.value = String(values[0]);
    if (high.current) high.current.value = String(values[1]);
  };

  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const next = typedRange(low.current?.value ?? "", high.current?.value ?? "", range.decimals);
    if (!next) {
      show(range.value ?? range.fitted);

      return;
    }

    range.set(next);
    show(next);
    onChange("range");
  };

  const reset = () => {
    dirty.current = false;
    range.set(null);
    show(range.fitted);
    onChange("range");
  };

  // Uncontrolled inputs keep the DOM behaviour of reverting an invalid edit.
  // Only a dirty edit commits, so an untouched blur keeps the fitted stops.
  return (
    <fieldset className="editor-range">
      <legend>
        {`Display range (${range.units}) `}
        <button
          type="button"
          className="range-reset"
          aria-label="Reset to this area's range"
          disabled={!range.value}
          onClick={reset}
        >
          Reset
        </button>
      </legend>
      <div className="range-row">
        <label>
          Low
          {" "}
          <input
            ref={low}
            type="number"
            aria-label="Low"
            step={String(10 ** -range.decimals)}
            defaultValue={String((range.value ?? range.fitted)[0])}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
        </label>
        <label>
          High
          {" "}
          <input
            ref={high}
            type="number"
            aria-label="High"
            step={String(10 ** -range.decimals)}
            defaultValue={String((range.value ?? range.fitted)[1])}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
        </label>
      </div>
      <div className="option-note">Values outside the range take the end colour.</div>
    </fieldset>
  );
}

function typedRange(
  lowText: string,
  highText: string,
  decimals: number,
): [number, number] | null {
  const rounded = (text: string) => Number(Number(text).toFixed(decimals));
  if (!lowText || !highText) return null;

  const next: [number, number] = [rounded(lowText), rounded(highText)];

  return Number.isFinite(next[0]) && Number.isFinite(next[1]) && next[0] < next[1]
    ? next
    : null;
}
