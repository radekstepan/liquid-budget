import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assignments } from "../schema.js";

export type UpsertAssignmentInput = {
  categoryId: number;
  month: string;
  amount: number;
};

export async function upsertAssignment(db: Database, input: UpsertAssignmentInput) {
  const existing = await db
    .select()
    .from(assignments)
    .where(
      and(eq(assignments.categoryId, input.categoryId), eq(assignments.month, input.month))
    );

  if (existing.length > 0) {
    const [row] = await db
      .update(assignments)
      .set({ amount: input.amount })
      .where(eq(assignments.id, existing[0]!.id))
      .returning();
    return row;
  }

  const [row] = await db
    .insert(assignments)
    .values({ categoryId: input.categoryId, month: input.month, amount: input.amount })
    .returning();
  return row;
}
