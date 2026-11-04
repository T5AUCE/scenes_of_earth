/** Edit new or saved chart definitions as drafts with live preview and validation. */
import { useEffect, useRef, useState } from "react";

import { INK_COLORS } from "../render/palettes";
import type { SceneStore } from "../scene-store";
import type { LayerDoc, Scene } from "../types";
import { isUnitFor, unitOptions } from "../units";
import { useSceneStore } from "../ui/use-scene-store";
import {
  allowedTypesFor,
  canonicalTableFor,
  chartTypeLabel,
  defaultChartTypeFor,
  defaultOptionsFor,
  isSupportedShape,
  MAX_TITLE_CHARS,
  newChartId,
  validateDefinition,
  type ChartDefinition,
  type ChartOptions,
  type SupportedShape,
} from "./definitions";
import { HypsometryChart } from "./hypsometry-chart";
import { SeriesChart } from "./series-chart";
import { isSeasonalEligible, shapesForLayer } from "./series";
import { validateYRange } from "./ticks";
import { isChartType, type ChartType } from "./table";

/** A draft the editor edits; saving copies it atomically into the store. */
export interface ChartDraft {
  id: string;
  title: string;
  source: { layerId: string; shape: SupportedShape };
  chartType: ChartType;
  options: ChartOptions;
  useAsMain: boolean;
}

/** Props of the takeover editor; drafts never reach storage or links. */
export interface ChartEditorProps {
  scene: Scene;
  store: SceneStore;
  initial: ChartDraft;
  isNew: boolean;
  currentTime: string | null;
  onSave(id: string): void;
  onCancel(): void;
  onDirtyChange?(dirty: boolean): void;
  onRegisterActions?(actions: { save: () => void; discard: () => void } | null): void;
}

/** A fresh draft for the first chartable layer with v2 appearance defaults. */
export function draftForNew(
  layers: readonly LayerDoc[],
  existingIds: readonly string[],
): ChartDraft | null {
  const layer = layers.find((entry) => shapesForLayer(entry).length > 0);
  if (!layer) return null;
  const shape = shapesForLayer(layer)[0];
  const chartType = defaultChartTypeFor(shape, layer.time?.method ?? null);

  return {
    id: newChartId(existingIds),
    title: `${layer.title} chart`,
    source: { layerId: layer.id, shape },
    chartType,
    options: defaultOptionsFor(),
    useAsMain: false,
  };
}

/** A copy of a saved definition for editing without touching the store. */
export function draftForEdit(definition: ChartDefinition): ChartDraft {
  return {
    id: definition.id,
    title: definition.title,
    source: { ...definition.source },
    chartType: definition.chartType,
    options: { ...definition.options },
    useAsMain: false,
  };
}

/**
 * Edit a draft with live preview and validation. Changing the layer or shape keeps only
 * compatible options and explains what was cleared, so the preview never shows stale units.
 */
