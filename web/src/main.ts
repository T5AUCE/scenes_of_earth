import "./style.css";
import { getHealth } from "./api";
import { createMap } from "./map";
import { createPanel } from "./panel";

const map = createMap("map");
const mapLoaded = new Promise<void>((resolve) => map.once("load", () => resolve()));
const panel = createPanel(document.getElementById("panel")!, map);

const sharedScene = new URLSearchParams(location.search).get("scene");
if (sharedScene) {
  Promise.all([panel, mapLoaded]).then(([ready]) => ready.openScene(sharedScene));
}

const badge = document.getElementById("status")!;
getHealth().then(
  (h) => {
    badge.textContent = `backend ok (v${h.version})`;
    badge.classList.add("ok");
  },
  () => {
    badge.textContent = "backend unreachable";
    badge.classList.add("down");
  },
);
