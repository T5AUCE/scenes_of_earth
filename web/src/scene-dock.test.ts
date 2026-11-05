import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createHarness, element, resetHarness } from "./testing/scene-mode-harness.ts";

afterEach(resetHarness);

test("the panel receives the scene store and follows the timeline", () => {
  const harness = createHarness();
  harness.initialUnits = ["ft", { terrain: "ft" }];
  harness.enter();

  assert.equal(harness.panelStore, harness.mountStore);
  assert.deepEqual(harness.times, [[null, null]]);

  harness.onTime!("2020-02-01", "2020-02");

  assert.deepEqual(harness.times.at(-1), ["2020-02-01", "2020-02"]);
});

test("play holds the share link until pause writes it once", () => {
  const harness = createHarness();
  const replaced: string[] = [];
  Object.assign(globalThis, {
    history: {
      get state() {
        return null;
      },
      pushState() {},
      replaceState(_next: unknown, _title: string, url: string) {
        replaced.push(url);
      },
      back() {},
    },
  });
  harness.enter();
  replaced.length = 0;

  harness.onPlayingChange!(true);
  harness.onTime!("2020-01-01", "2020-01");
  harness.onTime!("2020-02-01", "2020-02");
  assert.equal(replaced.length, 0);

  harness.onPlayingChange!(false);
  assert.equal(replaced.length, 1);
  assert.match(replaced[0], /t=2020-02/);
});

test("docking observes the attribution and time bar and publishes their extent", (context) => {
  const harness = createHarness();
  const docking = installDockingStubs(context, { footerHeight: 40, barHeight: 50 });
  harness.roots.timeBar = docking.timeBar;
  harness.enter();

  assert.ok(docking.observed.includes(docking.timeBar));
  assert.ok(docking.observed.includes(docking.footer));
  assert.equal(docking.observed.length, 2);
  assert.equal(docking.values["--scene-dock-bottom"], "86px");

  docking.setFooterHeight(100);
  docking.trigger();
  assert.equal(docking.values["--scene-dock-bottom"], "108px");

  docking.setFooterHeight(40);
  docking.setBarHeight(100);
  docking.fireResize();
  assert.equal(docking.values["--scene-dock-bottom"], "136px");

  assert.equal(docking.addedResize.length, 1);
  harness.mode.exit();
  assert.equal(docking.disconnects, 1);
  assert.equal(docking.removedResize.length, 1);
  assert.equal(docking.removedResize[0], docking.addedResize[0]);
});

test("docking disconnects on exit and re-observes on re-entry", (context) => {
  const harness = createHarness();
  const docking = installDockingStubs(context, { footerHeight: 32, barHeight: 24 });
  harness.roots.timeBar = docking.timeBar;
  harness.enter();
  assert.equal(docking.observed.length, 2);
  assert.equal(docking.values["--scene-dock-bottom"], "60px");
  assert.equal(docking.addedResize.length, 1);

  docking.setBarHeight(50);
  docking.fireResize();
  assert.equal(docking.values["--scene-dock-bottom"], "86px");

  docking.setBarHeight(24);
  docking.fireResize();
  assert.equal(docking.values["--scene-dock-bottom"], "60px");

  harness.mode.exit();
  assert.equal(docking.disconnects, 1);
  assert.equal(docking.removedResize.length, 1);
  assert.equal(docking.removedResize[0], docking.addedResize[0]);

  harness.map.layers.set("relief", { id: "relief", layout: { visibility: "visible" } });
  harness.map.layers.set("contours", {
    id: "contours",
    minzoom: 6,
    maxzoom: 12,
    layout: { visibility: "visible" },
  });
  harness.map.layers.set("rain", {
    id: "rain",
    minzoom: 0,
    maxzoom: 24,
    layout: { visibility: "visible" },
  });
  harness.map.layers.set("overview", {
    id: "overview",
    minzoom: 1,
    maxzoom: 4,
    layout: { visibility: "visible" },
  });
  harness.enter();
  assert.equal(docking.observed.length, 4);
  assert.equal(docking.values["--scene-dock-bottom"], "60px");
  assert.equal(docking.addedResize.length, 2);

  docking.fireResize();
  assert.equal(docking.values["--scene-dock-bottom"], "60px");

  harness.mode.exit();
  assert.equal(docking.disconnects, 2);
  assert.equal(docking.removedResize.length, 2);
  assert.equal(docking.removedResize[1], docking.addedResize[1]);
});

test("docking stays at the gap when nothing overlaps the column", (context) => {
  const harness = createHarness();
  const docking = installDockingStubs(context, { footerHeight: 40, barHeight: 50 });
  harness.roots.timeBar = docking.timeBar;
  harness.roots.column = docking.column;
  harness.enter();

  assert.ok(docking.observed.includes(docking.column));
  assert.ok(docking.observed.includes(docking.timeBar));
  assert.ok(docking.observed.includes(docking.footer));
  assert.equal(docking.values["--scene-dock-bottom"], "8px");

  harness.mode.exit();
  assert.equal(docking.disconnects, 1);
});

test("docking lifts above a footer overlapping the column", (context) => {
  const harness = createHarness();
  const docking = installDockingStubs(context, { footerHeight: 40, barHeight: 50 });
  docking.setFooterRight(800);
  harness.roots.timeBar = docking.timeBar;
  harness.roots.column = docking.column;
  harness.enter();

  assert.equal(docking.values["--scene-dock-bottom"], "48px");

  harness.mode.exit();
  assert.equal(docking.disconnects, 1);
});

