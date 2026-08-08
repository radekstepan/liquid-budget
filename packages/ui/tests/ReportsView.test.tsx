import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReportsView } from "../src/ReportsView.js";
import type { BudgetData, Transaction } from "@ynab/logic";

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
    amount: String(amount),
    status: "u",
  };
}

function makeData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "0.00", onBudget: true, sort: 0 },
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
  it("renders the toolbar and all four report panels", () => {
    renderView();
    expect(screen.getByText("Reports")).toBeInTheDocument();
    expect(screen.getByText("Net Worth")).toBeInTheDocument();
    expect(screen.getByText("Spending by Category")).toBeInTheDocument();
    expect(screen.getByText("Expense Breakdown")).toBeInTheDocument();
    expect(screen.getByText("Top Payees")).toBeInTheDocument();
  });

  it("totals income and expenses across the default range", () => {
    renderView();
    expect(screen.getByText("$9,000.00")).toBeInTheDocument();
    expect(screen.getByText("-$800.00")).toBeInTheDocument();
    expect(screen.getByText("$8,200.00")).toBeInTheDocument();
  });

  it("re-totals when the From month is narrowed", () => {
    renderView();
    const [from] = screen.getAllByRole("combobox");
    fireEvent.change(from!, { target: { value: "2026-06" } });
    expect(screen.getByText("$3,000.00")).toBeInTheDocument();
    expect(screen.getByText("-$50.00")).toBeInTheDocument();
    expect(screen.getByText("$2,950.00")).toBeInTheDocument();
  });

  it("swaps From/To when From is after To", () => {
    renderView();
    const [from] = screen.getAllByRole("combobox");
    fireEvent.change(from!, { target: { value: "2026-06" } });
    const [, to] = screen.getAllByRole("combobox");
    fireEvent.change(to!, { target: { value: "2026-04" } });
    // The swap keeps the full range, so totals are unchanged.
    expect(screen.getByText("$9,000.00")).toBeInTheDocument();
  });

  it("shows spending by category with percents, sorted descending", () => {
    renderView();
    const panel = screen.getByText("Spending by Category").closest("div")!.parentElement!;
    const scope = within(panel);
    // Groceries 350 (54%) before Rent 300 (46%).
    const names = scope.getAllByText(/Groceries|Rent/).map((el) => el.textContent);
    expect(names[0]).toBe("Groceries");
    expect(names[1]).toBe("Rent");
    expect(scope.getByText(/\(54%\)/)).toBeInTheDocument();
    expect(scope.getByText(/\(46%\)/)).toBeInTheDocument();
  });

  it("shows top payees sorted by spend", () => {
    renderView();
    const panel = screen.getByText("Top Payees").closest("div")!.parentElement!;
    const scope = within(panel);
    expect(scope.getByText("Groceries")).toBeInTheDocument();
    expect(scope.getByText("$350.00")).toBeInTheDocument();
    expect(scope.getByText("Shop A")).toBeInTheDocument();
    expect(scope.getByText("Shop B")).toBeInTheDocument();
    expect(scope.getByText("$150.00")).toBeInTheDocument();
  });

  it("renders the net worth SVG graph", () => {
    renderView();
    const panel = screen.getByText("Net Worth").closest("div")!.parentElement!;
    expect(panel.querySelector("svg")).not.toBeNull();
  });

  it("shows the empty state when there are no transactions", () => {
    renderView({ data: { ...makeData(), transactions: [] } });
    expect(screen.getAllByText("No data for this timeframe.").length).toBeGreaterThan(0);
  });
});
