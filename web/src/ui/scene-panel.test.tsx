import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import { assertSameNode } from "../testing/dom-assert.ts";
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
  assert.equal(dialog.childElementCount, 0);

  const charts = [...region.querySelectorAll("button")].find(
    (button) => button.textContent === "Charts",
  )!;
  await act(async () => {
    charts.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(region.textContent ?? "", /No charts for this scene/);

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

test("the docked header renders compact collapse and expand symbols", async (context) => {
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

  const header = panel!.element.querySelector(".panel-header") as HTMLElement;
  const collapse = header.querySelector(
    'button[aria-label="Collapse scene panel"]',
  ) as HTMLButtonElement;
  const expand = header.querySelector(
    'button[aria-label="Expand to full view"]',
  ) as HTMLButtonElement;
  assert.equal(collapse.textContent, "–");
  assert.equal(collapse.title, "Collapse");
  assert.equal(expand.textContent, "⤢");
  assert.equal(expand.title, "Expand to full view");
  assert.equal(expand.getAttribute("aria-haspopup"), "dialog");
  assert.ok(expand.classList.contains("expand"));

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
  assertSameNode(document.activeElement, creditsTab);

  await act(async () => {
    dialog.dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(closings, ["close"]);

  await act(async () => {
    panel!.closeFull();
  });
  assert.equal(panel!.isOpen, false);
  assertSameNode(
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
  assertSameNode(document.activeElement, creditsTab);
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
  assert.match(dialog.textContent ?? "", /Charts/);
  assert.match(dialog.textContent ?? "", /No rainfall accumulation|No charts/);
  const chartsTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "Charts",
  ) as HTMLButtonElement;
  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "Charts",
  );
  assertSameNode(document.activeElement, chartsTab);

  await act(async () => panel!.destroy());
});

test("reopening About after another tab focuses its tab and resets scroll", async (context) => {
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
  await act(async () => panel!.closeFull());

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
  assertSameNode(document.activeElement, aboutTab);
  assert.equal(main.scrollTop, 0);
  assert.match(dialog.textContent ?? "", /Test scene/);

  await act(async () => panel!.destroy());
});

test("a cold About open focuses its tab after the lazy load", async (context) => {
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

  assert.equal(panel!.isOpen, true);
  assert.match(dialog.textContent ?? "", /Test scene/);
  const aboutTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "About",
  ) as HTMLButtonElement;
  assert.equal(
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    "About",
  );
  assertSameNode(document.activeElement, aboutTab);
  assert.equal((dialog.querySelector("main") as HTMLElement).scrollTop, 0);

  await act(async () => panel!.destroy());
});

test(
  "a failed full-dialog load keeps the panel usable and retries on the next open",
  async (context) => {
    const window = new Window({ url: "http://localhost" });
    context.after(() => window.happyDOM.abort());
    installBrowser(window);
    const { act } = await import("react");
    const {
      createScenePanel,
      panelChunkLoaders,
      resetPanelChunkCacheForTest,
    } = await import("./scene-panel.tsx");
    resetPanelChunkCacheForTest();
    const originalFull = panelChunkLoaders.full;
    let attempts = 0;
    panelChunkLoaders.full = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("chunk failed"));

      return originalFull();
    };
    context.after(() => {
      panelChunkLoaders.full = originalFull;
    });
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

    assert.equal(panel!.isOpen, true);
    assert.match(dialog.textContent ?? "", /Could not load the full view/);
    assert.ok(panel!.element.querySelector(".panel-header"));
    assert.ok(panel!.element.querySelector(".panel-footer"));
    assert.match(panel!.element.textContent ?? "", /km²/);

    await act(async () => {
      panel!.closeFull();
    });
    await act(async () => {
      panel!.openFull("about");
    });

    assert.match(dialog.textContent ?? "", /Test scene/);
    const aboutTab = [...dialog.querySelectorAll('[role="tab"]')].find(
      (button) => button.textContent === "About",
    ) as HTMLButtonElement;
    assert.equal(
      dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      "About",
    );
    assertSameNode(document.activeElement, aboutTab);

    await act(async () => panel!.destroy());
  },
);

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
  assertSameNode(
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
  assertSameNode(document.activeElement, creditsTab);
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
  assertSameNode(dialog.querySelector("#notices-heading"), null);
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
  assertSameNode(document.activeElement, aboutTab);
  assert.equal(main.scrollTop, 0);
  assert.equal(dialog.querySelector("#notices-heading")?.textContent, "Notices and Limits");
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
  assertSameNode(document.activeElement, creditsTab);

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
  assertSameNode(
    document.activeElement,
    panel!.element.querySelector(".expand"),
  );

  await act(async () => panel!.destroy());
});

