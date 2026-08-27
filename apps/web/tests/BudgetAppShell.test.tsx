// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent, within } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData } from "@ynab/logic";

describe("BudgetAppShell (BUG-24)", () => {
  const initialBudget = makeSeedBudgetData();

  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/");
    window.localStorage.clear();
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

  it("BUG-07: optimistic assignment update stores an integer-cent string format matching DB format", async () => {
    let putAssignmentBody: any = null;
    let putAssignmentResolver: ((res: Response) => void) | null = null;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/assignments") && init?.method === "PUT") {
        putAssignmentBody = JSON.parse(init.body as string);
        return new Promise<Response>((resolve) => {
          putAssignmentResolver = resolve;
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="budget" />);

    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });

    // Find the category "Public Transport, Uber, Bike" which has $75.00 assigned in June 2026
    const row = screen
      .getAllByText("Public Transport, Uber, Bike")
      .find((el) => el.closest("tr"))
      ?.closest("tr")!;
    expect(row).toBeDefined();

    // Click the June 2026 assignment cell to edit (May 2026 and June 2026 both have $75.00 assigned)
    const assignButtons = within(row).getAllByRole("button", { name: "$75.00" });
    const assignBtn = assignButtons[assignButtons.length - 1]!;
    fireEvent.click(assignBtn);

    const input = within(row).getByDisplayValue("75.00");
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify PUT request body contains integer cents (10000)
    await waitFor(() => {
      expect(putAssignmentBody).toEqual({
        categoryId: 13,
        month: "2026-06",
        amount: 10000,
      });
    });

    // Optimistically, the June 2026 cell updates to "$100.00" while the PUT request is pending
    await waitFor(() => {
      expect(within(row).getByRole("button", { name: "$100.00" })).toBeDefined();
    });

    // Resolve PUT response
    await act(async () => {
      if (putAssignmentResolver) {
        putAssignmentResolver(
          new Response(
            JSON.stringify({
              id: 13,
              categoryId: 13,
              month: "2026-06",
              amount: 10000,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }
    });

    // Verify cell remains "$100.00"
    await waitFor(() => {
      expect(within(row).getByRole("button", { name: "$100.00" })).toBeDefined();
    });
  });

  it("BUG-15: optimistic addTransaction adjusts account.balance so register running balances are correct immediately", async () => {
    let postTransactionResolver: ((res: Response) => void) | null = null;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        return new Promise<Response>((resolve) => {
          postTransactionResolver = resolve;
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="transactions" />);

    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });

    // Switch to TD Unlimited Chequing
    fireEvent.click(screen.getAllByText("TD Unlimited Chequing")[0]!);

    // Open Add Transaction modal
    const addBtn = screen.getByRole("button", { name: /add a new transaction/i });
    fireEvent.click(addBtn);

    // Fill Payee
    const payeeTrigger = screen.getByText("e.g. Whole Foods");
    fireEvent.click(payeeTrigger);
    const payeeInput = screen.getByPlaceholderText("e.g. Whole Foods");
    fireEvent.change(payeeInput, { target: { value: "Optimistic Coffee" } });

    // Fill Amount: -50.00
    const amountInput = screen.getByPlaceholderText("0.00");
    fireEvent.change(amountInput, { target: { value: "-50.00" } });

    // Save transaction
    const saveBtn = screen.getByRole("button", { name: /save transaction/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // The new row should appear immediately in the register
    expect(screen.getAllByText("Optimistic Coffee").length).toBeGreaterThan(0);

    // Verify that the account balance was optimistically adjusted
    // Initial Chequing balance in seed is -805319 (-$8,053.19) minus $50 = -$8,103.19
    expect(screen.getAllByText("-$8,103.19").length).toBeGreaterThan(0);

    // Resolve POST response
    if (postTransactionResolver) {
      await act(async () => {
        postTransactionResolver!(
          new Response(
            JSON.stringify({
              id: 8888,
              accountId: 1,
              categoryId: null,
              date: "2026-06-15",
              payee: "Optimistic Coffee",
              memo: "",
              amount: -5000,
              status: "u",
              flagColor: null,
              transferAccountId: null,
              parentId: null,
              isIncome: false,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      });
    }
  });

  it("BUG-15: optimistic deleteTransaction adjusts account.balance immediately", async () => {
    let deleteTransactionResolver: ((res: Response) => void) | null = null;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          deleteTransactionResolver = resolve;
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="transactions" />);

    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });

    // Switch to TD Unlimited Chequing
    fireEvent.click(screen.getAllByText("TD Unlimited Chequing")[0]!);

    // Click on the first transaction row in the register to open edit modal
    const tableRows = screen.getAllByRole("row");
    const firstRow = tableRows[1]!;
    fireEvent.click(firstRow);

    expect(screen.getByText("Edit Transaction")).toBeDefined();

    // Step 1: Click Delete
    fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
    expect(screen.getByText(/^Delete /)).toBeDefined();

    // Step 2: Confirm deletion
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });

    // Deleting -17.95 from -8053.19 should optimistically increase balance to -8035.24 (-$8,035.24)
    expect(screen.getAllByText("-$8,035.24").length).toBeGreaterThan(0);

    // Resolve DELETE response
    if (deleteTransactionResolver) {
      await act(async () => {
        deleteTransactionResolver!(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });
    }
  });
});