export function ChartEditor({
  scene,
  store,
  initial,
  isNew,
  currentTime,
  onSave,
  onCancel,
  onDirtyChange,
  onRegisterActions,
}: ChartEditorProps): React.ReactElement {
  const [draft, setDraft] = useState<ChartDraft>(initial);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const confirmSaveRef = useRef<HTMLButtonElement | null>(null);
  const { display } = useSceneStore(store);
  const layers = scene.layers;
  const layer = layers.find((entry) => entry.id === draft.source.layerId) ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (confirming) confirmSaveRef.current?.focus();
  }, [confirming]);
  const viewerUnit = layer ? display.layers[layer.id]?.units ?? null : null;
  const effectivePalette = layer ? display.layers[layer.id]?.palette ?? null : null;
  const effectiveInk = layer ? display.layers[layer.id]?.ink ?? null : null;

  const update = (next: ChartDraft, note: string | null = null) => {
    setDraft(next);
    if (note) setExplanation(note);
    setError(null);
    setConfirming(false);
  };

  const save = () => {
    if (!layer) {
      setError("The chart source layer is missing.");

      return;
    }
    const definition = {
      id: draft.id,
      title: draft.title,
      source: draft.source,
      chartType: draft.chartType,
      options: draft.options,
    };
    const failure = validateDefinition(definition, layers);
    if (failure) {
      setError(failure);

      return;
    }
    try {
      store.dispatch({ kind: "saveChart", definition, makeMain: draft.useAsMain });
    } catch (thrown) {
      setError((thrown as Error).message);

      return;
    }
    onSave(draft.id);
  };

  const discard = () => {
    onCancel();
  };

  const requestBack = () => {
    if (dirty) {
      setConfirming(true);

      return;
    }
    discard();
  };
  useEffect(() => {
    onRegisterActions?.({ save, discard });

    return () => onRegisterActions?.(null);
  });

  return (
    <section className="chart-editor" aria-label={isNew ? "New chart" : "Edit chart"}>
      <header className="editor-head">
        <button type="button" ref={backRef} onClick={requestBack}>
          {"Back to charts"}
        </button>
        <h3>{isNew ? "New chart" : "Edit chart"}</h3>
      </header>
      <div className="editor-body">
        <div className="editor-controls">
          {layerSelect(layers, draft, (next) => update(next, clearedNote(next, draft)))}
          {shapeSelect(layer, draft, (next) => update(next, clearedNote(next, draft)))}
          {typeSelect(draft, (next) => update(next))}
          {titleField(draft, (next) => update(next))}
          {inkField(draft, (next) => update(next))}
          {unitField(layer, draft, (next) => update(next, clearedNote(next, draft)))}
          {axisFields(draft, (next) => update(next))}
          {rangeFields(layer, draft, (next) => update(next))}
          {toggleFields(draft, layer, (next) => update(next))}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.useAsMain}
              onChange={(event) => update({ ...draft, useAsMain: event.target.checked })}
            />
            <span className="checkbox-text">{"Use as main"}</span>
          </label>
          {categoricalNote(layers)}
          {explanation && <p className="chart-note">{explanation}</p>}
          {error && (
            <p className="chart-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="editor-preview">
          {layer
            ? previewFor(layer, draft, currentTime, viewerUnit, effectivePalette, effectiveInk)
            : <p>{"Choose a layer to preview the chart."}</p>}
        </div>
      </div>
      {confirming && (
        <div className="editor-confirm" role="alertdialog" aria-label="Unsaved changes">
          <p>{"This draft has unsaved changes."}</p>
          <button type="button" ref={confirmSaveRef} onClick={save}>
            {"Save"}
          </button>
          <button type="button" onClick={onCancel}>
            {"Discard"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              backRef.current?.focus();
            }}
          >
            {"Keep editing"}
          </button>
        </div>
      )}
      <footer className="editor-foot">
        <button type="button" onClick={onCancel}>
          {"Cancel"}
        </button>
        <button type="button" onClick={save}>
          {"Save"}
        </button>
        <span className="editor-attribution">
          {"Basemap: OpenFreeMap, © OpenMapTiles, data from OpenStreetMap."}
        </span>
      </footer>
    </section>
  );
}

function clearedNote(next: ChartDraft, previous: ChartDraft) {
  if (next.options.displayUnit !== previous.options.displayUnit) {
    return "The display unit was reset because the new layer uses different units.";
  }
  if (next.options.yRange !== previous.options.yRange) {
    return "The y-range was reset because it clipped the new chart.";
  }
  if (next.chartType !== previous.chartType) {
    return "The chart type was reset to the default for the new shape.";
  }

  return null;
}

