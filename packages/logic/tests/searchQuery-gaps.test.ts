/**
 * searchQuery-gaps.test.ts
 *
 * Focused coverage for search helpers: amount labels, date presets/parsing,
 * filter labels, query serialization round-trips, remaining match operators,
 * text/scope matching, and id resolvers.
 */
import { describe, expect, it } from "vitest";
import {
  accountSublabel,
  amountLabel,
  applyQuery,
  buildSearchCtx,
  buildSuggestions,
  datePresets,
  deserializeQuery,
  filterFromRaw,
  filterId,
  filterLabel,
  inScope,
  matchesFilter,
  matchesText,
  parseSearchDate,
  resolveAccountId,
  resolveCategoryId,
  serializeQuery,
  textTokens,
} from "../src/searchQuery.js";
import type { BudgetData, Transaction } from "../src/types.js";

let _id = 0;
const nextId = () => ++_id;

const t = (
  o: Partial<Transaction> & { accountId: number; amount: string; date: string }
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
      { id: 2, name: "Visa", kind: "credit", groupLabel: "Credit", balance: "0", onBudget: true, sort: 1 },
    ],
    groups: [{ id: 10, name: "Food", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 100, groupId: 10, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      t({ accountId: 1, categoryId: 100, payee: "Whole Foods", memo: "weekly shop", amount: "-5000", date: "2026-09-01" }),
      t({ accountId: 2, categoryId: null, payee: "Payroll", memo: "", amount: "100000", date: "2026-09-02", status: "u" }),
      t({ accountId: 1, categoryId: null, payee: "Transfer : Visa", memo: "", amount: "-50000", date: "2026-09-03", status: "u", transferAccountId: 2, transferStatus: "c" }),
    ],
    recurring: [],
  };
}

// June 15, 2026 in local time (date helpers are locale-based).
const NOW = new Date(2026, 5, 15);

describe("amountLabel", () => {
  it("formats between, exact, and comparison operators", () => {
    expect(amountLabel({ kind: "amount", op: "between", a: 10, b: 50 })).toBe("$10.00 – $50.00");
    expect(amountLabel({ kind: "amount", op: "=", a: 50 })).toBe("$50.00");
    expect(amountLabel({ kind: "amount", op: ">", a: 50 })).toBe("> $50.00");
    expect(amountLabel({ kind: "amount", op: "<=", a: 12.5 })).toBe("<= $12.50");
  });
});

describe("datePresets / parseSearchDate", () => {
  it("builds calendar presets around now", () => {
    const presets = datePresets(NOW);
    expect(presets.map((p) => p.id)).toEqual([
      "today", "yesterday", "this-week", "last-7", "this-month",
      "last-month", "last-30", "last-90", "this-year", "last-year",
    ]);
    const byId = new Map(presets.map((p) => [p.id, p.range]));
    expect(byId.get("today")).toEqual({ start: "2026-06-15", end: "2026-06-15", label: "Today" });
    expect(byId.get("this-month")).toEqual({ start: "2026-06-01", end: "2026-06-30", label: "This month" });
    expect(byId.get("last-month")).toEqual({ start: "2026-05-01", end: "2026-05-31", label: "Last month" });
  });

  it("resolves preset names, years, months, dates, and month names", () => {
    expect(parseSearchDate("this month", NOW)).toEqual({
      start: "2026-06-01", end: "2026-06-30", label: "This month",
    });
    expect(parseSearchDate("2026", NOW)).toEqual({ start: "2026-01-01", end: "2026-12-31", label: "2026" });
    expect(parseSearchDate("2026-3", NOW)).toEqual({ start: "2026-03-01", end: "2026-03-31", label: "Mar 2026" });
    expect(parseSearchDate("2026-03-05", NOW)).toEqual({
      start: "2026-03-05", end: "2026-03-05", label: "Mar 5, 2026",
    });
    expect(parseSearchDate("march 2026", NOW)).toEqual({
      start: "2026-03-01", end: "2026-03-31", label: "Mar 2026",
    });
    // Bare future month name resolves to last year.
    expect(parseSearchDate("december", NOW)).toEqual({
      start: "2025-12-01", end: "2025-12-31", label: "Dec 2025",
    });
  });

  it("rejects blank, unknown, and out-of-range input", () => {
    expect(parseSearchDate("", NOW)).toBeNull();
    expect(parseSearchDate("someday", NOW)).toBeNull();
    expect(parseSearchDate("2030-13", NOW)).toBeNull();
  });
});

