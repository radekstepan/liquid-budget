import { eq, asc, sql } from "drizzle-orm";
import type { RenameRule as RenameRuleView } from "@ynab/logic";
import { learnRenameRule as pureLearn } from "@ynab/logic";
import type { Db } from "../client.js";
import { renameRules } from "../schema.js";

export type RenameRuleRow = typeof renameRules.$inferSelect;
export type RenameRuleInput = {
  sourcePattern: string;
  targetPayee: string;
};

function toView(row: RenameRuleRow): RenameRuleView {
  return {
    id: row.id,
    sourcePattern: row.sourcePattern,
    targetPayee: row.targetPayee,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getRenameRules(db: Db): RenameRuleView[] {
  return db
    .select()
    .from(renameRules)
    .orderBy(asc(renameRules.createdAt), asc(renameRules.id))
    .all()
    .map(toView);
}

export function getRenameRuleById(db: Db, id: number): RenameRuleView | null {
  const row = db.select().from(renameRules).where(eq(renameRules.id, id)).get();
  return row ? toView(row) : null;
}

export async function createRenameRule(db: Db, input: RenameRuleInput): Promise<RenameRuleView> {
  const now = new Date().toISOString();
  const [inserted] = await db
    .insert(renameRules)
    .values({
      sourcePattern: input.sourcePattern.trim(),
      targetPayee: input.targetPayee.trim(),
      createdAt: now,
    })
    .returning();
  return toView(inserted!);
}

export async function updateRenameRule(
  db: Db,
  id: number,
  patch: Partial<RenameRuleInput>
): Promise<RenameRuleView | null> {
  const current = getRenameRuleById(db, id);
  if (!current) return null;
  const values: Partial<typeof renameRules.$inferInsert> = {};
  if (patch.sourcePattern !== undefined) {
    values.sourcePattern = patch.sourcePattern.trim();
  }
  if (patch.targetPayee !== undefined) {
    values.targetPayee = patch.targetPayee.trim();
  }
  if (Object.keys(values).length === 0) return current;
  values.updatedAt = new Date().toISOString();
  const [updated] = await db
    .update(renameRules)
    .set(values)
    .where(eq(renameRules.id, id))
    .returning();
  return updated ? toView(updated) : null;
}

export function deleteRenameRule(db: Db, id: number): boolean {
  const res = db.delete(renameRules).where(eq(renameRules.id, id)).run();
  return res.changes > 0;
}

/**
 * Learn (or generalise) a rename rule from an explicit payee rename.
 *
 * The pure engine decides whether an exact rule should be added or whether
 * a family (e.g. `BCF1`, `BCF2`) collapses into `BCF[N]`. This function
 * reconciles the stored rule set with the computed one atomically:
 * removed rules are deleted and new rules are inserted.
 */
export async function learnRenameRuleFromPayees(
  db: Db,
  oldPayee: string,
  newPayee: string
): Promise<{ generalised: boolean; rules: RenameRuleView[] }> {
  const all = getRenameRules(db);
  const { rules: next, generalised } = pureLearn(all, oldPayee, newPayee);

  const keepIds = new Set(next.filter((r) => r.id != null).map((r) => r.id));

  db.run(sql`BEGIN`);
  try {
    for (const r of all) {
      if (!keepIds.has(r.id)) {
        db.delete(renameRules).where(eq(renameRules.id, r.id)).run();
      }
    }
    for (const r of next) {
      if (r.id == null) {
        await createRenameRule(db, {
          sourcePattern: r.sourcePattern,
          targetPayee: r.targetPayee,
        });
      }
    }
    db.run(sql`COMMIT`);
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }

  return { generalised, rules: getRenameRules(db) };
}
