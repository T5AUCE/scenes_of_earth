import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { assertSameNode } from "../testing/dom-assert.ts";
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
  assertSameNode(host.querySelector("polyline"), null);
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

test(
  "tables stay exact while tooltips use concise values and arrows move the cursor",
  async (context) => {
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
    assert.ok((tooltip.textContent ?? "").includes("10.123"));
    assert.equal((tooltip.textContent ?? "").includes(precise), false);
    assert.ok((tooltip.textContent ?? "").includes("valid 100%"));
    await act(async () => {
      svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    assert.match(tooltip.textContent ?? "", /2015-04-01/);
    assert.ok((tooltip.textContent ?? "").includes("-3.75"));
    assert.ok((tooltip.textContent ?? "").includes("valid 70%"));
    await act(async () => {
      root.unmount();
    });
  },
);

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
  const details = host.querySelector("details")!;
  assert.match(details.textContent ?? "", /Mean 500\.123456789/);
  assert.match(details.textContent ?? "", /median 400\.987654321/);
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

test("responsive width follows the observer and compact keeps each type", async (context) => {
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

  for (const chartType of ["line", "bar", "area"] as const) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<SvgChart table={timeTable()} chartType={chartType} compact={true} />);
    });
    assert.equal(host.querySelector("svg")?.getAttribute("height"), "36");
    assertSameNode(host.querySelector("details"), null);
    if (chartType === "line") assert.ok(host.querySelector("polyline"));
    if (chartType === "bar") assert.ok(host.querySelector("rect"));
    if (chartType === "area") assert.ok(host.querySelector("polygon"));
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={timeTable()} chartType="bar" compact={true} />);
  });
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
  assertSameNode(host.querySelector(".chart-grid"), null);
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
  const bottomMargin_PX = 36;
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
    assert.ok(entry.y <= 140);
  }
  for (let first = 0; first < positions.length; first++) {
    for (let second = first + 1; second < positions.length; second++) {
      assert.ok(Math.abs(positions[first] - positions[second]) >= 12);
    }
  }
  const xTickY = Number(host.querySelector(".chart-x-ticks text")?.getAttribute("y"));
  assert.equal(xTickY, 160);
  for (const entry of labels) {
    assert.ok(entry.y + 4 <= 144);
    assert.ok(entry.y + 4 < xTickY);
  }
  const frame = host.querySelector(".chart-plot-frame")!;
  assert.equal(Number(frame.getAttribute("y1")), 20);
  assert.equal(Number(frame.getAttribute("y2")), 144);
  const gridY = [...host.querySelectorAll(".chart-grid line")].map((line) => (
    Number(line.getAttribute("y1"))
  ));
  assert.equal(gridY.length, 1);
  assert.equal(gridY[0], 82);
  assert.ok(labels.some((entry) => entry.y > gridY[0]));
  assert.ok(labels.every((entry) => entry.y + 4 <= 144));
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
    assert.ok(entry.y <= 140);
  }
  for (let first = 0; first < bottomPositions.length; first++) {
    for (let second = first + 1; second < bottomPositions.length; second++) {
      assert.ok(Math.abs(bottomPositions[first] - bottomPositions[second]) >= 12);
    }
  }
  const bottomXTickY = Number(bottomHost.querySelector(".chart-x-ticks text")?.getAttribute("y"));
  assert.equal(bottomXTickY, 160);
  for (const entry of bottomLabels) {
    assert.ok(entry.y + 4 <= 144);
    assert.ok(entry.y + 4 < bottomXTickY);
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
  const plotHeight_PX = 180 - 20 - 36;
  const span = high - low;
  const yOf = (value: number) => plotTop_PX + ((high - value) / span) * plotHeight_PX;
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
  const seriesHeight_PX = 140 - 20 - 36;
  const seriesSpan = seriesHigh - seriesLow;
  const seriesYOf = (value: number) => seriesTop_PX
    + ((seriesHigh - value) / seriesSpan) * seriesHeight_PX;
  const baseY = seriesYOf(0);
  assert.equal(Number(rects[0].getAttribute("y")), seriesYOf(10.123456789012345));
  assert.equal(Number(rects[0].getAttribute("height")), baseY - seriesYOf(10.123456789012345));
  assert.equal(Number(rects[1].getAttribute("y")), baseY);
  assert.equal(Number(rects[1].getAttribute("height")), 1);
  assert.equal(Number(rects[2].getAttribute("y")), baseY);
  // A stroked edge bar insets by half its stroke so the outer extent stays inside.
  const strokeHalf_PX = 1.5 / 2;
  assert.equal(
    Number(rects[2].getAttribute("height")),
    seriesYOf(-3.75) - baseY - strokeHalf_PX,
  );
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
  assert.equal(automaticY[0], 104);
  assert.ok(automaticY.every((value) => value >= 20 && value <= 104));
  assert.equal(automaticY[1], 104);
  assert.equal(automaticY[2], 20);
  assert.ok(automaticY.slice(1, -1).includes(104));
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
  assert.equal(explicitY[0], 104);
  assert.ok(explicitY.every((value) => value >= 20 && value <= 104));
  assert.equal(explicitY[1], 104);
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
  assert.equal(convertedY[0], 104);
  assert.ok(convertedY.every((value) => value >= 20 && value <= 104));
  assert.equal(convertedY[1], 104);
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
  assert.equal(terrainY[0], 144);
  assert.ok(terrainY.every((value) => value >= 20 && value <= 144));
  assert.equal(terrainY[1], 144);
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
  assert.equal(explicitTerrainY[0], 144);
  assert.ok(explicitTerrainY.every((value) => value >= 20 && value <= 144));
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
  assert.equal(seasonalY[0], 104);
  assert.ok(seasonalY.every((value) => value >= 20 && value <= 104));
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

test("presentation rounds axes while tables stay exact", async (context) => {
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
  const yTexts = [...host.querySelectorAll(".chart-y-ticks text")].map((node) => node.textContent);
  assert.equal(yTexts.length, 4);
  for (const text of yTexts) {
    assert.match(text ?? "", /^-?\d+$/);
    assert.equal((text ?? "").includes("500.123"), false);
  }
  const visible = [...host.querySelectorAll(".chart-references text")].map(
    (node) => node.textContent,
  );
  assert.ok(visible.includes("Mean 500"));
  assert.ok(visible.includes("Median 401"));
  assert.ok(visible.includes("Sea level 0"));
  assert.equal(visible.some((text) => (text ?? "").includes("500.123456789")), false);
  const titles = [...host.querySelectorAll(".chart-references > g > title")].map(
    (node) => node.textContent,
  );
  assert.ok(titles.includes("Mean 500.123"));
  assert.ok(titles.includes("Median 400.988"));
  assert.ok(titles.includes("Sea level 0"));
  assert.equal(titles.some((text) => (text ?? "").includes("500.123456789")), false);
  const exact = host.querySelector("details")!;
  assert.match(exact.textContent ?? "", /Mean 500\.123456789/);
  assert.ok((host.querySelector(".chart-tooltip")?.textContent ?? "").includes("1000.988"));
  assert.equal(
    (host.querySelector(".chart-tooltip")?.textContent ?? "").includes("1000.987654321"),
    false,
  );
  await act(async () => {
    root.unmount();
  });

  const seriesHost = document.createElement("div");
  document.body.append(seriesHost);
  const seriesRoot = createRoot(seriesHost);
  await act(async () => {
    seriesRoot.render(<SvgChart table={timeTable()} chartType="line" />);
  });
  const seriesTicks = [...seriesHost.querySelectorAll(".chart-y-ticks text")].map(
    (node) => node.textContent,
  );
  assert.ok(seriesTicks.length >= 2);
  for (const text of seriesTicks) {
    assert.equal(/\.\d{4,}/.test(text ?? ""), false);
  }
  const seriesExact = seriesHost.querySelector("details")!;
  assert.ok(seriesExact.textContent?.includes(String(timeTable().rows[0].value)));
  await act(async () => {
    seriesRoot.unmount();
  });
  host.remove();
  seriesHost.remove();
});

test("time edge labels anchor inward while share labels stay centered", async (context) => {
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
  const anchors = [...host.querySelectorAll(".chart-x-ticks text")].map(
    (node) => node.getAttribute("text-anchor"),
  );
  assert.ok(anchors.length >= 2);
  assert.equal(anchors[0], "start");
  assert.equal(anchors[anchors.length - 1], "end");
  await act(async () => {
    root.unmount();
  });

  const shareHost = document.createElement("div");
  document.body.append(shareHost);
  const shareRoot = createRoot(shareHost);
  await act(async () => {
    shareRoot.render(<SvgChart table={distributionTable()} chartType="line" />);
  });
  const shareAnchors = [...shareHost.querySelectorAll(".chart-x-ticks text")].map(
    (node) => node.getAttribute("text-anchor"),
  );
  assert.ok(shareAnchors.length >= 2);
  for (const anchor of shareAnchors) assert.equal(anchor, "middle");
  await act(async () => {
    shareRoot.unmount();
  });
  host.remove();
  shareHost.remove();
});

test("narrow large ticks stay distinct with a disclosed offset", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const low = 1234567890.123456;
  const high = 1234567891.456789;
  const table: TimeSeriesTable = {
    ...timeTable(),
    rows: [low, high].map((value, index) => ({
      x: Date.UTC(2019, index, 1),
      value,
      label: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(2019, index + 1, 1)).toISOString().slice(0, 10),
      },
    })),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="line" />);
  });
  const yTexts = [...host.querySelectorAll(".chart-y-ticks text")].map((node) => node.textContent);
  assert.ok(yTexts.length >= 2);
  assert.equal(new Set(yTexts).size, yTexts.length);
  for (const text of yTexts) {
    assert.equal((text ?? "").length <= 12, true);
  }
  const titles = [...host.querySelectorAll(".chart-axes text")].map((node) => node.textContent);
  const yTitle = titles.find((text) => (text ?? "").includes("Rain"));
  assert.equal(yTitle, "Rain (mm/month)");
  const disclosure = host.querySelector(".chart-offset")?.textContent ?? "";
  assert.ok(disclosure.includes("ticks"));
  assert.ok(disclosure.includes(String(low)));
  assert.ok(disclosure.includes("="));
  const grid = host.querySelector(".chart-grid line")!;
  const left = Number(grid.getAttribute("x1"));
  const note = host.querySelector(".chart-offset")!;
  assert.equal(Number(note.getAttribute("x")), left);
  assert.equal(Number(note.getAttribute("y")), 12);
  assert.equal(note.getAttribute("text-anchor"), "start");
  const span = high - low;
  const ticks = [0, 1, 2, 3].map((index) => low + (span * index) / 3);
  const scale = 1;
  yTexts.forEach((text, index) => {
    const absolute = low + scale * Number.parseFloat(text ?? "NaN");
    assert.ok(Number.isFinite(absolute));
    assert.ok(Math.abs(absolute - ticks[index]) <= span / 6 + 0.06);
  });
  const tickNodes = [...host.querySelectorAll(".chart-y-ticks text")];
  for (const tick of tickNodes) {
    const tickX = Number(tick.getAttribute("x"));
    assert.equal(tickX, left - 4);
    const width = (tick.textContent ?? "").length * 6;
    assert.ok(tickX - width >= 20);
  }
  assert.ok((host.textContent ?? "").includes("1234567890.123456"));
  assert.ok((host.textContent ?? "").includes("1234567891.456789"));
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("narrow tiny ticks stay distinct without losing variation", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const table: TimeSeriesTable = {
    ...timeTable(),
    rows: [0.0000123456, 0.0000136789].map((value, index) => ({
      x: Date.UTC(2019, index, 1),
      value,
      label: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(2019, index + 1, 1)).toISOString().slice(0, 10),
      },
    })),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="line" />);
  });
  const yTexts = [...host.querySelectorAll(".chart-y-ticks text")].map((node) => node.textContent);
  assert.ok(yTexts.length >= 2);
  assert.equal(new Set(yTexts).size, yTexts.length);
  for (const text of yTexts) {
    assert.equal((text ?? "").length <= 12, true);
  }
  assert.ok((host.textContent ?? "").includes("0.0000123456"));
  assert.ok((host.textContent ?? "").includes("0.0000136789"));
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("narrow tiny relative spans use a shared base and scale", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const low = 0.000012345678901;
  const high = 0.000012345678902;
  const table: TimeSeriesTable = {
    ...timeTable(),
    rows: [low, high].map((value, index) => ({
      x: Date.UTC(2019, index, 1),
      value,
      label: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(2019, index + 1, 1)).toISOString().slice(0, 10),
      },
    })),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="line" />);
  });
  const yTexts = [...host.querySelectorAll(".chart-y-ticks text")].map((node) => node.textContent);
  assert.ok(yTexts.length >= 2);
  assert.equal(new Set(yTexts).size, yTexts.length);
  for (const text of yTexts) {
    assert.ok((text ?? "").length <= 12);
  }
  const titles = [...host.querySelectorAll(".chart-axes text")].map((node) => node.textContent);
  assert.equal(titles.find((text) => (text ?? "").includes("Rain")), "Rain (mm/month)");
  const disclosure = host.querySelector(".chart-offset")?.textContent ?? "";
  assert.ok(disclosure.includes("ticks"));
  assert.ok(disclosure.includes(String(low)));
  assert.ok(disclosure.includes("e"));
  assert.ok(disclosure.includes("="));
  const grid = host.querySelector(".chart-grid line")!;
  const left = Number(grid.getAttribute("x1"));
  const note = host.querySelector(".chart-offset")!;
  assert.equal(Number(note.getAttribute("x")), left);
  assert.equal(Number(note.getAttribute("y")), 12);
  const span = high - low;
  const ticks = [0, 1, 2, 3].map((index) => low + (span * index) / 3);
  const scaleText = /x (.+) \+/.exec(disclosure)?.[1] ?? "";
  const scale = Number.parseFloat(scaleText);
  assert.ok(Number.isFinite(scale) && scale > 0);
  const magnitude = Math.max(Math.abs(low), Math.abs(high));
  const tolerance = span / 6 + Number.EPSILON * magnitude;
  assert.ok(span > tolerance * 2);
  yTexts.forEach((text, index) => {
    const delta = Number.parseFloat(text ?? "NaN");
    assert.ok(Number.isFinite(delta));
    const expectedDelta = (ticks[index] - low) / scale;
    const deltaTolerance = tolerance / scale + Number.EPSILON * Math.abs(expectedDelta);
    assert.ok(Math.abs(delta - expectedDelta) <= deltaTolerance);
    const absolute = low + scale * delta;
    assert.ok(Number.isFinite(absolute));
    assert.ok(Math.abs(absolute - ticks[index]) <= tolerance);
  });
  for (const tick of host.querySelectorAll(".chart-y-ticks text")) {
    const tickX = Number(tick.getAttribute("x"));
    assert.equal(tickX, left - 4);
    const width = (tick.textContent ?? "").length * 6;
    assert.ok(tickX - width >= 20);
  }
  const gridY = [...host.querySelectorAll(".chart-grid line")].map((line) => (
    Number(line.getAttribute("y1"))
  ));
  assert.equal(gridY.length, yTexts.length);
  assert.ok(Math.abs(gridY[0] - 104) <= 1e-9);
  assert.ok(Math.abs(gridY[gridY.length - 1] - 20) <= 1e-9);
  for (let index = 1; index < gridY.length; index += 1) {
    assert.ok(Math.abs(gridY[index] - gridY[index - 1]) >= 10);
  }
  const tickY = [...host.querySelectorAll(".chart-y-ticks text")].map((node) => (
    Number(node.getAttribute("y"))
  ));
  assert.equal(tickY.length, gridY.length);
  for (let first = 0; first < tickY.length; first += 1) {
    for (let second = first + 1; second < tickY.length; second += 1) {
      assert.ok(Math.abs(tickY[first] - tickY[second]) >= 12);
    }
  }
  const points = host.querySelector("polyline")?.getAttribute("points")?.trim().split(/\s+/) ?? [];
  const pointY = points.map((corner) => Number(corner.split(",")[1]));
  assert.ok(pointY.length >= 2);
  assert.ok(Math.min(...pointY) <= 20 + 1e-9);
  assert.ok(Math.max(...pointY) >= 104 - 1e-9);
  assert.ok(Math.max(...pointY) - Math.min(...pointY) >= 80);
  assert.ok((host.textContent ?? "").includes(String(low)));
  assert.ok((host.textContent ?? "").includes(String(high)));
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("adjacent representable ticks stay bounded and distinct", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const cases = [
    { low: 1, high: 1.0000000000000002 },
    { low: 9007199254740991, high: 9007199254740992 },
    { low: 1e-12, high: 1e-12 * (1 + Number.EPSILON) },
  ];
  for (const { low, high } of cases) {
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
        root.render(<SvgChart table={timeTable()} chartType="line" yRange={[low, high]} />);
      });
      const yTexts = [...host.querySelectorAll(".chart-y-ticks text")].map(
        (node) => node.textContent,
      );
      assert.equal(yTexts.length, 2);
      assert.equal(new Set(yTexts).size, yTexts.length);
      for (const text of yTexts) {
        assert.ok((text ?? "").length <= 12);
      }
      const grids = [...host.querySelectorAll(".chart-grid line")];
      assert.equal(grids.length, yTexts.length);
      const keys = grids.map((line) => Number(line.getAttribute("y1")));
      assert.equal(new Set(keys).size, keys.length);
      const expected = [low, high];
      assert.notEqual(expected[0], expected[1]);
      const disclosures = [...host.querySelectorAll(".chart-offset")].map(
        (node) => node.textContent ?? "",
      );
      const equation = disclosures.join(" ");
      const scaleMatch = /x (.+) \+/.exec(equation);
      const baseMatch = /\+ (.+) = value/.exec(equation);
      const base = baseMatch ? Number.parseFloat(baseMatch[1]) : low;
      const scale = scaleMatch ? Number.parseFloat(scaleMatch[1]) : 1;
      yTexts.forEach((text, index) => {
        const delta = Number.parseFloat(text ?? "NaN");
        assert.ok(Number.isFinite(delta));
        const absolute = equation.includes("ticks") ? base + scale * delta : delta;
        assert.equal(absolute, expected[index]);
      });
      const duplicates = errors.filter((args) => String(args[0]).includes("same key"));
      assert.equal(duplicates.length, 0);
      await act(async () => {
        root.unmount();
      });
      host.remove();
    } finally {
      console.error = original;
    }
  }
});

