/**
 * Oracle B8 — register/search parity map.
 *
 * Oracle sources (../ynab4-modern):
 * - packages/app/src/register/MRegister.ts
 *   criteria add/remove 207-235, parent-or-sub verify 238-261,
 *   mark-parent-if-all-subs 263-284 (vacuous truth), isFiltered 286-293,
 *   inSearch 295-301, per-account view-state identity/cache 315-336.
 * - packages/app/src/register/RegisterFilter.ts
 *   gate order 101-131, rejection counts + pass callbacks 133-159,
 *   verbatim resetCount 93-99, null passes 101-102.
 * - packages/app/src/register/RegisterSearchItem.ts
 *   AND-wrapper + split promotion 286-313, parseSearchString 315-369,
 *   decimal-comma preprocessor 379-414, parseSearchTerm matrix 416-557,
 *   first-colon split 559-570, Adaptive 572-728, AllFields 730-831,
 *   Amount 833-888, Approved 890-917, Check 919-952, cleared tables 954-1034,
 *   Expense 1096-1119, IncomeOrExpense 1121-1144, Flag 1158-1198,
 *   Accounts 1212-1304, Categories 1318-1409, Payees 1423-1516,
 *   ErrorLevel 1518-1564, Date 1566-1615, IncomeFor 1617-1680 +
 *   parseIncomeMonthString 235-269.
 * - packages/app/src/register/registerGrid.test.ts (MRegisterGrid defaults,
 *   change-only notify, singleton enforcers) — React-adapter N/A, see bottom.
 *
 * Implementation under test: packages/logic/src/search.ts (buildSearchIndex,
 * searchBudget, inScope-via-scope) + searchQuery.ts (parseInput,
 * parseSearchAmount, parseSearchDate, filterFromRaw, matchesFilter,
 * matchesText, applyQuery, inScope, resolvers).
 *
 * Method: each oracle behavior is mapped to the closest new-API analog.
 * Where no analog exists the test pins the gap explicitly (// FORK / // GAP).
 * Extends (does not duplicate) search.test.ts, searchQuery.test.ts,
 * searchQuery-gaps.test.ts — all fixtures/values below are new.
 */
import { describe, expect, it } from "vitest";
import { buildSearchIndex, searchBudget } from "../src/search.js";
import {
  applyQuery,
  buildSearchCtx,
  filterFromRaw,
  inScope,
  matchesFilter,
  matchesText,
  parseInput,
  parseSearchAmount,
  parseSearchDate,
  resolveAccountId,
  textTokens,
} from "../src/searchQuery.js";
import type { BudgetData, Transaction } from "../src/types.js";

let _id = 1000;
const nextId = () => ++_id;

const t = (
  o: Partial<Transaction> & { accountId: number; amount: string; date: string },
): Transaction => ({
  id: nextId(),
  categoryId: null,
  payee: "",
  memo: "",
  status: "c",
  transferAccountId: null,
  parentId: null,
  ...o,
});

function data(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 1 },
    ],
    groups: [{ id: 10, name: "Groceries Group", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 100, groupId: 10, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      t({ accountId: 1, categoryId: 100, payee: "Corner Store", memo: "milk run", amount: "-2500", date: "2026-04-01" }),
      // Reconciled row: oracle hides it only via the RegisterFilter tail.
      t({ accountId: 2, categoryId: null, payee: "Payroll", memo: "", amount: "300000", date: "2026-04-02", status: "r" }),
      // Transfer leg touching account 2: parent-or-sub analog.
      t({ accountId: 1, categoryId: null, payee: "Transfer : Savings", memo: "", amount: "-80000", date: "2026-04-03", status: "u", transferAccountId: 2 }),
    ],
    recurring: [],
  };
}

// Oracle MRegister.updateIsFilteredFlag: date != "All Dates" OR search OR
// reconciliation. New-API analog: any active facet/text/date filter.
// (inReconciliation has no search analog — reconciliation lives in
// reconcile.ts; see GAP note in the reconciliation test below.)
const isFilteredAnalog = (q: { filters: unknown[]; text: string }) =>
  q.filters.length > 0 || q.text.trim() !== "";

