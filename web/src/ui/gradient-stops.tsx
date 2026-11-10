/** Edit positioned gradient stops on a draggable bar with a detail row. */
import { useEffect, useRef, useState } from "react";

import { LAST_ENTRY, lut } from "../render/colormap";
import {
  MAX_CUSTOM_COLORS,
  MIN_CUSTOM_COLORS,
  hexToRgb,
  rgbToHex,
  type GradientStop,
} from "../render/palettes";

const POSITION_MIN = 0;
const POSITION_MAX = 100;
const DRAG_START_PX = 3;
const REMOVE_PULL_PX = 24;
/** The longest the stem stretches, so a pull feels elastic rather than detaching the pin. */
const MAX_STRETCH_PX = 12;
/** A pin set for removal fades over this much pull, never quite vanishing before release. */
const PULL_FADE_PX = 80;
const MIN_PULLED_OPACITY = 0.15;
const SMALL_STEP = 1;
const LARGE_STEP = 10;
const HEX_PATTERN = /^#[0-9a-f]{6}$/;

/** A stop with a stable id for focus and its edited colour and integer position. */
interface UiStop {
  id: string;
  color: string; // #rrggbb
  position: number; // 0..100
}

interface GradientStopsProps {
  /** The current positioned stops, from 2 to 8 entries. */
  stops: GradientStop[];
  /** Preview the map, throttled to one call per frame while dragging. */
  onPreview(stops: GradientStop[]): void;
  /** Commit the stops to the store, storage and link. */
  onCommit(stops: GradientStop[]): void;
}

/** A positioned stop bar; dragging previews while release commits. */
export function GradientStops({ stops, onPreview, onCommit }: GradientStopsProps) {
  const editor = useGradientEditor(stops, onPreview, onCommit);

  return (
    <div className="gradient-stops">
      <div className="gradient-bar" {...editor.barProps}>
        {editor.ordered.map((stop, index) => (
          <StopHandle
            key={stop.id}
            stop={stop}
            index={index}
            count={editor.ordered.length}
            selected={stop.id === editor.selectedId}
            removing={stop.id === editor.removingId}
            pullPx={stop.id === editor.pull?.id ? editor.pull.px : 0}
            {...editor.handleProps(stop)}
          />
        ))}
      </div>
      {editor.detail === null
        ? (
          <p className="stops-hint">
            Click the bar to add a colour. Drag a pin to move it,
            or click it to change or remove it.
          </p>
        )
        : <StopDetail {...editor.detail} />}
      <div aria-live="polite" role="status" className="visually-hidden">
        {editor.announcement}
      </div>
    </div>
  );
}

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  startPosition: number;
}

/** Everything the markup needs, owned by the editor hook below. */
interface GradientEditor {
  ordered: UiStop[];
  selectedId: string | null;
  removingId: string | null;
  /** How far the dragged pin is pulled below the bar, which stretches its stem elastically. */
  pull: { id: string; px: number } | null;
  announcement: string;
  barProps: {
    ref: React.RefObject<HTMLDivElement | null>;
    style: React.CSSProperties;
    onPointerDown(event: React.PointerEvent<HTMLDivElement>): void;
    onPointerMove(event: React.PointerEvent<HTMLDivElement>): void;
    onPointerUp(): void;
  };
  handleProps(stop: UiStop): HandleBehavior;
  detail: StopDetailProps | null;
}

