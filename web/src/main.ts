import "./style.css";
import { getHealth, isSceneId } from "./api";
import { createMap, reportMapErrors } from "./map";
import { createPanel } from "./panel";

const map = createMap("map");
const mapLoaded = new Promise<void>((resolve) => map.once("load", () => resolve()));
const panel = createPanel(document.getElementById("panel")!, map);
const badge = document.getElementById("status")!;

reportMapErrors(map, (message) => showBadge(`Map error: ${message}`, "down"));
openSharedScene();
showBackendStatus();

// ?scene= comes from the address bar, so it is checked before it reaches a request.
function openSharedScene() {
  const sceneId = new URLSearchParams(location.search).get("scene");
  if (!sceneId) return;

  Promise.all([panel, mapLoaded])
    .then(([ready]) => {
      if (isSceneId(sceneId)) return ready.openScene(sceneId);

      ready.showStatus("The scene id in the address is not valid.");
    })
    .catch((error) => showBadge(`Cannot open the scene: ${error.message}`, "down"));
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
