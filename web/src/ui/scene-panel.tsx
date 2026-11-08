/** Render the docked scene panel and defer its chart and full-dialog implementations. */
import {
  Component,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

import { creditsLine, summaryText } from "../about";
import { elevationUnitFrom } from "../display-state";
import { makeHtmlElement } from "../html";
import { noticeCount } from "../scene-info";
import type { SceneStore } from "../scene-store";
import type { Scene } from "../types";
import {
  TAB_LABELS,
  type FullOpenOptions,
  type FullPanelProps,
  type FullRequest,
  type PanelHooks,
  type PanelTab,
  type PanelTime,
} from "./panel-contract";
import { useSceneStore } from "./use-scene-store";

export { PANEL_TABS, type FullOpenOptions, type PanelHooks, type PanelTab } from "./panel-contract";

const DOCKED_TABS = ["charts", "about"] as const;

const FULL_LOAD_FAILED = "Could not load the full view. Close and reopen to retry.";
const CHIP_LOAD_FAILED = "Could not load the chart preview.";

/** Raw chunk imports behind the deferred panel parts so tests can fail the first load. */
export const panelChunkLoaders = {
  full: () => import("./scene-full").then(({ FullPanel }) => FullPanel),
  chip: () => import("./chart-chip").then(({ ChartChip }) => ChartChip),
};

let fullPanelPromise: ReturnType<typeof panelChunkLoaders.full> | null = null;
let chartChipPromise: ReturnType<typeof panelChunkLoaders.chip> | null = null;

type ChartChipProps = ComponentProps<typeof import("./chart-chip").ChartChip>;
type ChunkState<Props> = { component: ComponentType<Props> } | "failed" | null;

interface CollapsedProps {
  scene: Scene;
  store: SceneStore;
  hooks: PanelHooks;
  subscribeTime(listener: () => void): () => void;
  getTime(): PanelTime;
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
    <DeferredFullPanel
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

function DeferredFullPanel(props: FullPanelProps): React.ReactElement | null {
  const request = useSyncExternalStore(props.subscribeFull, props.getFull);
  const chunk = useChunk(loadFullPanel, request.seq);
  if (request.seq === 0 || chunk === null) return null;
  if (chunk === "failed") return <p>{FULL_LOAD_FAILED}</p>;
  const Panel = chunk.component;

  return (
    <ChunkBoundary resetKey={request.seq} fallback={<p>{FULL_LOAD_FAILED}</p>}>
      <Panel {...props} />
    </ChunkBoundary>
  );
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
  const chip = useChunk(loadChartChip, selected === "charts" ? scene.id : null);
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
    ? chartChipBody(chip, scene, store, time.time)
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
          className="collapse"
          ref={collapseRef}
          aria-label="Collapse scene panel"
          title="Collapse"
          onClick={collapsePanel}
        >
          {"–"}
        </button>
        <button
          type="button"
          className="expand"
          aria-label="Expand to full view"
          title="Expand to full view"
          aria-haspopup="dialog"
          onClick={() => hooks.requestOpen(selected)}
        >
          {"⤢"}
        </button>
      </div>
      <div className="panel-body">{body}</div>
      <button type="button" className="panel-footer" onClick={() => hooks.requestOpen("credits")}>
        {`${creditsLine(scene)} · Open full view →`}
      </button>
    </>
  );
}

function chartChipBody(
  chip: ChunkState<ChartChipProps>,
  scene: Scene,
  store: SceneStore,
  currentTime: string | null,
): ReactNode {
  if (chip === null) return null;
  if (chip === "failed") return <span>{CHIP_LOAD_FAILED}</span>;
  const Chip = chip.component;

  return (
    <ChunkBoundary resetKey={scene.id} fallback={<span>{CHIP_LOAD_FAILED}</span>}>
      <Chip scene={scene} store={store} currentTime={currentTime} />
    </ChunkBoundary>
  );
}

// Plain state allows retries, because React.lazy caches a rejected import for good.
function useChunk<Props>(
  load: () => Promise<ComponentType<Props>>,
  retryKey: unknown,
): ChunkState<Props> {
  const [chunk, setChunk] = useState<ChunkState<Props>>(null);
  useEffect(() => {
    if (retryKey === null || retryKey === 0) return;

    let current = true;
    load().then(
      (component) => {
        if (current) setChunk({ component });
      },
      () => {
        if (current) setChunk("failed");
      },
    );

    return () => {
      current = false;
    };
  }, [load, retryKey]);

  return chunk;
}

function loadFullPanel(): ReturnType<typeof panelChunkLoaders.full> {
  fullPanelPromise ??= panelChunkLoaders.full();
  // A rejected chunk stays rejected, so forget it and let the next open retry.
  fullPanelPromise.catch(() => {
    fullPanelPromise = null;
  });
  return fullPanelPromise;
}

function loadChartChip(): ReturnType<typeof panelChunkLoaders.chip> {
  chartChipPromise ??= panelChunkLoaders.chip();
  // A rejected chunk stays rejected, so forget it and let the next Charts click retry.
  chartChipPromise.catch(() => {
    chartChipPromise = null;
  });
  return chartChipPromise;
}

/** Clear cached chunk promises so tests can simulate a fresh first load. */
export function resetPanelChunkCacheForTest(): void {
  fullPanelPromise = null;
  chartChipPromise = null;
}

interface ChunkBoundaryProps {
  fallback: ReactNode;
  resetKey: unknown;
  children: ReactNode;
}

interface ChunkBoundaryState {
  failed: boolean;
}

// A failed chunk must not unmount its root, so the next open or click can retry it.
class ChunkBoundary extends Component<ChunkBoundaryProps, ChunkBoundaryState> {
  state: ChunkBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChunkBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previousProps: ChunkBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback;

    return this.props.children;
  }
}
