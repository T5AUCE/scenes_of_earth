import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import React from "react";
import { createSceneStore } from "./src/scene-store.ts";
import { draftForEdit } from "./src/charts/chart-editor.tsx";
test("probe dist steps", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  const names = ["Node","Element","HTMLElement","HTMLDivElement","HTMLSelectElement","HTMLInputElement","SVGElement","DocumentFragment","Event","CustomEvent","MouseEvent","KeyboardEvent"] as const;
  for (const name of names) Object.defineProperty(globalThis, name, { value: (window as any)[name], configurable: true, writable: true });
  Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: window.localStorage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true, writable: true });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChartEditor } = await import("./src/charts/chart-editor.tsx");
  const layers: any[] = [{
    id: "terrain", title: "Terrain", units: "m",
    style: { kind: "terrain", encodings: ["shade"] },
    grid: { bbox: [0,-1,1,1], res: 0.01, nx: 10, ny: 10 },
    time: null,
    distribution: { statistic: "quantiles", weights: "cell_area_inside_outline", percent: 1, values: Array.from({length:101},(_,i)=>i*10), min: 0, max: 1000, mean: 500, valid_fraction: 0.9, reference_values: [{id:"sea_level",value:0}] },
  }];
  const store = createSceneStore(layers, { layers: {}, off: new Set(), showAs: {} });
  const def = store.getSnapshot().charts.definitions[0];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ChartEditor as any, { scene: {id:"test",title:"Test",layers}, store, initial: draftForEdit(def as any), isNew: false, currentTime: null, onSave: ()=>{}, onCancel: ()=>{} }));
  });
  console.log("step1 refs", !!host.querySelector(".chart-references"));
  const label = [...host.querySelectorAll("label")].find((e) => (e.textContent ?? "").includes("Series ink"));
  console.log("label", !!label);
  const sel = label?.querySelector("select") as HTMLSelectElement;
  console.log("sel", sel?.value, sel?.innerHTML?.slice(0,100));
  await act(async () => {
    const native = Object.getOwnPropertyDescriptor((window as any).HTMLSelectElement.prototype, "value");
    native?.set?.call(sel, "deep-red");
    sel.dispatchEvent(new (window as any).Event("change", { bubbles: true }));
  });
  console.log("after ink", host.querySelector("polygon")?.getAttribute("stroke"));
  const refLabel = [...host.querySelectorAll("label")].find((e) => (e.textContent ?? "").includes("Reference lines"));
  console.log("refLabel", !!refLabel);
  const box = refLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement;
  console.log("box", box?.checked);
  await act(async () => { box.click(); });
  console.log("after toggle refs", !!host.querySelector(".chart-references"));
  await act(async () => { root.unmount(); });
  console.log("done");
});
