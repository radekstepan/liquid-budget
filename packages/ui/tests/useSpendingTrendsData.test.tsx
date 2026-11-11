import { describe, expect, it, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, renderHook, act } from "@testing-library/react";
import type { BudgetData, Transaction } from "@ynab/logic";
import {
  useSpendingTrendsData,
  type SpendingTrendsDataArgs,
} from "../src/useSpendingTrendsData.js";

const FILTER_KEY = "ynab:reports:trendsActiveCategories";

beforeEach(() => {
  localStorage.clear();
});

function txn(
  month: string,
  day: number,
  payee: string,
  amount: number,
  categoryId: number | null = null
): Transaction {
  return {
    id: Math.abs(amount) * 100 + day,
    accountId: 1,
    categoryId,
    date: `${month}-${String(day).padStart(2, "0")}`,
    payee,
    memo: "",
    amount: String(amount * 100),
    status: "u",
  };
}

function makeTestData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 0 },
    ],
    groups: [
      { id: 1, name: "Everyday Expenses", sort: 0, isCreditCardPayments: false },
      { id: 2, name: "Monthly Bills", sort: 1, isCreditCardPayments: false },
      { id: 3, name: "CC Payments", sort: 2, isCreditCardPayments: true },
    ],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 11, groupId: 1, name: "Fuel", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 20, groupId: 2, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 21, groupId: 2, name: "Utilities", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      txn("2026-04", 5, "Whole Foods", -200, 10),
      txn("2026-04", 10, "Shell", -50, 11),
      txn("2026-04", 1, "Landlord", -1200, 20),
      txn("2026-05", 3, "Trader Joes", -250, 10),
      txn("2026-05", 12, "Electric Co", -100, 21),
      txn("2026-05", 1, "Landlord", -1200, 20),
      txn("2026-06", 8, "Safeway", -180, 10),
      txn("2026-06", 15, "Chevron", -60, 11),
      txn("2026-06", 1, "Landlord", -1200, 20),
    ],
    recurring: [],
  };
}

// NOTE: data must be created once per test and closed over — building it
// inside the render callback gives a fresh identity every render, which
// legitimately re-fires the hook's data effects forever.
function args(data: BudgetData, overrides: Partial<SpendingTrendsDataArgs> = {}): SpendingTrendsDataArgs {
  return {
    data,
    startMonth: "2026-04",
    endMonth: "2026-06",
    ...overrides,
  };
}

