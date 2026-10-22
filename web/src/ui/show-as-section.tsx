/** Offer the Show as radios that choose how a layer draws. */
import { showAsLabel } from "../card-title";
import type { Draw } from "../layers/allocate";

interface ShowAsSectionProps {
  unit: string;
  options: Draw[];
  current: Draw | undefined;
  notice: string | null;
  onChoose(draw: Draw): void;
}

/** A radio group for a unit with two or more draws, with any displacement notice below it. */
export function ShowAsSection({
  unit,
  options,
  current,
  notice,
  onChoose,
}: ShowAsSectionProps): React.ReactElement | null {
  if (options.length < 2) return null;

  return (
    <fieldset className="show-as">
      <legend>Show as</legend>
      <div className="show-as-options">
        {options.map((draw) => (
          <label key={draw}>
            <input
              type="radio"
              name={`show-as-${unit}`}
              value={draw}
              checked={current === draw}
              onChange={() => onChoose(draw)}
            />
            {showAsLabel(draw)}
          </label>
        ))}
      </div>
      {notice && (
        <p className="colour-notice" aria-live="polite">
          {notice}
        </p>
      )}
    </fieldset>
  );
}
