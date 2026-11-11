import { and, eq, asc, isNull } from "drizzle-orm";
import type { RenameRule as RenameRuleView, RenameRuleOperator } from "@ynab/logic";
import {
  getRenameRuleOperator,
  isTransferPayee,
  learnRenameRule as pureLearn,
  matchesRenameRule,
} from "@ynab/logic";
import type { Db } from "../client.js";
import { translateConstraintError } from "../errors.js";
import { withTransaction } from "../transaction.js";
import { payees, renameRules, transactions } from "../schema.js";

export type RenameRuleRow = typeof renameRules.$inferSelect;
export type RenameRuleInput = {
  sourcePattern: string;
  targetPayee: string;
  operator?: RenameRuleOperator;
};

export class RenameRuleError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "RenameRuleError";
  }
}

const TRANSFER_RULE_MESSAGE =
  'Rename rules do not apply to transfers (payees like "Transfer : <account>").';

/** Transfers are categorised by account linkage, never by payee rename. */
function assertNotTransferRule(sourcePattern: string, targetPayee: string): void {
  if (isTransferPayee(sourcePattern) || isTransferPayee(targetPayee)) {
    throw new RenameRuleError(TRANSFER_RULE_MESSAGE, 400);
  }
}

function toView(row: RenameRuleRow): RenameRuleView {
  return {
    id: row.id,
    sourcePattern: row.sourcePattern,
    targetPayee: row.targetPayee,
    operator: getRenameRuleOperator({ operator: (row.operator as RenameRuleOperator | undefined) ?? undefined }),
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
  const sourcePattern = input.sourcePattern.trim();
  const targetPayee = input.targetPayee.trim();
  assertNotTransferRule(sourcePattern, targetPayee);
  const now = new Date().toISOString();
  try {
    const [inserted] = await db
      .insert(renameRules)
      .values({
        sourcePattern,
        targetPayee,
        operator: input.operator ?? "is",
        createdAt: now,
      })
      .returning();
    return toView(inserted!);
  } catch (e) {
    // Single-statement insert outside withTransaction: translate the
    // UNIQUE (source,target,operator) violation at the source.
    throw translateConstraintError(e);
  }
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
  if (patch.operator !== undefined) {
    values.operator = patch.operator;
  }
  if (Object.keys(values).length === 0) return current;
  assertNotTransferRule(
    values.sourcePattern ?? current.sourcePattern,
    values.targetPayee ?? current.targetPayee
  );
  values.updatedAt = new Date().toISOString();
  try {
    const [updated] = await db
      .update(renameRules)
      .set(values)
      .where(eq(renameRules.id, id))
      .returning();
    return updated ? toView(updated) : null;
  } catch (e) {
    // Single-statement update outside withTransaction: translate UNIQUE
    // violations at the source (same contract as createRenameRule).
    throw translateConstraintError(e);
  }
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
  // No-op for transfers in either direction: system payees
  // (`Transfer : <account>`) must never seed rename rules.
  if (isTransferPayee(oldPayee) || isTransferPayee(newPayee)) {
    return { generalised: false, rules: all };
  }
  const { rules: next, generalised } = pureLearn(all, oldPayee, newPayee);

  const keepIds = new Set(next.filter((r) => r.id != null).map((r) => r.id));

  await withTransaction(db, async () => {
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
  });

  return { generalised, rules: getRenameRules(db) };
}

export type ApplyRenameRuleResult = {
  rule: RenameRuleView;
  /** Rows rewritten to the rule's target payee. */
  updated: number;
  /** Matching rows left untouched because they are reconciled (locked). */
  skippedLocked: number;
};

/**
 * Apply one rename rule to already-stored transactions (learning a rule
 * otherwise only affects *future* CSV imports).
 *
 * Only regular, non-transfer, non-split-child rows are rewritten — the
 * same guard the payee-rename cascade uses — and reconciled rows are
 * counted as `skippedLocked` instead of edited. Rewritten rows are
 * relinked to the target payee entity (created when missing), mirroring
 * CSV import linkage. The imported (`needsReview`) flag is left
 * untouched: a rule backfill is automatic, not a user review, so
 * renamed rows stay bold until the user approves, edits, or
 * reconciles them.
 */
export async function applyRenameRuleToExisting(
  db: Db,
  id: number
): Promise<ApplyRenameRuleResult | null> {
  const rule = getRenameRuleById(db, id);
  if (!rule) return null;
  const target = rule.targetPayee.trim();
  if (!target) return { rule, updated: 0, skippedLocked: 0 };

  const rows = db
    .select({
      id: transactions.id,
      payee: transactions.payee,
      status: transactions.status,
      transferStatus: transactions.transferStatus,
    })
    .from(transactions)
    .where(
      and(
        isNull(transactions.parentId),
        isNull(transactions.transferAccountId)
      )
    )
    .all();

  // Already-at-target is a raw (case-sensitive) comparison — matching
  // YNAB4's case-sensitive affected-transactions scan — so drift rules
  // (`"starbucks"` -> `"Starbucks"`) converge stored casings instead of
  // skipping every row whose normalized text already equals the target.
  const hits = rows.filter(
    (r) =>
      matchesRenameRule(rule, r.payee) &&
      r.payee.trim() !== target
  );
  if (hits.length === 0) return { rule, updated: 0, skippedLocked: 0 };

  const locked = hits.filter(
    (r) => r.status === "r" || r.transferStatus === "r"
  );
  const editable = hits.filter(
    (r) => r.status !== "r" && r.transferStatus !== "r"
  );

  await withTransaction(db, async () => {
    let targetPayee = db
      .select()
      .from(payees)
      .where(eq(payees.name, target))
      .get();
    if (!targetPayee && editable.length > 0) {
      const now = new Date().toISOString();
      targetPayee = db
        .insert(payees)
        .values({ entityId: null, name: target, autoCategoryId: null, createdAt: now })
        .returning()
        .get();
    }
    for (const r of editable) {
      db
        .update(transactions)
        .set({ payee: target, payeeId: targetPayee?.id ?? null })
        .where(eq(transactions.id, r.id))
        .run();
    }
  });

  return { rule, updated: editable.length, skippedLocked: locked.length };
}
