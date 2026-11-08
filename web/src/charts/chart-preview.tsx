/** Dispatch saved chart shapes without changing specialized rendering defaults. */
import type { SupportedShape } from "./definitions";
import { HypsometryChart } from "./hypsometry-chart";
import { SeriesChart, type SeriesChartProps } from "./series-chart";

/** Shared chart inputs and explicit presentation choices for gallery, detail, editor and chip. */
export interface ChartPreviewProps extends Omit<SeriesChartProps, "shape"> {
  shape: SupportedShape;
}

/** Render the specialized wrapper for a source shape without adding a DOM container. */
export function ChartPreview({
  shape,
  currentTime,
  xDomain,
  ...props
}: ChartPreviewProps): React.ReactElement {
  if (shape === "distribution") return <HypsometryChart {...props} />;

  return <SeriesChart {...props} shape={shape} currentTime={currentTime} xDomain={xDomain} />;
}
