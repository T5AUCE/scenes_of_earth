import "./style.css";
import { getHealth } from "./api";
import { createMap } from "./map";
import { createPanel } from "./panel";

const map = createMap("map");
createPanel(document.getElementById("panel")!, map);

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
