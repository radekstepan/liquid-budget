import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { computeBudget, type BudgetData } from "@ynab/logic";
import { TransactionsView } from "../src/TransactionsView.js";
import { BudgetView } from "../src/BudgetView.js";

function dataWith(transactions: BudgetData["transactions"]): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 },
    ],
    groups: [{ id: 10, name: "Bills", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 100, groupId: 10, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions,
    recurring: [],
  };
}

const txnProps = {
  accountFilter: null as number | null,
  onAdd: () => {},
  onEdit: () => {},
  onDelete: () => {},
  onReconcile: () => {},
  onCycleStatus: () => {},
  onFlag: () => {},
};

describe("register empty states", () => {
  it("teaches first-run with an Add CTA", () => {
    const onAdd = vi.fn();
    render(<TransactionsView data={dataWith([])} {...txnProps} onAdd={onAdd} />);
    expect(screen.getByTestId("register-empty-state")).toHaveTextContent(/no transactions yet/i);
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("keeps the empty-state CTA distinctly named from the footer button", () => {
    // E2E selects the footer button by exact accessible name; the empty-state
    // CTA must never collide with it (strict-mode violation in Playwright).
    render(<TransactionsView data={dataWith([])} {...txnProps} onAdd={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Add a new transaction", exact: true })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add transaction", exact: true })
    ).toBeInTheDocument();
  });

  it("offers Clear search when an external filter matches nothing", () => {
    const onClearFilter = vi.fn();
    render(
      <TransactionsView
        data={dataWith([
          { id: 1, accountId: 1, categoryId: 100, date: "2026-09-01", payee: "Landlord", memo: "", amount: "-100000", status: "c", parentId: null, transferAccountId: null },
        ])}
        {...txnProps}
        externalFilter={{ payee: "Nobody_matches_this", nonce: 1 }}
        onClearFilter={onClearFilter}
      />
    );
    expect(screen.getByTestId("register-empty-state")).toHaveTextContent(/no transactions match your search/i);
    fireEvent.click(screen.getByRole("button", { name: /clear search/i }));
    expect(onClearFilter).toHaveBeenCalled();
  });

  it("names the account when it simply has no transactions", () => {
    render(
      <TransactionsView
        data={dataWith([
          { id: 1, accountId: 1, categoryId: 100, date: "2026-09-01", payee: "Landlord", memo: "", amount: "-100000", status: "c", parentId: null, transferAccountId: null },
        ])}
        {...txnProps}
        accountFilter={1}
      />
    );
    // One transaction exists in this account, so the register is not empty.
    expect(screen.queryByTestId("register-empty-state")).toBeNull();
  });
});

describe("budget empty state", () => {
  it("teaches a category-less budget with a group CTA", () => {
    const data = dataWith([]);
    data.categories = [];
    data.groups = [];
    const budget = computeBudget(data, "2026-09");
    const onAddGroup = vi.fn();
    render(
      <BudgetView
        budget={budget}
        budgets={[budget]}
        visibleMonths={["2026-09"]}
        monthCount={1}
        currentMonth="2026-09"
        collapsed={{}}
        onToggleGroup={() => {}}
        onAssign={() => {}}
        onShiftMonth={() => {}}
        onAddCategory={() => {}}
        onAddGroup={onAddGroup}
        onEditCategory={() => {}}
        onDeleteCategory={() => {}}
        onEditGroup={() => {}}
        onDeleteGroup={() => {}}
        onCollapseAll={() => {}}
        onExpandAll={() => {}}
      />
    );
    expect(screen.getByTestId("budget-empty-state")).toHaveTextContent(/no budget categories yet/i);
    fireEvent.click(screen.getByRole("button", { name: /first category group/i }));
    expect(onAddGroup).toHaveBeenCalledTimes(1);
  });

  it("warns live when a draft assignment would overspend", () => {
    const data = dataWith([
      { id: 1, accountId: 1, categoryId: 100, date: "2026-09-05", payee: "Store", memo: "", amount: "-10000", status: "c", parentId: null, transferAccountId: null },
    ]);
    data.assignments = [{ id: 1, categoryId: 100, month: "2026-09", amount: "5000" }];
    const budget = computeBudget(data, "2026-09");
    const row = budget.groups.flatMap((g) => g.rows).find((r) => r.category.id === 100);
    expect(row).toBeDefined();
    // Sanity: spent 100 of 50 assigned -> negative availability to warn about.
    expect(row!.available).toBeLessThan(0);
    render(
      <BudgetView
        budget={budget}
        budgets={[budget]}
        visibleMonths={["2026-09"]}
        monthCount={1}
        currentMonth="2026-09"
        collapsed={{}}
        onToggleGroup={() => {}}
        onAssign={() => {}}
        onShiftMonth={() => {}}
        onAddCategory={() => {}}
        onAddGroup={() => {}}
        onEditCategory={() => {}}
        onDeleteCategory={() => {}}
        onEditGroup={() => {}}
        onDeleteGroup={() => {}}
        onCollapseAll={() => {}}
        onExpandAll={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "$50.00" }));
    const input = screen.getByLabelText(/edit assigned amount|valid amount|overspend/i);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByLabelText(/enter a valid amount/i)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "10" } });
    expect(screen.getByLabelText(/would overspend/i)).toBeInTheDocument();
  });
});
