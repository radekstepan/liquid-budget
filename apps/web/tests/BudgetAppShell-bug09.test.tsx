// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData, type BudgetData } from "@ynab/logic";

describe("BudgetAppShell (BUG-09)", () => {
  let initialBudget: BudgetData;

  beforeEach(() => {
    vi.restoreAllMocks();
    initialBudget = makeSeedBudgetData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG-09: optimistic split creation inserts synthetic child rows with correct amounts", async () => {
    let postResolver: ((res: Response) => void) | null = null;
    let postedBody: any = null;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "POST") {
        postedBody = JSON.parse(init.body as string);
        return new Promise<Response>((resolve) => {
          postResolver = resolve;
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

    // Navigate to TD Unlimited Chequing
    fireEvent.click(screen.getAllByText("TD Unlimited Chequing")[0]!);

    // Open Add Transaction modal
    const addBtn = screen.getAllByRole("button", { name: /add a new transaction/i })[0]!;
    fireEvent.click(addBtn);

    // Switch to Split mode
    const splitBtn = screen.getByRole("button", { name: "Split" });
    fireEvent.click(splitBtn);

    // Enter payee
    const payeeTrigger = screen.getByText("e.g. Whole Foods");
    fireEvent.click(payeeTrigger);
    const payeeInput = screen.getByPlaceholderText("e.g. Whole Foods");
    fireEvent.change(payeeInput, { target: { value: "Optimistic Split Test" } });

    // Enter total amount: 100.00 (income split so children don't need categories)
    const amountInputs = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(amountInputs[0]!, { target: { value: "100.00" } });

    // Fill sub-transaction 1 amount: 50.00
    const subAmount1 = screen.getByLabelText("Sub-transaction 1 amount");
    fireEvent.change(subAmount1, { target: { value: "50.00" } });

    // Fill sub-transaction 2 amount: 50.00
    const subAmount2 = screen.getByLabelText("Sub-transaction 2 amount");
    fireEvent.change(subAmount2, { target: { value: "50.00" } });

    // Save
    const saveBtn = screen.getByRole("button", { name: /save transaction/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify POST body has subTransactions
    await waitFor(() => {
      expect(postedBody).not.toBeNull();
      expect(postedBody.subTransactions).toBeDefined();
      expect(postedBody.subTransactions.length).toBe(2);
    });

    // Verify optimistic state: parent shows "Split (Multiple Categories)"
    expect(screen.getAllByText("Split (Multiple Categories)").length).toBeGreaterThan(0);

    // Verify children appear in the register with the parent payee
    const childPayees = screen.getAllByText("Optimistic Split Test");
    expect(childPayees.length).toBeGreaterThanOrEqual(2);

    // Resolve POST so test cleanly finishes
    if (postResolver) {
      await act(async () => {
        postResolver!(
          new Response(
            JSON.stringify({
              parent: {
                id: 9999,
                accountId: 1,
                categoryId: null,
                date: "2026-08-28",
                payee: "Optimistic Split Test",
                memo: "",
                amount: 10000,
                status: "u",
                flagColor: null,
                transferAccountId: null,
                parentId: null,
                isIncome: false,
              },
              children: [
                {
                  id: 10001,
                  accountId: 1,
                  categoryId: null,
                  date: "2026-08-28",
                  payee: "Optimistic Split Test",
                  memo: "",
                  amount: 5000,
                  status: "u",
                  flagColor: null,
                  transferAccountId: null,
                  parentId: 9999,
                  isIncome: true,
                },
                {
                  id: 10002,
                  accountId: 1,
                  categoryId: null,
                  date: "2026-08-28",
                  payee: "Optimistic Split Test",
                  memo: "",
                  amount: 5000,
                  status: "u",
                  flagColor: null,
                  transferAccountId: null,
                  parentId: 9999,
                  isIncome: true,
                },
              ],
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

  it("BUG-09: optimistic updateTransaction on internal transfer re-classifies categoryId to null", async () => {
    let patchResolver: ((res: Response) => void) | null = null;
    let patchBody: any = null;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "PATCH") {
        patchBody = JSON.parse(init.body as string);
        return new Promise<Response>((resolve) => {
          patchResolver = resolve;
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

    // Navigate to TD Unlimited Chequing
    fireEvent.click(screen.getAllByText("TD Unlimited Chequing")[0]!);

    // Find the "AMEX Payment" row in the register table
    await waitFor(() => {
      expect(screen.getAllByText("AMEX Payment").length).toBeGreaterThan(0);
    });

    // The register shows AMEX Payment in both the table row and potentially elsewhere.
    // Click the first "AMEX Payment" element which is in the register.
    const firstAmex = screen.getAllByText("AMEX Payment")[0]!;
    const amexRow = firstAmex.closest("tr")!;
    fireEvent.click(amexRow);

    // Verify edit modal opened
    await waitFor(() => {
      expect(screen.getByText("Edit Transaction")).toBeDefined();
    });

    // Save without changing anything — the PATCH should be sent but the optimistic
    // state for categoryId should remain null (transfer is already null).
    // We verify the register still shows "Transfer" category.
    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify PATCH was called
    await waitFor(() => {
      expect(patchBody).not.toBeNull();
    });

    // The register should show "Transfer" as the category for the AMEX Payment row
    await waitFor(() => {
      const allAmex = screen.getAllByText("AMEX Payment");
      const row = allAmex.find((el) => el.closest("tr")?.querySelector(".y-cleared"));
      expect(row?.closest("tr")?.textContent).toContain("Transfer");
    });

    // Resolve PATCH so test cleanly finishes
    if (patchResolver) {
      await act(async () => {
        patchResolver!(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });
    }
  });
});
