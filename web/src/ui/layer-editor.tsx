/** Edit one layer in a persistent panel, with Show as, options and menu sections. */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";

import { drawLabel } from "../card-title";
import {
  DEFAULT_OUTLINE_COLOR,
  MAX_OUTLINE_WIDTH_PX,
  MIN_OUTLINE_WIDTH_PX,
  OUTLINE_COLORS,
  OUTLINE_WIDTH_STEP_PX,
  outlineCss,
  recordMenuChange,
  type OutlineState,
} from "../display-state";
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
import {
  customPalette,
  customStops,
  fieldStops,
  rgbToHex,
  type GradientStop,
} from "../render/palettes";
import type { InkMenu, LayerDoc, LayerMenu, LayerView, Part } from "../types";
import { DomNode } from "./dom-node";
import { GradientStops } from "./gradient-stops";
import { RangeSection } from "./range-section";
import { ShowAsSection } from "./show-as-section";
import { SwatchPicker, type SwatchOption } from "./swatch-picker";
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
  const { unit, title, view } = target;
  const options = showAsOptions(unit, layers);
  const current = allocation.as.get(unit) ?? display.showAs[unit];
  // An off unit leaves no draw while a hidden one holds a reason, so both count as hidden.
  const hidden = typeof allocation.draws.get(unit) !== "string";
  const tabLayer = layers.find(({ id }) => id === unit) ?? { title, units: "" };
  const [fading, setFading] = useState(false);

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
      // Reset restores values such as palette and range but keeps the current Show as choice.
      if (change === "reset") {
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
    <EditorPanel title={title} onClose={onClose}>
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
    </EditorPanel>
  );
}

interface EditorPanelProps {
  title: string;
  onClose(): void;
  children?: React.ReactNode;
}

/** The floating shell every card editor shares: title, Close and Escape handling. */
export function EditorPanel({
  title,
  onClose,
  children,
}: EditorPanelProps): React.ReactElement {
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      // An inner control that already claimed Escape keeps the panel open.
      if (event.key !== "Escape" || event.defaultPrevented) return;

      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);

    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

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
      {children}
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
  const fillRef = useRef<() => void>(() => {});
  const fill = useCallback(() => {
    topHost.replaceChildren(...menuMainSections(menu));
    bottomHost.replaceChildren(menuResetButton(menu, onChange, () => fillRef.current()));
  }, [bottomHost, menu, onChange, topHost]);

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
      <ColourSection menu={menu} onChange={onChange} />
      <DomNode node={topHost} className="editor-menu" />
      {menu.units && <UnitsSection units={menu.units} onChange={onChange} />}
      {menu.range && <RangeSection range={menu.range} onChange={onChange} />}
      <DomNode node={bottomHost} className="editor-menu-reset" />
    </>
  );
}

interface ColourSectionProps {
  menu: NonNullable<LayerView["menu"]>;
  onChange(changed: MenuChange): void;
}

/** The palette or ink swatches; the Custom box keeps its last choice across resets. */
function ColourSection({ menu, onChange }: ColourSectionProps): React.ReactElement {
  const [rememberedPalette, setRememberedPalette] = useState<string | null>(
    () => (customStops(menu.palette) === null ? null : menu.palette),
  );
  const [rememberedInk, setRememberedInk] = useState<string | null>(
    () => (menu.ink && isCustomInk(menu.ink) ? menu.ink.value : null),
  );
  if (menu.ink?.inUse) {
    return (
      <InkSection
        ink={menu.ink}
        remembered={rememberedInk}
        onRemember={setRememberedInk}
        onChange={onChange}
      />
    );
  }

  return (
    <PaletteSection
      menu={menu}
      remembered={rememberedPalette}
      onRemember={setRememberedPalette}
      onChange={onChange}
    />
  );
}

interface PaletteSectionProps {
  menu: NonNullable<LayerView["menu"]>;
  remembered: string | null;
  onRemember(name: string): void;
  onChange(changed: MenuChange): void;
}

