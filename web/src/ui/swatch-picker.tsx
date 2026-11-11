/** A reusable radiogroup of colour boxes with a Custom box last. */
export interface SwatchOption {
  value: string;
  label: string;
  /** The CSS colours of the face; empty means the Custom box has no remembered choice yet. */
  colors: string[];
  /** Render the colours as side-by-side blocks instead of one gradient. */
  blocks?: boolean;
}

interface SwatchPickerProps {
  /** The accessible name of the radiogroup, matching the section legend. */
  legend: string;
  /** The radio group name, unique per section. */
  group: string;
  options: SwatchOption[];
  /** The selected option value, or "custom" while a custom choice applies. */
  value: string;
  /** The default option value, named with a " (default)" suffix. */
  defaultValue: string;
  /** Wide two-per-row tiles for gradients and class blocks, else small squares. */
  tiles?: boolean;
  /** Whether to show the selected name below the swatches. */
  showCaption?: boolean;
  onSelect(value: string): void;
}

/** One radio per colour box; the selected box has a ring and a check badge. */
export function SwatchPicker({
  legend,
  group,
  options,
  value,
  defaultValue,
  tiles = false,
  showCaption = true,
  onSelect,
}: SwatchPickerProps): React.ReactElement {
  const selected = options.find((option) => option.value === value);
  return (
    <>
      <div className={tiles ? "swatches tiles" : "swatches"} role="radiogroup" aria-label={legend}>
        {options.map((option) => (
          <SwatchLabel
            key={option.value}
            group={group}
            option={option}
            checked={option.value === value}
            accessibleName={swatchAccessibleName(option, defaultValue)}
            onSelect={onSelect}
          />
        ))}
      </div>
      {showCaption && (
        <div className="swatch-caption" aria-hidden="true">
          {selected ? swatchAccessibleName(selected, defaultValue) : ""}
        </div>
      )}
    </>
  );
}

/** Format an option label for headings and accessible names. */
export function swatchAccessibleName(option: SwatchOption, defaultValue: string): string {
  return option.value === defaultValue ? `${option.label} (default)` : option.label;
}

interface SwatchLabelProps {
  group: string;
  option: SwatchOption;
  checked: boolean;
  accessibleName: string;
  onSelect(value: string): void;
}

function SwatchLabel({
  group,
  option,
  checked,
  accessibleName,
  onSelect,
}: SwatchLabelProps): React.ReactElement {
  return (
    <label className="swatch-option">
      <input
        type="radio"
        name={group}
        value={option.value}
        checked={checked}
        aria-label={accessibleName}
        onChange={() => onSelect(option.value)}
      />
      <SwatchFace option={option} />
      <span className="swatch-check" aria-hidden="true">
        {"\u2713"}
      </span>
      <span className="swatch-tip" aria-hidden="true">
        {accessibleName}
      </span>
    </label>
  );
}

function SwatchFace({ option }: { option: SwatchOption }): React.ReactElement {
  if (option.colors.length === 0) {
    return (
      <span className="swatch-face custom-empty" aria-hidden="true">
        {"+"}
      </span>
    );
  }
  if (option.colors.length === 1 || !option.blocks) {
    return <span className="swatch-face" aria-hidden="true" style={faceStyle(option)} />;
  }

  return (
    <span className="swatch-face swatch-blocks" aria-hidden="true">
      {option.colors.map((color) => (
        <span key={color} style={{ background: color }} />
      ))}
    </span>
  );
}

/** The background of one face: a solid colour or a left-to-right gradient. */
function faceStyle(option: SwatchOption): { background: string } {
  if (option.colors.length === 1) return { background: option.colors[0] };

  return { background: `linear-gradient(to right, ${option.colors.join(", ")})` };
}
