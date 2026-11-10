/**
 * Oracle B3: AccountBalanceCalculator balances, mapped through this repo.
 *
 * Oracle (read-only, never edited):
 * - ../ynab4-modern/packages/domain/src/AccountBalanceCalculator.test.ts
 *   (9 tests, lines 95-247)
 * - impl: .../domain/src/AccountBalanceCalculator.ts
 *   (static lines 117-153; ctor 108-115; suspend/resume 169-199;
 *   add/remove 270-296/235-268; UPDATE 298-395; running 408-437;
 *   through-date 452-466)
 *
 * Targets in this repo: packages/logic/src/reconcile.ts
 * (computeReconcileState) + packages/logic/src/register.ts
 * (computeRunningBalances). Server mirror:
 * packages/server/src/queries/reconcile.ts (getReconcileState SQL).
 *
 * // FORK — workingBalance naming (prominent, tested below):
 * this repo `workingBalance` = cleared + reconciled ONLY (uncleared
 * excluded) — the statement comparator, i.e. the YNAB4 `clearedBalance`
 * analog (reconcile.ts:8-16). The oracle `workingBalance` = cleared +
 * uncleared RAW sum where cleared already includes reconciled
 * (impl lines 146-152; test line 106-111: 150 + 25 = 175). This repo's
 * oracle-working analog is `workingBalance + unclearedTotal`. The stored
 * `accounts.balance` (every non-parent row regardless of status) is this
 * repo's YNAB4-`workingBalance` analog. Both semantics are asserted.
 *
 * // FORK — unknown cleared status: the oracle throws verbatim strings
 * ("unexpected cleared status" lowercase on the ADD path, impl line 287;
 * "Unexpected" capitalized on static/remove/UPDATE paths, impl lines 141,
 * 260, 339, 358, 379; test line 241-247 pins the lowercase ADD string).
 * This repo's computeReconcileState has no throw — unknown statuses fall
 * through all three branches (reconcile.ts:124-133) and are silently
 * skipped. Pinned as actual behavior below.
 *
 * // FORK — no live listeners: the oracle ctor/ListChanged/suspend-refcount
 * event system has no counterpart here (pure functions, no DB, no React).
 * Ctor-recalc/incremental/suspend/UPDATE are mapped to pure recompute
 * determinism: recompute-after-mutation equals a fresh full recompute.
 *
 * // FORK — running-balance direction: the oracle accumulates FORWARD from
 * zero in list order (reseed from previous row, impl 408-437); this repo
 * walks BACKWARD from the stored `accounts.balance` anchor over
 * date-descending rows (register.ts:29-43). With anchor == true row sum the
 * per-row readings agree; asserted below.
 */

import { describe, expect, it } from "vitest";
import { computeReconcileState } from "../src/reconcile.js";
import { computeRunningBalances } from "../src/register.js";
import type { Account, Transaction } from "../src/types.js";

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: "Chequing",
    kind: "liquid",
    groupLabel: "Budget",
    balance: "0",
    onBudget: true,
    sort: 0,
    lastReconciledAt: null,
    lastReconciledBalance: null,
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    accountId: 1,
    categoryId: null,
    date: "2012-01-01",
    payee: "",
    memo: "",
    amount: "0",
    status: "c",
    ...overrides,
  };
}

describe("oracle B3 static snapshot splits (oracle test:95-112)", () => {
  it("splits cleared/uncleared/reconciled: reconciled feeds the statement comparator", () => {
    const acct = makeAccount();
    const txns: Transaction[] = [
      makeTx({ id: 1, amount: "100", status: "r", date: "2012-01-01" }),
      makeTx({ id: 2, amount: "50", status: "c", date: "2012-01-02" }),
      makeTx({ id: 3, amount: "25", status: "u", date: "2012-01-03" }),
    ];
    const s = computeReconcileState(acct, txns, "2012-01-31");
    expect(s.reconciledCount).toBe(1);
    expect(s.clearedCount).toBe(1);
    expect(s.unclearedCount).toBe(1);
    expect(s.unclearedTotal).toBe(25);
    // FORK: this repo workingBalance = cleared + reconciled = 150
    // (statement comparator); oracle working = raw sum 175.
    expect(s.workingBalance).toBe(150);
  });

  it("FORK: documents both working-balance semantics against the oracle raw sum", () => {
    const acct = makeAccount();
    const txns: Transaction[] = [
      makeTx({ id: 1, amount: "100", status: "r", date: "2012-01-01" }),
      makeTx({ id: 2, amount: "50", status: "c", date: "2012-01-02" }),
      makeTx({ id: 3, amount: "25", status: "u", date: "2012-01-03" }),
    ];
    const s = computeReconcileState(acct, txns, "2012-01-31");
    // Oracle semantics: clearedBalance(150, reconciled included) + uncleared(25) = 175.
    expect(s.workingBalance + s.unclearedTotal).toBe(175);
    // This-repo semantics: uncleared excluded from the comparator.
    expect(s.workingBalance).toBe(150);
    expect(s.workingBalance).not.toBe(175);
  });

  it("reconciled-only snapshot feeds the comparator in full", () => {
    const acct = makeAccount();
    const txns: Transaction[] = [
      makeTx({ id: 1, amount: "10000", status: "r", date: "2012-01-01" }),
    ];
    const s = computeReconcileState(acct, txns, "2012-01-31");
    expect(s.workingBalance).toBe(10000);
    expect(s.reconciledCount).toBe(1);
    expect(s.clearedCount).toBe(0);
  });
});

