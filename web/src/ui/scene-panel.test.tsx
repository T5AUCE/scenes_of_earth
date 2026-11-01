import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import type { LayerDoc, Scene } from "../types.ts";

test("the collapsed panel keeps its label and switches its preview", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  const openings: string[] = [];
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: (tab) => openings.push(tab),
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
  });

  const region = panel!.element;
  assert.equal(region.getAttribute("role"), "region");
  assert.equal(region.getAttribute("aria-label"), "Scene details");
  assert.match(region.textContent ?? "", /km²/);

  const charts = [...region.querySelectorAll("button")].find(
    (button) => button.textContent === "Charts",
  )!;
  await act(async () => {
    charts.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(region.textContent ?? "", /not available yet/);

  const about = [...region.querySelectorAll("button")].find(
    (button) => button.textContent === "About",
  )!;
  await act(async () => {
    about.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(region.textContent ?? "", /km²/);

  const expand = region.querySelector(".expand") as HTMLButtonElement;
  await act(async () => {
    expand.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(openings.at(-1), "about");

  await act(async () => panel!.destroy());
});

test("the notice badge asks for About while the footer asks for Credits", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  const openings: string[] = [];
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: (tab) => openings.push(tab),
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
  });

  const badge = [...panel!.element.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes("note"),
  )!;
  await act(async () => {
    badge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(openings, ["about"]);

  const footer = panel!.element.querySelector(".panel-footer") as HTMLButtonElement;
  await act(async () => {
    footer.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(openings, ["about", "credits"]);

  await act(async () => panel!.destroy());
});

test("setTime shows the dialog label and hides it without a time", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(dialog);
    panel.openFull("about");
  });

  const label = () => dialog.querySelector(".mini-time span")?.textContent ?? "";
  const hidden = () => (dialog.querySelector(".mini-time") as HTMLElement).hidden;
  assert.equal(hidden(), true);

  await act(async () => {
    panel!.setTime("2020-02-01", "2020-02");
  });
  assert.equal(hidden(), false);
  assert.equal(label(), "2020-02");

  await act(async () => {
    panel!.setTime(null, null);
  });
  assert.equal(hidden(), true);

  await act(async () => panel!.destroy());
});

test("units through the store relabel the summary", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
  });

  assert.match(panel!.element.textContent ?? "", /km²/);
  await act(async () => {
    store.dispatch({
      kind: "display",
      update: (display) => {
        display.layers.terrain = { units: "ft" };
      },
    });
  });
  assert.match(panel!.element.textContent ?? "", /mi²/);

  await act(async () => panel!.destroy());
});

test("open, Escape and close keep focus on the collapsed entry point", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  const closings: string[] = [];
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => closings.push("close"),
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
  });

  await act(async () => {
    panel!.openFull("credits");
  });
  assert.equal(panel!.isOpen, true);
  assert.match(dialog.textContent ?? "", /Basemap/);
  const creditsTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "Credits",
  ) as HTMLButtonElement;
  assert.equal(document.activeElement, creditsTab);

  await act(async () => {
    dialog.dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(closings, ["close"]);

  await act(async () => {
    panel!.closeFull();
  });
  assert.equal(panel!.isOpen, false);
  assert.equal(
    document.activeElement,
    panel!.element.querySelector(".expand"),
  );

  await act(async () => panel!.destroy());
});

test("destroy removes both roots and clears the dialog", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
    panel.openFull("about");
  });
  assert.ok(document.body.contains(panel!.element));
  assert.ok(dialog.textContent?.includes("Test scene"));

  await act(async () => {
    panel!.destroy();
  });
  assert.equal(document.body.contains(panel!.element), false);
  assert.equal(dialog.textContent, "");
  assert.equal(dialog.open, false);
});

test("an immediate Credits open wins before the first commit", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
    panel.setTime("2020-02-01", "2020-02");
    panel.openFull("credits");
  });

  assert.equal(panel!.isOpen, true);
  assert.match(dialog.textContent ?? "", /Basemap/);
  const creditsTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "Credits",
  ) as HTMLButtonElement;
  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "Credits",
  );
  assert.equal(document.activeElement, creditsTab);
  assert.equal(dialog.querySelector(".mini-time span")?.textContent, "2020-02");

  await act(async () => panel!.destroy());
});

