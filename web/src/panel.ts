import type { Map as MapLibreMap } from "maplibre-gl";
import { ApiError, getLayers, getSceneStatus, loadScene, postScene, searchAreas } from "./api";
import { fitToBbox } from "./map";
import type { AreaHit, Layer, Scene, SceneRequest, SceneStatus } from "./types";

const POLL_MS = 1500;
const DEFAULT_MONTHS = 6;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", parent?: HTMLElement) {
  const e = document.createElement(tag);
  e.textContent = text;
  parent?.append(e);
  return e;
}

function addMonths(ym: string, delta: number) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export async function createPanel(root: HTMLElement, map: MapLibreMap) {
  let area: AreaHit | null = null;
  let run = 0; // id of the current build; changing it cancels the running poll

  const search = el("input", "", root);
  search.placeholder = "Search an area";
  const level = el("select", "", root);
  for (const [v, t] of [["", "any level"], ["country", "country"], ["state", "state"], ["county", "county"], ["city", "city"]]) {
    level.append(new Option(t, v));
  }
  const results = el("ul", "", root);
  results.className = "results";
  const chosen = el("div", "No area selected", root);
  chosen.className = "chosen";

  const layerBox = el("fieldset", "", root);
  el("legend", "Layers", layerBox);
  const months = el("div", "", root);
  const start = document.createElement("input");
  const end = document.createElement("input");
  start.type = end.type = "month";
  months.append("From ", start, " to ", end);
  const build = el("button", "Build scene", root);
  const status = el("div", "", root);
  status.className = "status";
  const result = el("div", "", root);

  // Layers come from the backend; none are hard-coded here.
  let layers: Layer[] = [];
  try {
    const info = await getLayers();
    layers = info.layers;
    for (const layer of layers) {
      const label = el("label", "", layerBox);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = layer.id;
      box.checked = info.default.includes(layer.id);
      label.append(box, ` ${layer.title} (${layer.units})`);
    }
    const series = layers.filter((l) => l.time_varying && l.first_month && l.latest_month);
    if (series.length) {
      const first = series.map((l) => l.first_month!).sort().at(-1)!;
      const latest = series.map((l) => l.latest_month!).sort()[0];
      start.min = end.min = first;
      start.max = end.max = latest;
      end.value = latest;
      start.value = addMonths(latest, 1 - DEFAULT_MONTHS) < first ? first : addMonths(latest, 1 - DEFAULT_MONTHS);
    }
  } catch (e) {
    status.textContent = `Could not load layers: ${(e as Error).message}`;
    build.disabled = true;
  }

  const selectedLayers = () => [...layerBox.querySelectorAll("input:checked")].map((i) => (i as HTMLInputElement).value);
  const usesMonths = () => layers.some((l) => l.time_varying && selectedLayers().includes(l.id));
  const updateMonths = () => (start.disabled = end.disabled = !usesMonths());
  layerBox.onchange = updateMonths;
  updateMonths();

  let timer: number | undefined;
  let searchSeq = 0;
  const runSearch = async () => {
    const seq = ++searchSeq;
    const q = search.value.trim();
    results.replaceChildren();
    if (!q) return;
    try {
      const hits = await searchAreas(q, level.value);
      if (seq !== searchSeq) return; // a newer search is running
      if (!hits.length) el("li", "No matches", results).className = "none";
      for (const hit of hits) {
        const li = el("li", [hit.name, hit.parent_name, hit.level].filter(Boolean).join(" · "), results);
        li.onclick = () => {
          area = hit;
          run++;
          build.disabled = false;
          results.replaceChildren();
          chosen.textContent = hit.name;
          fitToBbox(map, hit.bbox);
        };
      }
    } catch (e) {
      if (seq === searchSeq) el("li", `Search failed: ${(e as Error).message}`, results).className = "none";
    }
  };
  const scheduleSearch = () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 300);
  };
  search.oninput = scheduleSearch;
  level.onchange = scheduleSearch;

  const showProgress = (s: SceneStatus) => {
    status.textContent = s.status === "running" ? `Building… ${Math.round(s.progress * 100)}%` : `Scene ${s.status}…`;
  };

  // Registers the request; one automatic retry after Retry-After when the server is busy (503).
  async function submit(mine: number): Promise<SceneStatus | null> {
    const body: SceneRequest = { area: { type: "boundary", id: area!.id }, layers: selectedLayers() };
    if (usesMonths()) Object.assign(body, { start: start.value, end: end.value });
    try {
      return await postScene(body);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 503) throw e;
      const secs = e.retryAfter ?? 30;
      status.textContent = `${e.message} Retrying in ${secs} s…`;
      await wait(secs * 1000);
      return mine === run ? postScene(body) : null;
    }
  }

  function showScene(scene: Scene) {
    result.replaceChildren();
    el("h3", scene.title, result);
    if (scene.time) el("div", `${scene.time.start} to ${scene.time.end} (${scene.time.count} months)`, result);
    const list = el("ul", "", result);
    for (const l of scene.layers) el("li", `${l.style.title} (${l.units})`, list);
    for (const n of scene.notices.limits) el("div", n, result).className = "notice";
    fitToBbox(map, scene.area.bbox);
  }

  build.onclick = async () => {
    result.replaceChildren();
    if (!area) return void (status.textContent = "Select an area first.");
    if (!selectedLayers().length) return void (status.textContent = "Select at least one layer.");
    build.disabled = true;
    const mine = ++run;
    try {
      const first = await submit(mine);
      if (!first || mine !== run) return;
      let s = first;
      let failures = 0;
      while (s.status === "queued" || s.status === "running") {
        showProgress(s);
        await wait(POLL_MS);
        if (mine !== run) return;
        try {
          s = await getSceneStatus(s.id);
          failures = 0;
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) throw e;
          if (++failures >= 3) throw e;
        }
      }
      if (mine !== run) return;
      if (s.status === "failed") {
        status.textContent = `Build failed: ${s.error ?? "unknown error"}`;
        return;
      }
      status.textContent = "Bundle ready.";
      const scene = await loadScene(s.bundle_url!);
      if (mine === run) showScene(scene);
    } catch (e) {
      if (mine !== run) return;
      status.textContent = e instanceof ApiError ? `Error ${e.status}: ${e.message}` : `Error: ${(e as Error).message}`;
    } finally {
      if (mine === run) build.disabled = false;
    }
  };
}
