import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { categories, categoryGroups } from "../schema.js";

export type CreateCategoryGroupInput = { name: string };
export type CreateCategoryInput = { groupId: number; name: string; goalTarget?: number | null };

export async function createCategoryGroup(db: Database, input: CreateCategoryGroupInput) {
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${categoryGroups.sort}), -1)` })
    .from(categoryGroups);
  const [row] = await db
    .insert(categoryGroups)
    .values({ name: String(input.name ?? "New Group"), sort: Number(maxRow?.max ?? -1) + 1 })
    .returning();
  return row;
}

export async function createCategory(db: Database, input: CreateCategoryInput) {
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
  return row;
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