describe("filterFromRaw / filterLabel / filterId", () => {
  it("builds date and status filters, rejecting blanks and unknowns", () => {
    expect(filterFromRaw("date", "2026-03")).toMatchObject({ kind: "date", start: "2026-03-01" });
    expect(filterFromRaw("date", "nonsense")).toBeNull();
    expect(filterFromRaw("is", "cleared")).toEqual({ kind: "is", value: "cleared" });
    expect(filterFromRaw("is", "Cleared")).toEqual({ kind: "is", value: "cleared" });
    expect(filterFromRaw("is", "bogus")).toBeNull();
    expect(filterFromRaw("payee", "   ")).toBeNull();
  });

  it("labels every filter kind", () => {
    expect(filterLabel({ kind: "payee", value: "whole" })).toEqual({ key: "Payee", value: "whole" });
    expect(filterLabel({ kind: "category", value: "food" })).toEqual({ key: "Category", value: "food" });
    expect(filterLabel({ kind: "account", value: "checking" })).toEqual({ key: "Account", value: "checking" });
    expect(filterLabel({ kind: "memo", value: "weekly" })).toEqual({ key: "Memo", value: "“weekly”" });
    expect(filterLabel({ kind: "amount", op: ">", a: 50 })).toEqual({ key: "Amount", value: "> $50.00" });
    expect(filterLabel({ kind: "date", start: "2026-03-01", end: "2026-03-31", label: "Mar 2026" })).toEqual({
      key: "Date", value: "Mar 2026",
    });
    expect(filterLabel({ kind: "is", value: "cleared" })).toEqual({ key: "Is", value: "Cleared" });
  });

  it("identifies filters by JSON", () => {
    expect(filterId({ kind: "payee", value: "x" })).toBe(JSON.stringify({ kind: "payee", value: "x" }));
  });
});

describe("serializeQuery / deserializeQuery", () => {
  it("round-trips filters and text through serialization", () => {
    const q = {
      filters: [
        { kind: "payee" as const, value: "whole foods" },
        { kind: "amount" as const, op: ">" as const, a: 50 },
        { kind: "is" as const, value: "cleared" as const },
      ],
      text: "rent",
    };
    const s = serializeQuery(q);
    expect(s).toBe('payee:"whole foods" amount:"> $50.00" is:Cleared rent');
    expect(deserializeQuery(s)).toEqual(q);
  });

  it("understands key aliases and memo quote stripping", () => {
    const q = deserializeQuery("cat:groceries acct:checking amt:>50 when:2026-03 note:hello status:cleared");
    expect(q.filters.map((f) => f.kind)).toEqual(["category", "account", "amount", "date", "memo", "is"]);
    expect(q.filters[2]).toEqual({ kind: "amount", op: ">", a: 50 });
    expect(q.filters[4]).toEqual({ kind: "memo", value: "hello" });
    const memo = deserializeQuery('memo:"“weekly shop”"');
    expect(memo.filters).toEqual([{ kind: "memo", value: "weekly shop" }]);
  });

  it("keeps unknown key:value tokens and gaps as text", () => {
    const q = deserializeQuery("foo:bar baz");
    expect(q.filters).toEqual([]);
    expect(q.text).toContain("foo:bar");
    expect(q.text).toContain("baz");
    expect(deserializeQuery("  ").text).toBe("");
  });
});

describe("matchesFilter remaining operators", () => {
  it("compares <, >=, <=, and between amounts", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const whole = d.transactions[0]!;
    expect(matchesFilter(whole, { kind: "amount", op: "<", a: 100 }, ctx)).toBe(true);
    expect(matchesFilter(whole, { kind: "amount", op: "<", a: 50 }, ctx)).toBe(false);
    expect(matchesFilter(whole, { kind: "amount", op: ">=", a: 50 }, ctx)).toBe(true);
    expect(matchesFilter(whole, { kind: "amount", op: "<=", a: 50 }, ctx)).toBe(true);
    expect(matchesFilter(whole, { kind: "amount", op: "between", a: 10, b: 50 }, ctx)).toBe(true);
    expect(matchesFilter(whole, { kind: "amount", op: "between", a: 60, b: 100 }, ctx)).toBe(false);
  });

  it("matches cleared/uncleared across transfer legs and flows by sign", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const [whole, payroll, transfer] = d.transactions;
    // Source-leg cleared.
    expect(matchesFilter(whole!, { kind: "is", value: "cleared" }, ctx)).toBe(true);
    // Dest-leg cleared counts even when the source leg is uncleared.
    expect(matchesFilter(transfer!, { kind: "is", value: "cleared" }, ctx)).toBe(true);
    expect(matchesFilter(payroll!, { kind: "is", value: "cleared" }, ctx)).toBe(false);
    // Uncleared requires both legs uncleared (legacy null dest falls back to source).
    expect(matchesFilter(payroll!, { kind: "is", value: "uncleared" }, ctx)).toBe(true);
    expect(matchesFilter(transfer!, { kind: "is", value: "uncleared" }, ctx)).toBe(false);
    expect(matchesFilter(payroll!, { kind: "is", value: "inflow" }, ctx)).toBe(true);
    expect(matchesFilter(whole!, { kind: "is", value: "inflow" }, ctx)).toBe(false);
    expect(matchesFilter(whole!, { kind: "is", value: "outflow" }, ctx)).toBe(true);
    expect(matchesFilter(payroll!, { kind: "is", value: "outflow" }, ctx)).toBe(false);
  });
});

