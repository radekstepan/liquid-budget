import { describe, expect, it } from "vitest";
import {
  computeCashFlowRange,
  computeMonthlyInsights,
  computeSpendingTrends,
  getSpendingTransactions,
} from "../src/reports.js";
import {
  accumulateSpendingByMonth,
  buildSpendingConstituents,
  buildSpendingMonthPoints,
  buildSpendingScanContext,
  buildTrendInsights,
  collectInsightSpend,
  countAvailableBaselineMonths,
  finalizeSpendingConstituents,
  isReportSpendingRow,
  matchesSpendingTransaction,
  resolveSpendingDrill,
  spendingNetOutflow,
} from "../src/report-spending.js";
import { MIN_INSIGHT_PCT_CHANGE, insightAbsDiff } from "../src/reports.js";
import { fmt } from "../src/format.js";
import { isInternalTransfer, rowNetOnBudgetDelta } from "../src/transfers.js";
import type { BudgetData, Transaction } from "../src/types.js";

function makeData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget", balance: "100000", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Budget", balance: "50000", onBudget: true, sort: 1 },
      { id: 3, name: "Brokerage", kind: "offbudget", groupLabel: "Tracking", balance: "1000000", onBudget: false, sort: 2 },
    ],
    groups: [
      { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
      { id: 2, name: "Credit Card Payments", sort: 1, isCreditCardPayments: true },
    ],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 11, groupId: 1, name: "Dining", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 12, groupId: 2, name: "CC Payment", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      // Steady groceries baseline Jan-Mar, spike in Apr (trend signal).
      { id: 1, accountId: 1, categoryId: 10, date: "2026-01-05", payee: "Store", memo: "", amount: "-5000", status: "c" },
      { id: 2, accountId: 1, categoryId: 10, date: "2026-02-05", payee: "Store", memo: "", amount: "-5000", status: "c" },
      { id: 3, accountId: 1, categoryId: 10, date: "2026-03-05", payee: "Store", memo: "", amount: "-5000", status: "c" },
      { id: 4, accountId: 1, categoryId: 10, date: "2026-04-05", payee: "Store", memo: "", amount: "-20000", status: "c" },
      // Dining only in Apr (no baseline -> no trend row).
      { id: 5, accountId: 1, categoryId: 11, date: "2026-04-06", payee: "Bistro", memo: "", amount: "-3000", status: "c" },
      // CC-payment plumbing: never spending.
      { id: 6, accountId: 1, categoryId: 12, date: "2026-04-07", payee: "Transfer : Card", memo: "", amount: "-7000", status: "c" },
      // Internal transfer (on-budget -> on-budget): invisible to cash flow.
      { id: 7, accountId: 1, categoryId: null, date: "2026-04-08", payee: "Transfer : Savings", memo: "", amount: "-10000", status: "c", transferAccountId: 2 },
      // Boundary outflow (on-budget -> off-budget, uncategorized): cash outflow, not category spending.
      { id: 8, accountId: 1, categoryId: null, date: "2026-04-09", payee: "Transfer : Brokerage", memo: "", amount: "-20000", status: "c", transferAccountId: 3 },
      // Income.
      { id: 9, accountId: 1, categoryId: null, date: "2026-04-01", payee: "Employer", memo: "", amount: "300000", status: "c", isIncome: true },
    ],
    recurring: [],
  };
}

