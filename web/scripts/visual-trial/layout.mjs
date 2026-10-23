/** Hit-tests key controls at fixed viewports on a built scene. */
const VIEWPORT_PATTERN = /^(\d+)x(\d+)$/;

/** Caps accepted viewport dimensions far above any real screen so typos fail fast. */
const MAX_VIEWPORT_PX = 4096;

/** Samples each slider endpoint, inset so rounding cannot miss the control itself. */
const SLIDER_EDGE_INSET_PX = 3;

/** Lists the desktop release viewports, with the minimum supported size first. */
export const DEFAULT_LAYOUT_VIEWPORTS_PX = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];

/**
 * Selects the editor the trial opens. Rainfall configures Units and Reset, so it stands in
 * for every editor.
 */
export const LAYOUT_EDITOR = {
  role: "button",
  name: /^Edit Rainfall(?: ·|$)/,
  scroll: "#scene-column .cards",
};

/**
 * Lists the controls that must stay clickable, matched by accessible role and name.
 * Plain names match a substring while the layer entries anchor on the draw
 * separator, because the blend card shares the Rainfall prefix. The slider
 * stays scoped to the time bar and samples five points across it, because a fixed
 * editor can cover one end while the center stays clickable. Editors add their own
 * sliders, so the scope matters twice.
 * Editor-only entries carry when "open" so a closed editor skips them instead
 * of failing, while Expand stays optional until the chip UI arrives. Entries
 * with a scroll selector live in that scrollable container, so the trial
 * centres them there before hit-testing; fixed regions are never scrolled,
 * so an overlap with the time bar, the panel footer or the editor still fails.
 */
export const LAYOUT_CONTROLS = [
  { role: "button", name: "Play" },
  { role: "slider", name: "", scope: "#time-bar", samples: 5 },
  { role: "switch", name: /^Show Terrain(?: ·|$)/, scroll: "#scene-column .cards" },
  { role: "switch", name: /^Show Rainfall(?: ·|$)/, scroll: "#scene-column .cards" },
  { role: "switch", name: /^Show Temperature(?: ·|$)/, scroll: "#scene-column .cards" },
  { role: "switch", name: /^Show Land cover(?: ·|$)/, scroll: "#scene-column .cards" },
  { role: "switch", name: "Show Area outline", scroll: "#scene-column .cards" },
  { role: "button", name: /^Edit Terrain(?: ·|$)/, scroll: "#scene-column .cards" },
  LAYOUT_EDITOR,
  { role: "button", name: /^Edit Temperature(?: ·|$)/, scroll: "#scene-column .cards" },
  { role: "button", name: /^Edit Land cover(?: ·|$)/, scroll: "#scene-column .cards" },
  { role: "radio", name: "mm/month", when: "open", scroll: ".layer-editor" },
  { role: "radio", name: "in/month", when: "open", scroll: ".layer-editor" },
  { role: "button", name: "Reset layer", when: "open", scroll: ".layer-editor" },
  { role: "button", name: "Reset to this area's range", when: "open", scroll: ".layer-editor" },
  { role: "button", name: "Close", when: "open", scroll: ".layer-editor" },
  { role: "button", name: "Expand", optional: true },
];

/** Spreads count sample points across a control box for endpoint hit-testing. */
export function spreadPoints(box, count) {
  const span = box.width - 2 * SLIDER_EDGE_INSET_PX;
  return Array.from({ length: count }, (_, index) => {
    const fraction = index / (count - 1);
    const x = box.x + SLIDER_EDGE_INSET_PX + span * fraction;

    return [x, box.y + box.height / 2];
  });
}

/**
 * Parses a comma-separated viewport list such as "320x800,1280x800".
 * Throws an error that names the bad entry.
 */
export function parseViewportList(text) {
  return String(text).split(",").map((part) => parseViewport(part.trim()));
}

function parseViewport(text) {
  const match = VIEWPORT_PATTERN.exec(text);
  if (!match) throwInvalidViewport(text);

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1 || width > MAX_VIEWPORT_PX || height > MAX_VIEWPORT_PX) {
    throwInvalidViewport(text);
  }

  return { width, height };
}

function throwInvalidViewport(text) {
  throw new Error(`bad viewport "${text}", want WxH like 320x800`);
}

/**
 * Returns the viewports the layout trial checks, from SOE_LAYOUT_VIEWPORTS or the default list.
 * An env var carries the override because the trial runner cannot forward its argv here.
 */
export function layoutViewports(env = process.env) {
  const text = env.SOE_LAYOUT_VIEWPORTS;
  if (text === undefined || text === "") return DEFAULT_LAYOUT_VIEWPORTS_PX;

  return parseViewportList(text);
}

/** Renders a viewport as the "WxH" text the layout records carry. */
export function viewportLabel({ width, height }) {
  return `${width}x${height}`;
}

/** Returns the name a record shows, using a pattern's source so regex entries stay readable. */
export function controlDisplay(control) {
  return typeof control.name === "string" ? control.name : control.name.source;
}

/** Renders an intercepted element as a short selector with its clipped text. */
export function hitLabel(hit) {
  if (hit === null) return null;

  const id = hit.id ? `#${hit.id}` : "";
  const classes = hit.classes.map((name) => `.${name}`).join("");
  const text = hit.text ? ` "${hit.text}"` : "";

  return `${hit.tag}${id}${classes}${text}`;
}

/**
 * Determines whether a control is required in the current editor state.
 * Editor-only entries apply while the editor is open, and everything else applies in both
 * states unless it is marked optional.
 */
export function requiredInState(control, editor) {
  if (control.optional === true) return false;

  const when = control.when ?? "both";
  return when === "both" || when === editor;
}

/**
 * Shapes one layout record for a control hit-test or a page check.
 * Callers pass an explicit pass, so a missing required control fails the trial while an
 * expected absence stays null.
 */
export function layoutRecord({ viewport, editor, role, name, present, pass, hit }) {
  return {
    viewport: viewportLabel(viewport),
    editor,
    role,
    name,
    present,
    pass,
    hit: present ? hitLabel(hit) : null,
  };
}

/** Reports whether any record failed so the runner can choose its exit code. */
export function layoutFailed(records) {
  return records.some((record) => record.pass === false);
}
