// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData } from "@ynab/logic";

describe("BudgetAppShell (BUG-24)", () => {
  const initialBudget = makeSeedBudgetData();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains optimistic state and does not roll back when write succeeds but follow-up budget reload fails", async () => {
    let budgetFetchCount = 0;
    let postTransactionCalled = false;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        budgetFetchCount++;
        // Initial load succeeds
        if (budgetFetchCount === 1) {
          return new Response(JSON.stringify(initialBudget), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Subsequent reload fails (e.g. 500 error / network issue)
        return new Response(JSON.stringify({ error: "Budget reload failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "POST") {
        postTransactionCalled = true;
        const body = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            id: 9999,
            accountId: body.accountId,
            categoryId: body.categoryId,
            date: body.date,
            payee: body.payee,
            memo: body.memo ?? "",
            amount: body.amount,
            status: body.status,
            flagColor: body.flagColor ?? null,
            transferAccountId: null,
            parentId: null,
            isIncome: false,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="transactions" />);

    // Wait for initial load to complete
    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });

    expect(budgetFetchCount).toBe(1);

    // Switch to Transactions view by clicking an account in the sidebar
    fireEvent.click(screen.getAllByText("TD Unlimited Chequing")[0]!);

    // Open Add Transaction modal
    const addBtn = screen.getByRole("button", { name: /add a new transaction/i });
    fireEvent.click(addBtn);

    // Fill in Payee via SearchList trigger
    const payeeTrigger = screen.getByText("e.g. Whole Foods");
    fireEvent.click(payeeTrigger);
    const payeeInput = screen.getByPlaceholderText("e.g. Whole Foods");
    fireEvent.change(payeeInput, { target: { value: "Unique Grocery Payee" } });

    // Fill in Amount
    const amountInput = screen.getByPlaceholderText("0.00");
    fireEvent.change(amountInput, { target: { value: "-15.50" } });

    // Save transaction
    const saveBtn = screen.getByRole("button", { name: /save transaction/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify POST was called
    await waitFor(() => {
      expect(postTransactionCalled).toBe(true);
    });

    // Verify that reload was attempted
    await waitFor(() => {
      expect(budgetFetchCount).toBeGreaterThan(1);
    });

    // Verify that the optimistic transaction remains visible in the register
    // and was NOT rolled back, and no error toast claiming failure is shown
    expect(screen.getByText("Unique Grocery Payee")).toBeDefined();
    expect(screen.queryByText("Failed to add transaction. Please try again.")).toBeNull();
    // Warning toast about refresh should be shown
    expect(screen.getByText("Saved changes, but failed to refresh latest budget data.")).toBeDefined();
  });
});
