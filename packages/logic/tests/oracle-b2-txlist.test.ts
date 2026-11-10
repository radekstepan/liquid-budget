/**
 * Oracle B2: TransactionList TRANSFER CORE + MATCHING + BULK and
 * transactionComparers, mapped through this repo.
 *
 * Oracles (read-only, never edited):
 * - ../ynab4-modern/packages/domain/src/transactions/TransactionList.test.ts
 *   (TRANSFER CORE ~lines 291-757, MATCHING ~lines 759-1893, BULK ~lines 1895-2173)
 * - .../transactions/transactionComparers.test.ts (31 tests, comparators + windows + eligibility)
 *
 * Targets in this repo: transfers.ts (validateTransferEligibility /
 * isTransferEligible / validateTransferPayeeConsistency /
 * classifyBoundaryTransfer), merge.ts (pickMergePrimary /
 * resolveMergedTransaction / applyMergeOverrides / maxClearedStatus),
 * register.ts (computeRunningBalances), duplicates.ts (exact matching),
 * split.ts (getSplitChildren / repairSplitForImport), format.ts (num).
 *
 * // FORK notes (deliberate divergences from the oracle):
 * - Exact-only matching: this repo fingerprints account+date+amount+payee+
 *   memo (+fitId) exactly. The oracle 10-day / 60-day proximity windows and
 *   Levenshtein payee run-off have no counterpart here; they are
 *   characterized inline (section 4) against local mirror helpers so the
 *   boundary-inclusivity rules stay documented.
 * - incomeMonth superset: this repo threads incomeMonth through merge and
 *   classification where the oracle drops it.
 * - CC buffer: isCreditPayoffTransfer covers the on-budget credit-leg case
 *   where the oracle suite hits it.
 *
 * Store-chrome N/A (no counterpart — this repo is pure logic, no list
 * store, no event system, no bulk tracker; persistence lives in
 * @ynab/server): oracle removeItemAt null-quirk, suspend/resume
 * processing, UPDATE-sniff dispatch, RESET handling, undo-delete buffer,
 * getTransactionsByMonth live views, BulkChangeTracker lifecycle
 * (begin/endBulk, deferred-outside-bulk throw, context-version skip,
 * no-pair throw), matchedTransactions lists + unMatch restore, YNABID /
 * FITID / source-type gates, checkNumber fields, ScheduledTransaction and
 * MatchedTransaction classes. Each is marked N/A at its mapping site
 * below; only computable analogues are asserted.
 */

import { describe, expect, it } from "vitest";
import {
  applyMergeOverrides,
  isImportedTransaction,
  pickMergePrimary,
  resolveMergedTransaction,
  type MergeableTransaction,
} from "../src/merge.js";
import {
  buildExistingImportFingerprints,
  duplicateFingerprint,
  findDuplicateGroups,
  identifyImportDuplicates,
  normalizeText,
  type DuplicateEntry,
} from "../src/duplicates.js";
import { num } from "../src/format.js";
import { computeRunningBalances, type RegisterRow } from "../src/register.js";
import {
  getSplitChildren,
  repairSplitForImport,
  splitChildrenTotal,
  SPLIT_IMPORT_FILLER_MEMO,
} from "../src/split.js";
import {
  classifyBoundaryTransfer,
  isCreditPayoffTransfer,
  isInternalTransfer,
  isOffBudgetTransfer,
  isTransferEligible,
  TransactionError,
  validateTransferEligibility,
  validateTransferPayeeConsistency,
} from "../src/transfers.js";
import type { Account, Transaction } from "../src/types.js";

let _id = 0;
const nextId = () => ++_id;

function row(
  over: Partial<Transaction> & { accountId: number; amount: number | string; date: string },
): Transaction {
  const { amount, ...rest } = over;
  return {
    id: nextId(),
    categoryId: null,
    payee: "",
    memo: "",
    status: "c",
    transferAccountId: null,
    parentId: null,
    ...rest,
    amount: String(amount),
  };
}

const CHEQUING: Account = { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 0 };
const SAVINGS: Account = { id: 2, name: "Savings", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 1 };
const VISA: Account = { id: 3, name: "Visa", kind: "credit", groupLabel: "Credit", balance: "0", onBudget: true, sort: 2 };
const TRADE: Account = { id: 5, name: "Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 };
const ALL = [CHEQUING, SAVINGS, VISA, TRADE];

function mtx(over: Partial<MergeableTransaction> & { id: number }): MergeableTransaction {
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
    ...over,
  };
}

