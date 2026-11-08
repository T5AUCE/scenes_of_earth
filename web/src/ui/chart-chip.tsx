/** Render the docked main-chart preview only when Charts is selected. */
import { chartTypeLabel, resolveMainId } from "../charts/definitions";
import { ChartPreview } from "../charts/chart-preview";
import type { SceneStore } from "../scene-store";
import type { Scene } from "../types";
import { useSceneStore } from "./use-scene-store";

/** Show the current main chart with its compact presentation and definition identity. */
export function ChartChip({
  scene,
  store,
  currentTime,
}: {
  scene: Scene;
  store: SceneStore;
  currentTime: string | null;
}): React.ReactElement {
  const { charts, display } = useSceneStore(store);
  const layers = scene.layers;
  const mainId = resolveMainId(charts.definitions, charts.mainChartId, layers);
  const definition = charts.definitions.find((entry) => entry.id === mainId) ?? null;
  if (!definition) return <span>{"No charts for this scene."}</span>;
  const layer = layers.find((entry) => entry.id === definition.source.layerId) ?? null;
  if (!layer) return <span>{definition.title}</span>;
  const viewerUnit = display.layers[layer.id]?.units ?? null;
  const effectivePalette = display.layers[layer.id]?.palette ?? layer.style.palette ?? null;
  const effectiveInk = display.layers[layer.id]?.ink ?? null;
  const shapeLabel = definition.source.shape === "distribution"
    ? "Hypsometry"
    : definition.source.shape === "seasonal_cycle"
      ? "By month"
      : "Over time";

  return (
    <span className="chart-chip">
      <span className="chip-title">
        {`${definition.title} · ${shapeLabel} · ${chartTypeLabel(definition.chartType)}`}
      </span>
      <ChartPreview
        key={definition.id}
        layer={layer}
        shape={definition.source.shape}
        chartType={definition.chartType}
        options={definition.options}
        currentTime={currentTime}
        compact={true}
        showNotes={false}
        viewerUnit={viewerUnit}
        effectivePalette={effectivePalette}
        effectiveInk={effectiveInk}
      />
    </span>
  );
}