test("long base and scale wrap inside narrow desktop cards", async (context) => {
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

  const low = 123456789012345670000;
  const high = low + 1e15;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={timeTable()} chartType="line" yRange={[low, high]} />);
  });
  await act(async () => {
    notify?.(264);
  });
  const svgWidth = Number(host.querySelector("svg")?.getAttribute("width"));
  assert.equal(svgWidth, 264);
  const grid = host.querySelector(".chart-grid line")!;
  const left = Number(grid.getAttribute("x1"));
  const lines = [...host.querySelectorAll(".chart-offset")];
  assert.ok(lines.length >= 2);
  const combined = lines.map((node) => node.textContent ?? "").join(" ");
  assert.ok(combined.includes("1e15"));
  assert.ok(combined.includes(String(low)));
  assert.ok(combined.includes("="));
  assert.equal(combined.includes("1000000000000000"), false);
  for (const line of lines) {
    const x = Number(line.getAttribute("x"));
    assert.equal(x, left);
    const y = Number(line.getAttribute("y"));
    assert.ok(y >= 0 && y <= 140);
    const width = (line.textContent ?? "").length * 6;
    assert.ok(x + width <= svgWidth + 1);
  }
  const gridY = [...host.querySelectorAll(".chart-grid line")].map((line) => (
    Number(line.getAttribute("y1"))
  ));
  const lastCaptionY = Math.max(...lines.map((line) => Number(line.getAttribute("y"))));
  assert.ok(Math.min(...gridY) > lastCaptionY);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("wrapped disclosure keeps the current-time cursor inside the plot", async (context) => {
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

  const low = 123456789012345670000;
  const high = low + 1e15;
  const table: TimeSeriesTable = {
    ...timeTable(),
    rows: [low, high].map((value, index) => ({
      x: Date.UTC(2019, index, 1),
      value,
      label: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(2019, index + 1, 1)).toISOString().slice(0, 10),
      },
    })),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart
        table={table}
        chartType="line"
        yRange={[low, high]}
        currentTime="2019-01-15"
      />,
    );
  });
  await act(async () => {
    notify?.(264);
  });
  assert.equal(Number(host.querySelector("svg")?.getAttribute("width")), 264);
  const lines = [...host.querySelectorAll(".chart-offset")];
  assert.ok(lines.length >= 2);
  const gridY = [...host.querySelectorAll(".chart-grid line")].map((line) => (
    Number(line.getAttribute("y1"))
  ));
  assert.equal(Math.min(...gridY), 32);
  assert.equal(Math.max(...gridY), 104);
  const cursor = host.querySelector(".chart-cursor line")!;
  const cursorTop = Number(cursor.getAttribute("y1"));
  const cursorBottom = Number(cursor.getAttribute("y2"));
  assert.equal(cursorTop, Math.min(...gridY));
  assert.equal(cursorBottom, Math.max(...gridY));
  const lastCaptionY = Math.max(...lines.map((line) => Number(line.getAttribute("y"))));
  assert.ok(cursorTop > lastCaptionY);
  const frame = host.querySelector(".chart-plot-frame")!;
  assert.equal(Number(frame.getAttribute("y1")), cursorTop);
  assert.equal(Number(frame.getAttribute("y2")), cursorBottom);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("wide fixed labels widen the gutter and clear the title", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  for (const range of [[0, 123456789], [-123456789, 0]] as [number, number][]) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<SvgChart table={timeTable()} chartType="line" yRange={range} />);
    });
    const grid = host.querySelector(".chart-grid line")!;
    const left = Number(grid.getAttribute("x1"));
    assert.ok(left > 48);
    const title = [...host.querySelectorAll(".chart-axes text")].find((node) => (
      (node.textContent ?? "").includes("Rain")
    ))!;
    const titleX = Number(title.getAttribute("x"));
    assert.equal(titleX, 12);
    const ticks = [...host.querySelectorAll(".chart-y-ticks text")];
    assert.ok(ticks.length >= 2);
    for (const tick of ticks) {
      const tickX = Number(tick.getAttribute("x"));
      assert.equal(tickX, left - 4);
      const width = (tick.textContent ?? "").length * 6;
      const edge = tickX - width;
      assert.ok(edge >= 20);
      assert.ok(edge >= 0);
    }
    const texts = ticks.map((node) => node.textContent);
    assert.equal(new Set(texts).size, texts.length);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});