describe("MRegister criteria -> searchBudget scope/facets + SearchIndex", () => {
  it("absent facet (null) filters nothing, like the absent map entry", () => {
    const index = buildSearchIndex(data());
    const res = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: null, searchAll: true },
    );
    expect(res.transactions).toHaveLength(3);
  });

  it("clearing a facet restores rows (remove leaves excludable, re-add includes)", () => {
    const index = buildSearchIndex(data());
    const scoped = { scopeAccountId: null, searchAll: true };
    const narrowed = searchBudget(
      index,
      { query: "", payee: "Payroll", categoryId: null, accountId: null },
      scoped,
    );
    expect(narrowed.transactions.map((x) => x.payee)).toEqual(["Payroll"]);
    const cleared = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: null },
      scoped,
    );
    expect(cleared.transactions).toHaveLength(3);
  });

  it("parent-or-sub: a transfer row stays in scope via either leg", () => {
    const d = data();
    const transfer = d.transactions[2]!;
    expect(inScope(transfer, 2, false, null)).toBe(true);
    expect(inScope(transfer, 1, false, null)).toBe(true);
    expect(inScope(transfer, 999, false, null)).toBe(false);
    // Facet form: same OR across legs.
    expect(inScope(transfer, null, true, 2)).toBe(true);
  });

  it("vacuous truth: empty text/criteria match everything", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    expect(matchesText(d.transactions[0]!, [], ctx)).toBe(true);
    expect(textTokens("   ")).toEqual([]);
    const rows = applyQuery(d.transactions, { filters: [], text: "" }, ctx, {
      scopeAccountId: null,
      searchAll: true,
    });
    expect(rows).toHaveLength(3);
  });

  it("isFiltered analog: date/search/reconciliation OR", () => {
    expect(isFilteredAnalog({ filters: [], text: "" })).toBe(false);
    expect(isFilteredAnalog({ filters: [], text: "milk" })).toBe(true);
    expect(
      isFilteredAnalog({
        filters: [{ kind: "date", start: "2026-04-01", end: "2026-04-30", label: "Apr" }],
        text: "",
      }),
    ).toBe(true);
    // GAP: oracle also ORs inReconciliation; the new search pipeline has no
    // reconciliation flag (covered by reconcile.ts, not searchQuery.ts).
  });

  it("inSearch analog: non-blank text means in search", () => {
    // Oracle updateInSearchFlag uses !isNullOrEmpty(searchText): whitespace
    // counts as in-search (pinned in MRegister.test.ts).
    expect(textTokens("  ").length === 0).toBe(true);
    expect(isFilteredAnalog({ filters: [], text: "  " })).toBe(false);
    expect("  ".trim() !== "").toBe(false);
    expect(isFilteredAnalog({ filters: [], text: "x" })).toBe(true);
  });

  it("per-account state: ctx/index resolve accounts identically on repeat reads", () => {
    const d = data();
    const a = buildSearchCtx(d);
    const b = buildSearchCtx(d);
    expect(a.accountById.get(1)).toBe(b.accountById.get(1));
    expect(resolveAccountId(d, "CHECKING")).toBe(1);
    // Repeat matching is stable (WeakMap field cache in searchQuery.ts).
    const tx0 = d.transactions[0]!;
    const f = { kind: "payee" as const, value: "corner" };
    expect(matchesFilter(tx0, f, a)).toBe(true);
    expect(matchesFilter(tx0, f, a)).toBe(true);
  });
});

