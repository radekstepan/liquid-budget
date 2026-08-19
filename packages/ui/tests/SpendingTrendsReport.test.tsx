import { describe, expect, it, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SpendingTrendsReport } from "../src/SpendingTrendsReport.js";
import type { BudgetData, Transaction } from "@ynab/logic";

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

function txn(
  month: string,
  day: number,
  payee: string,
  amount: number,
  categoryId: number | null = null,
  memo = ""
): Transaction {
  return {
    id: Math.abs(amount) * 100 + day,
    accountId: 1,
    categoryId,
    date: `${month}-${String(day).padStart(2, "0")}`,
    payee,
    memo,
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
      { id: 3, name: "CC Payments", sort: 2, isCreditCardPayments: true },
    ],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 11, groupId: 1, name: "Fuel", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 20, groupId: 2, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 21, groupId: 2, name: "Utilities", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      txn("2026-04", 5, "Whole Foods", -200, 10, "Weekly groceries"),
      txn("2026-04", 10, "Shell", -50, 11, "Gas"),
      txn("2026-04", 1, "Landlord", -1200, 20, "April Rent"),
      txn("2026-05", 3, "Trader Joes", -250, 10, "Groceries"),
      txn("2026-05", 12, "Electric Co", -100, 21, "Electricity"),
      txn("2026-05", 1, "Landlord", -1200, 20, "May Rent"),
      txn("2026-06", 8, "Safeway", -180, 10, "Groceries"),
      txn("2026-06", 15, "Chevron", -60, 11, "Gas"),
      txn("2026-06", 1, "Landlord", -1200, 20, "June Rent"),
    ],
    recurring: [],
  };
}

