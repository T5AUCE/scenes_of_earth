/** Edit a layer's display range with Low and High on one line. */
import { useEffect, useRef } from "react";

import type { RangeMenu } from "../types";
import { convertRange, convertValue, displayDecimals } from "../units";

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
  // The stored range stays native while the inputs show the chosen display unit.
  const displayUnit = range.displayUnit ?? range.units;
  const shownDecimals = displayDecimals(range.decimals, range.units, displayUnit);
  const shownFitted = shownRange(range.fitted, range.units, displayUnit, shownDecimals);
  const shownValue = range.value
    ? shownRange(range.value, range.units, displayUnit, shownDecimals)
    : null;

  useEffect(() => {
    show(shownValue ?? shownFitted);
    dirty.current = false;
  }, [range, range.fitted, range.value, range.displayUnit]);

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
    const next = typedRange(
      low.current?.value ?? "",
      high.current?.value ?? "",
      range,
      displayUnit,
      shownDecimals,
    );
    if (!next) {
      show(shownValue ?? shownFitted);

      return;
    }

    range.set(next);
    show(shownRange(next, range.units, displayUnit, shownDecimals));
    onChange("range");
  };

  const reset = () => {
    dirty.current = false;
    range.set(null);
    show(shownFitted);
    onChange("range");
  };

  // Uncontrolled inputs keep the DOM behaviour of reverting an invalid edit.
  // Only a dirty edit commits, so an untouched blur keeps the fitted stops.
  return (
    <fieldset className="editor-range">
      <legend>
        {`Display range (${displayUnit}) `}
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
            step={String(10 ** -shownDecimals)}
            defaultValue={String((shownValue ?? shownFitted)[0])}
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
            step={String(10 ** -shownDecimals)}
            defaultValue={String((shownValue ?? shownFitted)[1])}
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
  range: RangeMenu,
  displayUnit: string,
  shownDecimals: number,
): [number, number] | null {
  if (!lowText || !highText) return null;

  const currentNative = range.value ?? range.fitted;
  const currentShown = shownRange(currentNative, range.units, displayUnit, shownDecimals);
  const lowNumber = Number(lowText);
  const highNumber = Number(highText);
  if (!Number.isFinite(lowNumber) || !Number.isFinite(highNumber)) return null;

  // An untouched endpoint keeps its stored native, so display rounding never quantises it.
  const isLowUntouched = lowNumber === currentShown[0];
  const isHighUntouched = highNumber === currentShown[1];
  const nativeLow = isLowUntouched
    ? currentNative[0]
    : convertValue(roundedDisplay(lowNumber, shownDecimals), displayUnit, range.units);
  const nativeHigh = isHighUntouched
    ? currentNative[1]
    : convertValue(roundedDisplay(highNumber, shownDecimals), displayUnit, range.units);

  return Number.isFinite(nativeLow) && Number.isFinite(nativeHigh) && nativeLow < nativeHigh
    ? [nativeLow, nativeHigh]
    : null;
}

function shownRange(
  nativeRange: readonly [number, number],
  nativeUnits: string,
  displayUnit: string,
  shownDecimals: number,
): [number, number] {
  const converted = convertRange(nativeRange, nativeUnits, displayUnit);
  if (nativeUnits === displayUnit) return converted;

  // Inputs show rounded conversions, so long floats never reach the box.
  return [
    roundedDisplay(converted[0], shownDecimals),
    roundedDisplay(converted[1], shownDecimals),
  ];
}

function roundedDisplay(value: number, shownDecimals: number): number {
  return Number(value.toFixed(shownDecimals));
}
