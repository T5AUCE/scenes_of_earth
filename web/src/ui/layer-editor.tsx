/** Edit one layer in a persistent panel: Show as first, then parts, options and menu sections. */
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { showAsLabel } from "../card-title";
import { recordMenuChange } from "../display-state";
import {
  BLEND,
  type ColourAllocation,
  type Draw,
} from "../layers/allocate";
import {
  menuSections,
  partControls,
  type MenuChange,
} from "../layers/layer-menu";
import type { SceneStore } from "../scene-store";
import {
  displacedOwner,
  showAsOptions,
  storeShowAs,
  type ShowAsAction,
} from "../show-as";
import type { LayerDoc, LayerView, Part } from "../types";
import { DomNode } from "./dom-node";
import { ShowAsSection } from "./show-as-section";
import { useSceneStore } from "./use-scene-store";

const COLOUR_NOTICE = "Only one layer can use colour unless layers are combined.";

/** The unit whose editor is open, with the view that owns its controls. */
export interface EditorTarget {
  unit: string;
  title: string;
  view: LayerView;
}

interface LayerEditorProps {
  target: EditorTarget;
  layers: readonly LayerDoc[];
  store: SceneStore;
  optionStates: Readonly<Record<string, readonly boolean[]>>;
  notice: string | null;
  onOptionChange(unit: string, index: number, on: boolean): void;
  onNotice(text: string | null): void;
  onClose(): void;
}

/** The single editor panel; it swaps contents when another card's Edit is pressed. */
export function LayerEditor({
  target,
  layers,
  store,
  optionStates,
  notice,
  onOptionChange,
  onNotice,
  onClose,
}: LayerEditorProps): React.ReactElement {
  const { display, allocation } = useSceneStore(store);
  const panel = useRef<HTMLElement>(null);
  const { unit, title, view } = target;
  const options = showAsOptions(unit, layers);
  const current = allocation.as.get(unit) ?? display.showAs[unit];

  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);

    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const chooseDraw = (draw: Draw) => {
    const before = store.getSnapshot().allocation;
    const action: ShowAsAction = { kind: "choose", unit, draw };
    store.dispatch(action);
    storeShowAs(unit, draw);
    const after = store.getSnapshot().allocation;
    onNotice(noticeFor(displacedOwner(before, after, action), after, layers));
  };

  const clearNotice = useCallback(() => onNotice(null), [onNotice]);
  const applyMenuChange = useCallback(
    (change: MenuChange) => {
      if (change === "reset") {
        store.dispatch({ kind: "clear", unit });
        storeShowAs(unit, null);
        onNotice(null);
        return;
      }

      store.dispatch({
        kind: "display",
        update: (next) => recordMenuChange(next, unit, view.menu!, change),
      });
      onNotice(null);
    },
    [onNotice, store, unit, view.menu],
  );

  return (
    <aside
      ref={panel}
      className="layer-editor"
      aria-label={`Edit ${title}`}
      tabIndex={-1}
    >
      <header className="editor-head">
        <h2>{title}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <ShowAsSection
        unit={unit}
        options={options}
        current={current}
        notice={notice}
        onChoose={chooseDraw}
      />
      <PartsSection
        view={view}
        display={display}
        store={store}
        onNotice={onNotice}
      />
      <OptionsSection
        unit={unit}
        view={view}
        optionStates={optionStates}
        onOptionChange={onOptionChange}
        onNotice={onNotice}
      />
      {view.menu && (
        <MenuContent
          menu={view.menu}
          unit={unit}
          draw={allocation.as.get(unit)}
          onChange={applyMenuChange}
          onUserInput={clearNotice}
        />
      )}
    </aside>
  );
}

function noticeFor(
  displaced: string | null,
  after: ColourAllocation,
  layers: readonly LayerDoc[],
): string | null {
  if (displaced === null) return null;
  if (displaced === BLEND) return `${COLOUR_NOTICE} The blend is off.`;

  const layer = layers.find(({ id }) => id === displaced);
  const title = layer?.title ?? displaced;
  if (showAsOptions(displaced, layers).length < 2) {
    return `${COLOUR_NOTICE} ${title} is hidden while another layer uses colour.`;
  }

  const draw = after.as.get(displaced);
  return draw ? `${COLOUR_NOTICE} ${title} now shows as ${showAsLabel(draw)}.` : COLOUR_NOTICE;
}

interface PartsSectionProps {
  view: LayerView;
  display: ReturnType<SceneStore["getSnapshot"]>["display"];
  store: SceneStore;
  onNotice(text: string | null): void;
}

