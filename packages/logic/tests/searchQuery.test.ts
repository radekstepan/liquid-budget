import { describe, expect, it } from "vitest";
import {
  applyQuery,
  buildSearchCtx,
  buildSuggestions,
  filterFromRaw,
  matchesFilter,
  parseInput,
  parseSearchAmount,
  parseSearchDate,
  serializeQuery,
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
      { id: 101, groupId: 10, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      t({ accountId: 1, categoryId: 100, payee: "Whole Foods", memo: "weekly shop", amount: "-5000", date: "2026-09-01" }),
      t({ accountId: 2, categoryId: 101, payee: "Landlord", memo: "september rent", amount: "-100000", date: "2026-08-01", status: "u" }),
      t({ accountId: 1, categoryId: 100, payee: "Whole Foods Market", memo: "", amount: "-2000", date: "2026-09-03", flagColor: "red" }),
      t({ accountId: 1, categoryId: null, payee: "Transfer : Visa", memo: "", amount: "-50000", date: "2026-09-02", transferAccountId: 2 }),
    ],
    recurring: [],
  };
}

describe("searchQuery parsing", () => {
  it("parses key:value input and amount shorthand", () => {
    expect(parseInput("payee:whole")).toEqual({ key: "payee", value: "whole", raw: "payee:whole" });
    expect(parseInput("cat:groceries").key).toBe("category");
    expect(parseInput(">50").key).toBe("amount");
    expect(parseInput("whole foods").key).toBeNull();
  });

  it("parses amounts including ranges", () => {
    expect(parseSearchAmount(">50")).toEqual({ kind: "amount", op: ">", a: 50 });
    expect(parseSearchAmount("10..50")).toEqual({ kind: "amount", op: "between", a: 10, b: 50 });
    expect(parseSearchAmount("=12.99")).toEqual({ kind: "amount", op: "=", a: 12.99 });
    expect(parseSearchAmount("blah")).toBeNull();
  });

  it("parses dates including presets and ISO months", () => {
    expect(parseSearchDate("2026-09")).toMatchObject({ start: "2026-09-01", end: "2026-09-30" });
    expect(parseSearchDate("2026")).toMatchObject({ start: "2026-01-01", end: "2026-12-31" });
    expect(parseSearchDate("this month", new Date("2026-09-09"))).toMatchObject({
      start: "2026-09-01",
      end: "2026-09-30",
    });
    expect(parseSearchDate("blah-blah")).toBeNull();
  });

  it("builds filters from raw key/value", () => {
    expect(filterFromRaw("payee", "whole")).toEqual({ kind: "payee", value: "whole" });
    expect(filterFromRaw("is", "flagged")).toEqual({ kind: "is", value: "flagged" });
    expect(filterFromRaw("is", "new")).toEqual({ kind: "is", value: "new" });
    expect(filterFromRaw("is", "duplicate")).toEqual({ kind: "is", value: "duplicate" });
    expect(filterFromRaw("is", "nope")).toBeNull();
  });
});

