import { eq, sql } from "drizzle-orm";
import type { ClearedStatus } from "@ynab/logic";
import { assertSplitsBalanced, TransactionError } from "@ynab/logic";
import type { Database } from "../../client.js";
import { accounts, transactions } from "../../schema.js";
import type { SubTransactionInput } from "./types.js";

export async function applyBalance(db: Database, accountId: number, delta: number) {
  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${Math.round(delta)}` })
    .where(eq(accounts.id, accountId));
}

export async function getAccountName(db: Database, accountId: number): Promise<string | null> {
  const [row] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.name ?? null;
}

export async function childCount(db: Database, parentId: number): Promise<number> {
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.parentId, parentId));
  return rows.length;
}

export async function getChildren(
  db: Database,
  parentId: number
): Promise<{
  id: number;
  accountId: number;
  amount: number;
  transferAccountId: number | null;
  categoryId: number | null;
  memo: string;
  payee: string;
  payeeId: number | null;
  flagColor: string | null;
  status: ClearedStatus;
  transferStatus: ClearedStatus | null;
}[]> {
  return db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amount: transactions.amount,
      transferAccountId: transactions.transferAccountId,
      categoryId: transactions.categoryId,
      memo: transactions.memo,
      payee: transactions.payee,
      payeeId: transactions.payeeId,
      flagColor: transactions.flagColor,
      status: transactions.status,
      transferStatus: transactions.transferStatus,
    })
    .from(transactions)
    .where(eq(transactions.parentId, parentId));
}

/**
 * Validate that a set of sub-transactions constitutes a balanced split.
 * The rules are single-sourced in `@ynab/logic`'s `assertSplitsBalanced`
 * (BUG-18.3); this wrapper only converts the thrown error into a
 * `TransactionError` so API routes surface it as a 4xx response.
 */

export function assertSplitsBalancedOr4xx(
  parentAmount: number,
  children: SubTransactionInput[]
): void {
  assertSplitsBalanced(parentAmount, children, (message) => new TransactionError(message, 400));
}

/**
 * Insert a single transaction row. Branches on `transferAccountId` to
 * perform a transfer (one row, mirrored balance updates) versus a plain
   * Reconciled status is never set by direct insert — only the reconcile
   * flow may set `"r"`. This keeps a single source of truth for the
   * "lastReconciledAt" account metadata and prevents orphan-R rows.
   */