/** The draft, selection, drag gesture and preview scheduling of one stop editor. */
function useGradientEditor(
  stops: GradientStop[],
  onPreview: (stops: GradientStop[]) => void,
  onCommit: (stops: GradientStop[]) => void,
): GradientEditor {
  const [draft, setDraft] = useState<UiStop[]>(() => toUi(stops, { current: 0 }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pull, setPull] = useState<{ id: string; px: number } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<string, HTMLDivElement>());
  const well = useRef<HTMLInputElement>(null);
  const nextId = useRef(draft.length);
  const drag = useRef<DragState | null>(null);
  const dragging = useRef(false);
  const pendingFocus = useRef<string | null>(null);
  const wellFocusQueued = useRef(false);
  const previewLatest = useRef<GradientStop[] | null>(null);
  const frame = useRef<number | null>(null);
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => () => cancelPreview(frame), []);
  useEffect(() => {
    if (dragging.current) return;
    const incoming = toGradient(draft);
    const current = [...stops].sort((first, second) => first.at - second.at);
    if (gradientName(incoming) !== gradientName(current)) {
      const fresh = { current: nextId.current };
      setDraft(toUi(stops, fresh));
      nextId.current = fresh.current;
      setSelectedId(null);
    }
    // The draft is the edited copy, so syncing only answers outside changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops]);
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const id = pendingFocus.current;
    pendingFocus.current = null;
    const element = handles.current.get(id);
    element?.focus();
    // A reorder can drop pointer capture, so the active drag reclaims it here.
    if (drag.current !== null && dragging.current) {
      try {
        element?.setPointerCapture?.(drag.current.pointerId);
      } catch {
        // Capture loss is handled below, so a failed reclaim never sticks the drag.
      }
    }
  }, [draft]);
  useEffect(() => {
    if (wellFocusQueued.current && well.current) {
      wellFocusQueued.current = false;
      well.current.focus();
    }
  }, [selectedId]);

  const ordered = [...draft].sort((first, second) => first.position - second.position);
  const selected = draft.find(({ id }) => id === selectedId) ?? null;

  const commitNow = (committed: GradientStop[]) => {
    // A terminal commit cancels its drag preview, so no stale frame can follow it.
    if (frame.current !== null) {
      cancelPreview(frame);
      previewLatest.current = null;
    }
    commitRef.current(committed);
  };
  const commit = (next: UiStop[]) => {
    setDraft(next);
    commitNow(toGradient(next));
  };
  const preview = (next: UiStop[]) => {
    setDraft(next);
    queueFrame(frame, previewLatest, previewRef, next);
  };

  const addAt = (position: number) => {
    if (draft.length >= MAX_CUSTOM_COLORS) {
      setAnnouncement("Up to 8 colours");
      return;
    }
    const clamped = clampPosition(position);
    const id = `stop-${nextId.current++}`;
    const next = [...draft, { id, color: sampleHexAt(draft, clamped), position: clamped }];
    next.sort((first, second) => first.position - second.position);
    setDraft(next);
    setSelectedId(id);
    pendingFocus.current = id;
    setAnnouncement(`Colour added at ${clamped} %`);
    commitNow(toGradient(next));
  };
  const removeById = (id: string, focusNeighbour: boolean) => {
    if (draft.length <= MIN_CUSTOM_COLORS) return;
    const index = ordered.findIndex((stop) => stop.id === id);
    const next = withoutStop(draft, id);
    setDraft(next);
    if (focusNeighbour && index >= 0) {
      const neighbour = ordered[index + 1] ?? ordered[index - 1] ?? null;
      setSelectedId(neighbour ? neighbour.id : null);
      pendingFocus.current = neighbour ? neighbour.id : null;
    } else if (selectedId === id) {
      setSelectedId(null);
    }
    setAnnouncement("Colour removed");
    commitNow(toGradient(next));
  };
  const finishDrag = () => {
    const state = drag.current;
    if (state === null) return;
    drag.current = null;
    const wasDragging = dragging.current;
    dragging.current = false;
    const pullRemove = removingId === state.id;
    setRemovingId(null);
    setPull(null);
    if (pullRemove) {
      removeById(state.id, true);
      return;
    }
    if (wasDragging) commitNow(toGradient(draft));
  };
  // A cancelled drag keeps its previewed stops, because the map already shows them.
  const cancelDrag = () => {
    if (drag.current === null) return;
    drag.current = null;
    dragging.current = false;
    setRemovingId(null);
    setPull(null);
    commitNow(toGradient(draft));
  };

  const moveDragTo = (clientX: number, clientY: number) => {
    const state = drag.current;
    if (state === null) return;
    const moved = Math.hypot(clientX - state.startX, clientY - state.startY);
    if (!dragging.current && moved <= DRAG_START_PX) return;
    dragging.current = true;
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const position = clampPosition(
      state.startPosition + ((clientX - state.startX) / rect.width) * POSITION_MAX,
    );
    const next = withMovedStop(draft, state.id, position);
    pendingFocus.current = state.id;
    preview(next);
    // Pulling a last pair only previews, because release keeps two stops.
    setPull({ id: state.id, px: Math.max(0, clientY - state.startY) });
    const pulledOff = clientY - rect.bottom > REMOVE_PULL_PX;
    setRemovingId(pulledOff && draft.length > MIN_CUSTOM_COLORS ? state.id : null);
  };
  const beginHandleDrag = (event: React.PointerEvent<HTMLDivElement>, stop: UiStop) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setSelectedId(stop.id);
    const element = event.currentTarget;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Some test environments lack pointer capture, while dragging still works.
    }
    drag.current = {
      id: stop.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: stop.position,
    };
    dragging.current = false;
    element.focus();
  };
  const editWell = () => {
    // The detail row mounts after selection, so an early Enter waits for the well.
    if (well.current) well.current.focus();
    else wellFocusQueued.current = true;
  };
  const openWell = () => {
    const input = well.current;
    if (!input) {
      wellFocusQueued.current = true;
      return;
    }
    input.focus();
    try {
      input.showPicker?.();
    } catch {
      // Focusing still leaves the well ready when the picker cannot open.
    }
  };

  const callbacks: HandleCallbacks = {
    handles,
    setSelectedId,
    begin: beginHandleDrag,
    move: moveDragTo,
    finish: finishDrag,
    cancel: cancelDrag,
    open: openWell,
    edit: editWell,
    moveStop: (stop: UiStop, position: number) => {
      if (position === stop.position) return;
      pendingFocus.current = stop.id;
      commit(withMovedStop(draft, stop.id, position));
    },
    removeStop: (stop: UiStop) => removeById(stop.id, true),
    insertStop: (stop: UiStop) => insertAfter(stop, draft, addAt),
    matches: (stop: UiStop) => drag.current?.id === stop.id,
  };

  return {
    ordered,
    selectedId,
    removingId,
    pull,
    announcement,
    barProps: {
      ref: bar,
      style: { background: gradientCss(draft) },
      onPointerDown: (event) => {
        if (event.target !== event.currentTarget || event.button !== 0) return;
        const rect = bar.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        addAt(((event.clientX - rect.left) / rect.width) * POSITION_MAX);
      },
      onPointerMove: (event) => {
        // Without capture a move lands here, so the gesture survives a reorder.
        if (event.target !== event.currentTarget) return;
        moveDragTo(event.clientX, event.clientY);
      },
      onPointerUp: finishDrag,
    },
    handleProps: (stop: UiStop) => handleProps(stop, callbacks),
    detail: selected === null ? null : {
      stop: selected,
      index: ordered.findIndex(({ id }) => id === selected.id),
      count: ordered.length,
      wellRef: well,
      onColor: (color: string) => {
        commit(withRecoloredStop(draft, selected.id, color));
      },
      onPreviewColor: (color: string) => {
        preview(withRecoloredStop(draft, selected.id, color));
      },
      onPosition: (position: number) => {
        if (position === selected.position) return;
        commit(withMovedStop(draft, selected.id, position));
      },
      onRemove: () => removeById(selected.id, true),
      onEscape: () => handles.current.get(selected.id)?.focus(),
    },
  };
}

