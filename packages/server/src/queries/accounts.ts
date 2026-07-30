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
