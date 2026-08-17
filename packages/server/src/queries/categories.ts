import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { assignments, categories, categoryGroups, recurring, recurringSubTransactions, transactions } from "../schema.js";

export class CategoryError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "CategoryError";
  }
}

export type CreateCategoryGroupInput = { name: string };
export type CreateCategoryInput = { groupId: number; name: string; goalTarget?: number | null; carryover?: number | null };

/**
 * Insert a new category group at sort = max(existing sort) + 1.
 *
 * The "select max then insert" pair is a classic read-then-write race:
 * two concurrent callers can both observe the same max and both insert
 * at the same sort, corrupting the user's manual ordering. Wrap the
 * pair in a transaction so the SELECT and the INSERT are atomic.
 *
 * We use manual `BEGIN` / `COMMIT` rather than `db.transaction()` because
 * better-sqlite3's transaction wrapper commits the moment the callback
 * returns, ignoring microtask-deferred `await`s — and our drizzle calls
 * are all `await`ed. The SQL itself executes synchronously under the
 * hood, so the BEGIN/COMMIT pair correctly brackets the work.
 */
export async function createCategoryGroup(db: Database, input: CreateCategoryGroupInput) {
  db.run(sql`BEGIN`);
  try {
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${categoryGroups.sort}), -1)` })
      .from(categoryGroups);
    const [row] = await db
      .insert(categoryGroups)
      .values({ name: String(input.name ?? "New Group"), sort: Number(maxRow?.max ?? -1) + 1 })
      .returning();
    db.run(sql`COMMIT`);
    return row;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

/**
 * Same read-then-write race as `createCategoryGroup`, scoped to a
 * single group via the `groupId` WHERE clause. Wrapped in
 * BEGIN/COMMIT for the same reason.
 */
export async function createCategory(db: Database, input: CreateCategoryInput) {
  db.run(sql`BEGIN`);
  try {
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${categories.sort}), -1)` })
      .from(categories)
      .where(eq(categories.groupId, input.groupId));
    const [row] = await db
      .insert(categories)
      .values({
        groupId: input.groupId,
        name: String(input.name ?? "New Category"),
        sort: Number(maxRow?.max ?? -1) + 1,
        goalTarget: input.goalTarget != null ? Number(input.goalTarget) : null,
        carryover: input.carryover != null ? Number(input.carryover) : 0,
      })
      .returning();
    db.run(sql`COMMIT`);
    return row;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

export async function renameCategoryGroup(db: Database, id: number, name: string) {
  const [row] = await db
    .update(categoryGroups)
    .set({ name })
    .where(eq(categoryGroups.id, id))
    .returning();
  return row;
}

export async function updateCategory(
  db: Database,
  id: number,
  patch: { name?: string; goalTarget?: number | null; carryover?: number; sort?: number }
) {
  const p: Record<string, unknown> = {};
  if (patch.name != null) p.name = String(patch.name);
  if ("goalTarget" in patch) {
    p.goalTarget = patch.goalTarget == null ? null : Number(patch.goalTarget);
  }
  if (patch.carryover != null) p.carryover = Number(patch.carryover);
  if (patch.sort != null) p.sort = Number(patch.sort);
  const [row] = await db.update(categories).set(p).where(eq(categories.id, id)).returning();
  return row;
}

export async function updateCategoryGroupSort(db: Database, id: number, sort: number) {
  const [row] = await db
    .update(categoryGroups)
    .set({ sort: Number(sort) })
    .where(eq(categoryGroups.id, id))
    .returning();
  return row;
}

export async function deleteCategory(
  db: Database,
  id: number,
  opts?: { moveToCategoryId?: number | null }
) {
  const [cat] = await db.select().from(categories).where(eq(categories.id, id));
  if (!cat) return;

  const txnRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.categoryId, id));

  const recRows = await db
    .select({ id: recurring.id })
    .from(recurring)
    .where(eq(recurring.categoryId, id));

  const recSubRows = await db
    .select({ id: recurringSubTransactions.id })
    .from(recurringSubTransactions)
    .where(eq(recurringSubTransactions.categoryId, id));

  const totalRefs = txnRows.length + recRows.length + recSubRows.length;

  if (totalRefs > 0) {
    if (!opts?.moveToCategoryId) {
      throw new CategoryError(
        `Category has ${txnRows.length} transaction(s) and ${recRows.length + recSubRows.length} scheduled transaction(s). Select a replacement category before deleting.`,
        422
      );
    }
    if (opts.moveToCategoryId === id) {
      throw new CategoryError("Cannot reassign transactions to the category being deleted.", 400);
    }
    const [targetCat] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, opts.moveToCategoryId));
    if (!targetCat) {
      throw new CategoryError("Replacement category not found.", 404);
    }
  }

  db.run(sql`BEGIN`);
  try {
    if (opts?.moveToCategoryId) {
      await db
        .update(transactions)
        .set({ categoryId: opts.moveToCategoryId })
        .where(eq(transactions.categoryId, id));
      await db
        .update(recurring)
        .set({ categoryId: opts.moveToCategoryId })
        .where(eq(recurring.categoryId, id));
      await db
        .update(recurringSubTransactions)
        .set({ categoryId: opts.moveToCategoryId })
        .where(eq(recurringSubTransactions.categoryId, id));
    }
    await db.delete(assignments).where(eq(assignments.categoryId, id));
    await db.delete(categories).where(eq(categories.id, id));
    db.run(sql`COMMIT`);
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

export async function deleteCategoryGroup(db: Database, id: number) {
  const cats = await db.select().from(categories).where(eq(categories.groupId, id));
  for (const c of cats) {
    await deleteCategory(db, c.id);
  }
  await db.delete(categoryGroups).where(eq(categoryGroups.id, id));
}
