"use client";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "./GlobalSearch.js";
import { SERVER_SEARCH_TXN_THRESHOLD } from "@ynab/logic";
import type { BudgetData } from "@ynab/logic";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function bigFixture(): BudgetData {
  const base = fixture();
  return {
    ...base,
    transactions: Array.from({ length: SERVER_SEARCH_TXN_THRESHOLD + 10 }, (_, i) => ({
      id: 1000 + i,
      accountId: 1,
      categoryId: 100,
      date: "2026-09-01",
      payee: `Bulk Payee ${i % 50}`,
      memo: "",
      amount: "-100",
      status: "c" as const,
      parentId: null,
      transferAccountId: null,
    })),
  };
}

function serverPayload() {
  return {
    payees: [{ name: "Server Payee", txnCount: 4999 }],
    categories: [],
    transactions: [
      {
        id: 4242,
        accountId: 1,
        accountName: "Checking",
        payee: "Server Payee",
        memo: "",
        categoryId: 100,
        categoryName: "Groceries",
        date: "2026-09-01",
        amount: -100,
        rank: 1,
      },
    ],
    payeeOptions: [{ value: "Server Payee", label: "Server Payee (4999)" }],
    nextCursor: null,
    hasMore: false,
  };
}

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

  it("uses GET /api/search for large budgets and renders server hits", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      const payload = url.includes("query=server")
        ? serverPayload()
        : {
            payees: [],
            categories: [],
            transactions: [],
            payeeOptions: [],
            nextCursor: null,
            hasMore: false,
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const onJump = vi.fn();
    render(<GlobalSearch data={bigFixture()} scopeAccountId={null} onJump={onJump} />);
    const input = screen.getByLabelText("Global search");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "server" } });
    // Flush the 150ms input debounce + fetch + deferred render inside act.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    expect(screen.getAllByText("Server Payee").length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toContain("/api/search?");
    expect(seen[seen.length - 1]).toContain("query=server");
  });

  it("falls back to the client index when the server fetch fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const onJump = vi.fn();
    render(<GlobalSearch data={bigFixture()} scopeAccountId={null} onJump={onJump} />);
    const input = screen.getByLabelText("Global search");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bulk payee 1" } });
    // Flush the debounce + failed fetch + client-index fallback inside act.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // Client fallback ranks the substring hit from the local transactions.
    expect(screen.getAllByText("Bulk Payee 1").length).toBeGreaterThan(0);
  });
});
