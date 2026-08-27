// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData, type BudgetData, type Transaction } from "@ynab/logic";

describe("BudgetAppShell (BUG-25 & BUG-26)", () => {
  let initialBudget: BudgetData;

  beforeEach(() => {
    vi.restoreAllMocks();
    initialBudget = makeSeedBudgetData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG-25: out-of-order budget reload response does not overwrite newer mutation state", async () => {
    let reloadResolvers: Array<(res: Response) => void> = [];
    let budgetCallCount = 0;

    const staleBudget: BudgetData = {
      ...initialBudget,
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        budgetCallCount++;
        if (budgetCallCount === 1) {
          // Initial load
          return new Response(JSON.stringify(staleBudget), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (budgetCallCount === 2) {
          // Reload 1 (from Mutation 1 delete) - delayed
          return new Promise<Response>((resolve) => {
            reloadResolvers.push(resolve);
          });
        }
      }

      if (url.includes("/api/transactions") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="transactions" />);

    // Wait for initial load
    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });

    expect(budgetCallCount).toBe(1);

    // Switch to TD Unlimited Chequing account
    fireEvent.click(screen.getAllByText("TD Unlimited Chequing")[0]!);

    // Click a transaction row to open edit modal and delete it (Mutation 1)
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]!);

    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(deleteBtn);
    const confirmDeleteBtn = screen.getByRole("button", { name: /yes, delete it/i });
    fireEvent.click(confirmDeleteBtn);

    // Reload 1 is now in-flight (delayed)
    await waitFor(() => {
      expect(budgetCallCount).toBe(2);
    });

    // While Reload 1 is in-flight, user cycles status on another transaction (Mutation 2)
    const nextRows = screen.getAllByRole("row");
    const clearedFlag = nextRows[1]!.querySelector(".y-cleared")!;
    expect(clearedFlag.textContent).toBe("C");
    fireEvent.click(clearedFlag);

    // Verify optimistic state updated to 'U'
    await waitFor(() => {
      const updatedRow = screen.getAllByRole("row")[1]!;
      expect(updatedRow.querySelector(".y-cleared")!.textContent).toBe("U");
    });

    // Now resolve the stale Reload 1 (which has status 'c' for that transaction)
    await act(async () => {
      if (reloadResolvers[0]) {
        reloadResolvers[0](
          new Response(JSON.stringify(staleBudget), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    });

    // Verify that the status was NOT overwritten back to 'C' by stale Reload 1!
    const finalRow = screen.getAllByRole("row")[1]!;
    expect(finalRow.querySelector(".y-cleared")!.textContent).toBe("U");
  });

  it("BUG-26: updating status on split parent optimistically propagates status to child rows", async () => {
    const parentTx: Transaction = {
      id: 500,
      accountId: 1,
      categoryId: null,
      date: "2026-08-01",
      payee: "Target Split",
      memo: "Parent Memo",
      amount: "-50.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: null,
    };
    const child1: Transaction = {
      id: 501,
      accountId: 1,
      categoryId: 1,
      date: "2026-08-01",
      payee: "Target Split",
      memo: "Child 1",
      amount: "-30.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 500,
    };
    const child2: Transaction = {
      id: 502,
      accountId: 1,
      categoryId: 2,
      date: "2026-08-01",
      payee: "Target Split",
      memo: "Child 2",
      amount: "-20.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 500,
    };

    const budgetWithSplit: BudgetData = {
      ...initialBudget,
      transactions: [parentTx, child1, child2, ...initialBudget.transactions],
    };

    let patchBody: any = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(budgetWithSplit), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "PATCH") {
        patchBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
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

    // Select account 1
    fireEvent.click(screen.getAllByText("TD Unlimited Chequing")[0]!);

    // Find the split parent row
    await waitFor(() => {
      expect(screen.getByText("Target Split")).toBeTruthy();
    });

    const parentRow = screen.getByText("Target Split").closest("tr")!;
    expect(parentRow).toBeTruthy();

    // The status flag button on parentRow should be 'C'
    const clearedFlag = parentRow.querySelector(".y-cleared")!;
    expect(clearedFlag.textContent).toBe("C");

    // Click the ClearedFlag on the parent row to cycle status C -> U
    fireEvent.click(clearedFlag);

    // The parent row should optimistically update to 'U'
    await waitFor(() => {
      const updatedRow = screen.getByText("Target Split").closest("tr")!;
      expect(updatedRow.querySelector(".y-cleared")!.textContent).toBe("U");
    });

    expect(patchBody).toMatchObject({ id: 500, status: "u" });
  });
});
