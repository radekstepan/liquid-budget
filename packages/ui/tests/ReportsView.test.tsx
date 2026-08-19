import { describe, expect, it, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReportsView } from "../src/ReportsView.js";
import type { BudgetData, Transaction } from "@ynab/logic";
import { pickFromOpenDropdownByValue } from "./dropdown.js";

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

function findPanel(title: string) {
  const matches = screen.getAllByText(title);
  const head = matches.find((el) => el.closest(".y-panel")) ?? matches[0];
  return head?.closest(".y-panel");
}

function clickTab(label: string) {
  const tab = screen.getByRole("button", { name: label });
  fireEvent.click(tab);
}

// Regression guard: the chart panels' body div (sibling of .y-panel-head)
// must be a flex column so the `flex-1` chart area actually stretches. If
// the body is a plain block, `flex-1` on the child is a no-op and the
// measured chart div collapses to content height (which depends on the
// chart rendering) — a deadlock that leaves the tabs blank in a real
// browser even though a unit-test ResizeObserver mock fakes dimensions.
function expectPanelBodyIsFlexColumn(panel: Element) {
  const head = panel.querySelector(".y-panel-head");
  expect(head).toBeTruthy();
  const body = head?.nextElementSibling ?? null;
  expect(body).toBeTruthy();
  const cls = (body as Element).className ?? "";
  expect(cls).toContain("flex");
  expect(cls).toContain("flex-col");
}

function txn(
  month: string,
  day: number,
  payee: string,
  amount: number,
  categoryId: number | null = null
): Transaction {
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

function makeData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
    ],
    groups: [],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      txn("2026-04", 1, "Payroll", 3000),
      txn("2026-04", 5, "Groceries", -200, 10),
      txn("2026-04", 10, "Shop A", -300, 11),
      txn("2026-05", 1, "Payroll", 3000),
      txn("2026-05", 5, "Groceries", -100, 10),
      txn("2026-05", 12, "Shop B", -150, null),
      txn("2026-06", 1, "Payroll", 3000),
      txn("2026-06", 5, "Groceries", -50, 10),
    ],
    recurring: [],
  };
}

function renderView(overrides: Record<string, unknown> = {}) {
  const props = {
    data: makeData(),
    month: "2026-06",
    onPrev: () => {},
    onNext: () => {},
    ...overrides,
  } as Parameters<typeof ReportsView>[0];
  render(<ReportsView {...props} />);
}

