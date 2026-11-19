/** Own boundary search interaction and picked outlines without owning scene cancellation. */
import type { Geometry } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";

import { getArea, searchAreas } from "./api";
import { nextOptionIndex } from "./combobox";
import { makeHtmlElement } from "./html";
import {
  BROWSE_MAX_ZOOM,
  BROWSE_PADDING_PX,
  clearPickedOutline,
  fitToBbox,
  showPickedOutline,
} from "./map";
import {
  loadNamePreference,
  preferredName,
  storeNamePreference,
  type NamePreference,
} from "./name-preference";
import { shiftLongitudes, worldShift } from "./render/mercator";
import type { AreaFeature, AreaHit, Bbox } from "./types";

const SEARCH_DEBOUNCE_MS = 300;
export const NO_AREA_TEXT = "No area selected";
const AREA_PREFIX = "Currently selected - ";
const AREA_LEVELS = [
  { value: "", label: "Any Level" },
  { value: "country", label: "ADM0" },
  { value: "state", label: "ADM1" },
  { value: "county", label: "ADM2" },
  { value: "city", label: "City" },
  { value: "urban", label: "Urban area" },
];
// Results name the official admin level rather than each country's local word for it.
const LEVEL_LABELS = new Map([
  ["country", "ADM0"],
  ["state", "ADM1"],
  ["county", "ADM2"],
  ["city", "City"],
  ["urban", "Urban area"],
]);

const NAME_PREFERENCE_OPTIONS = [
  { value: "english", label: "English" },
  { value: "local", label: "Local" },
];

// The panel still passes the old shape, so binding finds the new toggle here.
const nameToggleBySearch = new WeakMap<HTMLInputElement, HTMLSelectElement>();

/** The existing combobox and selected-area label owned by one search interaction. */
export interface AreaSearchControls {
  search: HTMLInputElement;
  level: HTMLSelectElement;
  results: HTMLUListElement;
  chosen: HTMLElement;
  namePreference?: HTMLSelectElement;
}

