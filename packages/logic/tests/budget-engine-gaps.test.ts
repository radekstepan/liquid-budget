/**
 * budget-engine-gaps.test.ts
 *
 * Focused coverage for budget-engine branches not exercised by the main
 * suite: synthetic CC-group id collision, deserialized-index hydration
 * (epoch stamping + legacy indexes without ending balances), and
 * red-arrow carry inside a CC Payment category.
 */
import { describe, expect, it } from "vitest";
import {
  buildBudgetIndex,
  computeBudget,
  normalizeBudgetData,
} from "../src/budget-engine.js";
import type { BudgetData, Category, CategoryGroup } from "../src/types.js";

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 1,
    groupId: 1,
    name: "Cat",
    sort: 0,
    carryover: "0",
    goalTarget: null,
    linkedAccountId: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<CategoryGroup> = {}): CategoryGroup {
  return {
    id: 1,
    name: "Group",
    sort: 0,
    isCreditCardPayments: false,
    ...overrides,
  };
}

function ccData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "300000", onBudget: true, sort: 0 },
      { id: 2, name: "Visa", kind: "credit", groupLabel: "Credit Cards", balance: "-50000", onBudget: true, sort: 1 },
    ],
    groups: [
      { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
      { id: 2, name: "Credit Card Payments", sort: 1, isCreditCardPayments: true },
    ],
    categories: [
      { id: 1, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 2, groupId: 2, name: "Visa Payment", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: 2 },
    ],
    assignments: [
      { id: 1, categoryId: 1, month: "2025-07", amount: "40000" },
      { id: 2, categoryId: 2, month: "2025-07", amount: "5000" },
    ],
    transactions: [
      { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "300000", status: "c", isIncome: true },
      { id: 2, accountId: 2, categoryId: 1, date: "2025-07-05", payee: "Whole Foods", memo: "", amount: "-12000", status: "c" },
      { id: 3, accountId: 2, categoryId: 1, date: "2025-07-18", payee: "Trader Joe", memo: "", amount: "-8000", status: "c" },
    ],
    recurring: [],
  };
}

function ccRow(result: ReturnType<typeof computeBudget>) {
  return result.groups.flatMap((g) => g.rows).find((r) => r.category.name === "Visa Payment")!;
}

describe("normalizeBudgetData synthetic CC group", () => {
  it("picks a non-colliding id when a group already uses -1", () => {
    const data: BudgetData = {
      accounts: [
        { id: 2, name: "Visa", kind: "credit", groupLabel: "CC", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup({ id: -1, name: "Legacy" })],
      categories: [],
      assignments: [],
      transactions: [],
      recurring: [],
    };
    const norm = normalizeBudgetData(data);
    const synth = norm.groups.find((g) => g.isCreditCardPayments);
    expect(synth).toBeDefined();
    expect(synth!.id).toBe(-2);
    // The synthetic payment category links the unlinked CC account.
    expect(norm.categories.some((c) => c.groupId === synth!.id && c.linkedAccountId === 2)).toBe(true);
  });
});

describe("deserialized index hydration", () => {
  it("hydrates a JSON-round-tripped index (epoch stamping) with identical results", () => {
    const data = ccData();
    const fresh = computeBudget(data, "2025-07");
    const deserialized = JSON.parse(JSON.stringify(buildBudgetIndex(data)));
    const viaIndex = computeBudget({ ...data, budgetIndex: deserialized }, "2025-07");
    expect(viaIndex.tbb).toBe(fresh.tbb);
    expect(ccRow(viaIndex).available).toBe(ccRow(fresh).available);
    expect(ccRow(viaIndex).ccBuffer).toBe(ccRow(fresh).ccBuffer);
  });

  it("recomputes ending balances when a legacy index lacks them", () => {
    const data = ccData();
    // An overspent clamp-to-zero category and a red-arrow category so the
    // fallback walk covers both carry branches for regular categories.
    data.categories.push(
      makeCategory({ id: 10, groupId: 1, name: "Dining", overspendCarriesOver: false }),
      makeCategory({ id: 11, groupId: 1, name: "Fun", overspendCarriesOver: true })
    );
    // A second, healthy CC account so the fallback walk also covers the
    // positive CC Payment branch alongside the overpaid (clamped) one.
    data.accounts.push(
      { id: 3, name: "MC", kind: "credit", groupLabel: "Credit Cards", balance: "0", onBudget: true, sort: 2 }
    );
    data.categories.push(
      makeCategory({ id: 3, groupId: 2, name: "MC Payment", linkedAccountId: 3 })
    );
    data.assignments.push({ id: 3, categoryId: 3, month: "2025-07", amount: "1000" });
    data.transactions.push(
      { id: 10, accountId: 1, categoryId: 10, date: "2025-07-10", payee: "Bistro", memo: "", amount: "-5000", status: "c" },
      { id: 11, accountId: 1, categoryId: 11, date: "2025-07-11", payee: "Cinema", memo: "", amount: "-3000", status: "c" },
      // Overpay the card so the CC Payment category goes negative without
      // red-arrow handling (covers the fallback walk's CC clamp branch).
      { id: 12, accountId: 1, categoryId: null, transferAccountId: 2, date: "2025-07-20", payee: "Transfer : Visa", memo: "", amount: "-30000", status: "c" }
    );
    const fresh = computeBudget(data, "2025-07");
    const legacy = JSON.parse(JSON.stringify(buildBudgetIndex(data)));
    delete legacy.endingBalanceByMonth;
    const viaLegacy = computeBudget({ ...data, budgetIndex: legacy }, "2025-07");
    expect(viaLegacy.tbb).toBe(fresh.tbb);
    expect(viaLegacy.overspentPrevious).toBe(fresh.overspentPrevious);
    const avail = (r: ReturnType<typeof computeBudget>) =>
      r.groups.flatMap((g) => g.rows).map((row) => [row.category.name, row.available] as const);
    expect(avail(viaLegacy)).toEqual(avail(fresh));
  });
});

describe("CC Payment category red-arrow carry", () => {
  it("carries a negative CC Payment balance forward instead of deducting TBB", () => {
    const data = ccData();
    data.categories = data.categories.map((c) =>
      c.id === 2 ? { ...c, overspendCarriesOver: true } : c
    );
    // Overpay the card: buffer 20000 - payment 30000 = -10000, so available
    // goes 5000 assigned - 10000 = -5000.
    data.transactions.push({
      id: 4,
      accountId: 1,
      categoryId: null,
      transferAccountId: 2,
      date: "2025-07-20",
      payee: "Transfer : Visa",
      memo: "overpay",
      amount: "-30000",
      status: "c",
    });
    const july = computeBudget(data, "2025-07");
    expect(ccRow(july).available).toBe(-5000);
    const august = computeBudget(data, "2025-08");
    expect(ccRow(august).carryoverIn).toBe(-5000);
    expect(august.overspentPrevious).toBe(0);
  });
});
