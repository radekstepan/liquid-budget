import { describe, expect, it, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SpendingTrendsReport } from "../src/SpendingTrendsReport.js";
import { colorAt } from "../src/chartUtils.js";
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
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
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
    expect(screen.getByRole("columnheader", { name: "Master Category" })).toBeInTheDocument();
    expect(screen.getByText("Monthly Bills")).toBeInTheDocument();
    expect(screen.getByText("Everyday Expenses")).toBeInTheDocument();

    // SVG elements present and chart container is overflow-hidden
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

    // Table header now says Category instead of Master Category
    expect(screen.getByRole("columnheader", { name: "Category" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Master Category" })).not.toBeInTheDocument();

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
    const filterBtn = screen.getByRole("button", { name: "Filter included categories" });
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

  it("caps an outsized month bar with a solid cap and a dashed hatch", () => {
    const data = makeTestData();
    data.transactions.push(txn("2026-05", 28, "Landlord", -10000, 20));
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    const svg = document.querySelector("svg.overflow-visible")!;
    // Only the dominant May bar (11200 vs ~1550) is truncated: one hatch + one cap.
    const hatches = svg.querySelectorAll('[data-testid="trunc-hatch"]');
    const caps = svg.querySelectorAll('[data-testid="trunc-cap"]');
    expect(hatches.length).toBe(1);
    expect(caps.length).toBe(1);

    // Cap sits immediately above the hatch, at the top of the bar.
    const hatchY = Number(hatches[0]!.getAttribute("y"));
    const capY = Number(caps[0]!.getAttribute("y"));
    expect(capY).toBe(hatchY - 5);
    expect(Number(caps[0]!.getAttribute("height"))).toBe(5);
    // The cap color is a solid hex (not a gradient/pattern reference).
    expect(caps[0]!.getAttribute("fill")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("caps only the tallest bar with ordinary proportional data", () => {
    const data = makeTestData();
    // Adding 200 in Jun makes Jun 1640 the max: Apr 1450 and May 1550 sit
    // below 95% of 1640, so only the Jun bar is capped.
    data.transactions.push(txn("2026-06", 20, "Safeway", -200, 10));
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    const svg = document.querySelector("svg.overflow-visible")!;
    const caps = svg.querySelectorAll('[data-testid="trunc-cap"]');
    expect(caps.length).toBe(1);
    // The starred month label lives above the capped bar: Jun 2026.
    const capX = Number(caps[0]!.getAttribute("x"));
    const junLabel = Array.from(svg.querySelectorAll("text")).find(
      (t) => t.textContent === "Jun 2026"
    );
    expect(junLabel).not.toBeNull();
    expect(Math.abs(Number(junLabel!.getAttribute("x")) - (capX + 21))).toBeLessThan(30);
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
    expect(Array.from(defs!.children).filter((el) => el.tagName === "clipPath").length).toBe(145);

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
    const filterBtn = screen.getByRole("button", { name: "Filter included categories" });
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

  it("renders an axis break when a single month spikes far above the rest", () => {
    const data = makeTestData();
    data.transactions.push(txn("2026-01", 1, "Landlord", -1200, 20));
    data.transactions.push(txn("2026-02", 1, "Landlord", -1200, 20));
    data.transactions.push(txn("2026-03", 1, "Landlord", -1200, 20));
    data.transactions.push(txn("2026-04", 1, "Landlord", -1200, 20));
    data.transactions.push(txn("2026-05", 28, "Landlord", -50000, 20));
    data.transactions.push(txn("2026-06", 1, "Landlord", -1200, 20));
    render(<SpendingTrendsReport data={data} startMonth="2026-01" endMonth="2026-06" />);

    const svg = document.querySelector("svg.overflow-visible")!;
    // One horizontal break cutout over the max spike.
    expect(svg.querySelectorAll('[data-testid="axis-break"]').length).toBe(1);
    // Compressed top tick label for the spike month.
    expect(screen.getByText("$100K")).toBeInTheDocument();
    // No truncation caps when the axis break is active.
    expect(svg.querySelectorAll('[data-testid="trunc-cap"]').length).toBe(0);
  });

  it("toggles between Linear and Logarithmic chart scale modes", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    const linearBtn = screen.getByRole("button", { name: "Linear" });
    const logBtn = screen.getByRole("button", { name: "Log" });

    expect(linearBtn).toBeInTheDocument();
    expect(logBtn).toBeInTheDocument();

    // Initially linear is active
    expect(linearBtn.classList.contains("is-on")).toBe(true);
    expect(logBtn.classList.contains("is-on")).toBe(false);

    // Switch to Log scale
    fireEvent.click(logBtn);
    expect(logBtn.classList.contains("is-on")).toBe(true);
    expect(linearBtn.classList.contains("is-on")).toBe(false);

    // SVG elements remain properly rendered with log ticks
    const svg = document.querySelector("svg");
    expect(svg).not.toBeNull();

    // Switch back to Linear scale
    fireEvent.click(linearBtn);
    expect(linearBtn.classList.contains("is-on")).toBe(true);
    expect(logBtn.classList.contains("is-on")).toBe(false);
  });

  it("renders negative bars below the zero line and prevents crushing small positive side", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "EQ Bank", kind: "liquid", groupLabel: "Liquid", balance: "50000000", onBudget: true, sort: 0 },
        { id: 2, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 1 },
      ],
      groups: [
        { id: 4, name: "Savings, Investments", sort: 0, isCreditCardPayments: false },
      ],
      categories: [
        { id: 30, groupId: 4, name: "Other Investments", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        // Apr: +$300 spending (contribution)
        { id: 1, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-04-10", payee: "Transfer : Wealthsimple Trade", memo: "deposit", amount: "-30000", status: "c" },
        // May: -$338,269.92 spending (liquidation)
        { id: 2, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-05-15", payee: "Transfer : Wealthsimple Trade", memo: "sell all", amount: "33826992", status: "c" },
      ],
      recurring: [],
    };

    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-05" />);

    expect(screen.queryByText("No spending data for this timeframe and filter selection.")).not.toBeInTheDocument();

    const svg = document.querySelector("svg.overflow-visible")!;
    expect(svg).not.toBeNull();

    // Check zero line (stroke="#b6b6b1")
    const zeroLine = svg.querySelector('line[stroke="#b6b6b1"]')!;
    expect(zeroLine).not.toBeNull();
    const zeroY = parseFloat(zeroLine.getAttribute("y1") || "0");
    // zeroY should be positioned proportionally (not at padT = 16)
    expect(zeroY).toBeGreaterThan(20);
    expect(zeroY).toBeLessThan(350);

    // Negative tick label exists
    const tickTexts = Array.from(svg.querySelectorAll("text")).map((t) => t.textContent?.trim());
    expect(tickTexts.some((t) => t?.startsWith("-$"))).toBe(true);

    // Apr positive bar height is clearly visible (> 1px)
    const rects = Array.from(svg.querySelectorAll("rect"));
    const aprBar = rects.find((r) => {
      const y = parseFloat(r.getAttribute("y") || "0");
      const h = parseFloat(r.getAttribute("height") || "0");
      return Math.abs(y + h - zeroY) < 0.75 && h > 1;
    });
    expect(aprBar).toBeDefined();

    // May negative bar hangs downward from zeroY
    const mayBar = rects.find((r) => {
      const y = parseFloat(r.getAttribute("y") || "0");
      const h = parseFloat(r.getAttribute("height") || "0");
      return Math.abs(y - zeroY) < 0.75 && h > 1;
    });
    expect(mayBar).toBeDefined();
  });

  it("renders signed values under Spending column in category drilldown table", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "EQ Bank", kind: "liquid", groupLabel: "Liquid", balance: "50000000", onBudget: true, sort: 0 },
        { id: 2, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 1 },
      ],
      groups: [
        { id: 4, name: "Savings, Investments", sort: 0, isCreditCardPayments: false },
      ],
      categories: [
        { id: 30, groupId: 4, name: "Other Investments", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        // Apr: +$300 contribution
        { id: 1, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-04-10", payee: "Transfer : Wealthsimple Trade", memo: "deposit", amount: "-30000", status: "c" },
        // May: -$338,269.92 liquidation
        { id: 2, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-05-15", payee: "Transfer : Wealthsimple Trade", memo: "sell all", amount: "33826992", status: "c" },
      ],
      recurring: [],
    };

    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-05" />);

    // Drill down: Savings, Investments -> Other Investments
    fireEvent.click(screen.getByText("Savings, Investments"));
    fireEvent.click(screen.getByText("Other Investments"));

    // Table header should be Spending, not Amount
    expect(screen.getByRole("columnheader", { name: "Spending" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Amount" })).not.toBeInTheDocument();

    // Table cells should show signed values
    expect(screen.getByText("$300.00")).toBeInTheDocument();
    expect(screen.getByText("-$338,269.92")).toBeInTheDocument();
    expect(screen.queryByText("$338,269.92")).not.toBeInTheDocument();
  });

  it("handles net-zero deposit and withdrawal in a multi-month period without false empty state", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 0 },
        { id: 2, name: "Savings Account", kind: "offbudget", groupLabel: "Savings", balance: "0", onBudget: false, sort: 1 },
      ],
      groups: [
        { id: 1, name: "Savings", sort: 0, isCreditCardPayments: false },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Emergency Fund", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        // Apr: +$500 contribution
        { id: 1, accountId: 1, transferAccountId: 2, categoryId: 10, date: "2026-04-01", payee: "Transfer : Savings", memo: "", amount: "-50000", status: "c" },
        // May: net zero ($200 deposit, $200 withdrawal)
        { id: 2, accountId: 1, transferAccountId: 2, categoryId: 10, date: "2026-05-05", payee: "Transfer : Savings", memo: "", amount: "-20000", status: "c" },
        { id: 3, accountId: 1, transferAccountId: 2, categoryId: 10, date: "2026-05-10", payee: "Transfer : Savings", memo: "", amount: "20000", status: "c" },
      ],
      recurring: [],
    };

    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-05" />);

    expect(screen.queryByText("No spending data for this timeframe and filter selection.")).not.toBeInTheDocument();
    expect(screen.getAllByText("$500.00").length).toBeGreaterThan(0);
  });

  it("renders an axis break with jagged lines for negative withdrawal spikes", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "EQ Bank", kind: "liquid", groupLabel: "Liquid", balance: "50000000", onBudget: true, sort: 0 },
        { id: 2, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 1 },
      ],
      groups: [
        { id: 4, name: "Savings, Investments", sort: 0, isCreditCardPayments: false },
      ],
      categories: [
        { id: 30, groupId: 4, name: "Other Investments", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        { id: 101, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-01-01", payee: "Transfer", memo: "", amount: "10000", status: "c" },
        { id: 102, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-02-01", payee: "Transfer", memo: "", amount: "10000", status: "c" },
        { id: 103, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-03-01", payee: "Transfer", memo: "", amount: "10000", status: "c" },
        { id: 104, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-04-01", payee: "Transfer", memo: "", amount: "10000", status: "c" },
        { id: 105, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-05-01", payee: "Transfer", memo: "", amount: "5000000", status: "c" },
        { id: 106, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-06-01", payee: "Transfer", memo: "", amount: "10000", status: "c" },
      ],
      recurring: [],
    };
    render(<SpendingTrendsReport data={data} startMonth="2026-01" endMonth="2026-06" />);

    const svg = document.querySelector("svg.overflow-visible")!;
    expect(svg.querySelectorAll('[data-testid="axis-break"]').length).toBeGreaterThan(0);
  });

  it("hides the average dashed line and label when it falls within the axis break band", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "10000000", onBudget: true, sort: 0 },
      ],
      groups: [
        { id: 1, name: "Housing", sort: 0, isCreditCardPayments: false },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        // 5 months of $350 spending, 1 month of $650 spending => inliers: $350 (breakTop: $400), avg = $400 (falls in break)
        { id: 1, accountId: 1, transferAccountId: null, categoryId: 10, date: "2026-01-15", payee: "Landlord", memo: "", amount: "-35000", status: "c" },
        { id: 2, accountId: 1, transferAccountId: null, categoryId: 10, date: "2026-02-15", payee: "Landlord", memo: "", amount: "-35000", status: "c" },
        { id: 3, accountId: 1, transferAccountId: null, categoryId: 10, date: "2026-03-15", payee: "Landlord", memo: "", amount: "-35000", status: "c" },
        { id: 4, accountId: 1, transferAccountId: null, categoryId: 10, date: "2026-04-15", payee: "Landlord", memo: "", amount: "-35000", status: "c" },
        { id: 5, accountId: 1, transferAccountId: null, categoryId: 10, date: "2026-05-15", payee: "Landlord", memo: "", amount: "-35000", status: "c" },
        { id: 6, accountId: 1, transferAccountId: null, categoryId: 10, date: "2026-06-15", payee: "Landlord", memo: "", amount: "-65000", status: "c" },
      ],
      recurring: [],
    };
    render(<SpendingTrendsReport data={data} startMonth="2026-01" endMonth="2026-06" />);

    const svg = document.querySelector("svg.overflow-visible")!;
    // Axis break exists
    expect(svg.querySelectorAll('[data-testid="axis-break"]').length).toBeGreaterThan(0);
    // Average dashed line is hidden because it falls into the jagged break section
    const avgLine = svg.querySelector('line[stroke-dasharray="4 3"]');
    expect(avgLine).toBeNull();
    // Avg text label inside chart is still shown
    expect(svg.textContent).toContain("Avg: $400");
  });

  it("handles mouse hover smoothly when drilled into a category without breaking transaction register", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Drill into Everyday Expenses -> Groceries
    fireEvent.click(screen.getByText("Everyday Expenses"));
    fireEvent.click(screen.getByText("Groceries"));

    expect(screen.getByText("Groceries Transactions")).toBeInTheDocument();
    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    expect(screen.getByText("Trader Joes")).toBeInTheDocument();
    expect(screen.getByText("Safeway")).toBeInTheDocument();

    // Hover over the chart container
    const chartArea = document.querySelector(".relative.min-h-\\[220px\\]")!;
    expect(chartArea).not.toBeNull();

    // Trigger mousemove on chart container
    fireEvent.mouseMove(chartArea, { clientX: 200, clientY: 100 });

    // Transactions table remains properly rendered
    expect(screen.getByText("Groceries Transactions")).toBeInTheDocument();
    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
  });

  it("resets drilldown to root All Categories when resetKey changes", () => {
    const data = makeTestData();
    const { rerender } = render(
      <SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" resetKey={0} />
    );

    // Drill into Everyday Expenses -> Groceries
    fireEvent.click(screen.getByText("Everyday Expenses"));
    fireEvent.click(screen.getByText("Groceries"));
    expect(screen.getByText("Groceries Transactions")).toBeInTheDocument();

    // Rerender with incremented resetKey
    rerender(
      <SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" resetKey={1} />
    );

    // Should return to root All Categories with Master Category table
    expect(screen.queryByText("Groceries Transactions")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Master Category" })).toBeInTheDocument();
    expect(screen.getByText("Everyday Expenses")).toBeInTheDocument();
    expect(screen.getByText("Monthly Bills")).toBeInTheDocument();
  });

  it("calls onSelectTransaction when clicking a transaction row in CategoryTransactionsTable", () => {
    const data = makeTestData();
    const onSelectTransaction = vi.fn();
    render(
      <SpendingTrendsReport
        data={data}
        startMonth="2026-04"
        endMonth="2026-06"
        onSelectTransaction={onSelectTransaction}
      />
    );

    // Drill down: Everyday Expenses -> Groceries
    fireEvent.click(screen.getByText("Everyday Expenses"));
    fireEvent.click(screen.getByText("Groceries"));

    // Find and click Whole Foods transaction row
    const row = screen.getByText("Whole Foods").closest("tr")!;
    expect(row).toBeInTheDocument();
    fireEvent.click(row);

    expect(onSelectTransaction).toHaveBeenCalledTimes(1);
    expect(onSelectTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        payee: "Whole Foods",
        categoryId: 10,
      })
    );
  });

  it("shows breakdown segments in hover popover when multiple categories exist in a month", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    const chartArea = document.querySelector(".relative.min-h-\\[220px\\]")!;
    // Hover over the first month (April 2026, which has Everyday Expenses and Monthly Bills)
    fireEvent.mouseMove(chartArea, { clientX: 100, clientY: 100 });

    const tip = document.querySelector(".y-tip")!;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain("Apr 2026");
    expect(tip.textContent).toContain("Total: $1,450.00");
    // Multi-category month should show individual segment lines and percentages
    expect(tip.textContent).toContain("Monthly Bills");
    expect(tip.textContent).toContain("$1,200.00");
    expect(tip.textContent).toContain("(83%)");
    expect(tip.textContent).toContain("Everyday Expenses");
    expect(tip.textContent).toContain("$250.00");
    expect(tip.textContent).toContain("(17%)");
  });

  it("does not duplicate info or show 100 percent breakdown line in hover popover when only 1 category exists", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Drill down to a single category: Everyday Expenses -> Groceries
    fireEvent.click(screen.getByText("Everyday Expenses"));
    fireEvent.click(screen.getByText("Groceries"));

    const chartArea = document.querySelector(".relative.min-h-\\[220px\\]")!;
    // Hover over April 2026 (only Groceries = $200)
    fireEvent.mouseMove(chartArea, { clientX: 100, clientY: 100 });

    const tip = document.querySelector(".y-tip")!;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain("Apr 2026");
    expect(tip.textContent).toContain("Total: $200.00");
    // Should NOT show the redundant segment breakdown line with 100%
    expect(tip.textContent).not.toContain("100%");
    expect(tip.textContent).not.toContain("(100%)");
    // Only total is shown in tooltip, not a duplicate Groceries row
    const tipLabels = tip.querySelectorAll(".flex.items-center.justify-between");
    expect(tipLabels.length).toBe(0);
  });

  it("renders em-dash for % Share when overall total is negative (BUG-37)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Budget", balance: "500000", onBudget: true, sort: 0 },
      ],
      groups: [
        { id: 1, name: "Groceries Group", sort: 0, isCreditCardPayments: false },
        { id: 2, name: "Returns Group", sort: 1, isCreditCardPayments: false },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 20, groupId: 2, name: "Electronics", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        // $100 spending
        { id: 1, accountId: 1, categoryId: 10, date: "2026-04-05", payee: "Supermarket", memo: "", amount: "-10000", status: "c" },
        // $200 refund
        { id: 2, accountId: 1, categoryId: 20, date: "2026-04-10", payee: "Store Refund", memo: "", amount: "20000", status: "c" },
      ],
    };

    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-04" />);

    // Table rows should display "—" in the % Share column instead of negative or inverted percentages
    const cells = document.querySelectorAll("tbody tr td:last-child");
    expect(cells.length).toBe(2);
    cells.forEach((cell) => {
      expect(cell.textContent?.trim()).toBe("—");
    });
  });

  it("highlights chart bar segments for the hovered category and dims others when hovering over table row", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Initially, all segments are rendered without dimming
    const barSegments = document.querySelectorAll("g[clip-path] > g");
    expect(barSegments.length).toBeGreaterThan(0);
    barSegments.forEach((g) => {
      expect((g as HTMLElement).style.opacity).toBe("1");
    });

    // Hover over "Everyday Expenses" master category row in table
    const everydayRow = screen.getByText("Everyday Expenses").closest("tr")!;
    fireEvent.mouseEnter(everydayRow);

    // Matching segments should have opacity 1 and fillOpacity 1, other segments should have opacity 0.2
    let dimmedCount = 0;
    let highlightedCount = 0;
    barSegments.forEach((g) => {
      const el = g as HTMLElement;
      if (el.style.opacity === "0.2") {
        dimmedCount++;
      } else if (el.style.opacity === "1") {
        highlightedCount++;
        const rect = el.querySelector("rect")!;
        expect(rect.getAttribute("fill-opacity")).toBe("1");
      }
    });
    expect(highlightedCount).toBeGreaterThan(0);
    expect(dimmedCount).toBeGreaterThan(0);

    // Mouse leave table row resets all back to normal
    fireEvent.mouseLeave(everydayRow);
    barSegments.forEach((g) => {
      expect((g as HTMLElement).style.opacity).toBe("1");
      const rect = g.querySelector("rect")!;
      expect(rect.getAttribute("fill-opacity")).toBe("0.88");
    });
  });

  it("renders equal-dollar segments at equal heights when a month mixes positive and negative segments", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 0 },
      ],
      groups: [
        { id: 1, name: "Housing", sort: 0, isCreditCardPayments: false },
        { id: 2, name: "Needs", sort: 1, isCreditCardPayments: false },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 20, groupId: 2, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        // April: Housing $1,000, Needs -$300 (a $500 refund outweighs $200 spending)
        { id: 1, accountId: 1, categoryId: 10, date: "2026-04-01", payee: "Landlord", memo: "", amount: "-100000", status: "c" },
        { id: 2, accountId: 1, categoryId: 20, date: "2026-04-05", payee: "Grocer", memo: "", amount: "-20000", status: "c" },
        { id: 3, accountId: 1, categoryId: 20, date: "2026-04-10", payee: "Refund", memo: "", amount: "50000", status: "c" },
        // May: identical Housing $1,000, Needs +$300 (all-positive month)
        { id: 4, accountId: 1, categoryId: 10, date: "2026-05-01", payee: "Landlord", memo: "", amount: "-100000", status: "c" },
        { id: 5, accountId: 1, categoryId: 20, date: "2026-05-05", payee: "Grocer", memo: "", amount: "-30000", status: "c" },
      ],
      recurring: [],
    };

    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-05" />);
    fireEvent.click(screen.getByRole("button", { name: "Linear" }));

    const svg = document.querySelector("svg.overflow-visible")!;
    const zeroY = parseFloat(
      svg.querySelector('line[stroke="#b6b6b1"]')!.getAttribute("y1") || "0"
    );

    // Segment rects carry fill-opacity; clip/selection rects do not.
    const segRects = Array.from(svg.querySelectorAll("rect[fill-opacity]"));
    // Constituents sort by total desc: Housing ($2,000) first, Needs ($0) second.
    const housingFill = colorAt(0).toLowerCase();
    const needsFill = colorAt(1).toLowerCase();
    const housingRects = segRects.filter(
      (r) => r.getAttribute("fill")?.toLowerCase() === housingFill
    );
    expect(housingRects.length).toBe(2);

    // Identical $1,000 Housing spending must render at identical heights.
    const heights = housingRects.map((r) => parseFloat(r.getAttribute("height") || "0"));
    expect(Math.abs(heights[0]! - heights[1]!)).toBeLessThan(0.01);

    // The negative Needs slice in April stacks downward from the zero line.
    const needsRects = segRects.filter(
      (r) => r.getAttribute("fill")?.toLowerCase() === needsFill
    );
    expect(needsRects.length).toBe(2);
    const aprilX = Math.min(...segRects.map((r) => parseFloat(r.getAttribute("x") || "0")));
    const aprilNeeds = needsRects.find(
      (r) => parseFloat(r.getAttribute("x") || "0") === aprilX
    )!;
    expect(parseFloat(aprilNeeds.getAttribute("y") || "0")).toBeGreaterThanOrEqual(zeroY - 0.75);
    expect(parseFloat(aprilNeeds.getAttribute("height") || "0")).toBeGreaterThan(1);
  });

  it("highlights subcategory segments when hovering over subcategory row in drilled group view", () => {
    const data = makeTestData();
    render(<SpendingTrendsReport data={data} startMonth="2026-04" endMonth="2026-06" />);

    // Drill into Everyday Expenses
    fireEvent.click(screen.getByText("Everyday Expenses"));

    const barSegments = document.querySelectorAll("g[clip-path] > g");
    expect(barSegments.length).toBeGreaterThan(0);

    // Hover over "Groceries" row in subcategory table
    const groceriesRow = screen.getByText("Groceries").closest("tr")!;
    fireEvent.mouseEnter(groceriesRow);

    let dimmedCount = 0;
    let highlightedCount = 0;
    barSegments.forEach((g) => {
      const el = g as HTMLElement;
      if (el.style.opacity === "0.2") {
        dimmedCount++;
      } else if (el.style.opacity === "1") {
        highlightedCount++;
        const rect = el.querySelector("rect")!;
        expect(rect.getAttribute("fill-opacity")).toBe("1");
      }
    });
    expect(highlightedCount).toBeGreaterThan(0);
    expect(dimmedCount).toBeGreaterThan(0);

    // Mouse leave resets
    fireEvent.mouseLeave(groceriesRow);
    barSegments.forEach((g) => {
      expect((g as HTMLElement).style.opacity).toBe("1");
    });
  });
});

