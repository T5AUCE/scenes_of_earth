/** Gallery of saved chart previews with unavailable placeholders. */
import { useState } from "react";

import type { SceneStore } from "../scene-store";
import type { LayerDoc, Scene } from "../types";
import { useSceneStore } from "../ui/use-scene-store";
import {
  canonicalTableFor,
  creationAvailability,
  resolveMainId,
  unavailableTemplates,
  type ChartDefinition,
} from "./definitions";
import { HypsometryChart } from "./hypsometry-chart";
import { chartNotesFor } from "./notes";
import { SeriesChart } from "./series-chart";
import { unionIntervals } from "./series";

/** Where the gallery sends the viewer; detail and editor keep the same dialog entry. */
export interface ChartGalleryProps {
  scene: Scene;
  store: SceneStore;
  currentTime: string | null;
  onOpenDetail(id: string, focusNotes?: boolean): void;
  onEdit(id: string): void;
  onNew(): void;
  syncNotice?: string | null;
}

/**
 * Show every saved definition with a live preview and labelled placeholders for missing
 * defaults. Time previews share one union domain so shapes stay comparable.
 */
export function ChartGallery({
  scene,
  store,
  currentTime,
  onOpenDetail,
  onEdit,
  onNew,
  syncNotice = null,
}: ChartGalleryProps): React.ReactElement {
  const { charts, display } = useSceneStore(store);
  const layers = scene.layers;
  const mainId = resolveMainId(charts.definitions, charts.mainChartId, layers);
  const availability = creationAvailability(layers);
  const templates = unavailableTemplates(layers);
  const domain = unionDomainFor(layers);

  return (
    <section className="chart-gallery" aria-label="Charts">
      <header className="gallery-head">
        <h3>{"Charts"}</h3>
        <button
          type="button"
          onClick={onNew}
          disabled={!availability.allowed}
          title={availability.reason ?? undefined}
        >
          {"+ New chart"}
        </button>
        <button type="button" onClick={() => store.dispatch({ kind: "resetCharts" })}>
          {"Reset charts"}
        </button>
      </header>
      {!availability.allowed && <p className="chart-note">{availability.reason}</p>}
      {syncNotice && (
        <p className="chart-note" role="status">
          {syncNotice}
        </p>
      )}
      <div className="gallery-grid">
        {charts.definitions.map((definition) => (
          <GalleryCard
            key={definition.id}
            scene={scene}
            store={store}
            definition={definition}
            isMain={definition.id === mainId}
            currentTime={currentTime}
            viewerUnit={viewerUnitFor(display, definition, layers)}
            effectivePalette={effectivePaletteFor(display, definition, layers)}
            effectiveInk={effectiveInkFor(display, definition, layers)}
            xDomain={domain}
            onOpen={() => onOpenDetail(definition.id)}
            onOpenNotes={() => onOpenDetail(definition.id, true)}
            onEdit={() => onEdit(definition.id)}
          />
        ))}
        {templates.map((template) => (
          <article key={template.title} className="chart-unavailable">
            <h4>{template.title}</h4>
            <p>{template.reason}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function viewerUnitFor(
  display: { layers: Record<string, { units?: string }> },
  definition: ChartDefinition,
  layers: readonly LayerDoc[],
) {
  const layer = layers.find((entry) => entry.id === definition.source.layerId);
  if (!layer) return null;

  return display.layers[layer.id]?.units ?? null;
}

function effectivePaletteFor(
  display: { layers: Record<string, { palette?: string }> },
  definition: ChartDefinition,
  layers: readonly LayerDoc[],
) {
  const layer = layers.find((entry) => entry.id === definition.source.layerId);
  if (!layer) return null;

  return display.layers[layer.id]?.palette ?? layer.style.palette ?? null;
}

function effectiveInkFor(
  display: { layers: Record<string, { ink?: string }> },
  definition: ChartDefinition,
  layers: readonly LayerDoc[],
) {
  const layer = layers.find((entry) => entry.id === definition.source.layerId);
  if (!layer) return null;

  return display.layers[layer.id]?.ink ?? null;
}

function unionDomainFor(layers: readonly LayerDoc[]): [number, number] | null {
  const intervals = unionIntervals(layers);
  if (intervals.length === 0) return null;
  const first = Date.parse(intervals[0].start);
  const last = Date.parse(intervals[intervals.length - 1].start);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;

  return [first, last];
}

interface GalleryCardProps {
  scene: Scene;
  store: SceneStore;
  definition: ChartDefinition;
  isMain: boolean;
  currentTime: string | null;
  viewerUnit: string | null;
  effectivePalette: string | null;
  effectiveInk: string | null;
  xDomain: [number, number] | null;
  onOpen(): void;
  onOpenNotes(): void;
  onEdit(): void;
}

function GalleryCard({
  scene,
  store,
  definition,
  isMain,
  currentTime,
  viewerUnit,
  effectivePalette,
  effectiveInk,
  xDomain,
  onOpen,
  onOpenNotes,
  onEdit,
}: GalleryCardProps): React.ReactElement {
  const layer = scene.layers.find((entry) => entry.id === definition.source.layerId);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const setMain = () => {
    store.dispatch({ kind: "setMain", id: definition.id });
    setConfirmation(
      `${definition.title} is now the main chart in the scene panel's Charts tab.`,
    );
  };
  const notes = notesFor(layer ?? null, definition);

  return (
    <article className="gallery-card" data-chart-id={definition.id}>
      <h4>
        <button type="button" onClick={onOpen}>
          {definition.title}
        </button>
        {isMain && <span className="chart-main-badge">{"Main"}</span>}
        {notes.length > 0 && (
          <button
            type="button"
            className="chart-notes-button"
            aria-label={`Notes for ${definition.title}; opens chart detail`}
            onClick={onOpenNotes}
          >
            {"Notes"}
          </button>
        )}
      </h4>
      <div className="gallery-preview" onClick={onOpen} onKeyDown={previewKey(onOpen)}>
        {layer && previewFor(
          layer,
          definition,
          currentTime,
          viewerUnit,
          effectivePalette,
          effectiveInk,
          xDomain,
        )}
      </div>
      <div className="gallery-actions">
        <button type="button" onClick={onOpen}>
          {"Open"}
        </button>
        <button type="button" onClick={onEdit}>
          {"Edit"}
        </button>
        <button type="button" onClick={setMain} disabled={isMain}>
          {"Use as main"}
        </button>
      </div>
      {confirmation && <p role="status">{confirmation}</p>}
    </article>
  );
}

function notesFor(layer: LayerDoc | null, definition: ChartDefinition): string[] {
  if (!layer) return [];
  try {
    const canonical = canonicalTableFor(layer, definition.source.shape);

    return chartNotesFor(layer, canonical, definition.chartType);
  } catch {
    return [];
  }
}

function previewKey(onOpen: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };
}

function previewFor(
  layer: LayerDoc,
  definition: ChartDefinition,
  currentTime: string | null,
  viewerUnit: string | null,
  effectivePalette: string | null,
  effectiveInk: string | null,
  xDomain: [number, number] | null,
) {
  if (definition.source.shape === "distribution") {
    return (
      <HypsometryChart
        layer={layer}
        chartType={definition.chartType}
        options={definition.options}
        showTable={false}
        showNotes={false}
        viewerUnit={viewerUnit}
        effectivePalette={effectivePalette}
        effectiveInk={effectiveInk}
      />
    );
  }

  return (
    <SeriesChart
      layer={layer}
      shape={definition.source.shape}
      chartType={definition.chartType}
      options={definition.options}
      currentTime={currentTime}
      showTable={false}
      showNotes={false}
      viewerUnit={viewerUnit}
      effectivePalette={effectivePalette}
      effectiveInk={effectiveInk}
      xDomain={definition.source.shape === "time_series" ? xDomain : null}
    />
  );
}
