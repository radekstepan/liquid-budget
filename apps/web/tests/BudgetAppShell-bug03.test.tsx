// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData, type BudgetData, type Transaction } from "@ynab/logic";

let capturedProps: { data: BudgetData; api: any } | null = null;

vi.mock("@ynab/ui", async () => {
  const actual = await vi.importActual<any>("@ynab/ui");
  return {
    ...actual,
    BudgetApp: (props: any) => {
      capturedProps = props;
      return <div data-testid="budget-app" />;
    },
  };
});

describe("BudgetAppShell (BUG-03)", () => {
  let initialBudget: BudgetData;

  beforeEach(() => {
    vi.restoreAllMocks();
    capturedProps = null;
    const seed = makeSeedBudgetData();

    const splitParent: Transaction = {
      id: 1000,
      accountId: 1,
      categoryId: null,
      date: "2026-06-01",
      payee: "Supermarket Split",
      memo: "Split parent memo",
      amount: "-100.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: null,
      isIncome: false,
    };
    const splitChild1: Transaction = {
      id: 1001,
      accountId: 1,
      categoryId: 1,
      date: "2026-06-01",
      payee: "Supermarket Split",
      memo: "Child 1 memo",
      amount: "-60.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 1000,
      isIncome: false,
    };
    const splitChild2: Transaction = {
      id: 1002,
      accountId: 1,
      categoryId: 2,
      date: "2026-06-01",
      payee: "Supermarket Split",
      memo: "Child 2 memo",
      amount: "-40.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 1000,
      isIncome: false,
    };

    initialBudget = {
      ...seed,
      transactions: [splitParent, splitChild1, splitChild2, ...seed.transactions],
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG-03: optimistic deleteTransaction on split child with 2 children flattens remaining child and deletes parent", async () => {
    let deleteUrl = "";

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "DELETE") {
        deleteUrl = url;
        return new Promise<Response>(() => {}); // Keep in-flight to inspect optimistic state
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="transactions" />);

    await waitFor(() => {
      expect(capturedProps).not.toBeNull();
    });

    const initialAccount1 = capturedProps!.data.accounts.find((a) => a.id === 1);
    const initialBal = Number(initialAccount1!.balance);

    // Call deleteTransaction on Child 1 (id: 1001)
    await act(async () => {
      capturedProps!.api.deleteTransaction(1001);
    });

    // In optimistic state:
    const txs = capturedProps!.data.transactions;
    // Child 1 (1001) and Split Parent (1000) must be removed, Child 2 (1002) is flattened!
    expect(txs.some((t) => t.id === 1001)).toBe(false);
    expect(txs.some((t) => t.id === 1000)).toBe(false);
    const flattened = txs.find((t) => t.id === 1002);
    expect(flattened).toBeDefined();
    expect(flattened?.parentId).toBeNull();
    expect(flattened?.amount).toBe("-40.00");

    // Account balance should have increased by +$60.00 (+6000 cents)
    const updatedAccount1 = capturedProps!.data.accounts.find((a) => a.id === 1);
    expect(Number(updatedAccount1!.balance)).toBe(initialBal + 60);
  });

  it("BUG-03: optimistic bulkDeleteTransactions on split child flattens remaining child and deletes parent", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions?action=bulk-delete") && init?.method === "POST") {
        return new Promise<Response>(() => {});
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="transactions" />);

    await waitFor(() => {
      expect(capturedProps).not.toBeNull();
    });

    const initialAccount1 = capturedProps!.data.accounts.find((a) => a.id === 1);
    const initialBal = Number(initialAccount1!.balance);

    // Bulk delete Child 1 (id: 1001)
    await act(async () => {
      capturedProps!.api.bulkDeleteTransactions([1001]);
    });

    const txs = capturedProps!.data.transactions;
    expect(txs.some((t) => t.id === 1001)).toBe(false);
    expect(txs.some((t) => t.id === 1000)).toBe(false);
    const flattened = txs.find((t) => t.id === 1002);
    expect(flattened).toBeDefined();
    expect(flattened?.parentId).toBeNull();
    expect(flattened?.amount).toBe("-40.00");

    const updatedAccount1 = capturedProps!.data.accounts.find((a) => a.id === 1);
    expect(Number(updatedAccount1!.balance)).toBe(initialBal + 60);
  });

  it("BUG-03: optimistic deleteTransaction on a 3-child split updates parent total amount", async () => {
    const splitParent: Transaction = {
      id: 2000,
      accountId: 1,
      categoryId: null,
      date: "2026-06-01",
      payee: "3-Child Split",
      memo: "Parent memo",
      amount: "-100.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: null,
      isIncome: false,
    };
    const child1: Transaction = {
      id: 2001,
      accountId: 1,
      categoryId: 1,
      date: "2026-06-01",
      payee: "3-Child Split",
      memo: "Child 1",
      amount: "-50.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 2000,
      isIncome: false,
    };
    const child2: Transaction = {
      id: 2002,
      accountId: 1,
      categoryId: 2,
      date: "2026-06-01",
      payee: "3-Child Split",
      memo: "Child 2",
      amount: "-30.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 2000,
      isIncome: false,
    };
    const child3: Transaction = {
      id: 2003,
      accountId: 1,
      categoryId: 3,
      date: "2026-06-01",
      payee: "3-Child Split",
      memo: "Child 3",
      amount: "-20.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 2000,
      isIncome: false,
    };

    const budgetWith3ChildSplit: BudgetData = {
      ...initialBudget,
      transactions: [splitParent, child1, child2, child3, ...initialBudget.transactions],
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(budgetWith3ChildSplit), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions") && init?.method === "DELETE") {
        return new Promise<Response>(() => {});
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="transactions" />);

    await waitFor(() => {
      expect(capturedProps).not.toBeNull();
    });

    // Delete child 1 ($50.00)
    await act(async () => {
      capturedProps!.api.deleteTransaction(2001);
    });

    const txs = capturedProps!.data.transactions;
    // Child 1 removed, Child 2 and 3 remain, Parent remains
    expect(txs.some((t) => t.id === 2001)).toBe(false);
    expect(txs.some((t) => t.id === 2002)).toBe(true);
    expect(txs.some((t) => t.id === 2003)).toBe(true);

    const parentTx = txs.find((t) => t.id === 2000);
    expect(parentTx).toBeDefined();
    // New parent amount should be -30 + -20 = -50.00
    expect(parentTx!.amount).toBe("-50.00");
  });

  it("BUG-24: optimistic bulkDeleteTransactions on 2 children of a 3-child split flattens remaining child and deletes parent", async () => {
    const splitParent: Transaction = {
      id: 3000,
      accountId: 1,
      categoryId: null,
      date: "2026-06-01",
      payee: "3-Child Split",
      memo: "Parent memo",
      amount: "-100.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: null,
      isIncome: false,
    };
    const child1: Transaction = {
      id: 3001,
      accountId: 1,
      categoryId: 1,
      date: "2026-06-01",
      payee: "3-Child Split",
      memo: "Child 1",
      amount: "-50.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 3000,
      isIncome: false,
    };
    const child2: Transaction = {
      id: 3002,
      accountId: 1,
      categoryId: 2,
      date: "2026-06-01",
      payee: "3-Child Split",
      memo: "Child 2",
      amount: "-30.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 3000,
      isIncome: false,
    };
    const child3: Transaction = {
      id: 3003,
      accountId: 1,
      categoryId: 3,
      date: "2026-06-01",
      payee: "3-Child Split",
      memo: "Child 3",
      amount: "-20.00",
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: 3000,
      isIncome: false,
    };

    const budgetWith3ChildSplit: BudgetData = {
      ...initialBudget,
      transactions: [splitParent, child1, child2, child3, ...initialBudget.transactions],
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(budgetWith3ChildSplit), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/transactions?action=bulk-delete") && init?.method === "POST") {
        return new Promise<Response>(() => {});
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="transactions" />);

    await waitFor(() => {
      expect(capturedProps).not.toBeNull();
    });

    const initialAccount1 = capturedProps!.data.accounts.find((a) => a.id === 1);
    const initialBal = Number(initialAccount1!.balance);

    // Bulk delete child 1 (3001) and child 2 (3002)
    await act(async () => {
      capturedProps!.api.bulkDeleteTransactions([3001, 3002]);
    });

    const txs = capturedProps!.data.transactions;
    // Parent and deleted children must be removed; remaining child 3003 is flattened
    expect(txs.some((t) => t.id === 3000)).toBe(false);
    expect(txs.some((t) => t.id === 3001)).toBe(false);
    expect(txs.some((t) => t.id === 3002)).toBe(false);
    const flattened = txs.find((t) => t.id === 3003);
    expect(flattened).toBeDefined();
    expect(flattened?.parentId).toBeNull();
    expect(flattened?.amount).toBe("-20.00");

    // Account balance should have increased by +$80.00 (+50 + +30)
    const updatedAccount1 = capturedProps!.data.accounts.find((a) => a.id === 1);
    expect(Number(updatedAccount1!.balance)).toBe(initialBal + 80);
  });
});
