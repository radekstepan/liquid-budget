import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts, categories, recurring, recurringSubTransactions, transactions } from "../schema.js";
import { assertValidAmount } from "./transactions.js";

export class AccountError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "AccountError";
  }
}

export type CreateAccountInput = {
  name: string;
  kind?: string;
  groupLabel?: string;
  balance?: number;
  onBudget?: boolean;
  archived?: boolean;
};

export type UpdateAccountInput = {
  name?: string;
  kind?: "liquid" | "credit" | "offbudget";
  groupLabel?: string;
  onBudget?: boolean;
  sort?: number;
  archived?: boolean;
};

export async function createAccount(db: Database, input: CreateAccountInput) {
  const balance = input.balance != null ? assertValidAmount(input.balance) : 0;
  db.run(sql`BEGIN`);
  try {
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${accounts.sort}), -1)` })
      .from(accounts);
    const [row] = await db
      .insert(accounts)
      .values({
        name: String(input.name),
        kind: String(input.kind ?? "liquid"),
        groupLabel: String(input.groupLabel ?? "Liquid"),
        balance,
        onBudget: input.onBudget ?? true,
        sort: Number(maxRow?.max ?? -1) + 1,
        archived: input.archived ?? false,
      })
      .returning();
    db.run(sql`COMMIT`);
    return row;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

export async function getAccount(db: Database, id: number) {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return row;
}

export async function updateAccount(db: Database, id: number, patch: UpdateAccountInput) {
  const p: Record<string, unknown> = {};
  if (patch.name != null) p.name = String(patch.name);
  if (patch.kind != null) p.kind = String(patch.kind);
  if (patch.groupLabel != null) p.groupLabel = String(patch.groupLabel);
  if (patch.onBudget != null) p.onBudget = !!patch.onBudget;
  if (patch.sort != null) p.sort = Number(patch.sort);
  if (patch.archived != null) p.archived = !!patch.archived;
  const [row] = await db.update(accounts).set(p).where(eq(accounts.id, id)).returning();
  return row;
}

/**
 * Delete an account cleanly.
 *
 * To avoid creating half-transfers (where the counterparty row in another account
 * has its transferAccountId set to NULL and becomes an orphaned uncategorized
 * transaction or phantom income), we explicitly find and delete all counterparty
 * transactions pointing to this account, reversing their balance effects,
 * as well as recurring transfer rules and linked categories.
 */
export async function deleteAccount(db: Database, id: number) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!account) return null;

  db.run(sql`BEGIN`);
  try {
    // 1. Clean up transfer counterparty transactions where transferAccountId = id
    const counterparties = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        parentId: transactions.parentId,
      })
      .from(transactions)
      .where(eq(transactions.transferAccountId, id));

    for (const cp of counterparties) {
      await db
        .update(accounts)
        .set({ balance: sql`${accounts.balance} - ${Number(cp.amount)}` })
        .where(eq(accounts.id, cp.accountId));
      await db.delete(transactions).where(eq(transactions.id, cp.id));
    }

    // 2. Clean up recurring transfer counterparties
    await db.delete(recurring).where(eq(recurring.transferAccountId, id));
    await db.delete(recurringSubTransactions).where(eq(recurringSubTransactions.transferAccountId, id));

    // 3. Clean up linked categories (e.g. credit card payment categories)
    await db.delete(categories).where(eq(categories.linkedAccountId, id));

    // 4. Delete the account itself (SQLite cascade handles own transactions/recurring)
    await db.delete(accounts).where(eq(accounts.id, id));

    db.run(sql`COMMIT`);
    return account;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

export async function listAccounts(db: Database) {
  return db.select().from(accounts).orderBy(accounts.sort);
}
