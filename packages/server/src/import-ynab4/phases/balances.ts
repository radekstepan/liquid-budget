import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../client.js";
import { accounts, categories, transactions } from "../../schema.js";
import { recomputeAccountBalances } from "../../queries/diagnostics.js";
import type { Ynab4ImportContext } from "../types.js";

export async function recomputeBalancesAndCcCarryover(
  db: Db,
  ctx: Ynab4ImportContext
): Promise<void> {
  // 6. Compute real balances of accounts
  await recomputeAccountBalances(db);
  const creditAccounts = await db.select().from(accounts).where(eq(accounts.kind, "credit"));

  // 6b. Initialize Credit Card Payment category carryover from card starting balance if present
  for (const acc of creditAccounts) {
    // Check if carryover was already set from exported CC Payment category
    const [existingCat] = await db
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.groupId, ctx.ccGroupId!),
          eq(categories.linkedAccountId, acc.id)
        )
      )
      .limit(1);

    if (existingCat && Number(existingCat.carryover) !== 0) {
      continue;
    }

    // Check opening debt via back-calculation: initialBalance = currentBalance - lifetimeDelta
    const [currAcc] = await db.select().from(accounts).where(eq(accounts.id, acc.id));
    const currentBal = Number(currAcc?.balance ?? 0);

    const outRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, acc.id),
          isNull(transactions.parentId)
        )
      );
    const inRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.transferAccountId, acc.id),
          isNotNull(transactions.transferAccountId),
          isNull(transactions.parentId)
        )
      );
    const lifetimeDelta = Number(outRes[0]?.sum || 0) - Number(inRes[0]?.sum || 0);
    const initialBalance = currentBal - lifetimeDelta;

    let openingDebt = 0;
    if (initialBalance < 0) {
      openingDebt = initialBalance;
    } else {
      // Find explicit starting balance transaction: match standard and multi-language starting payees
      const [startingTx] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, acc.id),
            isNull(transactions.parentId),
            isNull(transactions.transferAccountId),
            or(
              sql`lower(${transactions.payee}) like '%starting balance%'`,
              sql`lower(${transactions.payee}) like '%opening balance%'`,
              sql`lower(${transactions.payee}) like '%initial balance%'`,
              sql`lower(${transactions.payee}) like '%solde initial%'`,
              sql`lower(${transactions.payee}) like '%anfangssaldo%'`,
              sql`lower(${transactions.payee}) like '%saldo inicial%'`,
              sql`lower(${transactions.payee}) like '%saldo iniziale%'`,
              sql`lower(${transactions.payee}) like '%startsaldo%'`,
              sql`lower(${transactions.payee}) like '%beginsaldo%'`,
              sql`lower(${transactions.payee}) like '%debt balance%'`,
              sql`lower(${transactions.payee}) like '%old debt%'`,
              sql`lower(${transactions.payee}) like '%opening debt%'`
            )
          )
        )
        .orderBy(asc(transactions.date), asc(transactions.id))
        .limit(1);

      if (startingTx && Number(startingTx.amount) < 0) {
        openingDebt = Number(startingTx.amount);
      }
    }

    if (openingDebt < 0) {
      await db
        .update(categories)
        .set({ carryover: openingDebt })
        .where(
          and(
            eq(categories.groupId, ctx.ccGroupId!),
            eq(categories.linkedAccountId, acc.id)
          )
        );
    }
  }
}
