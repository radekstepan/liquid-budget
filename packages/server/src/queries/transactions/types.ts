import type { ClearedStatus, TransactionFlagColor } from "@ynab/logic";
import { transactions } from "../../schema.js";

export type CreateTransactionInput = {
  accountId: number;
  categoryId?: number | null;
  date: string;
  payee?: string;
  memo?: string;
  amount: number;
  status?: ClearedStatus;
  transferStatus?: ClearedStatus;
  /** YNAB4-style flag color; null/undefined leaves the row unflagged. */
  flagColor?: TransactionFlagColor | null;
  /**
   * If set, this row is one half of a transfer. The other side is the
   * destination account identified by `transferAccountId`; no row is
   * created there, but its balance is updated in the opposite direction
   * so the destination's running total stays accurate. The `categoryId`
   * is forced to null for transfers.
   */
  transferAccountId?: number | null;
  /**
   * If set, this row is a child of a split transaction. The parent's
   * `amount` is informational (the sum of children) and is not applied
   * to balance; each child IS applied to balance independently.
   */
  parentId?: number | null;
  /**
   * Suppress the balance update for this insert. Used for split parents,
   * whose balance effect is the sum of their children. Has no effect on
   * child rows (children always apply their own balance).
   */
  skipBalance?: boolean;
  isIncome?: boolean;
  incomeMonth?: string | null;
  /**
   * Flag the row as freshly arrived (rendered bold until reviewed).
   * Set by scheduled posting and CSV import; manual entry leaves it false.
   */
  needsReview?: boolean;
  /**
   * Explicit row id. Only the scheduled-posting re-post path sets this:
   * when a previously posted occurrence was deleted, its freed id is
   * reused so the re-post restores the same row (YNAB4's deterministic
   * `scheduleId_date_count` id is stable across delete/re-post).
   */
  id?: number | null;
  /**
   * Explicit entity id. The scheduled-posting path stamps deterministic
   * `<schedule>_<date>_<count>` ids (YNAB4 `YNABGuidCreator`
   * `createTransactionIdForEnteredScheduledTransaction`); everything else
   * leaves this null.
   */
  entityId?: string | null;
};

export type UpdateTransactionInput = {
  accountId?: number;
  categoryId?: number | null;
  transferAccountId?: number | null;
  date?: string;
  payee?: string;
  memo?: string;
  amount?: number;
  status?: ClearedStatus;
  transferStatus?: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
  isIncome?: boolean;
  incomeMonth?: string | null;
};

export type SubTransactionInput = {
  id?: number | null;
  /**
   * Category or transfer account for the sub-transaction.
   */
  categoryId?: number | null;
  transferAccountId?: number | null;
  transferStatus?: ClearedStatus;
  amount: number;
  memo?: string;
  payee?: string;
};

export type UpdateSplitParentFields = {
  amount?: number;
  date?: string;
  payee?: string;
  memo?: string;
  status?: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
  /** Checked defensively; split parents cannot be transfers. */
  transferAccountId?: number | null;
};

export type MergeTransactionsResult = {
  merged: typeof transactions.$inferSelect;
  deletedId: number;
};

/**
 * Merge exactly two transactions into one (YNAB4-style).
 *
 * The imported row (fresh CSV import or YNAB4 backup row) survives and
 * the other is deleted; field-level priority is resolved by
 * `resolveMergedTransaction` — imported bank data wins every field it
 * carries, manual curation fills the gaps. `overrides` (user edits from
 * the merge preview modal) win over the resolution, with
 * category/income recomputed from the final shape like the edit path.
 * Both old balance effects are reversed and the merged effect applied,
 * so merging a duplicate leaves exactly one balance impact.
 *
 * Reconciled (locked) rows and split parents/children are rejected, like
 * the delete/edit paths.
 */
