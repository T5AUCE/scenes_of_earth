import type { MonthSelect } from "./month-select";
import type { Layer } from "./types";

const MONTH_STEP = "P1M"; // the only request step the inputs below can take so far
const DEFAULT_MONTHS = 6;
const MONTHS_PER_YEAR = 12;

type TimeAxis = NonNullable<Layer["time"]>;

/** The panel controls that the layer choices fill in. */
export interface LayerChoiceControls {
  layerBox: HTMLElement;
  start: MonthSelect;
  end: MonthSelect;
}

/**
 * Adds a checkbox per backend layer (none are hard-coded) and keeps the month inputs' range at
 * the overlap of the checked layers. Rejects when the backend asks for periods other than months.
 */
export async function loadLayerChoices({ layerBox, start, end }: LayerChoiceControls) {
  // Loaded here so that tests can import this module without resolving the API client.
  const { getLayers } = await import("./api");
  const { layers, default: defaultIds, request_step: requestStep } = await getLayers();
  if (requestStep !== MONTH_STEP) throw new Error(`request step ${requestStep} is not supported`);

  appendLayerBoxes(layerBox, layers, defaultIds);
  const updateRange = () => setMonthRange(start, end, checkedAxes(layerBox, layers));
  layerBox.addEventListener("change", updateRange);
  keepMonthOrder(start, end);
  updateRange();
  return layers;
}

/** The first and last month that every given time axis has, or null without axes. */
export function commonRange(axes: TimeAxis[]) {
  if (!axes.length) return null;

  const first = axes.map((axis) => axis.first).sort().at(-1)!;
  const last = axes.map((axis) => axis.last).sort()[0];
  return { first, last };
}

function appendLayerBoxes(layerBox: HTMLElement, layers: Layer[], defaultIds: string[]) {
  for (const layer of layers) {
    const label = document.createElement("label");
    layerBox.append(label);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = layer.id;
    box.checked = defaultIds.includes(layer.id);
    label.append(box, ` ${layer.title}`);
  }
}

function checkedAxes(layerBox: HTMLElement, layers: Layer[]) {
  const checkedIds = [...layerBox.querySelectorAll<HTMLInputElement>("input:checked")].map(
    (box) => box.value,
  );
  const checked = layers.filter((layer) => checkedIds.includes(layer.id));
  return checked.flatMap((layer) => (layer.time ? [layer.time] : []));
}

// Moving one end past the other drags the other end along, so a request never ends early.
function keepMonthOrder(start: MonthSelect, end: MonthSelect): void {
  start.addEventListener("change", () => {
    if (start.value > end.value) end.value = start.value;
  });
  end.addEventListener("change", () => {
    if (end.value < start.value) start.value = end.value;
  });
}

// The range follows only the checked layers, so unchecking temperature brings back the
// longer rain range.
function setMonthRange(start: MonthSelect, end: MonthSelect, axes: TimeAxis[]) {
  const range = commonRange(axes);
  if (!range) return;

  // Bounds rebuild the year lists, so the picks are read first while they still hold dates.
  const previousStart = start.value || addMonths(range.last, 1 - DEFAULT_MONTHS);
  const previousEnd = end.value || range.last;
  start.min = end.min = range.first;
  start.max = end.max = range.last;
  end.value = withinRange(previousEnd, range);
  start.value = withinRange(previousStart, range);
  // Both ends clamp separately, so From still wins after an inverted pick.
  if (start.value > end.value) end.value = start.value;
}

function withinRange(month: string, { first, last }: { first: string; last: string }) {
  if (month < first) return first;
  return month > last ? last : month;
}

function addMonths(yearMonth: string, delta: number) {
  const [year, month] = yearMonth.split("-").map(Number);
  const totalMonths = year * MONTHS_PER_YEAR + (month - 1) + delta;
  const shiftedYear = Math.floor(totalMonths / MONTHS_PER_YEAR);
  const shiftedMonth = String((totalMonths % MONTHS_PER_YEAR) + 1).padStart(2, "0");

  return `${shiftedYear}-${shiftedMonth}`;
}