test("docking lifts above a time bar overlapping the column", (context) => {
  const harness = createHarness();
  const docking = installDockingStubs(context, { footerHeight: 40, barHeight: 50 });
  docking.setBarRight(800);
  harness.roots.timeBar = docking.timeBar;
  harness.roots.column = docking.column;
  harness.enter();

  assert.equal(docking.values["--scene-dock-bottom"], "86px");

  harness.mode.exit();
  assert.equal(docking.disconnects, 1);
});

function installDockingStubs(
  context: { after(hook: () => void): void },
  sizes: { footerHeight: number; barHeight: number },
): {
  footer: unknown;
  timeBar: unknown;
  column: unknown;
  observed: unknown[];
  values: Record<string, string>;
  trigger(): void;
  setFooterHeight(height: number): void;
  setBarHeight(height: number): void;
  setFooterRight(right: number): void;
  setBarRight(right: number): void;
  fireResize(): void;
  readonly addedResize: (() => void)[];
  readonly removedResize: (() => void)[];
  readonly disconnects: number;
} {
  const previous = {
    document: globalThis.document,
    history: globalThis.history,
    getComputedStyle: globalThis.getComputedStyle,
    window: (globalThis as Record<string, unknown>).window,
    ResizeObserver: (globalThis as Record<string, unknown>).ResizeObserver,
    Element: (globalThis as Record<string, unknown>).Element,
    HTMLElement: (globalThis as Record<string, unknown>).HTMLElement,
  };
  context.after(() => {
    Object.assign(globalThis, {
      document: previous.document,
      history: previous.history,
      getComputedStyle: previous.getComputedStyle,
    });
    (globalThis as Record<string, unknown>).window = previous.window;
    (globalThis as Record<string, unknown>).ResizeObserver = previous.ResizeObserver;
    (globalThis as Record<string, unknown>).Element = previous.Element;
    (globalThis as Record<string, unknown>).HTMLElement = previous.HTMLElement;
  });

  const INNER_HEIGHT_PX = 800;
  const TIME_BAR_BOTTOM_PX = 28;
  const COLUMN_TOP_PX = 8;
  const COLUMN_BOTTOM_PX = 792;
  let footerHeight = sizes.footerHeight;
  let barHeight = sizes.barHeight;
  class DockingElement {
    left = 0;
    right = 0;
    hidden = false;

    constructor(readonly kind: string) {
      if (kind === "footer") {
        this.left = 0;
        this.right = 200;
      } else if (kind === "bar") {
        this.left = 8;
        this.right = 400;
      } else {
        this.left = 724;
        this.right = 1016;
      }
    }

    append() {}

    replaceChildren() {}

    getBoundingClientRect() {
      if (this.kind === "footer") {
        return {
          top: INNER_HEIGHT_PX - footerHeight,
          bottom: INNER_HEIGHT_PX,
          height: footerHeight,
          left: this.left,
          right: this.right,
          width: this.right - this.left,
        };
      }
      if (this.kind === "column") {
        return {
          top: COLUMN_TOP_PX,
          bottom: COLUMN_BOTTOM_PX,
          height: COLUMN_BOTTOM_PX - COLUMN_TOP_PX,
          left: this.left,
          right: this.right,
          width: this.right - this.left,
        };
      }

      return {
        top: INNER_HEIGHT_PX - TIME_BAR_BOTTOM_PX - barHeight,
        bottom: INNER_HEIGHT_PX - TIME_BAR_BOTTOM_PX,
        height: barHeight,
        left: this.left,
        right: this.right,
        width: this.right - this.left,
      };
    }
  }

  const values: Record<string, string> = {};
  const footer = new DockingElement("footer");
  const timeBar = new DockingElement("bar") as unknown as HTMLElement;
  const column = new DockingElement("column") as unknown as HTMLElement;
  const observed: unknown[] = [];
  const addedResize: (() => void)[] = [];
  const removedResize: (() => void)[] = [];
  let disconnects = 0;
  let update: (() => void) | null = null;
  class TestObserver {
    constructor(callback: () => void) {
      update = callback;
    }

    observe(target: unknown) {
      observed.push(target);
    }

    disconnect() {
      disconnects += 1;
    }
  }

  (globalThis as Record<string, unknown>).Element = DockingElement;
  (globalThis as Record<string, unknown>).HTMLElement = DockingElement;
  (globalThis as Record<string, unknown>).window = {
    innerHeight: INNER_HEIGHT_PX,
    addEventListener(type: string, listener: () => void) {
      if (type === "resize") addedResize.push(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "resize") removedResize.push(listener);
    },
  };
  (globalThis as Record<string, unknown>).ResizeObserver = TestObserver;
  Object.assign(globalThis, {
    document: {
      body: { classList: { add() {}, remove() {} } },
      createElement: element,
      documentElement: {
        style: {
          setProperty(name: string, value: string) {
            values[name] = value;
          },
        },
      },
      querySelector(selector: string) {
        if (selector === ".maplibregl-ctrl-bottom-left") return footer;

        return null;
      },
    },
    history: { state: null, replaceState() {}, pushState() {}, back() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "#faf8f3" }),
  });

  return {
    footer,
    timeBar,
    column,
    observed,
    values,
    trigger() {
      update?.();
    },
    setFooterHeight(height: number) {
      footerHeight = height;
    },
    setBarHeight(height: number) {
      barHeight = height;
    },
    setFooterRight(right: number) {
      footer.right = right;
    },
    setBarRight(right: number) {
      (timeBar as unknown as DockingElement).right = right;
    },
    fireResize() {
      for (const listener of [...addedResize]) {
        if (!removedResize.includes(listener)) listener();
      }
    },
    addedResize,
    removedResize,
    get disconnects() {
      return disconnects;
    },
  };
}
