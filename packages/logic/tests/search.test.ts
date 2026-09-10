import { describe, expect, it } from "vitest";
import { buildSearchIndex, searchBudget } from "../src/search.js";
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
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 1 },
    ],
    groups: [{ id: 10, name: "Food", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 100, groupId: 10, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 101, groupId: 10, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      t({ accountId: 1, categoryId: 100, payee: "Whole Foods", memo: "weekly shop", amount: "-5000", date: "2026-09-01" }),
      t({ accountId: 2, categoryId: 101, payee: "Landlord", memo: "september", amount: "-100000", date: "2026-09-02" }),
      t({ accountId: 1, categoryId: 100, payee: "Whole Foods Market", memo: "", amount: "-2000", date: "2026-09-03" }),
    ],
    recurring: [],
  };
}

describe("searchBudget", () => {
  it("matches free text against payee and ranks exact before substring", () => {
    const index = buildSearchIndex(data());
    const res = searchBudget(
      index,
      { query: "whole", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: null, searchAll: true }
    );
    expect(res.transactions.map((x) => x.payee)).toEqual(["Whole Foods Market", "Whole Foods"]);
    expect(res.payees.map((p) => p.name)).toContain("Whole Foods");
  });

  it("scopes to the selected account by default and expands with searchAll", () => {
    const index = buildSearchIndex(data());
    const scoped = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: 1, searchAll: false }
    );
    expect(scoped.transactions.every((x) => x.accountId === 1)).toBe(true);
    const all = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: 1, searchAll: true }
    );
    expect(all.transactions.length).toBe(3);
  });

  it("ANDs structured payee and category facets", () => {
    const index = buildSearchIndex(data());
    const res = searchBudget(
      index,
      { query: "", payee: "Whole Foods", categoryId: 100, accountId: null },
      { scopeAccountId: null, searchAll: true }
    );
    expect(res.transactions.map((x) => x.payee)).toEqual(["Whole Foods"]);
  });

  it("scopes payee suggestions to the selected account", () => {
    const index = buildSearchIndex(data());
    const scoped = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: 1, searchAll: false }
    );
    expect(scoped.payees.map((p) => p.name).sort()).toEqual(["Whole Foods", "Whole Foods Market"]);
    const all = searchBudget(
      index,
      { query: "", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: 1, searchAll: true }
    );
    expect(all.payees.map((p) => p.name)).toContain("Landlord");
  });

  it("filters categories by name and returns payee hits", () => {
    const index = buildSearchIndex(data());
    const res = searchBudget(
      index,
      { query: "gro", payee: null, categoryId: null, accountId: null },
      { scopeAccountId: null, searchAll: true }
    );
    expect(res.categories.map((c) => c.name)).toContain("Groceries");
  });
});