test("gallery time labels stay separate at card widths", async (context) => {
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

  const starts = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const table: TimeSeriesTable = {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: starts.map((start, index) => ({
      x: Date.parse(start),
      value: 10 + index,
      label: start,
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start,
        end: index + 1 < starts.length ? starts[index + 1] : "2026-09-01",
      },
    })),
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="bar" />);
  });
  await act(async () => {
    notify?.(300);
  });
  assert.equal(Number(host.querySelector("svg")?.getAttribute("width")), 300);
  const ticks = [...host.querySelectorAll(".chart-x-ticks text")];
  assert.ok(ticks.length >= 2);
  const labels = ticks.map((node) => node.textContent ?? "");
  assert.equal(new Set(labels).size, labels.length);
  for (const label of labels) assert.match(label, /^2026-\d{2}-\d{2}$/);
  const boxes = ticks.map((node) => {
    const x = Number(node.getAttribute("x"));
    const anchor = node.getAttribute("text-anchor");
    const width = (node.textContent ?? "").length * 6;
    if (anchor === "start") return { left: x, right: x + width };
    if (anchor === "end") return { left: x - width, right: x };
    return { left: x - width / 2, right: x + width / 2 };
  });
  for (let index = 0; index < boxes.length - 1; index += 1) {
    assert.ok(boxes[index].right + 8 <= boxes[index + 1].left);
  }
  const cells = [...host.querySelectorAll("tbody th")].map((cell) => cell.textContent);
  for (const start of starts) assert.ok(cells.includes(start));
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("gallery bars stay inside the plot clear of y ticks", async (context) => {
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

  const starts = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const table: TimeSeriesTable = {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: starts.map((start, index) => ({
      x: Date.parse(start),
      value: 10 + index,
      label: start,
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start,
        end: index + 1 < starts.length ? starts[index + 1] : "2026-09-01",
      },
    })),
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="bar" />);
  });
  await act(async () => {
    notify?.(300);
  });
  const grid = host.querySelector(".chart-grid line")!;
  const left = Number(grid.getAttribute("x1"));
  const right = Number(grid.getAttribute("x2"));
  assert.ok(right > left);
  const rects = [...host.querySelectorAll(".chart-bars rect")];
  assert.equal(rects.length, 5);
  for (const rect of rects) {
    const x = Number(rect.getAttribute("x"));
    const width = Number(rect.getAttribute("width"));
    assert.ok(x >= left - 1);
    assert.ok(x + width <= right + 1);
  }
  const yTicks = [...host.querySelectorAll(".chart-y-ticks text")];
  assert.ok(yTicks.length >= 2);
  for (const tick of yTicks) {
    const tickX = Number(tick.getAttribute("x"));
    assert.equal(tickX, left - 4);
  }
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("two gallery bars stay separated, aligned and contained", async (context) => {
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

  const table: TimeSeriesTable = {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: [
      {
        x: Date.parse("2026-04-01"),
        value: 10,
        label: "2026-04-01",
        validFraction: 1,
        fallbackFraction: null,
        interval: { start: "2026-04-01", end: "2026-05-01" },
      },
      {
        x: Date.parse("2026-05-01"),
        value: 20,
        label: "2026-05-01",
        validFraction: 1,
        fallbackFraction: null,
        interval: { start: "2026-05-01", end: "2026-06-01" },
      },
    ],
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart table={table} chartType="bar" currentTime="2026-04-15" />,
    );
  });
  await act(async () => {
    notify?.(300);
  });
  const frame = host.querySelector(".chart-plot-frame")!;
  const left = Number(frame.getAttribute("x1"));
  const right = Number(frame.getAttribute("x2"));
  const top = Number(frame.getAttribute("y1"));
  const bottom = Number(frame.getAttribute("y2"));
  assert.ok(right > left);
  assert.ok(bottom > top);
  const rects = [...host.querySelectorAll(".chart-bars rect")];
  assert.equal(rects.length, 2);
  const boxes = rects.map((rect) => {
    const x = Number(rect.getAttribute("x"));
    const y = Number(rect.getAttribute("y"));
    const width = Number(rect.getAttribute("width"));
    const height = Number(rect.getAttribute("height"));
    const stroke = Number(rect.getAttribute("stroke-width") ?? "0");

    return {
      x,
      y,
      width,
      height,
      stroke,
      outerLeft: x - stroke / 2,
      outerRight: x + width + stroke / 2,
      outerTop: y - stroke / 2,
      outerBottom: y + height + stroke / 2,
    };
  });
  for (const box of boxes) {
    assert.ok(box.outerLeft >= left - 0.001);
    assert.ok(box.outerRight <= right + 0.001);
    assert.ok(box.outerTop >= top - 0.001);
    assert.ok(box.outerBottom <= bottom + 0.001);
  }
  const sorted = [...boxes].sort((first, second) => first.x - second.x);
  assert.ok(sorted[0].outerRight <= sorted[1].x + 0.001);
  const cursor = host.querySelector(".chart-cursor line")!;
  const cursorX = Number(cursor.getAttribute("x1"));
  assert.ok(Math.abs(sorted[0].width - sorted[1].width) < 0.001);
  assert.ok(sorted[0].outerLeft > left + 0.001);
  assert.ok(sorted[1].outerRight < right - 0.001);
  assert.ok(Math.abs(cursorX - (sorted[0].x + sorted[0].width / 2)) < 0.001);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("five gallery bars stay separated, aligned and contained", async (context) => {
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

  const starts = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const table: TimeSeriesTable = {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: starts.map((start, index) => ({
      x: Date.parse(start),
      value: 10 + index,
      label: start,
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start,
        end: index + 1 < starts.length ? starts[index + 1] : "2026-09-01",
      },
    })),
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart table={table} chartType="bar" currentTime="2026-06-15" />,
    );
  });
  await act(async () => {
    notify?.(300);
  });
  const frame = host.querySelector(".chart-plot-frame")!;
  const left = Number(frame.getAttribute("x1"));
  const right = Number(frame.getAttribute("x2"));
  const top = Number(frame.getAttribute("y1"));
  const bottom = Number(frame.getAttribute("y2"));
  assert.ok(right > left);
  assert.ok(bottom > top);
  const rects = [...host.querySelectorAll(".chart-bars rect")];
  assert.equal(rects.length, 5);
  const boxes = rects.map((rect) => {
    const x = Number(rect.getAttribute("x"));
    const y = Number(rect.getAttribute("y"));
    const width = Number(rect.getAttribute("width"));
    const height = Number(rect.getAttribute("height"));
    const stroke = Number(rect.getAttribute("stroke-width") ?? "0");

    return {
      x,
      y,
      width,
      height,
      stroke,
      outerLeft: x - stroke / 2,
      outerRight: x + width + stroke / 2,
      outerTop: y - stroke / 2,
      outerBottom: y + height + stroke / 2,
    };
  });
  for (const box of boxes) {
    assert.ok(box.outerLeft >= left - 0.001);
    assert.ok(box.outerRight <= right + 0.001);
    assert.ok(box.outerTop >= top - 0.001);
    assert.ok(box.outerBottom <= bottom + 0.001);
  }
  const sorted = [...boxes].sort((first, second) => first.x - second.x);
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    assert.ok(sorted[index].outerRight <= sorted[index + 1].x + 0.001);
  }
  const cursor = host.querySelector(".chart-cursor line")!;
  const cursorX = Number(cursor.getAttribute("x1"));
  const middle = boxes[2];
  assert.ok(Math.abs(cursorX - (middle.x + middle.width / 2)) < 0.001);
  for (const box of sorted) {
    assert.ok(Math.abs(box.width - sorted[0].width) < 0.001);
  }
  assert.ok(sorted[0].outerLeft > left + 0.001);
  assert.ok(sorted[4].outerRight < right - 0.001);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("minimum-height and stroked bars stay inside the plot", async (context) => {
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

  const cases: { table: TimeSeriesTable; currentTime: string | null }[] = [
    {
      table: twoValueTable([0, 20], [1, 1]),
      currentTime: "2026-04-15",
    },
    {
      table: twoValueTable([-5, 10], [1, 1]),
      currentTime: "2026-04-15",
    },
    {
      table: twoValueTable([5, 5], [1, 1]),
      currentTime: null,
    },
    {
      table: twoValueTable([10, 20], [0.5, 1]),
      currentTime: null,
    },
    {
      table: twoValueTable([10, 20], [1, 1]),
      currentTime: "2026-05-15",
    },
  ];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  for (const entry of cases) {
    await act(async () => {
      root.render(
        <SvgChart
          table={entry.table}
          chartType="bar"
          currentTime={entry.currentTime}
        />,
      );
    });
    await act(async () => {
      notify?.(300);
    });
    const frame = host.querySelector(".chart-plot-frame")!;
    const left = Number(frame.getAttribute("x1"));
    const right = Number(frame.getAttribute("x2"));
    const top = Number(frame.getAttribute("y1"));
    const bottom = Number(frame.getAttribute("y2"));
    const rects = [...host.querySelectorAll(".chart-bars rect")];
    assert.equal(rects.length, 2);
    for (const rect of rects) {
      const x = Number(rect.getAttribute("x"));
      const y = Number(rect.getAttribute("y"));
      const width = Number(rect.getAttribute("width"));
      const height = Number(rect.getAttribute("height"));
      const stroke = Number(rect.getAttribute("stroke-width") ?? "0");
      const outerLeft = x - stroke / 2;
      const outerRight = x + width + stroke / 2;
      const outerTop = y - stroke / 2;
      const outerBottom = y + height + stroke / 2;
      assert.ok(outerLeft >= left - 0.001);
      assert.ok(outerRight <= right + 0.001);
      assert.ok(outerTop >= top - 0.001);
      assert.ok(outerBottom <= bottom + 0.001);
      assert.ok(height >= 1 - 0.001);
    }
  }
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("gallery terrain endpoints fit with rounded resolution", async (context) => {
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

  const exact = "0.004545454545454546° analysis grid";
  const table = distributionTable();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SvgChart
        table={table}
        chartType="area"
        resolutionNote={exact}
        resolutionValue={0.004545454545454546}
      />,
    );
  });
  await act(async () => {
    notify?.(300);
  });
  assert.equal(Number(host.querySelector("svg")?.getAttribute("width")), 300);
  const grid = host.querySelector(".chart-grid line")!;
  const left = Number(grid.getAttribute("x1"));
  const right = Number(grid.getAttribute("x2"));
  const texts = [...host.querySelectorAll(".chart-endpoints text")];
  assert.equal(texts.length, 2);
  for (const text of texts) {
    const content = text.textContent ?? "";
    assert.ok(content.includes("0.005"));
    assert.equal(content.includes("0.004545454545454546"), false);
    const x = Number(text.getAttribute("x"));
    const anchor = text.getAttribute("text-anchor");
    const width = content.length * 6;
    if (anchor === "end") assert.ok(x - width >= left - 1);
    if (anchor === "start") assert.ok(x + width <= right + 1);
  }
  const titles = [...host.querySelectorAll(".chart-endpoints title")].map(
    (node) => node.textContent ?? "",
  );
  assert.ok(titles.some((text) => text.includes("0.004545454545454546")));
  assert.match(host.textContent ?? "", /0\.004545454545454546/);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("narrow terrain x title wraps inside the desktop gallery card", async (context) => {
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

  const title = "Share of valid area at or above (%)";
  const table = { ...distributionTable(), xTitle: title };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="area" />);
  });
  await act(async () => {
    notify?.(304);
  });
  assert.equal(Number(host.querySelector("svg")?.getAttribute("width")), 304);
  const lines = xTitleLines(host);
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(" "), title);
  const grid = host.querySelector(".chart-grid line")!;
  const left = Number(grid.getAttribute("x1"));
  const right = Number(grid.getAttribute("x2"));
  const plotWidth = right - left;
  for (const line of lines) assert.ok(line.length * 7 <= plotWidth + 1);
  const frame = host.querySelector(".chart-plot-frame")!;
  const bottom = Number(frame.getAttribute("y2"));
  assert.equal(Number(frame.getAttribute("y1")), 20);
  assert.ok(bottom < 144);
  const ticks = [...host.querySelectorAll(".chart-x-ticks text")];
  assert.ok(ticks.length >= 2);
  for (const tick of ticks) assert.equal(Number(tick.getAttribute("y")), bottom + 16);
  const nodes = xTitleNodes(host);
  nodes.forEach((node, index) => {
    assert.equal(Number(node.getAttribute("y")), bottom + 32 + index * 12);
    assert.equal(Number(node.getAttribute("x")), left + plotWidth / 2);
  });
  assert.match(host.querySelector("svg")?.getAttribute("aria-label") ?? "", /Elevation/);
  assert.match(host.textContent ?? "", /Mean 500\.123456789/);
  await act(async () => {
    notify?.(330);
  });
  assert.equal(Number(host.querySelector("svg")?.getAttribute("width")), 330);
  assert.deepEqual(xTitleLines(host), [title]);
  assert.equal(Number(host.querySelector(".chart-plot-frame")?.getAttribute("y2")), 144);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("narrow time-series tick clears its single-line title", async (context) => {
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

  const starts = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const table: TimeSeriesTable = {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: starts.map((start, index) => ({
      x: Date.parse(start),
      value: 10 + index,
      label: start,
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start,
        end: index + 1 < starts.length ? starts[index + 1] : "2026-09-01",
      },
    })),
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="bar" />);
  });
  await act(async () => {
    notify?.(300);
  });
  assert.equal(Number(host.querySelector("svg")?.getAttribute("width")), 300);
  assert.equal(Number(host.querySelector("svg")?.getAttribute("height")), 140);
  assert.deepEqual(xTitleLines(host), ["Time"]);
  const frame = host.querySelector(".chart-plot-frame")!;
  const bottom = Number(frame.getAttribute("y2"));
  assert.equal(bottom, 104);
  const ticks = [...host.querySelectorAll(".chart-x-ticks text")];
  assert.ok(ticks.length >= 2);
  for (const tick of ticks) assert.equal(Number(tick.getAttribute("y")), bottom + 16);
  const title = xTitleNodes(host)[0];
  assert.equal(Number(title.getAttribute("y")), bottom + 32);
  const grid = host.querySelector(".chart-grid line")!;
  const left = Number(grid.getAttribute("x1"));
  const right = Number(grid.getAttribute("x2"));
  const plotWidth = right - left;
  assert.equal(Number(title.getAttribute("x")), left + plotWidth / 2);
  const titleWidth = "Time".length * 7;
  const titleBox = {
    left: Number(title.getAttribute("x")) - titleWidth / 2,
    right: Number(title.getAttribute("x")) + titleWidth / 2,
  };
  const tickBoxes = ticks.map((node) => {
    const x = Number(node.getAttribute("x"));
    const anchor = node.getAttribute("text-anchor");
    const width = (node.textContent ?? "").length * 6;
    if (anchor === "start") return { left: x, right: x + width };
    if (anchor === "end") return { left: x - width, right: x };

    return { left: x - width / 2, right: x + width / 2 };
  });
  const overlapping = tickBoxes.some((box) => (
    box.left < titleBox.right - 1 && titleBox.left < box.right - 1
  ));
  assert.ok(overlapping);
  const tickBottom = bottom + 16 + 4;
  const titleTop = bottom + 32 - 9;
  assert.ok(tickBottom + 1 < titleTop);
  assert.ok(titleTop >= 0);
  assert.ok(bottom + 32 + 4 <= 140);
  assert.ok(titleBox.left >= -1);
  assert.ok(titleBox.right <= 300 + 1);
  for (const tick of ticks) {
    assert.ok(Number(tick.getAttribute("y")) - 9 >= -1);
    assert.ok(Number(tick.getAttribute("y")) + 4 <= 140 + 1);
  }
  assert.match(host.querySelector("svg")?.getAttribute("aria-label") ?? "", /time series/);
  const headers = [...host.querySelectorAll("thead th")].map((cell) => cell.textContent);
  assert.ok(headers.includes("Time"));
  assert.ok(headers.includes("Rain (mm/month)"));
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test(
  "light paint keeps its ink with a dark edge and no duplicate announcements",
  async (context) => {
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
      root.render(<SvgChart table={timeTable()} chartType="bar" ink="#ffffff" />);
    });
    const bars = [...host.querySelectorAll("rect")];
    assert.ok(bars.length >= 2);
    const solid = bars.find((rect) => rect.getAttribute("fill") === "#ffffff")!;
    assert.equal(solid.getAttribute("stroke"), "#1a3658");
    assert.equal(solid.getAttribute("stroke-width"), "1.5");
    const hollow = bars.find((rect) => rect.getAttribute("fill") === "none")!;
    assert.equal(hollow.getAttribute("fill"), "none");
    assert.equal(hollow.getAttribute("stroke"), "#1a3658");
    const barTitles = bars.map((rect) => rect.querySelector("title")?.textContent ?? "");
    assert.ok(barTitles.every((text) => text.length > 0));
    const frame = host.querySelector(".chart-plot-frame")!;
    const left = Number(frame.getAttribute("x1"));
    const right = Number(frame.getAttribute("x2"));
    const top = Number(frame.getAttribute("y1"));
    const bottom = Number(frame.getAttribute("y2"));
    for (const bar of bars) {
      const x = Number(bar.getAttribute("x"));
      const y = Number(bar.getAttribute("y"));
      const width = Number(bar.getAttribute("width"));
      const height = Number(bar.getAttribute("height"));
      const strokeHalf_PX = Number(bar.getAttribute("stroke-width")) / 2;
      assert.ok(x - strokeHalf_PX >= left);
      assert.ok(x + width + strokeHalf_PX <= right);
      assert.ok(y - strokeHalf_PX >= top);
      assert.ok(y + height + strokeHalf_PX <= bottom);
    }
    await act(async () => {
      root.unmount();
    });

    const lineHost = document.createElement("div");
    document.body.append(lineHost);
    const lineRoot = createRoot(lineHost);
    await act(async () => {
      lineRoot.render(<SvgChart table={timeTable()} chartType="line" ink="#ffffff" />);
    });
    const lines = [...lineHost.querySelectorAll(".chart-lines polyline")];
    assert.ok(lines.some((line) => line.getAttribute("stroke") === "#ffffff"));
    const under = lines.find((line) => line.getAttribute("aria-hidden") === "true")!;
    assert.equal(under.getAttribute("stroke"), "#1a3658");
    assertSameNode(under.querySelector("title"), null);
    await act(async () => {
      lineRoot.unmount();
    });

    const areaHost = document.createElement("div");
    document.body.append(areaHost);
    const areaRoot = createRoot(areaHost);
    await act(async () => {
      areaRoot.render(<SvgChart table={timeTable()} chartType="area" ink="#ffffff" />);
    });
    const polygon = areaHost.querySelector("polygon")!;
    assert.equal(polygon.getAttribute("fill"), "#ffffff");
    const edge = areaHost.querySelector('.chart-areas polyline[aria-hidden="true"]')!;
    assert.equal(edge.getAttribute("stroke"), "#1a3658");
    assertSameNode(edge.querySelector("title"), null);
    await act(async () => {
      areaRoot.unmount();
    });
    host.remove();
    lineHost.remove();
    areaHost.remove();
  },
);

