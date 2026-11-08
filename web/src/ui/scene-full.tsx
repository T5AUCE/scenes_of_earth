/** Render the full-view dialog with persistent chart navigation and editor state. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { NOTICES_HEADING_ID, renderAbout, renderCredits } from "../about";
import { displayUnitsFrom, elevationUnitFrom } from "../display-state";
import { ChartDetail } from "../charts/chart-detail";
import { DownloadSection } from "../charts/download-section";
import { ChartGallery } from "../charts/chart-gallery";
import { draftForEdit, draftForNew, ChartEditor, type ChartDraft } from "../charts/chart-editor";
import type { SceneStore } from "../scene-store";
import type { Scene } from "../types";
import { DomNode } from "./dom-node";
import { PANEL_TABS, TAB_LABELS, type FullPanelProps, type PanelTab } from "./panel-contract";
import { useSceneStore } from "./use-scene-store";

type ChartView =
  | { kind: "gallery" }
  | { kind: "detail"; id: string; origin: string | null; focusNotes?: boolean }
  | {
    kind: "editor";
    draft: ChartDraft;
    isNew: boolean;
    returnTo: string | null;
    origin: string | null;
  };

type GalleryReturnFocus = { id: string | null; target: "title" | "notes" };

/** Keep full-dialog navigation and chart drafts alive after the first open. */
export function FullPanel({
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
  const galleryReturnFocus = useRef<GalleryReturnFocus | null>(null);
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
    const focus = galleryReturnFocus.current;
    galleryReturnFocus.current = null;
    focusGalleryCard(dialog, focus.id, focus.target);
  }, [chartView, current, dialog]);
  // The outer confirmation is a new decision group, so focus enters it on open.
  useEffect(() => {
    if (closeConfirm) confirmSaveRef.current?.focus();
  }, [closeConfirm]);
  useEffect(() => {
    if (current !== "charts") return;
    if (chartView.kind === "detail") {
      if (chartView.focusNotes) {
        const heading = dialog.querySelector<HTMLElement>("[data-chart-notes-heading]");
        heading?.focus();
        heading?.scrollIntoView();
      } else {
        dialog.querySelector<HTMLElement>("[data-detail-back]")?.focus();
      }
    }
    if (chartView.kind === "editor") {
      dialog.querySelector<HTMLElement>(".chart-editor .editor-head button")?.focus();
    }
  }, [chartView, current, dialog]);

  const elevationUnit = elevationUnitFrom(display, scene.layers);
  const displayUnits = useMemo(
    () => displayUnitsFrom(display, scene.layers),
    [display, scene],
  );
  const node = useMemo(
    () => renderTabNode(scene, current, elevationUnit, displayUnits),
    [scene, current, elevationUnit, displayUnits],
  );
  const editing = current === "charts" && chartView.kind === "editor";

  const openDetail = (id: string, focusNotes = false) => {
    galleryReturnFocus.current = { id, target: focusNotes ? "notes" : "title" };
    setChartView({ kind: "detail", id, origin: id, focusNotes });
  };
  const openEditor = (
    draft: ChartDraft,
    isNew: boolean,
    returnTo: string | null,
    origin: string | null,
  ) => {
    galleryReturnFocus.current = { id: origin, target: "title" };
    setChartView({ kind: "editor", draft, isNew, returnTo, origin });
    setEditorDirty(false);
  };
  const backToGallery = (focusId: string | null) => {
    const target = galleryReturnFocus.current?.target ?? "title";
    galleryReturnFocus.current = { id: focusId, target };
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
  openDetail(id: string, focusNotes?: boolean): void;
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
    <>
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
      <DownloadSection scene={scene} />
    </>
  );
}

function focusGalleryCard(
  dialog: HTMLElement,
  focusId: string | null,
  target: GalleryReturnFocus["target"] = "title",
) {
  if (focusId) {
    const cards = [...dialog.querySelectorAll("[data-chart-id]")];
    const match = cards.find((element) => (element as HTMLElement).dataset.chartId === focusId);
    if (match) {
      if (target === "notes") {
        const notes = match.querySelector(".chart-notes-button");
        if (notes instanceof HTMLElement) {
          notes.focus();

          return;
        }
      }
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
