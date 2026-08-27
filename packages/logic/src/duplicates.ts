import type { ClearedStatus, RenameRule, TransactionFlagState } from "./types.js";
import { applyRenameRules } from "./rename-rules.js";

/**
 * A single row that participates in duplicate detection.
 *
 * Only "plain regular" rows take part: rows with no parent (not a split
 * child), no transfer account (not a transfer) and no children (not a
 * split parent). Split parents and children are excluded because their
 * amounts/payees are shared across many legitimate multi-leg splits.
 */
export type DuplicateEntry = {
  /** Present for rows already persisted in the database. */
  id?: number;
  /** Present for rows coming from a CSV file (1-based source line). */
  rowNumber?: number;
  accountId: number;
  accountName?: string;
  date: string;
  payee: string;
  memo: string;
  /** Amount in cents. */
  amount: number;
  flagColor?: TransactionFlagState;
  status?: ClearedStatus;
  parentId?: number | null;
  transferAccountId?: number | null;
};

export type DuplicateGroup = {
  fingerprint: string;
  /** The first-encountered entry; this one is kept. */
  keeper: DuplicateEntry;
  /** The remaining entries; these are the duplicates. */
  duplicates: DuplicateEntry[];
};

export type DuplicateAnalysisResult = {
  groups: DuplicateGroup[];
  /** Total number of duplicate entries (excludes each group's keeper). */
  duplicateCount: number;
  /** Duplicates that were newly flagged with the internal duplicate marker. */
  flaggedCount: number;
  /** Duplicates that already carried a manual flag and were left untouched. */
  alreadyFlaggedCount: number;
  /** Duplicates that are reconciled (locked) and were left untouched. */
  lockedCount: number;
  /** Rows whose stale internal duplicate marker was cleared this run. */
  clearedCount: number;
};

/**
 * An entry that was skipped during an import because it duplicates
 * another entry. Used to tell the user what "might be duplicates and
 * will be skipped" in the import preview/result.
 */
export type ImportSkippedEntry = {
  /** Source CSV row number when the skipped entry came from a CSV file. */
  rowNumber?: number;
  accountName?: string;
  date: string;
  payee: string;
  memo: string;
  /** Amount in cents. */
  amount: number;
  /** Human-readable explanation of why the entry was skipped. */
  reason: string;
  /** Kept CSV row number when the duplicate was earlier in the same file. */
  matchRowNumber?: number;
  /** Kept transaction id when the duplicate matched an existing row. */
  matchId?: number;
};

/** Summary returned by the YNAB4 backup importer. */
export type ImportSummary = {
  accounts: number;
  categoryGroups: number;
  categories: number;
  transactions: number;
  duplicatesSkipped: ImportSkippedEntry[];
  settings?: unknown;
};

/**
 * Normalize free-text fields (payee, memo) before fingerprinting so
 * that leading/trailing whitespace, case, and repeated spaces are
 * ignored.
 */
export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A conservative "exact match" identity for a transaction:
 * account + date + amount + normalized payee + normalized memo.
 * Serialized as JSON array to prevent delimiter collision issues.
 */
export function duplicateFingerprint(f: {
  accountId: number;
  date: string;
  amount: number;
  payee: string;
  memo: string;
}): string {
  return JSON.stringify([
    f.accountId,
    f.date,
    f.amount,
    normalizeText(f.payee),
    normalizeText(f.memo),
  ]);
}

/**
 * Group rows into duplicate candidates. Only plain regular rows are
 * considered (see {@link DuplicateEntry}). Reconciled rows are preferred
 * as keepers so that locked transactions are preserved while mutable
 * duplicates can be flagged. Relative input order is preserved.
 */
export function findDuplicateGroups(rows: DuplicateEntry[]): DuplicateGroup[] {
  const childIds = new Set<number>();
  for (const r of rows) {
    if (r.parentId != null) childIds.add(r.parentId);
  }

  const byFingerprint = new Map<string, DuplicateEntry[]>();
  const order: string[] = [];

  for (const r of rows) {
    if (r.parentId != null || r.transferAccountId != null) continue;
    if (r.id != null && childIds.has(r.id)) continue;
    const fp = duplicateFingerprint({
      accountId: r.accountId,
      date: r.date,
      amount: r.amount,
      payee: r.payee,
      memo: r.memo,
    });
    let list = byFingerprint.get(fp);
    if (!list) {
      list = [];
      byFingerprint.set(fp, list);
      order.push(fp);
    }
    list.push(r);
  }

  const groups: DuplicateGroup[] = [];
  for (const fp of order) {
    const list = byFingerprint.get(fp)!;
    if (list.length < 2) continue;
    const reconciled: DuplicateEntry[] = [];
    const nonReconciled: DuplicateEntry[] = [];
    for (const item of list) {
      if (item.status === "r") {
        reconciled.push(item);
      } else {
        nonReconciled.push(item);
      }
    }
    const sorted = [...reconciled, ...nonReconciled];
    groups.push({ fingerprint: fp, keeper: sorted[0]!, duplicates: sorted.slice(1) });
  }
  return groups;
}

