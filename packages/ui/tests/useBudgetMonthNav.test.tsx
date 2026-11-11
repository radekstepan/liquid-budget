import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { monthKey, parseMonthKey, todayISO } from "@ynab/logic";
import type { BudgetData } from "@ynab/logic";
import type { View } from "../src/Sidebar.js";
import {
  useBudgetMonthNav,
  type BudgetMonthNavArgs,
} from "../src/useBudgetMonthNav.js";

const MONTH_COUNT_KEY = "ynab:budget:monthCount";

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function makeTestData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 0 },
    ],
    groups: [
      { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
    ],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [{ categoryId: 10, month: "2021-03", amount: 10000 }],
    transactions: [
      {
        id: 1,
        accountId: 1,
        categoryId: 10,
        date: "2019-11-05",
        payee: "Old Store",
        memo: "",
        amount: "-20000",
        status: "c",
      },
    ],
    recurring: [
      {
        id: 1,
        accountId: 1,
        categoryId: 10,
        payee: "Future Sub",
        memo: "",
        amount: "-999",
        frequency: "monthly",
        nextDate: "2030-05-01",
        active: true,
        splits: [],
      },
    ],
  };
}

// NOTE: data must be created once per test and closed over — building it
// inside the render callback gives a fresh identity every render.
function navArgs(
  data: BudgetData,
  overrides: Partial<BudgetMonthNavArgs> = {}
): BudgetMonthNavArgs {
  return {
    data,
    view: "budget" as View,
    setView: () => {},
    accountFilter: null,
    setAccountFilter: () => {},
    ...overrides,
  };
}

/** Newest navigable month: one past today (mirrors the hook's clamp). */
function maxAllowedMonth(): string {
  const { year, month0 } = parseMonthKey(todayISO().slice(0, 7));
  const total = year * 12 + month0 + 1;
  return monthKey(Math.floor(total / 12), ((total % 12) + 12) % 12);
}

