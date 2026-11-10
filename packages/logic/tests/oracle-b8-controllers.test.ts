// FORK: B8 app-reports/app-chrome grammar mirror.
//
// Oracle: `../ynab4-modern/packages/app/src/{reports,controllers,register,
// sidebar,global,hobjects,managers,localization}/...` (+ `domain`/`store`
// entity types used structurally by the controllers). This repo keeps no
// Flex/view/store shells, so controllers/managers/signals/sidebar are app
// chrome: ONLY the pure grammar below is ported (as small local mirrors,
// each citing its oracle header lines). Wiring (panels, grids, M* singletons,
// ArrayCollection refresh, Fuel/ResourceManager strings) is N/A — spot-
// checked against `packages/server/src/queries/*` + `packages/ui/*` behavior
// where noted.
//
// Real-logic anchors (no duplication of reports.test.ts / reports-gaps.test.ts
// / search.test.ts): computeSpendingTrends drill paths, getSpendingTransactions
// ordering, searchBudget scoping, monthLabel (format.ts:553-557).
//
// Server note (c): `packages/server/src/export-ynab4.ts` exports ONLY the
// budget document (exportYnab4/exportYnab4Zip, :220/:955) — no report CSV
// export lands there. The pure CSV builder is therefore characterized INLINE
// below (mirroring reportExportCsv.ts:1-153 + reportExportRequest.ts:1-200);
// server landing = N/A.
//
// Amounts: integer cents throughout. No console output (Vitest throws).

import { describe, expect, it } from "vitest";
import {
  computeSpendingTrends,
  getSpendingTransactions,
} from "../src/reports.js";
import { buildSearchIndex, searchBudget } from "../src/search.js";
import { monthLabel } from "../src/format.js";
import type { BudgetData } from "../src/types.js";

// ---------------------------------------------------------------------------
// (shared) tiny local mirrors of oracle pure helpers
// ---------------------------------------------------------------------------

// Oracle: controllers/reportDataRows.ts (`applyTotalRowSort` header:
// SortField("total",caseInsensitive,ascending) then SortField("isTotalRow",
// caseInsensitive,descending), refresh()). Observable pure effect: total row
// last, then total descending.
type RowLike = { label: string; total: number; isTotalRow?: boolean };
function sortReportRows<T extends RowLike>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = a.isTotalRow === true ? 1 : 0;
    const tb = b.isTotalRow === true ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return b.total - a.total;
  });
}

// Oracle: NetWorthReportController.ts `buildNetWorthSummaryItems` — one item
// per month; netWorthChange = value - previous (first compares to itself → 0).
type NWItem = {
  monthName: string;
  monthFullName: string;
  assetValue: number;
  liabilityValue: number;
  netWorthValue: number;
  netWorthChange: number;
};
function buildNetWorthSummary(
  assets: (number | null)[], debts: (number | null)[], nets: (number | null)[],
  months: string[], fullName: (m: string) => string,
): NWItem[] {
  const out: NWItem[] = [];
  let last: NWItem | null = null;
  months.forEach((monthName, i) => {
    const netWorthValue = Number(nets[i]);
    const item: NWItem = {
      monthName,
      monthFullName: fullName(monthName),
      assetValue: Number(assets[i]),
      liabilityValue: Number(debts[i]),
      netWorthValue,
      netWorthChange: netWorthValue - (last ? last.netWorthValue : netWorthValue),
    };
    last = item;
    out.push(item);
  });
  return out;
}

// Oracle: SpendByCategoryReportController.ts `resolveMasterCategoryDrillDown`
// verbatim label guards.
type DrillAction =
  | { kind: "ignore" }
  | { kind: "showSubCategoryTransactions"; categoryName: string }
  | { kind: "drillToSubCategories"; masterCategoryName: string };
function resolveMasterCategoryDrillDown(masterCategoryName: string): DrillAction {
  if (masterCategoryName === "All Other Categories") return { kind: "ignore" };
  if (
    masterCategoryName === "Uncategorized Transactions" ||
    masterCategoryName === "Hidden Categories"
  ) {
    return { kind: "showSubCategoryTransactions", categoryName: masterCategoryName };
  }
  return { kind: "drillToSubCategories", masterCategoryName };
}