describe("textTokens / matchesText / inScope", () => {
  it("tokenizes and requires every token", () => {
    expect(textTokens("  Whole  Foods ")).toEqual(["whole", "foods"]);
    const d = data();
    const ctx = buildSearchCtx(d);
    const whole = d.transactions[0]!;
    expect(matchesText(whole, [], ctx)).toBe(true);
    expect(matchesText(whole, ["whole", "shop"], ctx)).toBe(true);
    expect(matchesText(whole, ["whole", "rent"], ctx)).toBe(false);
  });

  it("scopes by facet, account, or everything", () => {
    const d = data();
    const transfer = d.transactions[2]!;
    // Facet matches either leg.
    expect(inScope(transfer, null, true, 2)).toBe(true);
    expect(inScope(transfer, null, true, 999)).toBe(false);
    // Scoped account matches either leg when not searching all.
    expect(inScope(transfer, 2, false, null)).toBe(true);
    expect(inScope(transfer, 999, false, null)).toBe(false);
    expect(inScope(transfer, 2, true, null)).toBe(true);
    expect(inScope(transfer, null, true, null)).toBe(true);
  });

  it("applyQuery honors the account facet", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const rows = applyQuery(d.transactions, { filters: [], text: "" }, ctx, { accountId: 2 });
    expect(rows.map((r) => r.payee).sort()).toEqual(["Payroll", "Transfer : Visa"]);
  });
});

