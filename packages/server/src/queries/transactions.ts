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

export type UpdateTransactionInput = {
  accountId?: number;
  categoryId?: number | null;
  date?: string;
  payee?: string;
  memo?: string;
  amount?: number;
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

export async function updateTransaction(db: Database, id: number, patch: UpdateTransactionInput) {
  const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!existing) return null;

  const p: Record<string, unknown> = {};
  if (patch.accountId != null) p.accountId = Number(patch.accountId);
  if ("categoryId" in patch) p.categoryId = patch.categoryId ?? null;
  if (patch.date != null) p.date = String(patch.date);
  if (patch.payee != null) p.payee = String(patch.payee);
  if (patch.memo != null) p.memo = String(patch.memo);
  if (patch.amount != null) p.amount = Number(patch.amount);
  if (patch.cleared != null) p.cleared = !!patch.cleared;

  const newAccountId = (p.accountId as number | undefined) ?? existing.accountId;
  const newAmount = (p.amount as number | undefined) ?? Number(existing.amount);

  const [row] = await db.update(transactions).set(p).where(eq(transactions.id, id)).returning();

  // If account or amount changed, reverse the old balance change and apply the new one.
  if (newAccountId !== existing.accountId || newAmount !== Number(existing.amount)) {
    await applyBalance(db, existing.accountId, -Number(existing.amount));
    if (newAccountId !== existing.accountId) {
      await applyBalance(db, newAccountId, newAmount);
    } else {
      await applyBalance(db, newAccountId, newAmount - Number(existing.amount));
    }
  }

  return row;
}

export async function deleteTransaction(db: Database, id: number) {
  const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!existing) return null;
  await db.delete(transactions).where(eq(transactions.id, id));
  await applyBalance(db, existing.accountId, -Number(existing.amount));
  return existing;
}