function PartsSection({
  view,
  display,
  store,
  onNotice,
}: PartsSectionProps): React.ReactElement | null {
  const clearNotice = useCallback(() => onNotice(null), [onNotice]);
  const hasControls = view.parts.some(({ controls }) => controls !== undefined);
  const hasNote = view.parts.some(({ note }) => note !== undefined);
  if (view.parts.length < 2 && !hasControls && !hasNote) return null;

  const showNames = view.parts.length > 1;

  return (
    <fieldset className="editor-parts">
      <legend>Parts</legend>
      {view.parts.map((part) => (
        <PartRow
          key={part.id}
          part={part}
          checked={!display.off.has(part.id)}
          showName={showNames}
          onToggle={(on) => {
            store.dispatch({ kind: "toggle", unit: part.id, on });
            onNotice(null);
          }}
          onControlChange={clearNotice}
        />
      ))}
    </fieldset>
  );
}

interface PartRowProps {
  part: Part;
  checked: boolean;
  showName: boolean;
  onToggle(on: boolean): void;
  onControlChange(): void;
}

function PartRow({
  part,
  checked,
  showName,
  onToggle,
  onControlChange,
}: PartRowProps): React.ReactElement {
  const [controls, setControls] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!part.controls) {
      setControls(null);
      return;
    }
    const built = partControls(part.controls);
    setControls(built.element);
    const clear = () => onControlChange();
    built.element.addEventListener("input", clear);

    return () => {
      built.element.removeEventListener("input", clear);
      built.dispose();
    };
  }, [part.controls, onControlChange]);

  return (
    <div className="editor-part">
      {showName && (
        <label>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onToggle(event.target.checked)}
          />
          {part.label}
        </label>
      )}
      {part.note && <DomNode node={part.note} />}
      {controls && (
        <div hidden={!checked}>
          <DomNode node={controls} />
        </div>
      )}
    </div>
  );
}

interface OptionsSectionProps {
  unit: string;
  view: LayerView;
  optionStates: Readonly<Record<string, readonly boolean[]>>;
  onOptionChange(unit: string, index: number, on: boolean): void;
  onNotice(text: string | null): void;
}

function OptionsSection({
  unit,
  view,
  optionStates,
  onOptionChange,
  onNotice,
}: OptionsSectionProps): React.ReactElement | null {
  if (view.options.length === 0) return null;

  const states = optionStates[unit] ?? view.options.map(({ initial }) => initial ?? false);

  return (
    <fieldset className="editor-options">
      <legend>Options</legend>
      {view.options.map((option, index) => (
        <div key={option.label} className="editor-option">
          <label>
            <input
              type="checkbox"
              checked={states[index] ?? false}
              onChange={(event) => {
                option.set(event.target.checked);
                onOptionChange(unit, index, event.target.checked);
                onNotice(null);
              }}
            />
            {option.label}
          </label>
          {option.note && <p className="option-note">{option.note}</p>}
        </div>
      ))}
    </fieldset>
  );
}

interface MenuContentProps {
  menu: NonNullable<LayerView["menu"]>;
  unit: string;
  draw: Draw | undefined;
  onChange(changed: MenuChange): void;
  onUserInput(): void;
}

/** Mount the menu sections built by the old menu module inside the React editor. */
function MenuContent({
  menu,
  unit,
  draw,
  onChange,
  onUserInput,
}: MenuContentProps): React.ReactElement {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "menu-sections";
    return element;
  });
  const group = useId();
  const fillRef = useRef<() => void>(() => {});
  const fill = useCallback(() => {
    host.replaceChildren(
      ...menuSections(menu, group, onChange, () => fillRef.current()),
    );
  }, [group, host, menu, onChange]);

  useEffect(() => {
    fillRef.current = fill;
  }, [fill]);

  useEffect(() => {
    fill();
  }, [draw, fill]);

  useEffect(() => {
    const listener = () => fill();
    menu.updates?.addEventListener("change", listener);

    return () => menu.updates?.removeEventListener("change", listener);
  }, [fill, menu.updates]);

  useEffect(() => {
    host.addEventListener("input", onUserInput);
    host.addEventListener("change", onUserInput);

    return () => {
      host.removeEventListener("input", onUserInput);
      host.removeEventListener("change", onUserInput);
    };
  }, [host, onUserInput]);

  useEffect(() => () => host.replaceChildren(), [host]);

  return <DomNode node={host} className="editor-menu" />;
}
