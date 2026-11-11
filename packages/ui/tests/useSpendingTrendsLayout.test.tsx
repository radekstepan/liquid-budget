import { describe, expect, it, beforeAll } from "vitest";
import { render, renderHook } from "@testing-library/react";
import type { BudgetData, Transaction } from "@ynab/logic";
import { computeSpendingTrends } from "@ynab/logic";
import { colorAt } from "../src/chartUtils.js";
import type { ChartLayout } from "../src/StaticChart.js";
import {
  useSpendingTrendsLayout,
  type SpendingTrendsLayoutArgs,
} from "../src/useSpendingTrendsLayout.js";

class MockResizeObserver {
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(el: HTMLElement) {
    if (el.clientWidth === 0) {
      Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    }
    if (el.clientHeight === 0) {
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    }
    this.cb();
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver;
});

function txn(month: string, day: number, payee: string, amount: number, categoryId: number): Transaction {
  return {
    id: Math.abs(amount) * 100 + day,
    accountId: 1,
    categoryId,
    date: `${month}-${String(day).padStart(2, "0")}`,
    payee,
    memo: "",
    amount: String(amount * 100),
    status: "u",
  };
}

function makeTestData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 0 },
    ],
    groups: [
      { id: 1, name: "Everyday Expenses", sort: 0, isCreditCardPayments: false },
      { id: 2, name: "Monthly Bills", sort: 1, isCreditCardPayments: false },
    ],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 20, groupId: 2, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      txn("2026-04", 5, "Whole Foods", -200, 10),
      txn("2026-04", 1, "Landlord", -1200, 20),
      txn("2026-05", 3, "Trader Joes", -250, 10),
      txn("2026-05", 1, "Landlord", -1200, 20),
      txn("2026-06", 8, "Safeway", -180, 10),
      txn("2026-06", 1, "Landlord", -1200, 20),
    ],
    recurring: [],
  };
}

function layoutArgs(overrides: Partial<SpendingTrendsLayoutArgs> = {}): SpendingTrendsLayoutArgs {
  const trends = computeSpendingTrends(makeTestData(), "2026-04", "2026-06", {});
  const colorMap = new Map(trends.constituents.map((c, i) => [c.id, colorAt(i)]));
  return { trends, colorMap, scaleMode: "linear", ...overrides };
}

let latest: ChartLayout | null | undefined;

function Harness({ hookArgs }: { hookArgs: SpendingTrendsLayoutArgs }) {
  const layout = useSpendingTrendsLayout(hookArgs);
  latest = layout.chart;
  return <div ref={layout.chartContainerRef} data-testid="chartbox" />;
}

describe("useSpendingTrendsLayout (ui-split slice 10)", () => {
  it("returns null before the container is measured", () => {
    const { result } = renderHook(() => useSpendingTrendsLayout(layoutArgs()));
    expect(result.current.chart).toBeNull();
    expect(typeof result.current.chartContainerRef).toBe("function");
  });

  it("returns null with no months even once measured", () => {
    const full = layoutArgs();
    const empty = { ...full, trends: { ...full.trends, months: [] } };
    render(<Harness hookArgs={empty} />);
    expect(latest).toBeNull();
  });

  it("lays out one bar per month with axis geometry", () => {
    const hookArgs = layoutArgs();
    render(<Harness hookArgs={hookArgs} />);
    expect(latest).not.toBeNull();
    const chart = latest!;
    expect(chart.W).toBe(800);
    expect(chart.H).toBe(400);
    expect(chart.n).toBe(3);
    expect(chart.monthBars).toHaveLength(3);
    expect(chart.monthBars.map((b) => b.month)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(chart.ticks.length).toBeGreaterThan(0);
    expect(chart.zeroY).toBeGreaterThan(chart.padT);
    expect(chart.zeroY).toBeLessThanOrEqual(chart.H - chart.padB);
    expect(chart.y(0)).toBe(chart.zeroY);
    expect(chart.tickSet instanceof Set).toBe(true);
  });

  it("stacks colored segments inside each bar", () => {
    render(<Harness hookArgs={layoutArgs()} />);
    const chart = latest!;
    for (const bar of chart.monthBars) {
      expect(bar.segments.length).toBeGreaterThan(0);
      for (const seg of bar.segments) {
        expect(seg.width).toBe(chart.barW);
        expect(seg.x).toBe(bar.barX);
        expect(typeof seg.color).toBe("string");
        expect(seg.color.length).toBeGreaterThan(0);
      }
      const heights = bar.segments.reduce((n, s) => n + s.height, 0);
      expect(heights).toBeLessThanOrEqual(bar.totalH + 1e-6);
    }
  });

  it("maps values differently in log mode", () => {
    const linearArgs = layoutArgs();
    render(<Harness hookArgs={linearArgs} />);
    const linearY = latest!.y(100000);

    const logArgs = layoutArgs({ scaleMode: "log" });
    render(<Harness hookArgs={logArgs} />);
    const logY = latest!.y(100000);

    expect(latest).not.toBeNull();
    expect(logY).not.toBe(linearY);
  });
});
