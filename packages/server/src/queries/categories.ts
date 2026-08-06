import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { categories, categoryGroups } from "../schema.js";

export type CreateCategoryGroupInput = { name: string };
export type CreateCategoryInput = { groupId: number; name: string; goalTarget?: number | null };

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

export async function deleteCategory(db: Database, id: number) {
  await db.delete(categories).where(eq(categories.id, id));
}

export async function deleteCategoryGroup(db: Database, id: number) {
  await db.delete(categoryGroups).where(eq(categoryGroups.id, id));
}
