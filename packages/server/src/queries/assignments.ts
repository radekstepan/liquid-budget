import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assignments } from "../schema.js";

export type UpsertAssignmentInput = {
  categoryId: number;
  month: string;
  amount: number;
};

export async function upsertAssignment(db: Database, input: UpsertAssignmentInput) {
  const amountStr = input.amount.toFixed(2);
  const existing = await db
    .select()
    .from(assignments)
    .where(
      and(eq(assignments.categoryId, input.categoryId), eq(assignments.month, input.month))
    );

  if (existing.length > 0) {
    const [row] = await db
      .update(assignments)
      .set({ amount: amountStr })
      .where(eq(assignments.id, existing[0]!.id))
      .returning();
    return row;
  }

  const [row] = await db
    .insert(assignments)
    .values({ categoryId: input.categoryId, month: input.month, amount: amountStr })
    .returning();
  return row;
}
