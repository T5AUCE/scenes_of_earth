import "./style.css";
import { getHealth, isSceneId } from "./api";
import { createMap, reportMapErrors } from "./map";
import { createPanel } from "./panel";
import { createSceneMode, type SceneEntry } from "./scene-mode";
import { routeFor } from "./scene-url";

const map = createMap("map");
const mapLoaded = new Promise<void>((resolve) => map.once("load", () => resolve()));
const sceneMode = createSceneMode(map, {
  column: document.getElementById("scene-column")!,
  timeBar: document.getElementById("time-bar")!,
  dialog: document.getElementById("scene-full") as HTMLDialogElement,
});
const panel = createPanel(document.getElementById("panel")!, map, sceneMode);
const badge = document.getElementById("status")!;

reportMapErrors(map, (message) => showBadge(`Map error: ${message}`, "down"));
openSharedScene("replace");
window.addEventListener("popstate", followHistory);
showBackendStatus();

// ?scene= comes from the address bar, so it is checked before it reaches a request.
function openSharedScene(entry: SceneEntry) {
  const route = routeFor(location.search, history.state);
  if (route.kind === "world") return;

  Promise.all([panel, mapLoaded])
    .then(([ready]) => {
      if (isSceneId(route.id)) return ready.openScene(route.id, { time: route.time, entry });

      ready.showStatus("The scene id in the address is not valid.");
    })
    .catch((error) => showBadge(`Cannot open the scene: ${error.message}`, "down"));
}

// Back and Forward only move between entries; the address says where the page now is.
function followHistory() {
  const route = routeFor(location.search, history.state);
  if (route.kind === "world") return sceneMode.exit();
  if (route.id === sceneMode.sceneId()) return sceneMode.showFullscreen(route.panel);

  openSharedScene("keep");
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
