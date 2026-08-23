import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BulkEditTransactionsModal } from "../src/BulkEditModal.js";
import type { Account, Category, CategoryGroup, Transaction } from "@ynab/logic";
import {
  openSearchlistByPlaceholder,
  pickFromOpenDropdownByValue,
} from "./dropdown.js";

const sampleAccounts: Account[] = [
  { id: 1, name: "Checking", kind: "liquid", groupLabel: "Budget Accounts", balance: "1000", onBudget: true, archived: false },
  { id: 2, name: "Savings", kind: "liquid", groupLabel: "Budget Accounts", balance: "5000", onBudget: true, archived: false },
];

const sampleGroups: CategoryGroup[] = [
  { id: 1, name: "Everyday", sort: 0 },
];

const sampleCategories: Category[] = [
  { id: 1, name: "Groceries", groupId: 1, sort: 0 },
  { id: 2, name: "Dining Out", groupId: 1, sort: 1 },
];

const sampleTransactions: Transaction[] = [
  { id: 10, accountId: 1, categoryId: 1, date: "2026-08-01", payee: "Trader Joe's", memo: "Old memo 1", amount: "-4500", status: "c" },
  { id: 20, accountId: 1, categoryId: 2, date: "2026-08-02", payee: "Chipotle", memo: "Old memo 2", amount: "-1500", status: "u" },
];

describe("BulkEditTransactionsModal", () => {
  it("renders with Review Changes button disabled until at least one field is enabled", () => {
    render(
      <BulkEditTransactionsModal
        transactionIds={[10, 20]}
        transactions={sampleTransactions}
        accounts={sampleAccounts}
        categories={sampleCategories}
        groups={sampleGroups}
        onClose={() => {}}
        onSave={() => {}}
      />
    );

    expect(screen.getByText("Edit 2 Transactions")).toBeInTheDocument();
    const reviewBtn = screen.getByRole("button", { name: /review changes \(0\)/i });
    expect(reviewBtn).toBeDisabled();
  });

  it("updates only the payee field and preserves other fields", async () => {
    const onSave = vi.fn();
    render(
      <BulkEditTransactionsModal
        transactionIds={[10, 20]}
        transactions={sampleTransactions}
        accounts={sampleAccounts}
        categories={sampleCategories}
        groups={sampleGroups}
        onClose={() => {}}
        onSave={onSave}
      />
    );

    // Enable Payee checkbox
    const payeeCheckbox = screen.getByRole("checkbox", { name: /^payee$/i });
    fireEvent.click(payeeCheckbox);

    // Fill Payee
    const payeeInput = openSearchlistByPlaceholder("e.g. Target");
    fireEvent.change(payeeInput, { target: { value: "Whole Foods Market" } });

    // Review button should now be enabled with count 1
    const reviewBtn = screen.getByRole("button", { name: /review changes \(1\)/i });
    expect(reviewBtn).toBeEnabled();

    // Click Review Changes to go to confirmation step
    fireEvent.click(reviewBtn);

    // Verify confirmation view
    expect(screen.getByText("Confirm Changes (2 Transactions)")).toBeInTheDocument();
    expect(screen.getByText("Whole Foods Market")).toBeInTheDocument();
    expect(screen.getByText(/Only the fields listed below will be modified/i)).toBeInTheDocument();

    // Click Back
    fireEvent.click(screen.getByRole("button", { name: /← back/i }));
    expect(screen.getByText("Edit 2 Transactions")).toBeInTheDocument();

    // Review again and confirm
    fireEvent.click(screen.getByRole("button", { name: /review changes \(1\)/i }));
    const confirmBtn = screen.getByRole("button", { name: /confirm & update 2 transactions/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        payee: "Whole Foods Market",
      });
    });
  });

  it("supports updating category, memo, and cleared status simultaneously", async () => {
    const onSave = vi.fn();
    render(
      <BulkEditTransactionsModal
        transactionIds={[10, 20]}
        transactions={sampleTransactions}
        accounts={sampleAccounts}
        categories={sampleCategories}
        groups={sampleGroups}
        onClose={() => {}}
        onSave={onSave}
      />
    );

    // Enable Category
    fireEvent.click(screen.getByRole("checkbox", { name: /^category$/i }));
    pickFromOpenDropdownByValue(/Income: Available this month/i, "2"); // Dining Out

    // Enable Memo and set memo text
    fireEvent.click(screen.getByRole("checkbox", { name: /^memo$/i }));
    const memoInput = screen.getByPlaceholderText(/leave empty to clear memo/i);
    fireEvent.change(memoInput, { target: { value: "Team Dinner" } });

    // Enable Cleared Status and select Uncleared
    fireEvent.click(screen.getByRole("checkbox", { name: /^cleared status$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^uncleared$/i }));

    // Review changes (3 fields)
    const reviewBtn = screen.getByRole("button", { name: /review changes \(3\)/i });
    expect(reviewBtn).toBeEnabled();
    fireEvent.click(reviewBtn);

    expect(screen.getByText("Dining Out")).toBeInTheDocument();
    expect(screen.getByText("Team Dinner")).toBeInTheDocument();
    expect(screen.getByText("Uncleared")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm & update 2 transactions/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        categoryId: 2,
        incomeMonth: null,
        memo: "Team Dinner",
        status: "u",
      });
    });
  });

  it("shows warning when a reconciled transaction is among the selection", () => {
    const txWithReconciled: Transaction[] = [
      ...sampleTransactions,
      { id: 30, accountId: 1, categoryId: 1, date: "2026-08-01", payee: "Bank", memo: "", amount: "-100", status: "r" },
    ];

    render(
      <BulkEditTransactionsModal
        transactionIds={[10, 20, 30]}
        transactions={txWithReconciled}
        accounts={sampleAccounts}
        categories={sampleCategories}
        groups={sampleGroups}
        onClose={() => {}}
        onSave={() => {}}
      />
    );

    expect(screen.getByText(/reconciled transactions selected/i)).toBeInTheDocument();
  });
});