test("the chip previews the main chart and follows time and units", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  const chartsTab = [...panel!.element.querySelectorAll("button")].find(
    (button) => button.textContent === "Charts",
  )!;
  await act(async () => {
    chartsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(panel!.element.textContent ?? "", /Rain over time|Rain/);
  assert.ok(panel!.element.querySelector("svg"));

  await act(async () => {
    panel!.setTime("2019-02-01", "2019-02");
  });
  assert.match(panel!.element.textContent ?? "", /2019|10/);

  await act(async () => {
    store.dispatch({
      kind: "display",
      update: (display) => {
        display.layers.rain = { units: "in/month" };
      },
    });
  });
  assert.match(panel!.element.textContent ?? "", /in\/month/);

  await act(async () => panel!.destroy());
});

test(
  "a failed chart chip load keeps the panel usable and retries on the next Charts click",
  async (context) => {
    const window = new Window({ url: "http://localhost" });
    context.after(() => window.happyDOM.abort());
    installBrowser(window);
    const { act } = await import("react");
    const {
      createScenePanel,
      panelChunkLoaders,
      resetPanelChunkCacheForTest,
    } = await import("./scene-panel.tsx");
    resetPanelChunkCacheForTest();
    const originalChip = panelChunkLoaders.chip;
    let attempts = 0;
    panelChunkLoaders.chip = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("chunk failed"));

      return originalChip();
    };
    context.after(() => {
      panelChunkLoaders.chip = originalChip;
      resetPanelChunkCacheForTest();
    });
    const scene = makeChartableScene();
    const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
    const tab = (label: string) =>
      [...panel!.element.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      )!;
    const click = (button: HTMLElement) =>
      act(async () => {
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });

    await click(tab("Charts"));
    assert.match(panel!.element.textContent ?? "", /Could not load the chart preview/);
    assert.ok(tab("About"));
    assert.ok(panel!.element.querySelector(".expand"));

    await click(tab("About"));
    await click(tab("Charts"));
    assert.ok(panel!.element.querySelector("svg"));

    await act(async () => panel!.destroy());
  },
);

test("gallery opens detail and edit with focus restoration", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  assert.ok(dialog.querySelector(".chart-gallery"));
  const open = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Open",
  )!;
  await act(async () => {
    open.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-detail"));
  assert.ok(dialog.querySelector("details"));

  const back = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Back to charts",
  )!;
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-gallery"));
  assertSameNode(
    document.activeElement,
    dialog.querySelector('[data-chart-id] button'),
  );

  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.ok(dialog.querySelector(".editor-preview svg"));
  const tabs = [...dialog.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
  assert.ok(tabs.every((tab) => tab.disabled || tab.getAttribute("aria-selected") === "true"));

  await act(async () => panel!.destroy());
});

test("new chart saves to its close-up while cancel keeps the store untouched", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
  const before = JSON.stringify(store.getSnapshot().charts);
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
    panel.openFull("charts");
  });
  const creation = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "+ New chart",
  )!;
  await act(async () => {
    creation.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.equal(openings.length, 0);

  const cancel = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  )!;
  await act(async () => {
    cancel.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(JSON.stringify(store.getSnapshot().charts), before);
  assert.ok(dialog.querySelector(".chart-gallery"));

  await act(async () => {
    const second = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "+ New chart",
    )!;
    second.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const save = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.notEqual(JSON.stringify(store.getSnapshot().charts), before);
  assert.ok(dialog.querySelector(".chart-detail"));

  await act(async () => panel!.destroy());
});

test("dirty editor back asks to save, discard or keep editing", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
    panel.openFull("charts");
  });
  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const title = dialog.querySelector('.chart-editor input[type="text"]') as HTMLInputElement;
  await act(async () => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    native?.set?.call(title, "Dirty title");
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(panel!.isEditorDirty(), true);

  const back = [...dialog.querySelectorAll(".chart-editor button")].find(
    (button) => button.textContent === "Back to charts",
  )!;
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(dialog.textContent ?? "", /unsaved changes/);
  assert.equal(openings.length, 0);

  const keep = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Keep editing",
  )!;
  await act(async () => {
    keep.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.equal(panel!.isEditorDirty(), true);

  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const discard = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Discard",
  )!;
  await act(async () => {
    discard.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-gallery"));
  assert.equal(panel!.isEditorDirty(), false);

  await act(async () => panel!.destroy());
});

test("escape with a dirty draft holds the dialog and restores focus", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
    panel.openFull("charts");
  });
  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const title = dialog.querySelector('.chart-editor input[type="text"]') as HTMLInputElement;
  await act(async () => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    native?.set?.call(title, "Dirty title");
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    const event = new window.Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  });
  assert.deepEqual(closings, []);
  assert.match(dialog.textContent ?? "", /unsaved changes/);
  assert.equal(panel!.isOpen, true);

  const discard = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Discard",
  )!;
  await act(async () => {
    discard.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(closings, ["close"]);

  await act(async () => panel!.destroy());
});