describe("RegisterFilter pipeline -> applyQuery/inScope", () => {
  it("ANDs scope + filters + text; filter order does not change the result", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const payee = { kind: "payee" as const, value: "corner" };
    const date = { kind: "date" as const, start: "2026-04-01", end: "2026-04-30", label: "Apr" };
    const fwd = applyQuery(d.transactions, { filters: [payee, date], text: "milk" }, ctx, {
      scopeAccountId: null,
      searchAll: true,
    });
    const rev = applyQuery(d.transactions, { filters: [date, payee], text: "milk" }, ctx, {
      scopeAccountId: null,
      searchAll: true,
    });
    // FORK: oracle RegisterFilter has an ordered gate (filterDatesFirst swaps
    // search/date) with pass callbacks; the new pipeline is a single
    // order-independent AND, so both orders agree by construction.
    expect(fwd.map((x) => x.id)).toEqual(rev.map((x) => x.id));
    expect(fwd.map((x) => x.payee)).toEqual(["Corner Store"]);
  });

  it("a failing facet short-circuits the row (search-then-date analog)", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const rows = applyQuery(
      d.transactions,
      { filters: [{ kind: "payee", value: "nope" }], text: "milk" },
      ctx,
      { scopeAccountId: null, searchAll: true },
    );
    expect(rows).toEqual([]);
  });

  it("no reconciled-hiding tail: reconciled rows pass an empty query", () => {
    // FORK: oracle hides reconciled rows when no search/date fn is set and
    // !isShowingReconciled. The new pipeline has no showing-reconciled state;
    // visibility is explicit via is:cleared / is:uncleared.
    const d = data();
    const ctx = buildSearchCtx(d);
    const rows = applyQuery(d.transactions, { filters: [], text: "" }, ctx, {
      scopeAccountId: null,
      searchAll: true,
    });
    expect(rows.map((x) => x.payee)).toContain("Payroll");
  });

  it("empty query passes every row, including transfers", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const rows = applyQuery(d.transactions, { filters: [], text: "  " }, ctx, {
      scopeAccountId: null,
      searchAll: true,
    });
    expect(rows).toHaveLength(3);
  });

  it("pipeline is stateless: no rejection counts or resetCount", () => {
    // FORK: oracle counts filteredBySearch/filteredByDate and unwinds only
    // the date count in resetCount. The new pipeline keeps no counters;
    // repeating a query is a pure re-evaluation.
    const d = data();
    const ctx = buildSearchCtx(d);
    const q = { filters: [{ kind: "payee" as const, value: "nope" }], text: "" };
    const scope = { scopeAccountId: null, searchAll: true };
    expect(applyQuery(d.transactions, q, ctx, scope)).toEqual(
      applyQuery(d.transactions, q, ctx, scope),
    );
  });

  it("scope facet covers the transfer leg (exclusion analog)", () => {
    const index = buildSearchIndex(data());
    const res = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: 2 },
      { scopeAccountId: null, searchAll: true },
    );
    expect(res.transactions.map((x) => x.payee).sort()).toEqual([
      "Payroll",
      "Transfer : Savings",
    ]);
  });
});

