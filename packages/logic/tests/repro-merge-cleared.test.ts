/**
 * REPRO ONLY — merge keeps primary (import) date/cleared instead of
 * YNAB4's user-date + max-cleared rule (not yet fixed; do not promote).
 *
 * Diverges: YNAB4 `match()` takes the merged DATE, category, flag, payee and
 * memo from the USER-entered row and only amount/FITID/YNABID from the bank
 * row; cleared is `max(bank, user)` via `ClearedStatus.compare` (U<C<R).
 * Ours resolves date AND status primary-wins, so a cleared-vs-reconciled
 * merge keeps `c` and the bank posting date instead of `r` + user date.
 *
 * YNAB4: data/TransactionList.as `match()` (merged.date = userTransaction.date;
 *   `ClearedStatus.compare(bank, user)`: -1 → user wins else bank wins) +
 *   com/ynab/enums/ClearedStatus.as (`Uncleared`=0 < `Cleared`=1 < `Reconciled`=2).
 * Ours: packages/logic/src/merge.ts:107-117 (`pickMergePrimary`: imported wins)
 *   + :210 (`date: p.date`) + :215 (`status: p.status`).
 */
import { describe, expect, it } from "vitest";
import {
  pickMergePrimary,
  resolveMergedTransaction,
  type MergeableTransaction,
} from "../src/merge.js";

function tx(overrides: Partial<MergeableTransaction> & { id: number }): MergeableTransaction {
  return {
    accountId: 1,
    transferAccountId: null,
    categoryId: null,
    date: "2026-08-01",
    payee: "Payee",
    payeeId: null,
    memo: "",
    amount: -5000,
    status: "c",
    transferStatus: null,
    flagColor: null,
    needsReview: false,
    entityId: null,
    transferEntityId: null,
    isIncome: false,
    incomeMonth: null,
    ...overrides,
  };
}

const liquid = { onBudget: true, kind: "liquid" };

describe("ynab4 parity: merge keeps max cleared + user-entered date", () => {
  it("merge of c (import) + r (user) resolves to r (YNAB4 max), not c", () => {
    const user = tx({ id: 1, status: "r", date: "2026-08-02" });
    const imported = tx({ id: 2, needsReview: true, status: "c", date: "2026-08-10" });
    const [primary, secondary] = pickMergePrimary(user, imported);
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: liquid, destAccount: null });
    // FAILS today: primary-wins keeps the imported `c`; YNAB4 max(c, r) is `r`.
    expect(merged.status).toBe("r");
  });

  it("merged date is the user-entered date, not the bank posting date", () => {
    const user = tx({ id: 1, status: "c", date: "2026-08-02" });
    const imported = tx({ id: 2, needsReview: true, status: "c", date: "2026-08-10" });
    const [primary, secondary] = pickMergePrimary(user, imported);
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: liquid, destAccount: null });
    // FAILS today: `date: p.date` keeps 2026-08-10; YNAB4 keeps the user date 2026-08-02.
    expect(merged.date).toBe("2026-08-02");
  });
});
