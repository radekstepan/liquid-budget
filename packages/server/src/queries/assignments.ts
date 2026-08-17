import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { assignments } from "../schema.js";

export type UpsertAssignmentInput = {
  categoryId: number;
  month: string;
  amount: number;
};

export async function upsertAssignment(db: Database, input: UpsertAssignmentInput) {
  db.run(sql`BEGIN`);
  try {
    const [row] = await db
      .insert(assignments)
      .values({ categoryId: input.categoryId, month: input.month, amount: input.amount })
      .onConflictDoUpdate({
        target: [assignments.categoryId, assignments.month],
        set: { amount: input.amount },
      })
      .returning();
    db.run(sql`COMMIT`);
    return row;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}