describe("useSpendingTrendsData (ui-split slice 10)", () => {
  it("starts undrilled with all non-CC categories active", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useSpendingTrendsData(args(data)));
    expect(result.current.drillGroupId).toBeNull();
    expect(result.current.drillCategoryId).toBeNull();
    expect(result.current.selectedMonth).toBeNull();
    expect(result.current.trends.drillLevel).toBe("all");
    expect([...result.current.activeCategoryIds].sort()).toEqual([10, 11, 20, 21]);
    expect(result.current.filterButtonLabel).toBe("Categories: All");
    expect(result.current.transactions).toEqual([]);
    expect(result.current.colorMap.size).toBe(result.current.trends.constituents.length);
    expect(result.current.accountMap.get(1)).toBe("Checking");
  });

  it("drills all -> group -> category with derived names and transactions", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useSpendingTrendsData(args(data)));
    act(() => {
      result.current.handleDrillSegment(1);
    });
    expect(result.current.drillGroupId).toBe(1);
    expect(result.current.trends.drillLevel).toBe("group");
    expect(result.current.trends.currentGroupName).toBe("Everyday Expenses");
    expect(result.current.currentGroupCats.map((c) => c.id)).toEqual([10, 11]);

    act(() => {
      result.current.handleDrillSegment(10);
    });
    expect(result.current.drillCategoryId).toBe(10);
    expect(result.current.trends.drillLevel).toBe("category");
    expect(result.current.trends.currentCategoryName).toBe("Groceries");
    expect(result.current.transactions.length).toBeGreaterThan(0);
    expect(
      result.current.transactions.every((t) => t.categoryId === 10)
    ).toBe(true);
  });

  it("navigates back up and clears hover selections", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useSpendingTrendsData(args(data)));
    act(() => {
      result.current.handleDrillSegment(1);
    });
    act(() => {
      result.current.handleDrillSegment(10);
    });
    act(() => {
      result.current.handleToggleMonth("2026-05");
    });
    act(() => {
      result.current.setHover({ monthIdx: 1, x: 5, y: 5 });
      result.current.setHoveredConstituentId(10);
    });

    act(() => {
      result.current.handleGoToGroup();
    });
    expect(result.current.drillGroupId).toBe(1);
    expect(result.current.drillCategoryId).toBeNull();
    expect(result.current.selectedMonth).toBeNull();
    expect(result.current.trends.drillLevel).toBe("group");
    expect(result.current.hover).toBeNull();
    expect(result.current.hoveredConstituentId).toBeNull();

    act(() => {
      result.current.handleGoToAll();
    });
    expect(result.current.drillGroupId).toBeNull();
    expect(result.current.trends.drillLevel).toBe("all");
  });

  it("toggles and clears the month filter, listing month transactions", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useSpendingTrendsData(args(data)));
    act(() => {
      result.current.handleToggleMonth("2026-05");
    });
    expect(result.current.selectedMonth).toBe("2026-05");
    expect(result.current.transactions.length).toBe(3);
    expect(
      result.current.transactions.every((t) => t.date.startsWith("2026-05"))
    ).toBe(true);

    act(() => {
      result.current.handleToggleMonth("2026-05");
    });
    expect(result.current.selectedMonth).toBeNull();

    act(() => {
      result.current.handleToggleMonth("2026-05");
    });
    act(() => {
      result.current.handleClearMonth();
    });
    expect(result.current.selectedMonth).toBeNull();
    expect(result.current.transactions).toEqual([]);
  });

  it("toggles single categories and labels partial selection", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useSpendingTrendsData(args(data)));
    act(() => {
      result.current.handleToggleCategory(10);
    });
    expect(result.current.activeCategoryIds.has(10)).toBe(false);
    expect(result.current.filterButtonLabel).toBe("Categories: 3/4");

    act(() => {
      result.current.handleToggleCategory(10);
    });
    expect(result.current.filterButtonLabel).toBe("Categories: All");
  });

  it("toggles whole groups of categories", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useSpendingTrendsData(args(data)));
    act(() => {
      result.current.handleToggleGroup(1);
    });
    expect(result.current.activeCategoryIds.has(10)).toBe(false);
    expect(result.current.activeCategoryIds.has(11)).toBe(false);
    expect(result.current.activeCategoryIds.has(20)).toBe(true);

    act(() => {
      result.current.handleToggleGroup(1);
    });
    expect([...result.current.activeCategoryIds].sort()).toEqual([10, 11, 20, 21]);
  });

  it("selects and deselects all categories", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useSpendingTrendsData(args(data)));
    act(() => {
      result.current.handleDeselectAllCategories();
    });
    expect(result.current.activeCategoryIds.size).toBe(0);
    expect(result.current.filterButtonLabel).toBe("Categories: 0/4");

    act(() => {
      result.current.handleSelectAllCategories();
    });
    expect(result.current.filterButtonLabel).toBe("Categories: All");
  });

  it("manages current-group cats with a group-scoped label", () => {
    const data = makeTestData();
    const { result } = renderHook(() => useSpendingTrendsData(args(data)));
    act(() => {
      result.current.handleDrillSegment(1);
    });
    act(() => {
      result.current.handleClearCurrentGroupCats();
    });
    expect(result.current.activeCategoryIds.has(10)).toBe(false);
    expect(result.current.activeCategoryIds.has(11)).toBe(false);
    expect(result.current.activeCategoryIds.has(20)).toBe(true);
    expect(result.current.filterButtonLabel).toBe("Categories: 0/2");

    act(() => {
      result.current.handleToggleCategory(10);
    });
    expect(result.current.filterButtonLabel).toBe("Categories: 1/2");

    act(() => {
      result.current.handleSelectCurrentGroupCats();
    });
    expect(result.current.filterButtonLabel).toBe("Categories: All");
  });

  it("persists the filter and applies it on a fresh mount", () => {
    const data = makeTestData();
    const first = renderHook(() => useSpendingTrendsData(args(data)));
    act(() => {
      first.result.current.handleToggleCategory(10);
    });
    expect(JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null")?.sort()).toEqual([11, 20, 21]);

    const second = renderHook(() => useSpendingTrendsData(args(data)));
    expect([...second.result.current.activeCategoryIds].sort()).toEqual([11, 20, 21]);
    expect(second.result.current.filterButtonLabel).toBe("Categories: 3/4");
  });

  it("resets drill state when resetKey changes", () => {
    const data = makeTestData();
    const { result, rerender } = renderHook(
      ({ resetKey }: { resetKey: number }) => useSpendingTrendsData(args(data, { resetKey })),
      { initialProps: { resetKey: 0 } }
    );
    act(() => {
      result.current.handleDrillSegment(1);
    });
    act(() => {
      result.current.handleToggleMonth("2026-05");
    });
    expect(result.current.drillGroupId).toBe(1);

    rerender({ resetKey: 1 });

    expect(result.current.drillGroupId).toBeNull();
    expect(result.current.drillCategoryId).toBeNull();
    expect(result.current.selectedMonth).toBeNull();
    expect(result.current.trends.drillLevel).toBe("all");
  });

  it("closes the filter popover on outside mousedown only", () => {
    function Harness() {
      const [data] = useState(makeTestData);
      const trends = useSpendingTrendsData(args(data));
      return (
        <div>
          <div ref={trends.filterRef} data-testid="filterbox">
            <button type="button" onClick={() => trends.setFilterOpen(true)}>
              open
            </button>
          </div>
          <span data-testid="open-flag">{String(trends.filterOpen)}</span>
        </div>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByTestId("open-flag").textContent).toBe("true");

    fireEvent.mouseDown(screen.getByTestId("filterbox"));
    expect(screen.getByTestId("open-flag").textContent).toBe("true");

    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId("open-flag").textContent).toBe("false");
  });
});
