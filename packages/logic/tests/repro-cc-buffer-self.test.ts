/**
 * REPRO ONLY — overspend inside the CC Payment category itself (not yet
 * fixed; do not promote).
 *
 * Diverges: the second (CC) pass of the budget walk carries a negative
 * CC-payment available forward silently — it never feeds the cash-overspend
 * machine, so spending over the CC-payment available neither deducts from
 * TBB nor clamps to zero like a regular category would. YNAB4 has no buffer
 * machine: a CC-payment category overspend behaves like any category
 * overspend (deficit deducted from TBB / clamped next month).
 *
 * Ours: packages/logic/src/budget-engine.ts:969-991 (second pass:
 *   `next = prev + assigned + rawFlow + ccBuffer`, no overspend accounting)
 *   vs :778-967 (first pass: negative `endAvailable` → 0 + `monthCashOverspent`
 *   TBB deduction). Month view: :1231-1234 (CC available can go negative).
 */
import { describe, expect, it } from "vitest";
import { computeBudget } from "../src/budget-engine.js";
import type { BudgetData } from "../src/types.js";

function dataWithCCSelfOverspend(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      { id: 2, name: "Visa", kind: "credit", groupLabel: "Credit Cards", balance: "0", onBudget: true, sort: 1 },
    ],
    groups: [
      { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
      { id: 2, name: "Credit Card Payments", sort: 1, isCreditCardPayments: true },
    ],
    categories: [
      { id: 1, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 2, groupId: 2, name: "Visa Payment", sort: 0, carryover: "10000", goalTarget: null, linkedAccountId: 2 },
    ],
    assignments: [],
    transactions: [
      { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Payroll", memo: "", amount: "500000", status: "c", isIncome: true },
      // Interest fee booked straight to the CC Payment category, over its 10000 available.
      { id: 2, accountId: 2, categoryId: 2, date: "2026-01-15", payee: "Interest", memo: "", amount: "-15000", status: "c" },
    ],
    recurring: [],
  };
}

describe("ynab4-style: overspend inside the CC Payment category hits TBB", () => {
  it("5000 over the CC-payment available deducts from TBB like a regular category", () => {
    // Engine semantics (pinned by budget-engine.test.ts "cash overspending
    // reduces TBB but not available in next month"): same-month overspend
    // leaves same-month TBB untouched; the deficit lands in next month's
    // TBB via runningSurplus. Regular categories behave identically —
    // verified REG JAN tbb 500000 / REG FEB tbb 495000 for the same shape.
    const jan = computeBudget(dataWithCCSelfOverspend(), "2026-01");
    expect(jan.groups.find((g) => g.group.isCreditCardPayments)!.rows[0]!.available).toBe(-5000);
    const feb = computeBudget(dataWithCCSelfOverspend(), "2026-02");
    expect(feb.tbb).toBe(495000);
  });

  it("negative CC-payment available clamps to 0 next month instead of carrying", () => {
    const feb = computeBudget(dataWithCCSelfOverspend(), "2026-02");
    const ccRow = feb.groups.find((g) => g.group.isCreditCardPayments)!.rows[0]!;
    // FAILS today: -5000 carries into February silently.
    expect(ccRow.carryoverIn).toBe(0);
  });
});