describe("rowNetOnBudgetDelta", () => {
  it("scores plain rows by their on-budget leg", () => {
    const on: Transaction = { id: 1, accountId: 1, categoryId: 10, date: "2026-04-05", payee: "S", memo: "", amount: "-5000", status: "c" };
    const off: Transaction = { id: 2, accountId: 3, categoryId: null, date: "2026-04-05", payee: "F", memo: "", amount: "-5000", status: "c" };
    const map = new Map(makeData().accounts.map((a) => [a.id, a]));
    expect(rowNetOnBudgetDelta(on, map)).toBe(-5000);
    expect(rowNetOnBudgetDelta(off, map)).toBe(0);
  });

  it("matches transferNetOnBudgetDelta for transfer rows", () => {
    const data = makeData();
    const map = new Map(data.accounts.map((a) => [a.id, a]));
    const internal = data.transactions.find((t) => t.id === 7)!;
    const outflow = data.transactions.find((t) => t.id === 8)!;
    expect(rowNetOnBudgetDelta(internal, map)).toBe(0);
    expect(rowNetOnBudgetDelta(outflow, map)).toBe(-20000);
    // Missing accounts default to on-budget on both legs.
    expect(rowNetOnBudgetDelta(internal)).toBe(0);
  });
});

describe("shared boundary math in cash flow", () => {
  it("excludes internal transfers but counts boundary outflows", () => {
    const flow = computeCashFlowRange(makeData(), "2026-04", "2026-04");
    expect(flow.income).toBe(300000);
    // Groceries 20000 + dining 3000 + CC plumbing 7000 + boundary outflow 20000.
    // Internal 10000 move is money movement, not spending.
    expect(flow.outflow).toBe(20000 + 3000 + 7000 + 20000);
  });

  it("agrees with transfers.isInternalTransfer on the fixture", () => {
    const data = makeData();
    const map = new Map(data.accounts.map((a) => [a.id, a]));
    expect(isInternalTransfer(data.transactions.find((t) => t.id === 7)!, map)).toBe(true);
    expect(isInternalTransfer(data.transactions.find((t) => t.id === 8)!, map)).toBe(false);
  });
});

describe("insights sub-aggregators", () => {
  it("collectInsightSpend skips CC plumbing and internal transfers", () => {
    const data = makeData();
    const ctx = buildSpendingScanContext(data);
    const maps = collectInsightSpend(data, ctx, "2026-04", new Set(["2026-01", "2026-02", "2026-03"]), null);
    expect(maps.currentSpendByCat.get(10)).toBe(20000);
    expect(maps.currentSpendByCat.get(11)).toBe(3000);
    expect(maps.currentSpendByCat.has(12)).toBe(false);
    expect(maps.earliestMonth).toBe("2026-01");
    expect(countAvailableBaselineMonths(["2026-01", "2026-02", "2026-03"], maps.earliestMonth)).toBe(3);
  });

  it("buildTrendInsights flags the groceries spike, suppresses no-baseline dining", () => {
    const data = makeData();
    const ctx = buildSpendingScanContext(data);
    const maps = collectInsightSpend(data, ctx, "2026-04", new Set(["2026-01", "2026-02", "2026-03"]), null);
    const insights = buildTrendInsights(
      maps,
      3,
      new Map(data.categories.map((c) => [c.id, c.name])),
      null,
      MIN_INSIGHT_PCT_CHANGE,
      fmt
    );
    const groceries = insights.find((i) => i.categoryId === 10)!;
    expect(groceries.pctChange).toBe(300);
    expect(insights.some((i) => i.categoryId === 11)).toBe(false);
  });

  it("entry point matches manual orchestration (sort + fallback)", () => {
    const data = makeData();
    const viaEntry = computeMonthlyInsights(data, "2026-04");
    const ctx = buildSpendingScanContext(data);
    const prior = new Set(["2026-01", "2026-02", "2026-03"]);
    const maps = collectInsightSpend(data, ctx, "2026-04", prior, null);
    const manual = buildTrendInsights(
      maps,
      countAvailableBaselineMonths([...prior], maps.earliestMonth),
      new Map(data.categories.map((c) => [c.id, c.name])),
      null,
      MIN_INSIGHT_PCT_CHANGE,
      fmt
    ).sort((a, b) => insightAbsDiff(b) - insightAbsDiff(a));
    expect(viaEntry).toEqual(manual);
  });
});

