"use client";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeSeedBudgetData } from "@ynab/logic";
import { BudgetApp, type BudgetAppApi } from "./BudgetApp.js";

function stubApi(): BudgetAppApi {
  const ok = vi.fn().mockResolvedValue(undefined);
  return {
    reload: ok,
    assign: ok,
    addTransaction: ok,
    updateTransaction: ok,
    deleteTransaction: ok,
    addRecurring: ok,
    updateRecurring: ok,
    deleteRecurring: ok,
    postRecurring: ok,
    saveCategory: ok,
    deleteCategory: ok,
    reorderCategory: ok,
    reorderGroup: ok,
    saveGroup: ok,
    deleteGroup: ok,
    addAccount: ok,
    deleteAccount: ok,
    updateAccount: ok,
    reorderAccount: ok,
    reconcileAccount: ok,
    unreconcileAccount: ok,
    ensurePayee: vi.fn().mockResolvedValue(1),
    renamePayee: ok,
    setPayeeDefaultCategory: ok,
    mergePayees: ok,
    deletePayee: ok,
  };
}

describe("BudgetApp page title", () => {
  it("tracks the URL-driven view, month, and account", async () => {
    render(
      <BudgetApp
        data={makeSeedBudgetData()}
        api={stubApi()}
        initialView="budget"
        initialMonth="2026-06"
      />
    );
    expect(document.title).toBe("June 2026 Budget - Liquid");

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() =>
      expect(document.title).toBe("July 2026 Budget - Liquid")
    );
    expect(window.location.pathname).toBe("/budget/2026-07");

    fireEvent.click(
      screen.getByRole("button", { name: "Reports", exact: true })
    );
    await waitFor(() => expect(document.title).toBe("Reports - Liquid"));
    expect(window.location.pathname).toBe("/reports");

    fireEvent.click(screen.getByRole("button", { name: /^Transactions/ }));
    await waitFor(() => expect(document.title).toBe("All Transactions - Liquid"));
    expect(window.location.pathname).toBe("/transactions");

    fireEvent.click(
      screen.getByRole("button", { name: /^TD Unlimited Chequing/ })
    );
    await waitFor(() =>
      expect(document.title).toBe(
        "TD Unlimited Chequing Transactions - Liquid"
      )
    );
    expect(window.location.pathname).toBe("/transactions/1");
  });
});
