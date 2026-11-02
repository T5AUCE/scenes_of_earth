import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import type { DistributionTable, TimeSeriesTable } from "./table.ts";

test("line, bar and area share rows without mutating them", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  for (const chartType of ["line", "bar", "area"] as const) {
    const table = timeTable();
    const before = JSON.stringify(table.rows);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<SvgChart table={table} chartType={chartType} />);
    });
    assert.equal(JSON.stringify(table.rows), before);
    const svg = host.querySelector("svg")!;
    if (chartType === "line") assert.ok(svg.querySelector("polyline"));
    if (chartType === "bar") assert.ok(svg.querySelector("rect"));
    if (chartType === "area") assert.ok(svg.querySelector("polygon"));
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});

test("dense bars never switch type on their own", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const table = timeTable();
  table.rows = Array.from({ length: 61 }, (_, index) => ({
    x: Date.parse("2019-01-01") + index * 30 * 24 * 60 * 60 * 1000,
    value: 10 + index,
    label: `2019-${String(index + 1).padStart(2, "0")}-01`,
    validFraction: 1,
    fallbackFraction: null,
    interval: { start: "2019-01-01", end: "2019-02-01" },
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="bar" />);
  });
  assert.equal(host.querySelectorAll("rect").length, 61);
  assert.equal(host.querySelector("polyline"), null);
  await act(async () => {
    root.unmount();
  });
});

test("null gaps break lines while zero and single values stay visible", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={timeTable()} chartType="line" />);
  });
  assert.equal(host.querySelectorAll("polyline").length, 2);
  assert.equal(host.querySelectorAll("rect").length, 0);
  await act(async () => {
    root.unmount();
  });

  const bars = document.createElement("div");
  document.body.append(bars);
  const barRoot = createRoot(bars);
  await act(async () => {
    barRoot.render(<SvgChart table={timeTable()} chartType="bar" />);
  });
  assert.equal(bars.querySelectorAll("rect").length, 3);
  await act(async () => {
    barRoot.unmount();
  });

  const single = document.createElement("div");
  document.body.append(single);
  const singleRoot = createRoot(single);
  const one: TimeSeriesTable = {
    ...timeTable(),
    rows: [{ ...timeTable().rows[0] }],
  };
  await act(async () => {
    singleRoot.render(<SvgChart table={one} chartType="line" />);
  });
  const circle = single.querySelector("circle")!;
  assert.equal(circle.getAttribute("r"), "4");
  await act(async () => {
    singleRoot.unmount();
  });
});

test("tables and tooltips keep full precision and arrows move the cursor", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const table = timeTable();
  const precise = String(table.rows[0].value);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="line" />);
  });
  const cells = [...host.querySelectorAll("td")].map((cell) => cell.textContent);
  assert.ok(cells.includes(precise));
  const tooltip = host.querySelector(".chart-tooltip")!;
  assert.ok((tooltip.textContent ?? "").includes("-3.75"));
  const svg = host.querySelector("svg")!;
  await act(async () => {
    svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  assert.match(tooltip.textContent ?? "", /2015-01-01/);
  assert.ok((tooltip.textContent ?? "").includes(precise));
  await act(async () => {
    svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  });
  assert.match(tooltip.textContent ?? "", /2015-04-01/);
  assert.ok((tooltip.textContent ?? "").includes("-3.75"));
  await act(async () => {
    root.unmount();
  });
});

test("low coverage draws hollow marks with credited fallback shares", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart table={timeTable()} chartType="bar" fallbackNames="ERA5" showPoints={true} />,
    );
  });
  const hollow = [...host.querySelectorAll("rect")].filter(
    (rect) => rect.getAttribute("fill") === "none",
  );
  assert.ok(hollow.length >= 1);
  const tooltip = host.querySelector(".chart-tooltip")!;
  await act(async () => {
    const svg = host.querySelector("svg")!;
    svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  });
  assert.match(tooltip.textContent ?? "", /valid/);
  assert.match(tooltip.textContent ?? "", /ERA5/);
  await act(async () => {
    root.unmount();
  });
});