describe("oracle B3 maxDate inclusive filter (oracle test:114-136)", () => {
  const two = (): Transaction[] => [
    makeTx({ id: 1, amount: "100", status: "c", date: "2012-01-01" }),
    makeTx({ id: 2, amount: "50", status: "c", date: "2012-01-10" }),
  ];

  it("filters by statementDate, boundary row included", () => {
    const s = computeReconcileState(makeAccount(), two(), "2012-01-05");
    expect(s.workingBalance).toBe(100);
    expect(s.clearedCount).toBe(1);
  });

  it("row exactly ON the statementDate is included (inclusive)", () => {
    const s = computeReconcileState(makeAccount(), two(), "2012-01-10");
    expect(s.workingBalance).toBe(150);
    expect(s.clearedCount).toBe(2);
  });

  it("statementDate before all rows yields all zeros", () => {
    const s = computeReconcileState(makeAccount(), two(), "2011-12-31");
    expect(s.workingBalance).toBe(0);
    expect(s.unclearedTotal).toBe(0);
    expect(s.clearedCount).toBe(0);
    expect(s.reconciledCount).toBe(0);
    expect(s.unclearedCount).toBe(0);
  });

  it("empty list is all zeros (oracle null-list analogue; typed array here)", () => {
    const s = computeReconcileState(makeAccount(), [], "2012-01-31");
    expect(s).toEqual({
      accountId: 1,
      accountName: "Chequing",
      workingBalance: 0,
      unclearedTotal: 0,
      unclearedCount: 0,
      clearedCount: 0,
      reconciledCount: 0,
      lastReconciledAt: null,
      lastReconciledBalance: null,
    });
  });
});

describe("oracle B3 getBalancesThroughDate (oracle test:149-163)", () => {
  it("statementDate filters; unfiltered call covers all rows", () => {
    const acct = makeAccount();
    const txns: Transaction[] = [
      makeTx({ id: 1, amount: "100", status: "c", date: "2012-01-01" }),
      makeTx({ id: 2, amount: "25", status: "u", date: "2012-01-10" }),
    ];
    const through = computeReconcileState(acct, txns, "2012-01-05");
    expect(through.workingBalance).toBe(100);
    expect(through.unclearedTotal).toBe(0);
    const all = computeReconcileState(acct, txns, "2012-12-31");
    expect(all.workingBalance).toBe(100);
    expect(all.unclearedTotal).toBe(25);
    // Oracle analog: oracle cleared=100/uncleared=0/working=100 through-date,
    // cleared=100/uncleared=25/working=125 unfiltered (raw sum, FORK noted above).
    expect(all.workingBalance + all.unclearedTotal).toBe(125);
  });
});

describe("oracle B3 ctor recalc + incremental add/remove (oracle test:165-180)", () => {
  it("pure recompute is deterministic: same inputs, same outputs (ctor-recalc analogue)", () => {
    const acct = makeAccount();
    const txns: Transaction[] = [
      makeTx({ id: 1, amount: "100", status: "c", date: "2012-01-01" }),
    ];
    const a = computeReconcileState(acct, txns, "2012-01-31");
    const b = computeReconcileState(acct, txns, "2012-01-31");
    expect(a).toEqual(b);
    expect(a.workingBalance).toBe(100);
  });

  it("recompute-after-add pushes uncleared without moving cleared (add analogue)", () => {
    const acct = makeAccount();
    const base: Transaction[] = [
      makeTx({ id: 1, amount: "100", status: "c", date: "2012-01-01" }),
    ];
    const added = makeTx({ id: 2, amount: "25", status: "u", date: "2012-01-02" });
    const s = computeReconcileState(acct, [...base, added], "2012-01-31");
    expect(s.workingBalance).toBe(100);
    expect(s.unclearedTotal).toBe(25);
  });

  it("recompute-after-remove restores prior totals (remove analogue)", () => {
    const acct = makeAccount();
    const base: Transaction[] = [
      makeTx({ id: 1, amount: "100", status: "c", date: "2012-01-01" }),
    ];
    const added = makeTx({ id: 2, amount: "25", status: "u", date: "2012-01-02" });
    const afterRemove = computeReconcileState(acct, base, "2012-01-31");
    expect(afterRemove.unclearedTotal).toBe(0);
    expect(afterRemove.workingBalance).toBe(100);
    expect(afterRemove).toEqual(computeReconcileState(acct, [base[0]!, added].filter((t) => t.id !== 2), "2012-01-31"));
  });

  it("batched (suspended) mutations recompute to the same state as step-by-step (suspend/resume analogue)", () => {
    const acct = makeAccount();
    const t1 = makeTx({ id: 1, amount: "100", status: "c", date: "2012-01-01" });
    const t2 = makeTx({ id: 2, amount: "25", status: "c", date: "2012-01-02" });
    // "Suspended": mutate the whole list with no intermediate recompute,
    // then one resume-recompute — must equal the incrementally built state.
    const batched = computeReconcileState(acct, [t1, t2], "2012-01-31");
    const step1 = computeReconcileState(acct, [t1], "2012-01-31");
    expect(step1.workingBalance).toBe(100);
    const step2 = computeReconcileState(acct, [t1, t2], "2012-01-31");
    expect(batched).toEqual(step2);
    expect(batched.workingBalance).toBe(125);
  });
});