test("dirty tabs stay blocked while preserving the draft", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const title = dialog.querySelector('.chart-editor input[type="text"]') as HTMLInputElement;
  await act(async () => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    native?.set?.call(title, "Unsaved keyboard draft");
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    const chartsTab = [...dialog.querySelectorAll('[role="tab"]')].find(
      (button) => button.textContent === "Charts",
    ) as HTMLButtonElement;
    await act(async () => {
      chartsTab.focus();
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true });
      chartsTab.dispatchEvent(event);
    });
    assert.equal(
      dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      "Charts",
    );
    assert.ok(dialog.querySelector(".chart-editor"));
  }
  assert.equal(panel!.isEditorDirty(), true);
  assert.equal(
    (dialog.querySelector('.chart-editor input[type="text"]') as HTMLInputElement).value,
    "Unsaved keyboard draft",
  );
  const aboutTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "About",
  ) as HTMLButtonElement;
  assert.equal(aboutTab.disabled, true);
  await act(async () => panel!.destroy());
});

test("clean editor tabs stay blocked for every navigation key", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(panel!.isEditorDirty(), false);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    const chartsTab = [...dialog.querySelectorAll('[role="tab"]')].find(
      (button) => button.textContent === "Charts",
    ) as HTMLButtonElement;
    await act(async () => {
      chartsTab.focus();
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true });
      chartsTab.dispatchEvent(event);
    });
    assert.equal(
      dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      "Charts",
    );
    assert.ok(dialog.querySelector(".chart-editor"));
  }
  const aboutTab = [...dialog.querySelectorAll('[role="tab"]')].find(
    (button) => button.textContent === "About",
  ) as HTMLButtonElement;
  assert.equal(aboutTab.disabled, true);
  await act(async () => panel!.destroy());
});

test("close confirm save completes pending close and keep restores focus", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
    panel.openFull("charts");
  });
  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const title = dialog.querySelector('.chart-editor input[type="text"]') as HTMLInputElement;
  await act(async () => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    native?.set?.call(title, "Saved from close confirmation");
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    const event = new window.Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
  });
  const save = [...dialog.querySelector(".chart-confirm")!.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(closings, ["close"]);
  assertSameNode(dialog.querySelector(".chart-detail"), null);
  await act(async () => panel!.destroy());
});