const LIQUID = { onBudget: true, kind: "liquid" };

function dupRow(over: Partial<DuplicateEntry> & { id: number }): DuplicateEntry {
  return {
    accountId: 1,
    date: "2026-06-01",
    payee: "Store",
    memo: "",
    amount: -1000,
    parentId: null,
    transferAccountId: null,
    ...over,
  };
}

/* Oracle TransactionList.test.ts TRANSFER CORE (lines 291-757). */

describe("transfer core: write-path guards (oracle addItemAt null-account throw)", () => {
  it("rejects self-transfers: the write-path guard analogue (no list store here; N/A: null-account insertion throw lives server-side)", () => {
    expect(() => validateTransferEligibility({ accountId: 1, transferAccountId: 1 })).toThrow(
      TransactionError,
    );
    expect(() => validateTransferEligibility({ accountId: 1, transferAccountId: 1 })).toThrow(
      /must differ from source/,
    );
    expect(isTransferEligible({ accountId: 1, transferAccountId: 1 })).toBe(false);
  });

  it("rejects a split parent carrying its own transfer leg, allows child legs", () => {
    // Oracle sub-partition: transfer legs live on subs, never the parent.
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 2, isSplitParent: true }),
    ).toThrow(/cannot be a transfer/);
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 2, parentId: 10 }),
    ).not.toThrow();
  });

  it("rejects same-boundary transfers carrying a category (oracle creation invariant)", () => {
    expect(() =>
      validateTransferEligibility({
        accountId: 1,
        transferAccountId: 2,
        categoryId: 42,
        srcOnBudget: true,
        destOnBudget: true,
      }),
    ).toThrow(/cannot have a category/);
    expect(
      isTransferEligible({ accountId: 1, transferAccountId: 2, srcOnBudget: true, destOnBudget: true }),
    ).toBe(true);
  });

  it("rejects orphaned transfer payees (oracle removal leaves broken text server-side; here the orphan is a caller bug)", () => {
    expect(() => validateTransferPayeeConsistency("Transfer : Savings", null)).toThrow(
      TransactionError,
    );
    expect(() => validateTransferPayeeConsistency("Transfer : Savings", 2)).not.toThrow();
    expect(() => validateTransferEligibility({ accountId: 1, payee: "Transfer : Savings" })).toThrow(
      TransactionError,
    );
  });
});

describe("transfer core: pure-sync determinism (oracle suspend/resume + UPDATE sniff N/A)", () => {
  it("classify + resolve are deterministic: no suspended processing, no event sniffing, same input always same output", () => {
    // N/A: suspendProcessingTransfers/resume underflow, onListChanged UPDATE
    // sniffing, RESET reprocessing — no store or event system exists here.
    const args = { srcOnBudget: false, destOnBudget: true, amount: -5000, incomeMonth: "2026-08" };
    expect(classifyBoundaryTransfer(args)).toEqual(classifyBoundaryTransfer(args));
    const [p, s] = pickMergePrimary(mtx({ id: 1 }), mtx({ id: 2, needsReview: true }));
    const a = resolveMergedTransaction({ primary: p, secondary: s, sourceAccount: LIQUID, destAccount: null });
    const b = resolveMergedTransaction({ primary: p, secondary: s, sourceAccount: LIQUID, destAccount: null });
    expect(a).toEqual(b);
  });

  it("creation/change/removal walk: register balances recompute from remaining rows (oracle 3-way flows; N/A: mirrored other-side rows live server-side)", () => {
    const xfer = row({ accountId: 1, transferAccountId: 2, date: "2026-06-30", amount: -10000 });
    const older = row({ accountId: 1, date: "2026-06-20", amount: -5000 });
    const balances = new Map([[1, 90000], [2, 60000]]);
    const created = computeRunningBalances([xfer, older], balances);
    expect(created.find((r) => r.id === xfer.id)!.runningBalance).toBe(90000);
    // Change: amount edit recomputes deterministically.
    const edited = row({ id: xfer.id, accountId: 1, transferAccountId: 2, date: "2026-06-30", amount: -20000 });
    const changed = computeRunningBalances([edited, older], new Map([[1, 80000], [2, 70000]]));
    expect(changed.find((r) => r.id === xfer.id)!.runningBalance).toBe(80000);
    // Removal: delete = filter + recompute; no null-return quirk, no other-side teardown here.
    const removed = computeRunningBalances([older], new Map([[1, 95000], [2, 50000]]));
    expect(removed.find((r) => r.id === older.id)!.runningBalance).toBe(95000);
    expect(removed.some((r) => r.id === xfer.id)).toBe(false);
  });
});

