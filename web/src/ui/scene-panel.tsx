/** Port the docked scene panel and its full-view dialog to React with charts. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { creditsLine, NOTICES_HEADING_ID, renderAbout, renderCredits, summaryText } from "../about";
import { elevationUnitFrom } from "../display-state";
import type { SceneDisplay } from "../display-state";
import { ChartDetail } from "../charts/chart-detail";
import { ChartGallery } from "../charts/chart-gallery";
import { draftForEdit, draftForNew, ChartEditor, type ChartDraft } from "../charts/chart-editor";
import { resolveMainId } from "../charts/definitions";
import { HypsometryChart } from "../charts/hypsometry-chart";
import { SeriesChart } from "../charts/series-chart";
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

type ChartView =
  | { kind: "gallery" }
  | { kind: "detail"; id: string; origin: string | null }
  | {
    kind: "editor";
    draft: ChartDraft;
    isNew: boolean;
    returnTo: string | null;
    origin: string | null;
  };

interface CollapsedProps {
  scene: Scene;
  store: SceneStore;
  hooks: PanelHooks;
  subscribeTime(listener: () => void): () => void;
  getTime(): PanelTime;
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
  subscribeSync(listener: () => void): () => void;
  getSync(): string | null;
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

  let chartSyncNotice: string | null = null;
  const syncListeners = new Set<() => void>();
  const getSync = () => chartSyncNotice;
  const subscribeSync = (listener: () => void) => {
    syncListeners.add(listener);

    return () => {
      syncListeners.delete(listener);
    };
  };
  const setSyncNotice = (notice: string | null) => {
    if (chartSyncNotice === notice) return;
    chartSyncNotice = notice;
    for (const listener of [...syncListeners]) listener();
  };

  let editorDirtyFlag = false;
  let showCloseConfirmFn: (() => void) | null = null;

  dialog.replaceChildren();
  const collapsedRoot = createRoot(element);
  collapsedRoot.render(
    <CollapsedPanel
      scene={scene}
      store={store}
      hooks={hooks}
      subscribeTime={subscribeTime}
      getTime={getTime}
    />,
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
      subscribeSync={subscribeSync}
      getSync={getSync}
      onDirtyFlag={(dirty) => {
        editorDirtyFlag = dirty;
      }}
      onRegisterConfirm={(show) => {
        showCloseConfirmFn = show;
      }}
    />,
  );

  // Esc and the Android back gesture arrive as cancel; history decides what closes.
  dialog.oncancel = (event) => {
    event.preventDefault();
    if (editorDirtyFlag && showCloseConfirmFn) {
      showCloseConfirmFn();

      return;
    }
    hooks.requestClose();
  };

  return {

    element,

    setTime,

    setSyncNotice,

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

    isEditorDirty() {
      return editorDirtyFlag;
    },

    showCloseConfirm() {
      showCloseConfirmFn?.();
    },

    destroy() {
      if (dialog.open) dialog.close();
      dialog.oncancel = null;
      fullRoot.unmount();
      collapsedRoot.unmount();
      timeListeners.clear();
      fullListeners.clear();
      syncListeners.clear();
      dialog.replaceChildren();
      element.remove();
    },
  };
}

function CollapsedPanel({
  scene,
  store,
  hooks,
  subscribeTime,
  getTime,
}: CollapsedProps): React.ReactElement {
  const { display } = useSceneStore(store);
  const time = useSyncExternalStore(subscribeTime, getTime);
  const [selected, setSelected] = useState<PanelTab>("about");
  const [collapsed, setCollapsed] = useState(false);
  const showDetailsRef = useRef<HTMLButtonElement | null>(null);
  const collapseRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterToggle = useRef<"show" | "collapse" | null>(null);
  useEffect(() => {
    if (focusAfterToggle.current === "show") showDetailsRef.current?.focus();
    if (focusAfterToggle.current === "collapse") collapseRef.current?.focus();
    focusAfterToggle.current = null;
  }, [collapsed]);
  const collapsePanel = () => {
    focusAfterToggle.current = "show";
    setCollapsed(true);
  };
  const expandPanel = () => {
    focusAfterToggle.current = "collapse";
    setCollapsed(false);
  };
  const elevationUnit = elevationUnitFrom(display, scene.layers);
  const count = noticeCount(scene);
  const noun = count === 1 ? "note" : "notes";
  const description = `${count} ${noun} about this data's limits; opens About`;
  if (collapsed) {
    return (
      <>
        <div className="panel-header">
          <button
            type="button"
            ref={showDetailsRef}
            aria-label="Reopen scene details"
            onClick={expandPanel}
          >
            {"Show details"}
          </button>
          {count > 0 && (
            <button
              title={description}
              aria-label={description}
              onClick={() => hooks.requestOpen("about", { scrollToNotices: true })}
            >
              {`⚠ ${count} ${noun}`}
            </button>
          )}
        </div>
      </>
    );
  }
  const body = selected === "charts"
    ? <ChartChip scene={scene} store={store} currentTime={time.time} />
    : summaryText(scene, elevationUnit);

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
          ref={collapseRef}
          aria-label="Collapse scene panel"
          onClick={collapsePanel}
        >
          {"Collapse"}
        </button>
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

function ChartChip({
  scene,
  store,
  currentTime,
}: {
  scene: Scene;
  store: SceneStore;
  currentTime: string | null;
}): React.ReactElement {
  const { charts, display } = useSceneStore(store);
  const layers = scene.layers;
  const mainId = resolveMainId(charts.definitions, charts.mainChartId, layers);
  const definition = charts.definitions.find((entry) => entry.id === mainId) ?? null;
  if (!definition) return <span>{"No charts for this scene."}</span>;
  const layer = layers.find((entry) => entry.id === definition.source.layerId) ?? null;
  if (!layer) return <span>{definition.title}</span>;
  const viewerUnit = display.layers[layer.id]?.units ?? null;
  const effectivePalette = display.layers[layer.id]?.palette ?? layer.style.palette ?? null;
  const effectiveInk = display.layers[layer.id]?.ink ?? null;
  const shapeLabel = definition.source.shape === "distribution"
    ? "Hypsometry"
    : definition.source.shape === "seasonal_cycle"
      ? "By month"
      : "Over time";

  return (
    <span className="chart-chip">
      <span className="chip-title">{`${definition.title} · ${shapeLabel}`}</span>
      {definition.source.shape === "distribution"
        ? (
          <HypsometryChart
            layer={layer}
            chartType={definition.chartType}
            options={definition.options}
            compact={true}
            viewerUnit={viewerUnit}
            effectivePalette={effectivePalette}
            effectiveInk={effectiveInk}
          />
        )
        : (
          <SeriesChart
            layer={layer}
            shape={definition.source.shape}
            chartType={definition.chartType}
            options={definition.options}
            currentTime={currentTime}
            compact={true}
            viewerUnit={viewerUnit}
            effectivePalette={effectivePalette}
            effectiveInk={effectiveInk}
          />
        )}
    </span>
  );
}

interface FullPanelProps extends FullProps {
  onDirtyFlag(dirty: boolean): void;
  onRegisterConfirm(show: (() => void) | null): void;
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
  subscribeSync,
  getSync,
  onDirtyFlag,
  onRegisterConfirm,
}: FullPanelProps): React.ReactElement {
  const { display } = useSceneStore(store);
  const time = useSyncExternalStore(subscribeTime, getTime);
  const request = useSyncExternalStore(subscribeFull, getFull);
  const syncNotice = useSyncExternalStore(subscribeSync, getSync);
  const current = request.tab;
  const buttons = useRef(new Map<PanelTab, HTMLButtonElement>());
  const content = useRef<HTMLElement | null>(null);
  const [chartView, setChartView] = useState<ChartView>({ kind: "gallery" });
  const [editorDirty, setEditorDirty] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const invokingRef = useRef<HTMLElement | null>(null);
  const confirmSaveRef = useRef<HTMLButtonElement | null>(null);
  const editorActions = useRef<{ save: () => void; discard: () => void } | null>(null);
  const galleryReturnFocus = useRef<{ id: string | null } | null>(null);
  useEffect(() => {
    onDirtyFlag(editorDirty);
  }, [editorDirty, onDirtyFlag]);
  useEffect(() => {
    onRegisterConfirm(() => {
      invokingRef.current = document.activeElement as HTMLElement | null;
      setPendingClose(true);
      setCloseConfirm(true);
    });

    return () => onRegisterConfirm(null);
  }, [onRegisterConfirm]);
  useEffect(() => {
    if (request.seq === 0 || !dialog.open) return;

    buttons.current.get(request.tab)?.focus();
    if (content.current) content.current.scrollTop = 0;
    if (request.scrollToNotices) {
      const notices = dialog.querySelector(`#${NOTICES_HEADING_ID}`);
      notices?.scrollIntoView();
    }
  }, [request, dialog]);
  useEffect(() => {
    if (current !== "charts") return;

    galleryReturnFocus.current = null;
  }, [current]);
  useEffect(() => {
    if (current !== "charts" || chartView.kind !== "gallery") return;
    if (!galleryReturnFocus.current) return;
    const focusId = galleryReturnFocus.current.id;
    galleryReturnFocus.current = null;
    focusGalleryCard(dialog, focusId);
  }, [chartView, current, dialog]);
  // The outer confirmation is a new decision group, so focus enters it on open.
  useEffect(() => {
    if (closeConfirm) confirmSaveRef.current?.focus();
  }, [closeConfirm]);
  useEffect(() => {
    if (current !== "charts") return;
    if (chartView.kind === "detail") {
      dialog.querySelector<HTMLElement>("[data-detail-back]")?.focus();
    }
    if (chartView.kind === "editor") {
      dialog.querySelector<HTMLElement>(".chart-editor .editor-head button")?.focus();
    }
  }, [chartView, current, dialog]);

  const elevationUnit = elevationUnitFrom(display, scene.layers);
  const displayUnits = useMemo(
    () => displayUnitsOf(display, scene.layers),
    [display, scene],
  );
  const node = useMemo(
    () => renderTabNode(scene, current, elevationUnit, displayUnits),
    [scene, current, elevationUnit, displayUnits],
  );
  const editing = current === "charts" && chartView.kind === "editor";

  const openDetail = (id: string) => {
    galleryReturnFocus.current = { id };
    setChartView({ kind: "detail", id, origin: id });
  };
  const openEditor = (
    draft: ChartDraft,
    isNew: boolean,
    returnTo: string | null,
    origin: string | null,
  ) => {
    galleryReturnFocus.current = { id: origin };
    setChartView({ kind: "editor", draft, isNew, returnTo, origin });
    setEditorDirty(false);
  };
  const backToGallery = (focusId: string | null) => {
    galleryReturnFocus.current = { id: focusId };
    setChartView({ kind: "gallery" });
    setEditorDirty(false);
    setCloseConfirm(false);
  };

  const completePendingClose = () => {
    setCloseConfirm(false);
    setPendingClose(false);
    backToGallery(null);
    hooks.requestClose();
  };

  const handleEditorSave = (id: string) => {
    setEditorDirty(false);
    editorActions.current = null;
    if (pendingClose) {
      completePendingClose();

      return;
    }
    openDetail(id);
  };

  const handleEditorCancel = (returnTo: string | null, origin: string | null) => {
    setEditorDirty(false);
    editorActions.current = null;
    if (pendingClose) {
      completePendingClose();

      return;
    }
    if (returnTo) openDetail(returnTo);
    else backToGallery(origin);
  };

  const requestPanelClose = () => {
    if (editing && editorDirty) {
      invokingRef.current = document.activeElement as HTMLElement | null;
      setPendingClose(true);
      setCloseConfirm(true);

      return;
    }
    hooks.requestClose();
  };

  const safeSelect = (tab: PanelTab) => {
    if (editing) return;
    selectFull(tab);
  };

  const handleTabKey = (event: React.KeyboardEvent) => {
    if (editing) {
      event.preventDefault();

      return;
    }
    handleTabKeyInner(event, safeSelect);
  };

  return (
    <>
      <header>
        <h2 className="full-title">{scene.title}</h2>
        <div className="tabs" role="tablist" onKeyDown={handleTabKey}>
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
              disabled={editing && tab !== current}
              onClick={() => safeSelect(tab)}
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
        <button type="button" onClick={requestPanelClose}>
          {"✕ Back to scene"}
        </button>
      </header>
      <main
        role="tabpanel"
        ref={(node) => {
          content.current = node;
        }}
      >
        {/* The editor shows no status, so the shell keeps storage and share warnings visible. */}
        {editing && syncNotice && (
          <p className="chart-note" role="status">
            {syncNotice}
          </p>
        )}
        {current === "charts"
          ? chartViewFor({
            scene,
            store,
            view: chartView,
            currentTime: time.time,
            syncNotice,
            openDetail,
            openEditor,
            backToGallery,
            setDirty: setEditorDirty,
            editorActions,
            onSave: handleEditorSave,
            onCancel: handleEditorCancel,
          })
          : <DomNode node={node} />}
        {closeConfirm && (
          <div className="chart-confirm" role="alertdialog" aria-label="Unsaved chart changes">
            <p>{"This chart draft has unsaved changes."}</p>
            <button
              type="button"
              ref={confirmSaveRef}
              onClick={() => {
                editorActions.current?.save();
              }}
            >
              {"Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                editorActions.current?.discard();
              }}
            >
              {"Discard"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCloseConfirm(false);
                setPendingClose(false);
                const fallback = dialog.querySelector<HTMLElement>(
                  ".chart-editor .editor-head button",
                );
                (invokingRef.current ?? fallback)?.focus();
              }}
            >
              {"Keep editing"}
            </button>
          </div>
        )}
      </main>
    </>
  );
}

