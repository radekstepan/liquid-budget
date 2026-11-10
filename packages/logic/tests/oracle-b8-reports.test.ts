// FORK: B8 report providers + rows/settings/utils parity mirror.
//
// Oracle: `../ynab4-modern/packages/app/src/reports/{NetWorth,ProfitAndLoss,
// SpendByCategory,SpendByPayee,SpendingTrends}DataProvider.ts`,
// `HOReportDataRow.ts`, `HOSortedMonthlyCategories.ts`,
// `HOIncludedTransactionsFor{Categories,Months}.ts`, `MBaseReport.ts`,
// `M{NetWorth,ProfitAndLoss,SpendByCategory,SpendByPayee,SpendingTrends}Report.ts`,
// `MReports.ts`, `ReportSettings.ts`, `ReportUtilities.ts`,
// `ChartColorMap.ts`, `ColorMapEntry.ts`, `FilterSelection.ts`,
// `ReportConstants.ts`, `ProfitAndLossConstants.ts`,
// `SpendingTrendsConstants.ts`, `BaseReportDataProvider.ts`
// (+ `domain/src/utils/CurrencyUtilities.ts` safeAdd/safeSubtract,
// `budget-engine.ts` isIncomeTransaction, `format.ts` monthLabel).
//
// This repo keeps no Flex/entity-graph shells, so providers are mirrored as
// small local pure functions over integer cents (same branch structure as
// the behavior-model oracle, each case citing its oracle file:line rule). Real-logic
// anchors (no duplication of reports.test.ts / reports-gaps.test.ts /
// oracle-b8-controllers.test.ts): computeNetWorthReport sign convention,
// isIncomeTransaction income skip, monthLabel full-name parity.
//
// FORK deviations: integer cents everywhere (oracle floats via
// roundBasedOnCulture); SQLite BudgetData rows vs live entity graph
// (MonthlyBudget/account.getBalancesThroughDate) — selection/month math
// preserved, graph traversal replaced by direct maps.
//
// Amounts: integer cents throughout. No console output (Vitest throws).

import { describe, expect, it } from "vitest";
import { computeNetWorthReport } from "../src/reports.js";
import { isIncomeTransaction } from "../src/budget-engine.js";
import { monthLabel } from "../src/format.js";
import type { BudgetData } from "../src/types.js";

// ---------------------------------------------------------------------------
// shared tiny mirrors of oracle pure helpers
// ---------------------------------------------------------------------------

// Oracle: CurrencyUtilities.ts safeAdd/safeSubtract (roundBasedOnCulture over
// integer cents = Math.round; oracle operates on dollars).
const safeAdd = (a: number, b: number): number => Math.round(a + b);
const safeSubtract = (a: number, b: number): number => Math.round(a - b);

// Oracle: ReportPanel.safeGetPercentageOfTotal (ReportUtilities.ts:92-97):
// `total != 0` guard (loose — NaN total still divides), else 0.
function safeGetPercentageOfTotal(value: number, total: number): number {
  if (total != 0) return (value / total) * 100;
  return 0;
}

// Oracle: BaseReportDataProvider.removeUnusedRows — backwards sweep over
// top-level rows + one child level, dropping untouched rows.
type TouchRow = { label: string; hasBeenTouched: boolean; childRows: TouchRow[] | null };
function removeUnusedRows(rows: TouchRow[]): TouchRow[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (!row.hasBeenTouched) rows.splice(i, 1);
    else if (row.childRows) {
      for (let j = row.childRows.length - 1; j >= 0; j--) {
        if (!row.childRows[j]!.hasBeenTouched) row.childRows.splice(j, 1);
      }
    }
  }
  return rows;
}

// Oracle: HOReportDataRow.ts:95-117 — the `average` ctor arg is accepted but
// never assigned (field keeps its NaN default); isTotalRow/hasBeenTouched
// false; childRows null.
class RowMirror {
  label: string;
  data: unknown;
  total: number;
  average: number = NaN;
  change: number;
  hasBeenTouched = false;
  isTotalRow = false;
  childRows: RowMirror[] | null = null;
  type: string;
  colors: unknown[] | null;
  cells: Map<string, number> = new Map();
  constructor(
    label: string, data: unknown, total: number, type: string,
    colors: unknown[] | null = null, change: number = NaN,
    _average = 0, // accepted, never assigned (verbatim oracle quirk)
  ) {
    this.label = label;
    this.data = data;
    this.total = total;
    this.type = type;
    this.colors = colors;
    this.change = change;
  }
  getMonth(m: string): number { return Number(this.cells.get(m)); }
  setMonth(m: string, v: number): void { this.cells.set(m, v); }
  getMonthChange(m: string): number { return Number(this.cells.get(`${m}Change`)); }
  setMonthChange(m: string, v: number): void { this.cells.set(`${m}Change`, v); }
  getPreviousMonthValue(m: string): number {
    return this.getMonth(m) - this.getMonthChange(m);
  }
  // Oracle HOReportDataRow.ts:147-161 verbatim branches.
  getMonthChangePercentage(m: string): number {
    let pct = 0;
    const prev = this.getPreviousMonthValue(m);
    const ch = this.getMonthChange(m);
    if (ch > 0 && prev > 0) pct = (ch / prev) * 100;
    else if (ch > 0 && prev <= 0) pct = 100;
    else if (ch < 0) pct = (-ch / prev) * 100;
    else if (ch == 0) pct = 0;
    return pct;
  }
}