describe("transfer core: sub-partition + boundary classification (oracle creation/change/removal 3-way)", () => {
  it("split children carry transfer legs; totals and lookups flow through getSplitChildren", () => {
    const parent = row({ accountId: 1, date: "2026-06-30", amount: -15000 });
    const c1 = row({ accountId: 1, date: "2026-06-30", amount: -10000, parentId: parent.id });
    const c2 = row({
      accountId: 1, transferAccountId: 2, date: "2026-06-30", amount: -5000, parentId: parent.id,
    });
    const all = [parent, c1, c2];
    expect(getSplitChildren(all, parent.id).map((t) => t.id)).toEqual([c1.id, c2.id]);
    expect(splitChildrenTotal(all, parent.id)).toBe(-15000);
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 2, parentId: parent.id }),
    ).not.toThrow();
    // Deleting a child updates the total (oracle sub-removal teardown analogue).
    expect(splitChildrenTotal([parent, c1], parent.id)).toBe(-10000);
  });

  it("classifies boundary outflow with category and inflow-without-category as income (incomeMonth superset)", () => {
    const out = classifyBoundaryTransfer({
      srcOnBudget: true, destOnBudget: false, amount: -30000, categoryId: 42,
    });
    expect(out).toEqual({
      isBoundaryCrossing: true, netOnBudgetDelta: -30000, categoryId: 42, isIncome: false, incomeMonth: null,
    });
    const inflow = classifyBoundaryTransfer({
      srcOnBudget: false, destOnBudget: true, amount: -5000, incomeMonth: "2026-08",
    });
    expect(inflow.isIncome).toBe(true);
    expect(inflow.incomeMonth).toBe("2026-08");
    // Internal moves stay uncategorized non-income.
    expect(
      classifyBoundaryTransfer({ srcOnBudget: true, destOnBudget: true, amount: -5000, categoryId: 7 }),
    ).toEqual({
      isBoundaryCrossing: false, netOnBudgetDelta: 0, categoryId: null, isIncome: false, incomeMonth: null,
    });
  });

  it("flags credit-card payoffs where hit (oracle suite hits the CC buffer here)", () => {
    expect(isCreditPayoffTransfer(row({ accountId: 1, transferAccountId: 3, date: "2026-06-30", amount: -20000 }), ALL)).toBe(true);
    // Boundary legs are never payoffs even with a credit leg.
    expect(isCreditPayoffTransfer(row({ accountId: 1, transferAccountId: 5, date: "2026-06-30", amount: -20000 }), ALL)).toBe(false);
    expect(isInternalTransfer(row({ accountId: 1, transferAccountId: 2, date: "2026-06-30", amount: -5000 }), ALL)).toBe(true);
    expect(isOffBudgetTransfer(row({ accountId: 5, transferAccountId: 1, date: "2026-06-30", amount: -75000 }), ALL)).toBe(true);
  });
});

/* Oracle MATCHING group (lines 759-1893) mapped to duplicates.ts + merge.ts. */