test("hypsometry uses above-percent direction with exact references", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart
        table={distributionTable()}
        chartType="area"
        showReferences={true}
        resolutionNote="0.01° analysis grid"
      />,
    );
  });
  assert.match(host.textContent ?? "", /Mean 500\.123456789/);
  assert.match(host.textContent ?? "", /Median 400\.987654321/);
  assert.match(host.textContent ?? "", /Lowest cell/);
  assert.match(host.textContent ?? "", /Highest cell/);
  assert.match(host.textContent ?? "", /0\.01° analysis grid/);
  assert.match(host.textContent ?? "", /Sea level/);
  assert.match(host.textContent ?? "", /Share of valid area below/);
  const circles = [...host.querySelectorAll("circle")];
  assert.ok(circles.length >= 2);
  await act(async () => {
    root.unmount();
  });

  const bare = distributionTable();
  bare.referenceValues = [];
  const second = document.createElement("div");
  document.body.append(second);
  const secondRoot = createRoot(second);
  await act(async () => {
    secondRoot.render(<SvgChart table={bare} chartType="line" />);
  });
  assert.equal((second.textContent ?? "").includes("Sea level"), false);
  await act(async () => {
    secondRoot.unmount();
  });
});

test("responsive width follows the observer and compact simplifies", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  let notify: ((width: number) => void) | null = null;
  class TestObserver {
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
      notify = (width: number) => callback([{ contentRect: { width } }]);
    }

    observe() {}

    disconnect() {}
  }
  const previous = (globalThis as Record<string, unknown>).ResizeObserver;
  (globalThis as Record<string, unknown>).ResizeObserver = TestObserver;
  context.after(() => {
    (globalThis as Record<string, unknown>).ResizeObserver = previous;
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={timeTable()} chartType="bar" compact={true} />);
  });
  assert.equal(host.querySelector("svg")?.getAttribute("height"), "36");
  assert.equal(host.querySelector("details"), null);
  assert.ok(host.querySelector("polyline"));
  assert.equal(host.querySelector("rect"), null);
  await act(async () => {
    notify?.(500);
  });
  assert.equal(host.querySelector("svg")?.getAttribute("width"), "500");
  await act(async () => {
    root.unmount();
  });
});

test("selected ink and axis titles follow display units", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");
  const { toDisplayTable } = await import("./table.ts");

  const display = toDisplayTable(timeTable(), "in/month") as TimeSeriesTable;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={display} chartType="line" ink="#ff0000" />);
  });
  assert.match(host.innerHTML, /#ff0000/);
  assert.match(host.textContent ?? "", /Rain \(in\/month\)/);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("custom x titles reach axes while headings stay independent", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SeriesChart } = await import("./series-chart.tsx");
  const { HypsometryChart } = await import("./hypsometry-chart.tsx");
  const rain = wrapperRain();
  const terrain = wrapperTerrain();

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SeriesChart
        layer={rain}
        shape="time_series"
        chartType="line"
        options={{ xTitle: "CUSTOM X" }}
      />,
    );
  });
  assert.match(host.querySelector("figcaption")?.textContent ?? "", /Rain/);
  assert.equal((host.querySelector("figcaption")?.textContent ?? "").includes("CUSTOM X"), false);
  const axis = [...host.querySelectorAll(".chart-axes text")].map((node) => node.textContent);
  assert.ok(axis.includes("CUSTOM X"));
  await act(async () => {
    root.unmount();
  });

  const second = document.createElement("div");
  document.body.append(second);
  const secondRoot = createRoot(second);
  await act(async () => {
    secondRoot.render(
      <HypsometryChart layer={terrain} chartType="area" options={{ xTitle: "CUSTOM DIST X" }} />,
    );
  });
  assert.match(second.querySelector("figcaption")?.textContent ?? "", /Terrain/);
  assert.equal((second.textContent ?? "").includes("CUSTOM DIST X"), true);
  const axes = [...second.querySelectorAll(".chart-axes text")].map((node) => node.textContent);
  assert.ok(axes.includes("CUSTOM DIST X"));
  await act(async () => {
    secondRoot.unmount();
  });
  host.remove();
  second.remove();
});

test("grid toggles only strokes while axes stay readable", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={timeTable()} chartType="line" showGrid={false} />);
  });
  assert.equal(host.querySelector(".chart-grid"), null);
  assert.ok(host.querySelector(".chart-y-ticks"));
  assert.ok(host.querySelector(".chart-x-ticks"));
  assert.ok(host.querySelector(".chart-axes"));
  const yTexts = [...host.querySelectorAll(".chart-y-ticks text")].map((node) => node.textContent);
  assert.ok(yTexts.length >= 2);
  const xTexts = [...host.querySelectorAll(".chart-x-ticks text")].map((node) => node.textContent);
  assert.ok(xTexts.some((text) => (text ?? "").includes("2015")));
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("isolated points around nulls stay visible including zero and negative", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  for (const values of [[1, null, 2], [0, null, 2], [-5, null, 5]]) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const table = gapTable(values as (number | null)[]);
    await act(async () => {
      root.render(<SvgChart table={table} chartType="line" />);
    });
    assert.equal(host.querySelectorAll("circle").length, 2);
    await act(async () => {
      root.unmount();
    });
    host.remove();

    const areaHost = document.createElement("div");
    document.body.append(areaHost);
    const areaRoot = createRoot(areaHost);
    await act(async () => {
      areaRoot.render(<SvgChart table={table} chartType="area" />);
    });
    assert.equal(areaHost.querySelectorAll("circle").length, 2);
    await act(async () => {
      areaRoot.unmount();
    });
    areaHost.remove();
  }
});

