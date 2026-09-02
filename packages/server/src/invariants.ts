import { TransactionError } from "@ynab/logic";

export type InvariantSubTransaction = {
  id?: number | null;
  amount?: number;
  categoryId?: number | null;
  transferAccountId?: number | null;
  [key: string]: unknown;
};

export type InvariantEntity = {
  accountId?: number | null;
  transferAccountId?: number | null;
  parentId?: number | null;
  subTransactions?: readonly InvariantSubTransaction[] | null;
  [key: string]: unknown;
};

export type TransactionRow = InvariantEntity;
export type RecurringRow = InvariantEntity;

/**
 * Centralized entity invariant assertions enforced at the DB mutation layer.
 *
 * Invariant 1: A split transaction cannot also be a transfer.
 * Invariant 2: A transfer destination cannot be the source account (at root or within subtransactions).
 */
export function assertEntityInvariants(tx: TransactionRow | RecurringRow): void {
  // Invariant 1: Cannot be both a split parent and a transfer
  if (tx.transferAccountId != null && tx.subTransactions?.length) {
    throw new TransactionError("Split transaction cannot be a transfer", 400);
  }
  // Invariant 2: Cannot have a transfer to the same account
  if (tx.transferAccountId != null && tx.accountId != null && tx.transferAccountId === tx.accountId) {
    throw new TransactionError("Transfer destination cannot be the source account", 422);
  }
  // Invariant 2 (subtransactions): Nested split transfers cannot target the source account
  if (tx.subTransactions?.length && tx.accountId != null) {
    for (const sub of tx.subTransactions) {
      if (sub.transferAccountId != null && sub.transferAccountId === tx.accountId) {
        throw new TransactionError("Transfer destination cannot be the source account", 422);
      }
    }
  }
}