function PaletteSection({
  menu,
  remembered,
  onRemember,
  onChange,
}: PaletteSectionProps): React.ReactElement {
  const group = useId();
  const customName = customStops(menu.palette) === null ? null : menu.palette;
  const selected = customName === null ? menu.palette : "custom";
  const faceColors = facePaletteColors(customName, remembered);

  const options: SwatchOption[] = menu.palettes.map(({ name, label, colors }) => ({
    value: name,
    label,
    colors,
    blocks: menu.blocks,
  }));
  if (menu.custom) options.push({ value: "custom", label: "Custom", colors: faceColors });

  const select = (next: string) => {
    if (next !== "custom") {
      menu.setPalette(next);
      onChange("palette");

      return;
    }
    if (customName === null) {
      const seeded = rememberedOrSeeded(remembered, menu.palette);
      menu.setPalette(seeded);
      onRemember(seeded);
      onChange("palette");
    }
  };
  const previewCustom = (stops: GradientStop[]) => {
    menu.setPalette(customPalette(stops));
  };
  const commitCustom = (stops: GradientStop[]) => {
    const next = customPalette(stops);
    menu.setPalette(next);
    onRemember(next);
    onChange("palette");
  };

  return (
    <fieldset className="editor-colours">
      <legend>{menu.heading}</legend>
      <SwatchPicker
        legend={menu.heading}
        group={group}
        options={options}
        value={selected}
        defaultValue={menu.defaultPalette}
        tiles={hasWideFaces(menu)}
        onSelect={select}
      />
      {menu.custom && customName !== null && (
        <GradientStops
          stops={customStops(customName)!}
          onPreview={previewCustom}
          onCommit={commitCustom}
        />
      )}
    </fieldset>
  );
}

interface InkSectionProps {
  ink: InkMenu;
  remembered: string | null;
  onRemember(ink: string): void;
  onChange(changed: MenuChange): void;
}

function InkSection({
  ink,
  remembered,
  onRemember,
  onChange,
}: InkSectionProps): React.ReactElement {
  const group = useId();
  const custom = isCustomInk(ink);
  const selected = custom ? "custom" : ink.value;
  const faceColors = custom ? [ink.value] : remembered ? [remembered] : [];

  const options: SwatchOption[] = ink.presets.map(({ name, label, colors }) => ({
    value: name,
    label,
    colors,
  }));
  options.push({ value: "custom", label: "Custom", colors: faceColors });

  const select = (next: string) => {
    if (next !== "custom") {
      ink.set(next);
      onChange("ink");

      return;
    }
    if (!custom) {
      const seeded = remembered ?? inkSeed(ink);
      ink.set(seeded);
      onRemember(seeded);
      onChange("ink");
    }
  };
  const commitCustom = (next: string) => {
    ink.set(next);
    onRemember(next);
    onChange("ink");
  };

  return (
    <fieldset className="editor-colours">
      <legend>{ink.heading}</legend>
      <SwatchPicker
        legend={ink.heading}
        group={group}
        options={options}
        value={selected}
        defaultValue={ink.defaultInk}
        onSelect={select}
      />
      {custom && <CommitColorInput value={ink.value} label="Ink colour" onCommit={commitCustom} />}
    </fieldset>
  );
}

interface OutlineEditorProps {
  outline: OutlineState;
  onChange(outline: OutlineState): void;
}