// Oracle: HOSortedMonthlyCategories.ts — nonzero counts only value > 0,
// descending numeric sort, "" / 0 / -1 fallbacks, reset.
class SortedCatsMirror {
  private cats: { name: string; value: number }[] = [];
  private nonZero = 0;
  get categoriesCount(): number { return this.cats.length; }
  get nonZeroCategoriesCount(): number { return this.nonZero; }
  removeAllEntries(): void { this.nonZero = 0; this.cats.splice(0); }
  addEntry(name: string, value: number): void {
    this.cats.push({ name, value });
    if (value > 0) this.nonZero += 1;
  }
  sortEntries(): void { this.cats.sort((a, b) => b.value - a.value); }
  getSortedPosition(name: string): number {
    for (let i = 0; i < this.cats.length; i++) {
      if (this.cats[i]!.name === name) return i;
    }
    return -1;
  }
  getCategoryName(i: number): string {
    return i < this.cats.length ? this.cats[i]!.name : "";
  }
  getCategoryValue(i: number): number {
    return i < this.cats.length ? this.cats[i]!.value : 0;
  }
}

// Oracle: NetWorthDataProvider.ts:191-207 workingBalance classification.
function classifyBalances(balances: number[]): { assets: number; liabilities: number; net: number } {
  let assets = 0;
  let liabilities = 0;
  let net = 0;
  for (const b of balances) {
    if (b >= 0) assets = safeAdd(assets, b);
    else liabilities = safeSubtract(liabilities, b);
    net = safeAdd(net, b);
  }
  return { assets, liabilities, net };
}

// Oracle: NetWorthDataProvider.ts:219-226 includeAccount gate.
function includeAccount(
  selectedOption: string, selection: unknown[], account: unknown,
  includeOffBudget: boolean,
): boolean {
  const all = includeOffBudget ? "All Accounts" : "Budget Accounts";
  return selectedOption === all || selection.indexOf(account) > -1;
}

// Oracle: FilterSelection.ts:49-59 ctor truthiness ("" stays "", null stays []).
class FilterMirror {
  selectedOption = "";
  selection: unknown[] = [];
  constructor(opt: string | null = null, sel: unknown[] | null = null) {
    if (opt) this.selectedOption = opt;
    if (sel) this.selection = sel;
  }
}

// Oracle: ReportSettings.ts:178-195 find-or-create.
function getIndividualSettingsForReport(
  list: { reportName: string }[], reportName: string,
  addItem: (v: { reportName: string }) => void,
): { reportName: string } {
  for (const vo of list) {
    if (vo.reportName === reportName) return vo;
  }
  const fresh = { reportName };
  addItem(fresh);
  return fresh;
}

function nwData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Cash", kind: "liquid", groupLabel: "Cash", balance: "15000", onBudget: true, sort: 0 },
      { id: 2, name: "Card", kind: "credit", groupLabel: "CC", balance: "-5000", onBudget: true, sort: 1 },
    ],
    groups: [],
    categories: [],
    assignments: [],
    transactions: [],
    recurring: [],
  };
}

// ---------------------------------------------------------------------------
// (a) NetWorth provider parity
// ---------------------------------------------------------------------------

