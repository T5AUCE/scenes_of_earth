import type { Map as MapLibreMap } from "maplibre-gl";

import { ApiError, getSceneStatus, loadScene } from "./api";
import { bindAreaSearch, createSearchControls, NO_AREA_TEXT } from "./area-search";
import { makeHtmlElement } from "./html";
import { loadLayerChoices } from "./layer-picker";
import { createMonthSelect } from "./month-select";
import { submitAndPoll } from "./scene-build";
import type { EnterOptions } from "./scene-mode";
import type { AreaHit, Layer, Scene, SceneRequest } from "./types";
import { PREPARING_STATUS } from "./ui/panel-contract";

interface SceneMode {
  enter(scene: Scene, options: EnterOptions): void;
}

/** The area search and build panel; search works while the layer choices load. */
export async function createPanel(
  root: HTMLElement,
  map: MapLibreMap,
  sceneMode: SceneMode | (() => Promise<SceneMode>),
) {
  const controls = createControls(root);
  const { search, level, results, chosen, layerBox, start, end, build, status } = controls;

  let area: AreaHit | null = null;
  // Changing the run id cancels the running poll.
  let run = 0;
  let layers: Layer[] = [];

  const selectedLayerIds = () =>
    [...layerBox.querySelectorAll("input:checked")].map((box) => (box as HTMLInputElement).value);
  const usesMonths = () =>
    layers.some((layer) => layer.time_varying && selectedLayerIds().includes(layer.id));
  const updateMonths = () => (start.disabled = end.disabled = !usesMonths());

  layerBox.onchange = updateMonths;
  updateMonths();

  const areaSearch = bindAreaSearch(
    { search, level, results, chosen },
    map,
    handlePick,
    handleClear,
    showStatus,
  );

  build.onclick = buildScene;

  // Search stays live while the layer list loads, so handlers attach before this fetch.
  try {
    layers = await loadLayerChoices(controls);
  } catch (error) {
    status.textContent = `Could not load layers: ${(error as Error).message}`;
    build.disabled = true;
  }
  updateMonths();

  return { openScene, showStatus, cancelOpen };

  function cancelOpen() {
    run++;
    if (status.classList.contains("busy")) {
      build.disabled = false;
      status.classList.remove("busy");
    }
  }

  function showStatus(text: string) {
    status.textContent = text;
  }

  function setBusy(isBusy: boolean) {
    build.disabled = isBusy;
    status.classList.toggle("busy", isBusy);
  }

  function handlePick(hit: AreaHit) {
    area = hit;
    run++;
    build.disabled = false;
    status.textContent = "";
    status.classList.remove("busy");
  }

  function handleClear() {
    area = null;
  }

  async function openScene(id: string, options: EnterOptions) {
    const thisRun = ++run;

    try {
      const sceneStatus = await getSceneStatus(id);
      if (sceneStatus.status !== "done") {
        status.textContent = `Scene ${id} is ${sceneStatus.status}.`;
        return;
      }

      const scene = await loadScene(sceneStatus.bundle_url!);
      if (thisRun === run) await enterScene(scene, options, thisRun);
    } catch (error) {
      if (thisRun === run) {
        status.textContent = `Could not open scene ${id}: ${(error as Error).message}`;
      }
    }
  }

  async function buildScene() {
    if (!area) {
      status.textContent = "Select an area first.";
      return;
    }

    if (!selectedLayerIds().length) {
      status.textContent = "Select at least one layer.";
      return;
    }

    build.disabled = true;
    status.textContent = "Starting build…";
    status.classList.add("busy");
    const thisRun = ++run;
    let enteredScene = false;

    try {
      const finished = await submitAndPoll(
        captureRequest,
        () => thisRun === run,
        showStatus,
      );
      if (!finished) return;

      if (finished.status === "failed") {
        status.textContent = `Build failed: ${finished.error ?? "unknown error"}`;
        return;
      }

      status.textContent = PREPARING_STATUS;
      const scene = await loadScene(finished.bundle_url!);
      if (thisRun === run) {
        await enterScene(scene, { time: null, entry: "push" }, thisRun);
        enteredScene = true;
      }
    } catch (error) {
      if (thisRun !== run) return;

      status.textContent = error instanceof ApiError
        ? `Error ${error.status}: ${error.message}`
        : `Error: ${(error as Error).message}`;
    } finally {
      if (thisRun === run && !enteredScene) {
        build.disabled = false;
        status.classList.remove("busy");
      }
    }
  }

  function captureRequest(): SceneRequest {
    const body: SceneRequest = {
      area: { type: "boundary", id: area!.id },
      layers: selectedLayerIds(),
    };

    if (usesMonths()) Object.assign(body, { start: start.value, end: end.value });

    return body;
  }

  // The scene draws its own outline, and reports its progress and failures back through the status.
  async function enterScene(scene: Scene, options: EnterOptions, thisRun: number) {
    const ready = typeof sceneMode === "function" ? await sceneMode() : sceneMode;
    if (thisRun !== run) return;
    areaSearch.clearOutline();
    ready.enter(scene, {
      ...options,
      buildPanel: {
        showStatus,
        setBusy,
        setInert: (isInert) => (root.inert = isInert),
      },
    });
  }
}

function createControls(root: HTMLElement) {
  const { search, level, results } = createSearchControls(root);
  const chosen = makeHtmlElement("div", NO_AREA_TEXT, root);
  chosen.className = "chosen";

  const layerBox = makeHtmlElement("fieldset", "", root);
  makeHtmlElement("legend", "Layers", layerBox);

  const { start, end } = createMonthInputs(root);
  const build = makeHtmlElement("button", "Build scene", root);
  const status = makeHtmlElement("div", "", root);
  status.className = "status";

  return { search, level, results, chosen, layerBox, start, end, build, status };
}

function createMonthInputs(root: HTMLElement) {
  const months = makeHtmlElement("div", "", root);
  months.className = "months";
  const start = createMonthSelect("From month", "From year");
  const end = createMonthSelect("To month", "To year");
  months.append("From ", start, " to ", end);

  return { start, end };
}