describe("oracle B3 running balances accumulate + reseed (oracle test:182-199)", () => {
  it("accumulates across rows; anchor == row sum agrees with forward accumulation", () => {
    // Oracle forward: 100, 70, 120 from zero. Backward walk from the true
    // sum (120) over newest-first rows must read the same per-row figures.
    const rows: Transaction[] = [
      { ...makeTx({ id: 3, amount: "50", status: "u", date: "2012-01-03" }) },
      { ...makeTx({ id: 2, amount: "-30", status: "u", date: "2012-01-02" }) },
      { ...makeTx({ id: 1, amount: "100", status: "u", date: "2012-01-01" }) },
    ];
    const out = computeRunningBalances(rows, new Map([[1, 120]]));
    const byId = (id: number) => out.find((r) => r.id === id)!.runningBalance;
    expect(byId(3)).toBe(120);
    expect(byId(2)).toBe(70);
    expect(byId(1)).toBe(100);
  });

  it("post-removal reseed: recompute with the updated anchor shifts older rows", () => {
    // Remove the -30 middle row; true sum reseeds 150; newest-first recompute.
    const rows: Transaction[] = [
      { ...makeTx({ id: 3, amount: "50", status: "u", date: "2012-01-03" }) },
      { ...makeTx({ id: 1, amount: "100", status: "u", date: "2012-01-01" }) },
    ];
    const out = computeRunningBalances(rows, new Map([[1, 150]]));
    const byId = (id: number) => out.find((r) => r.id === id)!.runningBalance;
    expect(byId(3)).toBe(150);
    expect(byId(1)).toBe(100);
  });
});

describe("oracle B3 cleared/amount UPDATE replay (oracle test:220-239)", () => {
  it("status u->c replay moves the amount across buckets on recompute", () => {
    const acct = makeAccount();
    const before = computeReconcileState(
      acct,
      [makeTx({ id: 1, amount: "100", status: "u", date: "2012-01-01" })],
      "2012-01-31",
    );
    expect(before.unclearedTotal).toBe(100);
    expect(before.workingBalance).toBe(0);
    const after = computeReconcileState(
      acct,
      [makeTx({ id: 1, amount: "100", status: "c", date: "2012-01-01" })],
      "2012-01-31",
    );
    expect(after.unclearedTotal).toBe(0);
    expect(after.workingBalance).toBe(100);
  });

  it("amount replay updates totals and the running balance on recompute", () => {
    const acct = makeAccount();
    const s = computeReconcileState(
      acct,
      [makeTx({ id: 1, amount: "150", status: "u", date: "2012-01-01" })],
      "2012-01-31",
    );
    expect(s.unclearedTotal).toBe(150);
    const out = computeRunningBalances(
      [{ ...makeTx({ id: 1, amount: "150", status: "u", date: "2012-01-01" }) }],
      new Map([[1, 150]]),
    );
    expect(out[0]!.runningBalance).toBe(150);
  });
});

describe("oracle B3 unknown cleared status (oracle test:241-247)", () => {
  it("FORK: this repo silently skips unknown statuses — no throw (oracle throws verbatim strings)", () => {
    // Oracle: ADD path throws "unexpected cleared status" (lowercase,
    // impl:287); static/remove/UPDATE paths throw "Unexpected" (capitalized,
    // impl:141,260,339,358,379). This repo pins skip-behavior instead.
    const bad = makeTx({
      id: 9,
      amount: "100",
      date: "2012-01-01",
      status: "x" as unknown as Transaction["status"],
    });
    const s = computeReconcileState(makeAccount(), [bad], "2012-01-31");
    expect(s.workingBalance).toBe(0);
    expect(s.unclearedTotal).toBe(0);
    expect(s.clearedCount).toBe(0);
    expect(s.reconciledCount).toBe(0);
    expect(s.unclearedCount).toBe(0);
  });

  it("unknown status alongside valid rows leaves valid sums untouched", () => {
    const txns: Transaction[] = [
      makeTx({ id: 1, amount: "100", status: "c", date: "2012-01-01" }),
      makeTx({
        id: 9,
        amount: "999",
        date: "2012-01-02",
        status: "x" as unknown as Transaction["status"],
      }),
    ];
    const s = computeReconcileState(makeAccount(), txns, "2012-01-31");
    expect(s.workingBalance).toBe(100);
    expect(s.clearedCount).toBe(1);
  });
});