describe("trends sub-aggregators", () => {
  it("resolveSpendingDrill covers all/group/category/unknown", () => {
    const data = makeData();
    expect(resolveSpendingDrill(data, {})).toMatchObject({ drillLevel: "all", currentGroupId: null });
    expect(resolveSpendingDrill(data, { drillGroupId: 1 })).toMatchObject({
      drillLevel: "group",
      currentGroupId: 1,
      currentGroupName: "Everyday",
    });
    expect(resolveSpendingDrill(data, { drillCategoryId: 10 })).toMatchObject({
      drillLevel: "category",
      currentCategoryId: 10,
      currentCategoryName: "Groceries",
      currentGroupId: 1,
    });
    expect(resolveSpendingDrill(data, { drillGroupId: 999 })).toMatchObject({
      drillLevel: "group",
      currentGroupName: "Master Category",
    });
    expect(resolveSpendingDrill(data, { drillCategoryId: 999 })).toMatchObject({
      drillLevel: "category",
      currentCategoryName: "Category",
      currentGroupId: null,
    });
  });

  it.each([{ drillGroupId: null, drillCategoryId: null }, { drillGroupId: 1 }, { drillCategoryId: 10 }])(
    "helpers reproduce computeSpendingTrends (%j)",
    (options) => {
      const data = makeData();
      const expected = computeSpendingTrends(data, "2026-01", "2026-04", options);
      const drill = resolveSpendingDrill(data, options);
      const ctx = buildSpendingScanContext(data);
      const spendByMonthCat = accumulateSpendingByMonth(
        data, ctx, ["2026-01", "2026-02", "2026-03", "2026-04"],
        "2026-01", "2026-04", drill, null
      );
      const constituentsMap = buildSpendingConstituents(data, drill, null);
      const { monthPoints, overallTotal, maxMonthSpend, minMonthSpend } =
        buildSpendingMonthPoints(["2026-01", "2026-02", "2026-03", "2026-04"], spendByMonthCat, constituentsMap, drill.drillLevel, ctx.catMap);
      const constituents = finalizeSpendingConstituents(constituentsMap, 4, overallTotal);
      expect({ months: monthPoints, constituents, total: overallTotal, maxMonthSpend, minMonthSpend }).toEqual({
        months: expected.months,
        constituents: expected.constituents,
        total: expected.total,
        maxMonthSpend: expected.maxMonthSpend,
        minMonthSpend: expected.minMonthSpend,
      });
    }
  );

  it("isReportSpendingRow encodes the shared predicate", () => {
    const data = makeData();
    const ctx = buildSpendingScanContext(data);
    const byId = new Map(data.transactions.map((t) => [t.id, t]));
    expect(isReportSpendingRow(byId.get(4)!, ctx)).toBe(true);
    // CC plumbing skipped only with the flag (top-level views).
    expect(isReportSpendingRow(byId.get(6)!, ctx)).toBe(true);
    expect(isReportSpendingRow(byId.get(6)!, ctx, { skipCCPayments: true })).toBe(false);
    // Income + internal-transfer-without-category rows are not spending rows.
    expect(isReportSpendingRow(byId.get(9)!, ctx)).toBe(false);
    expect(isReportSpendingRow(byId.get(7)!, ctx)).toBe(false);
    expect(spendingNetOutflow(byId.get(4)!)).toBe(20000);
  });
});

describe("matchesSpendingTransaction", () => {
  it("matches getSpendingTransactions across filters", () => {
    const data = makeData();
    const ctx = buildSpendingScanContext(data);
    const filters = [
      undefined,
      { month: "2026-04" },
      { groupId: 1 },
      { categoryId: 10 },
      { activeCategoryIds: new Set([11]) },
    ];
    for (const filter of filters) {
      const expected = getSpendingTransactions(data, "2026-01", "2026-04", filter);
      const actual = data.transactions
        .filter((t) => matchesSpendingTransaction(t, ctx, "2026-01", "2026-04", filter))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
      expect(actual.map((t) => t.id)).toEqual(expected.map((t) => t.id));
    }
  });
});
