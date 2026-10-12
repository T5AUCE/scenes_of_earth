import { creditsLine, renderAbout, renderCredits, summaryText } from "./about";
import { makeHtmlElement } from "./html";
import { noticeCount } from "./scene-info";
import type { Scene } from "./types";

export const PANEL_TABS = ["charts", "about", "credits"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

const TAB_LABELS: Record<PanelTab, string> = {
  charts: "Charts",
  about: "About",
  credits: "Credits",
};
const CHARTS_PLACEHOLDER = "Charts for this scene are not available yet.";
const DOCKED_TABS = ["charts", "about"] as const;

export interface PanelHooks {
  // The owner records the history entry, then calls openFull or closeFull.
  requestOpen(tab: PanelTab): void;
  requestClose(): void;
  stepTime(delta: number): void;
}

// The docked panel is always usable; the dialog is its whole-window view.
export function createScenePanel(scene: Scene, dialog: HTMLDialogElement, hooks: PanelHooks) {
  const collapsed = makeCollapsed(scene, hooks);
  const full = makeFull(scene, dialog, hooks);

  return {
    element: collapsed.element,
    setTimeLabel: full.setTimeLabel,

    openFull(tab: PanelTab) {
      if (!dialog.open) dialog.showModal();
      full.selectTab(tab);
    },

    closeFull() {
      if (!dialog.open) return;

      dialog.close();
      collapsed.expand.focus();
    },

    get isOpen() {
      return dialog.open;
    },

    destroy() {
      if (dialog.open) dialog.close();
      dialog.oncancel = null;
      dialog.replaceChildren();
      collapsed.element.remove();
    },
  };
}

function makeCollapsed(scene: Scene, hooks: PanelHooks) {
  const element = makeHtmlElement("section");
  element.className = "scene-panel";
  element.setAttribute("role", "region");
  element.setAttribute("aria-label", "Scene details");

  let selected: PanelTab = "about";

  const header = makeHtmlElement("div", "", element);
  header.className = "panel-header";
  // The mouse shortcut only; the Expand button is the keyboard route.
  header.ondblclick = () => hooks.requestOpen(selected);

  // Pass B puts a mini chart under Charts; until then it shows the placeholder.
  const body = makeHtmlElement("div", "", element);
  body.className = "panel-body";

  const chips = DOCKED_TABS.map((tab) => {
    const chip = makeHtmlElement("button", TAB_LABELS[tab], header);
    chip.onclick = () => select(tab);

    return { tab, chip };
  });

  const select = (tab: PanelTab) => {
    selected = tab;
    body.textContent = tab === "charts" ? CHARTS_PLACEHOLDER : summaryText(scene);
    for (const { tab: chipTab, chip } of chips) {
      chip.setAttribute("aria-pressed", String(chipTab === tab));
    }
  };

  select(selected);

  const count = noticeCount(scene);
  if (count) {
    const badge = makeHtmlElement("button", `⚠ ${count}`, header);
    badge.title = "Notices and limits";
    badge.onclick = () => hooks.requestOpen("about");
  }

  const expand = makeHtmlElement("button", "Expand ⤢", header);
  expand.className = "expand";
  expand.setAttribute("aria-haspopup", "dialog");
  expand.onclick = () => hooks.requestOpen(selected);

  const footer = makeHtmlElement("button", `${creditsLine(scene)} · Open full view →`, element);
  footer.className = "panel-footer";
  footer.onclick = () => hooks.requestOpen("credits");

  return { element, expand };
}

function makeFull(scene: Scene, dialog: HTMLDialogElement, hooks: PanelHooks) {
  dialog.replaceChildren();

  const header = makeHtmlElement("header", "", dialog);
  const title = makeHtmlElement("h2", scene.title, header);
  title.className = "full-title";

  const tabs = makeHtmlElement("div", "", header);
  tabs.className = "tabs";
  tabs.setAttribute("role", "tablist");

  const tabButtons = PANEL_TABS.map((tab) => {
    const button = makeHtmlElement("button", TAB_LABELS[tab], tabs);
    button.setAttribute("role", "tab");

    return { tab, button };
  });

  const timeControl = makeTimeControl(hooks);
  header.append(timeControl.element);

  const close = makeHtmlElement("button", "✕ Back to scene", header);
  close.onclick = () => hooks.requestClose();

  const content = makeHtmlElement("main", "", dialog);
  content.setAttribute("role", "tabpanel");

  // Esc and the Android back gesture arrive as cancel; history decides what closes.
  dialog.oncancel = (event) => {
    event.preventDefault();
    hooks.requestClose();
  };

  const selectTab = (selected: PanelTab) => {
    for (const { tab, button } of tabButtons) {
      const isSelected = tab === selected;
      button.setAttribute("aria-selected", String(isSelected));
      button.tabIndex = isSelected ? 0 : -1;
      if (isSelected) button.focus();
    }

    content.replaceChildren(renderTab(scene, selected));
    content.scrollTop = 0;
  };

  tabs.onkeydown = (event) => {
    const current = tabButtons.findIndex(({ button }) => button === event.target);
    const target = tabIndexForKey(event.key, current, tabButtons.length);
    if (target === null) return;

    event.preventDefault();
    selectTab(tabButtons[target].tab);
  };

  for (const { tab, button } of tabButtons) button.onclick = () => selectTab(tab);

  return { selectTab, setTimeLabel: timeControl.setLabel };
}

// Arrow keys wrap; Home and End jump, as in the WAI-ARIA tabs pattern.
function tabIndexForKey(key: string, current: number, count: number) {
  if (current < 0) return null;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;

  return null;
}

function renderTab(scene: Scene, tab: PanelTab) {
  if (tab === "about") return renderAbout(scene);
  if (tab === "credits") return renderCredits(scene);

  return makeHtmlElement("p", CHARTS_PLACEHOLDER);
}

// Shown only for scenes with a time axis; it drives the same timeline as the time bar.
function makeTimeControl(hooks: PanelHooks) {
  const element = makeHtmlElement("div");
  element.className = "mini-time";
  element.hidden = true;

  const previous = makeHtmlElement("button", "◀", element);
  previous.setAttribute("aria-label", "Previous step");
  previous.onclick = () => hooks.stepTime(-1);

  const label = makeHtmlElement("span", "", element);

  const next = makeHtmlElement("button", "▶", element);
  next.setAttribute("aria-label", "Next step");
  next.onclick = () => hooks.stepTime(1);

  return {
    element,
    setLabel(text: string | null) {
      element.hidden = text === null;
      label.textContent = text ?? "";
    },
  };
}