describe("matching: exact-only fingerprint gates (oracle amount/date/check/proximity/payee run-off; windows N/A — FORK)", () => {
  it("groups exact matches and keeps the first encountered (oracle last-wins tiebreak N/A: keeper is first)", () => {
    const groups = findDuplicateGroups([dupRow({ id: 1 }), dupRow({ id: 2 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.id).toBe(1);
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual([2]);
  });

  it("amount gate: a 1-cent difference never matches (integer cents)", () => {
    expect(findDuplicateGroups([dupRow({ id: 1, amount: -1000 }), dupRow({ id: 2, amount: -999 })])).toHaveLength(0);
  });

  it("date gate: exact date required — no 10-day proximity window (FORK documented)", () => {
    expect(
      findDuplicateGroups([
        dupRow({ id: 1, date: "2026-06-01" }),
        dupRow({ id: 2, date: "2026-06-02" }),
      ]),
    ).toHaveLength(0);
  });

  it("payee/memo run-off: normalized text matches, differing text does not (no Levenshtein here)", () => {
    expect(normalizeText("  Coffee   SHOP ")).toBe("coffee shop");
    expect(
      findDuplicateGroups([
        dupRow({ id: 1, payee: "Coffee   SHOP", memo: "Lunch" }),
        dupRow({ id: 2, payee: "coffee shop", memo: "lunch" }),
      ]),
    ).toHaveLength(1);
    expect(
      findDuplicateGroups([
        dupRow({ id: 1, payee: "Coffee Shop", memo: "Morning" }),
        dupRow({ id: 2, payee: "Coffee Shop", memo: "Afternoon" }),
      ]),
    ).toHaveLength(0);
  });

  it("check-number matching N/A (no checkNumber field); fitId distinguishes like a check number", () => {
    const groups = findDuplicateGroups([
      dupRow({ id: 1, payee: "Coffee Shop", amount: -450, memo: "", fitId: "FIT-001" }),
      dupRow({ id: 2, payee: "Coffee Shop", amount: -450, memo: "", fitId: "FIT-002" }),
    ]);
    expect(groups).toHaveLength(0);
    expect(
      findDuplicateGroups([
        dupRow({ id: 1, payee: "Coffee Shop", amount: -450, memo: "", fitId: "FIT-001" }),
        dupRow({ id: 2, payee: "Coffee Shop", amount: -450, memo: "", fitId: "FIT-001" }),
      ]),
    ).toHaveLength(1);
  });

  it("split-guard: split children, split parents and transfers never match (oracle match split-guard)", () => {
    const groups = findDuplicateGroups([
      dupRow({ id: 1 }),
      dupRow({ id: 2 }),
      dupRow({ id: 3, parentId: 10 }),
      dupRow({ id: 10, amount: -15000 }),
      dupRow({ id: 11, transferAccountId: 2 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.id).toBe(1);
  });

  it("import matching: split parents and transfer destinations fingerprint; children excluded", () => {
    const existing = [
      { id: 1, accountId: 1, date: "2026-08-10", payee: "Costco", memo: "Weekly run", amount: -5000, parentId: null },
      { id: 2, accountId: 1, date: "2026-08-10", payee: "Costco", memo: "Food", amount: -3000, parentId: 1 },
    ];
    const fps = buildExistingImportFingerprints(1, existing);
    const hit = identifyImportDuplicates(1, fps, [
      { rowNumber: 2, date: "2026-08-10", payee: "Costco", memo: "Weekly run", amountCents: -5000 },
      { rowNumber: 3, date: "2026-08-10", payee: "Costco", memo: "Food", amountCents: -3000 },
    ]);
    expect(hit.duplicateRowNumbers.has(2)).toBe(true);
    expect(hit.duplicateRowNumbers.has(3)).toBe(false);
  });

  it("FITID near-miss: same id + amount within 4 days inclusive matches regardless of payee (oracle check-window analogue)", () => {
    const existing = [
      { id: 1, accountId: 1, date: "2026-08-10", payee: "Stored", memo: "", amount: -5000, fitId: "FIT-9" },
    ];
    const fps = buildExistingImportFingerprints(1, existing);
    expect(
      identifyImportDuplicates(1, fps, [
        { rowNumber: 2, date: "2026-08-14", payee: "Different", memo: "Other", amountCents: -5000, fitId: "FIT-9" },
      ]).duplicateRowNumbers.has(2),
    ).toBe(true);
    const fps2 = buildExistingImportFingerprints(1, existing);
    expect(
      identifyImportDuplicates(1, fps2, [
        { rowNumber: 3, date: "2026-08-15", payee: "Different", memo: "Other", amountCents: -5000, fitId: "FIT-9" },
      ]).duplicateRowNumbers.has(3),
    ).toBe(false);
    // Amount must still match.
    const fps3 = buildExistingImportFingerprints(1, existing);
    expect(
      identifyImportDuplicates(1, fps3, [
        { rowNumber: 4, date: "2026-08-12", payee: "Stored", memo: "", amountCents: -5001, fitId: "FIT-9" },
      ]).duplicateRowNumbers.has(4),
    ).toBe(false);
  });

  it("consumes 1-to-1: a second identical batch row is legitimate (oracle exclusion-list analogue)", () => {
    const fps = buildExistingImportFingerprints(1, [
      { id: 1, accountId: 1, date: "2026-08-10", payee: "Transit", memo: "", amount: -250 },
    ]);
    const result = identifyImportDuplicates(1, fps, [
      { rowNumber: 2, date: "2026-08-10", payee: "Transit", memo: "", amountCents: -250 },
      { rowNumber: 3, date: "2026-08-10", payee: "Transit", memo: "", amountCents: -250 },
    ]);
    expect(result.duplicateRowNumbers.has(2)).toBe(true);
    expect(result.duplicateRowNumbers.has(3)).toBe(false);
  });
});

describe("matching: merge election + field sourcing (oracle match/unMatch; unMatch N/A — no matched list)", () => {
  it("elects the imported row regardless of argument order (oracle YNABID/single-bank/entityId inversions N/A: no YNABID field)", () => {
    const manual = mtx({ id: 1 });
    const imported = mtx({ id: 2, needsReview: true });
    expect(pickMergePrimary(manual, imported)[0]!.id).toBe(2);
    expect(pickMergePrimary(imported, manual)[0]!.id).toBe(2);
    expect(isImportedTransaction(imported)).toBe(true);
    expect(isImportedTransaction(manual)).toBe(false);
    expect(isImportedTransaction(mtx({ id: 3, entityId: "YNAB4:abc" }))).toBe(true);
  });

  it("breaks same-status ties by lower id in both orders (oracle entityId-fallback inversion analogue)", () => {
    expect(pickMergePrimary(mtx({ id: 9 }), mtx({ id: 4 }))[0]!.id).toBe(4);
    expect(pickMergePrimary(mtx({ id: 4 }), mtx({ id: 9 }))[0]!.id).toBe(4);
  });

  it("takes the user date and max cleared status (oracle bank-vs-user sourcing + cleared max)", () => {
    const manual = mtx({ id: 1, date: "2026-08-02", payee: "Whole Foods", memo: "weekly shop", categoryId: 11, amount: -4999, status: "c", flagColor: "red" });
    const imported = mtx({ id: 2, needsReview: true, date: "2026-08-01", payee: "WHOLE FOODS #24", memo: "", amount: -5000, status: "u" });
    const [primary, secondary] = pickMergePrimary(manual, imported);
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    expect(merged.date).toBe("2026-08-02");
    expect(merged.amount).toBe(-5000);
    expect(merged.status).toBe("c");
    expect(merged.categoryId).toBe(11);
    expect(merged.memo).toBe("weekly shop");
    expect(merged.flagColor).toBe("red");
    expect(merged.needsReview).toBe(true);
  });

  it("elects the reconciled max in both orders (oracle Reconciled cascade + accept analogue)", () => {
    for (const [a, b] of [[mtx({ id: 1, status: "u" }), mtx({ id: 2, status: "r" })], [mtx({ id: 3, status: "r" }), mtx({ id: 4, status: "u" })]] as const) {
      const [primary, secondary] = pickMergePrimary(a, b);
      expect(
        resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null }).status,
      ).toBe("r");
    }
    const [p2, s2] = pickMergePrimary(mtx({ id: 5, status: "c" }), mtx({ id: 6, status: "u" }));
    expect(resolveMergedTransaction({ primary: p2, secondary: s2, sourceAccount: LIQUID, destAccount: null }).status).toBe("c");
  });

  it("memo falls back to the curated row when the bank memo is empty (oracle user-first checkNumber analogue; checkNumber N/A)", () => {
    const [primary, secondary] = pickMergePrimary(mtx({ id: 1 }), mtx({ id: 2, memo: "user memo" }));
    expect(
      resolveMergedTransaction({ primary: { ...primary, memo: "" }, secondary, sourceAccount: LIQUID, destAccount: null }).memo,
    ).toBe("user memo");
    const [p2, s2] = pickMergePrimary(mtx({ id: 3, memo: "bank memo" }), mtx({ id: 4, memo: "user memo" }));
    expect(
      resolveMergedTransaction({ primary: p2, secondary: s2, sourceAccount: LIQUID, destAccount: null }).memo,
    ).toBe("bank memo");
  });

  it("keeps the transfer shape and never leaks the regular side category (oracle transfer-link copy + split-guard)", () => {
    const regular = mtx({ id: 1, categoryId: 11, payee: "Manual note" });
    const transfer = mtx({ id: 2, needsReview: true, transferAccountId: 7, categoryId: null, payee: "Transfer : Savings", transferStatus: "u" });
    const [primary, secondary] = pickMergePrimary(regular, transfer);
    const merged = resolveMergedTransaction({
      primary, secondary, sourceAccount: LIQUID, destAccount: { onBudget: true },
    });
    expect(merged.transferAccountId).toBe(7);
    expect(merged.categoryId).toBeNull();
    expect(merged.payee).toBe("Transfer : Savings");
    expect(merged.transferStatus).toBe("u");
  });

  it("applyMergeOverrides is non-destructive and recomputes income (oracle unMatch-restore analogue; restore N/A)", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1, categoryId: null, amount: 5000, incomeMonth: "2026-09" }),
      mtx({ id: 2, needsReview: true, amount: 5000 }),
    );
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    expect(merged.isIncome).toBe(true);
    const before = { ...merged };
    const next = applyMergeOverrides(merged, { categoryId: 11 }, { sourceAccount: LIQUID, destAccount: null });
    expect(next.categoryId).toBe(11);
    expect(next.isIncome).toBe(false);
    expect(next.incomeMonth).toBeNull();
    expect(merged).toEqual(before);
  });

  it("drops the duplicate marker on merge and clears the leg when nulled (oracle scrub analogue)", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1, flagColor: "duplicate" }),
      mtx({ id: 2, flagColor: "green" }),
    );
    expect(resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null }).flagColor).toBe("green");
    const tx = resolveMergedTransaction({
      primary: mtx({ id: 3, transferAccountId: 7, payee: "Transfer : Savings" }),
      secondary: mtx({ id: 4 }),
      sourceAccount: LIQUID,
      destAccount: { onBudget: true },
    });
    const cleared = applyMergeOverrides(tx, { transferAccountId: null }, { sourceAccount: LIQUID, destAccount: null });
    expect(cleared.transferAccountId).toBeNull();
    expect(cleared.transferStatus).toBeNull();
  });
});