/** The Area Outline editor: colour swatches with a Custom well, plus a thickness slider. */
export function OutlineEditor({ outline, onChange }: OutlineEditorProps): React.ReactElement {
  const group = useId();
  const custom = outline.color.startsWith("#");
  const [remembered, setRemembered] = useState<string | null>(
    () => (custom ? outline.color : null),
  );
  const faceColors = custom ? [outline.color] : remembered ? [remembered] : [];

  const options: SwatchOption[] = OUTLINE_COLORS.map(({ name, label, color }) => ({
    value: name,
    label,
    colors: [color],
  }));
  options.push({ value: "custom", label: "Custom", colors: faceColors });

  const setColor = (color: string) => {
    // Choosing a colour while the outline is off shows it again.
    onChange({ ...outline, color, shown: true });
  };
  const select = (next: string) => {
    if (next !== "custom") {
      setColor(next);

      return;
    }
    if (!custom) {
      const seeded = remembered ?? outlineCss(outline.color);
      setRemembered(seeded);
      setColor(seeded);
    }
  };
  const commitCustom = (color: string) => {
    setRemembered(color);
    setColor(color);
  };
  const css = outlineCss(outline.color);

  return (
    <>
      <fieldset className="editor-colours">
        <legend>Colour</legend>
        <SwatchPicker
          legend="Colour"
          group={group}
          options={options}
          value={custom ? "custom" : outline.color}
          defaultValue={DEFAULT_OUTLINE_COLOR}
          onSelect={select}
        />
        {custom && (
          <CommitColorInput value={outline.color} label="Custom colour" onCommit={commitCustom} />
        )}
      </fieldset>
      <fieldset>
        <legend>Thickness</legend>
        <div className="edge-control">
          <output>{`${outline.widthPx} px`}</output>
          <input
            type="range"
            min={MIN_OUTLINE_WIDTH_PX}
            max={MAX_OUTLINE_WIDTH_PX}
            step={OUTLINE_WIDTH_STEP_PX}
            value={outline.widthPx}
            aria-label="Outline thickness"
            aria-valuetext={`${outline.widthPx} pixels`}
            onChange={(event) => onChange({ ...outline, widthPx: Number(event.target.value) })}
          />
          <span className="line-preview" aria-hidden="true">
            <i style={previewStyle(css, outline.widthPx)} />
          </span>
        </div>
      </fieldset>
    </>
  );
}

/** The preview line of the thickness slider, with a ring around white so it stays visible. */
function previewStyle(colorCss: string, widthPx: number): CSSProperties {
  return {
    height: `${widthPx}px`,
    background: colorCss,
    boxShadow: colorCss === "#ffffff" ? "0 0 0 1px #999" : "none",
  };
}

function hasWideFaces(menu: NonNullable<LayerView["menu"]>): boolean {
  return menu.palettes.some(({ colors }) => colors.length > 1);
}

/** The remembered custom gradient, else the one on screen, else an empty Custom box. */
function facePaletteColors(customName: string | null, remembered: string | null): string[] {
  const shown = customName ?? remembered;
  if (shown === null) return [];
  const stops = customStops(shown);
  if (!stops) return [];

  return stops.map(({ at, rgb }) => `${rgbToHex(rgb)} ${Math.round(at * 100)}%`);
}

/** The remembered custom gradient, or a three-stop seed from the shown preset. */
function rememberedOrSeeded(remembered: string | null, palette: string): string {
  if (remembered !== null && customStops(remembered) !== null) return remembered;

  return customPalette(seedStops(palette));
}

// Starting from the gradient on screen keeps the first custom colours familiar.
function seedStops(palette: string): GradientStop[] {
  const gradient = fieldStops(palette) ?? [
    { at: 0, rgb: [0, 0, 0] },
    { at: 1, rgb: [255, 255, 255] },
  ];
  const middle = Math.floor((gradient.length - 1) / 2);

  return [
    { at: 0, rgb: gradient[0].rgb },
    { at: 0.5, rgb: gradient[middle].rgb },
    { at: 1, rgb: gradient[gradient.length - 1].rgb },
  ];
}

/** The first colour of the shown ink preset, so a first Custom choice stays familiar. */
function inkSeed(ink: InkMenu) {
  return ink.presets.find(({ name }) => name === ink.value)?.colors[0] ?? ink.value;
}

function isCustomInk(ink: InkMenu) {
  return ink.value.startsWith("#");
}

function CommitColorInput({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit(color: string): void;
}): React.ReactElement {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.value = value;
    // The picker fires input continuously while dragging, so only change commits.
    const commit = () => onCommit(input.value);
    input.addEventListener("change", commit);

    return () => input.removeEventListener("change", commit);
  }, [value, onCommit]);

  return <input ref={ref} type="color" defaultValue={value} aria-label={label} />;
}

/** A small Units choice for a convertible layer; other layers show nothing. */
function UnitsSection({
  units,
  onChange,
}: {
  units: NonNullable<NonNullable<LayerView["menu"]>["units"]>;
  onChange(changed: MenuChange): void;
}): React.ReactElement {
  const group = useId();

  return (
    <fieldset className="editor-units">
      <legend>Units</legend>
      <div className="units-options">
        {units.options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={group}
              value={option}
              checked={units.value === option}
              onChange={() => {
                units.set(option);
                onChange("units");
              }}
            />
            {option}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