/** Attach search before layers load while the panel retains selection/build coordination. */
export function bindAreaSearch(
  { search, level, results, chosen, namePreference: explicitToggle }: AreaSearchControls,
  map: MapLibreMap,
  onPick: (hit: AreaHit) => void,
  onClear: () => void,
  onOutlineNotice?: (text: string) => void,
) {
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchCount = 0;
  let pickCount = 0;
  let shownHits: AreaHit[] = [];
  let hitItems: HTMLElement[] = [];
  let activeIndex = -1;
  // Hiding keeps the geometry so leaving the scene can show it again.
  let lastOutline: Geometry | null = null;
  let isOutlineHidden = false;
  // A failure notice must not overwrite the entry status while the outline is hidden.
  let outlineNotice: string | null = null;
  let preference: NamePreference = loadNamePreference();
  let pickedHit: AreaHit | null = null;
  let pickedApproximate = false;
  const toggle = explicitToggle ?? nameToggleBySearch.get(search);

  if (toggle) {
    toggle.value = preference;
    toggle.onchange = () => {
      const previous = preference;
      preference = toggle.value === "local" ? "local" : "english";
      storeNamePreference(preference);
      refreshNames(previous);
    };
  }

  const scheduleSearch = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(), SEARCH_DEBOUNCE_MS);
  };

  search.oninput = () => {
    if (!search.value.trim()) deselectArea();
    scheduleSearch();
  };
  search.onkeydown = handleSearchKey;
  search.onblur = closeResults;
  level.onchange = scheduleSearch;

  return { hideOutline, showOutline };

  async function runSearch() {
    const thisSearch = ++searchCount;
    const query = search.value.trim();
    closeResults();

    if (!query) return;

    try {
      const hits = await searchAreas(query, level.value);

      // A newer search has started, so these hits are stale.
      if (thisSearch !== searchCount) return;

      if (!hits.length) showMessage("No matches");

      shownHits = hits;
      hitItems = hits.map(showHit);
      openResults();
    } catch (error) {
      if (thisSearch !== searchCount) return;

      showMessage(`Search failed: ${(error as Error).message}`);
    }
  }

  function showMessage(text: string) {
    const item = makeHtmlElement("li", text, results);
    item.className = "none";
    item.setAttribute("role", "presentation");
    openResults();
  }

  function showHit(hit: AreaHit, index: number) {
    const item = makeHtmlElement("li", hitText(hit), results);
    item.id = `${results.id}-${index}`;
    item.setAttribute("role", "option");

    // Mouse down, not click, so the pick happens before the input loses focus.
    item.onmousedown = (event) => {
      event.preventDefault();
      pick(hit);
    };

    return item;
  }

  function refreshNames(previous: NamePreference) {
    shownHits.forEach((hit, index) => {
      hitItems[index].textContent = hitText(hit);
    });

    if (!pickedHit) return;

    const name = preferredName(pickedHit.name, pickedHit.name_local, preference);
    const previousName = preferredName(pickedHit.name, pickedHit.name_local, previous);
    chosen.textContent = `${AREA_PREFIX}${name}${pickedApproximate ? " (approximate outline)" : ""}`;

    // An edited query is the viewer's next search, so only the untouched pick label follows.
    if (search.value === previousName) search.value = name;
  }

  function hitText(hit: AreaHit) {
    const level = LEVEL_LABELS.get(hit.level) ?? hit.level;
    const name = preferredName(hit.name, hit.name_local, preference);
    const parent = hit.parent_name
      ? preferredName(hit.parent_name, hit.parent_name_local, preference)
      : null;
    return [name, parent, level].filter(Boolean).join(" · ");
  }

  function pick(hit: AreaHit) {
    onPick(hit);
    closeResults();
    pickedHit = hit;
    pickedApproximate = false;
    const name = preferredName(hit.name, hit.name_local, preference);
    chosen.textContent = `${AREA_PREFIX}${name}`;
    search.value = name;
    isOutlineHidden = false;
    outlineNotice = null;
    fitToBbox(map, hit.bbox, { padding: BROWSE_PADDING_PX, maxZoom: BROWSE_MAX_ZOOM });
    void drawPickedOutline(hit);
  }

  // The outline is the stored geometry; the bbox rectangle stands in when it cannot be fetched.
  async function drawPickedOutline(hit: AreaHit) {
    const thisPick = ++pickCount;
    let geometry: AreaFeature["geometry"];
    let pendingNotice: string | null = null;

    try {
      geometry = (await getArea(hit.id)).geometry;
    } catch {
      if (thisPick !== pickCount) return;

      const name = preferredName(hit.name, hit.name_local, preference);
      geometry = bboxGeometry(hit.bbox);
      pickedApproximate = true;
      chosen.textContent = `${AREA_PREFIX}${name} (approximate outline)`;
      pendingNotice = `Outline unavailable for ${name}; showing an approximate outline.`;

      if (!isOutlineHidden) onOutlineNotice?.(pendingNotice);
    }

    if (thisPick !== pickCount) return;

    const shifted = shiftLongitudes(geometry.coordinates, worldShift(hit.bbox));
    lastOutline = { ...geometry, coordinates: shifted } as Geometry;
    outlineNotice = isOutlineHidden ? pendingNotice : null;

    if (isOutlineHidden) return;

    showPickedOutline(map, lastOutline);
  }

  // Clearing the search forgets the area, so Build asks for a new pick.
  function deselectArea() {
    onClear();
    pickCount++;
    pickedHit = null;
    pickedApproximate = false;
    lastOutline = null;
    outlineNotice = null;
    isOutlineHidden = false;
    chosen.textContent = NO_AREA_TEXT;
    clearPickedOutline(map);
  }

  function handleSearchKey(event: KeyboardEvent) {
    if (event.key === "Escape") closeResults();
    else if (event.key === "Enter") pickActive(event);
    else moveActive(event);
  }

  function pickActive(event: KeyboardEvent) {
    if (activeIndex < 0) return;

    event.preventDefault();
    pick(shownHits[activeIndex]);
  }

  function moveActive(event: KeyboardEvent) {
    const next = nextOptionIndex(event.key, activeIndex, hitItems.length);
    if (next === activeIndex) return;

    event.preventDefault();
    openResults();
    setActive(next);
  }

  function setActive(index: number) {
    hitItems[activeIndex]?.setAttribute("aria-selected", "false");
    activeIndex = index;

    const item = hitItems[index];
    item.setAttribute("aria-selected", "true");
    item.scrollIntoView({ block: "nearest" });
    search.setAttribute("aria-activedescendant", item.id);
  }

  function openResults() {
    results.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }

  function closeResults() {
    results.replaceChildren();
    results.hidden = true;
    shownHits = [];
    hitItems = [];
    activeIndex = -1;
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
  }

  function hideOutline() {
    isOutlineHidden = true;
    clearPickedOutline(map);
  }

  function showOutline() {
    isOutlineHidden = false;

    if (!lastOutline) return;

    showPickedOutline(map, lastOutline);

    if (outlineNotice) onOutlineNotice?.(outlineNotice);

    outlineNotice = null;
  }
}

/** Create the same ordered area-search controls used by the panel shell. */
export function createSearchControls(root: HTMLElement) {
  const searchBox = makeHtmlElement("div", "", root);
  searchBox.className = "search-box";

  const search = makeHtmlElement("input", "", searchBox);
  search.placeholder = "Search an area";
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-label", "Search an area");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-controls", "area-results");
  search.setAttribute("aria-expanded", "false");
  search.autocomplete = "off";

  const level = makeHtmlElement("select", "", root);

  for (const { value, label } of AREA_LEVELS) level.append(new Option(label, value));

  const namePreference = makeHtmlElement("select", "", root);
  namePreference.setAttribute("aria-label", "Name language");

  for (const { value, label } of NAME_PREFERENCE_OPTIONS) {
    namePreference.append(new Option(label, value));
  }

  namePreference.value = loadNamePreference();
  nameToggleBySearch.set(search, namePreference);

  const results = makeHtmlElement("ul", "", searchBox);
  results.id = "area-results";
  results.className = "results";
  results.setAttribute("role", "listbox");
  results.hidden = true;

  return { search, level, results, namePreference };
}

function bboxGeometry([west, south, east, north]: Bbox): AreaFeature["geometry"] {
  const ring = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];

  return { type: "Polygon", coordinates: [ring] };
}