interface EditorRefs {
  current: { save: () => void; discard: () => void } | null;
}

function chartViewFor(args: {
  scene: Scene;
  store: SceneStore;
  view: ChartView;
  currentTime: string | null;
  syncNotice: string | null;
  openDetail(id: string): void;
  openEditor(
    draft: ChartDraft,
    isNew: boolean,
    returnTo: string | null,
    origin: string | null,
  ): void;
  backToGallery(focusId: string | null): void;
  setDirty(dirty: boolean): void;
  editorActions: EditorRefs;
  onSave(id: string): void;
  onCancel(returnTo: string | null, origin: string | null): void;
}): React.ReactElement {
  const {
    scene,
    store,
    view,
    currentTime,
    syncNotice,
    openDetail,
    openEditor,
    backToGallery,
    setDirty,
    editorActions,
    onSave,
    onCancel,
  } = args;
  if (view.kind === "detail") {
    return (
      <ChartDetail
        scene={scene}
        store={store}
        definitionId={view.id}
        currentTime={currentTime}
        syncNotice={syncNotice}
        onBack={() => backToGallery(view.origin)}
        onEdit={(id) => {
          const snapshot = store.getSnapshot();
          const definition = snapshot.charts.definitions.find((entry) => entry.id === id);
          if (!definition) {
            backToGallery(view.origin);

            return;
          }
          openEditor(draftForEdit(definition), false, view.id, view.origin);
        }}
      />
    );
  }
  if (view.kind === "editor") {
    return (
      <ChartEditor
        scene={scene}
        store={store}
        initial={view.draft}
        isNew={view.isNew}
        currentTime={currentTime}
        onSave={onSave}
        onCancel={() => onCancel(view.returnTo, view.origin)}
        onDirtyChange={setDirty}
        onRegisterActions={(actions) => {
          editorActions.current = actions;
        }}
      />
    );
  }

  return (
    <ChartGallery
      scene={scene}
      store={store}
      currentTime={currentTime}
      syncNotice={syncNotice}
      onOpenDetail={openDetail}
      onEdit={(id) => {
        const snapshot = store.getSnapshot();
        const definition = snapshot.charts.definitions.find((entry) => entry.id === id);
        if (!definition) return;
        openEditor(draftForEdit(definition), false, null, id);
      }}
      onNew={() => {
        const snapshot = store.getSnapshot();
        const existing = snapshot.charts.definitions.map((entry) => entry.id);
        const draft = draftForNew(scene.layers, existing);
        if (!draft) return;
        openEditor(draft, true, null, null);
      }}
    />
  );
}

function focusGalleryCard(dialog: HTMLElement, focusId: string | null) {
  if (focusId) {
    const cards = [...dialog.querySelectorAll("[data-chart-id]")];
    const match = cards.find((element) => (element as HTMLElement).dataset.chartId === focusId);
    if (match) {
      const button = match.querySelector("button");
      if (button instanceof HTMLElement) {
        button.focus();

        return;
      }
    }
  }
  const scope = dialog.querySelector(".chart-gallery") ?? dialog;
  const creation = [...scope.querySelectorAll("button")].find(
    (button) => button.textContent === "+ New chart",
  );
  if (creation instanceof HTMLElement) creation.focus();
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

function handleTabKeyInner(
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
