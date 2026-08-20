import type { ClearedStatus, TransactionFlagState } from "./types.js";

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
 */
export function duplicateFingerprint(f: {
  accountId: number;
  date: string;
  amount: number;
  payee: string;
  memo: string;
}): string {
  return [
    f.accountId,
    f.date,
    f.amount,
    normalizeText(f.payee),
    normalizeText(f.memo),
  ].join("|");
}

/**
 * Group rows into duplicate candidates. Only plain regular rows are
 * considered (see {@link DuplicateEntry}). Input order is preserved, so
 * the first occurrence in the input is the keeper of its group.
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
    groups.push({ fingerprint: fp, keeper: list[0]!, duplicates: list.slice(1) });
  }
  return groups;
}