test("light solid and hollow circles keep contrasting outlines", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  for (const chartType of ["line", "area"] as const) {
    await act(async () => {
      root.render(
        <SvgChart table={timeTable()} chartType={chartType} ink="#ffffff" showPoints={true} />,
      );
    });
    const circles = [...host.querySelectorAll(".chart-points circle")];
    assert.equal(circles.length, 3);
    assert.equal(circles[0].getAttribute("fill"), "#ffffff");
    assert.equal(circles[0].getAttribute("stroke-width"), "1.5");
    assert.equal(circles[1].getAttribute("fill"), "none");
    assert.equal(circles[1].getAttribute("stroke-width"), "1.5");
    for (const circle of circles) {
      assert.equal(circle.getAttribute("stroke"), "#1a3658");
      assert.equal(circle.querySelectorAll("title").length, 1);
    }
  }
  await act(async () => root.unmount());
  host.remove();
});

test("wrappers honour ink precedence and fall back for unknown palettes", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SeriesChart } = await import("./series-chart.tsx");
  const { HypsometryChart } = await import("./hypsometry-chart.tsx");

  const cases = [
    { ink: "#123456", effectiveInk: "white", palette: "blue-red", expected: "#123456" },
    { ink: undefined, effectiveInk: "white", palette: "blue-red", expected: "#ffffff" },
    { ink: undefined, effectiveInk: null, palette: "unknown-palette", expected: null },
  ];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  for (const entry of cases) {
    await act(async () => {
      root.render(
        <>
          <SeriesChart
            layer={wrapperRain()}
            shape="time_series"
            chartType="bar"
            options={{ ink: entry.ink }}
            effectiveInk={entry.effectiveInk}
            effectivePalette={entry.palette}
          />
          <HypsometryChart
            layer={wrapperTerrain()}
            chartType="area"
            options={{ ink: entry.ink }}
            effectiveInk={entry.effectiveInk}
            effectivePalette={entry.palette}
          />
        </>,
      );
    });
    assert.equal(
      host.querySelector(".series-chart .chart-bars rect")?.getAttribute("fill"),
      entry.expected ?? "#1a3658",
    );
    assert.equal(
      host.querySelector(".hypsometry-chart .chart-areas polygon")?.getAttribute("fill"),
      entry.expected ?? "#6e6e6e",
    );
  }
  await act(async () => root.unmount());
  host.remove();
});

