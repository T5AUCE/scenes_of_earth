/** Month-name and year dropdowns standing in for one native month input. */
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTHS_PER_YEAR = 12;
const FIRST_MONTH = 1;

const YEAR_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/**
 * Month and year dropdowns in one inline wrapper, standing in for a native month input.
 * Reads and writes one "YYYY-MM" value so callers keep treating it like a single field.
 */
export interface MonthSelect extends HTMLSpanElement {
  value: string; // the picked month, "YYYY-MM" ("" while no range is set)
  min: string; // the first allowed month, "YYYY-MM" ("" leaves the years empty)
  max: string; // the last allowed month, "YYYY-MM" ("" leaves the years empty)
  disabled: boolean; // forwards to both dropdowns
}

/**
 * Builds the month-name and year dropdowns with the given accessible names. Month and year
 * picks bubble up as change events on the wrapper, so one listener covers both dropdowns.
 */
export function createMonthSelect(monthLabel: string, yearLabel: string): MonthSelect {
  const wrapper = document.createElement("span") as MonthSelect;
  wrapper.className = "month-select";
  const month = document.createElement("select");
  month.setAttribute("aria-label", monthLabel);
  month.append(...MONTH_LABELS.map((label, index) => makeMonthOption(label, padMonth(index + 1))));
  const year = document.createElement("select");
  year.setAttribute("aria-label", yearLabel);
  wrapper.append(month, year);
  const control = new MonthSelectControl(month, year);
  Object.defineProperties(wrapper, {
    value: {
      configurable: true,
      get: () => control.value,
      set: (text: string) => {
        control.value = text;
      },
    },
    min: {
      configurable: true,
      get: () => control.min,
      set: (text: string) => {
        control.min = text;
      },
    },
    max: {
      configurable: true,
      get: () => control.max,
      set: (text: string) => {
        control.max = text;
      },
    },
    disabled: {
      configurable: true,
      get: () => control.disabled,
      set: (flag: boolean) => {
        control.disabled = flag;
      },
    },
  });
  year.onchange = () => control.yearChanged();
  return wrapper;
}

/** Holds the bounds and dropdowns for one month control. */
class MonthSelectControl {
  private minText = "";
  private maxText = "";

  constructor(
    private month: HTMLSelectElement,
    private year: HTMLSelectElement,
  ) {}

  get value(): string {
    if (this.year.selectedIndex < 0) return "";

    return `${this.year.value}-${this.month.value}`;
  }

  set value(text: string) {
    const parsed = parseYearMonth(text);
    if (!parsed || !this.hasYear(parsed.year)) {
      // Like a native month input, an empty or unrepresentable write clears the field.
      this.year.selectedIndex = -1;
      return;
    }

    this.year.value = String(parsed.year);
    this.month.value = padMonth(parsed.month);
    this.refreshMonths();
  }

  get min(): string {
    return this.minText;
  }

  set min(text: string) {
    this.minText = text;
    this.refreshYears();
  }

  get max(): string {
    return this.maxText;
  }

  set max(text: string) {
    this.maxText = text;
    this.refreshYears();
  }

  get disabled(): boolean {
    return this.month.disabled;
  }

  set disabled(flag: boolean) {
    this.month.disabled = flag;
    this.year.disabled = flag;
  }

  yearChanged(): void {
    this.refreshMonths();
  }

  private hasYear(candidate: number): boolean {
    const first = parseYearMonth(this.minText);
    const last = parseYearMonth(this.maxText);
    return !!first && !!last && candidate >= first.year && candidate <= last.year;
  }

  // Keeping no picked year until a value arrives lets callers fall back to their default period.
  private refreshYears(): void {
    const previous = this.year.value;
    const first = parseYearMonth(this.minText);
    const last = parseYearMonth(this.maxText);
    this.year.replaceChildren();
    if (!first || !last) return;
    for (let current = first.year; current <= last.year; current += 1) {
      this.year.append(makeMonthOption(String(current), String(current)));
    }
    if (previous && this.hasYear(Number(previous))) this.year.value = previous;
    else this.year.selectedIndex = previous ? 0 : -1;
    this.refreshMonths();
  }

  // Months outside an edge year stay visible but unpickable, so the list shape never shifts.
  private refreshMonths(): void {
    const first = parseYearMonth(this.minText);
    const last = parseYearMonth(this.maxText);
    const picked = Number(this.year.value);
    let lowest = FIRST_MONTH;
    let highest = MONTHS_PER_YEAR;
    if (first && picked === first.year) lowest = first.month;
    if (last && picked === last.year) highest = last.month;
    for (let index = 0; index < this.month.options.length; index += 1) {
      const option = this.month.options[index];
      const number = index + 1;
      option.disabled = number < lowest || number > highest;
    }
    if (this.month.value < padMonth(lowest)) this.month.value = padMonth(lowest);
    else if (this.month.value > padMonth(highest)) this.month.value = padMonth(highest);
  }
}

function parseYearMonth(text: string): { year: number; month: number } | null {
  const match = YEAR_MONTH_PATTERN.exec(text);
  if (!match) return null;

  const month = Number(match[2]);
  if (month < FIRST_MONTH || month > MONTHS_PER_YEAR) return null;

  return { year: Number(match[1]), month };
}

function padMonth(month: number): string {
  return String(month).padStart(2, "0");
}

function makeMonthOption(label: string, value: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.textContent = label;
  option.value = value;
  return option;
}