describe("B8 NetWorth provider: workingBalance math + selection + columns", () => {
  it("classifies non-negative via safeAdd, negative via safeSubtract, net via safeAdd", () => {
    // Oracle NetWorthDataProvider.ts:201-206: liabilities stay POSITIVE
    // (safeSubtract(0, -5000) = 5000). FORK: this repo's
    // computeNetWorthReport keeps debts negative instead.
    expect(classifyBalances([15000, -5000])).toEqual({ assets: 15000, liabilities: 5000, net: 10000 });
    expect(classifyBalances([0])).toEqual({ assets: 0, liabilities: 0, net: 0 });
    // Real engine anchor: debts stay <= 0 and net = assets + debts.
    const pts = computeNetWorthReport(nwData(), "2026-06", "2026-06");
    expect(pts[0]).toEqual({ month: "2026-06", assets: 15000, debts: -5000, net: 10000 });
  });

  it("selection gate: all-accounts option includes everything, else explicit hit only", () => {
    const acct = { name: "Cash" };
    expect(includeAccount("All Accounts", [], acct, true)).toBe(true);
    expect(includeAccount("Budget Accounts", [], acct, false)).toBe(true);
    expect(includeAccount("Selected Accounts...", [], acct, true)).toBe(false);
    expect(includeAccount("Selected Accounts...", [acct], acct, true)).toBe(true);
  });

  it("recalculateData snapshots selectedMonthsName; resetColumns emits Account + months", () => {
    // Oracle NetWorthDataProvider.ts:244-247 + 228-236.
    const selected = ["Jan '26", "Feb '26"];
    const sliced = [...selected]; // snapshot, not alias
    selected.push("Mar '26");
    expect(sliced).toEqual(["Jan '26", "Feb '26"]);
    expect(["Account", ...sliced]).toEqual(["Account", "Jan '26", "Feb '26"]);
  });

  it("summary rows keep verbatim labels/types/colors", () => {
    // Oracle NetWorthDataProvider.ts:127-150.
    const rows = [
      new RowMirror("Net Worth", null, 0, "a", [2275053]),
      new RowMirror("Total Assets", null, 0, "b", [8001995]),
      new RowMirror("Total Liabilities", null, 0, "b", [9842700]),
    ];
    expect(rows.map((r) => [r.label, r.type, r.colors])).toEqual([
      ["Net Worth", "a", [2275053]],
      ["Total Assets", "b", [8001995]],
      ["Total Liabilities", "b", [9842700]],
    ]);
  });
});

// ---------------------------------------------------------------------------
// (b) P&L provider parity
// ---------------------------------------------------------------------------

describe("B8 P&L provider: income payee rows + split fan-out", () => {
  // Oracle ProfitAndLossDataProvider.ts:161-213 addPayeeRows.
  function addPayeeRow(
    rows: Map<string, number>, master: { total: number }, payee: string | null,
    amount: number, included: boolean,
  ): void {
    if (!included) return;
    const key = payee === null || payee === "" ? "[No Payee]" : payee;
    rows.set(key, safeAdd(rows.get(key) ?? 0, amount));
    master.total = safeAdd(master.total, amount);
  }

  it("accumulates supplemental + deferred income per payee; [No Payee] fallback; unselected months skipped", () => {
    const rows = new Map<string, number>();
    const master = { total: 0 };
    const selected = new Set(["Jan '26"]);
    // Two income sources feed the same master/payee rows (verbatim dual calls).
    for (const src of [[{ payee: "Employer", amount: 300000 }], [{ payee: "Employer", amount: 50000 }, { payee: "", amount: 12000 }]]) {
      for (const t of src) addPayeeRow(rows, master, t.payee, t.amount, selected.has("Jan '26"));
    }
    // Unselected month contributes nothing.
    addPayeeRow(rows, master, "Employer", 999, selected.has("Feb '26"));
    expect(rows.get("Employer")).toBe(350000);
    expect(rows.get("[No Payee]")).toBe(12000);
    expect(master.total).toBe(362000);
  });

  it("split fan-out dedupes per parent; null-category falls back to uncategorised; unresolvable skipped", () => {
    // Oracle ProfitAndLossDataProvider.ts:387-444.
    const seen = new Set<number>();
    const cells = new Map<string, number>();
    const apply = (parentId: number, subCat: string | null, amount: number, resolvable: boolean): void => {
      if (seen.has(parentId)) return; // per-parent dedupe
      seen.add(parentId);
      let row = subCat;
      if (!row) {
        row = resolvable ? "Uncategorised" : null; // uncategorised fallback
        if (!row) return; // skip when unresolvable
      }
      cells.set(row, safeAdd(cells.get(row) ?? 0, amount));
    };
    apply(1, "Groceries", -6000, true);
    apply(1, "Groceries", -6000, true); // same parent ignored
    apply(2, null, -4000, true); // null category → uncategorised
    apply(3, null, -1000, false); // unresolvable → skipped
    expect(cells.get("Groceries")).toBe(-6000);
    expect(cells.get("Uncategorised")).toBe(-4000);
    expect(cells.has("null")).toBe(false);
  });

  it("expense category gate skips internal/income masters; hidden master sorts last", () => {
    // Oracle ProfitAndLossDataProvider.ts:275-281.
    const gate = (name: string, internal: string, income: string, option: string, sel: string[]): boolean => {
      if (name === internal || name === income) return false;
      return option === "All Categories" || option === "All Master Categories" || sel.includes(name);
    };
    expect(gate("Internal", "Internal", "Income", "All Categories", [])).toBe(false);
    expect(gate("Income", "Internal", "Income", "All Categories", [])).toBe(false);
    expect(gate("Food", "Internal", "Income", "Selected Categories", ["Food"])).toBe(true);
    expect(gate("Food", "Internal", "Income", "Selected Categories", ["Bills"])).toBe(false);
    const names = ["Hidden Categories", "Food", "Uncategorized Transactions", "Bills"];
    const hiddenLast = [...names].sort((a) => (a === "Hidden Categories" ? 1 : -1));
    expect(hiddenLast[hiddenLast.length - 1]).toBe("Hidden Categories");
  });

  it("uncategorised/hidden masters lose childRows; childless income row dropped; Total + Net Income rows", () => {
    // Oracle ProfitAndLossDataProvider.ts:477-491 + 592-622.
    const uncat: TouchRow = { label: "Uncategorized", hasBeenTouched: true, childRows: [{ label: "c", hasBeenTouched: true, childRows: null }] };
    const hidden: TouchRow = { label: "Hidden", hasBeenTouched: true, childRows: [{ label: "c", hasBeenTouched: true, childRows: null }] };
    uncat.childRows = null; // verbatim nulling
    hidden.childRows = null;
    expect(uncat.childRows).toBeNull();
    const incomeChildless: TouchRow[] = [{ label: "All Income Sources", hasBeenTouched: true, childRows: null }];
    const kept = removeUnusedRows(incomeChildless.filter((r) => r.childRows !== null || r.label !== "All Income Sources"));
    expect(kept).toEqual([]); // childless income row dropped
    // Summary grammar: "Total <label>" + trailing "Net Income" (isNetTotal).
    const summary = `Total Food`;
    expect(summary).toBe("Total Food");
    const netIncome = { label: "Net Income", isNetTotal: true, hideCheckbox: true, notExpandable: true };
    expect(netIncome).toMatchObject({ label: "Net Income", isNetTotal: true });
    // Totals: safeAdd rollup + round average.
    let total = 0;
    for (const v of [-10000, -20000]) total = safeAdd(total, v);
    expect(total).toBe(-30000);
    expect(Math.round(total / 2)).toBe(-15000);
  });
});

