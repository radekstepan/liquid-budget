import type { Database } from "../client.js";
import { withTransaction } from "../transaction.js";
import { assignments } from "../schema.js";
import { assertValidAmount } from "./transactions.js";

export type UpsertAssignmentInput = {
  categoryId: number;
  month: string;
  amount: number;
};

export async function upsertAssignment(db: Database, input: UpsertAssignmentInput) {
  const amount = assertValidAmount(input.amount);
  return withTransaction(db, async () => {
    const [row] = await db
      .insert(assignments)
      .values({ categoryId: input.categoryId, month: input.month, amount })
      .onConflictDoUpdate({
        target: [assignments.categoryId, assignments.month],
        set: { amount },
      })
      .returning();
    return row;
  });
}

