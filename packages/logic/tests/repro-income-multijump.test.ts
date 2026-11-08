/**
 * REPRO ONLY — incomeMonth multi-month jump on split-parent income
 * (not yet fixed; do not promote).
 *
 * Diverges: plain (non-split) income Honors any N-month jump — forward +2,
 * +3, backward −3 and cross-year jumps were all verified to land in the
 * incomeMonth bucket with matching past/future bookkeeping (dropped, no
 * test). But split-PARENT rows are skipped wholesale by the raw indexer, so
 * a split parent carrying incomeMonth drops its income entirely: it lands
 * in NO bucket, and only the children's categorized outflows remain.
 *
 * YNAB4 has no N-month rule (only `__ImmediateIncome__` vs
 * `__DeferredIncome__`, `constants/CategoryConstants.as:36-38`); this pins
 * OUR superset contract (`.planning/codebase/INTEGRATIONS.md:55`, fork #6).
 * Ours: packages/logic/src/budget-engine.ts:608-610 (`splitParentIds`
 *   skip in `buildRawIndexData`) vs :661-687 (income attribution walk,
 *   never reached for the parent).
 */
import { describe, expect, it } from "vitest";
import { computeBudget } from "../src/budget-engine.js";
import type { BudgetData } from "../src/types.js";

function dataWithSplitParentIncome(date: string, incomeMonth: string): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 0 },
    ],
    groups: [{ id: 1, name: "Living", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      {
        id: 1,
        accountId: 1,
        categoryId: null,
        date,
        payee: "Split income",
        memo: "",
        amount: "600000",
        status: "c",
        isIncome: true,
        incomeMonth,
      },
      { id: 2, accountId: 1, parentId: 1, categoryId: 10, date, payee: "", memo: "", amount: "-400000", status: "c" },
      { id: 3, accountId: 1, parentId: 1, categoryId: 10, date, payee: "", memo: "", amount: "-200000", status: "c" },
    ],
    recurring: [],
  };
}

describe("superset rule: split-parent income N months out is not dropped", () => {
  it("split-parent income +2 months out lands in the incomeMonth bucket", () => {
    const mar = computeBudget(dataWithSplitParentIncome("2026-01-10", "2026-03"), "2026-03");
    // FAILS today: the split parent is skipped, so Mar income is 0 and only the outflow remains.
    expect(mar.totalIncome).toBe(600000);
    expect(mar.incomeFromPast).toBe(600000);
  });

  it("split-parent income +3 months out lands in the incomeMonth bucket", () => {
    const apr = computeBudget(dataWithSplitParentIncome("2026-01-10", "2026-04"), "2026-04");
    // FAILS today: the split parent is skipped, so Apr income is 0 and only the outflow remains.
    expect(apr.totalIncome).toBe(600000);
    expect(apr.incomeFromPast).toBe(600000);
  });
});