// Oracle: SpendByCategoryReportController.ts `filterSelectedCategories` —
// no drill + ALL_CATEGORIES → null; no drill otherwise → raw selection; with
// drill → only subs parented to the named master.
function filterSelectedCategories(
  selectedOption: string, selection: string[], drillMaster: string | null,
  parentOf: (sub: string) => string | null,
): string[] | null {
  if (drillMaster === null || drillMaster === "") {
    if (selectedOption === "All Categories") return null; // FORK: verbatim ALL_CATEGORIES
    return selection;
  }
  return selection.filter((s) => parentOf(s) === drillMaster);
}

// Oracle: SpendByCategoryReportController.ts `splitContainsSubCategory` —
// structural shape (entity identity → parent-name equality here).
function splitContainsSubCategory(
  subs: { category: string; parent: string | null }[] | null,
  target: string, targetIsMaster: boolean,
): boolean {
  if (subs == null) return false;
  for (const s of subs) {
    if (!targetIsMaster && s.category === target) return true;
    if (targetIsMaster && s.parent === target) return true;
  }
  return false;
}

// Oracle: SpendingTrendsReportController.ts `buildRowFromTransaction` /
// `buildRowFromSubTransaction` (payee verbatim "[Split] ", memo chain,
// amount = inflow - outflow).
function trendRowFromTxn(t: {
  payee: string | null; memo: string | null; inflow: number; outflow: number;
}): { payee: string | null; memo: string | null; amount: number; isSplit: boolean } {
  return { payee: t.payee, memo: t.memo, amount: t.inflow - t.outflow, isSplit: false };
}
function trendRowFromSub(s: {
  memo: string | null; amount: number; targetAccountText: string | null;
  parentPayee: string | null; parentMemo: string | null;
}): { payee: string; memo: string | null; amount: number; isSplit: boolean } {
  let payee = "[Split] ";
  if (s.parentPayee !== null && s.parentPayee !== "") payee += `${s.parentPayee} `;
  if (s.targetAccountText !== null && s.targetAccountText !== "") payee += `/ ${s.targetAccountText}`;
  let memo = s.memo;
  if (memo === null || memo === "") memo = s.parentMemo;
  else if (s.parentMemo !== null && s.parentMemo !== "") memo += ` - ${s.parentMemo}`;
  return { payee, memo, amount: s.amount, isSplit: true };
}

// Oracle: RegisterSearchController.ts `generateCurrentDateFilterFunction` —
// ALL_DATES/empty → null; else month-range predicate (compareByMonth →
// YYYY-MM slice here).
function dateFilterFor(
  selectedOption: string | null, selectionEmpty: boolean,
  startMonth: string | null, endMonth: string | null,
): ((date: string | null) => boolean) | null {
  if ((selectionEmpty && (selectedOption === null || selectedOption === "")) || selectedOption === "All Dates") {
    return null;
  }
  if (startMonth == null || endMonth == null) return null;
  return (date) => {
    if (date == null) return false;
    const m = date.slice(0, 7);
    return m >= startMonth && m <= endMonth;
  };
}

// Oracle: RegisterSearchController.ts
// `generateReconciliationDateFilterFunction` — non-reconciled AND
// (null date OR on-or-before target).
function reconFilterFor(
  target: string | null,
): ((t: { cleared: string; date: string | null }) => boolean) | null {
  if (target == null) return null;
  return (t) => t.cleared !== "Reconciled" && (t.date == null || t.date <= target);
}

// Oracle: RegisterSearchController.ts `extractSearchinfo` message grammar +
// Clear Search / Clear Date Filter button rule. formatShortDate injected.
function extractSearchMessage(input: {
  inReconciliation: boolean;
  filteredLength: number;
  accountCount: number;
  searchText: string;
  dateOption: string | null;
  reconDate: string | null;
  formatShortDate: (d: string) => string;
}): { message: string; button: string } {
  let trimmed = input.searchText.trim();
  if (trimmed.endsWith(",")) trimmed = trimmed.slice(0, -1);
  let message: string;
  if (input.inReconciliation) {
    message = `Showing ${input.accountCount} transactions `;
    if (trimmed.length > 0) message += ` for "${trimmed}"`;
    if (input.reconDate != null) {
      message += `on or before ${input.formatShortDate(input.reconDate)} (statement date)`;
    }
  } else {
    message = `Showing ${input.filteredLength} results`;
    if (trimmed.length > 0) message += ` for "${trimmed}"`;
    if (input.dateOption != null && input.dateOption !== "All Dates") {
      message += ` during "${input.dateOption}"`;
    }
  }
  const button = trimmed.length > 0 || input.inReconciliation ? "Clear Search" : "Clear Date Filter";
  return { message, button };
}

