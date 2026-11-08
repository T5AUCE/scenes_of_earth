/** Own boundary search interaction and picked outlines without owning scene cancellation. */
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
import { shiftLongitudes, worldShift } from "./render/mercator";
import type { AreaFeature, AreaHit, Bbox } from "./types";

const SEARCH_DEBOUNCE_MS = 300;
export const NO_AREA_TEXT = "No area selected";
const AREA_LEVELS = [
  { value: "", label: "Any Level" },
  { value: "country", label: "ADM0 (country, territory, etc.)" },
  { value: "state", label: "ADM1 (state, county, etc.)" },
  { value: "county", label: "ADM2 (district, county, etc.)" },
  { value: "city", label: "City (urban area)" },
];
// Results name the level briefly; the dropdown's examples would crowd each hit.
const LEVEL_LABELS = new Map([
  ["country", "Country"],
  ["state", "ADM1"],
  ["county", "ADM2"],
  ["city", "City"],
]);

/** The existing combobox and selected-area label owned by one search interaction. */
export interface AreaSearchControls {
  search: HTMLInputElement;
  level: HTMLSelectElement;
  results: HTMLUListElement;
  chosen: HTMLElement;
}

/** Attach search before layers load while the panel retains selection/build coordination. */
export function bindAreaSearch(
  { search, level, results, chosen }: AreaSearchControls,
  map: MapLibreMap,
  onPick: (hit: AreaHit) => void,
  onClear: () => void,
) {
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchCount = 0;
  let pickCount = 0;
  let shownHits: AreaHit[] = [];
  let hitItems: HTMLElement[] = [];
  let activeIndex = -1;

  const scheduleSearch = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  };

  search.oninput = () => {
    if (!search.value.trim()) deselectArea();
    scheduleSearch();
  };
  search.onkeydown = handleSearchKey;
  search.onblur = closeResults;
  level.onchange = scheduleSearch;

  return { clearOutline };

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
    const kind = hit.kind ?? LEVEL_LABELS.get(hit.level) ?? hit.level;
    const text = [hit.name, hit.parent_name, kind].filter(Boolean).join(" · ");
    const item = makeHtmlElement("li", text, results);
    item.id = `${results.id}-${index}`;
    item.setAttribute("role", "option");

    // Mouse down, not click, so the pick happens before the input loses focus.
    item.onmousedown = (event) => {
      event.preventDefault();
      pick(hit);
    };
    return item;
  }

  function pick(hit: AreaHit) {
    onPick(hit);
    closeResults();
    chosen.textContent = hit.name;
    search.value = hit.name;
    fitToBbox(map, hit.bbox, { padding: BROWSE_PADDING_PX, maxZoom: BROWSE_MAX_ZOOM });
    drawPickedOutline(hit);
  }

  // The outline is the stored geometry; the bbox rectangle stands in when it cannot be fetched.
  async function drawPickedOutline(hit: AreaHit) {
    const thisPick = ++pickCount;
    const geometry = await getArea(hit.id).then(
      (detail) => detail.geometry,
      () => bboxGeometry(hit.bbox),
    );
    if (thisPick !== pickCount) return;

    const shifted = shiftLongitudes(geometry.coordinates, worldShift(hit.bbox));
    showPickedOutline(map, { ...geometry, coordinates: shifted } as GeoJSON.Geometry);
  }

  // Clearing the search forgets the area, so Build asks for a new pick.
  function deselectArea() {
    onClear();
    pickCount++;
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

  function clearOutline() {
    pickCount++;
    clearPickedOutline(map);
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

  const results = makeHtmlElement("ul", "", searchBox);
  results.id = "area-results";
  results.className = "results";
  results.setAttribute("role", "listbox");
  results.hidden = true;

  return { search, level, results };
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
