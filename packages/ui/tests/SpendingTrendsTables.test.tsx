import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Transaction } from "@ynab/logic";
import { ConstituentTable, CategoryTransactionsTable } from "../src/SpendingTrendsTables.js";

function txn(id: number, payee: string, amountCents: number, accountId = 1): Transaction {
  return {
    id,
    accountId,
    categoryId: 10,
    date: "2024-01-15",
    payee,
    memo: "",
    amount: String(amountCents),
    status: "u",
  };
}

describe("ConstituentTable (ui-split slice 5)", () => {
  const constituents = [
    { id: 1, name: "Groceries", total: 50000, avgPerMonth: 25000, pctOfTotal: 50 },
    { id: 2, name: "Rent", total: 50000, avgPerMonth: 25000, pctOfTotal: 50 },
  ];
  const colorMap = new Map([
    [1, "#111"],
    [2, "#222"],
  ]);

  function renderTable(overrides: Record<string, unknown> = {}) {
    const onDrill = vi.fn();
    const view = render(
      <ConstituentTable
        constituents={constituents}
        colorMap={colorMap}
        onDrill={onDrill}
        overallTotal={100000}
        {...overrides}
      />
    );
    return { onDrill, unmount: view.unmount };
  }

  it("renders averages, totals, and shares", () => {
    renderTable();
    expect(screen.getAllByText("$250.00")).toHaveLength(2);
    expect(screen.getAllByText("$500.00")).toHaveLength(2);
    expect(screen.getAllByText("50%")).toHaveLength(2);
  });

  it("labels the first column by drill level", () => {
    const { unmount } = renderTable({ drillLevel: "group" });
    expect(screen.getByText("Category")).toBeDefined();
    unmount();
    renderTable();
    expect(screen.getByText("Master Category")).toBeDefined();
  });

  it("drills on row click and highlights the hovered row", () => {
    const { onDrill } = renderTable({ hoveredId: 2 });
    expect(screen.getByLabelText("Click to drill down into Rent").closest("tr")?.className).toContain("is-sel");
    fireEvent.click(screen.getByLabelText("Click to drill down into Groceries"));
    expect(onDrill).toHaveBeenCalledTimes(1);
    expect(onDrill).toHaveBeenCalledWith(1);
  });

  it("shows a dash share when there is no total", () => {
    renderTable({ overallTotal: 0 });
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("CategoryTransactionsTable (ui-split slice 5)", () => {
  const accountMap = new Map([[1, "Checking"]]);

  function renderRegister(overrides: Record<string, unknown> = {}) {
    const onClearMonth = vi.fn();
    const onSelectTransaction = vi.fn();
    render(
      <CategoryTransactionsTable
        categoryName="Groceries"
        transactions={[txn(1, "Store", -4250), txn(2, "Market", -1000)]}
        selectedMonth={null}
        onClearMonth={onClearMonth}
        accountMap={accountMap}
        onSelectTransaction={onSelectTransaction}
        {...overrides}
      />
    );
    return { onClearMonth, onSelectTransaction };
  }

  it("shows entry counts and an empty state", () => {
    renderRegister();
    expect(screen.getByText("2 entries")).toBeDefined();
    expect(screen.getByText("Click any month bar to filter")).toBeDefined();
    const { unmount } = render(
      <CategoryTransactionsTable
        categoryName="Groceries"
        transactions={[]}
        selectedMonth={null}
        onClearMonth={() => {}}
        accountMap={accountMap}
      />
    );
    expect(screen.getByText("No transactions found for this timeframe.")).toBeDefined();
    unmount();
  });

  it("filters by month with a clear action", () => {
    const { onClearMonth } = renderRegister({ selectedMonth: "2024-01" });
    expect(screen.getByText("Showing: January 2024")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show All Months" }));
    expect(onClearMonth).toHaveBeenCalledTimes(1);
  });

  it("renders rows with account names and spending, and selects on click", () => {
    const { onSelectTransaction } = renderRegister();
    expect(screen.getByText("$42.50")).toBeDefined();
    expect(screen.getAllByText("Checking")).toHaveLength(2);
    fireEvent.click(screen.getAllByLabelText("Click to view transaction in Checking")[0]);
    expect(onSelectTransaction).toHaveBeenCalledTimes(1);
  });
});
