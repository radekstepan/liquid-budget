import { eq, asc, or, and, isNull } from "drizzle-orm";
import type { Db } from "../client.js";
import { payees, transactions, recurring } from "../schema.js";
import { withTransaction } from "../transaction.js";

export type PayeeRow = typeof payees.$inferSelect;
export type CreatePayeeInput = {
  name: string;
  autoCategoryId?: number | null;
};
export type UpdatePayeeInput = {
  name?: string;
  autoCategoryId?: number | null;
};

export function getPayees(db: Db): PayeeRow[] {
  return db.select().from(payees).orderBy(asc(payees.name)).all();
}

export function getPayeeById(db: Db, id: number): PayeeRow | null {
  const row = db.select().from(payees).where(eq(payees.id, id)).get();
  return row ?? null;
}

export function getPayeeByName(db: Db, name: string): PayeeRow | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const row = db.select().from(payees).where(eq(payees.name, trimmed)).get();
  return row ?? null;
}

export function findOrCreatePayee(
  db: Db,
  name: string,
  autoCategoryId?: number | null
): PayeeRow {
  const trimmed = name.trim();
  const existing = getPayeeByName(db, trimmed);
  if (existing) {
    if (autoCategoryId !== undefined && autoCategoryId !== existing.autoCategoryId) {
      db.update(payees)
        .set({ autoCategoryId })
        .where(eq(payees.id, existing.id))
        .run();
      return { ...existing, autoCategoryId };
    }
    return existing;
  }

  const now = new Date().toISOString();
  const inserted = db
    .insert(payees)
    .values({
      name: trimmed,
      autoCategoryId: autoCategoryId ?? null,
      createdAt: now,
    })
    .returning()
    .get();

  return inserted;
}

export async function updatePayee(
  db: Db,
  id: number,
  patch: UpdatePayeeInput
): Promise<PayeeRow | null> {
  const current = getPayeeById(db, id);
  if (!current) return null;

  const updates: Partial<typeof payees.$inferInsert> = {};
  if (patch.name !== undefined) {
    updates.name = patch.name.trim();
  }
  if (patch.autoCategoryId !== undefined) {
    updates.autoCategoryId = patch.autoCategoryId;
  }

  if (Object.keys(updates).length === 0) return current;

  return withTransaction(db, async () => {
    const updated = db
      .update(payees)
      .set(updates)
      .where(eq(payees.id, id))
      .returning()
      .get();

    // If payee name changed, propagate to transactions and recurring referencing this payeeId or name
    if (patch.name !== undefined && patch.name.trim() !== current.name) {
      const newName = patch.name.trim();
      const oldName = current.name;

      // Best-effort cascade: Rows linked by payeeId are always updated.
      // Text fallback is restricted to regular, non-transfer, non-split-child rows
      // (BUG-22) so that transfer legs and split sub-transactions are never rewritten by accident.
      const txCondition = oldName
        ? or(
            eq(transactions.payeeId, id),
            and(
              eq(transactions.payee, oldName),
              isNull(transactions.parentId),
              isNull(transactions.transferAccountId)
            )
          )
        : eq(transactions.payeeId, id);

      db.update(transactions)
        .set({ payee: newName })
        .where(txCondition)
        .run();

      const recCondition = oldName
        ? or(
            eq(recurring.payeeId, id),
            and(
              eq(recurring.payee, oldName),
              isNull(recurring.transferAccountId)
            )
          )
        : eq(recurring.payeeId, id);

      db.update(recurring)
        .set({ payee: newName })
        .where(recCondition)
        .run();
    }

    return updated ?? null;
  });
}

export function deletePayee(db: Db, id: number): boolean {
  const res = db.delete(payees).where(eq(payees.id, id)).run();
  return res.changes > 0;
}