describe("SpendingTrendsReport", () => {
  it("renders top-level spending by master category with stacked bars and totals", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    expect(screen.getByText("Spending Trends")).toBeInTheDocument();
    expect(screen.getByText("All Categories")).toBeInTheDocument();

    // Summary stats
    expect(screen.getByText("$4,440.00")).toBeInTheDocument(); // Total spent: (200+50+1200) + (250+100+1200) + (180+60+1200) = 1450 + 1550 + 1440 = 4440
    expect(screen.getByText("$1,480.00/mo")).toBeInTheDocument(); // Avg / mo: 4440 / 3 = 1480

    // Master categories listed in breakdown table
    expect(screen.getByText("Monthly Bills")).toBeInTheDocument();
    expect(screen.getByText("Everyday Expenses")).toBeInTheDocument();

    // SVG elements present
    const svg = document.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("drills down to subcategories when a master category is clicked", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Click Everyday Expenses master category row
    const everydayRow = screen.getByText("Everyday Expenses");
    fireEvent.click(everydayRow);

    // Breadcrumb updates
    expect(screen.getByText("All Categories")).toBeInTheDocument();
    expect(screen.getAllByText("Everyday Expenses").length).toBeGreaterThan(0);

    // Constituents now show subcategories
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Fuel")).toBeInTheDocument();

    // Total for Everyday Expenses: 200 + 50 + 250 + 180 + 60 = 740
    expect(screen.getByText("$740.00")).toBeInTheDocument();
  });

  it("drills down to a subcategory to show transaction table", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Drill into Everyday Expenses -> Groceries
    fireEvent.click(screen.getByText("Everyday Expenses"));
    fireEvent.click(screen.getByText("Groceries"));

    // Breadcrumb shows All Categories > Everyday Expenses > Groceries
    expect(screen.getByText("Groceries Transactions")).toBeInTheDocument();

    // Transactions table lists transactions for Groceries
    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    expect(screen.getByText("Trader Joes")).toBeInTheDocument();
    expect(screen.getByText("Safeway")).toBeInTheDocument();
    expect(screen.queryByText("Chevron")).not.toBeInTheDocument(); // Fuel txn excluded
  });

  it("navigates back up using breadcrumb buttons", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Drill down to category
    fireEvent.click(screen.getByText("Everyday Expenses"));
    fireEvent.click(screen.getByText("Groceries"));
    expect(screen.getByText("Groceries Transactions")).toBeInTheDocument();

    // Click Everyday Expenses in breadcrumbs
    const groupCrumb = screen.getByRole("button", { name: "Everyday Expenses" });
    fireEvent.click(groupCrumb);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Fuel")).toBeInTheDocument();

    // Click All Categories in breadcrumbs
    const allCrumb = screen.getByRole("button", { name: "All Categories" });
    fireEvent.click(allCrumb);
    expect(screen.getByText("Monthly Bills")).toBeInTheDocument();
    expect(screen.getByText("Everyday Expenses")).toBeInTheDocument();
  });

  it("filters transactions to a specific month in subcategory view", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Drill to Groceries
    fireEvent.click(screen.getByText("Everyday Expenses"));
    fireEvent.click(screen.getByText("Groceries"));

    // Click on April bar column or month text in SVG
    const aprText = screen.getByText("Apr 2026");
    fireEvent.click(aprText);

    // Transaction list shows filtered state
    const showAllBtn = screen.getByRole("button", { name: "Show All Months" });
    expect(showAllBtn).toBeInTheDocument();
    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    expect(screen.queryByText("Trader Joes")).not.toBeInTheDocument(); // May txn

    // Click Show All Months
    fireEvent.click(showAllBtn);
    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    expect(screen.getByText("Trader Joes")).toBeInTheDocument();
    expect(screen.getByText("Safeway")).toBeInTheDocument();
  });

  it("filters categories via the filter popover", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Open category filter popover
    const filterBtn = screen.getByTitle("Filter included categories");
    fireEvent.click(filterBtn);

    expect(screen.getByText("Filter Categories")).toBeInTheDocument();

    // Click Clear to deselect all categories
    fireEvent.click(screen.getByText("Clear"));
    expect(screen.getByText("No spending data for this timeframe and filter selection.")).toBeInTheDocument();

    // Click Select All
    fireEvent.click(screen.getByText("Select All"));
    expect(screen.queryByText("No spending data for this timeframe and filter selection.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Monthly Bills").length).toBeGreaterThan(0);
  });

  it("renders empty state gracefully when no transactions exist", () => {
    const data = { ...makeTestData(), transactions: [] };
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    expect(screen.getByText("No spending data for this timeframe and filter selection.")).toBeInTheDocument();
  });

  it("handles 12-year (144 months) wide timeframe without overlapping axis labels or bars", () => {
    const data = makeTestData();
    // Add transactions spanning 2014 to 2026 (12 years)
    data.transactions.push(txn("2014-01", 1, "Old Landlord", -1000, 20));
    data.transactions.push(txn("2020-06", 1, "Mid Landlord", -1100, 20));

    render(<SpendingTrendsReport data={data} startMonth="2014-01" endMonth="2026-01" />);

    const svg = document.querySelector("svg.overflow-visible")!;
    expect(svg).not.toBeNull();

    // Verify clipPaths exist for whole-bar rounded corners
    const defs = svg.querySelector("defs");
    expect(defs).not.toBeNull();
    expect(defs!.children.length).toBe(145);

    // Verify that X-axis labels use smart stride (at most 10-12 labels, not all 145)
    const textLabels = Array.from(svg.querySelectorAll("text")).filter(
      (el) => /^\d{4}$/.test(el.textContent?.trim() || "")
    );
    expect(textLabels.length).toBeGreaterThan(1);
    expect(textLabels.length).toBeLessThanOrEqual(12);

    // Verify label spacing is at least 40px apart
    const xPositions = textLabels.map((el) => parseFloat(el.getAttribute("x") || "0")).sort((a, b) => a - b);
    for (let i = 1; i < xPositions.length; i++) {
      expect(xPositions[i]! - xPositions[i - 1]!).toBeGreaterThanOrEqual(40);
    }
  });

  it("shows contextual category filters when drilled down into a master category", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Drill into Everyday Expenses
    fireEvent.click(screen.getByText("Everyday Expenses"));

    // Open filter popover
    const filterBtn = screen.getByTitle("Filter included categories");
    fireEvent.click(filterBtn);

    // Filter popover title shows the current group name
    expect(screen.getByText("Filter: Everyday Expenses")).toBeInTheDocument();

    // Only subcategories of Everyday Expenses are shown
    expect(screen.getAllByText("Groceries").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Fuel").length).toBeGreaterThan(0);
    // Other master categories/subcategories should NOT be present in this contextual filter list
    expect(screen.queryByText("Rent")).not.toBeInTheDocument();
    expect(screen.queryByText("Monthly Bills")).not.toBeInTheDocument();
  });

  it("renders transaction table with standard y-table and alternating row styling", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Drill into Everyday Expenses -> Groceries
    fireEvent.click(screen.getByText("Everyday Expenses"));
    fireEvent.click(screen.getByText("Groceries"));

    const table = document.querySelector("table.y-table");
    expect(table).not.toBeNull();

    const thead = table!.querySelector("thead.y-thead");
    expect(thead).not.toBeNull();

    const rows = table!.querySelectorAll("tbody tr.y-row");
    expect(rows.length).toBe(3);
    // Second row has alt class for alternating row colors
    expect(rows[1]!.classList.contains("alt")).toBe(true);
  });
});
