/**
 * reports-gaps.test.ts
 *
 * Focused coverage for report branches: transfers from unknown accounts,
 * pre-range months in net worth, the no-income savings rate, and the
 * active-category spending filter.
 */
import { describe, expect, it } from "vitest";
import {
  computeCashFlowRange,
  computeNetWorthReport,
  getSpendingTransactions,
} from "../src/reports.js";
import type { BudgetData } from "../src/types.js";

function data(over: Partial<BudgetData> = {}): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "10000", onBudget: true, sort: 0 },
    ],
    groups: [{ id: 1, name: "Living", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [],
    recurring: [],
    ...over,
  };
}

describe("computeNetWorthReport gaps", () => {
  it("applies a transfer leg into a known account even when the source is unknown", () => {
    const d = data({
      transactions: [
        {
          id: 1, accountId: 999, transferAccountId: 1, categoryId: null,
          date: "2026-06-05", payee: "Transfer : Checking", memo: "",
          amount: "-5000", status: "c",
        },
      ],
    });
    const points = computeNetWorthReport(d, "2026-06", "2026-06");
    expect(points).toHaveLength(1);
    // Destination receives -amount: 10000 current, so June nets to 10000.
    expect(points[0]).toMatchObject({ month: "2026-06", net: 10000 });
  });

  it("advances running balances through months before the requested range", () => {
    const d = data({
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "8000", onBudget: true, sort: 0 },
      ],
      transactions: [
        {
          id: 1, accountId: 1, categoryId: 10,
          date: "2026-04-10", payee: "Store", memo: "",
          amount: "-2000", status: "c",
        },
      ],
    });
    const points = computeNetWorthReport(d, "2026-06", "2026-07");
    expect(points.map((p) => p.month)).toEqual(["2026-06", "2026-07"]);
    // Base 10000 - April 2000 spend = 8000 carried into the range.
    expect(points[0]!.net).toBe(8000);
    expect(points[1]!.net).toBe(8000);
  });
});

describe("computeCashFlowRange gaps", () => {
  it("reports a 100% savings rate when refunds arrive with no income", () => {
    const d = data({
      transactions: [
        {
          id: 1, accountId: 1, categoryId: 10,
          date: "2026-06-10", payee: "Store refund", memo: "",
          amount: "5000", status: "c",
        },
      ],
    });
    expect(computeCashFlowRange(d, "2026-06", "2026-06")).toEqual({
      income: 0,
      outflow: -5000,
      net: 5000,
      savingsRate: 100,
    });
  });
});

describe("getSpendingTransactions gaps", () => {
  const spending = data({
    transactions: [
      {
        id: 1, accountId: 1, categoryId: 10,
        date: "2026-06-10", payee: "Store", memo: "",
        amount: "-2000", status: "c",
      },
    ],
  });

  it("excludes categories outside the active set", () => {
    expect(
      getSpendingTransactions(spending, "2026-06", "2026-06", { activeCategoryIds: new Set([999]) })
    ).toEqual([]);
    expect(
      getSpendingTransactions(spending, "2026-06", "2026-06", { activeCategoryIds: new Set([10]) })
    ).toHaveLength(1);
  });
});