interface HandleCallbacks {
  handles: React.MutableRefObject<Map<string, HTMLDivElement>>;
  setSelectedId(id: string): void;
  begin(event: React.PointerEvent<HTMLDivElement>, stop: UiStop): void;
  move(clientX: number, clientY: number): void;
  finish(): void;
  cancel(): void;
  open(): void;
  edit(): void;
  moveStop(stop: UiStop, position: number): void;
  removeStop(stop: UiStop): void;
  insertStop(stop: UiStop): void;
  matches(stop: UiStop): boolean;
}

/** The behaviour bundle of one pin, built from the editor's callbacks. */
function handleProps(stop: UiStop, callbacks: HandleCallbacks) {
  return {
    register: (element: HTMLDivElement | null) => {
      if (element) callbacks.handles.current.set(stop.id, element);
      else callbacks.handles.current.delete(stop.id);
    },
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => callbacks.begin(event, stop),
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (callbacks.matches(stop)) callbacks.move(event.clientX, event.clientY);
    },
    onPointerUp: () => callbacks.finish(),
    onPointerCancel: () => callbacks.cancel(),
    // Capture loss outside a release still ends the gesture instead of sticking it.
    onLostPointerCapture: () => callbacks.finish(),
    onDoubleClick: () => callbacks.open(),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Focus alone never selects, so the first key on a handle claims it by stable id.
      callbacks.setSelectedId(stop.id);
      handleStopKey(event, stop, {
        move: (position: number) => callbacks.moveStop(stop, position),
        remove: () => callbacks.removeStop(stop),
        edit: () => callbacks.edit(),
        insert: () => callbacks.insertStop(stop),
      });
    },
  };
}

