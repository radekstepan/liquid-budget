import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SpendingTrendsResult } from "@ynab/logic";
import { StaticChart, type ChartLayout } from "../src/StaticChart.js";

function trends(overrides: Partial<SpendingTrendsResult> = {}): SpendingTrendsResult {
  return {
    months: [],
    constituents: [],
    total: 0,
    avgPerMonth: 12000,
    maxMonthSpend: 0,
    minMonthSpend: 0,
    drillLevel: "all",
    currentGroupId: null,
    currentGroupName: null,
    currentCategoryId: null,
    currentCategoryName: null,
    ...overrides,
  };
}

function layout(overrides: Partial<ChartLayout> = {}): ChartLayout {
  return {
    W: 400,
    H: 300,
    padL: 58,
    padR: 18,
    padT: 16,
    padB: 32,
    innerW: 324,
    innerH: 252,
    y: (v: number) => 200 - v / 1000,
    zeroY: 200,
    ticks: [{ v: 0, grid: true }],
    colW: 60,
    barW: 30,
    cornerRadius: 2,
    n: 2,
    monthBars: [
      {
        month: "2024-01",
        monthTotal: 50000,
        totalH: 50,
        barTopY: 150,
        cx: 100,
        barX: 85,
        barW: 30,
        colW: 60,
        colX: 70,
        segments: [
          {
            id: 7,
            name: "Groceries",
            amount: 50000,
            x: 85,
            y: 150,
            width: 30,
            height: 50,
            color: "#123456",
            neg: false,
            truncated: false,
          },
        ],
      },
    ],
    avgY: null,
    avgInBreak: false,
    hasBreak: false,
    posBreak: null,
    negBreak: null,
    tickSet: new Set([0]),
    ...overrides,
  };
}

function renderChart(chartOverrides: Partial<ChartLayout> = {}, trendsOverrides: Partial<SpendingTrendsResult> = {}) {
  const onDrillSegment = vi.fn();
  const onToggleMonth = vi.fn();
  render(
    <StaticChart
      chart={layout(chartOverrides)}
      gid="test"
      selectedMonth={null}
      trends={trends(trendsOverrides)}
      colorMap={new Map()}
      onDrillSegment={onDrillSegment}
      onToggleMonth={onToggleMonth}
    />
  );
  return { onDrillSegment, onToggleMonth };
}

describe("StaticChart (ui-split slice 6)", () => {
  it("renders month labels and segment fills", () => {
    renderChart();
    expect(screen.getByText("Jan 2024")).toBeDefined();
    expect(document.querySelector('rect[fill="#123456"]')).not.toBeNull();
  });

  it("drills on segment click outside category level", () => {
    const { onDrillSegment, onToggleMonth } = renderChart();
    fireEvent.click(document.querySelector('rect[fill="#123456"]')!);
    expect(onDrillSegment).toHaveBeenCalledTimes(1);
    expect(onDrillSegment).toHaveBeenCalledWith(7);
    expect(onToggleMonth).not.toHaveBeenCalled();
  });

  it("toggles the month at category drill level", () => {
    const { onDrillSegment, onToggleMonth } = renderChart({}, { drillLevel: "category" });
    fireEvent.click(document.querySelector('rect[fill="#123456"]')!);
    expect(onToggleMonth).toHaveBeenCalledTimes(1);
    expect(onToggleMonth).toHaveBeenCalledWith("2024-01");
    expect(onDrillSegment).not.toHaveBeenCalled();
  });

  it("renders the average line when in range", () => {
    renderChart({ avgY: 100 });
    expect(screen.getByText("Avg: $120.00")).toBeDefined();
  });

  it("renders a truncation cap for narrow bars", () => {
    renderChart({
      barW: 6,
      monthBars: [
        {
          ...layout().monthBars[0]!,
          barW: 6,
          segments: [{ ...layout().monthBars[0]!.segments[0]!, truncated: true }],
        },
      ],
    });
    expect(screen.getByTestId("trunc-cap")).toBeDefined();
  });
});