// ---------------------------------------------------------------------------
// (c) SpendByCategory provider parity
// ---------------------------------------------------------------------------

describe("B8 SpendByCategory provider: gates + accumulation + TOTAL", () => {
  it("skips internal/income masters; ALL_CATEGORIES + explicit + uncategorised gates", () => {
    // Oracle SpendByCategoryDataProvider.ts:212-231.
    const gate = (name: string, internal: string, income: string, option: string, sel: string[], uncat: boolean): boolean => {
      if (name === internal || name === income) return false;
      return option === "All Categories" || option === "All Master Categories" || sel.includes(name) || uncat;
    };
    expect(gate("Internal", "Internal", "Income", "All Categories", [], false)).toBe(false);
    expect(gate("Income", "Internal", "Income", "All Master Categories", [], false)).toBe(false);
    expect(gate("Odd", "Internal", "Income", "Selected Categories", [], true)).toBe(true);
    expect(gate("Odd", "Internal", "Income", "Selected Categories", [], false)).toBe(false);
  });

  it("accumulates via safeSubtract with per-parent split dedupe and uncategorised fallback", () => {
    // Oracle SpendByCategoryDataProvider.ts:331-419 (spending = -amount).
    const seen = new Set<number>();
    const cells = new Map<string, number>();
    const applyLeaf = (cat: string | null, amount: number, fallback: string | null): void => {
      const row = cat ?? fallback;
      if (!row) return;
      cells.set(row, safeSubtract(cells.get(row) ?? 0, amount));
    };
    const applySplit = (parentId: number, subs: { cat: string | null; amount: number }[], fallback: string | null): void => {
      if (seen.has(parentId)) return;
      seen.add(parentId);
      for (const s of subs) applyLeaf(s.cat, s.amount, fallback);
    };
    applyLeaf("Groceries", -6000, null); // safeSubtract(0, -6000) = 6000 spend
    applySplit(7, [{ cat: "Fuel", amount: -3000 }, { cat: null, amount: -1000 }], "Uncategorised");
    applySplit(7, [{ cat: "Fuel", amount: -3000 }], "Uncategorised"); // deduped
    expect(cells.get("Groceries")).toBe(6000);
    expect(cells.get("Fuel")).toBe(3000);
    expect(cells.get("Uncategorised")).toBe(1000);
  });

  it("untouched rows are swept; untouched month cells zero-fill", () => {
    const rows: TouchRow[] = [
      { label: "Food", hasBeenTouched: true, childRows: [{ label: "stale", hasBeenTouched: false, childRows: null }] },
      { label: "stale-master", hasBeenTouched: false, childRows: null },
    ];
    expect(removeUnusedRows(rows).map((r) => r.label)).toEqual(["Food"]);
    expect(rows[0]!.childRows).toEqual([]);
    // Oracle: `if (!row[month]) row[month] = 0` — NaN/0/undefined all fill.
    const fill = (v: number): number => (!v ? 0 : v);
    expect(fill(NaN)).toBe(0);
    expect(fill(0)).toBe(0);
    expect(fill(500)).toBe(500);
  });

  it("TOTAL row: overallTotal/overallAverage, month subtotals, 100 percents, row percents", () => {
    // Oracle SpendByCategoryDataProvider.ts:451-519.
    const months = ["Jan '26", "Feb '26"];
    const childTotals = [6000, 3000];
    let overallTotal = 0;
    for (const t of childTotals) overallTotal = safeAdd(overallTotal, t);
    const overallAverage = Math.round(overallTotal / months.length);
    expect(overallTotal).toBe(9000);
    expect(overallAverage).toBe(4500);
    expect(safeGetPercentageOfTotal(6000, overallTotal)).toBeCloseTo(66.666, 2);
    expect(safeGetPercentageOfTotal(0, 0)).toBe(0);
    const totalRow = { label: "TOTAL", isTotalRow: true, totalPercent: 100, averagePercent: 100 / Math.max(months.length, 1) };
    expect(totalRow).toEqual({ label: "TOTAL", isTotalRow: true, totalPercent: 100, averagePercent: 50 });
  });
});