test("an immediate Charts open wins before the first commit", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
    panel.openFull("charts");
  });

  assert.equal(panel!.isOpen, true);
  assert.match(dialog.textContent ?? "", /not available yet/);
  const chartsTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "Charts",
  ) as HTMLButtonElement;
  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "Charts",
  );
  assert.equal(document.activeElement, chartsTab);

  await act(async () => panel!.destroy());
});

test("the first About open focuses its tab and resets scroll", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
  });

  const main = dialog.querySelector("main") as HTMLElement;
  main.scrollTop = 123;
  await act(async () => {
    panel!.openFull("about");
  });

  const aboutTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "About",
  ) as HTMLButtonElement;
  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "About",
  );
  assert.equal(document.activeElement, aboutTab);
  assert.equal(main.scrollTop, 0);
  assert.match(dialog.textContent ?? "", /Test scene/);

  await act(async () => panel!.destroy());
});

test("reopening the same tab refocuses and resets scroll", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
    panel.openFull("credits");
  });

  const main = dialog.querySelector("main") as HTMLElement;
  main.scrollTop = 123;
  await act(async () => {
    panel!.closeFull();
  });
  assert.equal(panel!.isOpen, false);
  assert.equal(
    document.activeElement,
    panel!.element.querySelector(".expand"),
  );

  main.scrollTop = 123;
  await act(async () => {
    panel!.openFull("credits");
  });

  const creditsTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "Credits",
  ) as HTMLButtonElement;
  assert.equal(document.activeElement, creditsTab);
  assert.equal(main.scrollTop, 0);

  await act(async () => panel!.destroy());
});

test("a notice from Credits commits About before scrolling to notices", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const previousHistory = (globalThis as Record<string, unknown>).history;
  (globalThis as Record<string, unknown>).history = window.history;
  context.after(() => {
    (globalThis as Record<string, unknown>).history = previousHistory;
  });
  const scrolled = installScrollSpy(context);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen(tab, options) {
        history.pushState({ panel: tab }, "", "/?scene=test");
        panel!.openFull(tab, options);
      },
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
    panel.openFull("credits");
  });

  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "Credits",
  );
  assert.equal(dialog.querySelector("#notices-heading"), null);
  assert.deepEqual(scrolled, []);

  const main = dialog.querySelector("main") as HTMLElement;
  main.scrollTop = 77;
  const badge = [...panel!.element.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes("note"),
  )!;
  await act(async () => {
    badge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(history.state, { panel: "about" });
  assert.equal(panel!.isOpen, true);
  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "About",
  );
  const aboutTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "About",
  ) as HTMLButtonElement;
  assert.equal(document.activeElement, aboutTab);
  assert.equal(main.scrollTop, 0);
  assert.equal(dialog.querySelector("#notices-heading")?.textContent, "Notices and limits");
  assert.ok(scrolled.includes("notices-heading"));

  await act(async () => panel!.destroy());
  assert.equal(dialog.textContent, "");
});

test("recording the notice request without opening leaves the dialog closed", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const scrolled = installScrollSpy(context);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  const openings: string[] = [];
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: (tab) => openings.push(tab),
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
  });

  const badge = [...panel!.element.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes("note"),
  )!;
  await act(async () => {
    badge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(openings, ["about"]);
  assert.equal(panel!.isOpen, false);

  await act(async () => panel!.destroy());
  assert.deepEqual(scrolled, []);
  assert.equal(dialog.textContent, "");
  assert.equal(dialog.open, false);
});

test("a pending notice destroyed early leaves no stale scroll or focus", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const scrolled = installScrollSpy(context);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
  });

  // The open commits after this turn, so destroying now cancels it before the effect.
  panel!.openFull("about", { scrollToNotices: true });
  await act(async () => panel!.destroy());

  assert.deepEqual(scrolled, []);
  assert.equal(dialog.textContent, "");
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement?.tagName, "BODY");

  await new Promise((resolve) => setImmediate(resolve));
  await act(async () => {});
  assert.deepEqual(scrolled, []);

  let reopened: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    reopened = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(reopened.element);
    reopened.openFull("credits");
  });

  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "Credits",
  );
  assert.deepEqual(scrolled, []);
  const creditsTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "Credits",
  ) as HTMLButtonElement;
  assert.equal(document.activeElement, creditsTab);

  await act(async () => reopened!.destroy());
  assert.equal(dialog.textContent, "");
});

