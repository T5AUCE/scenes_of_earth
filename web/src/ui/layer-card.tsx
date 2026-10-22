/** Show one calm card with its legend, descriptive title, master switch and Edit button. */
import { DomNode } from "./dom-node";

interface LayerCardProps {
  title: string;
  checked: boolean;
  onToggle(on: boolean): void;
  onEdit?(button: HTMLButtonElement): void;
  legend: HTMLElement | null;
}

/** One card whose only controls open the editor or switch all of the layer's parts. */
export function LayerCard({
  title,
  checked,
  onToggle,
  onEdit,
  legend,
}: LayerCardProps): React.ReactElement {
  return (
    <section className="card" aria-label={title}>
      <div className="card-head">
        <h4 className="card-title">{title}</h4>
        <label className="card-switch">
          <input
            type="checkbox"
            role="switch"
            checked={checked}
            aria-label={`Show ${title}`}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span className="visually-hidden">Show layer</span>
        </label>
      {onEdit && (
        <button
          type="button"
          className="edit-button"
          aria-label={`Edit ${title}`}
          onClick={(event) => onEdit(event.currentTarget)}
        >
          Edit
        </button>
      )}
      </div>
      {legend && <DomNode node={legend} className="card-legend" />}
    </section>
  );
}
