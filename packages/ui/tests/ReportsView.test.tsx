import { describe, expect, it, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReportsView } from "../src/ReportsView.js";
import type { BudgetData, Transaction } from "@ynab/logic";
import { openDropdown, pickFromOpenDropdownByValue } from "./dropdown.js";

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
    groups: [
      { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
    ],
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
  it("renders the toolbar, three tabs, and Spending Trends by default", () => {
    renderView();
    expect(screen.getByText("Reports")).toBeInTheDocument();
    // Only the three remaining report pages — Overview is gone.
    for (const tab of ["Spending Trends", "Spending by Category", "Net Worth"]) {
      expect(screen.getByRole("button", { name: tab })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    // Spending Trends is the default page, totaling all categorized spend ($650.00).
    const panel = findPanel("Spending Trends")!;
    expect(panel).toBeTruthy();
    expectPanelBodyIsFlexColumn(panel);
    expect(panel.querySelector("svg")).not.toBeNull();
    expect(screen.getAllByText("$650.00").length).toBeGreaterThan(0);
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

  it("re-totals Spending Trends when the From month is narrowed", () => {
    renderView();
    // June only: $50.00 of categorized spend (uncategorized Shop B is excluded).
    pickFromOpenDropdownByValue(/from month/i, "5");
    expect(screen.getAllByText("$50.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("$650.00")).not.toBeInTheDocument();
  });

  it("swaps From/To when From is after To", () => {
    renderView();
    pickFromOpenDropdownByValue(/from month/i, "5");
    pickFromOpenDropdownByValue(/to month/i, "3");
    // The swap keeps the full range, so the trends total is unchanged.
    expect(screen.getAllByText("$650.00").length).toBeGreaterThan(0);
  });

  it("Cash Flow renders full-height bars when narrowed to Jun-Oct with an outlier month", () => {
    // Reported scenario: narrowing to Jun-Oct 2026 rendered no bars while a
    // wider range showed the same months. One bonus month inside the window
    // trips the outlier axis break; the bars must keep their height instead
    // of collapsing to 1px slivers.
    localStorage.clear();
    const transactions: Transaction[] = [];
    for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]) {
      transactions.push(txn(m, 1, "Payroll", 5000));
      transactions.push(txn(m, 5, "Groceries", -3200, 10));
    }
    transactions.push(txn("2026-08", 15, "Bonus", 20000));
    const data: BudgetData = { ...makeData(), transactions };
    renderView({ data, month: "2026-10" });
    clickTab("Cash Flow");
    pickFromOpenDropdownByValue(/from month/i, "5");
    pickFromOpenDropdownByValue(/to month/i, "9");
    const panel = findPanel("Monthly Cash Flow")!;
    expect(panel).toBeTruthy();
    const bars = Array.from(panel.querySelectorAll("rect")).filter((r) => {
      const fill = r.getAttribute("fill") ?? "";
      return fill.includes("surplus-grad") || fill.includes("loss-grad");
    });
    expect(bars.length).toBe(5);
    for (const bar of bars) {
      expect(Number(bar.getAttribute("height"))).toBeGreaterThan(50);
    }
  });

  it("provides 2-field selectors for month and year on both From and To", () => {
    renderView();
    expect(screen.getByRole("button", { name: /from month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /from year/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /to month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /to year/i })).toBeInTheDocument();
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

  it("Spending by Category renders proportional bars with no truncation breaks", () => {
    const data: BudgetData = {
      ...makeData(),
      categories: [
        { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 12, groupId: 1, name: "Fuel", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 13, groupId: 1, name: "Fees", sort: 3, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 14, groupId: 1, name: "Taxes", sort: 4, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      transactions: [
        txn("2026-04", 1, "Payroll", 3000),
        txn("2026-04", 5, "Groceries", -350, 10),
        txn("2026-04", 10, "Rent", -300, 11),
        txn("2026-04", 12, "Gas", -120, 12),
        txn("2026-04", 15, "Stamps", -80, 13),
        txn("2026-04", 20, "Gov", -5000, 14),
      ],
    };
    renderView({ data });
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;

    // No truncation / break UI on any bar: no masks, markers, or caps.
    expect(panel.querySelector('[data-testid="axis-break"]')).toBeNull();
    expect(panel.querySelector(".y-bar-truncated")).toBeNull();
    expect(panel.querySelector(".y-bar-track svg")).toBeNull();

    // Bars scale linearly against the largest category (5000 = 100%,
    // Groceries 350 = 7%) regardless of how dominant the top spender is.
    const taxRow = screen.getByText("$5,000.00").closest(".group")!;
    const groceriesRow = screen.getByText("$350.00").closest(".group")!;
    const taxFill = taxRow.querySelector(".y-bar-track > div") as HTMLElement;
    const groceriesFill = groceriesRow.querySelector(".y-bar-track > div") as HTMLElement;
    expect(taxFill.style.width).toBe("100%");
    expect(groceriesFill.style.width).toBe("7%");
  });

  it("shows the empty state when there are no transactions", () => {
    renderView({ data: { ...makeData(), transactions: [] } });
    expect(
      screen.getByText("No spending data for this timeframe and filter selection.")
    ).toBeInTheDocument();
  });

  it("lists years newest-first in the year selectors", () => {
    const data: BudgetData = {
      ...makeData(),
      transactions: [
        txn("2024-05", 1, "Groceries", -50, 10),
        txn("2025-06", 1, "Groceries", -50, 10),
        txn("2026-04", 1, "Groceries", -50, 10),
      ],
    };
    renderView({ data });

    openDropdown(/from year/i);
    const labels = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent?.trim());
    expect(labels).toEqual(["2026", "2025", "2024"]);
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

  it("includes categorized transfers in spending", () => {
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

    // Spending tab must show Retirement category
    clickTab("Spending by Category");
    expect(screen.getByText("Retirement")).toBeInTheDocument();
    expect(screen.getAllByText("$500.00").length).toBeGreaterThanOrEqual(1);
  });

  it("BUG-45: updates automatic date range when older transactions are imported if untouched", () => {
    const initialData = makeData(); // transactions from 2026-04 to 2026-06
    const { rerender } = render(<ReportsView data={initialData} month="2026-06" />);

    // Default range starts 2026-04
    expect(screen.getByRole("button", { name: /from month/i })).toHaveTextContent("April");
    expect(screen.getByRole("button", { name: /from year/i })).toHaveTextContent("2026");

    // Now older transaction from 2025-01 ($5000 income) is imported
    const updatedData: BudgetData = {
      ...initialData,
      transactions: [
        txn("2025-01", 1, "Old Payroll", 5000),
        ...initialData.transactions,
      ],
    };

    rerender(<ReportsView data={updatedData} month="2026-06" />);

    // Automatic range now starts 2025-01
    expect(screen.getByRole("button", { name: /from month/i })).toHaveTextContent("January");
    expect(screen.getByRole("button", { name: /from year/i })).toHaveTextContent("2025");
  });

  it("BUG-45: retains user customized date range when data updates", () => {
    const initialData = makeData();
    const { rerender } = render(<ReportsView data={initialData} month="2026-06" />);

    // Manually customize the From month using Select (May)
    pickFromOpenDropdownByValue(/from month/i, "4");

    // From selector shows the customized May start
    expect(screen.getByRole("button", { name: /from month/i })).toHaveTextContent("May");

    // Now older transaction from 2025-01 is imported
    const updatedData: BudgetData = {
      ...initialData,
      transactions: [
        txn("2025-01", 1, "Old Payroll", 5000),
        ...initialData.transactions,
      ],
    };

    rerender(<ReportsView data={updatedData} month="2026-06" />);

    // Customized range is retained — still May
    expect(screen.getByRole("button", { name: /from month/i })).toHaveTextContent("May");

    // Now resetKey changes (user clicks Reports in sidebar)
    rerender(<ReportsView data={updatedData} month="2026-06" resetKey={1} />);

    // Reset reverts to the automatic full range starting 2025-01
    expect(screen.getByRole("button", { name: /from month/i })).toHaveTextContent("January");
    expect(screen.getByRole("button", { name: /from year/i })).toHaveTextContent("2025");
  });

  it("BUG-44: recovers from invalid subTab in localStorage", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.localStorage.setItem("ynab:reports:subTab", JSON.stringify("invalid-tab"));
    renderView();
    // Falls back to Spending Trends
    expect(findPanel("Spending Trends")).toBeTruthy();
    expect(window.localStorage.getItem("ynab:reports:subTab")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'Invalid value for localStorage key "ynab:reports:subTab", removing stored entry'
    );
    warnSpy.mockRestore();
  });

  it("migrates a stored legacy Overview tab to Spending Trends", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.localStorage.setItem("ynab:reports:subTab", JSON.stringify("overview"));
    renderView();
    expect(findPanel("Spending Trends")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("ynab:reports:subTab")).toBeNull();
    warnSpy.mockRestore();
  });

  it("BUG-04: Spending by Category nets refunds against category outflows", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [],
      categories: [
        { id: 10, groupId: 1, name: "Clothing", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        // Outflow $200.00
        txn("2026-06", 5, "Clothing Store", -200, 10),
        // Refund / Return $150.00
        txn("2026-06", 10, "Clothing Store Return", 150, 10),
      ],
      recurring: [],
    };

    render(<ReportsView data={data} month="2026-06" />);
    clickTab("Spending by Category");

    const panel = findPanel("Spending by Category")!;
    expect(panel).toBeInTheDocument();

    // Net spend is $50.00 ($200 - $150), total is $50.00
    expect(within(panel).getByText("Clothing")).toBeInTheDocument();
    expect(within(panel).getAllByText("$50.00")).toHaveLength(2);
    expect(within(panel).getByText("Total:")).toBeInTheDocument();
  });
});



