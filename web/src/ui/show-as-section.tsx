/** Offer the Show as tabs that choose how a layer draws, including Hidden. */
import { showAsLabel, type TitledLayer } from "../card-title";
import type { Draw } from "../layers/allocate";

interface ShowAsSectionProps {
  unit: string;
  options: Draw[];
  current: Draw | undefined;
  hidden: boolean;
  layer: TitledLayer;
  notice: string | null;
  fading: boolean;
  onChoose(draw: Draw): void;
  onHide(): void;
}

/** A tab group for a unit with draws, with Hidden selected while the unit cannot draw. */
export function ShowAsSection({
  unit,
  options,
  current,
  hidden,
  layer,
  notice,
  fading,
  onChoose,
  onHide,
}: ShowAsSectionProps): React.ReactElement | null {
  if (options.length === 0) return null;

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
              checked={!hidden && current === draw}
              onChange={() => onChoose(draw)}
            />
            {showAsLabel(draw, layer)}
          </label>
        ))}
        {/* A checked Hidden fires no change, so an explicit click still switches the unit off. */}
        <label key="hidden">
          <input
            type="radio"
            name={`show-as-${unit}`}
            value="hidden"
            checked={hidden}
            onChange={onHide}
            onClick={() => {
              if (hidden) onHide();
            }}
          />
          Hidden
        </label>
      </div>
      {notice && (
        <p
          className={fading ? "colour-notice fading" : "colour-notice"}
          aria-live="polite"
        >
          {notice}
        </p>
      )}
    </fieldset>
  );
}