describe("parseSearchString matrix -> searchQuery parser", () => {
  it("blank input yields no key and no filter", () => {
    expect(parseInput("").key).toBeNull();
    expect(filterFromRaw("payee", "   ")).toBeNull();
    expect(parseSearchDate("")).toBeNull();
    expect(parseSearchAmount("")).toBeNull();
  });

  it("account:/memo: supported; check: has no analog (GAP)", () => {
    expect(parseInput("account:Checking").key).toBe("account");
    expect(parseInput("memo:milk").key).toBe("memo");
    // GAP: oracle CheckSearchItem (checkNumber) — Transaction has no
    // checkNumber field, so check: falls through to free text.
    expect(parseInput("check:101").key).toBeNull();
  });

  it("flag: has no per-color analog; only is:flagged / is:duplicate exist (GAP)", () => {
    expect(parseInput("flag:Red").key).toBeNull();
    expect(filterFromRaw("is", "flagged")).toEqual({ kind: "is", value: "flagged" });
    expect(filterFromRaw("is", "duplicate")).toEqual({ kind: "is", value: "duplicate" });
  });

  it("is: sub-switch: supported subset passes, oracle-only values are null", () => {
    for (const v of ["cleared", "uncleared", "flagged", "inflow", "outflow", "transfer", "uncategorized", "new", "duplicate"]) {
      expect(filterFromRaw("is", v)).not.toBeNull();
    }
    // GAPs: approval workflow, error levels, expense kinds, free
    // ClearedStatus names beyond cleared/uncleared.
    for (const v of ["approved", "unapproved", "error", "reminder", "needscategory", "expense", "income or expense", "cleared or reconciled", "unreconciled", "bogus"]) {
      expect(filterFromRaw("is", v)).toBeNull();
    }
  });

  it("amount/date prefixes: comparison and range supported; outflow:/inflow: are not keys (FORK)", () => {
    expect(parseSearchAmount(">50")).toEqual({ kind: "amount", op: ">", a: 50 });
    expect(parseSearchAmount("10..50")).toMatchObject({ kind: "amount", op: "between" });
    expect(parseSearchDate("2026-04")).toMatchObject({ start: "2026-04-01", end: "2026-04-30" });
    // FORK: oracle outflow:>5 / inflow:<5 compare signed amounts against
    // -parsed/parsed; the new grammar folds sign into is:inflow/is:outflow
    // plus an absolute-value amount filter.
    expect(parseInput("outflow:>5").key).toBeNull();
    expect(parseInput("inflow:<5").key).toBeNull();
    // on:/after:/before: single-sided operators have no analog either: only
    // date:/when: are keys, so after: falls through to free text (GAP).
    expect(parseInput("after:2026-04-01").key).toBeNull();
    expect(parseInput("date:2026-04-01").key).toBe("date");
  });

  it("bare text falls back to all-fields free text", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    expect(parseInput("corner store").key).toBeNull();
    expect(matchesText(d.transactions[0]!, textTokens("corner milk"), ctx)).toBe(true);
    expect(matchesText(d.transactions[1]!, textTokens("corner milk"), ctx)).toBe(false);
  });

  it("splits on the first colon only", () => {
    expect(parseInput("memo:a:b")).toEqual({ key: "memo", value: "a:b", raw: "memo:a:b" });
    expect(parseInput("payee:a:b").value).toBe("a:b");
  });

  it("repeated facets AND instead of merging into one OR item (FORK)", () => {
    // Oracle merges repeated flag:/account:/category:/payee: placeholders
    // into a single item (OR across names). The new Query keeps each chip
    // and ANDs them.
    const d = data();
    const ctx = buildSearchCtx(d);
    const rows = applyQuery(
      d.transactions,
      {
        filters: [
          { kind: "payee", value: "corner" },
          { kind: "payee", value: "market" },
        ],
        text: "",
      },
      ctx,
      { scopeAccountId: null, searchAll: true },
    );
    expect(rows).toEqual([]);
  });

  it("decimal comma is a grouping strip, not a decimal point (FORK)", () => {
    // Oracle preProcess rewrites digit-comma-digit to a dot when the decimal
    // separator is ",". parseSearchAmount strips commas as grouping: "1,5"
    // parses as fifteen dollars, not 1.5.
    expect(parseSearchAmount("1,5")).toEqual({ kind: "amount", op: "=", a: 15 });
  });

  it("income: month has no analog (GAP)", () => {
    // Oracle IncomeForSearchItem (income:January 2012 + supplemental/deferred
    // month rule) has no counterpart; income: is free text here.
    expect(parseInput("income:January 2012").key).toBeNull();
    expect(filterFromRaw("payee", "January 2012")).toMatchObject({ kind: "payee" });
  });
});