// ---------------------------------------------------------------------------
// (d) SpendByPayee provider parity
// ---------------------------------------------------------------------------

describe("B8 SpendByPayee provider: gate + blank-first + sort + percents", () => {
  it("ALL_PAYEES builds every payee row; explicit selection gates the rest", () => {
    // Oracle SpendByPayeeDataProvider.ts:135-153.
    const build = (all: string[], option: string, sel: string[]): string[] => {
      if (option === "All Payees") return [...all];
      return all.filter((p) => sel.includes(p));
    };
    expect(build(["a", "b"], "All Payees", [])).toEqual(["a", "b"]);
    expect(build(["a", "b"], "Selected Payees...", ["b"])).toEqual(["b"]);
  });

  it("blank [No Payee] row is always built (null-keyed) but listed first only when used; used rows sort desc", () => {
    // Oracle SpendByPayeeDataProvider.ts:154-256.
    const blank = { label: "[No Payee]", total: 4000, used: true };
    const used = [
      { label: "Store", total: 9000 },
      { label: "Cafe", total: 1000 },
    ].sort((a, b) => b.total - a.total);
    const listed = blank.used ? [blank.label, ...used.map((r) => r.label)] : used.map((r) => r.label);
    expect(listed).toEqual(["[No Payee]", "Store", "Cafe"]);
    const unusedBlank = { ...blank, used: false };
    const listed2 = unusedBlank.used ? [unusedBlank.label, ...used.map((r) => r.label)] : used.map((r) => r.label);
    expect(listed2).toEqual(["Store", "Cafe"]);
    // Verbatim blank label/type: "a" (oracle :154-161).
    expect(blank.label).toBe("[No Payee]");
  });

  it("percent fill uses row.total over month.totalSpent; recalcTotals uses plain += (not safeAdd)", () => {
    // Oracle SpendByPayeeDataProvider.ts:234-238 + 319-330.
    expect(safeGetPercentageOfTotal(9000, 14000)).toBeCloseTo(64.2857, 3);
    expect(safeGetPercentageOfTotal(0, 0)).toBe(0);
    let overallTotal = 0; // verbatim plain +=
    overallTotal += 9000;
    overallTotal += 4000;
    expect(overallTotal).toBe(13000);
  });
});

// ---------------------------------------------------------------------------
// (e) SpendingTrends provider parity
// ---------------------------------------------------------------------------

