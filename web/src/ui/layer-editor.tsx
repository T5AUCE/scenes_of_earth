/** Edit one layer in a persistent panel, with Show as, options and menu sections. */
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { drawLabel } from "../card-title";
import { recordMenuChange } from "../display-state";
import {
  BLEND,
  type ColourAllocation,
  type Draw,
} from "../layers/allocate";
import {
  menuMainSections,
  menuResetButton,
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
import { RangeSection } from "./range-section";
import { ShowAsSection } from "./show-as-section";
import { useSceneStore } from "./use-scene-store";

const COLOUR_NOTICE = "Only one layer can use colour unless layers are combined.";
const NOTICE_VISIBLE_MS = 3 * 1000;
/** Matches the CSS: a 1 s fade, then a 0.6 s collapse of the gap. */
const NOTICE_FADE_MS = 1600;

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
  onToggleTarget?(on: boolean): void;
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
  onToggleTarget,
}: LayerEditorProps): React.ReactElement {
  const { display, allocation } = useSceneStore(store);
  const panel = useRef<HTMLElement>(null);
  const { unit, title, view } = target;
  const options = showAsOptions(unit, layers);
  const current = allocation.as.get(unit) ?? display.showAs[unit];
  // An off unit leaves no draw while a hidden one holds a reason, so both count as hidden.
  const hidden = typeof allocation.draws.get(unit) !== "string";
  const tabLayer = layers.find(({ id }) => id === unit) ?? { title, units: "" };
  const [fading, setFading] = useState(false);

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

  useEffect(() => {
    if (notice === null) {
      setFading(false);

      return;
    }
    setFading(false);
    const fadeTimer = setTimeout(() => setFading(true), NOTICE_VISIBLE_MS);
    const removeTimer = setTimeout(
      () => onNotice(null),
      NOTICE_VISIBLE_MS + NOTICE_FADE_MS,
    );

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, [notice, onNotice]);

  const chooseDraw = (draw: Draw) => {
    const before = store.getSnapshot().allocation;
    // Choosing a draw while off shows the layer again.
    if (display.off.has(unit)) toggleTarget(true);
    const action: ShowAsAction = { kind: "choose", unit, draw };
    store.dispatch(action);
    storeShowAs(unit, draw);
    const after = store.getSnapshot().allocation;
    onNotice(noticeFor(displacedOwner(before, after, action), after, layers));
  };

  const hideUnit = () => {
    toggleTarget(false);
    onNotice(null);
  };

  const toggleTarget = useCallback((on: boolean) => {
    if (onToggleTarget) {
      onToggleTarget(on);

      return;
    }
    store.dispatch({ kind: "toggle", unit, on });
    // The blend switch remembers its choice because it has no card switch of its own.
    if (unit === BLEND) storeShowAs(BLEND, on ? "colour" : null);
  }, [onToggleTarget, store, unit]);

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
        hidden={hidden}
        layer={tabLayer}
        notice={notice}
        fading={fading}
        onChoose={chooseDraw}
        onHide={hideUnit}
      />
      <OptionsSection
        unit={unit}
        view={view}
        display={display}
        store={store}
        optionStates={optionStates}
        onOptionChange={onOptionChange}
        onNotice={onNotice}
      />
      {view.menu && (
        <MenuContent
          menu={view.menu}
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
  return draw && layer
    ? `${COLOUR_NOTICE} ${title} now shows as ${drawLabel(draw, layer)}.`
    : COLOUR_NOTICE;
}

interface OptionsSectionProps {
  unit: string;
  view: LayerView;
  display: ReturnType<SceneStore["getSnapshot"]>["display"];
  store: SceneStore;
  optionStates: Readonly<Record<string, readonly boolean[]>>;
  onOptionChange(unit: string, index: number, on: boolean): void;
  onNotice(text: string | null): void;
}

function OptionsSection({
  unit,
  view,
  display,
  store,
  optionStates,
  onOptionChange,
  onNotice,
}: OptionsSectionProps): React.ReactElement | null {
  const clearNotice = useCallback(() => onNotice(null), [onNotice]);
  const showNames = view.parts.length > 1;
  const rows = view.parts.filter(
    (part) => showNames || part.controls !== undefined || part.note !== undefined,
  );
  if (view.options.length === 0 && rows.length === 0) return null;

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
      {rows.map((part) => (
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

interface MenuContentProps {
  menu: NonNullable<LayerView["menu"]>;
  draw: Draw | undefined;
  onChange(changed: MenuChange): void;
  onUserInput(): void;
}

/** Mount the menu sections built by the old menu module inside the React editor. */
function MenuContent({
  menu,
  draw,
  onChange,
  onUserInput,
}: MenuContentProps): React.ReactElement {
  const [topHost] = useState(() => {
    const element = document.createElement("div");
    element.className = "menu-sections";
    return element;
  });
  const [bottomHost] = useState(() => document.createElement("div"));
  const group = useId();
  const fillRef = useRef<() => void>(() => {});
  const fill = useCallback(() => {
    topHost.replaceChildren(...menuMainSections(menu, group, onChange));
    bottomHost.replaceChildren(menuResetButton(menu, onChange, () => fillRef.current()));
  }, [bottomHost, group, menu, onChange, topHost]);

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
    for (const host of [topHost, bottomHost]) {
      host.addEventListener("input", onUserInput);
      host.addEventListener("change", onUserInput);
    }

    return () => {
      for (const host of [topHost, bottomHost]) {
        host.removeEventListener("input", onUserInput);
        host.removeEventListener("change", onUserInput);
      }
    };
  }, [bottomHost, onUserInput, topHost]);

  useEffect(() => () => {
    topHost.replaceChildren();
    bottomHost.replaceChildren();
  }, [bottomHost, topHost]);

  return (
    <>
      <DomNode node={topHost} className="editor-menu" />
      {menu.range && <RangeSection range={menu.range} onChange={onChange} />}
      <DomNode node={bottomHost} className="editor-menu-reset" />
    </>
  );
}