describe("item semantics -> matchesFilter / matchesText", () => {
  it("amount compares absolute cents; unparsable input never becomes a filter", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const corner = d.transactions[0]!;
    expect(matchesFilter(corner, { kind: "amount", op: "=", a: 25 }, ctx)).toBe(true);
    expect(matchesFilter(corner, { kind: "amount", op: ">", a: 100 }, ctx)).toBe(false);
    expect(matchesFilter(corner, { kind: "amount", op: "between", a: 20, b: 30 }, ctx)).toBe(true);
    // NaN never matches: the parser refuses it, so no such filter exists.
    expect(parseSearchAmount("bogus")).toBeNull();
    // FORK: oracle compares signed amount vs -parsed (outflow) / parsed
    // (inflow); here the amount facet is sign-agnostic (abs) and sign lives
    // in is:inflow / is:outflow.
    expect(matchesFilter(d.transactions[1]!, { kind: "amount", op: "=", a: 3000 }, ctx)).toBe(true);
  });

  it("date matches by inclusive range; bad input yields no filter", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const range = { kind: "date" as const, start: "2026-04-01", end: "2026-04-30", label: "Apr" };
    expect(matchesFilter(d.transactions[0]!, range, ctx)).toBe(true);
    expect(
      matchesFilter(d.transactions[0]!, { kind: "date", start: "2026-05-01", end: "2026-05-31", label: "May" }, ctx),
    ).toBe(false);
    expect(filterFromRaw("date", "not a date")).toBeNull();
    // Oracle on:/after:/before: reject unparseable dates to false; here the
    // equivalent is "no filter produced", so nothing can match on it.
  });

  it("approval workflow is not modeled; is:new tracks needsReview (GAP)", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const fresh = t({ accountId: 1, payee: "Fresh", amount: "-100", date: "2026-04-04", needsReview: true });
    const settled = t({ accountId: 1, payee: "Settled", amount: "-100", date: "2026-04-04" });
    // GAP: oracle ApprovedSearchItem keys off needsAcceptance; Transaction
    // carries needsReview, mapped to is:new instead.
    expect(matchesFilter(fresh, { kind: "is", value: "new" }, ctx)).toBe(true);
    expect(matchesFilter(settled, { kind: "is", value: "new" }, ctx)).toBe(false);
  });

  it("cleared-state tables across transfer legs", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const [corner, payroll, transfer] = d.transactions as [Transaction, Transaction, Transaction];
    // Oracle ClearedSearchItem: strict equality; ClearedAndReconciled: either.
    // New analog: is:cleared = c/r on either leg.
    expect(matchesFilter(corner!, { kind: "is", value: "cleared" }, ctx)).toBe(true);
    expect(matchesFilter(payroll!, { kind: "is", value: "cleared" }, ctx)).toBe(true);
    expect(matchesFilter(payroll!, { kind: "is", value: "uncleared" }, ctx)).toBe(false);
    // Dest-leg cleared counts while the source leg is uncleared.
    expect(matchesFilter(transfer!, { kind: "is", value: "cleared" }, ctx)).toBe(false);
    const clearedDest = t({ accountId: 1, payee: "X", amount: "-100", date: "2026-04-05", status: "u", transferAccountId: 2, transferStatus: "r" });
    expect(matchesFilter(clearedDest, { kind: "is", value: "cleared" }, ctx)).toBe(true);
    expect(matchesFilter(clearedDest, { kind: "is", value: "uncleared" }, ctx)).toBe(false);
    // FORK: oracle Unreconciled = cleared !== Reconciled (includes Cleared);
    // new is:uncleared requires both legs uncleared — strictly narrower.
    expect(matchesFilter(corner!, { kind: "is", value: "uncleared" }, ctx)).toBe(false);
  });

  it("expense/income-or-expense transfer rules have no analog; sign + transfer do (GAP)", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const [corner, payroll, transfer] = d.transactions as [Transaction, Transaction, Transaction];
    // GAP: oracle checks InflowSubCategory identity + on/off-budget sides.
    // New analog: any transferAccountId row is a transfer; sign decides flow.
    expect(matchesFilter(transfer!, { kind: "is", value: "transfer" }, ctx)).toBe(true);
    expect(matchesFilter(corner!, { kind: "is", value: "transfer" }, ctx)).toBe(false);
    expect(matchesFilter(corner!, { kind: "is", value: "outflow" }, ctx)).toBe(true);
    expect(matchesFilter(payroll!, { kind: "is", value: "inflow" }, ctx)).toBe(true);
    expect(matchesFilter(transfer!, { kind: "is", value: "uncategorized" }, ctx)).toBe(false);
    expect(matchesFilter(corner!, { kind: "is", value: "uncategorized" }, ctx)).toBe(false);
  });

  it("flags: only flagged/duplicate exist; no per-color or None (GAP)", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const red = t({ accountId: 1, payee: "Flagged", amount: "-100", date: "2026-04-06", flagColor: "red" });
    const dupe = t({ accountId: 1, payee: "Dupe", amount: "-100", date: "2026-04-06", flagColor: "duplicate" });
    const plain = t({ accountId: 1, payee: "Plain", amount: "-100", date: "2026-04-06" });
    // GAP: oracle FlagSearchItem matches TransactionFlag.None against null
    // flags and each color exactly; there is no flag: key here.
    expect(matchesFilter(red, { kind: "is", value: "flagged" }, ctx)).toBe(true);
    expect(matchesFilter(dupe, { kind: "is", value: "flagged" }, ctx)).toBe(false);
    expect(matchesFilter(plain, { kind: "is", value: "flagged" }, ctx)).toBe(false);
    expect(matchesFilter(dupe, { kind: "is", value: "duplicate" }, ctx)).toBe(true);
    // GAP: oracle CheckSearchItem (checkNumber) has no Transaction field.
  });

  it("accounts/categories/payees: contains (+exact), group nuance, empty is no filter (FORK)", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const corner = d.transactions[0]!;
    expect(matchesFilter(corner, { kind: "account", value: "check" }, ctx)).toBe(true);
    expect(matchesFilter(corner, { kind: "account", value: "Checking", exact: true }, ctx)).toBe(true);
    // FORK: oracle AccountsSearchItem also matches the five AccountType group
    // names ("Budget Accounts", ...); here only the account name matches.
    expect(matchesFilter(corner, { kind: "account", value: "Budget Accounts", exact: true }, ctx)).toBe(false);
    // Category matches the name or its group (master), like oracle partial.
    expect(matchesFilter(corner, { kind: "category", value: "grocer" }, ctx)).toBe(true);
    expect(matchesFilter(corner, { kind: "category", value: "groceries group" }, ctx)).toBe(true);
    expect(matchesFilter(corner, { kind: "payee", value: "corner", exact: false }, ctx)).toBe(true);
    // FORK: oracle empty-selection items match null category/payee rows;
    // here blank values never become filters, and uncategorized needs is:.
    expect(filterFromRaw("category", "  ")).toBeNull();
    expect(filterFromRaw("payee", "")).toBeNull();
    // FORK: oracle empty Accounts criteria never match; here a null facet
    // (absent) matches everything — absence is not a criterion.
    const index = buildSearchIndex(d);
    expect(
      searchBudget(index, { query: "", payee: null, categoryId: null, accountId: null }, { scopeAccountId: null, searchAll: true }).transactions,
    ).toHaveLength(3);
  });

  it("error/adaptive/all-fields/income-for: only new/duplicate + haystack text (GAPs)", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const corner = d.transactions[0]!;
    // GAP: oracle ErrorLevel reminder/error/needscategory consult sub levels
    // with ForReview parent-only; only is:new (needsReview) exists here.
    expect(filterFromRaw("is", "reminder")).toBeNull();
    expect(filterFromRaw("is", "error")).toBeNull();
    // Adaptive/AllFields analog: one haystack over payee/memo/category(+group)
    // /account/amount/date. Lacks checkNumber + outflow/inflow split +
    // targetAccountText (transfers surface as "Transfer : X" payee text).
    expect(matchesText(corner, textTokens("groceries"), ctx)).toBe(true);
    expect(matchesText(corner, textTokens("25.00 2026-04-01"), ctx)).toBe(true);
    expect(matchesText(corner, textTokens("transfer"), ctx)).toBe(false);
    expect(matchesText(d.transactions[2]!, textTokens("transfer"), ctx)).toBe(true);
    // GAP: IncomeFor supplemental/deferred month rule has no analog; month
    // parsing lives in parseSearchDate instead (see next test).
    expect(parseInput("income:april").key).toBeNull();
  });
});

