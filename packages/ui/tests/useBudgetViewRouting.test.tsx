import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { BudgetData, RenameRule, Transaction } from "@ynab/logic";
import {
  useBudgetViewRouting,
  type BudgetViewRoutingArgs,
} from "../src/useBudgetViewRouting.js";

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
      txn({ id: 1, accountId: 7 }),
      txn({ id: 100, accountId: 1 }),
      txn({ id: 101, accountId: 1, parentId: 100 }),
    ],
    recurring: [],
  };
}

function spies() {
  return {
    setView: vi.fn(),
    setAccountFilter: vi.fn(),
    setShowSettingsOverlay: vi.fn(),
    setSearchOpen: vi.fn(),
    updateUrl: vi.fn(),
  };
}

// NOTE: data must be created once per test and closed over — building it
// inside the render callback gives a fresh identity every render.
function routingArgs(
  data: BudgetData,
  spy: ReturnType<typeof spies>,
  overrides: Partial<BudgetViewRoutingArgs> = {}
): BudgetViewRoutingArgs {
  return {
    data,
    month: "2026-06",
    updateUrl: spy.updateUrl,
    setView: spy.setView,
    accountFilter: null,
    setAccountFilter: spy.setAccountFilter,
    setShowSettingsOverlay: spy.setShowSettingsOverlay,
    setSearchOpen: spy.setSearchOpen,
    ...overrides,
  };
}

