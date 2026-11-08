/** Share panel navigation contracts without importing chart implementations. */
import type { SceneStore } from "../scene-store";
import type { Scene } from "../types";

/** The tabs of the full view, in order. */
export const PANEL_TABS = ["charts", "about", "credits"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export const TAB_LABELS: Record<PanelTab, string> = {
  charts: "Charts",
  about: "About",
  credits: "Credits",
};

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

export interface PanelTime {
  time: string | null;
  label: string | null;
}

/** A new sequence requests focus even when the selected tab stays the same. */
export interface FullRequest {
  tab: PanelTab;
  seq: number;
  scrollToNotices: boolean;
}

/** Keep the deferred dialog subscribed to the shell's current requests and notices. */
export interface FullPanelProps {
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
  onDirtyFlag(dirty: boolean): void;
  onRegisterConfirm(show: (() => void) | null): void;
}