describe("parseIncomeMonthString -> parseSearchDate month handling", () => {
  it("resolves month names, ISO months, and rejects junk", () => {
    const now = new Date(2026, 5, 15);
    expect(parseSearchDate("april 2026", now)).toMatchObject({ start: "2026-04-01", end: "2026-04-30" });
    expect(parseSearchDate("2026-4", now)).toMatchObject({ start: "2026-04-01", end: "2026-04-30" });
    expect(parseSearchDate("bogus month", now)).toBeNull();
    // FORK: oracle parseIncomeMonthString("March") always uses the current
    // year; parseSearchDate maps a *future* bare month to last year.
    expect(parseSearchDate("december", now)).toMatchObject({ start: "2025-12-01" });
    expect(parseSearchDate("january", now)).toMatchObject({ start: "2026-01-01" });
  });
});

describe("registerGrid -> React-adapter N/A", () => {
  it("search pipeline is stateless: no grid singletons or change-only setters", () => {
    // Oracle MRegisterGrid/MRegisterMainGrid/MRegisterScheduledGrid (plain
    // get/set defaults, change-only notify, singleton enforcers) are Flex
    // view models with no counterpart in @ynab/logic: search state is
    // function arguments (facets/scope/query), and the index/ctx builders
    // are pure. Pin the purity contract instead.
    const d = data();
    const first = searchBudget(
      buildSearchIndex(d),
      { query: "corner", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: null, searchAll: true },
    );
    const second = searchBudget(
      buildSearchIndex(d),
      { query: "corner", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: null, searchAll: true },
    );
    expect(second).toEqual(first);
    expect(first.transactions.map((x) => x.payee)).toEqual(["Corner Store"]);
  });
});
