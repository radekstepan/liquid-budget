// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent, within } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData, type BudgetData } from "@ynab/logic";

function openSearchableInModal(modal: HTMLElement, label: string | RegExp): HTMLInputElement {
  const existing = within(modal).queryByRole("textbox", { name: label });
  if (existing) {
    act(() => {
      existing.focus();
    });
    return existing;
  }
  const trigger = within(modal).getByRole("button", { name: label });
  fireEvent.click(trigger);
  const input = within(modal).getByRole("textbox", { name: label });
  act(() => {
    input.focus();
  });
  return input;
}

function findOptionByValueAcrossListboxes(value: string): HTMLButtonElement {
  for (const list of screen.getAllByRole("listbox")) {
    const options = within(list).getAllByRole("option") as HTMLButtonElement[];
    const target = options.find((o) => o.getAttribute("data-value") === value);
    if (target) return target;
  }
  throw new Error(`No option with value="${value}" in any open searchable dropdown`);
}

function pickFromOpenSearchableByValue(modal: HTMLElement, label: string | RegExp, value: string): void {
  openSearchableInModal(modal, label);
  fireEvent.click(findOptionByValueAcrossListboxes(value));
}

describe("BudgetAppShell (BUG-06: optimistic transaction income reclassification)", () => {
  let initialBudget: BudgetData;

  beforeEach(() => {
    vi.restoreAllMocks();
    initialBudget = makeSeedBudgetData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG-06: editing an uncategorized inflow to assign a category sets isIncome: false in optimistic state", async () => {
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
        initialBudget = {
          ...initialBudget,
          transactions: initialBudget.transactions.map((tx) =>
            tx.id === patchBody.id
              ? {
                  ...tx,
                  ...patchBody,
                  // The real server String()s money on the wire; mirror that
                  // so the re-served /api/budget satisfies the response contract.
                  amount:
                    patchBody.amount !== undefined ? String(patchBody.amount) : tx.amount,
                  isIncome: patchBody.categoryId == null,
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

    render(<BudgetAppShell initialView="transactions" />);

    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });

    // Navigate to EQ Bank in the sidebar
    fireEvent.click(screen.getAllByText("EQ Bank")[0]!);

    // Find the SAP Concur row in the register table
    await waitFor(() => {
      expect(screen.getAllByText("SAP Concur").length).toBeGreaterThan(0);
    });

    const firstSap = screen.getAllByText("SAP Concur")[0]!;
    const sapRow = firstSap.closest("tr")!;
    fireEvent.click(sapRow);

    // Verify edit modal opened
    await waitFor(() => {
      expect(screen.getByText("Edit Transaction")).toBeDefined();
    });

    const modal = screen.getByText("Edit Transaction").closest(".y-modal") as HTMLElement;

    // Select category 11 (Groceries)
    pickFromOpenSearchableByValue(modal, "Category", "11");

    // Save changes
    const saveBtn = within(modal).getByRole("button", { name: /save changes/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify PATCH was called with categoryId set to Groceries (id: 11)
    await waitFor(() => {
      expect(patchBody).not.toBeNull();
      expect(patchBody.categoryId).toBe(11);
    });

    // In optimistic state & post-reload, the register row should now show Groceries
    await waitFor(() => {
      const allSap = screen.getAllByText("SAP Concur");
      const row = allSap[0]!.closest("tr")!;
      expect(row.textContent).toContain("Groceries");
    });
  });

  it("BUG-06: editing a categorized transaction to clear category sets isIncome: true in optimistic state for inflows", async () => {
    // Set Telus to be an inflow on TD Unlimited Chequing with category 9 (Internet, iPhone)
    initialBudget = {
      ...initialBudget,
      transactions: initialBudget.transactions.map((tx) =>
        tx.payee === "Telus"
          ? {
              ...tx,
              amount: "11000", // +$110.00 inflow
              categoryId: 9,
              isIncome: false,
            }
          : tx
      ),
    };

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
        initialBudget = {
          ...initialBudget,
          transactions: initialBudget.transactions.map((tx) =>
            tx.id === patchBody.id
              ? {
                  ...tx,
                  ...patchBody,
                  // The real server String()s money on the wire; mirror that
                  // so the re-served /api/budget satisfies the response contract.
                  amount:
                    patchBody.amount !== undefined ? String(patchBody.amount) : tx.amount,
                  isIncome: patchBody.categoryId == null,
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

    render(<BudgetAppShell initialView="transactions" />);

    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });

    // Navigate to TD Unlimited Chequing
    fireEvent.click(screen.getAllByText("TD Unlimited Chequing")[0]!);

    // Find the Telus row
    await waitFor(() => {
      expect(screen.getAllByText("Telus").length).toBeGreaterThan(0);
    });

    const firstRow = screen.getAllByText("Telus")[0]!;
    const telusRow = firstRow.closest("tr")!;
    fireEvent.click(telusRow);

    // Verify edit modal opened
    await waitFor(() => {
      expect(screen.getByText("Edit Transaction")).toBeDefined();
    });

    const modal = screen.getByText("Edit Transaction").closest(".y-modal") as HTMLElement;

    // Select "Income: Available this month" (value: "")
    pickFromOpenSearchableByValue(modal, "Category", "");

    // Save changes
    const saveBtn = within(modal).getByRole("button", { name: /save changes/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify PATCH was called with categoryId: null
    await waitFor(() => {
      expect(patchBody).not.toBeNull();
      expect(patchBody.categoryId).toBeNull();
    });

    // In optimistic state, the register row should no longer show Internet, iPhone
    await waitFor(() => {
      const row = screen.getAllByText("Telus")[0]!.closest("tr")!;
      expect(row.textContent).not.toContain("Internet, iPhone");
    });
  });
});