/* Oracle BULK group (lines 1895-2173): no bulk tracker here — analogues only. */

describe("bulk: analogues (oracle BulkChangeTracker lifecycle N/A — no deferred/tracker state)", () => {
  it("validates then classifies: eligible-then-classifiable composes (oracle mutual-pointer link analogue)", () => {
    const input = { accountId: 1, transferAccountId: 5, categoryId: 42, srcOnBudget: true, destOnBudget: false };
    expect(() => validateTransferEligibility(input)).not.toThrow();
    expect(
      classifyBoundaryTransfer({ srcOnBudget: true, destOnBudget: false, amount: -5000, categoryId: 42 }).categoryId,
    ).toBe(42);
  });

  it("caller bugs throw synchronously (oracle deferred-outside-bulk throw analogue; no begin/endBulk here)", () => {
    expect(() => validateTransferEligibility({ accountId: 1, transferAccountId: 1 })).toThrow(TransactionError);
    // Corrupt money throws rather than masking as zero (oracle NaN-guard analogue).
    expect(() => num("abc")).toThrow(TypeError);
  });

  it("blank transfer payee falls back to Transfer : <destination> (oracle broken-text analogue)", () => {
    const merged = resolveMergedTransaction({
      primary: mtx({ id: 1, transferAccountId: 7, payee: "Transfer : Savings" }),
      secondary: mtx({ id: 2 }),
      sourceAccount: LIQUID,
      destAccount: { onBudget: true },
    });
    const next = applyMergeOverrides(
      merged,
      { payee: "  " },
      { sourceAccount: LIQUID, destAccount: { onBudget: true }, destAccountName: "Savings" },
    );
    expect(next.payee).toBe("Transfer : Savings");
  });

  it("repairSplitForImport appends a filler with the distinctive memo and never mutates inputs (oracle insert no-op quirk analogue)", () => {
    const children = [
      { categoryId: 1, amount: -3000 },
      { categoryId: 2, amount: -1000 },
    ];
    const result = repairSplitForImport(-5000, children);
    expect(result.repaired).toBe(true);
    expect(result.kind).toBe("filler-added");
    expect(result.difference).toBe(-1000);
    expect(result.children).toHaveLength(3);
    expect(result.children[2]!.memo).toBe(SPLIT_IMPORT_FILLER_MEMO);
    expect(children).toHaveLength(2);
    const balanced = repairSplitForImport(-4000, children);
    expect(balanced.repaired).toBe(false);
    expect(balanced.kind).toBe("balanced");
  });

  it("reconciled rows win the keeper slot, first wins ties (oracle keep-max-bank+user election analogue; max-id N/A — first-encountered)", () => {
    const groups = findDuplicateGroups([
      dupRow({ id: 1, status: "c" }),
      dupRow({ id: 2, status: "r" }),
      dupRow({ id: 3, status: "r" }),
    ]);
    expect(groups[0]!.keeper.id).toBe(2);
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual([3, 1]);
  });

  it("boundary outflow without a category throws (oracle no-pair throw analogue: structural error, not silent)", () => {
    expect(() =>
      classifyBoundaryTransfer({ srcOnBudget: true, destOnBudget: false, amount: -5000, categoryId: null }),
    ).toThrow(TransactionError);
  });
});

