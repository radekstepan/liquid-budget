"use client";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "./GlobalSearch.js";
import type { BudgetData } from "@ynab/logic";

function fixture(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 1 },
    ],
    groups: [{ id: 10, name: "Food", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 100, groupId: 10, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      { id: 1, accountId: 1, categoryId: 100, date: "2026-09-01", payee: "Whole Foods", memo: "", amount: "-5000", status: "c", parentId: null, transferAccountId: null },
      { id: 2, accountId: 2, categoryId: 100, date: "2026-09-02", payee: "Landlord", memo: "", amount: "-100000", status: "c", parentId: null, transferAccountId: null },
    ],
    recurring: [],
  };
}

describe("GlobalSearch", () => {
  it("scopes to the selected account and expands to all via toggle", async () => {
    const onJump = vi.fn();
    render(<GlobalSearch data={fixture()} scopeAccountId={1} onJump={onJump} />);
    const input = screen.getByLabelText("Global search");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "landlord" } });
    await waitFor(() => expect(screen.queryByText("No matches")).not.toBeNull());
    // Scoped to Checking: Landlord (Savings) hidden.
    expect(screen.queryByText("Landlord")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /searching checking/i }));
    await waitFor(() => expect(screen.getAllByText("Landlord").length).toBeGreaterThan(0));
  });

  it("filters by structured payee facet and jumps on Enter", async () => {
    const onJump = vi.fn();
    render(<GlobalSearch data={fixture()} scopeAccountId={null} onJump={onJump} />);
    const input = screen.getByLabelText("Global search");
    fireEvent.focus(input);
    fireEvent.change(screen.getByLabelText("Filter by payee"), { target: { value: "Whole Foods" } });
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByText("Whole Foods").length).toBeGreaterThan(0));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith({ kind: "payee", payee: "Whole Foods" });
  });
});
