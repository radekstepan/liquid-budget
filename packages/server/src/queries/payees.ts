import { eq, asc, or, and, isNull, inArray } from "drizzle-orm";
import { isTransferPayee } from "@ynab/logic";
import type { Db } from "../client.js";
import { categories, payees, transactions, recurring } from "../schema.js";
import { withTransaction } from "../transaction.js";
import { learnRenameRuleFromPayees } from "./rename-rules.js";

export class PayeeError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "PayeeError";
  }
}

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
  autoCategoryId?: number | null,
  entityId?: string | null
): PayeeRow {
  const trimmed = name.trim();
  const existing = getPayeeByName(db, trimmed);
  if (existing) {
    const patch: Partial<typeof payees.$inferInsert> = {};
    if (autoCategoryId !== undefined && autoCategoryId !== existing.autoCategoryId) {
      patch.autoCategoryId = autoCategoryId;
    }
    if (entityId !== undefined && entityId && !existing.entityId) {
      patch.entityId = entityId;
    }
    if (Object.keys(patch).length > 0) {
      db.update(payees)
        .set(patch)
        .where(eq(payees.id, existing.id))
        .run();
      return { ...existing, ...patch };
    }
    return existing;
  }

  const now = new Date().toISOString();
  const inserted = db
    .insert(payees)
    .values({
      entityId: entityId ?? null,
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
    const next = patch.name.trim();
    if (!next) throw new PayeeError("Payee name cannot be empty", 400);
    if (next.length > 255) throw new PayeeError("Payee name is too long", 400);
    if (isTransferPayee(next)) {
      throw new PayeeError(
        'Payees like "Transfer : <account>" are managed by transfers, not the payee manager',
        400
      );
    }
    updates.name = next;
  }
  if (patch.autoCategoryId !== undefined) {
    if (patch.autoCategoryId != null) {
      const cat = db.select().from(categories).where(eq(categories.id, patch.autoCategoryId)).get();
      if (!cat) throw new PayeeError("Default category does not exist", 400);
    }
    updates.autoCategoryId = patch.autoCategoryId;
  }

  if (Object.keys(updates).length === 0) return current;

  if (updates.name !== undefined && updates.name !== current.name) {
    const clash = getPayeeByName(db, updates.name);
    if (clash && clash.id !== id) {
      throw new PayeeError(
        `A payee named "${updates.name}" already exists. Merge them instead of renaming.`,
        409
      );
    }
  }

  // Seed a rename rule when the payee itself is renamed so future CSV
  // imports arrive with the curated name. Learned after the commit so a
  // rule-learning failure never rolls back (or blocks) the rename itself.
  const nextName = updates.name;

  const result = await withTransaction(db, async () => {
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

  if (nextName !== undefined && nextName !== current.name) {
    try {
      await learnRenameRuleFromPayees(db, current.name, nextName);
    } catch (learnErr) {
      console.error("[payees] failed to learn rename rule:", learnErr);
    }
  }

  return result;
}

export function deletePayee(db: Db, id: number): boolean {
  const res = db.delete(payees).where(eq(payees.id, id)).run();
  return res.changes > 0;
}

/**
 * Merge source payees into a target payee (YNAB4-style).
 *
 * Every transaction and recurring rule linked to a source — by `payeeId`
 * or, for legacy text-only rows, by exact payee name on regular rows —
 * is repointed at the target (adopting the target's name), then the
 * source payee rows are deleted. Transfer rows and split sub-rows without
 * an explicit `payeeId` are never rewritten (same BUG-22 guard as rename).
 */
export async function mergePayees(
  db: Db,
  targetId: number,
  sourceIds: number[]
): Promise<PayeeRow | null> {
  const target = getPayeeById(db, targetId);
  if (!target) return null;

  const uniqueSources = [...new Set(sourceIds)].filter((id) => id !== targetId);
  if (uniqueSources.length === 0) {
    throw new PayeeError("Choose at least one other payee to merge", 400);
  }

  const sources = db.select().from(payees).where(inArray(payees.id, uniqueSources)).all();
  if (sources.length !== uniqueSources.length) {
    throw new PayeeError("One of the payees to merge does not exist", 404);
  }

  // Seed one rename rule per absorbed source so future CSV imports arrive
  // with the surviving name (several sources may generalise into a
  // pattern, e.g. merging BCF1 + BCF2 into BC Ferries learns BCF[N]).
  const learned: Array<{ from: string; to: string }> = sources
    .map((s) => s.name)
    .filter((name): name is string => name.trim() !== "" && name !== target.name)
    .map((name) => ({ from: name, to: target.name }));

  const result = await withTransaction(db, async () => {
    for (const source of sources) {
      const txCondition = source.name
        ? or(
            eq(transactions.payeeId, source.id),
            and(
              eq(transactions.payee, source.name),
              isNull(transactions.parentId),
              isNull(transactions.transferAccountId)
            )
          )
        : eq(transactions.payeeId, source.id);

      db.update(transactions)
        .set({ payee: target.name, payeeId: target.id })
        .where(txCondition)
        .run();

      const recCondition = source.name
        ? or(
            eq(recurring.payeeId, source.id),
            and(
              eq(recurring.payee, source.name),
              isNull(recurring.transferAccountId)
            )
          )
        : eq(recurring.payeeId, source.id);

      db.update(recurring)
        .set({ payee: target.name, payeeId: target.id })
        .where(recCondition)
        .run();

      db.delete(payees).where(eq(payees.id, source.id)).run();
    }

    return getPayeeById(db, targetId);
  });

  for (const rule of learned) {
    try {
      await learnRenameRuleFromPayees(db, rule.from, rule.to);
    } catch (learnErr) {
      console.error("[payees] failed to learn rename rule on merge:", learnErr);
    }
  }

  return result;
}