describe("ReportsView", () => {
  it("renders the toolbar, tabs, math strip, and Top Payees on Overview", () => {
    renderView();
    expect(screen.getByText("Reports")).toBeInTheDocument();
    // Tabs include the four report pages.
    for (const tab of ["Overview", "Spending Trends", "Spending by Category", "Net Worth"]) {
      expect(screen.getByRole("button", { name: tab })).toBeInTheDocument();
    }
    // Math strip cells.
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Expenses")).toBeInTheDocument();
    expect(screen.getByText("Net")).toBeInTheDocument();
    // Overview panel — Top Payees only.
    const topPanel = findPanel("Top Payees")!;
    expect(topPanel).toBeTruthy();
    expect(screen.queryByText("Net Worth", { selector: ".y-panel-head" })).not.toBeInTheDocument();
  });

  it("Spending Trends tab renders the stacked chart and breadcrumb navigation", () => {
    renderView();
    clickTab("Spending Trends");
    const panel = findPanel("Spending Trends")!;
    expect(panel).toBeTruthy();
    expectPanelBodyIsFlexColumn(panel);
    expect(within(panel).getByText("All Categories")).toBeInTheDocument();
    expect(panel.querySelector("svg")).not.toBeNull();
  });

  it("totals income and expenses across the default range", () => {
    renderView();
    expect(screen.getByText("$9,000.00")).toBeInTheDocument();
    expect(screen.getByText("-$800.00")).toBeInTheDocument();
    expect(screen.getByText("$8,200.00")).toBeInTheDocument();
  });

  it("re-totals when the From month is narrowed", () => {
    renderView();
    pickFromOpenDropdownByValue(/from month/i, "5");
    expect(screen.getByText("$3,000.00")).toBeInTheDocument();
    expect(screen.getByText("-$50.00")).toBeInTheDocument();
    expect(screen.getByText("$2,950.00")).toBeInTheDocument();
  });

  it("swaps From/To when From is after To", () => {
    renderView();
    pickFromOpenDropdownByValue(/from month/i, "5");
    pickFromOpenDropdownByValue(/to month/i, "3");
    // The swap keeps the full range, so totals are unchanged.
    expect(screen.getByText("$9,000.00")).toBeInTheDocument();
  });

  it("provides 2-field selectors for month and year on both From and To", () => {
    renderView();
    expect(screen.getByRole("button", { name: /from month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /from year/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /to month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /to year/i })).toBeInTheDocument();
  });

  it("shows top payees sorted by spend on Overview", () => {
    renderView();
    const scope = within(findPanel("Top Payees")!);
    expect(scope.getByText("Groceries")).toBeInTheDocument();
    expect(scope.getByText("$350.00")).toBeInTheDocument();
    expect(scope.getByText("Shop A")).toBeInTheDocument();
    expect(scope.getByText("Shop B")).toBeInTheDocument();
    expect(scope.getByText("$150.00")).toBeInTheDocument();
  });

  it("Spending tab shows sorted bars with percents", () => {
    renderView();
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    expectPanelBodyIsFlexColumn(panel);
    const scope = within(panel);
    // Groceries ($350, 54%) is top, Rent ($300, 46%) second.
    const names = scope.getAllByText(/Groceries|Rent/).map((el) => el.textContent);
    expect(names[0]).toBe("Groceries");
    expect(names[1]).toBe("Rent");
    expect(scope.getByText("54%")).toBeInTheDocument();
    expect(scope.getByText("46%")).toBeInTheDocument();
  });

  it("Spending by Category tab toggles between Bars and Donut view modes", () => {
    renderView();
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    expect(panel).toBeTruthy();
    expectPanelBodyIsFlexColumn(panel);

    const barsBtn = within(panel).getByRole("button", { name: "Bars" });
    const donutBtn = within(panel).getByRole("button", { name: "Donut" });
    expect(barsBtn).toBeInTheDocument();
    expect(donutBtn).toBeInTheDocument();

    // Default is Bars view with bar tracks
    expect(panel.querySelectorAll(".y-bar-track").length).toBeGreaterThan(0);
    expect(panel.querySelector("svg")).toBeNull();

    // Toggle to Donut view
    fireEvent.click(donutBtn);
    expect(panel.querySelector("svg")).not.toBeNull();
    expect(within(panel).getByText("TOTAL")).toBeInTheDocument();
    expect(within(panel).getByText("Groceries")).toBeInTheDocument();
    expect(within(panel).getByText("Rent")).toBeInTheDocument();

    // Toggle back to Bars view
    fireEvent.click(barsBtn);
    expect(panel.querySelector("svg")).toBeNull();
    expect(panel.querySelectorAll(".y-bar-track").length).toBeGreaterThan(0);
  });

  it("Net Worth tab renders the SVG line/area graph with correct assets and debts", () => {
    const data: BudgetData = {
      ...makeData(),
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "820000", onBudget: true, sort: 0 },
        { id: 2, name: "Home Value", kind: "offbudget", groupLabel: "Property", balance: "50000000", onBudget: false, sort: 1 },
        { id: 3, name: "Mortgage Debt", kind: "offbudget", groupLabel: "Property", balance: "-30000000", onBudget: false, sort: 2 },
      ],
    };
    renderView({ data });
    clickTab("Net Worth");
    const panel = findPanel("Net Worth")!;
    expect(panel).toBeTruthy();
    expectPanelBodyIsFlexColumn(panel);
    const svg = panel.querySelector("svg");
    expect(svg).not.toBeNull();
    // Chart should contain rectangles for assets/debts bars
    expect(svg!.querySelectorAll("rect").length).toBeGreaterThan(0);
    // Chart should contain paths for net line and area
    expect(svg!.querySelectorAll("path").length).toBe(2);
  });

  it("Net Worth tab toggles between Linear and Log scale modes", () => {
    const data: BudgetData = {
      ...makeData(),
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "820000", onBudget: true, sort: 0 },
        { id: 2, name: "Home Value", kind: "offbudget", groupLabel: "Property", balance: "50000000", onBudget: false, sort: 1 },
        { id: 3, name: "Mortgage Debt", kind: "offbudget", groupLabel: "Property", balance: "-30000000", onBudget: false, sort: 2 },
      ],
    };
    renderView({ data });
    clickTab("Net Worth");
    const panel = findPanel("Net Worth")!;
    expect(panel).toBeTruthy();

    const linearBtn = within(panel).getByRole("button", { name: "Linear" });
    const logBtn = within(panel).getByRole("button", { name: "Log" });
    expect(linearBtn).toBeInTheDocument();
    expect(logBtn).toBeInTheDocument();

    // Toggle to Log
    fireEvent.click(logBtn);
    expect(panel.querySelector("svg")).not.toBeNull();
    // Grid lines and decade ticks should render in log mode
    expect(within(panel).getByText("$100K")).toBeInTheDocument();
    expect(within(panel).getByText("-$100K")).toBeInTheDocument();

    // Toggle back to Linear
    fireEvent.click(linearBtn);
    expect(panel.querySelector("svg")).not.toBeNull();
  });

  it("Net Worth bars stay within the chart vertical bounds (y >= 10)", () => {
    const data: BudgetData = {
      ...makeData(),
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "9500000", onBudget: true, sort: 0 },
      ],
    };
    renderView({ data });
    clickTab("Net Worth");
    const panel = findPanel("Net Worth")!;
    const svg = panel.querySelector("svg")!;
    const rects = Array.from(svg.querySelectorAll("rect"));
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      const yVal = parseFloat(rect.getAttribute("y") || "0");
      // y must not be above the top padding (padT = 10)
      expect(yVal).toBeGreaterThanOrEqual(10);
    }
  });

  it("Net Worth horizontal axis labels do not overlap adjacent months in 14-month view", () => {
    const data: BudgetData = {
      ...makeData(),
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 0 },
      ],
    };
    renderView({ data, selectedRange: "12m" });
    clickTab("Net Worth");
    const panel = findPanel("Net Worth")!;
    const svg = panel.querySelector("svg")!;
    // Horizontal axis labels match month text like "Jan 2026", "Feb 2026", etc.
    const textEls = Array.from(svg.querySelectorAll("text")).filter(
      (el) => /^[A-Z][a-z]{2} \d{4}$/.test(el.textContent?.trim() || "")
    );
    expect(textEls.length).toBeGreaterThan(1);
    const xCoords = textEls
      .map((el) => parseFloat(el.getAttribute("x") || "0"))
      .sort((a, b) => a - b);
    // Verify that consecutive X-axis label positions have adequate spacing
    for (let i = 1; i < xCoords.length; i++) {
      expect(xCoords[i]! - xCoords[i - 1]!).toBeGreaterThanOrEqual(30);
    }
  });

  it("Spending by Category in Donut mode draws slices as explicit arc paths so tiny slices cannot render a dash 'bow'", () => {
    // "Fees" is a tiny share — the slice whose sub-pixel stroke-dasharray used
    // to rasterize as a ragged multi-colour sliver at the ring seam.
    const data = makeData();
    data.categories.push({
      id: 12,
      groupId: 1,
      name: "Fees",
      sort: 2,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: null,
    });
    data.transactions.push(txn("2026-06", 20, "Stamps", -1, 12));
    renderView({ data });
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    const donutBtn = within(panel).getByRole("button", { name: "Donut" });
    fireEvent.click(donutBtn);

    const svg = panel.querySelector("svg")!;
    const circles = svg.querySelectorAll("circle");
    const paths = svg.querySelectorAll("path");
    // Wedges are explicit <path> arcs; the only <circle> left is the background fill.
    expect(circles.length).toBe(1);
    expect(paths.length).toBe(3);
    // No slice may use stroke-dasharray/dashoffset — the source of the "bow".
    for (const c of Array.from(circles)) {
      expect(c.getAttribute("stroke-dasharray")).toBeNull();
      expect(c.getAttribute("stroke-dashoffset")).toBeNull();
    }
    // Each wedge closes along the ring's inner edge: its path data must contain
    // an arc drawn in the reverse (sweep 0) direction. A missing/incorrectly
    // swept inner arc renders slices as an "outer arc with no inner band".
    for (const p of Array.from(paths)) {
      const d = p.getAttribute("d");
      expect(d).toMatch(/A [\d.]+ [\d.]+ 0 [01] 0 /);
    }
  });

  it("shows the empty state when there are no transactions", () => {
    renderView({ data: { ...makeData(), transactions: [] } });
    expect(screen.getAllByText("No data for this timeframe.").length).toBeGreaterThan(0);
  });

  it("does not include future years beyond the dataset/current year in the year selector", () => {
    const data: BudgetData = {
      ...makeData(),
      transactions: [
        txn("2024-05", 1, "Groceries", -50, 10),
        txn("2025-06", 1, "Groceries", -50, 10),
        txn("2026-04", 1, "Groceries", -50, 10),
      ],
    };
    renderView({ data });

    const fromYearBtn = screen.getByRole("button", { name: /from year/i });
    expect(fromYearBtn).toBeInTheDocument();
    // Years 2027..2031 must NOT be in the document
    expect(screen.queryByText("2027")).not.toBeInTheDocument();
    expect(screen.queryByText("2028")).not.toBeInTheDocument();
    expect(screen.queryByText("2031")).not.toBeInTheDocument();
  });

  it("includes categorized transfers in spending and expenses", () => {
    const data: BudgetData = {
      ...makeData(),
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget", balance: "500000", onBudget: true, sort: 0 },
        { id: 2, name: "RRSP", kind: "offbudget", groupLabel: "Investments", balance: "100000", onBudget: false, sort: 1 },
      ],
      categories: [
        { id: 20, groupId: 1, name: "Retirement", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      transactions: [
        {
          id: 1,
          accountId: 1,
          transferAccountId: 2,
          categoryId: 20,
          date: "2026-06-15",
          payee: "Transfer : RRSP",
          memo: "Savings",
          amount: "-50000",
          status: "c",
        },
      ],
    };
    renderView({ data });

    // Overview expenses must reflect the $500 transfer to RRSP
    expect(screen.getAllByText("-$500.00").length).toBeGreaterThanOrEqual(1);

    // Spending tab must show Retirement category
    clickTab("Spending by Category");
    expect(screen.getByText("Retirement")).toBeInTheDocument();
    expect(screen.getAllByText("$500.00").length).toBeGreaterThanOrEqual(1);
  });
});

