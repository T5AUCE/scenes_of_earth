/** Hit-tests key controls at fixed viewports on a built scene. */
const VIEWPORT_PATTERN = /^(\d+)x(\d+)$/;

/** Caps accepted viewport dimensions far above any real screen so typos fail fast. */
const MAX_VIEWPORT_PX = 4096;

/** Lists the default layout viewports, with narrow phones first so they fail first. */
export const DEFAULT_LAYOUT_VIEWPORTS_PX = [
  { width: 320, height: 800 },
  { width: 320, height: 560 },
  { width: 1280, height: 800 },
];

/**
 * Selects the editor the trial opens. Rainfall configures Units and Reset, so it stands in
 * for every editor.
 */
export const LAYOUT_EDITOR = { role: "button", name: /^Edit Rainfall(?: ·|$)/ };

/**
 * Lists the controls that must stay clickable, matched by accessible role and name.
 * Plain names match a substring while the layer entries anchor on the draw
 * separator, because the blend card shares the Rainfall prefix. The slider
 * stays scoped to the time bar, because editors add their own sliders.
 * Editor-only entries carry when "open" so a closed editor skips them instead
 * of failing, while Expand stays optional until the chip UI arrives.
 */
export const LAYOUT_CONTROLS = [
  { role: "button", name: "Play" },
  { role: "slider", name: "", scope: "#time-bar" },
  { role: "switch", name: /^Show Terrain(?: ·|$)/ },
  { role: "switch", name: /^Show Rainfall(?: ·|$)/ },
  { role: "switch", name: /^Show Temperature(?: ·|$)/ },
  { role: "switch", name: /^Show Land cover(?: ·|$)/ },
  { role: "switch", name: "Show Area outline" },
  { role: "button", name: /^Edit Terrain(?: ·|$)/ },
  LAYOUT_EDITOR,
  { role: "button", name: /^Edit Temperature(?: ·|$)/ },
  { role: "button", name: /^Edit Land cover(?: ·|$)/ },
  { role: "radio", name: "mm/month", when: "open" },
  { role: "radio", name: "in/month", when: "open" },
  { role: "button", name: "Reset layer", when: "open" },
  { role: "button", name: "Reset to this area's range", when: "open" },
  { role: "button", name: "Close", when: "open" },
  { role: "button", name: "Expand", optional: true },
];

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