test("all-null keeps shell table and inspection", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const table = gapTable([null, null]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="line" />);
  });
  assert.ok(host.querySelector("details"));
  assert.match(host.textContent ?? "", /No data to draw/);
  assert.match(host.textContent ?? "", /No data in this table/);
  const rows = [...host.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 2);
  const svg = host.querySelector("svg")!;
  await act(async () => {
    svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  assert.match(host.querySelector(".chart-tooltip")?.textContent ?? "", /No data/);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("missing current intervals never show future values", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart table={gapTable([10, 20, 30])} chartType="line" currentTime="2018-12-01" />,
    );
  });
  assert.match(host.querySelector(".chart-tooltip")?.textContent ?? "", /No observation/);
  await act(async () => {
    root.unmount();
  });

  const compactHost = document.createElement("div");
  document.body.append(compactHost);
  const compactRoot = createRoot(compactHost);
  await act(async () => {
    compactRoot.render(
      <SvgChart
        table={gapTable([10, 20, 30])}
        chartType="line"
        currentTime="2018-12-01"
        compact={true}
      />,
    );
  });
  assert.match(compactHost.querySelector(".chart-tooltip")?.textContent ?? "", /No observation/);
  await act(async () => {
    compactRoot.unmount();
  });
  host.remove();
  compactHost.remove();
});

test("inspection stays separate from current marker and clamps on rerender", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart table={gapTable([10, 20, 30])} chartType="line" currentTime="2019-01-01" />,
    );
  });
  const svg = host.querySelector("svg")!;
  await act(async () => {
    svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  });
  assert.match(host.querySelector(".chart-tooltip")?.textContent ?? "", /Inspection/);
  await act(async () => {
    root.render(
      <SvgChart table={gapTable([10, 20, 30])} chartType="line" currentTime="2019-02-01" />,
    );
  });
  assert.match(host.querySelector(".chart-cursor title")?.textContent ?? "", /Current 2019-02-01/);
  assert.match(host.querySelector(".chart-tooltip")?.textContent ?? "", /Inspection/);
  await act(async () => {
    root.render(<SvgChart table={gapTable([10])} chartType="line" currentTime="2019-01-01" />);
  });
  assert.ok(host.querySelector(".chart-tooltip"));
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("offset ranges use converted zero without expansion", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SeriesChart } = await import("./series-chart.tsx");
  const rain = wrapperRain();
  rain.units = "°C";
  rain.time = { ...rain.time, method: "mean" };
  rain.area_series = { ...rain.area_series, values: rain.area_series.values.map(() => 20) };

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SeriesChart
        layer={rain}
        shape="time_series"
        chartType="bar"
        options={{ displayUnit: "°F", yRange: [0, 30] }}
      />,
    );
  });
  const ticks = [...host.querySelectorAll(".chart-y-ticks text")].map((node) => node.textContent);
  assert.ok(ticks.includes("32"));
  assert.ok(ticks.includes("86"));
  assert.equal(ticks.includes("0"), false);
  const rect = host.querySelector("rect")!;
  const y = Number(rect.getAttribute("y"));
  const height = Number(rect.getAttribute("height"));
  assert.ok(Number.isFinite(y));
  assert.ok(height >= 1);
  const top_PX = 20;
  const bottomMargin_PX = 32;
  const height_PX = 140;
  const plotBottom_PX = top_PX + (height_PX - top_PX - bottomMargin_PX);
  assert.equal(y + height, plotBottom_PX);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("seasonal counts years with exact distribution summaries", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SeriesChart } = await import("./series-chart.tsx");
  const { HypsometryChart } = await import("./hypsometry-chart.tsx");
  const rain = wrapperRain();

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SeriesChart layer={rain} shape="seasonal_cycle" chartType="line" options={{}} />);
  });
  const headers = [...host.querySelectorAll("thead th")].map((node) => node.textContent);
  assert.ok(headers.includes("Sample count"));
  assert.ok(headers.includes("Year range"));
  assert.match(host.textContent ?? "", /Sample count.*contributed/);
  const tooltip = host.querySelector(".chart-tooltip")?.textContent ?? "";
  await act(async () => {
    host.querySelector("svg")!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  assert.match(host.querySelector(".chart-tooltip")?.textContent ?? "", /years/);
  assert.ok((host.querySelector(".chart-tooltip")?.textContent ?? "").length >= tooltip.length);
  await act(async () => {
    root.unmount();
  });

  const terrainHost = document.createElement("div");
  document.body.append(terrainHost);
  const terrainRoot = createRoot(terrainHost);
  await act(async () => {
    terrainRoot.render(
      <HypsometryChart layer={wrapperTerrain()} chartType="area" options={{}} />,
    );
  });
  assert.match(terrainHost.textContent ?? "", /Mean 500/);
  assert.match(terrainHost.textContent ?? "", /Median/);
  assert.match(terrainHost.textContent ?? "", /lowest cell 0/);
  assert.match(terrainHost.textContent ?? "", /highest cell 1000/);
  assert.match(terrainHost.textContent ?? "", /1%.*approximate|approximate.*1%/);
  await act(async () => {
    terrainRoot.unmount();
  });
  host.remove();
  terrainHost.remove();
});