function layerSelect(
  layers: readonly LayerDoc[],
  draft: ChartDraft,
  onChange: (next: ChartDraft) => void,
) {
  const chartable = layers.filter((layer) => shapesForLayer(layer).length > 0);

  return (
    <label>
      {"Layer"}
      <select
        value={draft.source.layerId}
        onChange={(event) => onChange(withLayer(draft, layers, event.target.value))}
      >
        {chartable.map((layer) => (
          <option key={layer.id} value={layer.id}>
            {layer.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function withLayer(draft: ChartDraft, layers: readonly LayerDoc[], layerId: string): ChartDraft {
  const layer = layers.find((entry) => entry.id === layerId);
  if (!layer) return { ...draft, source: { ...draft.source, layerId } };
  const shapes = shapesForLayer(layer);
  const shape = shapes.includes(draft.source.shape) ? draft.source.shape : shapes[0];
  const next: ChartDraft = {
    ...draft,
    source: { layerId, shape },
    chartType: draft.source.shape === shape
      ? draft.chartType
      : defaultChartTypeFor(shape, layer.time?.method ?? null),
    options: { ...draft.options },
  };

  return compatibleDraft(next, layer);
}

function shapeSelect(
  layer: LayerDoc | null,
  draft: ChartDraft,
  onChange: (next: ChartDraft) => void,
) {
  if (!layer) return null;
  const shapes = shapesForLayer(layer);

  return (
    <label>
      {"Table"}
      <select
        value={draft.source.shape}
        onChange={(event) => {
          const shape = event.target.value;
          if (!isSupportedShape(shape)) return;
          onChange(withShape(draft, layer, shape));
        }}
      >
        {shapes.map((shape) => (
          <option key={shape} value={shape}>
            {shapeLabel(shape)}
          </option>
        ))}
      </select>
    </label>
  );
}

function shapeLabel(shape: SupportedShape) {
  if (shape === "time_series") return "Over time";
  if (shape === "seasonal_cycle") return "By month";

  return "Distribution";
}

function withShape(draft: ChartDraft, layer: LayerDoc, shape: SupportedShape): ChartDraft {
  const next: ChartDraft = {
    ...draft,
    source: { ...draft.source, shape },
    chartType: allowedTypesFor(shape).includes(draft.chartType)
      ? draft.chartType
      : defaultChartTypeFor(shape, layer.time?.method ?? null),
    options: { ...draft.options },
  };

  return compatibleDraft(next, layer);
}

function typeSelect(draft: ChartDraft, onChange: (next: ChartDraft) => void) {
  return (
    <label>
      {"Type"}
      <select
        value={draft.chartType}
        onChange={(event) => {
          const chartType = event.target.value;
          if (!isChartType(chartType)) return;
          onChange({ ...draft, chartType });
        }}
      >
        {allowedTypesFor(draft.source.shape).map((type) => (
          <option key={type} value={type}>
            {chartTypeLabel(type)}
          </option>
        ))}
      </select>
    </label>
  );
}

function titleField(draft: ChartDraft, onChange: (next: ChartDraft) => void) {
  return (
    <label>
      {"Title"}
      <input
        type="text"
        value={draft.title}
        maxLength={MAX_TITLE_CHARS}
        onChange={(event) => onChange({ ...draft, title: event.target.value })}
      />
    </label>
  );
}

function inkField(draft: ChartDraft, onChange: (next: ChartDraft) => void) {
  const ink = draft.options.ink;
  const isCustom = ink !== undefined && !INK_COLORS.some((preset) => preset.name === ink);
  const selectValue = ink === undefined ? "follow" : isCustom ? "custom" : ink;

  return (
    <label>
      {"Series ink"}
      <select
        value={selectValue}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "follow") {
            const { ink: _dropped, ...rest } = draft.options;
            onChange({ ...draft, options: rest });
          } else if (value === "custom") {
            onChange({ ...draft, options: { ...draft.options, ink: "#1a3658" } });
          } else {
            onChange({ ...draft, options: { ...draft.options, ink: value } });
          }
        }}
      >
        <option value="follow">{"Follow layer"}</option>
        {INK_COLORS.map((preset) => (
          <option key={preset.name} value={preset.name}>
            {preset.label}
          </option>
        ))}
        <option value="custom">{"Custom"}</option>
      </select>
      {isCustom && (
        <input
          type="text"
          value={ink}
          pattern="#[0-9a-f]{6}"
          onChange={(event) =>
            onChange({ ...draft, options: { ...draft.options, ink: event.target.value } })}
        />
      )}
    </label>
  );
}

function unitField(
  layer: LayerDoc | null,
  draft: ChartDraft,
  onChange: (next: ChartDraft) => void,
) {
  if (!layer) return null;
  const choices = unitOptions(layer.units);
  if (!choices) return null;

  return (
    <label>
      {"Display unit"}
      <select
        value={draft.options.displayUnit ?? "follow"}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "follow") {
            const { displayUnit: _dropped, ...rest } = draft.options;
            onChange({ ...draft, options: rest });
          } else {
            onChange({ ...draft, options: { ...draft.options, displayUnit: value } });
          }
        }}
      >
        <option value="follow">{"Follow viewer"}</option>
        {choices.map((unit) => (
          <option key={unit} value={unit}>
            {unit}
          </option>
        ))}
      </select>
    </label>
  );
}

function axisFields(draft: ChartDraft, onChange: (next: ChartDraft) => void) {
  return (
    <>
      <label>
        {"X title"}
        <input
          type="text"
          value={draft.options.xTitle ?? ""}
          maxLength={MAX_TITLE_CHARS}
          placeholder="Automatic"
          onChange={(event) =>
            onChange({
              ...draft,
              options: { ...draft.options, xTitle: event.target.value || undefined },
            })}
        />
      </label>
      <label>
        {"Y title"}
        <input
          type="text"
          value={draft.options.yTitle ?? ""}
          maxLength={MAX_TITLE_CHARS}
          placeholder="Automatic"
          onChange={(event) =>
            onChange({
              ...draft,
              options: { ...draft.options, yTitle: event.target.value || undefined },
            })}
        />
      </label>
    </>
  );
}

