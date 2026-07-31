import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { recurring } from "../schema.js";

export type CreateRecurringInput = {
  accountId: number;
  categoryId: number | null;
  payee: string;
  amount: number;
  frequency: string;
  nextDate: string;
  active?: boolean;
};

export type UpdateRecurringInput = {
  accountId?: number;
  categoryId?: number | null;
  payee?: string;
  amount?: number;
  frequency?: string;
  nextDate?: string;
  active?: boolean;
};

export async function createRecurring(db: Database, input: CreateRecurringInput) {
  const [row] = await db
    .insert(recurring)
    .values({
      accountId: input.accountId,
      categoryId: input.categoryId,
      payee: input.payee,
      amount: input.amount,
      frequency: input.frequency,
      nextDate: input.nextDate,
      active: input.active ?? true,
    })
    .returning();
  return row;
}

export async function updateRecurring(db: Database, id: number, patch: UpdateRecurringInput) {
  const p: Record<string, unknown> = {};
  if (patch.accountId != null) p.accountId = Number(patch.accountId);
  if ("categoryId" in patch) p.categoryId = patch.categoryId ?? null;
  if (patch.payee != null) p.payee = String(patch.payee);
  if (patch.amount != null) p.amount = Number(patch.amount);
  if (patch.frequency != null) p.frequency = String(patch.frequency);
  if (patch.nextDate != null) p.nextDate = String(patch.nextDate);
  if (patch.active != null) p.active = !!patch.active;
  const [row] = await db.update(recurring).set(p).where(eq(recurring.id, id)).returning();
  return row;
}

export async function deleteRecurring(db: Database, id: number) {
  await db.delete(recurring).where(eq(recurring.id, id));
}
