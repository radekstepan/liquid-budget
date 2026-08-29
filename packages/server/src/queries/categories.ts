import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withTransaction } from "../transaction.js";
import { assignments, categories, categoryGroups, recurring, recurringSubTransactions, transactions } from "../schema.js";
import { assertValidAmount } from "./transactions.js";

export class CategoryError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "CategoryError";
  }
}

export type CreateCategoryGroupInput = {
  name: string;
  isHidden?: boolean;
};
export type CreateCategoryInput = {
  groupId: number;
  name: string;
  goalTarget?: number | null;
  carryover?: number | null;
  overspendCarriesOver?: boolean | null;
};

/**
 * Insert a new category group at sort = max(existing sort) + 1.
 *
 * The "select max then insert" pair is a classic read-then-write race:
 * two concurrent callers can both observe the same max and both insert
 * at the same sort, corrupting the user's manual ordering. Wrap the
 * pair in a transaction so the SELECT and the INSERT are atomic.
 */
export async function createCategoryGroup(db: Database, input: CreateCategoryGroupInput) {
  return withTransaction(db, async () => {
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${categoryGroups.sort}), -1)` })
      .from(categoryGroups);
    const [row] = await db
      .insert(categoryGroups)
      .values({
        name: String(input.name ?? "New Group"),
        sort: Number(maxRow?.max ?? -1) + 1,
        isHidden: Boolean(input.isHidden),
      })
      .returning();
    return row;
  });
}

/**
 * Same read-then-write race as `createCategoryGroup`, scoped to a
 * single group via the `groupId` WHERE clause. Wrapped in
 * withTransaction for the same reason.
 */
export async function createCategory(db: Database, input: CreateCategoryInput) {
  return withTransaction(db, async () => {
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
        goalTarget: input.goalTarget != null ? assertValidAmount(input.goalTarget, { allowZero: true }) : null,
        carryover: input.carryover != null ? assertValidAmount(input.carryover, { allowZero: true }) : 0,
        overspendCarriesOver: input.overspendCarriesOver === true,
      })
      .returning();
    return row;
  });
}

export async function updateCategoryGroup(
  db: Database,
  id: number,
  patch: {
    name?: string;
    sort?: number;
    isHidden?: boolean;
  }
) {
  const p: Record<string, unknown> = {};
  if (patch.name !== undefined) p.name = String(patch.name);
  if (patch.sort !== undefined) p.sort = Number(patch.sort);
  if (patch.isHidden !== undefined) p.isHidden = Boolean(patch.isHidden);
  if (Object.keys(p).length === 0) {
    const [row] = await db.select().from(categoryGroups).where(eq(categoryGroups.id, id));
    return row;
  }
  const [row] = await db.update(categoryGroups).set(p).where(eq(categoryGroups.id, id)).returning();
  return row;
}

export async function renameCategoryGroup(db: Database, id: number, name: string) {
  return updateCategoryGroup(db, id, { name });
}

export async function updateCategory(
  db: Database,
  id: number,
  patch: {
    name?: string;
    goalTarget?: number | null;
    carryover?: number | null;
    sort?: number;
    overspendCarriesOver?: boolean | null;
  }
) {
  const p: Record<string, unknown> = {};
  if (patch.name !== undefined && patch.name != null) p.name = String(patch.name);
  if (patch.goalTarget !== undefined) {
    p.goalTarget = patch.goalTarget == null ? null : assertValidAmount(patch.goalTarget, { allowZero: true });
  }
  if (patch.carryover !== undefined) {
    p.carryover = patch.carryover == null ? 0 : assertValidAmount(patch.carryover, { allowZero: true });
  }
  if (patch.sort !== undefined && patch.sort != null) p.sort = Number(patch.sort);
  if (patch.overspendCarriesOver !== undefined) {
    p.overspendCarriesOver = patch.overspendCarriesOver === true;
  }
  if (Object.keys(p).length === 0) {
    const [row] = await db.select().from(categories).where(eq(categories.id, id));
    return row;
  }
  const [row] = await db.update(categories).set(p).where(eq(categories.id, id)).returning();
  return row;
}

export async function updateCategoryGroupSort(db: Database, id: number, sort: number) {
  return updateCategoryGroup(db, id, { sort });
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

  return withTransaction(db, async () => {
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
  });
}

export async function deleteCategoryGroup(
  db: Database,
  id: number,
  opts?: { moveToCategoryId?: number | null }
) {
  const [group] = await db.select().from(categoryGroups).where(eq(categoryGroups.id, id));
  if (!group) return;

  const cats = await db.select().from(categories).where(eq(categories.groupId, id));
  const catIds = cats.map((c) => c.id);

  if (opts?.moveToCategoryId) {
    if (catIds.includes(opts.moveToCategoryId)) {
      throw new CategoryError(
        "Cannot reassign transactions to a category in the group being deleted.",
        400
      );
    }
    const [targetCat] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, opts.moveToCategoryId));
    if (!targetCat) {
      throw new CategoryError("Replacement category not found.", 404);
    }
  } else if (catIds.length > 0) {
    const txnRows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(inArray(transactions.categoryId, catIds));

    const recRows = await db
      .select({ id: recurring.id })
      .from(recurring)
      .where(inArray(recurring.categoryId, catIds));

    const recSubRows = await db
      .select({ id: recurringSubTransactions.id })
      .from(recurringSubTransactions)
      .where(inArray(recurringSubTransactions.categoryId, catIds));

    const totalRefs = txnRows.length + recRows.length + recSubRows.length;

    if (totalRefs > 0) {
      throw new CategoryError(
        `Category group has ${txnRows.length} transaction(s) and ${recRows.length + recSubRows.length} scheduled transaction(s). Select a replacement category before deleting.`,
        422
      );
    }
  }

  return withTransaction(db, async () => {
    if (catIds.length > 0) {
      if (opts?.moveToCategoryId) {
        await db
          .update(transactions)
          .set({ categoryId: opts.moveToCategoryId })
          .where(inArray(transactions.categoryId, catIds));
        await db
          .update(recurring)
          .set({ categoryId: opts.moveToCategoryId })
          .where(inArray(recurring.categoryId, catIds));
        await db
          .update(recurringSubTransactions)
          .set({ categoryId: opts.moveToCategoryId })
          .where(inArray(recurringSubTransactions.categoryId, catIds));
      }
      await db.delete(assignments).where(inArray(assignments.categoryId, catIds));
      await db.delete(categories).where(inArray(categories.id, catIds));
    }
    await db.delete(categoryGroups).where(eq(categoryGroups.id, id));
  });
}

