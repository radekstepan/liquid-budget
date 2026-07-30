import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts } from "../schema.js";

export type CreateAccountInput = {
  name: string;
  kind?: string;
  groupLabel?: string;
  balance?: number;
  onBudget?: boolean;
};

export type UpdateAccountInput = {
  name?: string;
  kind?: "liquid" | "credit" | "offbudget";
  groupLabel?: string;
  balance?: number;
  onBudget?: boolean;
  sort?: number;
};

export async function createAccount(db: Database, input: CreateAccountInput) {
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${accounts.sort}), -1)` })
    .from(accounts);
  const [row] = await db
    .insert(accounts)
    .values({
      name: String(input.name),
      kind: String(input.kind ?? "liquid"),
      groupLabel: String(input.groupLabel ?? "Liquid"),
      balance: Number(input.balance) || 0,
      onBudget: input.onBudget ?? true,
      sort: Number(maxRow?.max ?? -1) + 1,
    })
    .returning();
  return row;
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
  if (patch.balance != null) p.balance = Number(patch.balance) || 0;
  if (patch.onBudget != null) p.onBudget = !!patch.onBudget;
  if (patch.sort != null) p.sort = Number(patch.sort);
  const [row] = await db.update(accounts).set(p).where(eq(accounts.id, id)).returning();
  return row;
}

export async function deleteAccount(db: Database, id: number) {
  await db.delete(accounts).where(eq(accounts.id, id));
}

export async function listAccounts(db: Database) {
  return db.select().from(accounts).orderBy(accounts.sort);
}