describe("useBudgetViewRouting (ui-split slice 13)", () => {
  it("starts with no navigation targets", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useBudgetViewRouting(routingArgs(data, spies())));
    expect(result.current.reportsResetKey).toBe(0);
    expect(result.current.focusTransaction).toBeNull();
    expect(result.current.registerFilter).toBeNull();
  });

  it("navigates to the register with a cleared account filter", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() =>
      useBudgetViewRouting(routingArgs(data, spy, { accountFilter: 7 }))
    );
    act(() => {
      result.current.navigateView("transactions");
    });
    expect(spy.setView).toHaveBeenCalledWith("transactions");
    expect(spy.setAccountFilter).toHaveBeenCalledWith(null);
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", null, "2026-06");
    expect(spy.setShowSettingsOverlay).toHaveBeenCalledWith(false);
    expect(result.current.reportsResetKey).toBe(0);
  });

  it("bumps the reports reset key and keeps the filter elsewhere", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() =>
      useBudgetViewRouting(routingArgs(data, spy, { accountFilter: 7 }))
    );
    act(() => {
      result.current.navigateView("reports");
    });
    expect(spy.setView).toHaveBeenCalledWith("reports");
    expect(result.current.reportsResetKey).toBe(1);
    expect(spy.updateUrl).toHaveBeenCalledWith("reports", 7, "2026-06");

    act(() => {
      result.current.navigateView("budget");
    });
    expect(result.current.reportsResetKey).toBe(1);
    expect(spy.updateUrl).toHaveBeenCalledWith("budget", 7, "2026-06");
  });

  it("toggles the account register on selection", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() =>
      useBudgetViewRouting(routingArgs(data, spy, { accountFilter: 7 }))
    );
    act(() => {
      result.current.handleSelectAccount(7);
    });
    expect(spy.setAccountFilter).toHaveBeenCalledWith(null);
    expect(spy.setView).toHaveBeenCalledWith("transactions");
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", null, "2026-06");
  });

  it("selects a different account register", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() => useBudgetViewRouting(routingArgs(data, spy)));
    act(() => {
      result.current.handleSelectAccount(7);
    });
    expect(spy.setAccountFilter).toHaveBeenCalledWith(7);
    expect(spy.setView).toHaveBeenCalledWith("transactions");
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", 7, "2026-06");
  });

  it("opens badge registers pre-filtered without toggling off", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() =>
      useBudgetViewRouting(routingArgs(data, spy, { accountFilter: 7 }))
    );
    act(() => {
      result.current.handleBadgeClick(7, "new");
    });
    expect(spy.setAccountFilter).toHaveBeenCalledWith(7);
    expect(spy.setView).toHaveBeenCalledWith("transactions");
    expect(result.current.registerFilter).toMatchObject({
      query: { filters: [{ kind: "is", value: "new" }], text: "" },
    });
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", 7, "2026-06");

    act(() => {
      result.current.handleBadgeClick(1, "duplicates");
    });
    expect(result.current.registerFilter).toMatchObject({
      query: { filters: [{ kind: "is", value: "duplicate" }] },
    });
  });

  it("jumps from reports to a transaction and its split parent", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() => useBudgetViewRouting(routingArgs(data, spy)));

    act(() => {
      result.current.handleSelectTransactionFromReport(
        data.transactions.find((t) => t.id === 1)!
      );
    });
    expect(spy.setAccountFilter).toHaveBeenCalledWith(7);
    expect(spy.setView).toHaveBeenCalledWith("transactions");
    expect(result.current.focusTransaction).toMatchObject({ id: 1 });
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", 7, "2026-06");

    act(() => {
      result.current.handleSelectTransactionFromReport(
        data.transactions.find((t) => t.id === 101)!
      );
    });
    expect(spy.setAccountFilter).toHaveBeenCalledWith(1);
    expect(result.current.focusTransaction).toMatchObject({ id: 100 });
  });

  it("jumps to transfer counterparts", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() => useBudgetViewRouting(routingArgs(data, spy)));
    act(() => {
      result.current.handleGoToTransfer(7, 42);
    });
    expect(spy.setAccountFilter).toHaveBeenCalledWith(7);
    expect(spy.setView).toHaveBeenCalledWith("transactions");
    expect(result.current.focusTransaction).toMatchObject({ id: 42 });
    expect(spy.setShowSettingsOverlay).toHaveBeenCalledWith(false);
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", 7, "2026-06");
  });

  it("drops the register filter entirely on clear", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() => useBudgetViewRouting(routingArgs(data, spy)));
    act(() => {
      result.current.handleBadgeClick(1, "new");
    });
    expect(result.current.registerFilter).not.toBeNull();
    act(() => {
      result.current.handleClearRegisterFilter();
    });
    expect(result.current.registerFilter).toBeNull();
  });

  it("routes global-search transaction jumps to a focused row", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() => useBudgetViewRouting(routingArgs(data, spy)));
    act(() => {
      result.current.handleGlobalSearchJump({ kind: "transaction", transactionId: 9, accountId: 7 });
    });
    expect(spy.setSearchOpen).toHaveBeenCalledWith(false);
    expect(spy.setAccountFilter).toHaveBeenCalledWith(7);
    expect(spy.setView).toHaveBeenCalledWith("transactions");
    expect(result.current.focusTransaction).toMatchObject({ id: 9 });
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", 7, "2026-06");
  });

  it("routes global-search filter jumps to a filtered register", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() =>
      useBudgetViewRouting(routingArgs(data, spy, { accountFilter: 7 }))
    );

    act(() => {
      result.current.handleGlobalSearchJump({ kind: "payee", payee: "Shell" });
    });
    expect(result.current.registerFilter).toMatchObject({ payee: "Shell", categoryId: null });
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", 7, "2026-06");

    act(() => {
      result.current.handleGlobalSearchJump({ kind: "category", categoryId: 10 });
    });
    expect(result.current.registerFilter).toMatchObject({ categoryId: 10 });

    const query = { filters: [], text: "fuel" };
    act(() => {
      result.current.handleGlobalSearchJump({ kind: "query", query });
    });
    expect(result.current.registerFilter).toMatchObject({ query });

    act(() => {
      result.current.handleGlobalSearchJump({ kind: "text", text: "store" });
    });
    expect(result.current.registerFilter).toMatchObject({ text: "store" });
    expect(spy.setSearchOpen).toHaveBeenCalledWith(false);
  });

  it("jumps to rename-rule matches and ignores empty patterns", () => {
    const data = makeTestData();
    const spy = spies();
    const { result } = renderHook(() =>
      useBudgetViewRouting(routingArgs(data, spy, { accountFilter: 7 }))
    );
    const rule: RenameRule = {
      id: 1,
      sourcePattern: "STARBUCKS",
      targetPayee: "Starbucks",
      createdAt: "2026-01-01",
    };
    act(() => {
      result.current.handleViewRuleMatches(rule);
    });
    expect(spy.setView).toHaveBeenCalledWith("transactions");
    expect(result.current.registerFilter).toMatchObject({ payee: "STARBUCKS", categoryId: null });
    expect(spy.updateUrl).toHaveBeenCalledWith("transactions", 7, "2026-06");

    spy.setView.mockClear();
    act(() => {
      result.current.handleViewRuleMatches({ ...rule, sourcePattern: "   " });
    });
    expect(spy.setView).not.toHaveBeenCalled();
  });
});
