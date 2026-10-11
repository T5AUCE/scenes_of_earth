import type { Map as MapLibreMap } from "maplibre-gl";
import { ApiError, getLayers, getSceneStatus, loadScene, postScene, searchAreas } from "./api";
import { fitToBbox } from "./map";
import { makeElement } from "./dom";
import { mountScene } from "./view";
import type { AreaHit, Layer, Scene, SceneRequest, SceneStatus } from "./types";

const POLL_INTERVAL_MS = 1500;
const SEARCH_DEBOUNCE_MS = 300;
const DEFAULT_MONTHS = 6;
const DEFAULT_RETRY_SECONDS = 30;
const MAX_POLL_FAILURES = 3;
const SERVER_BUSY = 503;
const NOT_FOUND = 404;

const AREA_LEVELS = [
  { value: "", label: "any level" },
  { value: "country", label: "country" },
  { value: "state", label: "state" },
  { value: "county", label: "county" },
  { value: "city", label: "city" },
];

export async function createPanel(root: HTMLElement, map: MapLibreMap) {
  const controls = createControls(root);
  const { search, level, results, chosen, layerBox, start, end, build, status, result } = controls;

  let area: AreaHit | null = null;
  let run = 0; // id of the current build; changing it cancels the running poll
  let layers: Layer[] = [];
  let unmountScene = () => {};

  try {
    layers = await loadLayerChoices(controls);
  } catch (error) {
    status.textContent = `Could not load layers: ${(error as Error).message}`;
    build.disabled = true;
  }

  const selectedLayerIds = () =>
    [...layerBox.querySelectorAll("input:checked")].map((box) => (box as HTMLInputElement).value);
  const usesMonths = () =>
    layers.some((layer) => layer.time_varying && selectedLayerIds().includes(layer.id));
  const updateMonths = () => (start.disabled = end.disabled = !usesMonths());

  layerBox.onchange = updateMonths;
  updateMonths();

  let searchTimer: number | undefined;
  let searchCount = 0;

  const scheduleSearch = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  };
  search.oninput = scheduleSearch;
  level.onchange = scheduleSearch;

  build.onclick = buildScene;

  return { openScene, showStatus };

  function showStatus(text: string) {
    status.textContent = text;
  }

  async function runSearch() {
    const thisSearch = ++searchCount;
    const query = search.value.trim();
    results.replaceChildren();
    if (!query) return;

    try {
      const hits = await searchAreas(query, level.value);
      if (thisSearch !== searchCount) return; // a newer search is running

      if (!hits.length) makeElement("li", "No matches", results).className = "none";

      for (const hit of hits) showHit(hit);
    } catch (error) {
      if (thisSearch !== searchCount) return;

      makeElement("li", `Search failed: ${(error as Error).message}`, results).className = "none";
    }
  }

  function showHit(hit: AreaHit) {
    const text = [hit.name, hit.parent_name, hit.level].filter(Boolean).join(" · ");
    makeElement("li", text, results).onclick = () => {
      area = hit;
      run++;
      build.disabled = false;
      results.replaceChildren();
      chosen.textContent = hit.name;
      fitToBbox(map, hit.bbox);
    };
  }

  function showScene(scene: Scene) {
    unmountScene();
    result.replaceChildren();
    makeElement("h3", scene.title, result);
    unmountScene = mountScene(map, scene, result);
    fitToBbox(map, scene.area.bbox);
  }

  async function openScene(id: string) {
    const thisRun = ++run;
    try {
      const sceneStatus = await getSceneStatus(id);
      if (sceneStatus.status !== "done") {
        status.textContent = `Scene ${id} is ${sceneStatus.status}.`;

        return;
      }

      const scene = await loadScene(sceneStatus.bundle_url!);
      if (thisRun === run) showScene(scene);
    } catch (error) {
      if (thisRun === run) {
        status.textContent = `Could not open scene ${id}: ${(error as Error).message}`;
      }
    }
  }

  async function buildScene() {
    unmountScene();
    unmountScene = () => {};
    result.replaceChildren();

    if (!area) {
      status.textContent = "Select an area first.";

      return;
    }

    if (!selectedLayerIds().length) {
      status.textContent = "Select at least one layer.";

      return;
    }

    build.disabled = true;
    const thisRun = ++run;
    try {
      const finished = await submitAndPoll(thisRun);
      if (!finished) return;

      if (finished.status === "failed") {
        status.textContent = `Build failed: ${finished.error ?? "unknown error"}`;

        return;
      }

      status.textContent = "Bundle ready.";
      const scene = await loadScene(finished.bundle_url!);
      if (thisRun === run) showScene(scene);
    } catch (error) {
      if (thisRun !== run) return;

      status.textContent = error instanceof ApiError
        ? `Error ${error.status}: ${error.message}`
        : `Error: ${(error as Error).message}`;
    } finally {
      if (thisRun === run) build.disabled = false;
    }
  }

  // Returns null when a newer run has cancelled this one.
  async function submitAndPoll(thisRun: number) {
    const submitted = await submit(thisRun);
    if (!submitted || thisRun !== run) return null;

    let current = submitted;
    let failures = 0;

    while (current.status === "queued" || current.status === "running") {
      showProgress(current);
      await wait(POLL_INTERVAL_MS);
      if (thisRun !== run) return null;

      try {
        current = await getSceneStatus(current.id);
        failures = 0;
      } catch (error) {
        const isMissing = error instanceof ApiError && error.status === NOT_FOUND;
        if (isMissing || ++failures >= MAX_POLL_FAILURES) throw error;
      }
    }

    return thisRun === run ? current : null;
  }

  // Registers the request; one automatic retry after Retry-After when the server is busy.
  async function submit(thisRun: number): Promise<SceneStatus | null> {
    const body: SceneRequest = {
      area: { type: "boundary", id: area!.id },
      layers: selectedLayerIds(),
    };
    if (usesMonths()) Object.assign(body, { start: start.value, end: end.value });

    try {
      return await postScene(body);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== SERVER_BUSY) throw error;

      const retrySeconds = error.retryAfter ?? DEFAULT_RETRY_SECONDS;
      status.textContent = `${error.message} Retrying in ${retrySeconds} s…`;
      await wait(retrySeconds * 1000);

      return thisRun === run ? postScene(body) : null;
    }
  }

  function showProgress(sceneStatus: SceneStatus) {
    status.textContent = sceneStatus.status === "running"
      ? `Building… ${Math.round(sceneStatus.progress * 100)}%`
      : `Scene ${sceneStatus.status}…`;
  }
}