test("cancel is prevented and delegated while close returns to Expand", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeScene();
  const store = createSceneStore(makeLayers(), { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  const closings: string[] = [];
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => closings.push("close"),
      stepTime: () => {},
    });
    document.body.append(panel.element);
    document.body.append(dialog);
    panel.openFull("about");
  });

  await act(async () => {
    const event = new window.Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  });
  assert.deepEqual(closings, ["close"]);

  await act(async () => {
    panel!.closeFull();
  });
  assert.equal(panel!.isOpen, false);
  assert.equal(
    document.activeElement,
    panel!.element.querySelector(".expand"),
  );

  await act(async () => panel!.destroy());
});

function installScrollSpy(context: { after: (hook: () => void) => void }): string[] {
  const scrolled: string[] = [];
  const prototype = globalThis.Element.prototype as unknown as {
    scrollIntoView?: () => void;
  };
  const original = prototype.scrollIntoView;
  prototype.scrollIntoView = function (this: Element) {
    scrolled.push((this as HTMLElement).id);
  };
  context.after(() => {
    prototype.scrollIntoView = original!;
  });

  return scrolled;
}

function makeDialog(): HTMLDialogElement {
  const dialog = document.createElement("dialog") as HTMLDialogElement;
  if (typeof dialog.showModal !== "function") {
    let open = false;
    Object.defineProperty(dialog, "open", {
      get: () => open,
      configurable: true,
    });
    dialog.showModal = () => {
      open = true;
    };
    dialog.close = () => {
      open = false;
    };
  }
  if (typeof dialog.scrollIntoView !== "function") {
    (dialog as unknown as Record<string, unknown>).scrollIntoView = () => {};
  }
  return dialog;
}

function makeLayers(): LayerDoc[] {
  return [
    {
      id: "rain",
      title: "Rainfall",
      units: "mm/month",
      style: { kind: "field", encodings: ["ramp"] },
    },
    {
      id: "terrain",
      title: "Terrain",
      units: "m",
      style: { kind: "terrain", encodings: ["shade"] },
    },
  ] as unknown as LayerDoc[];
}

function makeScene(): Scene {
  return {
    id: "test",
    title: "Test scene",
    generator: { name: "soe", version: "0.9.0" },
    version: "0.7",
    created: "2026-10-23T00:00:00Z",
    area: {
      boundary: {
        id: "test",
        name: "Test",
        level: "level",
        iso3: null,
        source: "geoBoundaries",
        licence: "CC BY 4.0",
        attribution: "Boundary credit",
      },
      bbox: [0, -1, 1, 1],
      geometry_href: "area.geojson",
      clipped_to_coverage: false,
    },
    period: null,
    layers: [
      {
        id: "rain",
        title: "Rainfall",
        units: "mm/month",
        source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
        style: { kind: "field", encodings: ["ramp"] },
        grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
        mask: { path: "mask.zarr", cells_inside: 100 },
        time: null,
        arrays: {},
      },
      {
        id: "terrain",
        title: "Terrain",
        units: "m",
        source: { name: "DEM", licence: "open", attribution: "DEM credit" },
        style: { kind: "terrain", encodings: ["shade"] },
        grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
        mask: { path: "mask.zarr", cells_inside: 100 },
        time: null,
        arrays: {},
      },
    ],
    data: { href: "data.zarr" },
    notices: { limits: ["Coarse terrain."] },
    credits: {
      lines: ["Rain credit", "DEM credit", "Boundary credit"],
      disclaimers: [],
      endorsement: "Endorsement.",
      terms_passthrough: "Terms.",
    },
  } as unknown as Scene;
}

function installBrowser(window: Window): void {
  const names = [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDialogElement",
    "SVGElement",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
  ] as const;
  for (const name of names) defineGlobal(name, window[name]);
  defineGlobal("window", window);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("localStorage", window.localStorage);
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
