import { describe, expect, it } from "vitest";
import { num } from "../src/format.js";
import { isIncomeTransaction } from "../src/budget-engine.js";
import type { Transaction } from "../src/types.js";

/**
 * Regression: `num()` rejects corrupt money instead of coercing to 0.
 *
 * Pins YNAB4 behaviour (`MonthlySubCategoryBudget.as:202-256`, which throws
 * on corrupt money):
 * - `num("abc")` throws (was: silent 0)
 * - `num(NaN)` throws (was: silent 0)
 * - `isIncomeTransaction` with a NaN amount surfaces the corrupt input
 *   (via `num(t.amount)` at budget-engine.ts:98,108) instead of silently
 *   returning false.
 *
 * Fix commit: a3a050d (g-money-strict).
 */
describe("ynab4 parity: num() rejects corrupt money (YNAB4 throws)", () => {
  it("num('abc') throws (YNAB4 behavior)", () => {
    expect(() => num("abc")).toThrow();
  });

  it("num(NaN) throws (YNAB4 behavior)", () => {
    expect(() => num(NaN)).toThrow();
  });

  it("isIncomeTransaction with NaN amount throws instead of silently returning false", () => {
    const t = {
      id: 1,
      accountId: 1,
      categoryId: null,
      date: "2026-01-01",
      payee: "Employer",
      memo: "",
      amount: NaN,
      status: "c",
    } as unknown as Transaction;
    expect(() => isIncomeTransaction(t)).toThrow();
  });
});