function rangeFields(
  layer: LayerDoc | null,
  draft: ChartDraft,
  onChange: (next: ChartDraft) => void,
) {
  const automatic = draft.options.yRange == null;
  const low = draft.options.yRange?.[0];
  const high = draft.options.yRange?.[1];

  return (
    <fieldset>
      <legend>{`Y range in ${layer?.units ?? "source units"}`}</legend>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={automatic}
          onChange={(event) =>
            onChange({
              ...draft,
              options: { ...draft.options, yRange: event.target.checked ? null : [0, 1] },
            })}
        />
        <span className="checkbox-text">{"Automatic"}</span>
      </label>
      {!automatic && (
        <>
          <label>
            {"Low"}
            <input
              type="number"
              value={low ?? ""}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                onChange({
                  ...draft,
                  options: { ...draft.options, yRange: [value, high ?? value] },
                });
              }}
            />
          </label>
          <label>
            {"High"}
            <input
              type="number"
              value={high ?? ""}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                onChange({
                  ...draft,
                  options: { ...draft.options, yRange: [low ?? value, value] },
                });
              }}
            />
          </label>
        </>
      )}
    </fieldset>
  );
}

function toggleFields(
  draft: ChartDraft,
  layer: LayerDoc | null,
  onChange: (next: ChartDraft) => void,
) {
  const seasonal = layer ? isSeasonalEligible(layer) : false;
  const showTime = draft.source.shape !== "distribution";

  return (
    <fieldset>
      <legend>{"Display"}</legend>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.options.showGrid ?? true}
          onChange={(event) =>
            onChange({ ...draft, options: { ...draft.options, showGrid: event.target.checked } })}
        />
        <span className="checkbox-text">{"Grid"}</span>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.options.showPoints ?? false}
          onChange={(event) =>
            onChange({
              ...draft,
              options: { ...draft.options, showPoints: event.target.checked },
            })}
        />
        <span className="checkbox-text">{"Point marks"}</span>
      </label>
      {showTime && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.options.showCurrentTime ?? true}
            onChange={(event) =>
              onChange({
                ...draft,
                options: { ...draft.options, showCurrentTime: event.target.checked },
              })}
          />
          <span className="checkbox-text">{seasonal || draft.source.shape === "seasonal_cycle" ? "Current month" : "Current time"}</span>
        </label>
      )}
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.options.showReferences ?? true}
          onChange={(event) =>
            onChange({
              ...draft,
              options: { ...draft.options, showReferences: event.target.checked },
            })}
        />
        <span className="checkbox-text">{"Reference lines"}</span>
      </label>
    </fieldset>
  );
}

function categoricalNote(layers: readonly LayerDoc[]) {
  const hasCategorical = layers.some((layer) => shapesForLayer(layer).length === 0);
  if (!hasCategorical) return null;

  return <p className="chart-note">{"Categorical shares arrive later."}</p>;
}

function previewFor(
  layer: LayerDoc,
  draft: ChartDraft,
  currentTime: string | null,
  viewerUnit: string | null,
  effectivePalette: string | null,
  effectiveInk: string | null,
) {
  if (draft.source.shape === "distribution") {
    return (
      <HypsometryChart
        layer={layer}
        chartType={draft.chartType}
        options={draft.options}
        viewerUnit={viewerUnit}
        effectivePalette={effectivePalette}
        effectiveInk={effectiveInk}
      />
    );
  }

  return (
    <SeriesChart
      layer={layer}
      shape={draft.source.shape}
      chartType={draft.chartType}
      options={draft.options}
      currentTime={currentTime}
      viewerUnit={viewerUnit}
      effectivePalette={effectivePalette}
      effectiveInk={effectiveInk}
    />
  );
}

function compatibleDraft(draft: ChartDraft, layer: LayerDoc) {
  const options = { ...draft.options };
  if (options.displayUnit !== undefined && !isUnitFor(layer.units, options.displayUnit)) {
    delete options.displayUnit;
  }
  if (options.yRange !== undefined && options.yRange !== null) {
    try {
      const table = canonicalTableFor(layer, draft.source.shape);
      const failure = validateYRange(options.yRange, table, draft.chartType, []);
      if (failure) options.yRange = null;
    } catch {
      options.yRange = null;
    }
  }

  return { ...draft, options };
}