function createControls(root: HTMLElement) {
  const search = makeElement("input", "", root);
  search.placeholder = "Search an area";

  const level = makeElement("select", "", root);

  for (const { value, label } of AREA_LEVELS) level.append(new Option(label, value));

  const results = makeElement("ul", "", root);
  results.className = "results";

  const chosen = makeElement("div", "No area selected", root);
  chosen.className = "chosen";

  const layerBox = makeElement("fieldset", "", root);
  makeElement("legend", "Layers", layerBox);

  const months = makeElement("div", "", root);
  const start = document.createElement("input");
  const end = document.createElement("input");
  start.type = end.type = "month";
  months.append("From ", start, " to ", end);

  const build = makeElement("button", "Build scene", root);

  const status = makeElement("div", "", root);
  status.className = "status";

  const result = makeElement("div", "", root);

  return { search, level, results, chosen, layerBox, start, end, build, status, result };
}

// Layers come from the backend; none are hard-coded here.
async function loadLayerChoices({ layerBox, start, end }: ReturnType<typeof createControls>) {
  const { layers, default: defaultIds } = await getLayers();

  for (const layer of layers) {
    const label = makeElement("label", "", layerBox);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = layer.id;
    box.checked = defaultIds.includes(layer.id);
    label.append(box, ` ${layer.title} (${layer.units})`);
  }

  const axes = layers.flatMap((layer) => (layer.time ? [layer.time] : []));
  if (axes.length) {
    const commonFirst = axes.map((axis) => axis.first).sort().at(-1)!;
    const commonLatest = axes.map((axis) => axis.latest).sort()[0];
    const defaultStart = addMonths(commonLatest, 1 - DEFAULT_MONTHS);

    start.min = end.min = commonFirst;
    start.max = end.max = commonLatest;
    end.value = commonLatest;
    start.value = defaultStart < commonFirst ? commonFirst : defaultStart;
  }

  return layers;
}

function addMonths(yearMonth: string, delta: number) {
  const [year, month] = yearMonth.split("-").map(Number);
  const totalMonths = year * 12 + (month - 1) + delta;

  return `${Math.floor(totalMonths / 12)}-${String((totalMonths % 12) + 1).padStart(2, "0")}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