test("gallery detail editor focus lands on exact controls", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  const open = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Open",
  )! as HTMLButtonElement;
  await act(async () => {
    open.focus();
    open.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(document.activeElement, dialog.querySelector("[data-detail-back]"));
  const editDetail = dialog.querySelector("[data-detail-edit]") as HTMLButtonElement;
  await act(async () => {
    editDetail.focus();
    editDetail.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(
    document.activeElement,
    dialog.querySelector(".chart-editor .editor-head button"),
  );
  const cancel = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  )! as HTMLButtonElement;
  await act(async () => {
    cancel.focus();
    cancel.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(document.activeElement, dialog.querySelector("[data-detail-back]"));
  const back = dialog.querySelector("[data-detail-back]") as HTMLButtonElement;
  await act(async () => {
    back.focus();
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const cardButton = dialog.querySelector('[data-chart-id] button') as HTMLButtonElement;
  assertSameNode(document.activeElement, cardButton);
  await act(async () => panel!.destroy());
});

test("arbitrary chart ids focus without selector failure", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createSceneStore } = await import("../scene-store.ts");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
  const current = store.getSnapshot().charts.definitions[0];
  store.dispatch({
    kind: "saveChart",
    definition: { ...current, id: 'a"b', title: "Quoted" },
  });
  const { createScenePanel } = await import("./scene-panel.tsx");
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
  const quotedCard = [...dialog.querySelectorAll("[data-chart-id]")].find(
    (element) => (element as HTMLElement).dataset.chartId === 'a"b',
  ) as HTMLElement;
  assert.ok(quotedCard);
  const open = [...quotedCard.querySelectorAll("button")].find(
    (button) => button.textContent === "Open",
  )!;
  await act(async () => {
    open.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(dialog.textContent ?? "", /Quoted/);
  const back = dialog.querySelector("[data-detail-back]") as HTMLButtonElement;
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const currentCard = [...dialog.querySelectorAll("[data-chart-id]")].find(
    (element) => (element as HTMLElement).dataset.chartId === 'a"b',
  ) as HTMLElement;
  assert.ok(currentCard, "quoted card stays in the gallery after Back");
  const quotedButton = currentCard.querySelector("button") as HTMLButtonElement;
  assert.ok(document.activeElement === quotedButton, "focus returns to the quoted card button");
  await act(async () => panel!.destroy());
});

test("chip uses one covering row and unavailable outside coverage", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeDistinctScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  const chartsTab = [...panel!.element.querySelectorAll("button")].find(
    (button) => button.textContent === "Charts",
  )!;
  await act(async () => {
    chartsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    panel!.setTime("2020-01-01", "2020-01");
  });
  const caption = panel!.element.querySelector("figcaption")?.textContent ?? "";
  const tooltip = panel!.element.querySelector(".chart-tooltip")?.textContent ?? "";
  assert.ok(caption.includes("1 mm/month"));
  assert.ok(tooltip.includes("1 mm/month"));
  assert.equal(panel!.element.querySelectorAll(".chart-cursor").length, 1);
  await act(async () => {
    panel!.setTime("2019-01-01", "2019-01");
  });
  assert.match(panel!.element.textContent ?? "", /unavailable/);
  assert.match(panel!.element.querySelector(".chart-tooltip")?.textContent ?? "", /No observation/);
  await act(async () => panel!.destroy());
});

test("chip follows effective palette and collapse preserves preview", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  const chartsTab = [...panel!.element.querySelectorAll("button")].find(
    (button) => button.textContent === "Charts",
  )!;
  await act(async () => {
    chartsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const mark = () =>
    panel!.element.querySelector("rect")?.getAttribute("fill")
    ?? panel!.element.querySelector("polyline, polygon")?.getAttribute("stroke");
  const before = mark();
  await act(async () => {
    store.dispatch({
      kind: "display",
      update: (display) => {
        display.layers.rain = { palette: "cividis" };
      },
    });
  });
  const after = mark();
  assert.notEqual(before, after);
  const collapse = panel!.element.querySelector(
    'button[aria-label="Collapse scene panel"]',
  )! as HTMLButtonElement;
  await act(async () => {
    collapse.focus();
    collapse.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(panel!.element.textContent ?? "", /Show details/);
  const shown = [...panel!.element.querySelectorAll("button")].find(
    (button) => button.textContent === "Show details",
  )! as HTMLButtonElement;
  assertSameNode(document.activeElement, shown);
  assert.match(panel!.element.textContent ?? "", /note/);
  await act(async () => {
    shown.focus();
    shown.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(panel!.element.querySelector("svg"));
  assert.match(panel!.element.textContent ?? "", /Rain/);
  const restored = panel!.element.querySelector(
    'button[aria-label="Collapse scene panel"]',
  )! as HTMLButtonElement;
  assertSameNode(document.activeElement, restored);
  await act(async () => panel!.destroy());
});

test("sync notice appears inside gallery and clears on recovery", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  await act(async () => {
    panel!.setSyncNotice("Charts are kept for this visit only.");
  });
  assert.match(dialog.textContent ?? "", /kept for this visit/);
  await act(async () => {
    panel!.setSyncNotice("Charts are kept for this visit only.");
  });
  assert.equal(
    [...dialog.textContent!.matchAll(/kept for this visit/g)].length,
    1,
  );
  await act(async () => {
    panel!.setSyncNotice(null);
  });
  assert.equal((dialog.textContent ?? "").includes("kept for this visit"), false);
  await act(async () => panel!.destroy());
});

test("outer confirmation focuses Save and Keep editing restores the invoker", async (context) => {
  const pending = await openDirtyEditor(context, "Focus draft");
  const { dialog, panel, input, act } = pending;
  const buttons = await openOuterConfirm(pending);
  const save = buttons.find((button) => button.textContent === "Save") as HTMLButtonElement;
  assert.ok(document.activeElement === save, "outer confirmation focuses its Save control");

  const keep = buttons.find((button) => button.textContent === "Keep editing")!;
  await act(async () => {
    keep.dispatchEvent(new pending.window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.equal(input.value, "Focus draft");
  assert.ok(document.activeElement === input, "Keep editing restores focus to the invoker");

  await act(async () => panel.destroy());
});

test("sync notice stays visible while editing until recovery", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  await act(async () => {
    panel!.setSyncNotice("Charts are kept for this visit only.");
  });
  assert.match(dialog.textContent ?? "", /kept for this visit/);

  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.match(dialog.textContent ?? "", /kept for this visit/);
  assert.equal(
    [...dialog.textContent!.matchAll(/kept for this visit/g)].length,
    1,
  );

  await act(async () => {
    panel!.setSyncNotice(null);
  });
  assert.equal((dialog.textContent ?? "").includes("kept for this visit"), false);

  await act(async () => panel!.destroy());
});

test("pending close Keep editing keeps the draft and history", async (context) => {
  const pending = await openDirtyEditor(context, "Pending history draft");
  const { window, dialog, panel, input, act } = pending;
  const buttons = await openOuterConfirm(pending);
  const keep = buttons.find((button) => button.textContent === "Keep editing")!;
  await act(async () => {
    keep.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.equal(input.value, "Pending history draft");
  assert.deepEqual(window.history.state, { panel: "charts" });

  await act(async () => panel.destroy());
});

test("pending close Discard completes the close through history", async (context) => {
  const pending = await openDirtyEditor(context, "Pending discard draft");
  const { dialog, panel, store, backs, act } = pending;
  const buttons = await openOuterConfirm(pending);
  const beforeDiscard = JSON.stringify(store.getSnapshot().charts);
  const discard = buttons.find((button) => button.textContent === "Discard")!;
  await act(async () => {
    discard.dispatchEvent(new pending.window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(backs, ["back"]);
  assert.ok(dialog.querySelector(".chart-gallery"));
  assert.equal(JSON.stringify(store.getSnapshot().charts), beforeDiscard);
  await act(async () => {
    panel.closeFull();
  });
  assert.equal(panel.isOpen, false);
  assert.ok(
    document.activeElement === panel.element.querySelector(".expand"),
    "closing returns focus to Expand",
  );

  await act(async () => panel.destroy());
});

test("pending close Save persists the draft and closes", async (context) => {
  const pending = await openDirtyEditor(context, "Pending save draft");
  const { dialog, panel, store, backs, act } = pending;
  const buttons = await openOuterConfirm(pending);
  const save = buttons.find((button) => button.textContent === "Save")!;
  await act(async () => {
    save.dispatchEvent(new pending.window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(backs, ["back"]);
  assert.ok(dialog.querySelector(".chart-gallery"));
  const savedTitles = store.getSnapshot().charts.definitions.map((entry) => entry.title);
  assert.ok(savedTitles.includes("Pending save draft"));
  await act(async () => {
    panel.closeFull();
  });
  assert.equal(panel.isOpen, false);

  await act(async () => panel.destroy());
});

test("invalid pending Save keeps the draft, decision focus and history", async (context) => {
  const pending = await openDirtyEditor(context, "Invalid draft");
  const { window, dialog, panel, store, act } = pending;
  const rangeFieldset = [...dialog.querySelectorAll("fieldset")].find(
    (fieldset) => (fieldset.querySelector("legend")?.textContent ?? "").includes("Y range"),
  )!;
  const autoBox = rangeFieldset.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => {
    autoBox.click();
  });
  const numbers = [...dialog.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
  await act(async () => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    native?.set?.call(numbers[0], "11");
    numbers[0].dispatchEvent(new window.Event("input", { bubbles: true }));
    numbers[0].dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    native?.set?.call(numbers[1], "12");
    numbers[1].dispatchEvent(new window.Event("input", { bubbles: true }));
    numbers[1].dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  const beforeInvalid = JSON.stringify(store.getSnapshot().charts);
  const buttons = await openOuterConfirm(pending);
  const invalidSave = buttons.find(
    (button) => button.textContent === "Save",
  ) as HTMLButtonElement;
  assert.ok(
    document.activeElement === invalidSave,
    "outer confirmation focuses its Save control",
  );
  await act(async () => {
    invalidSave.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(dialog.textContent ?? "", /observed|baseline/);
  assert.ok(dialog.querySelector(".chart-editor"));
  assert.ok(dialog.querySelector(".chart-confirm"));
  assert.ok(
    document.activeElement === invalidSave,
    "rejected Save keeps focus on the decision control",
  );
  assert.equal(
    (dialog.querySelector('.chart-editor input[type="text"]') as HTMLInputElement).value,
    "Invalid draft",
  );
  assert.equal(JSON.stringify(store.getSnapshot().charts), beforeInvalid);
  assert.deepEqual(window.history.state, { panel: "charts" });

  await act(async () => panel.destroy());
});

test("the charts gallery shows its download section below it", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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

  const gallery = dialog.querySelector(".chart-gallery");
  const downloads = dialog.querySelector(".chart-downloads");
  assert.ok(gallery);
  assert.ok(downloads);
  assert.equal(
    gallery!.compareDocumentPosition(downloads!) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const labels = [...downloads!.querySelectorAll("button")].map((button) => button.textContent);
  assert.ok(labels.includes("Area means (CSV)"));
  assert.ok(labels.includes("Elevation distribution (CSV)"));

  await act(async () => panel!.destroy());
});

test("the gallery download writes attribution and cleans up its object url", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const downloads = installDownloadCapture(context);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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

  const button = [...dialog.querySelectorAll(".chart-downloads button")].find(
    (entry) => entry.textContent === "Area means (CSV)",
  )!;
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(downloads.blobs.length, 1);
  const content = await downloads.blobs[0].text();
  assert.ok(content.includes("rain_mean [mm/month]"));
  assert.ok(content.includes("Rain credit"));
  assert.ok(content.includes("Terms."));
  assert.equal(downloads.revoked.length, 1);
  assert.equal(document.body.contains(downloads.anchors[0]), false);

  await act(async () => panel!.destroy());
});

test("detail downloads follow the selected shape from the gallery", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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

  const open = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Open",
  )!;
  await act(async () => {
    open.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-detail"));
  const detailLabels = [...dialog.querySelectorAll(".detail-downloads button")]
    .map((button) => button.textContent);
  assert.ok(detailLabels.includes("Area means (CSV)"));
  assert.equal(detailLabels.includes("By month (CSV)"), false);

  const back = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Back to charts",
  )!;
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-gallery"));
  assert.ok(dialog.querySelector(".chart-downloads"));

  await act(async () => panel!.destroy());
});

test("main switches keep type fidelity while About and collapse stay put", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
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
  const chartsTab = [...panel!.element.querySelectorAll("button")].find(
    (button) => button.textContent === "Charts",
  )!;
  await act(async () => {
    chartsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(panel!.element.textContent ?? "", /Rain over time · Over time · Bar/);
  assert.ok(panel!.element.querySelector("rect"));

  const mains = [...dialog.querySelectorAll("button")].filter(
    (button) => button.textContent === "Use as main",
  );
  await act(async () => {
    mains[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(panel!.element.textContent ?? "", /Terrain distribution · Hypsometry · Area/);
  assert.ok(panel!.element.querySelector("polygon"));

  await act(async () => {
    store.dispatch({
      kind: "saveChart",
      definition: {
        id: "rain-line",
        title: "Rain over time",
        source: { layerId: "rain", shape: "time_series" },
        chartType: "line",
        options: {},
      },
      makeMain: false,
    });
  });
  await act(async () => {
    buttonNamed(galleryCardFor(dialog, "rain:time_series"), "Use as main").click();
  });
  await act(async () => {
    panel!.element.querySelector("svg")!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
  });
  assert.match(panel!.element.querySelector(".chart-tooltip")?.textContent ?? "", /2019-01-01/);
  const lineCard = [...dialog.querySelectorAll(".gallery-card")].find(
    (card) => (card as HTMLElement).dataset.chartId === "rain-line",
  )!;
  const lineButton = [...lineCard.querySelectorAll("button")].find(
    (button) => button.textContent === "Use as main",
  )!;
  await act(async () => {
    lineButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(panel!.element.textContent ?? "", /Rain over time · Over time · Line/);
  assert.ok(panel!.element.querySelector("polyline"));
  assert.match(panel!.element.querySelector(".chart-tooltip")?.textContent ?? "", /2021-06-01/);

  const aboutTab = [...panel!.element.querySelectorAll("button")].find(
    (button) => button.textContent === "About",
  )!;
  await act(async () => {
    aboutTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(aboutTab.getAttribute("aria-pressed"), "true");
  const summary = panel!.element.querySelector(".panel-body")?.textContent ?? "";
  assert.match(summary, /km²/);
  assert.match(summary, /2019.*2021/);
  assert.match(summary, /2 layers/);
  await act(async () => {
    buttonNamed(galleryCardFor(dialog, "terrain:distribution"), "Use as main").click();
  });
  assert.equal(store.getSnapshot().charts.mainChartId, "terrain:distribution");
  assert.equal(aboutTab.getAttribute("aria-pressed"), "true");
  assert.equal(panel!.element.querySelector(".panel-body")?.textContent, summary);
  assertSameNode(panel!.element.querySelector("svg"), null);
  const collapse = panel!.element.querySelector(
    'button[aria-label="Collapse scene panel"]',
  )!;
  await act(async () => {
    collapse.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(panel!.element.querySelector("svg"), null);
  assert.match(panel!.element.textContent ?? "", /Show details/);
  await act(async () => {
    buttonNamed(galleryCardFor(dialog, "rain-line"), "Use as main").click();
  });
  assert.equal(store.getSnapshot().charts.mainChartId, "rain-line");
  assertSameNode(panel!.element.querySelector("svg"), null);
  assert.match(panel!.element.textContent ?? "", /Show details/);
  await act(async () => {
    buttonNamed(panel!.element, "Show details").click();
  });
  assert.equal(buttonNamed(panel!.element, "About").getAttribute("aria-pressed"), "true");
  assert.equal(panel!.element.querySelector(".panel-body")?.textContent, summary);
  await act(async () => {
    buttonNamed(panel!.element, "Charts").click();
  });
  assert.match(panel!.element.textContent ?? "", /Rain over time · Over time · Line/);
  assert.ok(panel!.element.querySelector("polyline"));
  await act(async () => panel!.destroy());
});

test("detail main edits and delete or reset update both panel roots", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
  store.dispatch({
    kind: "saveChart",
    definition: {
      id: "rain-line",
      title: "Custom rain",
      source: { layerId: "rain", shape: "time_series" },
      chartType: "line",
      options: {},
    },
  });
  const dialog = makeDialog();
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen: () => {},
      requestClose: () => {},
      stepTime: () => {},
    });
    document.body.append(panel.element, dialog);
    panel.openFull("charts");
  });
  await act(async () => {
    buttonNamed(panel!.element, "Charts").click();
  });
  await act(async () => {
    buttonNamed(galleryCardFor(dialog, "rain-line"), "Open").click();
  });
  await act(async () => {
    buttonNamed(dialog.querySelector(".chart-detail")!, "Use as main").click();
  });

  assert.equal(store.getSnapshot().charts.mainChartId, "rain-line");
  assert.ok(dialog.querySelector(".chart-detail"));
  assert.match(dialog.querySelector('.chart-detail > p[role="status"]')?.textContent ?? "", /main/);
  assert.match(panel!.element.textContent ?? "", /Custom rain · Over time · Line/);
  assert.ok(panel!.element.querySelector("polyline"));
  await act(async () => {
    buttonNamed(dialog.querySelector(".chart-detail")!, "Edit").click();
  });
  const type = [...dialog.querySelectorAll("label")].find(
    (label) => label.textContent?.startsWith("Type"),
  )!.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!;
    native.set!.call(type, "area");
    type.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    buttonNamed(dialog.querySelector(".editor-foot")!, "Save").click();
  });
  assert.equal(store.getSnapshot().charts.mainChartId, "rain-line");
  assert.equal(
    store.getSnapshot().charts.definitions.find((definition) => definition.id === "rain-line")!
      .chartType,
    "area",
  );
  assert.ok(dialog.querySelector(".chart-detail polygon"));
  assert.match(panel!.element.textContent ?? "", /Custom rain · Over time · Area/);
  assert.ok(panel!.element.querySelector("polygon"));
  await act(async () => {
    buttonNamed(dialog.querySelector(".chart-detail")!, "Delete").click();
  });
  assert.ok(dialog.querySelector(".chart-gallery"));
  assert.equal(store.getSnapshot().charts.mainChartId, "rain:time_series");
  assert.match(panel!.element.textContent ?? "", /Rain over time · Over time · Bar/);
  assert.ok(panel!.element.querySelector("rect"));
  await act(async () => {
    buttonNamed(galleryCardFor(dialog, "terrain:distribution"), "Use as main").click();
  });
  assert.ok(panel!.element.querySelector("polygon"));
  await act(async () => {
    buttonNamed(dialog, "Reset charts").click();
  });
  assert.equal(store.getSnapshot().charts.mainChartId, "rain:time_series");
  assert.match(panel!.element.textContent ?? "", /Rain over time · Over time · Bar/);
  assert.ok(panel!.element.querySelector("rect"));
  assert.ok(galleryCardFor(dialog, "rain:time_series").querySelector(".chart-main-badge"));
  await act(async () => panel!.destroy());
});

test("notes focus the detail heading and back restores the notes action", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const scrolled = installScrollSpy(context);
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
  await act(async () => {
    store.dispatch({
      kind: "saveChart",
      definition: {
        id: 'we"ird',
        title: "Quoted chart",
        source: { layerId: "terrain", shape: "distribution" },
        chartType: "area",
        options: {},
      },
      makeMain: false,
    });
  });
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
  const quotedCard = [...dialog.querySelectorAll(".gallery-card")].find(
    (card) => (card as HTMLElement).dataset.chartId === 'we"ird',
  )!;
  const notesButton = quotedCard.querySelector(".chart-notes-button") as HTMLButtonElement;
  assert.equal(
    notesButton.getAttribute("aria-label"),
    "Notes for Quoted chart; opens chart detail",
  );
  await act(async () => {
    notesButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-detail"));
  const heading = dialog.querySelector("[data-chart-notes-heading]") as HTMLElement;
  assert.equal(heading.textContent, "Notes");
  assertSameNode(document.activeElement, heading);
  assert.equal(scrolled.length, 1);
  assert.equal(scrolled[0], heading.id);
  const back = dialog.querySelector("[data-detail-back]") as HTMLButtonElement;
  await act(async () => {
    back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(dialog.querySelector(".chart-gallery"));
  const remountedCard = galleryCardFor(dialog, 'we"ird');
  const remountedNotes = remountedCard.querySelector(".chart-notes-button");
  assert.ok(remountedNotes);
  assertSameNode(document.activeElement, remountedNotes);
  await act(async () => panel!.destroy());
});

function buttonNamed(host: ParentNode, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === text);
  assert.ok(button, `Expected button ${text}`);

  return button as HTMLButtonElement;
}

function galleryCardFor(host: ParentNode, id: string): HTMLElement {
  const card = [...host.querySelectorAll<HTMLElement>(".gallery-card")].find(
    (entry) => entry.dataset.chartId === id,
  );
  assert.ok(card, `Expected gallery card ${id}`);

  return card;
}

function installDownloadCapture(context: { after: (hook: () => void) => void }) {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const anchors: HTMLAnchorElement[] = [];
  const originalCreate = document.createElement.bind(document);
  const originalObjectUrl = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  (document as unknown as Record<string, unknown>).createElement = (tag: string) => {
    const element = originalCreate(tag);
    if (tag === "a") anchors.push(element as HTMLAnchorElement);

    return element;
  };
  (URL as unknown as Record<string, unknown>).createObjectURL = (blob: Blob) => {
    blobs.push(blob);

    return "blob:fake-download";
  };
  (URL as unknown as Record<string, unknown>).revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  context.after(() => {
    (document as unknown as Record<string, unknown>).createElement = originalCreate;
    URL.createObjectURL = originalObjectUrl;
    URL.revokeObjectURL = originalRevoke;
  });

  return { blobs, revoked, anchors };
}

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

function makeChartableScene(): Scene {
  const base = makeScene();
  const values = monthlyValues(30);

  return {
    ...base,
    period: { start: "2019-01-01", end: "2021-07-01", step: "P1M" },
    layers: [
      {
        id: "rain",
        title: "Rain",
        units: "mm/month",
        source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
        style: { kind: "field", encodings: ["ramp"] },
        grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
        mask: { path: "mask.zarr", cells_inside: 100 },
        time: { step: "P1M", values, end: "2021-07-01", method: "sum" },
        area_series: {
          statistic: "mean",
          weights: "cell_area_inside_outline",
          values: values.map(() => 10),
          valid_fraction: values.map(() => 1),
        },
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
        distribution: {
          statistic: "quantiles",
          weights: "cell_area_inside_outline",
          percent: 1,
          values: Array.from({ length: 101 }, (_, index) => index * 10),
          min: 0,
          max: 1000,
          mean: 500,
          valid_fraction: 0.9,
          reference_values: [],
        },
        arrays: {},
      },
    ],
  } as unknown as Scene;
}

function makeDistinctScene(): Scene {
  const base = makeScene();
  const values = ["2020-01-01", "2020-02-01", "2020-03-01"];

  return {
    ...base,
    period: { start: values[0], end: "2020-04-01", step: "P1M" },
    layers: [
      {
        id: "rain",
        title: "Rainfall",
        units: "mm/month",
        source: { name: "Rain", licence: "CC BY 4.0", attribution: "Rain credit" },
        style: { kind: "field", encodings: ["ramp"], palette: "batlow" },
        grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
        mask: { path: "mask.zarr", cells_inside: 100 },
        time: { step: "P1M", values, end: "2020-04-01", method: "sum" },
        area_series: {
          statistic: "mean",
          weights: "cell_area_inside_outline",
          values: [1, 100, null],
          valid_fraction: [1, 1, 0],
        },
        arrays: {},
      },
    ],
  } as unknown as Scene;
}

function monthlyValues(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2019, index, 1));
    return date.toISOString().slice(0, 10);
  });
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
    "HTMLDivElement",
    "HTMLSelectElement",
    "HTMLInputElement",
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

async function openDirtyEditor(
  context: { after(hook: () => void): void },
  title: string,
) {
  const window = new Window({ url: "https://example.test/a/?scene=test" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const previousHistory = (globalThis as Record<string, unknown>).history;
  (globalThis as Record<string, unknown>).history = window.history;
  context.after(() => {
    (globalThis as Record<string, unknown>).history = previousHistory;
  });
  const { act } = await import("react");
  const { createScenePanel } = await import("./scene-panel.tsx");
  const scene = makeChartableScene();
  const store = createSceneStore(scene.layers, { layers: {}, off: new Set(), showAs: {} });
  const dialog = makeDialog();
  document.body.append(dialog);
  const backs: string[] = [];
  let panel: ReturnType<typeof createScenePanel> | null = null;
  await act(async () => {
    panel = createScenePanel(scene, dialog, store, {
      requestOpen(tab) {
        window.history.pushState({ panel: tab }, "", "/a/?scene=test");
        panel!.openFull(tab);
      },
      requestClose() {
        if (window.history.state?.panel) {
          backs.push("back");
          window.history.back();
        } else {
          panel!.closeFull();
        }
      },
      stepTime() {},
    });
    document.body.append(panel.element);
    panel.openFull("charts");
  });
  await act(async () => {
    window.history.pushState({ panel: "charts" }, "", "/a/?scene=test");
  });
  const edit = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const input = dialog.querySelector('.chart-editor input[type="text"]') as HTMLInputElement;
  await act(async () => {
    input.focus();
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    native?.set?.call(input, title);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(panel!.isEditorDirty(), true);

  return { window, dialog, panel: panel!, store, backs, input, act };
}

async function openOuterConfirm(pending: Awaited<ReturnType<typeof openDirtyEditor>>) {
  const { window, dialog, act } = pending;
  await act(async () => {
    const event = new window.Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
  });
  assert.ok(dialog.querySelector(".chart-confirm"));
  assert.deepEqual(window.history.state, { panel: "charts" });

  return [...dialog.querySelectorAll(".chart-confirm button")];
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
