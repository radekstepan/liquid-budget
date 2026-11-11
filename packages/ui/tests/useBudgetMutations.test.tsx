import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { todayISO } from "@ynab/logic";
import type { BudgetData, Transaction } from "@ynab/logic";
import type { BudgetAppApi } from "../src/BudgetAppApi.js";
import {
  useBudgetMutations,
  type BudgetMutationsArgs,
} from "../src/useBudgetMutations.js";

function txn(partial: Partial<Transaction> & { id: number }): Transaction {
  return {
    accountId: 1,
    categoryId: 10,
    date: "2026-06-05",
    payee: "Store",
    memo: "",
    amount: "-20000",
    status: "u",
    ...partial,
  };
}

function makeTestData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 0 },
      { id: 7, name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 1 },
    ],
    groups: [
      { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
    ],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      txn({ id: 1, status: "u" }),
      txn({ id: 2, status: "c" }),
      txn({ id: 3, status: "r" }),
      txn({ id: 4, status: "c", transferAccountId: 7, transferStatus: "u" }),
      txn({ id: 5, status: "u", transferAccountId: 7, transferStatus: "r" }),
    ],
    recurring: [
      {
        id: 11,
        accountId: 1,
        categoryId: 10,
        payee: "Active Sub",
        memo: "",
        amount: "-999",
        frequency: "monthly",
        nextDate: "2026-01-01",
        active: true,
        splits: [],
      },
      {
        id: 12,
        accountId: 1,
        categoryId: 10,
        payee: "Paused Sub",
        memo: "",
        amount: "-999",
        frequency: "monthly",
        nextDate: "2999-01-01",
        active: false,
        splits: [],
      },
    ],
  };
}

function mockApi() {
  return {
    assign: vi.fn(),
    updateTransaction: vi.fn(),
    updateRecurring: vi.fn(),
    postRecurring: vi.fn(),
  };
}

// NOTE: data must be created once per test and closed over — building it
// inside the render callback gives a fresh identity every render.
function mutArgs(
  data: BudgetData,
  api: ReturnType<typeof mockApi>,
  overrides: Partial<BudgetMutationsArgs> = {}
): BudgetMutationsArgs {
  return {
    api: api as unknown as BudgetAppApi,
    data,
    month: "2026-06",
    accountFilter: null,
    ...overrides,
  };
}

describe("useBudgetMutations (ui-split slice 12)", () => {
  it("assigns to the current month by default and honors overrides", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() => useBudgetMutations(mutArgs(data, api)));

    await result.current.assign(10, 5000);
    expect(api.assign).toHaveBeenCalledWith(10, 5000, "2026-06");

    await result.current.assign(10, 1, "2026-01");
    expect(api.assign).toHaveBeenCalledWith(10, 1, "2026-01");
  });

  it("swallows assign errors for the shell toast/rollback path", async () => {
    const data = makeTestData();
    const api = mockApi();
    api.assign.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useBudgetMutations(mutArgs(data, api)));

    await expect(result.current.assign(10, 5000)).resolves.toBeUndefined();
  });

  it("cycles uncleared to cleared and back", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() => useBudgetMutations(mutArgs(data, api)));

    await result.current.cycleStatus(1);
    expect(api.updateTransaction).toHaveBeenCalledWith(1, { status: "c" });

    await result.current.cycleStatus(2);
    expect(api.updateTransaction).toHaveBeenCalledWith(2, { status: "u" });
  });

  it("skips reconciled and missing transactions", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() => useBudgetMutations(mutArgs(data, api)));

    await result.current.cycleStatus(3);
    await result.current.cycleStatus(999);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it("cycles the transfer leg for incoming transfers in the filtered account", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() =>
      useBudgetMutations(mutArgs(data, api, { accountFilter: 7 }))
    );

    await result.current.cycleStatus(4);
    expect(api.updateTransaction).toHaveBeenCalledWith(4, { transferStatus: "c" });
  });

  it("skips reconciled transfer legs and uses the own leg otherwise", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() =>
      useBudgetMutations(mutArgs(data, api, { accountFilter: 7 }))
    );

    await result.current.cycleStatus(5);
    expect(api.updateTransaction).not.toHaveBeenCalled();

    // Same transfer viewed from the other account cycles the own status.
    const other = renderHook(() => useBudgetMutations(mutArgs(data, api)));
    await other.result.current.cycleStatus(4);
    expect(api.updateTransaction).toHaveBeenCalledWith(4, { status: "u" });
  });

  it("writes and clears flags", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() => useBudgetMutations(mutArgs(data, api)));

    await result.current.setFlag(1, "red");
    expect(api.updateTransaction).toHaveBeenCalledWith(1, { flagColor: "red" });

    await result.current.setFlag(1, null);
    expect(api.updateTransaction).toHaveBeenCalledWith(1, { flagColor: null });
  });

  it("posts active recurring without resuming", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() => useBudgetMutations(mutArgs(data, api)));

    await result.current.postRecurringOneClick(11);
    expect(api.updateRecurring).not.toHaveBeenCalled();
    // Past nextDate with no explicit date posts undated.
    expect(api.postRecurring).toHaveBeenCalledWith(11, undefined);
  });

  it("resumes paused recurring before posting, clamping future dates to today", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() => useBudgetMutations(mutArgs(data, api)));

    await result.current.postRecurringOneClick(12);
    expect(api.updateRecurring).toHaveBeenCalledWith(12, { active: true });
    expect(api.postRecurring).toHaveBeenCalledWith(12, todayISO());
    expect(api.updateRecurring.mock.invocationCallOrder[0]).toBeLessThan(
      api.postRecurring.mock.invocationCallOrder[0]!
    );
  });

  it("passes explicit posting dates through and tolerates missing rules", async () => {
    const data = makeTestData();
    const api = mockApi();
    const { result } = renderHook(() => useBudgetMutations(mutArgs(data, api)));

    await result.current.postRecurringOneClick(11, "2026-01-15");
    expect(api.postRecurring).toHaveBeenCalledWith(11, "2026-01-15");

    await result.current.postRecurringOneClick(999);
    expect(api.updateRecurring).not.toHaveBeenCalled();
    expect(api.postRecurring).toHaveBeenCalledWith(999, undefined);
  });
});