test("constant references stagger bounded with inward endpoints", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const terrain = {
    shape: "distribution",
    layerId: "terrain",
    units: "m",
    rows: Array.from(
      { length: 101 },
      (_, index) => ({
        x: index,
        value: 0,
        label: `${index}%`,
        validFraction: 0.9,
        fallbackFraction: null,
      }),
    ),
    xTitle: "Share",
    yTitle: "Elevation (m)",
    validFraction: 0.9,
    mean: 0,
    median: 0,
    min: 0,
    max: 0,
    referenceValues: [{ id: "sea_level", value: 0 }],
  } as DistributionTable;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart table={terrain} chartType="line" resolutionNote="0.012345678901234567° grid" />,
    );
  });
  const labels = [...host.querySelectorAll(".chart-references text")].map((node) => ({
    text: node.textContent,
    x: Number(node.getAttribute("x")),
    y: Number(node.getAttribute("y")),
    anchor: node.getAttribute("text-anchor"),
  }));
  assert.equal(labels.length, 5);
  const positions = labels.map((entry) => entry.y);
  assert.equal(new Set(positions).size, positions.length);
  for (const entry of labels) {
    assert.ok(entry.y >= 12);
    assert.ok(entry.y <= 176);
  }
  for (let first = 0; first < positions.length; first++) {
    for (let second = first + 1; second < positions.length; second++) {
      assert.ok(Math.abs(positions[first] - positions[second]) >= 12);
    }
  }
  const endpoints = [...host.querySelectorAll(".chart-endpoints text")];
  assert.equal(endpoints[0]?.getAttribute("text-anchor"), "end");
  assert.equal(endpoints[1]?.getAttribute("text-anchor"), "start");
  await act(async () => {
    root.unmount();
  });
  host.remove();

  const bottomHost = document.createElement("div");
  document.body.append(bottomHost);
  const bottomRoot = createRoot(bottomHost);
  const concentrated = {
    shape: "distribution",
    layerId: "terrain",
    units: "m",
    rows: Array.from(
      { length: 101 },
      (_, index) => ({
        x: index,
        value: index === 100 ? 1000 : 0,
        label: `${index}%`,
        validFraction: 0.9,
        fallbackFraction: null,
      }),
    ),
    xTitle: "Share",
    yTitle: "Elevation (m)",
    validFraction: 0.9,
    mean: 1,
    median: 0,
    min: 0,
    max: 1000,
    referenceValues: [{ id: "sea_level", value: 0 }],
  } as DistributionTable;
  await act(async () => {
    bottomRoot.render(<SvgChart table={concentrated} chartType="line" />);
  });
  const bottomLabels = [...bottomHost.querySelectorAll(".chart-references text")].map((node) => ({
    text: node.textContent,
    x: Number(node.getAttribute("x")),
    y: Number(node.getAttribute("y")),
    anchor: node.getAttribute("text-anchor"),
  }));
  assert.equal(bottomLabels.length, 5);
  const bottomPositions = bottomLabels.map((entry) => entry.y);
  assert.equal(new Set(bottomPositions).size, bottomPositions.length);
  for (const entry of bottomLabels) {
    assert.ok(entry.y >= 12);
    assert.ok(entry.y <= 176);
  }
  for (let first = 0; first < bottomPositions.length; first++) {
    for (let second = first + 1; second < bottomPositions.length; second++) {
      assert.ok(Math.abs(bottomPositions[first] - bottomPositions[second]) >= 12);
    }
  }
  const seaLabel = bottomLabels.find((entry) => entry.text === "Sea level 0")!;
  const lowLabel = bottomLabels.find((entry) => (entry.text ?? "").startsWith("Lowest cell"))!;
  assert.equal(seaLabel.x, lowLabel.x);
  assert.equal(seaLabel.anchor, lowLabel.anchor);
  assert.ok(Math.abs(seaLabel.y - lowLabel.y) >= 12);
  await act(async () => {
    bottomRoot.unmount();
  });
  bottomHost.remove();
});

