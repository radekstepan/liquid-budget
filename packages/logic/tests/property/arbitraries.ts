/**
 * Shared fast-check arbitraries for @ynab/logic property tests.
 *
 * Amounts are integer cents inside a range whose small sums stay exact.
 * Transaction rows use string amounts (the stored type); `num()` parses
 * those exactly, so integer maths stays exact end to end.
 */
import * as fc from "fast-check";
import { isTransferPayee } from "../../src/rename-rules.js";
import type { Account, Transaction } from "../../src/types.js";

/** Integer cents comfortably inside the safe-integer range. */
export const centsArb = fc.integer({ min: -50_000_000, max: 50_000_000 });

export const nonZeroCentsArb: fc.Arbitrary<number> = fc
  .tuple(fc.integer({ min: 1, max: 50_000_000 }), fc.boolean())
  .map(([magnitude, negative]) => (negative ? -magnitude : magnitude));

export const idArb = fc.integer({ min: 1, max: 1_000_000 });

export const accountArb: fc.Arbitrary<Account> = fc.record({
  id: idArb,
  name: fc.string({ minLength: 1, maxLength: 24 }),
  kind: fc.constantFrom("liquid", "credit", "offbudget"),
  groupLabel: fc.constant("group"),
  balance: fc.constant("0"),
  onBudget: fc.boolean(),
  sort: fc.constant(0),
});

/** Payee strings matching the `Transfer : <account>` convention (any casing/spacing). */
export const transferPayeeArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("Transfer", "transfer", "TRANSFER", "tRaNsFeR"),
    fc.constantFrom("", " ", "  "),
    fc.constantFrom("", " ", "  "),
    fc.string({ minLength: 0, maxLength: 16 }),
  )
  .map(([prefix, gap1, gap2, name]) => `${prefix}${gap1}:${gap2}${name}`);

/** Payee strings that are NOT transfer payees. */
export const plainPayeeArb: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 40 })
  .filter((s) => !isTransferPayee(s));

/** Minimal valid transaction row with test-friendly defaults. */
export function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    accountId: 1,
    categoryId: null,
    date: "2026-01-15",
    payee: "",
    memo: "",
    amount: "0",
    status: "c",
    parentId: null,
    transferAccountId: null,
    ...overrides,
  };
}

export const transactionArb: fc.Arbitrary<Transaction> = fc
  .record({
    id: idArb,
    accountId: idArb,
    categoryId: fc.option(idArb, { nil: null }),
    date: fc.constant("2026-01-15"),
    payee: fc.string({ maxLength: 30 }),
    memo: fc.constant(""),
    amount: centsArb.map(String),
    status: fc.constant("c"),
    parentId: fc.option(idArb, { nil: null }),
    transferAccountId: fc.option(idArb, { nil: null }),
  })
  .map((row) => tx(row));