test("preview readouts stay short while full readouts keep rounded coverage", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const preview = document.createElement("div");
  document.body.append(preview);
  const previewRoot = createRoot(preview);
  await act(async () => {
    previewRoot.render(
      <SvgChart
        table={timeTable()}
        chartType="bar"
        fallbackNames="ERA5"
        showCoverageDetails={false}
      />,
    );
  });
  const previewTooltip = preview.querySelector(".chart-tooltip")!;
  assert.ok((previewTooltip.textContent ?? "").includes("-3.75"));
  assert.equal((previewTooltip.textContent ?? "").includes("valid"), false);
  assert.equal((previewTooltip.textContent ?? "").includes("ERA5"), false);
  const previewTitles = [...preview.querySelectorAll("rect title")].map(
    (node) => node.textContent ?? "",
  );
  assert.ok(previewTitles.length > 0);
  assert.ok(previewTitles.every((text) => !text.includes("valid")));
  assert.ok(previewTitles.every((text) => !text.includes("ERA5")));
  await act(async () => {
    previewRoot.unmount();
  });

  const full = document.createElement("div");
  document.body.append(full);
  const fullRoot = createRoot(full);
  await act(async () => {
    fullRoot.render(
      <SvgChart table={timeTable()} chartType="bar" fallbackNames="ERA5" />,
    );
  });
  const fullTooltip = full.querySelector(".chart-tooltip")!;
  assert.ok((fullTooltip.textContent ?? "").includes("-3.75"));
  assert.ok((fullTooltip.textContent ?? "").includes("valid 70%"));
  assert.ok((fullTooltip.textContent ?? "").includes("ERA5"));
  const summary = full.querySelector("summary")!;
  assert.equal(summary.textContent, "Table (exact values)");
  assert.ok((full.querySelector("details")?.textContent ?? "").includes("source units"));
  assert.ok(
    [...full.querySelectorAll("td")].some(
      (cell) => cell.textContent === String(timeTable().rows[0].value),
    ),
  );
  await act(async () => {
    fullRoot.unmount();
  });
  preview.remove();
  full.remove();
});