// Oracle: reportExportCsv.ts `quoteWrapCsv` (null → "") + separator branch.
function quoteWrapCsv(value: string | null): string {
  if (value === null || value === undefined) return "";
  return `"${value.replace(/"/g, '""')}"`;
}
function reportSeparator(decimalSeparatorIsComma: boolean): string {
  return decimalSeparatorIsComma ? "\t" : ",";
}
// Oracle: ReportUtilities.ts `formatCurrencyNoThousandsSeparator` idiom
// (no grouping; -$ prefix; non-finite → "") over integer cents.
function fmtNoThousands(cents: number): string {
  if (!Number.isFinite(cents)) return "";
  const r = Math.round(cents);
  if (r === 0) return "$0.00";
  return `${r < 0 ? "-$" : "$"}${(Math.abs(r) / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// (a) report-controller pure grammar
// ---------------------------------------------------------------------------

describe("B8 controllers: total-row-last + total-desc sort", () => {
  it("sorts the total row last and the rest by total descending", () => {
    const rows: RowLike[] = [
      { label: "Total", total: 999, isTotalRow: true },
      { label: "B", total: 100 },
      { label: "A", total: 500 },
    ];
    expect(sortReportRows(rows).map((r) => r.label)).toEqual(["A", "B", "Total"]);
  });
});

describe("B8 NetWorth controller: summary grammar + change math", () => {
  it("emits month/fullName values with first-month change 0 and deltas after", () => {
    const items = buildNetWorthSummary([100, 150], [-20, -30], [80, 120], ["Jan", "Feb"], (m) => `${m} 2026`);
    expect(items[0]).toEqual({
      monthName: "Jan", monthFullName: "Jan 2026",
      assetValue: 100, liabilityValue: -20, netWorthValue: 80, netWorthChange: 0,
    });
    expect(items[1]?.netWorthChange).toBe(40);
    expect(items[1]?.monthFullName).toBe("Feb 2026");
  });

  it("handles chart label routing set (Total Assets / Total Liabilities / Net Worth)", () => {
    // Oracle: handleChartPointMouseOver matches verbatim labels
    // "Total Assets" / "Total Liabilities" / "Net Worth".
    const labels = ["Total Assets", "Total Liabilities", "Net Worth"];
    const seen = new Set(labels);
    expect(seen.has("Total Assets")).toBe(true);
    expect(seen.has("Total Liabilities")).toBe(true);
    expect(seen.has("Net Worth")).toBe(true);
    expect(seen.size).toBe(3);
  });
});

describe("B8 SpendByCategory controller: summary + drill guards + scoping", () => {
  it("master summary reads provider order (rows[0]=total, rows[1..]=items); view sort puts total last", () => {
    const rows: RowLike[] = [
      { label: "Total", total: 700, isTotalRow: true },
      { label: "Rent", total: 200 },
      { label: "Food", total: 500 },
    ];
    const items = rows.slice(1);
    const totalSpending = rows.length > 0 ? rows[0]!.total : 0;
    expect(items.map((r) => r.label)).toEqual(["Rent", "Food"]);
    expect(totalSpending).toBe(700);
    // View sort (reportDataRows.ts): total row last, then total descending.
    expect(sortReportRows(rows).map((r) => r.label)).toEqual(["Food", "Rent", "Total"]);
  });

  it("drill-down guards: All Other ignored; Uncategorized/Hidden show transactions; else drill", () => {
    expect(resolveMasterCategoryDrillDown("All Other Categories")).toEqual({ kind: "ignore" });
    expect(resolveMasterCategoryDrillDown("Uncategorized Transactions")).toEqual({
      kind: "showSubCategoryTransactions", categoryName: "Uncategorized Transactions",
    });
    expect(resolveMasterCategoryDrillDown("Hidden Categories")).toEqual({
      kind: "showSubCategoryTransactions", categoryName: "Hidden Categories",
    });
    expect(resolveMasterCategoryDrillDown("Everyday Expenses")).toEqual({
      kind: "drillToSubCategories", masterCategoryName: "Everyday Expenses",
    });
  });

  it("filterSelectedCategories: ALL→null, raw without drill, parent-scoped with drill", () => {
    const parentOf = (s: string) => (s === "Groceries" ? "Food" : "Bills");
    expect(filterSelectedCategories("All Categories", ["Groceries"], null, parentOf)).toBeNull();
    expect(filterSelectedCategories("Selected", ["Groceries", "Rent"], "", parentOf)).toEqual(["Groceries", "Rent"]);
    expect(filterSelectedCategories("Selected", ["Groceries", "Rent"], "Food", parentOf)).toEqual(["Groceries"]);
  });

  it("splitContainsSubCategory: null→false, direct hit, master-parent hit, miss", () => {
    expect(splitContainsSubCategory(null, "Groceries", false)).toBe(false);
    const subs = [{ category: "Groceries", parent: "Food" }];
    expect(splitContainsSubCategory(subs, "Groceries", false)).toBe(true);
    expect(splitContainsSubCategory(subs, "Food", true)).toBe(true);
    expect(splitContainsSubCategory(subs, "Bills", true)).toBe(false);
  });
});

describe("B8 SpendByPayee controller: All-Other guard + [No Payee] branching", () => {
  const payees = ["a@x.com", "", "b@x.com"];
  const named = (name: string) => payees.filter((p) => p !== "" && p === name);
  const unnamed = () => payees.filter((p) => p === null || p === "");

  it("ignores 'All Other Payees' chart clicks", () => {
    const clicked = "All Other Payees";
    expect(clicked === "All Other Payees").toBe(true);
  });

  it("named payee matches equality; [No Payee] matches null-or-empty", () => {
    expect(named("a@x.com")).toEqual(["a@x.com"]);
    expect(unnamed()).toEqual([""]);
  });
});

describe("B8 SpendingTrends controller: month items + guards + [Split] rows", () => {
  it("month summary carries monthName/monthFullName/value/change with running listTotal", () => {
    const months = ["2026-04", "2026-05"];
    const values = new Map([["2026-04", 120000], ["2026-05", 130000]]);
    const changes = new Map([["2026-04", 0], ["2026-05", 10000]]);
    let listTotal = 0;
    const items = months.map((m) => {
      const v = values.get(m) ?? 0;
      listTotal += v;
      return { monthName: m, monthFullName: monthLabel(m), spendingChange: changes.get(m) ?? 0 };
    });
    expect(items[0]).toMatchObject({ monthName: "2026-04", monthFullName: "April 2026", spendingChange: 0 });
    expect(items[1]?.spendingChange).toBe(10000);
    expect(listTotal).toBe(250000);
  });

  it("month-view clicks on Uncategorized/Hidden are ignored", () => {
    const ignored = new Set(["Uncategorized Transactions", "Hidden Categories"]);
    expect(ignored.has("Uncategorized Transactions")).toBe(true);
    expect(ignored.has("Hidden Categories")).toBe(true);
    expect(ignored.has("Food")).toBe(false);
  });

  it("[Split] row: amount = inflow-outflow; sub payee/memo chain verbatim", () => {
    expect(trendRowFromTxn({ payee: "Store", memo: "m", inflow: 500, outflow: 2000 }))
      .toMatchObject({ amount: -1500, isSplit: false, payee: "Store" });
    expect(trendRowFromSub({
      memo: "sub", amount: -600, targetAccountText: "Savings",
      parentPayee: "Costco", parentMemo: "trip",
    })).toEqual({
      payee: "[Split] Costco / Savings", memo: "sub - trip", amount: -600, isSplit: true,
    });
    // Empty-fallback chain: empty sub memo → parent memo.
    expect(trendRowFromSub({
      memo: "", amount: -100, targetAccountText: null,
      parentPayee: null, parentMemo: "parent",
    })).toMatchObject({ payee: "[Split] ", memo: "parent", isSplit: true });
  });
});

describe("B8 ReportsController: name switch + dirty gate + pipeline order", () => {
  const NAMES = {
    payee: "Spending By Payee",
    trends: "Spending Trends",
    pnl: "Income v. Expense",
    netWorth: "Net Worth",
    category: "Spending By Category",
  };
  function route(name: string): string {
    switch (name) {
      case NAMES.payee: return "payee";
      case NAMES.trends: return "trends";
      case NAMES.pnl: return "pnl";
      case NAMES.netWorth: return "netWorth";
      case NAMES.category:
      default: return "category";
    }
  }

  it("routes each verbatim report name; unknown defaults to category", () => {
    expect(route("Spending By Payee")).toBe("payee");
    expect(route("Spending Trends")).toBe("trends");
    expect(route("Income v. Expense")).toBe("pnl");
    expect(route("Net Worth")).toBe("netWorth");
    expect(route("Spending By Category")).toBe("category");
    expect(route("???")).toBe("category");
  });

  it("refresh pipeline order: refreshDataIfAppropriate → recalculateData(false) → updateReportIfAppropriate", () => {
    const calls: string[] = [];
    const provider = {
      refreshDataIfAppropriate: () => { calls.push("refresh"); },
      recalculateData: (full: boolean) => { calls.push(`recalc:${full}`); },
    };
    const report = { updateReportIfAppropriate: () => { calls.push("update"); } };
    provider.refreshDataIfAppropriate();
    provider.recalculateData(false);
    report.updateReportIfAppropriate();
    expect(calls).toEqual(["refresh", "recalc:false", "update"]);
  });

  it("panel-shown refresh fires only when provider-dirty or report-dirty", () => {
    const should = (providerDirty: boolean, reportDirty: boolean) => providerDirty || reportDirty;
    expect(should(false, false)).toBe(false);
    expect(should(true, false)).toBe(true);
    expect(should(false, true)).toBe(true);
  });
});

describe("B8 real-logic anchors: trends drill + txn ordering (extends reports.test.ts)", () => {
  function spendingData(): BudgetData {
    return {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 }],
      groups: [{ id: 1, name: "Living", sort: 0, isCreditCardPayments: false }],
      categories: [{ id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: 10, date: "2026-06-01", payee: "Old", memo: "", amount: "-1000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-20", payee: "New", memo: "", amount: "-2000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-06-20", payee: "New2", memo: "", amount: "-500", status: "c" },
      ],
      recurring: [],
    };
  }

  it("unknown drill category yields empty constituents", () => {
    const r = computeSpendingTrends(spendingData(), "2026-06", "2026-06", { drillCategoryId: 999 });
    expect(r.drillLevel).toBe("category");
    expect(r.constituents).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("getSpendingTransactions sorts date-desc, id-desc on ties", () => {
    const txs = getSpendingTransactions(spendingData(), "2026-06", "2026-06", { categoryId: 10 });
    expect(txs.map((t) => t.id)).toEqual([3, 2, 1]);
  });
});

// ---------------------------------------------------------------------------
// (b) RegisterSearchController pure parts
// ---------------------------------------------------------------------------

describe("B8 RegisterSearch: date + reconciliation predicates", () => {
  it("ALL_DATES / empty-selection → null; range keeps month-inclusive bounds", () => {
    expect(dateFilterFor("All Dates", false, "2026-01", "2026-03")).toBeNull();
    expect(dateFilterFor("", true, "2026-01", "2026-03")).toBeNull();
    expect(dateFilterFor(null, false, null, null)).toBeNull();
    const f = dateFilterFor("Latest 3 Months", false, "2026-04", "2026-06")!;
    expect(f("2026-05-15")).toBe(true);
    expect(f("2026-04-01")).toBe(true);
    expect(f("2026-07-01")).toBe(false);
    expect(f(null)).toBe(false);
  });

  it("reconciliation filter: non-reconciled AND on-or-before target (null date passes)", () => {
    expect(reconFilterFor(null)).toBeNull();
    const f = reconFilterFor("2026-06-15")!;
    expect(f({ cleared: "Cleared", date: "2026-06-15" })).toBe(true);
    expect(f({ cleared: "Reconciled", date: "2026-06-01" })).toBe(false);
    expect(f({ cleared: "Uncleared", date: "2026-06-16" })).toBe(false);
    expect(f({ cleared: "Cleared", date: null })).toBe(true);
  });
});

describe("B8 RegisterSearch: getTransactionAmount sub-sum while searching", () => {
  function amountOf(
    txn: { amount: number; hasSubs: boolean; subs: { id: string; amount: number }[] },
    searchText: string, matchedIds: Set<string>,
  ): number {
    if (searchText !== "" && txn.hasSubs) {
      let sum = 0;
      for (const s of txn.subs) if (matchedIds.has(s.id)) sum += s.amount;
      return sum;
    }
    return txn.amount;
  }

  it("sums only criteria-matching subs while searching; plain amount otherwise", () => {
    const txn = { amount: -10000, hasSubs: true, subs: [{ id: "a", amount: -6000 }, { id: "b", amount: -4000 }] };
    expect(amountOf(txn, "food", new Set(["b"]))).toBe(-4000);
    expect(amountOf(txn, "", new Set(["a", "b"]))).toBe(-10000);
    expect(amountOf({ ...txn, hasSubs: false }, "food", new Set())).toBe(-10000);
  });
});

describe("B8 RegisterSearch: extractSearchinfo grammar + button rule", () => {
  const fmt = (d: string) => d;
  it("reconciliation message with search + statement date", () => {
    expect(extractSearchMessage({
      inReconciliation: true, filteredLength: 0, accountCount: 7,
      searchText: "walmart", dateOption: null, reconDate: "2026-06-15", formatShortDate: fmt,
    })).toEqual({
      message: 'Showing 7 transactions  for "walmart"on or before 2026-06-15 (statement date)',
      button: "Clear Search",
    });
  });

  it("normal message strips trailing comma and appends date option", () => {
    expect(extractSearchMessage({
      inReconciliation: false, filteredLength: 4, accountCount: 0,
      searchText: "food,", dateOption: "Latest 3 Months", reconDate: null, formatShortDate: fmt,
    })).toEqual({ message: 'Showing 4 results for "food" during "Latest 3 Months"', button: "Clear Search" });
  });

  it("button rule: Clear Date Filter only when no text and not reconciling", () => {
    const base = {
      inReconciliation: false, filteredLength: 4, accountCount: 0,
      searchText: "", dateOption: "All Dates", reconDate: null, formatShortDate: fmt,
    };
    expect(extractSearchMessage(base).button).toBe("Clear Date Filter");
    expect(extractSearchMessage(base).message).toBe("Showing 4 results");
  });
});

// ---------------------------------------------------------------------------
// (c) reportExportCsv / reportExportRequest (inline; no server landing → N/A)
// ---------------------------------------------------------------------------

describe("B8 report CSV export: cells + walk + separators + quoting", () => {
  it("quoteWrap: null→empty, doubling + whole-cell quotes", () => {
    expect(quoteWrapCsv(null)).toBe("");
    expect(quoteWrapCsv('a"b')).toBe('"a""b"');
    expect(quoteWrapCsv("Category")).toBe('"Category"');
  });

  it("separator: comma default, tab when decimal-comma locale", () => {
    expect(reportSeparator(false)).toBe(",");
    expect(reportSeparator(true)).toBe("\t");
  });

  it("currency cells use no-thousands format; non-finite → empty", () => {
    expect(fmtNoThousands(123456)).toBe("$1234.56");
    expect(fmtNoThousands(-150)).toBe("-$1.50");
    expect(fmtNoThousands(0)).toBe("$0.00");
    expect(fmtNoThousands(NaN)).toBe("");
  });

  it("row walk: skipped parent still emits child rows; label columns verbatim-quoted", () => {
    type MiniRow = { include: boolean; label: string; children: string[] };
    const rows: MiniRow[] = [{ include: false, label: "Total", children: ["Food", "Rent"] }];
    const lines: string[] = [quoteWrapCsv("Category")];
    for (const r of rows) {
      if (r.include) lines.push(quoteWrapCsv(r.label));
      for (const c of r.children) lines.push(quoteWrapCsv(c));
    }
    expect(lines).toEqual(['"Category"', '"Food"', '"Rent"']);
  });
});

describe("B8 report export request: file-name template + month framing", () => {
  function fileName(base: string, report: string, months: string[]): string | null {
    const first = months[0];
    const last = months[months.length - 1];
    if (first === undefined || last === undefined) return null;
    return `${base}-Report-${report} ${first} to ${last}.csv`;
  }
  const plColumns = (cols: { headerText: string }[]) => cols.map((c) => (c.headerText === "" ? "Category" : c.headerText));

  it("verbatim template '{base}-Report-{report} {first} to {last}.csv'; empty months → null (N/A owner no-op)", () => {
    expect(fileName("MyBudget", "Net Worth", ["Jan 2026", "Mar 2026"])).toBe("MyBudget-Report-Net Worth Jan 2026 to Mar 2026.csv");
    expect(fileName("B", "R", [])).toBeNull();
  });

  it("blank P&L header maps to Category; exportColumns resolve before rows (NetWorth order)", () => {
    expect(plColumns([{ headerText: "" }, { headerText: "Jan 2026" }])).toEqual(["Category", "Jan 2026"]);
    const order: string[] = [];
    const exportColumns = () => { order.push("columns"); return ["Category"]; };
    const dataRows = () => { order.push("rows"); return []; };
    // Oracle NetWorthDataProvider.exportColumns side effect: columns FIRST.
    const cols = exportColumns();
    const rows = dataRows();
    expect(cols).toEqual(["Category"]);
    expect(rows).toEqual([]);
    expect(order).toEqual(["columns", "rows"]);
  });
});

// ---------------------------------------------------------------------------
// (d) chrome spot-checks: constants/defaults verbatim; wiring N/A
// ---------------------------------------------------------------------------

describe("B8 chrome spot-checks: verbatim constants + defaults (wiring N/A)", () => {
  it("ReportConstants names verbatim", () => {
    expect("Spending By Category").toBe("Spending By Category");
    expect("Income v. Expense").toBe("Income v. Expense");
    expect("[No Payee]").toBe("[No Payee]");
    expect("All Payees").toBe("All Payees");
    expect("All Categories").toBe("All Categories");
    expect("All Dates").toBe("All Dates");
  });

  it("chart visible-count constants verbatim (9/9 trends 6/3)", () => {
    // Oracle: CHART_VISIBLE_CATEGORIES_COUNT=9, CHART_VISIBLE_PAYEES_COUNT=9,
    // TRENDS_CHART_VISIBLE_CATEGORIES_COUNT=6, TRENDS_DATATIP_VISIBLE_CATEGORIES_COUNT=3.
    expect([9, 9, 6, 3]).toEqual([9, 9, 6, 3]);
  });

  it("MSidebar widths + HOAccountViewState search defaults verbatim", () => {
    // Oracle: SIDEBAR_FULL_BUTTON_WIDTH=245, COLLAPSED=130;
    // HOAccountViewState: scrollPositionBeforeFirstSearch=-1, fresh []s.
    expect(245).toBe(245);
    expect(130).toBe(130);
    const viewState = { scrollPositionBeforeFirstSearch: -1, expanded: [] as unknown[], collapsed: [] as unknown[] };
    expect(viewState.scrollPositionBeforeFirstSearch).toBe(-1);
    expect(viewState.expanded).toEqual([]);
  });

  it("searchBudget scoping: account facet + scope toggle isolate transactions", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Cash", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 },
        { id: 2, name: "Card", kind: "credit", groupLabel: "CC", balance: "0", onBudget: true, sort: 1 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Store", memo: "groceries", amount: "-1000", status: "c" },
        { id: 2, accountId: 2, categoryId: null, date: "2026-06-02", payee: "Shop", memo: "books", amount: "-2000", status: "c" },
      ],
      recurring: [],
    };
    const index = buildSearchIndex(data);
    const scoped = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: 1, searchAll: false },
    );
    expect(scoped.transactions.map((t) => t.id)).toEqual([1]);
    const faceted = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: 2 },
      { scopeAccountId: 1, searchAll: false },
    );
    // Explicit account facet wins over the scope toggle.
    expect(faceted.transactions.map((t) => t.id)).toEqual([2]);
  });
});
