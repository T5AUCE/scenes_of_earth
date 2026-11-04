import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";

import { createMonthSelect } from "./month-select.ts";
import type { MonthSelect } from "./month-select.ts";
import { assertSameNode } from "./testing/dom-assert.ts";

test("year options run from the first to the last allowed month", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const control = createMonthSelect("From month", "From year");
  control.min = "2016-03";
  control.max = "2018-11";
  const [, year] = dropdowns(control);

  assert.deepEqual(optionValues(year), ["2016", "2017", "2018"]);
});

test("months outside an edge year stay listed but disabled", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const control = createMonthSelect("From month", "From year");
  control.min = "2016-03";
  control.max = "2026-06";
  const [month] = dropdowns(control);

  control.value = "2016-05";
  assert.equal(month.options.length, 12);
  assert.equal(month.options[0].disabled, true);
  assert.equal(month.options[1].disabled, true);
  assert.equal(month.options[2].disabled, false);
  assert.equal(month.options[11].disabled, false);

  control.value = "2026-04";
  assert.equal(month.options[5].disabled, false);
  assert.equal(month.options[6].disabled, true);
  assert.equal(month.options[11].disabled, true);

  control.value = "2020-05";
  assert.ok(disabledFlags(month).every((flag) => !flag));
});

test("picking a year outside the month moves to the nearest allowed month", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const control = createMonthSelect("From month", "From year");
  control.min = "2016-10";
  control.max = "2026-06";
  const [, year] = dropdowns(control);

  control.value = "2026-06";
  pickYear(year, "2016");
  assert.equal(control.value, "2016-10");

  control.value = "2016-12";
  pickYear(year, "2026");
  assert.equal(control.value, "2026-06");
});

test("a picked month round-trips through value", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const control = createMonthSelect("From month", "From year");
  control.min = "1981-01";
  control.max = "2026-08";

  assert.equal(control.value, "");
  control.value = "2020-05";
  assert.equal(control.value, "2020-05");
  const [month, year] = dropdowns(control);
  assert.equal(month.value, "05");
  assert.equal(year.value, "2020");
});

test("the wrapper fires change and names the month and year dropdowns", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const start = createMonthSelect("From month", "From year");
  start.min = "2016-01";
  start.max = "2016-12";
  const end = createMonthSelect("To month", "To year");

  assertSameNode(start.children[0], start.querySelector('select[aria-label="From month"]'));
  assertSameNode(start.children[1], start.querySelector('select[aria-label="From year"]'));
  assertSameNode(end.children[0], end.querySelector('select[aria-label="To month"]'));
  assertSameNode(end.children[1], end.querySelector('select[aria-label="To year"]'));

  let changes = 0;
  start.addEventListener("change", () => {
    changes += 1;
  });
  const [, year] = dropdowns(start);
  pickYear(year, "2016");
  assert.equal(changes, 1);
});

test("disabling the control disables both dropdowns", (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const control = createMonthSelect("From month", "From year");
  const [month, year] = dropdowns(control);

  control.disabled = true;
  assert.equal(month.disabled, true);
  assert.equal(year.disabled, true);

  control.disabled = false;
  assert.equal(month.disabled, false);
  assert.equal(year.disabled, false);
});

function installBrowser(window: Window): void {
  const names = ["Node", "Element", "HTMLElement", "DocumentFragment", "Event"] as const;
  for (const name of names) defineGlobal(name, window[name]);
  defineGlobal("document", window.document);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

function dropdowns(control: MonthSelect): [HTMLSelectElement, HTMLSelectElement] {
  return [
    control.children[0] as HTMLSelectElement,
    control.children[1] as HTMLSelectElement,
  ];
}

function optionValues(select: HTMLSelectElement): string[] {
  const values: string[] = [];
  for (let index = 0; index < select.options.length; index += 1) {
    values.push(select.options[index].value);
  }
  return values;
}

function disabledFlags(select: HTMLSelectElement): boolean[] {
  const flags: boolean[] = [];
  for (let index = 0; index < select.options.length; index += 1) {
    flags.push(select.options[index].disabled);
  }
  return flags;
}

function pickYear(year: HTMLSelectElement, value: string): void {
  year.value = value;
  year.dispatchEvent(new Event("change", { bubbles: true }));
}
