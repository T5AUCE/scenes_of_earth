import { getLayers } from "./api";
import { makeHtmlElement } from "./html";
import type { Layer } from "./types";

const MONTH_STEP = "P1M"; // the only request step the inputs below can take so far
const DEFAULT_MONTHS = 6;
const MONTHS_PER_YEAR = 12;

/** The panel controls that the layer choices fill in. */
export interface LayerChoiceControls {
  layerBox: HTMLElement;
  start: HTMLInputElement;
  end: HTMLInputElement;
}

/**
 * Adds a checkbox per backend layer (none are hard-coded) and sets the month inputs' range.
 * Rejects when the backend asks for periods other than months.
 */
export async function loadLayerChoices({ layerBox, start, end }: LayerChoiceControls) {
  const { layers, default: defaultIds, request_step: requestStep } = await getLayers();
  if (requestStep !== MONTH_STEP) throw new Error(`request step ${requestStep} is not supported`);

  appendLayerBoxes(layerBox, layers, defaultIds);
  setMonthRange(start, end, layers);
  return layers;
}

function appendLayerBoxes(layerBox: HTMLElement, layers: Layer[], defaultIds: string[]) {
  for (const layer of layers) {
    const label = makeHtmlElement("label", "", layerBox);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = layer.id;
    box.checked = defaultIds.includes(layer.id);
    label.append(box, ` ${layer.title} (${layer.units})`);
  }
}

// Only months that every time-varying layer has can be built, so the range is their overlap.
function setMonthRange(start: HTMLInputElement, end: HTMLInputElement, layers: Layer[]) {
  const axes = layers.flatMap((layer) => (layer.time ? [layer.time] : []));
  if (!axes.length) return;

  const commonFirst = axes.map((axis) => axis.first).sort().at(-1)!;
  const commonLast = axes.map((axis) => axis.last).sort()[0];
  const defaultStart = addMonths(commonLast, 1 - DEFAULT_MONTHS);

  start.min = end.min = commonFirst;
  start.max = end.max = commonLast;
  end.value = commonLast;
  start.value = defaultStart < commonFirst ? commonFirst : defaultStart;
}

function addMonths(yearMonth: string, delta: number) {
  const [year, month] = yearMonth.split("-").map(Number);
  const totalMonths = year * MONTHS_PER_YEAR + (month - 1) + delta;
  const shiftedYear = Math.floor(totalMonths / MONTHS_PER_YEAR);
  const shiftedMonth = String((totalMonths % MONTHS_PER_YEAR) + 1).padStart(2, "0");

  return `${shiftedYear}-${shiftedMonth}`;
}
