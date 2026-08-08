import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecurringView } from "../src/RecurringView.js";
import type { BudgetData } from "@ynab/logic";

function makeData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "0.00", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "0.00", onBudget: true, sort: 1 },
    ],
    groups: [],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [],
    recurring: [
      {
        id: 1,
        accountId: 1,
        categoryId: 11,
        payee: "Rent",
        amount: "-1500.00",
        frequency: "monthly",
        nextDate: "2026-06-01",
        active: true,
        subTransactions: [],
      },
      {
        id: 2,
        accountId: 1,
        categoryId: null,
        payee: "To Savings",
        amount: "-200.00",
        frequency: "monthly",
        nextDate: "2026-06-15",
        active: true,
        transferAccountId: 2,
        subTransactions: [],
      },
      {
        id: 3,
        accountId: 1,
        categoryId: null,
        payee: "Paycheck split",
        amount: "3000.00",
        frequency: "monthly",
        nextDate: "2026-06-25",
        active: true,
        subTransactions: [
          { id: 31, recurringId: 3, categoryId: 10, amount: "2000.00", memo: "", sort: 0 },
          { id: 32, recurringId: 3, categoryId: 11, amount: "1000.00", memo: "", sort: 1 },
        ],
      },
      {
        id: 4,
        accountId: 1,
        categoryId: 10,
        payee: "Paused bill",
        amount: "-100.00",
        frequency: "monthly",
        nextDate: "2026-06-05",
        active: false,
        subTransactions: [],
      },
    ],
  };
}

function renderView(overrides: Record<string, unknown> = {}) {
  const onAdd = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onPost = vi.fn();
  const onToggleActive = vi.fn();
  const props = {
    data: makeData(),
    onAdd,
    onEdit,
    onDelete,
    onPost,
    onToggleActive,
    ...overrides,
  } as Parameters<typeof RecurringView>[0];
  render(<RecurringView {...props} />);
  return { onAdd, onEdit, onDelete, onPost, onToggleActive };
}

describe("RecurringView", () => {
  it("calls onAdd from the Add Recurring button", () => {
    const { onAdd } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /add recurring/i }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("computes the monthly income / bills / net strip", () => {
    renderView();
    // Income: split children sum +3000. Bills: only the active single
    // monthly entry (-1500); the paused entry is excluded.
    expect(screen.getByText("Monthly Income")).toBeInTheDocument();
    expect(screen.getAllByText("$3,000.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Monthly Bills")).toBeInTheDocument();
    expect(screen.getAllByText("-$1,500.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Net Monthly")).toBeInTheDocument();
    expect(screen.getByText("$1,500.00")).toBeInTheDocument();
  });

  it("renders cards with hints for each flavour", () => {
    renderView();
    expect(screen.getByText("Rent")).toBeInTheDocument();
    expect(screen.getByText(/Chequing · Rent/)).toBeInTheDocument();
    expect(screen.getByText("To Savings")).toBeInTheDocument();
    expect(screen.getByText(/Chequing → Savings/)).toBeInTheDocument();
    expect(screen.getByText("Paycheck split")).toBeInTheDocument();
    expect(screen.getByText(/Chequing · 2 categories/)).toBeInTheDocument();
  });

  it("shows flavour pills only for non-single entries", () => {
    renderView();
    expect(screen.getByText("transfer")).toBeInTheDocument();
    expect(screen.getByText("split")).toBeInTheDocument();
    expect(screen.queryAllByText("single")).toHaveLength(0);
  });

  it("toggles active state from the pill", () => {
    const { onToggleActive } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /pause rent/i }));
    expect(onToggleActive).toHaveBeenCalledWith(1, false);
    fireEvent.click(screen.getByRole("button", { name: /resume paused bill/i }));
    expect(onToggleActive).toHaveBeenCalledWith(4, true);
  });

  it("posts, edits, and deletes with the entry id", () => {
    const { onPost, onEdit, onDelete } = renderView();
    fireEvent.click(screen.getAllByRole("button", { name: /^post now$/i })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /edit rent/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete rent/i }));
    expect(onPost).toHaveBeenCalledWith(1);
    expect(onEdit).toHaveBeenCalledWith(1);
    expect(onDelete).toHaveBeenCalledWith(1);
  });

  it("renders the empty state", () => {
    renderView({
      data: { ...makeData(), recurring: [] },
    });
    expect(screen.getByText("No recurring transactions yet.")).toBeInTheDocument();
  });
});