describe("useBudgetMonthNav (ui-split slice 11)", () => {
  it("initializes month to today and monthCount to 3", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useBudgetMonthNav(navArgs(data)));
    expect(result.current.month).toBe(todayISO().slice(0, 7));
    expect(result.current.monthCount).toBe(3);
  });

  it("honors a valid initialMonth and rejects an invalid one", () => {
    const data = makeTestData();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: "2024-02" }))
    );
    expect(result.current.month).toBe("2024-02");

    const bad = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: "bogus" }))
    );
    expect(bad.result.current.month).toBe(todayISO().slice(0, 7));
  });

  it("centers visibleMonths on the anchor in the budget view", () => {
    const data = makeTestData();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: "2026-06" }))
    );
    expect(result.current.visibleMonths).toEqual(["2026-05", "2026-06", "2026-07"]);
  });

  it("returns only the anchor outside the budget view", () => {
    const data = makeTestData();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { view: "transactions" as View, initialMonth: "2026-06" }))
    );
    expect(result.current.visibleMonths).toEqual(["2026-06"]);
  });

  it("clamps visibleMonths at the max allowed month", () => {
    const data = makeTestData();
    const max = maxAllowedMonth();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: max }))
    );
    expect(result.current.visibleMonths.length).toBeGreaterThan(0);
    expect(result.current.visibleMonths[result.current.visibleMonths.length - 1]).toBe(max);
    expect(result.current.visibleMonths.every((m) => m <= max)).toBe(true);
  });

  it("shifts months and syncs the budget URL", () => {
    const data = makeTestData();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: "2026-06" }))
    );
    act(() => {
      result.current.shiftMonth(1);
    });
    expect(result.current.month).toBe("2026-07");
    expect(window.location.pathname).toBe("/budget/2026-07");

    act(() => {
      result.current.shiftMonth(-2);
    });
    expect(result.current.month).toBe("2026-05");
    expect(window.location.pathname).toBe("/budget/2026-05");
  });

  it("blocks forward shifts past the clamp without touching the URL", () => {
    const data = makeTestData();
    const max = maxAllowedMonth();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: max }))
    );
    expect(result.current.canShiftRight).toBe(false);
    act(() => {
      result.current.shiftMonth(1);
    });
    expect(result.current.month).toBe(max);
    expect(window.location.pathname).toBe("/");
  });

  it("enables forward shifts for older months", () => {
    const data = makeTestData();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: "2026-06" }))
    );
    expect(result.current.canShiftRight).toBe(true);
  });

  it("does not sync the URL outside the budget view", () => {
    const data = makeTestData();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { view: "transactions" as View, initialMonth: "2026-06" }))
    );
    act(() => {
      result.current.shiftMonth(1);
    });
    expect(result.current.month).toBe("2026-07");
    expect(window.location.pathname).toBe("/");
  });

  it("clamps set months beyond the max allowed month", () => {
    const data = makeTestData();
    const max = maxAllowedMonth();
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: "2026-06" }))
    );
    act(() => {
      result.current.handleSetMonth("2999-01");
    });
    expect(result.current.month).toBe(max);
    expect(window.location.pathname).toBe(`/budget/${max}`);
  });

  it("resets future months to today when widening past one month", () => {
    const data = makeTestData();
    const today = todayISO().slice(0, 7);
    const { result } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { initialMonth: "2030-01" }))
    );
    expect(result.current.month).toBe("2030-01");
    act(() => {
      result.current.handleSetMonthCount(3);
    });
    expect(result.current.monthCount).toBe(3);
    expect(result.current.month).toBe(today);
  });

  it("persists monthCount and restores it on a fresh mount", () => {
    const data = makeTestData();
    const first = renderHook(() => useBudgetMonthNav(navArgs(data)));
    act(() => {
      first.result.current.handleSetMonthCount(6);
    });
    expect(localStorage.getItem(MONTH_COUNT_KEY)).toBe("6");

    const second = renderHook(() => useBudgetMonthNav(navArgs(data)));
    expect(second.result.current.monthCount).toBe(6);
  });

  it("scans year bounds from transactions, assignments, and recurring", () => {
    const data = makeTestData();
    // Push the recurring date past the thisYear+5 future cap so the scan,
    // not the cap, determines maxYear.
    const farYear = Number(todayISO().slice(0, 4)) + 10;
    data.recurring = data.recurring.map((r) => ({ ...r, nextDate: `${farYear}-05-01` }));
    const { result } = renderHook(() => useBudgetMonthNav(navArgs(data)));
    expect(result.current.minYear).toBe(2019);
    expect(result.current.maxYear).toBe(farYear);
  });

  it("defaults year bounds to this year through +5 with no dated rows", () => {
    const data = makeTestData();
    data.transactions = [];
    data.assignments = [];
    data.recurring = [];
    const { result } = renderHook(() => useBudgetMonthNav(navArgs(data)));
    const thisYear = Number(todayISO().slice(0, 4));
    expect(result.current.minYear).toBe(thisYear);
    expect(result.current.maxYear).toBe(thisYear + 5);
  });

  it("parses the mount path into view, account, and month state", () => {
    const data = makeTestData();
    window.history.replaceState(null, "", "/transactions/5");
    const setView = vi.fn();
    const setAccountFilter = vi.fn();
    const { result: txResult } = renderHook(() =>
      useBudgetMonthNav(navArgs(data, { setView, setAccountFilter }))
    );
    expect(setView).toHaveBeenCalledWith("transactions");
    expect(setAccountFilter).toHaveBeenCalledWith(5);
    // No month segment: the anchor month is left alone.
    expect(txResult.current.month).toBe(todayISO().slice(0, 7));

    window.history.replaceState(null, "", "/budget/2026-03");
    const setView2 = vi.fn();
    const setAccountFilter2 = vi.fn();
    const { result } = renderHook(() =>
      useBudgetMonthNav(
        navArgs(data, { setView: setView2, setAccountFilter: setAccountFilter2 })
      )
    );
    expect(setView2).toHaveBeenCalledWith("budget");
    // The month setter flows into URL sync: the parsed month reaches state.
    expect(result.current.month).toBe("2026-03");
    expect(setAccountFilter2).not.toHaveBeenCalled();
  });
});