/** The event handlers of one pin, without its identity and state. */
interface HandleBehavior {
  register(element: HTMLDivElement | null): void;
  onPointerDown(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  onLostPointerCapture(): void;
  onDoubleClick(): void;
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
}

interface StopHandleProps {
  stop: UiStop;
  index: number;
  count: number;
  selected: boolean;
  removing: boolean;
  pullPx: number;
  register(element: HTMLDivElement | null): void;
  onPointerDown(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  onLostPointerCapture(): void;
  onDoubleClick(): void;
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
}

/** One draggable pin with slider semantics for its colour stop. */
function StopHandle({
  stop,
  index,
  count,
  selected,
  removing,
  pullPx,
  register,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onDoubleClick,
  onKeyDown,
}: StopHandleProps) {
  return (
    <div
      ref={register}
      role="slider"
      tabIndex={0}
      aria-valuemin={POSITION_MIN}
      aria-valuemax={POSITION_MAX}
      aria-valuenow={stop.position}
      aria-label={`Colour ${index + 1} of ${count}`}
      aria-valuetext={`${stop.color} at ${stop.position} %`}
      className={["gradient-stop", selected ? "selected" : "", removing ? "removing" : ""]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: `${stop.position}%`,
        zIndex: selected ? 2 : 1,
        ...pullStyle(pullPx, removing),
      } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <span className="gradient-handle" style={{ background: stop.color }} aria-hidden="true" />
    </div>
  );
}

interface StopDetailProps {
  stop: UiStop;
  index: number;
  count: number;
  wellRef: React.RefObject<HTMLInputElement | null>;
  onColor(color: string): void;
  onPreviewColor(color: string): void;
  onPosition(position: number): void;
  onRemove(): void;
  onEscape(): void;
}

/** The colour well, hex box, position and Remove row of the selected stop. */
function StopDetail({
  stop,
  index,
  count,
  wellRef,
  onColor,
  onPreviewColor,
  onPosition,
  onRemove,
  onEscape,
}: StopDetailProps) {
  // The text stays mounted so Enter keeps focus, syncing only on outside changes.
  const [text, setText] = useState(stop.color);
  const [invalid, setInvalid] = useState(false);
  const colorRef = useRef(onColor);
  colorRef.current = onColor;
  const previewColorRef = useRef(onPreviewColor);
  previewColorRef.current = onPreviewColor;
  useEffect(() => {
    setText(stop.color);
    setInvalid(false);
  }, [stop.id, stop.color]);

  useEffect(() => {
    const input = wellRef.current;
    if (!input) return;
    input.value = stop.color;
    // Refs stay current across edits, so a position change never stales the well.
    const preview = () => previewColorRef.current(input.value.toLowerCase());
    const commit = () => colorRef.current(input.value.toLowerCase());
    input.addEventListener("input", preview);
    input.addEventListener("change", commit);

    return () => {
      input.removeEventListener("input", preview);
      input.removeEventListener("change", commit);
    };
    // The well stays mounted for the selection, so its value follows hex commits too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop.id, stop.color]);

  const commitHexText = (value: string) => {
    const trimmed = value.trim().toLowerCase();
    const normalised = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    if (!HEX_PATTERN.test(normalised)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (normalised !== stop.color) onColor(normalised);
  };

  return (
    <div
      className="stop-detail"
      onKeyDown={(event) => {
        // The panel closes on an unclaimed Escape, so this claim keeps it open.
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }}
    >
      <input ref={wellRef} type="color" defaultValue={stop.color} aria-label="Stop colour" />
      <label>
        Hex
        <input
          type="text"
          value={text}
          aria-label={`Hex colour ${index + 1} of ${count}`}
          aria-invalid={invalid}
          onChange={(event) => setText(event.target.value)}
          onBlur={(event) => commitHexText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitHexText(event.currentTarget.value);
          }}
        />
      </label>
      <label>
        Position
        <input
          type="number"
          min={POSITION_MIN}
          max={POSITION_MAX}
          value={stop.position}
          aria-label={`Position ${index + 1} of ${count}`}
          onChange={(event) => {
            // Clearing the box is not a move to zero, so it waits for digits.
            if (event.target.value === "") return;
            onPosition(clampPosition(Number(event.target.value)));
          }}
        />
        <span aria-hidden="true">%</span>
      </label>
      <button type="button" disabled={count <= MIN_CUSTOM_COLORS} onClick={onRemove}>
        Remove
      </button>
      {count <= MIN_CUSTOM_COLORS && <p>A gradient needs at least two colours.</p>}
    </div>
  );
}

interface StopKeyActions {
  move(position: number): void;
  remove(): void;
  edit(): void;
  insert(): void;
}

/** Keyboard moves, removal, well focus and midway insertion for one handle. */
function handleStopKey(
  event: React.KeyboardEvent<HTMLDivElement>,
  stop: UiStop,
  actions: StopKeyActions,
) {
  const large = event.shiftKey ? LARGE_STEP : SMALL_STEP;
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowDown":
      event.preventDefault();
      actions.move(clampPosition(stop.position - large));
      return;
    case "ArrowRight":
    case "ArrowUp":
      event.preventDefault();
      actions.move(clampPosition(stop.position + large));
      return;
    case "PageDown":
      event.preventDefault();
      actions.move(clampPosition(stop.position - LARGE_STEP));
      return;
    case "PageUp":
      event.preventDefault();
      actions.move(clampPosition(stop.position + LARGE_STEP));
      return;
    case "Home":
      event.preventDefault();
      actions.move(POSITION_MIN);
      return;
    case "End":
      event.preventDefault();
      actions.move(POSITION_MAX);
      return;
    case "Delete":
    case "Backspace":
      event.preventDefault();
      actions.remove();
      return;
    case "Enter":
    case " ":
      event.preventDefault();
      actions.edit();
      return;
    case "+":
    case "Insert":
      event.preventDefault();
      actions.insert();
      return;
    default:
      return;
  }
}

/** Insert a stop midway from the handle toward its next neighbour. */
function insertAfter(stop: UiStop, draft: UiStop[], addAt: (position: number) => void) {
  const ordered = [...draft].sort((first, second) => first.position - second.position);
  const index = ordered.findIndex(({ id }) => id === stop.id);
  const next = ordered[index + 1] ?? null;
  addAt(
    next
      ? Math.round((stop.position + next.position) / 2)
      : Math.round((stop.position + POSITION_MAX) / 2),
  );
}

/** The draft with one stop moved, resorted so crossings reorder. */
function withMovedStop(draft: UiStop[], id: string, position: number) {
  const next = draft.map((entry) => {
    return entry.id === id ? { ...entry, position } : entry;
  });
  next.sort((first, second) => first.position - second.position);

  return next;
}

/** The draft without one stop. */
function withoutStop(draft: UiStop[], id: string) {
  return draft.filter((stop) => stop.id !== id);
}

/** The draft with one stop recoloured. */
function withRecoloredStop(draft: UiStop[], id: string, color: string) {
  return draft.map((entry) => {
    return entry.id === id ? { ...entry, color } : entry;
  });
}

/** The bar background through the draft stops. */
function gradientCss(stops: UiStop[]) {
  const ordered = [...stops].sort((first, second) => first.position - second.position);

  return `linear-gradient(to right, ${
    ordered.map(({ color, position }) => `${color} ${position}%`).join(", ")
  })`;
}

/** The gradient colour at an integer percent, so added stops blend in invisibly. */
function sampleHexAt(stops: UiStop[], position: number) {
  const table = lut(toGradient(stops));
  const start = Math.round((position / POSITION_MAX) * LAST_ENTRY) * 4;

  return rgbToHex([table[start], table[start + 1], table[start + 2]]);
}

/** Draft stops with stable ids for focus, sorted as given. */
function toUi(stops: GradientStop[], nextId: { current: number }) {
  const ordered = [...stops].sort((first, second) => first.at - second.at);
  return ordered.map(({ at, rgb }) => {
    const stop = {
      id: `stop-${nextId.current++}`,
      color: rgbToHex(rgb),
      position: Math.max(POSITION_MIN, Math.min(POSITION_MAX, Math.round(at * POSITION_MAX))),
    };

    return stop;
  });
}

/** Draft stops as gradient stops for the palette name and the map lookup. */
function toGradient(stops: UiStop[]) {
  return [...stops]
    .sort((first, second) => first.position - second.position)
    .map(({ color, position }) => ({ at: position / POSITION_MAX, rgb: hexToRgb(color) }));
}

/** Canonical names compare equal exactly when the gradients match. */
function gradientName(stops: GradientStop[]) {
  return stops
    .map(({ at, rgb }) => `${Math.round(at * POSITION_MAX)}:${rgbToHex(rgb)}`)
    .join(",");
}

/** Clamp a position to the bar and round it to whole percent. */
function clampPosition(position: number) {
  if (Number.isNaN(position)) return POSITION_MIN;

  return Math.max(POSITION_MIN, Math.min(POSITION_MAX, Math.round(position)));
}

/** Queue one preview per frame while a drag sends many moves. */
function queueFrame(
  frame: React.MutableRefObject<number | null>,
  latest: React.MutableRefObject<GradientStop[] | null>,
  preview: React.MutableRefObject<(stops: GradientStop[]) => void>,
  next: UiStop[],
) {
  latest.current = toGradient(next);
  if (frame.current !== null) return;
  const fire = () => {
    frame.current = null;
    const pending = latest.current;
    latest.current = null;
    if (pending) preview.current(pending);
  };
  if (typeof requestAnimationFrame === "function") frame.current = requestAnimationFrame(fire);
  else frame.current = setTimeout(fire, 16) as unknown as number;
}

/** Clear a queued preview when the editor unmounts. */
function cancelPreview(frame: React.MutableRefObject<number | null>) {
  if (frame.current === null) return;
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame.current);
  else clearTimeout(frame.current);
  frame.current = null;
}

/** Stretch the stem with the pull, and fade the pin once the pull would remove it. */
function pullStyle(pullPx: number, removing: boolean) {
  if (pullPx <= 0) return {};
  const stretch = { "--pull": `${stretchPx(pullPx).toFixed(1)}px` };
  if (!removing) return stretch;
  const opacity = Math.max(MIN_PULLED_OPACITY, 1 - pullPx / PULL_FADE_PX);
  return { ...stretch, opacity: opacity.toFixed(2) };
}

/** Ease a downward pull into a stem stretch that resists more the further it goes. */
function stretchPx(pullPx: number) {
  return MAX_STRETCH_PX * (1 - Math.exp(-pullPx / MAX_STRETCH_PX));
}