test("hypsometry direction and bar baseline use exact coordinates", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={distributionTable()} chartType="line" />);
  });
  const points = [...host.querySelectorAll(".chart-points circle")];
  const xs = points.map((node) => Number(node.getAttribute("cx")));
  assert.ok(xs[0] > xs[xs.length - 1]);
  assert.equal(xs[0], 296);
  assert.equal(xs[1], 172);
  assert.equal(xs[2], 48);
  const low = 0;
  const high = 1000.987654321;
  const plotTop_PX = 20;
  const plotHeight_PX = 180 - 20 - 32;
  const span = high - low;
  const yOf = (value: number) => plotTop_PX + (plotHeight_PX * (high - value)) / span;
  const lines = [...host.querySelectorAll(".chart-references line")];
  assert.equal(lines.length, 3);
  assert.equal(Number(lines[0].getAttribute("y1")), yOf(500.123456789));
  assert.equal(Number(lines[1].getAttribute("y1")), yOf(400.987654321));
  assert.equal(Number(lines[2].getAttribute("y1")), yOf(0));
  const endpointCircles = [...host.querySelectorAll(".chart-endpoints circle")];
  assert.equal(Number(endpointCircles[0].getAttribute("cy")), yOf(0.123456789));
  assert.equal(Number(endpointCircles[1].getAttribute("cy")), yOf(1000.987654321));
  const annotationTexts = [...host.querySelectorAll(".chart-references text")];
  const annotationY = annotationTexts.map((node) => Number(node.getAttribute("y")));
  assert.equal(new Set(annotationY).size, annotationY.length);
  await act(async () => {
    root.unmount();
  });

  const barHost = document.createElement("div");
  document.body.append(barHost);
  const barRoot = createRoot(barHost);
  await act(async () => {
    barRoot.render(<SvgChart table={timeTable()} chartType="bar" baseline={0} />);
  });
  const rects = [...barHost.querySelectorAll("rect")];
  assert.equal(rects.length, 3);
  const seriesLow = -3.75;
  const seriesHigh = 10.123456789012345;
  const seriesTop_PX = 20;
  const seriesHeight_PX = 140 - 20 - 32;
  const seriesSpan = seriesHigh - seriesLow;
  const seriesYOf = (value: number) => seriesTop_PX
    + (seriesHeight_PX * (seriesHigh - value)) / seriesSpan;
  const baseY = seriesYOf(0);
  assert.equal(Number(rects[0].getAttribute("y")), seriesYOf(10.123456789012345));
  assert.equal(Number(rects[0].getAttribute("height")), baseY - seriesYOf(10.123456789012345));
  assert.equal(Number(rects[1].getAttribute("y")), baseY);
  assert.equal(Number(rects[1].getAttribute("height")), 1);
  assert.equal(Number(rects[2].getAttribute("y")), baseY);
  assert.equal(Number(rects[2].getAttribute("height")), seriesYOf(-3.75) - baseY);
  await act(async () => {
    barRoot.unmount();
  });

  const areaHost = document.createElement("div");
  document.body.append(areaHost);
  const areaRoot = createRoot(areaHost);
  await act(async () => {
    areaRoot.render(<SvgChart table={timeTable()} chartType="area" baseline={-3.75} />);
  });
  const polygon = areaHost.querySelector("polygon")!;
  const corners = polygon.getAttribute("points")!.trim().split(/\s+/);
  const firstCorner = corners[0].split(",").map(Number);
  const lastCorner = corners[corners.length - 1].split(",").map(Number);
  assert.equal(firstCorner[1], seriesYOf(-3.75));
  assert.equal(lastCorner[1], seriesYOf(-3.75));
  await act(async () => {
    areaRoot.unmount();
  });
  host.remove();
  barHost.remove();
  areaHost.remove();
});

