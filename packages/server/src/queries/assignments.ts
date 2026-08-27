import type { Database } from "../client.js";
import { withTransaction } from "../transaction.js";
import { assignments } from "../schema.js";
import { assertValidAmount, assertValidISOMonth } from "./transactions.js";

export type UpsertAssignmentInput = {
  categoryId: number;
  month: string;
  amount: number;
};

export async function upsertAssignment(db: Database, input: UpsertAssignmentInput) {
  const amount = assertValidAmount(input.amount, { allowZero: true });
  const validatedMonth = assertValidISOMonth(input.month, "month");
  return withTransaction(db, async () => {
    const [row] = await db
      .insert(assignments)
      .values({ categoryId: input.categoryId, month: validatedMonth, amount })
      .onConflictDoUpdate({
        target: [assignments.categoryId, assignments.month],
        set: { amount },
      })
      .returning();
    return row;
  });
}

