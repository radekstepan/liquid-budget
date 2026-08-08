import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CalendarView } from "../src/CalendarView.js";
import type { BudgetData, Transaction } from "@ynab/logic";

function txn(day: number, payee: string, amount: number): Transaction {
  return {
    id: day * 100 + Math.abs(amount),
    accountId: 1,
    categoryId: 10,
    date: `2026-06-${String(day).padStart(2, "0")}`,
    payee,
    memo: "",
    amount: String(amount),
    status: "u",
  };
}

function makeData(txns: Transaction[]): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "0.00", onBudget: true, sort: 0 },
    ],
    groups: [],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: txns,
    recurring: [],
  };
}

function renderView(overrides: Record<string, unknown> = {}) {
  const onPrev = vi.fn();
  const onNext = vi.fn();
  const onAdd = vi.fn();
  const props = {
    data: makeData([]),
    month: "2026-06",
    onPrev,
    onNext,
    onAdd,
    ...overrides,
  } as Parameters<typeof CalendarView>[0];
  render(<CalendarView {...props} />);
  return { onPrev, onNext, onAdd };
}

describe("CalendarView", () => {
  it("renders the month grid and shifts months", () => {
    const { onPrev, onNext } = renderView();
    expect(screen.getByText("Calendar")).toBeInTheDocument();
    for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      expect(screen.getByText(d)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(onPrev).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(onNext).toHaveBeenCalled();
  });

  it("shows Net this month as the signed sum of the month's transactions", () => {
    renderView({ data: makeData([txn(1, "Payroll", 2000), txn(3, "Shop", -50.5)]) });
    expect(screen.getByText("$1,949.50")).toBeInTheDocument();
  });

  it("calls onAdd with the ISO date when an empty day is clicked", () => {
    const { onAdd } = renderView({ data: makeData([txn(5, "Shop", -10)]) });
    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-10/i });
    fireEvent.click(dayCell);
    expect(onAdd).toHaveBeenCalledWith("2026-06-10");
  });

  it("shows up to three pills per day and expands via the overflow button", () => {
    const txns = [1, 2, 3, 4, 5].map((i) => txn(6, `Payee ${i}`, -i * 10));
    renderView({ data: makeData(txns) });

    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-06/i });
    const cell = within(dayCell);

    expect(cell.getByText("Payee 1")).toBeInTheDocument();
    expect(cell.getByText("Payee 2")).toBeInTheDocument();
    expect(cell.getByText("Payee 3")).toBeInTheDocument();
    expect(cell.queryByText("Payee 4")).not.toBeInTheDocument();

    fireEvent.click(cell.getByRole("button", { name: /\+2 more/i }));
    expect(cell.getByText("Payee 4")).toBeInTheDocument();
    expect(cell.getByText("Payee 5")).toBeInTheDocument();
    // "+N more" is replaced by the expanded pill list; the cell itself
    // toggles the expansion back.
    expect(cell.queryByRole("button", { name: /\+2 more/i })).not.toBeInTheDocument();
  });

  it("toggles expansion by clicking a populated day cell", () => {
    const txns = [1, 2, 3, 4].map((i) => txn(12, `Payee ${i}`, -i * 10));
    renderView({ data: makeData(txns) });

    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-12/i });
    expect(within(dayCell).queryByText("Payee 4")).not.toBeInTheDocument();

    fireEvent.click(dayCell);
    expect(within(dayCell).getByText("Payee 4")).toBeInTheDocument();

    fireEvent.click(dayCell);
    expect(within(dayCell).queryByText("Payee 4")).not.toBeInTheDocument();
  });

  it("shows the day net for days with transactions", () => {
    renderView({ data: makeData([txn(15, "Shop", -25), txn(15, "Coffee", -5)]) });
    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-15/i });
    expect(within(dayCell).getByText("-$30.00")).toBeInTheDocument();
  });

  it("does not call onAdd for a populated day", () => {
    const { onAdd } = renderView({ data: makeData([txn(20, "Shop", -10)]) });
    fireEvent.click(screen.getByRole("button", { name: /add transaction on 2026-06-20/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });
});