test("one frozen table renders identical rows across all three types", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const frozen = timeTable();
  const before = JSON.stringify(frozen);
  for (const row of frozen.rows) {
    Object.freeze(row.interval);
    Object.freeze(row);
  }
  Object.freeze(frozen.rows);
  Object.freeze(frozen);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const seen: string[] = [];
  for (const chartType of ["line", "bar", "area"] as const) {
    await act(async () => {
      root.render(<SvgChart table={frozen} chartType={chartType} />);
    });
    const rows = [...host.querySelectorAll("tbody tr")].map((row) => row.innerHTML);
    const tooltip = host.querySelector(".chart-tooltip")?.textContent ?? "";
    seen.push(`${rows.join("|")}##${tooltip}`);
  }
  assert.deepEqual(seen[0], seen[1]);
  assert.deepEqual(seen[1], seen[2]);
  assert.equal(JSON.stringify(frozen), before);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("negative area closes at its minimum with converted baselines", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SeriesChart } = await import("./series-chart.tsx");
  const { HypsometryChart } = await import("./hypsometry-chart.tsx");
  const { validateDefinition } = await import("./definitions.ts");

  const negative = wrapperRain();
  negative.area_series = {
    ...negative.area_series,
    values: negative.area_series.values.map((_, index) => (index % 2 === 0 ? -10 : -5)),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SeriesChart layer={negative} shape="time_series" chartType="area" options={{}} />);
  });
  const automatic = host.querySelector("polygon")!.getAttribute("points")!.trim().split(/\s+/);
  const automaticY = automatic.map((corner) => Number(corner.split(",")[1]));
  assert.equal(automaticY[0], automaticY[automaticY.length - 1]);
  assert.equal(automaticY[0], Math.max(...automaticY));
  assert.equal(automaticY[0], 108);
  assert.ok(automaticY.every((value) => value >= 20 && value <= 108));
  assert.equal(automaticY[1], 108);
  assert.equal(automaticY[2], 20);
  assert.ok(automaticY.slice(1, -1).includes(108));
  assert.ok(automaticY.slice(1, -1).includes(20));
  const automaticTicks = [...host.querySelectorAll(".chart-y-ticks text")].map(
    (node) => node.textContent,
  );
  assert.ok(automaticTicks.includes("-10"));
  assert.ok(automaticTicks.includes("-5"));
  assert.equal(automaticTicks.includes("0"), false);
  await act(async () => {
    root.unmount();
  });

  const explicitHost = document.createElement("div");
  document.body.append(explicitHost);
  const explicitRoot = createRoot(explicitHost);
  await act(async () => {
    explicitRoot.render(
      <SeriesChart
        layer={negative}
        shape="time_series"
        chartType="area"
        options={{ yRange: [-10, -5] }}
      />,
    );
  });
  const explicit = explicitHost.querySelector("polygon")!.getAttribute("points")!.trim().split(
    /\s+/,
  );
  const explicitY = explicit.map((corner) => Number(corner.split(",")[1]));
  assert.equal(explicitY[0], explicitY[explicitY.length - 1]);
  assert.equal(explicitY[0], Math.max(...explicitY));
  assert.equal(explicitY[0], 108);
  assert.ok(explicitY.every((value) => value >= 20 && value <= 108));
  assert.equal(explicitY[1], 108);
  assert.equal(explicitY[2], 20);
  const explicitTicks = [...explicitHost.querySelectorAll(".chart-y-ticks text")].map(
    (node) => node.textContent,
  );
  assert.ok(explicitTicks.includes("-10"));
  assert.ok(explicitTicks.includes("-5"));
  await act(async () => {
    explicitRoot.unmount();
  });

  const cold = wrapperRain();
  cold.units = "°C";
  cold.title = "Temperature";
  cold.time = { ...cold.time, method: "mean" };
  cold.area_series = {
    ...cold.area_series,
    values: cold.area_series.values.map((_, index) => (index % 2 === 0 ? -10 : -5)),
  };
  assert.equal(
    validateDefinition(
      {
        id: "negative-area",
        title: "Negative",
        source: { layerId: cold.id, shape: "time_series" },
        chartType: "area",
        options: { yRange: [-10, -5] },
      },
      [cold],
    ),
    null,
  );
  const convertedHost = document.createElement("div");
  document.body.append(convertedHost);
  const convertedRoot = createRoot(convertedHost);
  await act(async () => {
    convertedRoot.render(
      <SeriesChart
        layer={cold}
        shape="time_series"
        chartType="area"
        options={{ displayUnit: "°F", yRange: [-10, -5] }}
      />,
    );
  });
  const convertedTicks = [...convertedHost.querySelectorAll(".chart-y-ticks text")].map(
    (node) => node.textContent,
  );
  assert.ok(convertedTicks.includes("14"));
  assert.ok(convertedTicks.includes("23"));
  assert.equal(convertedTicks.includes("32"), false);
  const converted = convertedHost.querySelector("polygon")!.getAttribute("points")!.trim().split(
    /\s+/,
  );
  const convertedY = converted.map((corner) => Number(corner.split(",")[1]));
  assert.equal(convertedY[0], convertedY[convertedY.length - 1]);
  assert.equal(convertedY[0], Math.max(...convertedY));
  assert.equal(convertedY[0], 108);
  assert.ok(convertedY.every((value) => value >= 20 && value <= 108));
  assert.equal(convertedY[1], 108);
  assert.equal(convertedY[2], 20);
  await act(async () => {
    convertedRoot.unmount();
  });

  const lowTerrain = wrapperTerrain();
  lowTerrain.distribution = {
    ...lowTerrain.distribution,
    values: Array.from(
      { length: 101 },
      (_, index) => (index % 2 === 0 ? -10 : -5),
    ),
    min: -10,
    max: -5,
    mean: -7.5,
    reference_values: [],
  };
  const terrainHost = document.createElement("div");
  document.body.append(terrainHost);
  const terrainRoot = createRoot(terrainHost);
  await act(async () => {
    terrainRoot.render(<HypsometryChart layer={lowTerrain} chartType="area" options={{}} />);
  });
  const terrainPoints = terrainHost.querySelector("polygon")!.getAttribute("points")!.trim().split(
    /\s+/,
  );
  const terrainY = terrainPoints.map((corner) => Number(corner.split(",")[1]));
  assert.equal(terrainY[0], terrainY[terrainY.length - 1]);
  assert.equal(terrainY[0], Math.max(...terrainY));
  assert.equal(terrainY[0], 148);
  assert.ok(terrainY.every((value) => value >= 20 && value <= 148));
  assert.equal(terrainY[1], 148);
  assert.ok(terrainY.slice(1, -1).includes(20));
  const terrainTicks = [...terrainHost.querySelectorAll(".chart-y-ticks text")].map(
    (node) => node.textContent,
  );
  assert.ok(terrainTicks.includes("-10"));
  assert.ok(terrainTicks.includes("-5"));
  await act(async () => {
    terrainRoot.unmount();
  });

  const explicitTerrainHost = document.createElement("div");
  document.body.append(explicitTerrainHost);
  const explicitTerrainRoot = createRoot(explicitTerrainHost);
  await act(async () => {
    explicitTerrainRoot.render(
      <HypsometryChart layer={lowTerrain} chartType="area" options={{ yRange: [-10, -5] }} />,
    );
  });
  const explicitTerrainPoints = explicitTerrainHost.querySelector("polygon")!.getAttribute(
    "points",
  )!.trim().split(/\s+/);
  const explicitTerrainY = explicitTerrainPoints.map((corner) => Number(corner.split(",")[1]));
  assert.equal(explicitTerrainY[0], explicitTerrainY[explicitTerrainY.length - 1]);
  assert.equal(explicitTerrainY[0], 148);
  assert.ok(explicitTerrainY.every((value) => value >= 20 && value <= 148));
  await act(async () => {
    explicitTerrainRoot.unmount();
  });

  const seasonalHost = document.createElement("div");
  document.body.append(seasonalHost);
  const seasonalRoot = createRoot(seasonalHost);
  await act(async () => {
    seasonalRoot.render(
      <SeriesChart layer={negative} shape="seasonal_cycle" chartType="area" options={{}} />,
    );
  });
  const seasonalPoints = seasonalHost.querySelector("polygon")!.getAttribute(
    "points",
  )!.trim().split(/\s+/);
  const seasonalY = seasonalPoints.map((corner) => Number(corner.split(",")[1]));
  assert.equal(seasonalY[0], seasonalY[seasonalY.length - 1]);
  assert.equal(seasonalY[0], 108);
  assert.ok(seasonalY.every((value) => value >= 20 && value <= 108));
  await act(async () => {
    seasonalRoot.unmount();
  });
  host.remove();
  explicitHost.remove();
  convertedHost.remove();
  terrainHost.remove();
  explicitTerrainHost.remove();
  seasonalHost.remove();
});

