// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent, within, cleanup } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData, type BudgetData } from "@ynab/logic";

describe("BudgetAppShell (needsReview: approving an import clears bold without refetch)", () => {
  let initialBudget: BudgetData;
  let budgetGets: number;
  let patchBody: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    budgetGets = 0;
    patchBody = null;
    // Mirror a fresh CSV import: uncleared + needing review.
    initialBudget = makeSeedBudgetData();
    initialBudget = {
      ...initialBudget,
      transactions: initialBudget.transactions.map((tx) =>
        tx.payee === "SAP Concur" ? { ...tx, status: "u" as const, needsReview: true } : tx
      ),
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        budgetGets += 1;
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "PATCH") {
        patchBody = JSON.parse(init.body as string);
        // Mirror the real server: any edit reviews the row. The C-click
        // test below still proves the optimistic path because status-only
        // edits skip the reload entirely (no refetch to deliver this).
        initialBudget = {
          ...initialBudget,
          transactions: initialBudget.transactions.map((tx) =>
            tx.id === patchBody.id
              ? {
                  ...tx,
                  ...(patchBody.memo !== undefined ? { memo: patchBody.memo } : {}),
                  ...(patchBody.status !== undefined ? { status: patchBody.status } : {}),
                  ...(patchBody.amount !== undefined ? { amount: String(patchBody.amount) } : {}),
                  needsReview: false,
                }
              : tx
          ),
        };
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
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function openRegisterOnSap(): Promise<HTMLElement> {
    render(<BudgetAppShell initialView="transactions" />);
    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });
    fireEvent.click(screen.getAllByText("EQ Bank")[0]!);
    await waitFor(() => {
      expect(screen.getAllByText("SAP Concur").length).toBeGreaterThan(0);
    });
    const row = screen.getAllByText("SAP Concur")[0]!.closest("tr")!;
    expect(row.classList.contains("font-bold")).toBe(true);
    return row;
  }

  it("C-column approve (u -> c) un-bolds without a budget refetch", async () => {
    const row = await openRegisterOnSap();
    const getsBefore = budgetGets;

    // Unreviewed rows show "N" (New) in the C column until approved.
    const badge = within(row).getByRole("button", { name: "New" });
    expect(badge.textContent).toBe("N");

    await act(async () => {
      fireEvent.click(badge);
    });

    await waitFor(() => {
      expect(patchBody).not.toBeNull();
      expect(patchBody.status).toBe("c");
    });
    // Status-only edits skip the reload: the row must un-bold optimistically.
    expect(budgetGets).toBe(getsBefore);
    await waitFor(() => {
      const updated = screen.getAllByText("SAP Concur")[0]!.closest("tr")!;
      expect(updated.classList.contains("font-bold")).toBe(false);
      expect(within(updated).getByRole("button", { name: "Cleared" }).textContent).toBe("C");
    });
  });

  it("modal resave un-bolds via the reloaded server state", async () => {
    const row = await openRegisterOnSap();

    fireEvent.click(row);
    await waitFor(() => {
      expect(screen.getByText("Edit Transaction")).toBeDefined();
    });
    const modal = screen.getByText("Edit Transaction").closest(".y-modal") as HTMLElement;
    fireEvent.change(within(modal).getByPlaceholderText("Optional notes"), {
      target: { value: "reviewed" },
    });
    await act(async () => {
      fireEvent.click(within(modal).getByRole("button", { name: /save changes/i }));
    });

    await waitFor(() => {
      expect(patchBody).not.toBeNull();
      expect(patchBody.memo).toBe("reviewed");
    });
    // Modal saves send the full payload, which reloads: the mock server
    // above cleared the flag, so the re-served row un-bolds.
    await waitFor(() => {
      const updated = screen.getAllByText("SAP Concur")[0]!.closest("tr")!;
      expect(updated.classList.contains("font-bold")).toBe(false);
    });
  });
});