describe("buildSuggestions", () => {
  const suggest = (input: string, opts?: { filters?: Parameters<typeof buildSuggestions>[0]["filters"]; recents?: Parameters<typeof buildSuggestions>[0]["recents"] }) => {
    const d = data();
    return buildSuggestions({
      input,
      filters: opts?.filters ?? [],
      data: d,
      ctx: buildSearchCtx(d),
      recents: opts?.recents ?? [],
      now: NOW,
    });
  };
  const group = (groups: ReturnType<typeof suggest>, id: string) => groups.find((g) => g.id === id);
  const labels = (groups: ReturnType<typeof suggest>, id: string) =>
    (group(groups, id)?.items ?? []).map((i) => ("label" in i ? i.label : ""));

  it("offers keys, quick filters, and recents on empty input", () => {
    const groups = suggest("", {
      recents: [{ filters: [{ kind: "is", value: "uncleared" }], text: "" }],
    });
    expect(group(groups, "recent")?.items).toHaveLength(1);
    expect(labels(groups, "recent")).toEqual(["is:Uncleared"]);
    expect(group(groups, "keys")?.items).toHaveLength(7);
    expect(labels(groups, "quick")).toEqual(["Uncleared", "This month", "Flagged", "Over $100"]);
    expect(group(groups, "txs")).toBeUndefined();
  });

  it("previews matching transactions when chips are committed but input is empty", () => {
    const groups = suggest("", { filters: [{ kind: "payee", value: "whole" }] });
    const txs = group(groups, "txs");
    expect(txs?.title).toBe("Matching transactions");
    expect(txs?.items).toHaveLength(1);
  });

  it("suggests exact and contains payee matches in key context", () => {
    const groups = suggest("payee:whol");
    const ctx = group(groups, "ctx");
    expect(ctx?.title).toBe("Payee");
    expect(labels(groups, "ctx")).toContain("Whole Foods");
    expect(labels(groups, "ctx")).toContain("Payee contains “whol”");
  });

  it("suggests categories, accounts (by name or group), and statuses in key context", () => {
    expect(labels(suggest("cat:gro"), "ctx")).toContain("Groceries");
    expect(labels(suggest("acct:cash"), "ctx")).toContain("Checking");
    expect(labels(suggest("is:clear"), "ctx")).toContain("Cleared");
  });

  it("suggests custom amounts or presets with help in key context", () => {
    const custom = suggest("amt:>50");
    expect(labels(custom, "ctx")).toEqual(["> $50.00"]);
    const presets = suggest("amt:bogus");
    expect(labels(presets, "ctx")).toContain("> $100.00");
    expect(labels(presets, "ctx")).toContain("Try  >50   <20   =12.99   10..50");
  });

  it("suggests custom dates or help in key context", () => {
    const custom = suggest("when:2026-03");
    expect(labels(custom, "ctx")).toContain("Mar 2026");
    expect(labels(suggest("when:zzz"), "ctx")).toEqual([
      "Try  this month · last 30 days · march · 2025-03 · 2025-03-14",
    ]);
  });

  it("suggests memo contains plus frequent words in key context", () => {
    const groups = suggest("note:week");
    expect(labels(groups, "ctx")).toContain("Memo contains “week”");
    expect(labels(groups, "ctx")).toContain("weekly");
  });

  it("shows a no-matches hint when every candidate is already committed", () => {
    const groups = suggest("payee:whole foods", {
      filters: [{ kind: "payee", value: "Whole Foods", exact: true }],
    });
    expect(labels(groups, "ctx")).toEqual(['No payee matches “whole foods”']);
  });

  it("searches text, amounts, and statuses on free text", () => {
    const text = suggest("whole");
    expect(group(text, "text")?.items[0]).toMatchObject({ type: "text", count: 1 });
    expect(labels(text, "payees")).toContain("Whole Foods");
    // Key names complete from their own prefix.
    expect(labels(suggest("pa"), "keys")).toContain("Payee");

    const amt = suggest("50");
    expect(labels(amt, "amount")).toEqual(["$50.00", "≈ $50.00"]);

    const status = suggest("cleared");
    expect(labels(status, "status")).toContain("Cleared");
    // Committed filters are excluded from suggestion groups.
    const deduped = suggest("cleared", { filters: [{ kind: "is", value: "cleared" }] });
    expect(group(deduped, "status")).toBeUndefined();
  });

  it("covers >= and <= amount hints, uncategorized, and matched date presets", () => {
    expect(labels(suggest("amt:>=50"), "ctx")).toEqual([">= $50.00"]);
    expect(labels(suggest("amt:<=50"), "ctx")).toEqual(["<= $50.00"]);
    expect(labels(suggest("cat:uncat"), "ctx")).toEqual(["Uncategorized"]);
    expect(labels(suggest("when:this month"), "ctx")).toEqual(["This month"]);
  });

  it("guesses dates, categories, and accounts from free text", () => {
    expect(labels(suggest("2026-03"), "date")).toEqual(["Mar 2026"]);
    expect(labels(suggest("groceries"), "cats")).toEqual(["Groceries"]);
    expect(labels(suggest("visa"), "accts")).toEqual(["Visa"]);
  });

  it("scopes suggestions to an exact committed account filter", () => {
    expect(labels(suggest("whole"), "payees")).toContain("Whole Foods");
    const scoped = suggest("whole", {
      filters: [{ kind: "account", value: "Visa", exact: true }],
    });
    expect(labels(scoped, "payees")).not.toContain("Whole Foods");
  });
});

describe("accountSublabel / resolvers", () => {
  it("labels accounts by group or kind", () => {
    const d = data();
    expect(accountSublabel(d.accounts[0]!)).toBe("Cash");
    expect(accountSublabel({ ...d.accounts[1]!, groupLabel: "" })).toBe("Credit card");
    expect(
      accountSublabel({ id: 9, name: "Fund", kind: "offbudget", groupLabel: "", balance: "0", onBudget: false, sort: 0 })
    ).toBe("Off budget");
    expect(
      accountSublabel({ id: 9, name: "Cash", kind: "liquid", groupLabel: "", balance: "0", onBudget: true, sort: 0 })
    ).toBe("Account");
  });

  it("resolves exact account/category names case-insensitively", () => {
    const d = data();
    expect(resolveAccountId(d, "checking")).toBe(1);
    expect(resolveAccountId(d, "Missing")).toBeNull();
    expect(resolveCategoryId(d, "GROCERIES")).toBe(100);
    // Group names have no single category.
    expect(resolveCategoryId(d, "Food")).toBeNull();
    expect(resolveCategoryId(d, "Missing")).toBeNull();
  });
});