test("distribution table keeps below-percent rows against above-percent plot", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HypsometryChart } = await import("./hypsometry-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<HypsometryChart layer={wrapperTerrain()} chartType="area" options={{}} />);
  });
  const axis = host.querySelector(".chart-axes text")?.textContent ?? "";
  assert.match(axis, /at or above/);
  const header = host.querySelector("thead th")?.textContent ?? "";
  assert.match(header, /below/);
  assert.equal(header.includes("at or above"), false);
  const rows = [...host.querySelectorAll("tbody tr")];
  assert.equal(rows[0].querySelector("th")?.textContent, "0%");
  assert.equal(rows[rows.length - 1].querySelector("th")?.textContent, "100%");
  const polygon = host.querySelector("polygon")!;
  const corners = polygon.getAttribute("points")!.trim().split(/\s+/);
  const firstPoint = corners[0].split(",").map(Number);
  const lastPoint = corners[corners.length - 1].split(",").map(Number);
  assert.ok(firstPoint[0] > lastPoint[0]);
  const svg = host.querySelector("svg")!;
  await act(async () => {
    svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  assert.match(host.querySelector(".chart-tooltip")?.textContent ?? "", /below/);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("singleton time chart keeps unique ticks without key warnings", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const single: TimeSeriesTable = {
    ...timeTable(),
    rows: [{ ...timeTable().rows[0] }],
  };
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<SvgChart table={single} chartType="line" />);
    });
    await act(async () => {
      root.render(<SvgChart table={single} chartType="line" />);
    });
    const labels = [...host.querySelectorAll(".chart-x-ticks text")].map(
      (node) => node.textContent,
    );
    assert.equal(new Set(labels).size, labels.length);
    assert.ok(labels.length >= 1);
    const duplicates = errors.filter((args) => String(args[0]).includes("same key"));
    assert.equal(duplicates.length, 0);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  } finally {
    console.error = original;
  }
});

