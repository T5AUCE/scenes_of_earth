/** Port the docked scene panel and its full-view dialog to React without charts. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { creditsLine, NOTICES_HEADING_ID, renderAbout, renderCredits, summaryText } from "../about";
import { elevationUnitFrom } from "../display-state";
import type { SceneDisplay } from "../display-state";
import { makeHtmlElement } from "../html";
import { noticeCount } from "../scene-info";
import type { SceneStore } from "../scene-store";
import type { LayerDoc, Scene } from "../types";
import { DomNode } from "./dom-node";
import { useSceneStore } from "./use-scene-store";

/** The tabs of the full view, in order. */
export const PANEL_TABS = ["charts", "about", "credits"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

const TAB_LABELS: Record<PanelTab, string> = {
  charts: "Charts",
  about: "About",
  credits: "Credits",
};

const DOCKED_TABS = ["charts", "about"] as const;

const CHARTS_PLACEHOLDER = "Charts for this scene are not available yet.";

/** Where the full view should land after its content commits. */
export interface FullOpenOptions {
  scrollToNotices?: boolean;
}

/** What the panel asks its owner to do. */
export interface PanelHooks {
  // The owner records the history entry, then calls openFull or closeFull.
  requestOpen(tab: PanelTab, options?: FullOpenOptions): void;
  requestClose(): void;
  stepTime(delta: number): void;
}

interface PanelTime {
  time: string | null;
  label: string | null;
}

interface FullRequest {
  tab: PanelTab;
  seq: number;
  scrollToNotices: boolean;
}

interface CollapsedProps {
  scene: Scene;
  store: SceneStore;
  hooks: PanelHooks;
}

interface FullProps {
  scene: Scene;
  dialog: HTMLDialogElement;
  store: SceneStore;
  hooks: PanelHooks;
  subscribeTime(listener: () => void): () => void;
  getTime(): PanelTime;
  subscribeFull(listener: () => void): () => void;
  getFull(): FullRequest;
  selectFull(tab: PanelTab): void;
}

/**
 * Build the docked panel and its full-view dialog from one scene store.
 * The dialog stays a body-level native dialog and the docked section keeps its label.
 */
export function createScenePanel(
  scene: Scene,
  dialog: HTMLDialogElement,
  store: SceneStore,
  hooks: PanelHooks,
) {
  const element = makeHtmlElement("section");
  element.className = "scene-panel";
  element.setAttribute("role", "region");
  element.setAttribute("aria-label", "Scene details");

  let time: PanelTime = { time: null, label: null };
  const timeListeners = new Set<() => void>();
  const getTime = () => time;
  const subscribeTime = (listener: () => void) => {
    timeListeners.add(listener);

    return () => {
      timeListeners.delete(listener);
    };
  };
  const setTime = (nextTime: string | null, nextLabel: string | null) => {
    if (time.time === nextTime && time.label === nextLabel) return;

    time = { time: nextTime, label: nextLabel };
    for (const listener of [...timeListeners]) listener();
  };

  let fullRequest: FullRequest = { tab: "about", seq: 0, scrollToNotices: false };
  const fullListeners = new Set<() => void>();
  const getFullRequest = () => fullRequest;
  const subscribeFull = (listener: () => void) => {
    fullListeners.add(listener);

    return () => {
      fullListeners.delete(listener);
    };
  };
  const requestFull = (tab: PanelTab, scrollToNotices = false) => {
    fullRequest = { tab, seq: fullRequest.seq + 1, scrollToNotices };
    for (const listener of [...fullListeners]) listener();
  };
  const selectFull = (tab: PanelTab) => {
    requestFull(tab, false);
  };

  dialog.replaceChildren();
  const collapsedRoot = createRoot(element);
  collapsedRoot.render(
    <CollapsedPanel scene={scene} store={store} hooks={hooks} />,
  );
  const fullRoot = createRoot(dialog);
  fullRoot.render(
    <FullPanel
      scene={scene}
      dialog={dialog}
      store={store}
      hooks={hooks}
      subscribeTime={subscribeTime}
      getTime={getTime}
      subscribeFull={subscribeFull}
      getFull={getFullRequest}
      selectFull={selectFull}
    />,
  );

  // Esc and the Android back gesture arrive as cancel; history decides what closes.
  dialog.oncancel = (event) => {
    event.preventDefault();
    hooks.requestClose();
  };

  return {
    element,

    setTime,

    openFull(tab: PanelTab, options: FullOpenOptions = {}) {
      requestFull(tab, options.scrollToNotices ?? false);
      if (!dialog.open) dialog.showModal();
    },

    closeFull() {
      if (!dialog.open) return;

      dialog.close();
      element.querySelector<HTMLButtonElement>(".expand")?.focus();
    },

    get isOpen() {
      return dialog.open;
    },

    destroy() {
      if (dialog.open) dialog.close();
      dialog.oncancel = null;
      fullRoot.unmount();
      collapsedRoot.unmount();
      timeListeners.clear();
      fullListeners.clear();
      dialog.replaceChildren();
      element.remove();
    },
  };
}

function CollapsedPanel({ scene, store, hooks }: CollapsedProps): React.ReactElement {
  const { display } = useSceneStore(store);
  const [selected, setSelected] = useState<PanelTab>("about");
  const elevationUnit = elevationUnitFrom(display, scene.layers);
  const body = selected === "charts" ? CHARTS_PLACEHOLDER : summaryText(scene, elevationUnit);
  const count = noticeCount(scene);
  const noun = count === 1 ? "note" : "notes";
  const description = `${count} ${noun} about this data's limits; opens About`;

  return (
    <>
      <div className="panel-header" onDoubleClick={() => hooks.requestOpen(selected)}>
        {DOCKED_TABS.map((tab) => (
          <button key={tab} aria-pressed={tab === selected} onClick={() => setSelected(tab)}>
            {TAB_LABELS[tab]}
          </button>
        ))}
        {count > 0 && (
          <button
            title={description}
            aria-label={description}
            onClick={() => hooks.requestOpen("about", { scrollToNotices: true })}
          >
            {`⚠ ${count} ${noun}`}
          </button>
        )}
        <button
          type="button"
          className="expand"
          aria-haspopup="dialog"
          onClick={() => hooks.requestOpen(selected)}
        >
          {"Expand ⤢"}
        </button>
      </div>
      <div className="panel-body">{body}</div>
      <button type="button" className="panel-footer" onClick={() => hooks.requestOpen("credits")}>
        {`${creditsLine(scene)} · Open full view →`}
      </button>
    </>
  );
}

function FullPanel({
  scene,
  dialog,
  store,
  hooks,
  subscribeTime,
  getTime,
  subscribeFull,
  getFull,
  selectFull,
}: FullProps): React.ReactElement {
  const { display } = useSceneStore(store);
  const time = useSyncExternalStore(subscribeTime, getTime);
  const request = useSyncExternalStore(subscribeFull, getFull);
  const current = request.tab;
  const buttons = useRef(new Map<PanelTab, HTMLButtonElement>());
  const content = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (request.seq === 0 || !dialog.open) return;

    buttons.current.get(request.tab)?.focus();
    if (content.current) content.current.scrollTop = 0;
    if (request.scrollToNotices) {
      const notices = dialog.querySelector(`#${NOTICES_HEADING_ID}`);
      notices?.scrollIntoView();
    }
  }, [request, dialog]);

  const elevationUnit = elevationUnitFrom(display, scene.layers);
  const displayUnits = useMemo(
    () => displayUnitsOf(display, scene.layers),
    [display, scene],
  );
  const node = useMemo(
    () => renderTabNode(scene, current, elevationUnit, displayUnits),
    [scene, current, elevationUnit, displayUnits],
  );

  return (
    <>
      <header>
        <h2 className="full-title">{scene.title}</h2>
        <div className="tabs" role="tablist" onKeyDown={(event) => handleTabKey(event, selectFull)}>
          {PANEL_TABS.map((tab) => (
            <button
              key={tab}
              ref={(button) => {
                if (button) buttons.current.set(tab, button);
                else buttons.current.delete(tab);
              }}
              type="button"
              role="tab"
              aria-selected={tab === current}
              tabIndex={tab === current ? 0 : -1}
              onClick={() => selectFull(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
        <div className="mini-time" hidden={time.label === null}>
          <button type="button" aria-label="Previous step" onClick={() => hooks.stepTime(-1)}>
            {"◀"}
          </button>
          <span>{time.label ?? ""}</span>
          <button type="button" aria-label="Next step" onClick={() => hooks.stepTime(1)}>
            {"▶"}
          </button>
        </div>
        <button type="button" onClick={() => hooks.requestClose()}>
          {"✕ Back to scene"}
        </button>
      </header>
      <main
        role="tabpanel"
        ref={(node) => {
          content.current = node;
        }}
      >
        {current === "charts" ? <p>{CHARTS_PLACEHOLDER}</p> : <DomNode node={node} />}
      </main>
    </>
  );
}

function renderTabNode(
  scene: Scene,
  tab: PanelTab,
  elevationUnit: string,
  displayUnits: Record<string, string>,
): HTMLElement | null {
  if (tab === "about") return renderAbout(scene, elevationUnit, displayUnits);
  if (tab === "credits") return renderCredits(scene);

  return null;
}

function displayUnitsOf(
  display: SceneDisplay,
  layers: readonly LayerDoc[],
): Record<string, string> {
  return Object.fromEntries(
    layers.map((layer) => [layer.id, display.layers[layer.id]?.units ?? layer.units]),
  );
}

function handleTabKey(
  event: React.KeyboardEvent,
  select: (tab: PanelTab) => void,
): void {
  const target = event.target as HTMLElement;
  const buttons = [...target.parentElement?.querySelectorAll('[role="tab"]') ?? []];
  const index = buttons.indexOf(target);
  const next = tabIndexForKey(event.key, index, buttons.length);
  if (next === null) return;

  event.preventDefault();
  select(PANEL_TABS[next]);
}

// Arrow keys wrap; Home and End jump, as in the WAI-ARIA tabs pattern.
function tabIndexForKey(key: string, current: number, count: number): number | null {
  if (current < 0) return null;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;

  return null;
}
