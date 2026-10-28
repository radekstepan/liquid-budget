import { describe, expect, it, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReportsView } from "../src/ReportsView.js";
import { colorForName, REMAINING_COLOR, sankeyFamilyShade } from "../src/chartUtils.js";
import type { BudgetData, Transaction } from "@ynab/logic";
import { sankeyThresholdStops } from "@ynab/logic";
import { openDropdown, pickFromOpenDropdownByValue } from "./dropdown.js";

// The Under slider walks stepped stops, not raw dollars: resolve the slider
// position for a dollar threshold from the stops covering `maxDollars` (the
// fixture's largest row on any column — the same input the report uses).
function stepFor(maxDollars: number, dollars: number): string {
  return String(sankeyThresholdStops(maxDollars).indexOf(dollars));
}

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
    fireEvent.click(within(panel).getByRole("button", { name: "Bars" }));
    const scope = within(panel);
    // Groceries ($350, 54%) is top, Rent ($300, 46%) second.
    const names = scope.getAllByText(/Groceries|Rent/).map((el) => el.textContent);
    expect(names[0]).toBe("Groceries");
    expect(names[1]).toBe("Rent");
    expect(scope.getByText("54%")).toBeInTheDocument();
    expect(scope.getByText("46%")).toBeInTheDocument();
  });

  it("Spending by Category defaults to the Sankey view and toggles to Bars", () => {
    renderView();
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    expect(panel).toBeTruthy();
    expectPanelBodyIsFlexColumn(panel);

    const sankeyBtn = within(panel).getByRole("button", { name: "Sankey" });
    const barsBtn = within(panel).getByRole("button", { name: "Bars" });
    expect(sankeyBtn).toBeInTheDocument();
    expect(barsBtn).toBeInTheDocument();

    // Default is the three-column Sankey flow: the income feeds the
    // Everyday group plus the full-width Remaining ribbon (income exceeds
    // spending), and the group fans out to Groceries and Rent.
    const svg = panel.querySelector('[data-testid="sankey-svg"]');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(4);
    expect(svg!.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(3);
    expect(svg!.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(1);
    expect(svg!.querySelector('[data-testid="sankey-total"]')).toBeNull();
    expect(svg!.querySelectorAll('[data-testid="sankey-in-link"]')).toHaveLength(0);
    expect(svg!.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(1);
    expect(within(panel).getByText("Groceries")).toBeInTheDocument();
    expect(within(panel).getByText("Rent")).toBeInTheDocument();
    expect(within(panel).getByText("Everyday")).toBeInTheDocument();
    expect(within(panel).getByText("Remaining")).toBeInTheDocument();
    expect(panel.querySelectorAll(".y-bar-track")).toHaveLength(0);

    // Toggle to Bars view
    fireEvent.click(barsBtn);
    expect(panel.querySelector('[data-testid="sankey-svg"]')).toBeNull();
    expect(panel.querySelectorAll(".y-bar-track").length).toBeGreaterThan(0);

    // Toggle back to Sankey view
    fireEvent.click(sankeyBtn);
    expect(panel.querySelector('[data-testid="sankey-svg"]')).not.toBeNull();
    expect(panel.querySelectorAll(".y-bar-track")).toHaveLength(0);
  });

  it("Spending tab toggles between Categories and Merchants dimensions", () => {
    renderView();
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    fireEvent.click(within(panel).getByRole("button", { name: "Merchants" }));

    // Panel retitles; uncategorized "Shop B" counts as a merchant but
    // income payee "Payroll" stays on the income side only (one label: the
    // income column — never duplicated into merchant spending).
    expect(findPanel("Spending by Merchant")).toBeTruthy();
    expect(within(panel).getByText("Shop B")).toBeInTheDocument();
    expect(within(panel).getAllByText("Payroll")).toHaveLength(1);
    expect(within(panel).getByText("3 merchants")).toBeInTheDocument();
    // Uncategorized Shop B routes through the Uncategorized pseudo-group.
    expect(within(panel).getByText("Uncategorized")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Categories" }));
    expect(findPanel("Spending by Category")).toBeTruthy();
    expect(within(panel).queryByText("Shop B")).not.toBeInTheDocument();
  });

  it("Spending tab re-totals the Sankey when the From month is narrowed", () => {
    renderView();
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    // Full range spends $650.00 across Groceries + Rent (Out readout only —
    // the chart carries no total caption anymore).
    expect(within(panel).getAllByText("$650.00")).toHaveLength(1);
    pickFromOpenDropdownByValue(/from month/i, "5");
    // June only: $50.00 of Groceries; Rent drops out entirely.
    expect(within(panel).getAllByText("$50.00")).toHaveLength(1);
    expect(within(panel).queryByText("Rent")).not.toBeInTheDocument();
    const svg = panel.querySelector('[data-testid="sankey-svg"]')!;
    // Groceries plus the Remaining plug (June income exceeds June spending),
    // routed through the Everyday group: two left ribbons, one right ribbon.
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(3);
  });

  it("Spending tab merges smaller groups into Other via the threshold slider", () => {
    renderView();
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    const slider = within(panel).getByRole("slider", { name: /merge smaller groups/i });
    // Groceries $350 is kept, Rent $300 folds into Other at a $350 stop
    // (the $9,000 Payroll drives the stops).
    fireEvent.change(slider, { target: { value: stepFor(9000, 350) } });
    expect(within(panel).getByText("Other")).toBeInTheDocument();
    expect(within(panel).getByText("(1 in Other)")).toBeInTheDocument();
    const svg = panel.querySelector('[data-testid="sankey-svg"]')!;
    // Groceries + Other + Remaining on the right, all through Everyday.
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(4);
    // Out total is unchanged by merging.
    expect(within(panel).getAllByText("$650.00")).toHaveLength(1);
  });

  it("Spending tab merges small incomes into Other with the same threshold", () => {
    const data = makeData();
    data.transactions.push(txn("2026-06", 15, "Bonus", 100));
    renderView({ data });
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    const slider = within(panel).getByRole("slider", { name: /merge smaller groups/i });
    // $350 stop: Rent ($300) folds into Other on the right, Bonus ($100)
    // into Other on the left; Groceries ($350) and Payroll stay.
    fireEvent.change(slider, { target: { value: stepFor(9000, 350) } });
    expect(within(panel).getByText("(2 in Other)")).toBeInTheDocument();
    const svg = panel.querySelector('[data-testid="sankey-svg"]')!;
    expect(svg.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(2);
    // 2 incomes x 1 group plus 2 full-width Remaining ribbons on the
    // left; one ribbon per cell (Groceries + Other) on the right.
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(6);
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

  it("Spending by Category draws one closed ribbon per group and keeps tiny flows hoverable", () => {
    // "Fees" is a dust share ($0.01 of $650.01) — without a minimum node
    // height it would collapse to a sub-pixel sliver no cursor can hit.
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

    const svg = panel.querySelector('[data-testid="sankey-svg"]')!;
    const links = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]'));
    const nodes = Array.from(svg.querySelectorAll('[data-testid="sankey-node"]'));
    // Groceries + Rent + Fees + the Remaining plug (income exceeds spending),
    // all routed through the single Everyday group: two left ribbons (group
    // + full-width Remaining) and three right ribbons.
    expect(links).toHaveLength(5);
    expect(nodes).toHaveLength(4);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(1);
    // Each ribbon is a closed bezier path running left-to-right.
    for (const link of links) {
      const d = link.getAttribute("d") ?? "";
      expect(d).toMatch(/^M .* C .* Z$/);
    }
    // Every node (including dust) is tall enough to hover, and the bands
    // stack without overlap inside the 400px-tall mock viewport.
    let prevBottom = 8;
    for (const node of nodes) {
      const y = Number(node.getAttribute("y"));
      const h = Number(node.getAttribute("height"));
      expect(h).toBeGreaterThanOrEqual(8);
      expect(y).toBeGreaterThanOrEqual(prevBottom - 1e-6);
      expect(y + h).toBeLessThanOrEqual(400 - 8 + 1e-6);
      prevBottom = y + h + 6;
    }
    expect(within(panel).getByText("Fees")).toBeInTheDocument();
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
    fireEvent.click(within(panel).getByRole("button", { name: "Bars" }));

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

  it("flows boundary transfers through instead of counting contributions as spending", () => {
    // This used to assert a Chequing→RRSP contribution shows as Retirement
    // spending — that expectation encoded the bug (task-26): with
    // flow-through attribution the contribution is movement into an
    // intermediate pool, and the downstream purchase is the one record.
    const data: BudgetData = {
      ...makeData(),
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget", balance: "500000", onBudget: true, sort: 0 },
        { id: 2, name: "RRSP", kind: "offbudget", groupLabel: "Investments", balance: "100000", onBudget: false, sort: 1 },
      ],
      categories: [
        { id: 20, groupId: 1, name: "Retirement", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 21, groupId: 1, name: "Vacation", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      transactions: [
        {
          id: 1,
          accountId: 1,
          categoryId: null,
          date: "2026-06-01",
          payee: "Payroll",
          memo: "",
          amount: "300000",
          status: "c",
        },
        {
          id: 2,
          accountId: 1,
          transferAccountId: 2,
          categoryId: 20,
          date: "2026-06-15",
          payee: "Transfer : RRSP",
          memo: "Savings",
          amount: "-50000",
          status: "c",
        },
        {
          id: 3,
          accountId: 2,
          categoryId: 21,
          date: "2026-06-20",
          payee: "Airline",
          memo: "",
          amount: "-50000",
          status: "c",
        },
      ],
    };
    renderView({ data });

    // Spending tab shows the vacation purchase (traced to Payroll), never
    // the contribution as a Retirement allocation.
    clickTab("Spending by Category");
    expect(screen.getByText("Vacation")).toBeInTheDocument();
    expect(screen.getAllByText("$500.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Retirement")).not.toBeInTheDocument();
    expect(screen.getByText("Payroll")).toBeInTheDocument();
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

    // Net spend is $50.00 ($200 - $150). No income in range, so there are
    // no income bars — the expense bar is fully unfunded instead of the
    // income side inventing an Overspent source.
    expect(within(panel).getByText("Clothing")).toBeInTheDocument();
    expect(within(panel).getAllByText("$50.00")).toHaveLength(2);
    expect(within(panel).getByText("Out:")).toBeInTheDocument();
    expect(within(panel).getByText("Over:")).toBeInTheDocument();
    expect(within(panel).queryByText("Overspent")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Remaining")).not.toBeInTheDocument();
    const svg = panel.querySelector('[data-testid="sankey-svg"]')!;
    expect(svg.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(0);
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(0);
    // No grey shortfall segments: the unfunded state shows in tooltips.
    expect(svg.querySelectorAll('[data-testid="sankey-shortfall"]')).toHaveLength(0);
    // The dangling group still draws its (fully unfunded) middle bar.
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-testid="sankey-group-shortfall"]')).toHaveLength(0);
  });

  it("Spending sankey hides amounts on tiny income bars and colors ribbons by destination", () => {
    const data = makeData();
    data.transactions.push(txn("2026-06", 15, "Bonus", 1));
    renderView({ data });
    clickTab("Spending by Category");
    const panel = findPanel("Spending by Category")!;
    const svg = panel.querySelector('[data-testid="sankey-svg"]')!;

    // Both income names render, but the $1 Bonus bar is too short for two
    // lines, so only Payroll keeps its amount.
    const bars = svg.querySelectorAll('[data-testid="sankey-income"]');
    const labels = svg.querySelectorAll('[data-testid="sankey-income-label"]');
    expect(bars).toHaveLength(2);
    expect(labels).toHaveLength(2);
    expect(within(panel).getByText("Bonus")).toBeInTheDocument();
    expect(svg.querySelectorAll('[data-testid="sankey-income-amount"]')).toHaveLength(1);
    // The name-only label sits centered on its bar.
    const barY = Number(bars[1]!.getAttribute("y"));
    const barH = Number(bars[1]!.getAttribute("height"));
    expect(barH).toBeLessThan(26);
    expect(Number(labels[1]!.getAttribute("y"))).toBeCloseTo(barY + barH / 2 + 4, 5);

    // Left ribbons take their middle group's color and right ribbons
    // their final category's family shade: each ribbon reads as where the
    // money lands, in one flat color through its whole length.
    const left = svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]');
    const right = svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]');
    // 2 incomes x 1 group plus 2 Remaining ribbons on the left; one ribbon
    // per cell (2) on the right — never one per income.
    expect(left).toHaveLength(4);
    expect(right).toHaveLength(2);
    // Flat destination fills on every ribbon — gradients live only on
    // the two income bars, never on a ribbon.
    for (const link of svg.querySelectorAll('[data-testid="sankey-link"]')) {
      expect(link.getAttribute("fill")).not.toMatch(/^url\(/);
    }
    expect(svg.querySelectorAll("linearGradient")).toHaveLength(2);
    const everyday = colorForName("Everyday");
    const leftFills = [everyday, everyday, REMAINING_COLOR, REMAINING_COLOR];
    left.forEach((link, k) => {
      expect(link.getAttribute("fill")).toBe(leftFills[k]);
    });
    // Right ribbons fill with their target's family shade, cell-major.
    // Darkest-first: the larger sibling (Groceries) takes the darker
    // shade, Rent keeps the Everyday color.
    const targetFills = [sankeyFamilyShade(everyday, 1), everyday];
    right.forEach((link, k) => {
      expect(link.getAttribute("fill")).toBe(targetFills[k]);
      expect(link.getAttribute("data-income")).toBeNull();
    });
    // Ribbon fills equal their destination bars' fills exactly.
    const nodeFills = Array.from(svg.querySelectorAll('[data-testid="sankey-node"]')).map(
      (n) => n.getAttribute("fill")
    );
    expect(nodeFills).toEqual([sankeyFamilyShade(everyday, 1), everyday, REMAINING_COLOR]);
    const groupFill = svg.querySelector('[data-testid="sankey-group"]')!.getAttribute("fill");
    expect(groupFill).toBe(everyday);
  });
});



