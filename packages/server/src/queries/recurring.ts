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

export async function createRecurring(db: Database, input: CreateRecurringInput) {
  const [row] = await db
    .insert(recurring)
    .values({
      accountId: input.accountId,
      categoryId: input.categoryId,
      payee: input.payee,
      amount: input.amount.toFixed(2),
      frequency: input.frequency,
      nextDate: input.nextDate,
      active: input.active ?? true,
    })
    .returning();
  return row;
}

export async function deleteRecurring(db: Database, id: number) {
  await db.delete(recurring).where(eq(recurring.id, id));
}
