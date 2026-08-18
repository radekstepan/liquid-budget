import { eq, asc } from "drizzle-orm";
import type { Db } from "../client.js";
import { payees, transactions, recurring } from "../schema.js";

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

export function updatePayee(
  db: Db,
  id: number,
  patch: UpdatePayeeInput
): PayeeRow | null {
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

  return db.transaction((tx) => {
    const updated = tx
      .update(payees)
      .set(updates)
      .where(eq(payees.id, id))
      .returning()
      .get();

    // If payee name changed, propagate to transactions and recurring referencing this payeeId
    if (patch.name !== undefined && patch.name.trim() !== current.name) {
      const newName = patch.name.trim();
      tx.update(transactions)
        .set({ payee: newName })
        .where(eq(transactions.payeeId, id))
        .run();

      tx.update(recurring)
        .set({ payee: newName })
        .where(eq(recurring.payeeId, id))
        .run();
    }

    return updated ?? null;
  });
}

export function deletePayee(db: Db, id: number): boolean {
  const res = db.delete(payees).where(eq(payees.id, id)).run();
  return res.changes > 0;
}