describe("searchQuery matching (cents, numeric ids, flags)", () => {
  it("matches payee/category/account/memo/amount/date/is filters", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const [whole, landlord] = d.transactions;
    expect(matchesFilter(whole!, { kind: "payee", value: "whole" }, ctx)).toBe(true);
    expect(matchesFilter(landlord!, { kind: "payee", value: "whole" }, ctx)).toBe(false);
    expect(matchesFilter(whole!, { kind: "category", value: "groceries", exact: true }, ctx)).toBe(true);
    expect(matchesFilter(whole!, { kind: "account", value: "checking", exact: true }, ctx)).toBe(true);
    expect(matchesFilter(whole!, { kind: "memo", value: "weekly" }, ctx)).toBe(true);
    // Amounts compare in cents: $50.00 == 5000c
    expect(matchesFilter(whole!, { kind: "amount", op: "=", a: 50 }, ctx)).toBe(true);
    expect(matchesFilter(whole!, { kind: "amount", op: ">", a: 100 }, ctx)).toBe(false);
    expect(matchesFilter(landlord!, { kind: "amount", op: ">", a: 100 }, ctx)).toBe(true);
    expect(
      matchesFilter(whole!, { kind: "date", start: "2026-09-01", end: "2026-09-30", label: "Sep" }, ctx)
    ).toBe(true);
    expect(matchesFilter(landlord!, { kind: "is", value: "uncleared" }, ctx)).toBe(true);
    expect(matchesFilter(whole!, { kind: "is", value: "flagged" }, ctx)).toBe(false);
    expect(matchesFilter(d.transactions[2]!, { kind: "is", value: "flagged" }, ctx)).toBe(true);
    expect(matchesFilter(d.transactions[3]!, { kind: "is", value: "transfer" }, ctx)).toBe(true);
    expect(matchesFilter(d.transactions[3]!, { kind: "is", value: "uncategorized" }, ctx)).toBe(false);
  });

  it("matches is:new on unreviewed rows and is:duplicate on the duplicate marker", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const fresh = t({ accountId: 1, payee: "Fresh Import", amount: "-100", date: "2026-09-05", needsReview: true });
    const reviewed = t({ accountId: 1, payee: "Old Row", amount: "-100", date: "2026-09-05" });
    const dupe = t({ accountId: 1, payee: "Fresh Import", amount: "-100", date: "2026-09-05", flagColor: "duplicate" });
    const flagged = t({ accountId: 1, payee: "Flagged Row", amount: "-100", date: "2026-09-05", flagColor: "red" });
    expect(matchesFilter(fresh, { kind: "is", value: "new" }, ctx)).toBe(true);
    expect(matchesFilter(reviewed, { kind: "is", value: "new" }, ctx)).toBe(false);
    expect(matchesFilter(dupe, { kind: "is", value: "new" }, ctx)).toBe(false);
    expect(matchesFilter(dupe, { kind: "is", value: "duplicate" }, ctx)).toBe(true);
    expect(matchesFilter(flagged, { kind: "is", value: "duplicate" }, ctx)).toBe(false);
    expect(matchesFilter(reviewed, { kind: "is", value: "duplicate" }, ctx)).toBe(false);
    // The duplicate marker is not a user flag: is:flagged still excludes it.
    expect(matchesFilter(dupe, { kind: "is", value: "flagged" }, ctx)).toBe(false);
  });

  it("applies combined query with scope", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const rows = applyQuery(
      d.transactions,
      { filters: [{ kind: "payee", value: "whole foods", exact: true }], text: "" },
      ctx,
      { scopeAccountId: null, searchAll: true }
    );
    expect(rows.map((r) => r.payee)).toEqual(["Whole Foods"]);
    const scoped = applyQuery(d.transactions, { filters: [], text: "" }, ctx, {
      scopeAccountId: 2,
      searchAll: false,
    });
    // Transfer row links account 2 via transferAccountId, so it stays in scope.
    expect(scoped.map((r) => r.payee).sort()).toEqual(["Landlord", "Transfer : Visa"]);
  });
});

describe("searchQuery suggestions", () => {
  it("offers filter keys on empty input and contextual values for payee:", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const empty = buildSuggestions({ input: "", filters: [], data: d, ctx, recents: [] });
    expect(empty.map((g) => g.id)).toEqual(expect.arrayContaining(["keys", "quick"]));
    const payeeCtx = buildSuggestions({ input: "payee:whole", filters: [], data: d, ctx, recents: [] });
    expect(payeeCtx[0]!.title).toBe("Payee");
    expect(payeeCtx[0]!.items.some((i) => i.type === "filter" && i.label === "Whole Foods")).toBe(true);
  });

  it("lists matching transactions when only chips are set (no text)", () => {
    const d = data();
    const ctx = buildSearchCtx(d);
    const withChip = buildSuggestions({
      input: "",
      filters: [{ kind: "payee", value: "whole", exact: false }],
      data: d,
      ctx,
      recents: [],
    });
    const txs = withChip.find((g) => g.id === "txs");
    expect(txs?.title).toBe("Matching transactions");
    expect(txs!.items.length).toBeGreaterThan(0);
    expect(txs!.items.every((i) => i.type === "tx")).toBe(true);

    const bare = buildSuggestions({ input: "", filters: [], data: d, ctx, recents: [] });
    expect(bare.find((g) => g.id === "txs")).toBeUndefined();
  });

  it("round-trips serialize/deserialize through suggestions recents", () => {
    const q = { filters: [{ kind: "payee" as const, value: "Whole Foods", exact: true }], text: "" };
    const s = serializeQuery(q);
    expect(s).toBe('payee:"Whole Foods"');
    const withRecent = buildSuggestions({
      input: "",
      filters: [],
      data: data(),
      ctx: buildSearchCtx(data()),
      recents: [q],
    });
    expect(withRecent.find((g) => g.id === "recent")?.items).toHaveLength(1);
  });
});