function gapTable(values: (number | null)[]): TimeSeriesTable {
  return {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: values.map((value, index) => ({
      x: Date.UTC(2019, index, 1),
      value,
      label: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
      validFraction: value === null ? 0 : 1,
      fallbackFraction: null,
      interval: {
        start: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(2019, index + 1, 1)).toISOString().slice(0, 10),
      },
    })),
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
}

function wrapperRain(): import("../types.ts").LayerDoc {
  const values = Array.from(
    { length: 30 },
    (_, index) => new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
  );
  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"], palette: "ink-blue" },
    time: { step: "P1M", values, end: "2021-07-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map((_, index) => index + 1),
      valid_fraction: values.map(() => 1),
    },
  } as unknown as import("../types.ts").LayerDoc;
}

function wrapperTerrain(): import("../types.ts").LayerDoc {
  return {
    id: "terrain",
    title: "Terrain",
    units: "m",
    style: { kind: "terrain", encodings: ["shade"] },
    grid: { bbox: [0, -1, 1, 1], res: 0.01, nx: 10, ny: 10 },
    time: null,
    distribution: {
      statistic: "quantiles",
      weights: "cell_area_inside_outline",
      percent: 1,
      values: Array.from({ length: 101 }, (_, index) => index * 10),
      min: 0,
      max: 1000,
      mean: 500,
      valid_fraction: 0.9,
      reference_values: [],
    },
  } as unknown as import("../types.ts").LayerDoc;
}

function timeTable(): TimeSeriesTable {
  return {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: [
      {
        x: Date.parse("2015-01-01"),
        value: 10.123456789012345,
        label: "2015-01-01",
        validFraction: 1,
        fallbackFraction: 0.2,
        interval: { start: "2015-01-01", end: "2015-02-01" },
      },
      {
        x: Date.parse("2015-02-01"),
        value: null,
        label: "2015-02-01",
        validFraction: 0,
        fallbackFraction: 0,
        interval: { start: "2015-02-01", end: "2015-03-01" },
      },
      {
        x: Date.parse("2015-03-01"),
        value: 0,
        label: "2015-03-01",
        validFraction: 0.5,
        fallbackFraction: 0,
        interval: { start: "2015-03-01", end: "2015-04-01" },
      },
      {
        x: Date.parse("2015-04-01"),
        value: -3.75,
        label: "2015-04-01",
        validFraction: 0.7,
        fallbackFraction: 0.1,
        interval: { start: "2015-04-01", end: "2015-05-01" },
      },
    ],
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
}

function distributionTable(): DistributionTable {
  return {
    shape: "distribution",
    layerId: "terrain",
    units: "m",
    rows: [
      { x: 0, value: 0.123456789, label: "0%", validFraction: 0.9, fallbackFraction: null },
      { x: 50, value: 500.123456789, label: "50%", validFraction: 0.9, fallbackFraction: null },
      { x: 100, value: 1000.987654321, label: "100%", validFraction: 0.9, fallbackFraction: null },
    ],
    xTitle: "Share of valid area below (%)",
    yTitle: "Elevation (m)",
    validFraction: 0.9,
    mean: 500.123456789,
    median: 400.987654321,
    min: 0.123456789,
    max: 1000.987654321,
    referenceValues: [{ id: "sea_level", value: 0 }],
  };
}

function installBrowser(window: Window): void {
  const names = [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "SVGElement",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
  ] as const;
  for (const name of names) defineGlobal(name, window[name]);
  defineGlobal("window", window);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