test("time bars keep full width inside while lines stay on the edges", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const starts = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const table: TimeSeriesTable = {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: starts.map((start, index) => ({
      x: Date.parse(start),
      value: 10 + index,
      label: start,
      validFraction: 1,
      fallbackFraction: null,
      interval: {
        start,
        end: index + 1 < starts.length ? starts[index + 1] : "2026-09-01",
      },
    })),
    xTitle: "Time",
    yTitle: "Rain (mm/month)",
  };
  const low = Date.parse("2026-04-01");
  const high = Date.parse("2026-08-01");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={table} chartType="bar" />);
  });
  const frame = host.querySelector(".chart-plot-frame")!;
  const left = Number(frame.getAttribute("x1"));
  const right = Number(frame.getAttribute("x2"));
  const rects = [...host.querySelectorAll(".chart-bars rect")];
  assert.equal(rects.length, 5);
  const widths = rects.map((rect) => Number(rect.getAttribute("width")));
  for (const width of widths) {
    assert.ok(Math.abs(width - widths[0]) < 0.001);
  }
  for (const rect of rects) {
    const x = Number(rect.getAttribute("x"));
    const width = Number(rect.getAttribute("width"));
    assert.ok(x >= left - 0.001);
    assert.ok(x + width <= right + 0.001);
  }
  const firstX = Number(rects[0].getAttribute("x"));
  const last = rects[rects.length - 1];
  const lastRight = Number(last.getAttribute("x")) + Number(last.getAttribute("width"));
  assert.ok(firstX > left + 0.001);
  assert.ok(lastRight < right - 0.001);

  await act(async () => {
    root.render(<SvgChart table={table} chartType="line" />);
  });
  const lineFrame = host.querySelector(".chart-plot-frame")!;
  const lineLeft = Number(lineFrame.getAttribute("x1"));
  const lineRight = Number(lineFrame.getAttribute("x2"));
  const points = host.querySelector(".chart-lines polyline")!.getAttribute("points")!.trim().split(
    /\s+/,
  );
  const firstPoint = points[0].split(",").map(Number);
  const lastPoint = points[points.length - 1].split(",").map(Number);
  assert.ok(Math.abs(firstPoint[0] - lineLeft) < 0.001);
  assert.ok(Math.abs(lastPoint[0] - lineRight) < 0.001);

  await act(async () => {
    root.render(<SvgChart table={table} chartType="bar" xDomain={[low, high]} />);
  });
  const overrideFrame = host.querySelector(".chart-plot-frame")!;
  const overrideLeft = Number(overrideFrame.getAttribute("x1"));
  const overrideRight = Number(overrideFrame.getAttribute("x2"));
  const overrideRects = [...host.querySelectorAll(".chart-bars rect")];
  assert.equal(overrideRects.length, 5);
  const overrideWidths = overrideRects.map((rect) => Number(rect.getAttribute("width")));
  for (const width of overrideWidths) {
    assert.ok(Math.abs(width - overrideWidths[0]) < 0.001);
  }
  const overrideFirst = Number(overrideRects[0].getAttribute("x"));
  const overrideLast = overrideRects[overrideRects.length - 1];
  const overrideLastRight = Number(overrideLast.getAttribute("x"))
    + Number(overrideLast.getAttribute("width"));
  assert.ok(overrideFirst > overrideLeft + 0.001);
  assert.ok(overrideLastRight < overrideRight - 0.001);

  await act(async () => {
    root.render(<SvgChart table={table} chartType="line" xDomain={[low, high]} />);
  });
  const overrideLine = host.querySelector(".chart-lines polyline")!.getAttribute("points")!.trim()
    .split(/\s+/);
  const overrideFirstPoint = overrideLine[0].split(",").map(Number);
  const overrideLastPoint = overrideLine[overrideLine.length - 1].split(",").map(Number);
  assert.ok(Math.abs(overrideFirstPoint[0] - overrideLeft) < 0.001);
  assert.ok(Math.abs(overrideLastPoint[0] - overrideRight) < 0.001);

  await act(async () => {
    root.render(<SvgChart table={table} chartType="bar" compact={true} />);
  });
  const compactWidth = Number(host.querySelector("svg")?.getAttribute("width"));
  const compactLeft = 2;
  const compactRight = compactWidth - 2;
  const compactRects = [...host.querySelectorAll(".chart-bars rect")];
  assert.equal(compactRects.length, 5);
  const compactWidths = compactRects.map((rect) => Number(rect.getAttribute("width")));
  for (const width of compactWidths) {
    assert.ok(Math.abs(width - compactWidths[0]) < 0.001);
  }
  for (const rect of compactRects) {
    const x = Number(rect.getAttribute("x"));
    const width = Number(rect.getAttribute("width"));
    assert.ok(x >= compactLeft - 0.001);
    assert.ok(x + width <= compactRight + 0.001);
  }
  const compactFirst = Number(compactRects[0].getAttribute("x"));
  const compactLast = compactRects[compactRects.length - 1];
  const compactLastRight = Number(compactLast.getAttribute("x"))
    + Number(compactLast.getAttribute("width"));
  assert.ok(compactFirst > compactLeft + 0.001);
  assert.ok(compactLastRight < compactRight - 0.001);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("seasonal bars keep full width inside while lines stay on the edges", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const table = {
    shape: "seasonal_cycle",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: months.map((label, index) => ({
      x: index + 1,
      value: 10 + index,
      label,
      validFraction: 1,
      fallbackFraction: null,
      sampleCount: 5,
      yearRange: [2019, 2023],
    })),
    xTitle: "Month",
    yTitle: "Rain by month (mm/month)",
  } as const;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={{ ...table }} chartType="bar" />);
  });
  const frame = host.querySelector(".chart-plot-frame")!;
  const left = Number(frame.getAttribute("x1"));
  const right = Number(frame.getAttribute("x2"));
  const rects = [...host.querySelectorAll(".chart-bars rect")];
  assert.equal(rects.length, 12);
  const widths = rects.map((rect) => Number(rect.getAttribute("width")));
  for (const width of widths) {
    assert.ok(Math.abs(width - widths[0]) < 0.001);
  }
  for (const rect of rects) {
    const x = Number(rect.getAttribute("x"));
    const width = Number(rect.getAttribute("width"));
    assert.ok(x >= left - 0.001);
    assert.ok(x + width <= right + 0.001);
  }
  const firstX = Number(rects[0].getAttribute("x"));
  const last = rects[rects.length - 1];
  const lastRight = Number(last.getAttribute("x")) + Number(last.getAttribute("width"));
  assert.ok(firstX > left + 0.001);
  assert.ok(lastRight < right - 0.001);

  await act(async () => {
    root.render(<SvgChart table={{ ...table }} chartType="line" />);
  });
  const lineFrame = host.querySelector(".chart-plot-frame")!;
  const lineLeft = Number(lineFrame.getAttribute("x1"));
  const lineRight = Number(lineFrame.getAttribute("x2"));
  const points = host.querySelector(".chart-lines polyline")!.getAttribute("points")!.trim().split(
    /\s+/,
  );
  const firstPoint = points[0].split(",").map(Number);
  const lastPoint = points[points.length - 1].split(",").map(Number);
  assert.ok(Math.abs(firstPoint[0] - lineLeft) < 0.001);
  assert.ok(Math.abs(lastPoint[0] - lineRight) < 0.001);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("distribution bars keep full width inside while lines stay on the edges", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SvgChart } = await import("./svg-chart.tsx");

  const solid = distributionTable();
  solid.rows = solid.rows.map((row) => ({ ...row, validFraction: 1 }));

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SvgChart table={solid} chartType="bar" />);
  });
  const frame = host.querySelector(".chart-plot-frame")!;
  const left = Number(frame.getAttribute("x1"));
  const right = Number(frame.getAttribute("x2"));
  const rects = [...host.querySelectorAll(".chart-bars rect")];
  assert.equal(rects.length, 3);
  const widths = rects.map((rect) => Number(rect.getAttribute("width")));
  for (const width of widths) {
    assert.ok(Math.abs(width - widths[0]) < 0.001);
  }
  for (const rect of rects) {
    const x = Number(rect.getAttribute("x"));
    const width = Number(rect.getAttribute("width"));
    assert.ok(x >= left - 0.001);
    assert.ok(x + width <= right + 0.001);
  }
  const centres = rects.map((rect) => (
    Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2
  ));
  assert.ok(centres[0] > centres[1]);
  assert.ok(centres[1] > centres[2]);
  assert.ok(centres[0] < right - 0.001);
  assert.ok(centres[2] > left + 0.001);

  await act(async () => {
    root.render(<SvgChart table={distributionTable()} chartType="line" />);
  });
  const lineFrame = host.querySelector(".chart-plot-frame")!;
  const lineLeft = Number(lineFrame.getAttribute("x1"));
  const lineRight = Number(lineFrame.getAttribute("x2"));
  const points = host.querySelector(".chart-lines polyline")!.getAttribute("points")!.trim().split(
    /\s+/,
  );
  const firstPoint = points[0].split(",").map(Number);
  const lastPoint = points[points.length - 1].split(",").map(Number);
  assert.ok(Math.abs(firstPoint[0] - lineRight) < 0.001);
  assert.ok(Math.abs(lastPoint[0] - lineLeft) < 0.001);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

function xTitleNodes(host: Element): Element[] {
  return [...host.querySelectorAll(".chart-axes text")].filter((node) => (
    (node.getAttribute("transform") ?? "").indexOf("rotate") === -1
    && !node.classList.contains("chart-offset")
  ));
}

function xTitleLines(host: Element): string[] {
  return xTitleNodes(host).map((node) => node.textContent ?? "");
}

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

function twoValueTable(values: number[], fractions: number[]): TimeSeriesTable {
  const starts = ["2026-04-01", "2026-05-01"];

  return {
    shape: "time_series",
    layerId: "rain",
    units: "mm/month",
    method: "sum",
    rows: starts.map((start, index) => ({
      x: Date.parse(start),
      value: values[index] ?? null,
      label: start,
      validFraction: fractions[index] ?? 1,
      fallbackFraction: null,
      interval: {
        start,
        end: index + 1 < starts.length ? starts[index + 1] : "2026-06-01",
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
