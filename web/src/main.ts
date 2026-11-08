import "./style.css";
import { getHealth, isSceneId } from "./api";
import { createMap, reportMapErrors } from "./map";
import { createPanel } from "./panel";
import type { createSceneMode, SceneEntry } from "./scene-mode";
import { routeFor } from "./scene-url";

const map = createMap("map");
const mapLoaded = new Promise<void>((resolve) => map.once("load", () => resolve()));
let sceneMode: ReturnType<typeof createSceneMode> | null = null;
let sceneModeReady: Promise<ReturnType<typeof createSceneMode>> | null = null;
let navigation = 0;
let cancelOpen = () => {};
const panel = createPanel(document.getElementById("panel")!, map, loadSceneMode).then((ready) => {
  cancelOpen = ready.cancelOpen;

  return ready;
});
const badge = document.getElementById("status")!;

reportMapErrors(map, (message) => showBadge(`Map error: ${message}`, "down"));
openSharedScene("replace");
window.addEventListener("popstate", followHistory);
showBackendStatus();
maybeShowDevStats();

// ?scene= comes from the address bar, so it is checked before it reaches a request.
function openSharedScene(entry: SceneEntry) {
  const thisNavigation = ++navigation;
  const route = routeFor(location.search, history.state);
  if (route.kind === "world") return;

  Promise.all([panel, mapLoaded])
    .then(([ready]) => {
      if (thisNavigation !== navigation) return;
      if (isSceneId(route.id)) {
        const { time, display } = route;
        return ready.openScene(route.id, { time, entry, display });
      }

      ready.showStatus("The scene id in the address is not valid.");
    })
    .catch((error) => {
      if (thisNavigation === navigation) {
        showBadge(`Cannot open the scene: ${error.message}`, "down");
      }
    });
}

// Back and Forward only move between entries; the address says where the page now is.
function followHistory() {
  navigation++;
  cancelOpen();
  const route = routeFor(location.search, history.state);
  if (route.kind === "world") return sceneMode?.exit();
  if (route.id === sceneMode?.sceneId()) return sceneMode.showFullscreen(route.panel);

  openSharedScene("keep");
}

function loadSceneMode(): Promise<ReturnType<typeof createSceneMode>> {
  sceneModeReady ??= import("./scene-mode").then(({ createSceneMode }) => {
    sceneMode = createSceneMode(map, {
      column: document.getElementById("scene-column")!,
      timeBar: document.getElementById("time-bar")!,
      dialog: document.getElementById("scene-full") as HTMLDialogElement,
    });

    return sceneMode;
  });
  sceneModeReady.catch(() => {
    sceneModeReady = null;
  });
  return sceneModeReady;
}

function showBackendStatus() {
  getHealth().then(
    (health) => showBadge(`backend ok (v${health.version})`, "ok"),
    () => showBadge("backend unreachable", "down"),
  );
}

function showBadge(text: string, state: "ok" | "down") {
  badge.textContent = text;
  badge.classList.remove("ok", "down");
  badge.classList.add(state);
}

// The gate lives in the dev chunk because only a module can read import.meta.env.
function maybeShowDevStats() {
  void import("./dev-stats")
    .then(({ startDevStatsWhenEnabled }) => {
      startDevStatsWhenEnabled(document.getElementById("dev-stats"), map);
    })
    .catch(() => undefined);
}
