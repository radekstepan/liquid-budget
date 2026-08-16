import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts, transactions } from "../schema.js";

export type BalanceIntegrityReport = {
  accountId: number;
  accountName: string;
  storedBalance: number;
  computedBalance: number;
  difference: number;
};

/**
 * Audit all accounts in the database and verify that `account.balance` equals
 * the sum of all direct transaction amounts minus incoming transfer amounts
 * (excluding split parent rows which are non-balance bearing).
 */
export async function verifyBalanceIntegrity(db: Database): Promise<BalanceIntegrityReport[]> {
  const allAccounts = await db.select().from(accounts);
  const issues: BalanceIntegrityReport[] = [];

  for (const acct of allAccounts) {
    const outRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, acct.id),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    const inRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.transferAccountId, acct.id),
          isNotNull(transactions.transferAccountId),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    const outgoing = Number(outRes[0]?.sum ?? 0);
    const incomingFromTransfers = Number(inRes[0]?.sum ?? 0);
    const computedBalance = outgoing - incomingFromTransfers;
    const storedBalance = Number(acct.balance ?? 0);

    if (computedBalance !== storedBalance) {
      issues.push({
        accountId: acct.id,
        accountName: acct.name,
        storedBalance,
        computedBalance,
        difference: storedBalance - computedBalance,
      });
    }
  }

  return issues;
}

/**
 * Recompute every account's `balance` from the current set of transactions
 * and update the accounts table.
 */
export async function recomputeAccountBalances(
  db: Database
): Promise<{ updatedCount: number }> {
  const allAccounts = await db.select().from(accounts);
  let updatedCount = 0;

  for (const acct of allAccounts) {
    const outRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, acct.id),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    const inRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.transferAccountId, acct.id),
          isNotNull(transactions.transferAccountId),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    const outgoing = Number(outRes[0]?.sum ?? 0);
    const incomingFromTransfers = Number(inRes[0]?.sum ?? 0);
    const sum = outgoing - incomingFromTransfers;

    if (Number(acct.balance) !== sum) {
      await db.update(accounts).set({ balance: sum }).where(eq(accounts.id, acct.id));
      updatedCount++;
    }
  }

  return { updatedCount };
}
