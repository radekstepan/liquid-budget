import type { ClearedStatus, TransactionFlagColor, TransactionFlagState } from "./types.js";
import { classifyBoundaryTransfer } from "./transfers.js";
import { isTransferPayee } from "./rename-rules.js";

/**
 * merge.ts
 *
 * YNAB4-style merging of two register transactions into one.
 *
 * When a manually entered transaction duplicates an imported one (same
 * purchase, entered by hand and later confirmed by a bank statement), the
 * user selects both rows and merges them. The imported row is the
 * authority: its bank-supplied data (date, amount, payee, cleared status)
 * wins every field it actually carries, while manual curation (category,
 * memo, flag) fills the gaps the import left empty.
 */

// Local copy of the YNAB4 palette (see TRANSACTION_FLAG_COLORS in
// index.js): kept here so this module does not import the package index.
const FLAG_COLORS: ReadonlySet<string> = new Set([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
]);

/** The fields merge resolution reads. Amounts are integer cents. */
export type MergeableTransaction = {
  id: number;
  accountId: number;
  transferAccountId: number | null;
  categoryId: number | null;
  date: string;
  payee: string;
  payeeId?: number | null;
  memo: string;
  amount: number;
  status: ClearedStatus;
  transferStatus?: ClearedStatus | null;
  flagColor?: TransactionFlagState;
  needsReview?: boolean | null;
  entityId?: string | null;
  transferEntityId?: string | null;
  isIncome?: boolean | null;
  incomeMonth?: string | null;
};

export type MergeAccountInfo = {
  onBudget: boolean;
  kind: string;
};

export type MergedTransactionFields = {
  accountId: number;
  transferAccountId: number | null;
  categoryId: number | null;
  date: string;
  payee: string;
  payeeId: number | null;
  memo: string;
  amount: number;
  status: ClearedStatus;
  transferStatus: ClearedStatus | null;
  flagColor: TransactionFlagColor | null;
  isIncome: boolean;
  incomeMonth: string | null;
  needsReview: boolean;
  entityId: string | null;
  transferEntityId: string | null;
};

/**
 * True for rows that arrived via an import rather than manual entry:
 * fresh CSV rows still awaiting review, or rows carrying a YNAB4 backup
 * entity id. Manually created rows have neither marker.
 */
export function isImportedTransaction(
  t: Pick<MergeableTransaction, "needsReview" | "entityId">
): boolean {
  if (t.needsReview === true) return true;
  return t.entityId != null && t.entityId !== "";
}

/**
 * Order a merge pair as [primary, secondary]. The imported row is
 * primary (its data wins); when both rows share import status the lower
 * id wins so the outcome never depends on selection order.
 */
export function pickMergePrimary<T extends MergeableTransaction>(a: T, b: T): [T, T] {
  const aImported = isImportedTransaction(a);
  const bImported = isImportedTransaction(b);
  if (aImported !== bImported) return aImported ? [a, b] : [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
}

function validFlagColor(value: unknown): TransactionFlagColor | null {
  if (typeof value !== "string") return null;
  return FLAG_COLORS.has(value) ? (value as TransactionFlagColor) : null;
}

/**
 * Resolve the merged row's fields from a [primary, secondary] pair (see
 * {@link pickMergePrimary}).
 *
 *   - Shape (account, transfer leg, amount, date, cleared status) always
 *     comes from the primary — the imported bank record.
 *   - Payee, memo, category, flag and income month fall back to the
 *     secondary when the primary left them empty, so manual curation is
 *     preserved instead of discarded.
 *   - Category/income are recomputed from the resolved category against
 *     the source (and destination, for transfers) account, mirroring
 *     creation semantics: off-budget rows stay uncategorized, credit
 *     rows are never income, and only uncategorized positive liquid
 *     inflows count as income.
 *   - The internal "duplicate" flag marker is never carried over: merging
 *     resolves the duplication.
 */
export function resolveMergedTransaction(args: {
  primary: MergeableTransaction;
  secondary: MergeableTransaction;
  sourceAccount: MergeAccountInfo;
  destAccount: Pick<MergeAccountInfo, "onBudget"> | null;
}): MergedTransactionFields {
  const { primary: p, secondary: s, sourceAccount, destAccount } = args;
  const transferAccountId = p.transferAccountId ?? null;
  const isTransfer = transferAccountId != null;
  const amount = p.amount;

  let payee: string;
  let payeeId: number | null;
  if (isTransfer) {
    payee = p.payee;
    payeeId = p.payeeId ?? null;
  } else {
    const primaryUsable = p.payee.trim() !== "" && !isTransferPayee(p.payee);
    const secondaryUsable = s.payee.trim() !== "" && !isTransferPayee(s.payee);
    if (primaryUsable) {
      payee = p.payee;
      payeeId = p.payeeId ?? null;
    } else if (secondaryUsable) {
      payee = s.payee;
      payeeId = s.payeeId ?? null;
    } else {
      payee = p.payee;
      payeeId = p.payeeId ?? null;
    }
  }

  const memo = p.memo.trim() !== "" ? p.memo : s.memo;

  let categoryId: number | null;
  let isIncome: boolean;
  let incomeMonth: string | null;
  if (isTransfer) {
    // Reclassify from the primary's own stored values: a valid transfer
    // reproduces its boundary category/income exactly, while a
    // same-boundary transfer stays uncategorized (the secondary's
    // regular-transaction category must never leak onto a transfer).
    const classification = classifyBoundaryTransfer({
      srcOnBudget: sourceAccount.onBudget,
      destOnBudget: destAccount?.onBudget ?? true,
      amount,
      categoryId: p.categoryId ?? null,
      incomeMonth: p.incomeMonth ?? null,
    });
    categoryId = classification.categoryId;
    isIncome = classification.isIncome;
    incomeMonth = classification.incomeMonth;
  } else if (!sourceAccount.onBudget) {
    categoryId = null;
    isIncome = false;
    incomeMonth = null;
  } else if (sourceAccount.kind === "credit") {
    categoryId = p.categoryId ?? s.categoryId ?? null;
    isIncome = false;
    incomeMonth = null;
  } else {
    categoryId = p.categoryId ?? s.categoryId ?? null;
    isIncome = categoryId == null && amount > 0;
    incomeMonth = isIncome ? (p.incomeMonth ?? s.incomeMonth ?? null) : null;
  }

  return {
    accountId: p.accountId,
    transferAccountId,
    categoryId,
    date: p.date,
    payee,
    payeeId,
    memo,
    amount,
    status: p.status,
    transferStatus: isTransfer ? (p.transferStatus ?? p.status) : null,
    flagColor: validFlagColor(p.flagColor) ?? validFlagColor(s.flagColor) ?? null,
    isIncome,
    incomeMonth,
    needsReview: p.needsReview === true,
    entityId: p.entityId ?? null,
    transferEntityId: isTransfer ? (p.transferEntityId ?? null) : null,
  };
}
