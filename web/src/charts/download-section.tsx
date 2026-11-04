/** Offer CSV downloads for the scene's area means and elevation distributions. */
import type { LayerDoc, Scene } from "../types";
import { buildAreaMeansCsv, buildElevationCsv, downloadCsv } from "./csv";
import { isDistributionLayer, isTimeSeriesLayer } from "./series";

/**
 * Offer one area-means file for all time-varying layers and one elevation file per
 * distribution layer. Scenes with nothing exportable render nothing because unavailable
 * sources keep labelled gallery tiles instead of empty files.
 */
export function DownloadSection({ scene }: { scene: Scene }): React.ReactElement | null {
  const timeLayers = (scene.layers ?? []).filter(isTimeSeriesLayer);
  const distributionLayers = (scene.layers ?? []).filter(isDistributionLayer);
  if (timeLayers.length === 0 && distributionLayers.length === 0) return null;

  return (
    <section className="chart-downloads" aria-label="Downloads">
      <h3>{"Downloads"}</h3>
      {timeLayers.length > 0 && (
        <button type="button" onClick={() => downloadArea(scene)}>
          {"Area means (CSV)"}
        </button>
      )}
      {distributionLayers.map((layer) => (
        <button
          key={layer.id}
          type="button"
          aria-label={elevationLabel(scene, layer)}
          onClick={() => downloadElevation(scene, layer)}
        >
          {"Elevation distribution (CSV)"}
        </button>
      ))}
    </section>
  );
}

function downloadArea(scene: Scene): void {
  const file = buildAreaMeansCsv(scene);
  downloadCsv(file.filename, file.content);
}

function downloadElevation(scene: Scene, layer: LayerDoc): void {
  const file = buildElevationCsv(scene, layer);
  downloadCsv(file.filename, file.content);
}

// A lone elevation button keeps its exact label while shared names name their layer.
function elevationLabel(scene: Scene, layer: LayerDoc): string | undefined {
  const distributions = (scene.layers ?? []).filter(isDistributionLayer);
  if (distributions.length < 2) return undefined;

  return `Elevation distribution (CSV) for ${layer.title}`;
}