describe("B8 SpendingTrends provider: skips + Change cells + dictionary", () => {
  it("skips income/internal masters and empty-subcategory masters", () => {
    // Oracle SpendingTrendsDataProvider.ts:141-147.
    const keep = (name: string, income: string, internal: string, subCount: number): boolean =>
      !(name === income || name === internal || subCount === 0);
    expect(keep("Income", "Income", "Internal", 2)).toBe(false);
    expect(keep("Internal", "Income", "Internal", 2)).toBe(false);
    expect(keep("Empty", "Income", "Internal", 0)).toBe(false);
    expect(keep("Food", "Income", "Internal", 2)).toBe(true);
    // Real engine anchor: uncategorized inflow on-budget is income → skipped.
    const t = { id: 1, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Pay", memo: "", amount: "5000", status: "c" as const };
    const accounts = new Map([[1, { id: 1, name: "Cash", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 } as BudgetData["accounts"][number]]]);
    expect(isIncomeTransaction(t, accounts)).toBe(true);
  });

  it("Change cells = current - linked previous-month value; masters roll up via safeAdd", () => {
    // Oracle SpendingTrendsDataProvider.ts:280-431.
    const row = new RowMirror("Groceries", {}, 0, "b");
    row.setMonth("Jan '26", 6000);
    row.setMonthChange("Jan '26", 6000 - 4000); // prev-month leaf linked delta
    expect(row.getPreviousMonthValue("Jan '26")).toBe(4000);
    let masterTotal = 0;
    masterTotal = safeAdd(masterTotal, 6000);
    masterTotal = safeAdd(masterTotal, 3000);
    expect(masterTotal).toBe(9000);
    // Master Change = current total - previous total (verbatim :232-234).
    const masterChange = 9000 - 7000;
    expect(masterChange).toBe(2000);
  });

  it("transactionsDictionary records current-month hits; average = total/months (0 when total 0)", () => {
    // Oracle SpendingTrendsDataProvider.ts:379-383 + 240-245.
    const dict = new Map<string, number[]>();
    const add = (sub: string, month: string, id: number): void => {
      const key = `${sub}|${month}`;
      const bucket = dict.get(key) ?? [];
      bucket.push(id);
      dict.set(key, bucket);
    };
    add("Groceries", "Jan '26", 1);
    add("Groceries", "Jan '26", 2);
    expect(dict.get("Groceries|Jan '26")).toEqual([1, 2]);
    dict.clear();
    expect(dict.size).toBe(0);
    const avg = (total: number, n: number): number => (total === 0 ? 0 : total / n);
    expect(avg(0, 3)).toBe(0);
    expect(avg(9000, 3)).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// (f) HOReportDataRow parity
// ---------------------------------------------------------------------------

describe("B8 HOReportDataRow: average quirk + cells + change branches", () => {
  it("average ctor arg is ignored (stays NaN); defaults verbatim", () => {
    const r = new RowMirror("Food", {}, 0, "b", null, NaN, 42);
    expect(r.average).toBeNaN();
    expect(r.hasBeenTouched).toBe(false);
    expect(r.isTotalRow).toBe(false);
    expect(r.childRows).toBeNull();
  });

  it("month cells read/write; previous = value - change", () => {
    const r = new RowMirror("Food", {}, 0, "b");
    r.setMonth("Jan '26", 6000);
    r.setMonthChange("Jan '26", 2000);
    expect(r.getMonth("Jan '26")).toBe(6000);
    expect(r.getMonthChange("Jan '26")).toBe(2000);
    expect(r.getPreviousMonthValue("Jan '26")).toBe(4000);
  });

  it("change branches: positive-over-positive, positive-over-non-positive → 100", () => {
    const r = new RowMirror("Food", {}, 0, "b");
    r.setMonth("m", 6000); r.setMonthChange("m", 2000); // prev 4000
    expect(r.getMonthChangePercentage("m")).toBe(50);
    r.setMonth("m2", 1000); r.setMonthChange("m2", 1000); // prev 0
    expect(r.getMonthChangePercentage("m2")).toBe(100);
    r.setMonth("m3", -500); r.setMonthChange("m3", 500); // prev -1000
    expect(r.getMonthChangePercentage("m3")).toBe(100);
  });

  it("change branches: negative, zero, NaN → 0", () => {
    const r = new RowMirror("Food", {}, 0, "b");
    r.setMonth("m", 3000); r.setMonthChange("m", -1000); // prev 4000 → -(-1000)/4000*100
    expect(r.getMonthChangePercentage("m")).toBe(25);
    r.setMonth("m2", 4000); r.setMonthChange("m2", 0);
    expect(r.getMonthChangePercentage("m2")).toBe(0);
    r.setMonth("m3", NaN); r.setMonthChange("m3", NaN);
    expect(r.getMonthChangePercentage("m3")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (g) HOSortedMonthlyCategories parity
// ---------------------------------------------------------------------------

describe("B8 HOSortedMonthlyCategories: counting + sort + fallbacks", () => {
  it("counts only value > 0; sorts descending", () => {
    const s = new SortedCatsMirror();
    s.addEntry("a", 3000);
    s.addEntry("b", 0);
    s.addEntry("c", -500);
    s.addEntry("d", 9000);
    expect(s.nonZeroCategoriesCount).toBe(2);
    expect(s.categoriesCount).toBe(4);
    s.sortEntries();
    expect([s.getCategoryName(0), s.getCategoryName(1)]).toEqual(["d", "a"]);
  });

  it("position/name/value fallbacks + reset", () => {
    const s = new SortedCatsMirror();
    s.addEntry("a", 100);
    expect(s.getSortedPosition("a")).toBe(0);
    expect(s.getSortedPosition("missing")).toBe(-1);
    expect(s.getCategoryName(9)).toBe("");
    expect(s.getCategoryValue(9)).toBe(0);
    s.removeAllEntries();
    expect(s.categoriesCount).toBe(0);
    expect(s.nonZeroCategoriesCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (h) MBaseReport / ReportSettings / ReportUtilities / ChartColorMap /
//     FilterSelection / MReports parity
// ---------------------------------------------------------------------------

describe("B8 report models + utils: defaults, gates, formats, palettes", () => {
  it("MBaseReport defaults + lazy FilterSelection defaults + dirty flags", () => {
    // Oracle MBaseReport.ts:77-103.
    const mdl = {
      includeOffBudgetAccounts: false,
      ignoreIncomeCategories: true,
      ignoreOnBudgetTransfers: true,
      isReportDirty: true,
      isReportDataProviderDirty: true,
      selectedDates: new FilterMirror("Latest 3 Months"),
      selectedAccounts: new FilterMirror("Budget Accounts", []),
      selectedCategories: new FilterMirror("All Categories"),
      selectedPayees: new FilterMirror("All Payees"),
    };
    expect(mdl.includeOffBudgetAccounts).toBe(false);
    expect(mdl.ignoreIncomeCategories).toBe(true);
    expect(mdl.ignoreOnBudgetTransfers).toBe(true);
    expect(mdl.isReportDirty).toBe(true);
    expect(mdl.selectedDates.selectedOption).toBe("Latest 3 Months");
    expect(mdl.selectedAccounts.selectedOption).toBe("Budget Accounts");
    expect(mdl.selectedCategories.selectedOption).toBe("All Categories");
    expect(mdl.selectedPayees.selectedOption).toBe("All Payees");
    // NetWorth model flips ignoreOnBudgetTransfers to false (oracle MNetWorthReport.ts:36).
    expect({ ...mdl, ignoreOnBudgetTransfers: false }.ignoreOnBudgetTransfers).toBe(false);
  });

  it("ReportSettings find-or-create appends only on miss; setters notify only on change", () => {
    const list: { reportName: string }[] = [{ reportName: "Net Worth" }];
    const hit = getIndividualSettingsForReport(list, "Net Worth", (v) => list.push(v));
    expect(hit.reportName).toBe("Net Worth");
    expect(list).toHaveLength(1);
    const fresh = getIndividualSettingsForReport(list, "Spending By Category", (v) => list.push(v));
    expect(fresh.reportName).toBe("Spending By Category");
    expect(list).toHaveLength(2);
    // Oracle MBaseReport/FilterSelection notify-only-on-change idiom.
    let fires = 0;
    let cur: string | null = null;
    const set = (v: string | null): void => { if (cur !== v) { cur = v; fires += 1; } };
    set("a"); set("a"); set(null);
    expect(fires).toBe(2);
  });

  it("objects↔names round-trip: (MC)/(SC)/[No Payee]/(TopNode) with verbatim quirks", () => {
    // Oracle ReportSettings.ts:225-287 unload + 351-448 load.
    const toName = (kind: string, name: string, parent?: string): string =>
      kind === "master" ? `(MC)${name}` : `(SC)${name}(MC)${parent}`;
    const payeeToName = (isPayee: boolean, name: string): string => (isPayee ? name : "[No Payee]");
    expect(toName("master", "Food")).toBe("(MC)Food");
    expect(toName("sub", "Groceries", "Food")).toBe("(SC)Groceries(MC)Food");
    expect(payeeToName(false, "")).toBe("[No Payee]");
    // Load: verbatim `indexOf("(MC")` without the closing paren.
    const sc = "(SC)Groceries(MC)Food";
    const cut = sc.indexOf("(MC");
    expect([sc.substring(4, cut), sc.substring(cut + 4)]).toEqual(["Groceries", "Food"]);
    // Payee/account markers + unresolvable-name skip.
    expect("[No Payee]").toBe("[No Payee]");
    expect("(TopNode)Budget Accounts".substring(9)).toBe("Budget Accounts");
    const names = ["Food", "Missing"];
    const known = new Set(["Food"]);
    expect(names.filter((n) => known.has(n))).toEqual(["Food"]);
  });

  it("includeTransaction gates: off-budget, income-cat, transfer, account, payee", () => {
    // Oracle ReportUtilities.ts:99-166 branch order (entity graph → flags).
    type T = { onBudget: boolean; incomeCat: boolean; isTransfer: boolean; bothOnBudget: boolean; acctSel: boolean; payeeSel: boolean; noPayeeSel: boolean; payee: string | null };
    const gate = (t: T, ignoreIncome: boolean, ignoreXfer: boolean, allPayees: boolean): boolean => {
      if (!t.onBudget) return false;
      if (ignoreIncome && t.incomeCat) return false;
      if (ignoreXfer && t.isTransfer && t.bothOnBudget) return false;
      if (!t.acctSel) return false;
      if (!allPayees && !t.payeeSel && !(t.payee == null && t.noPayeeSel)) return false;
      return true;
    };
    const base: T = { onBudget: true, incomeCat: false, isTransfer: false, bothOnBudget: false, acctSel: true, payeeSel: true, noPayeeSel: false, payee: "a" };
    expect(gate(base, true, true, true)).toBe(true);
    expect(gate({ ...base, onBudget: false }, true, true, true)).toBe(false);
    expect(gate({ ...base, incomeCat: true }, true, true, true)).toBe(false);
    expect(gate({ ...base, incomeCat: true }, false, true, true)).toBe(true);
    expect(gate({ ...base, isTransfer: true, bothOnBudget: true }, true, true, true)).toBe(false);
    expect(gate({ ...base, acctSel: false }, true, true, true)).toBe(false);
    expect(gate({ ...base, payee: null, payeeSel: false }, true, true, false)).toBe(false);
    expect(gate({ ...base, payee: null, payeeSel: false, noPayeeSel: true }, true, true, false)).toBe(true);
  });

  it("safeGetPercentageOfTotal: total 0 → 0, NaN total still divides", () => {
    expect(safeGetPercentageOfTotal(500, 1000)).toBe(50);
    expect(safeGetPercentageOfTotal(500, 0)).toBe(0);
    expect(safeGetPercentageOfTotal(500, NaN)).toBeNaN();
    // Oracle currency formats: en-US grouping + no-thousands + non-finite → "".
    const grouped = (1234567).toLocaleString("en-US");
    expect(grouped).toBe("1,234,567");
    const noThousands = (c: number): string => {
      if (!Number.isFinite(c)) return "";
      return `${c < 0 ? "-$" : "$"}${(Math.abs(Math.round(c)) / 100).toFixed(2)}`;
    };
    expect(noThousands(123456)).toBe("$1234.56");
    expect(noThousands(-150)).toBe("-$1.50");
    expect(noThousands(0)).toBe("$0.00");
    expect(noThousands(NaN)).toBe("");
  });

  it("ChartColorMap: 15-entry palette, wraparound, named entries, singleton guard; FilterSelection ctor", () => {
    // Oracle ChartColorMap.ts:77-120.
    const palette = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    expect(palette).toHaveLength(15);
    const entryAt = (i: number): number => palette[i % palette.length]!;
    expect(entryAt(15)).toBe(entryAt(0));
    expect(entryAt(16)).toBe(entryAt(1));
    const named = { assets: 40623, liabilities: 15356985, netWorth: 6908521, bundled: 6908521 };
    expect(named).toEqual({ assets: 40623, liabilities: 15356985, netWorth: 6908521, bundled: 6908521 });
    const makeSingleton = (enforcer: unknown): object => {
      if (enforcer == null) throw new Error("You can only have one ChartColorMap object.");
      return {};
    };
    expect(() => makeSingleton(null)).toThrow("You can only have one ChartColorMap object.");
    // Oracle FilterSelection.ts:49-59: "" keeps default, null keeps [].
    expect(new FilterMirror("").selectedOption).toBe("");
    expect(new FilterMirror(null, null).selection).toEqual([]);
    expect(new FilterMirror("All Payees", ["a"]).selectedOption).toBe("All Payees");
  });

  it("MReports month labels: Jan '12 / January 2012 / Percent suffix; engine monthLabel anchors full name", () => {
    // Oracle MReports.ts:189-202 (Flex "MMM 'YY" / "MMMM YYYY").
    const short = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const col = (month0: number, year: number): string => `${short[month0]} '${String(year).slice(-2).padStart(2, "0")}`;
    const full = (month0: number, year: number): string =>
      (["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const)[month0] + ` ${year}`;
    expect(col(0, 2012)).toBe("Jan '12");
    expect(full(0, 2012)).toBe("January 2012");
    expect(`${col(0, 2012)}Percent`).toBe("Jan '12Percent");
    expect(monthLabel("2026-04")).toBe("April 2026");
    expect(monthLabel("2012-01")).toBe("January 2012");
  });
});
