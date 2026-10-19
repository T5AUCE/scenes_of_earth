import { createCategoricalView } from "./categorical";
import { createSeriesView } from "./field";
import { createTerrainView } from "./terrain";

/** Renderers by style.kind; later stack numbers draw on top of earlier ones. */
export const LAYER_KINDS = new Map([
  ["categorical", { stack: 0, create: createCategoricalView }],
  ["field", { stack: 1, create: createSeriesView }],
  ["terrain", { stack: 2, create: createTerrainView }],
]);
