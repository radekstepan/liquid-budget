import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts, transactions } from "../schema.js";

export type CreateTransactionInput = {
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  cleared?: boolean;
};

async function applyBalance(db: Database, accountId: number, delta: number) {
  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${delta.toFixed(2)}` })
    .where(eq(accounts.id, accountId));
}

export async function createTransaction(db: Database, input: CreateTransactionInput) {
  const [row] = await db
    .insert(transactions)
    .values({
      accountId: input.accountId,
      categoryId: input.categoryId,
      date: input.date,
      payee: input.payee,
      memo: input.memo,
      amount: input.amount,
      cleared: input.cleared ?? true,
    })
    .returning();

  await applyBalance(db, input.accountId, input.amount);
  return row;
}

export async function deleteTransaction(db: Database, id: number) {
  const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!existing) return null;
  await db.delete(transactions).where(eq(transactions.id, id));
  await applyBalance(db, existing.accountId, -Number(existing.amount));
  return existing;
}