/**
 * Build a fingerprint set from existing transactions for import deduplication.
 * Includes plain regular rows, split parents, and transfers. Split children
 * are excluded on the source account because their parent already represents
 * the full bank transaction amount.
 *
 * When rename rules are provided, fingerprints are added for both the stored
 * payee and the canonical renamed payee so subsequent imports match regardless
 * of when the rename rule was defined.
 */
export function buildExistingImportFingerprints(
  accountId: number,
  existing: Array<{
    accountId: number;
    transferAccountId?: number | null;
    parentId?: number | null;
    date: string;
    payee: string;
    memo?: string | null;
    amount: number | string;
  }>,
  accountNameById?: Map<number, string>,
  renameRules?: RenameRule[]
): Set<string> {
  const fingerprints = new Set<string>();

  for (const t of existing) {
    const amt = typeof t.amount === "number" ? Math.round(t.amount) : Math.round(Number(t.amount));
    if (t.accountId === accountId) {
      // Direct transaction on this account:
      // Exclude split children (t.parentId != null) because their split parent
      // (t.parentId == null) already represents the complete bank transaction.
      if (t.parentId != null) continue;
      fingerprints.add(
        duplicateFingerprint({
          accountId,
          date: t.date,
          amount: amt,
          payee: t.payee,
          memo: t.memo ?? "",
        })
      );
      if (renameRules && renameRules.length > 0) {
        const renamed = applyRenameRules(renameRules, t.payee);
        if (renamed !== t.payee) {
          fingerprints.add(
            duplicateFingerprint({
              accountId,
              date: t.date,
              amount: amt,
              payee: renamed,
              memo: t.memo ?? "",
            })
          );
        }
      }
    } else if (t.transferAccountId === accountId) {
      // Transfer where this account is the destination:
      // The incoming amount is opposite in sign to the stored transfer row.
      const destAmount = -amt;
      fingerprints.add(
        duplicateFingerprint({
          accountId,
          date: t.date,
          amount: destAmount,
          payee: t.payee,
          memo: t.memo ?? "",
        })
      );
      if (renameRules && renameRules.length > 0) {
        const renamed = applyRenameRules(renameRules, t.payee);
        if (renamed !== t.payee) {
          fingerprints.add(
            duplicateFingerprint({
              accountId,
              date: t.date,
              amount: destAmount,
              payee: renamed,
              memo: t.memo ?? "",
            })
          );
        }
      }
      if (accountNameById && accountNameById.has(t.accountId)) {
        const sourceName = accountNameById.get(t.accountId)!;
        const transferPayee = `Transfer : ${sourceName}`;
        fingerprints.add(
          duplicateFingerprint({
            accountId,
            date: t.date,
            amount: destAmount,
            payee: transferPayee,
            memo: t.memo ?? "",
          })
        );
        if (renameRules && renameRules.length > 0) {
          const renamed = applyRenameRules(renameRules, transferPayee);
          if (renamed !== transferPayee) {
            fingerprints.add(
              duplicateFingerprint({
                accountId,
                date: t.date,
                amount: destAmount,
                payee: renamed,
                memo: t.memo ?? "",
              })
            );
          }
        }
      }
    }
  }

  return fingerprints;
}

/**
 * Identify which incoming import rows duplicate existing transactions or
 * previous rows within the same batch.
 */
export function identifyImportDuplicates<
  T extends {
    rowNumber: number;
    date?: string | null;
    payee?: string | null;
    memo?: string | null;
    amountCents?: number | null;
    error?: string | null;
  }
>(
  accountId: number,
  existingFingerprints: Set<string>,
  rows: T[]
): {
  duplicateRowNumbers: Set<number>;
  duplicates: Array<{ rowNumber: number; reason: string; matchRowNumber?: number }>;
} {
  const duplicateRowNumbers = new Set<number>();
  const duplicates: Array<{ rowNumber: number; reason: string; matchRowNumber?: number }> = [];
  const batchSeen = new Map<string, number>();

  for (const row of rows) {
    if (row.error || row.date == null || row.amountCents == null) continue;
    const amount = Math.round(row.amountCents);
    if (amount === 0) continue;

    const fp = duplicateFingerprint({
      accountId,
      date: row.date,
      payee: row.payee ?? "",
      memo: row.memo ?? "",
      amount,
    });

    const matchRowNumber = batchSeen.get(fp);
    if (existingFingerprints.has(fp) || matchRowNumber != null) {
      duplicateRowNumbers.add(row.rowNumber);
      duplicates.push({
        rowNumber: row.rowNumber,
        reason:
          matchRowNumber != null
            ? `Duplicate of row ${matchRowNumber} in this file`
            : "Matches an existing transaction",
        matchRowNumber,
      });
    } else {
      batchSeen.set(fp, row.rowNumber);
    }
  }

  return { duplicateRowNumbers, duplicates };
}
