/** Close-up of one saved chart with its data table and chart actions. */
import type { SceneStore } from "../scene-store";
import type { Scene } from "../types";
import { useSceneStore } from "../ui/use-scene-store";
import { HypsometryChart } from "./hypsometry-chart";
import { SeriesChart } from "./series-chart";
import { unionIntervals } from "./series";

/** Props of the close-up; the dialog entry stays Charts while detail shows. */
export interface ChartDetailProps {
  scene: Scene;
  store: SceneStore;
  definitionId: string;
  currentTime: string | null;
  onBack(): void;
  onEdit(id: string): void;
  syncNotice?: string | null;
}

/**
 * Show one chart large with Back, Edit, main selection and deletion. Deletion keeps the
 * gallery nonempty because the store restores a default when the last definition leaves.
 */
export function ChartDetail({
  scene,
  store,
  definitionId,
  currentTime,
  onBack,
  onEdit,
  syncNotice = null,
}: ChartDetailProps): React.ReactElement {
  const { charts, display } = useSceneStore(store);
  const definition = charts.definitions.find((entry) => entry.id === definitionId);
  if (!definition) {
    return (
      <section className="chart-detail" aria-label="Chart detail">
        <button type="button" data-detail-back={true} onClick={onBack}>
          {"Back to charts"}
        </button>
        <p>{"This chart is no longer available."}</p>
      </section>
    );
  }
  const layer = scene.layers.find((entry) => entry.id === definition.source.layerId);
  if (!layer) {
    return (
      <section className="chart-detail" aria-label="Chart detail">
        <button type="button" data-detail-back={true} onClick={onBack}>
          {"Back to charts"}
        </button>
        <p>{"This layer is no longer available."}</p>
      </section>
    );
  }
  const isMain = charts.mainChartId === definition.id;
  const viewerUnit = display.layers[layer.id]?.units ?? null;
  const effectivePalette = display.layers[layer.id]?.palette ?? layer.style.palette ?? null;
  const effectiveInk = display.layers[layer.id]?.ink ?? null;
  const setMain = () => store.dispatch({ kind: "setMain", id: definition.id });
  const remove = () => {
    store.dispatch({ kind: "deleteChart", id: definition.id });
    onBack();
  };

  return (
    <section className="chart-detail" aria-label="Chart detail">
      <header className="detail-head">
        <button type="button" data-detail-back={true} onClick={onBack}>
          {"Back to charts"}
        </button>
        <h3>{definition.title}</h3>
      </header>
      {syncNotice && (
        <p className="chart-note" role="status">
          {syncNotice}
        </p>
      )}
      {definition.source.shape === "distribution"
        ? (
          <HypsometryChart
            layer={layer}
            chartType={definition.chartType}
            options={definition.options}
            viewerUnit={viewerUnit}
            effectivePalette={effectivePalette}
            effectiveInk={effectiveInk}
          />
        )
        : (
          <SeriesChart
            layer={layer}
            shape={definition.source.shape}
            chartType={definition.chartType}
            options={definition.options}
            currentTime={currentTime}
            viewerUnit={viewerUnit}
            effectivePalette={effectivePalette}
            effectiveInk={effectiveInk}
            xDomain={definition.source.shape === "time_series"
              ? unionDomainFor(scene)
              : null}
          />
        )}
      <div className="detail-actions">
        <button type="button" data-detail-edit={true} onClick={() => onEdit(definition.id)}>
          {"Edit"}
        </button>
        <button type="button" onClick={setMain} disabled={isMain}>
          {"Use as main"}
        </button>
        <button type="button" onClick={remove}>
          {"Delete"}
        </button>
      </div>
    </section>
  );
}

function unionDomainFor(scene: Scene): [number, number] | null {
  const intervals = unionIntervals(scene.layers);
  if (intervals.length === 0) return null;
  const first = Date.parse(intervals[0].start);
  const last = Date.parse(intervals[intervals.length - 1].start);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;

  return [first, last];
}