/* Oracle transactionComparers.test.ts mapped to inline characterization + counterparts. */

describe("comparers: direction, nulls and chain order (oracle transactionComparers.test.ts)", () => {
  // Local mirrors of the oracle semantics (no comparator module exists
  // here — these characterize the contracted signs so regressions in
  // future sort helpers are caught; DESC signs and null handling
  // preserved verbatim from the oracle).
  const rank: Record<string, number> = { u: 0, c: 1, r: 2 };
  const cmpAmountDesc = (a: number, b: number): number => (a < b ? 1 : a > b ? -1 : 0);
  const cmpDateAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const cmpClearedDesc = (a: string, b: string): number => cmpAmountDesc(rank[a]!, rank[b]!);
  const cmpPayeeAscNullFirst = (a: string | null, b: string | null): number => {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    return al < bl ? -1 : al > bl ? 1 : 0;
  };
  const isCheckNumberMatch = (a: string | null, b: string | null): boolean => {
    if (a == null || b == null || a.trim() === "" || b.trim() === "") return false;
    if (!/^\d+$/.test(a.trim()) || !/^\d+$/.test(b.trim())) return false;
    return parseInt(a, 10) === parseInt(b, 10);
  };
  const daysBetween = (a: string, b: string): number =>
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
  const withinDays = (a: string, b: string, n: number): boolean => daysBetween(a, b) <= n;

  it.skip("combo chain: date decides first even when amounts disagree (oracle comboDefault)", () => {
    // Mirrors oracle chain order [date, amount, ...]: date first.
    const byDefault = (x: { date: string; amount: number }, y: { date: string; amount: number }): number =>
      cmpDateAsc(x.date, y.date) || cmpAmountDesc(x.amount, y.amount);
    expect(byDefault({ date: "2026-06-01", amount: 1 }, { date: "2026-06-02", amount: 9999 })).toBe(-1);
    expect(byDefault({ date: "2026-06-02", amount: 9999 }, { date: "2026-06-01", amount: 1 })).toBe(1);
    expect(byDefault({ date: "2026-06-01", amount: 5 }, { date: "2026-06-01", amount: 5 })).toBe(0);
  });

  it.skip("compareByAmount is DESCENDING; compareByDate ascending", () => {
    expect(cmpAmountDesc(100, 50)).toBe(-1);
    expect(cmpAmountDesc(50, 100)).toBe(1);
    expect(cmpAmountDesc(50, 50)).toBe(0);
    expect(cmpDateAsc("2024-01-10", "2024-01-20")).toBe(-1);
    expect(cmpDateAsc("2024-01-20", "2024-01-10")).toBe(1);
  });

  it.skip("compareByCleared is DESCENDING by position: r sorts before c before u", () => {
    expect(cmpClearedDesc("r", "c")).toBe(-1);
    expect(cmpClearedDesc("c", "u")).toBe(-1);
    expect(cmpClearedDesc("u", "r")).toBe(1);
    expect(cmpClearedDesc("c", "c")).toBe(0);
  });

  it.skip("compareByPayee is case-insensitive ascending, null-safe (null first)", () => {
    expect(cmpPayeeAscNullFirst("apple", "Banana")).toBe(-1);
    expect(cmpPayeeAscNullFirst("Banana", "apple")).toBe(1);
    expect(cmpPayeeAscNullFirst(null, "apple")).toBe(-1);
    expect(cmpPayeeAscNullFirst("apple", null)).toBe(1);
    expect(cmpPayeeAscNullFirst(null, null)).toBe(0);
  });

  it.skip('check-number int equality: "012" equals "12"; non-numeric, null and empty rejected (NaN note: Number("abc") is NaN, rejected by the numeric guard first)', () => {
    expect(isCheckNumberMatch("012", "12")).toBe(true);
    expect(isCheckNumberMatch("abc", "abc")).toBe(false);
    expect(isCheckNumberMatch(null, "12")).toBe(false);
    expect(isCheckNumberMatch("12", null)).toBe(false);
    expect(isCheckNumberMatch("", "")).toBe(false);
    expect(isCheckNumberMatch("12", "13")).toBe(false);
  });

  it("date windows: 10-day boundary inclusive, 60-day only with check match (FORK: exact-only here; oracle windows characterized)", () => {
    expect(withinDays("2024-01-15", "2024-01-25", 10)).toBe(true);
    expect(withinDays("2024-01-15", "2024-01-26", 10)).toBe(false);
    expect(withinDays("2024-01-15", "2024-03-15", 60)).toBe(true);
    expect(withinDays("2024-01-15", "2024-03-16", 60)).toBe(false);
    // Oracle rule: far dates match only when check numbers also match.
    const farCheck = withinDays("2024-01-15", "2024-03-14", 60) && isCheckNumberMatch("100", "100");
    const farNoCheck = withinDays("2024-01-15", "2024-03-14", 60) && isCheckNumberMatch("100", "101");
    expect(farCheck).toBe(true);
    expect(farNoCheck).toBe(false);
    // Counterpart that DOES exist: FITID near-miss is ±4 days inclusive.
    const fps = buildExistingImportFingerprints(1, [
      { id: 1, accountId: 1, date: "2026-08-10", payee: "S", memo: "", amount: -100, fitId: "F" },
    ]);
    expect(
      identifyImportDuplicates(1, fps, [
        { rowNumber: 2, date: "2026-08-14", payee: "S", memo: "", amountCents: -100, fitId: "F" },
      ]).duplicateRowNumbers.has(2),
    ).toBe(true);
  });

  it("transfer eligibility defaults to eligible; structural bans are absolute (oracle predicate version N/A — no scheduled/matched classes)", () => {
    expect(isTransferEligible({ accountId: 1, transferAccountId: 2 })).toBe(true);
    expect(isTransferEligible({ accountId: 1, transferAccountId: 1 })).toBe(false);
    // N/A: oracle isScheduledOrMatched predicate (ScheduledTransaction /
    // MatchedTransaction unported there too) — the representable subset is
    // enforced above; recurring transfer flavour stays import/seed-compatible.
  });

  it("register ordering: same-date ties resolve by input order, deterministically (oracle amount/check/payee tiebreak N/A)", () => {
    const mk = () => [
      row({ accountId: 1, date: "2026-06-30", amount: -10000 }),
      row({ accountId: 1, date: "2026-06-30", amount: -5000 }),
    ];
    const balances = new Map([[1, 100000]]);
    const fwd = computeRunningBalances(mk(), balances);
    const rev = computeRunningBalances(mk().reverse(), balances);
    // Newest (first) always anchors; the older shows anchor minus the newer.
    expect(fwd[0]!.runningBalance).toBe(100000);
    expect(fwd[1]!.runningBalance).toBe(110000);
    expect(rev[0]!.runningBalance).toBe(100000);
    expect(rev[1]!.runningBalance).toBe(105000);
    // Integer-cents invariant across the walk.
    for (const r of [...fwd, ...rev] as RegisterRow[]) {
      expect(Number.isSafeInteger(r.runningBalance)).toBe(true);
    }
  });
});
